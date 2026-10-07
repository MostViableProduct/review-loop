#!/usr/bin/env node
// One review round per `run`, plus the decision/dispute/override/push/repin/status commands the skill drives.
// Output: one JSON object on stdout. Exit codes are the contract — see lib/policy.mjs EXIT.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ReviewLoopError, errorCode } from "./lib/errors.mjs";
import { emitEvent } from "./lib/events.mjs";
import { effectiveCodex } from "./lib/codexcfg.mjs";
import { readConfig } from "./lib/config.mjs";
import { sha256hex } from "./lib/fsutil.mjs";
import {
  identityKey,
  identityLabel,
  readRecord,
  writeRecord,
  newRecord,
  acquireLock,
  readMarker,
  removeMarker,
  setLockEventSource,
  listMarkers,
  stateRoot,
  stateSubdir,
  assertKey
} from "./lib/state.mjs";
import { EXIT, OPTION_LABELS, applyRoundResult, applyDecision, awaitHuman, resetIfNewLoop, withoutWaived, exitForAwaiting } from "./lib/policy.mjs";
import { scoreFindings, parseDimensionTag } from "./lib/scoring.mjs";
import { verifyPin, verifyUsage, runCompanion, parseCompanionOutput, companionFailureText, writePin, pinFile, installedTreeDigest, snapshotVerified, stopCompanionBroker, sweepStaleSnapshots, afterSnapshotSecond, countOrphanBrokers, stopOrphan, STOP_DEADLINE_MS, SWEEP_MANUAL_DEADLINE_MS, SNAPSHOT_NAME } from "./lib/pin.mjs";
import { loadRubricSection, buildFocus } from "./lib/rubric.mjs";
import { prepare, pushBranch, HumanNeeded, NON_RETRYABLE } from "./lib/round.mjs";
import { repoRoot, headSha, implFingerprint, mergeBaseValidity, readArtifact } from "./lib/git.mjs";
import { pendingForSession, identityForTouchedPath } from "./lib/detect.mjs";
import { ghBranchSha } from "./lib/github.mjs";
import { postVerdict } from "./lib/status.mjs";

const SESSION = process.env.CLAUDE_SESSION_ID ?? null;
setLockEventSource("round");
const PIN_CODES = new Set(["plugin_pin_mismatch", "companion_usage_mismatch", "companion_contract_mismatch"]);

/** @param {Record<string, unknown>} obj @param {number} code */
function out(obj, code) {
  process.stdout.write(JSON.stringify({ exit: code, ...obj }, null, 2) + "\n");
  process.exitCode = code;
}

/**
 * @param {Record<string, string | boolean | undefined>} v
 * @returns {Promise<{ identity: import("./lib/state.mjs").Identity, projectRoot: string | null }>}
 */
async function resolveIdentity(v) {
  if (typeof v.key === "string") {
    assertKey(v.key);
    const rec = readRecord(v.key);
    const marker = readMarker(v.key);
    const identity = rec?.identity ?? marker?.identity;
    if (!identity) throw new ReviewLoopError("unknown_key", `no record or marker for key ${v.key}`);
    return { identity, projectRoot: marker?.projectRoot ?? /** @type {string | null} */ (rec?.meta?.projectRoot ?? null) };
  }
  const kind = v.kind;
  if (kind !== "spec" && kind !== "plan" && kind !== "impl") throw new ReviewLoopError("bad_args", "--kind must be spec, plan or impl (or pass --key)");
  if (typeof v.path !== "string") throw new ReviewLoopError("bad_args", "--path is required");
  const abs = path.resolve(v.path);
  if (kind === "impl") {
    const root = await repoRoot(abs);
    if (!root) throw new ReviewLoopError("bad_args", `${abs} is not inside a git repository`);
    return { identity: { kind, path: root }, projectRoot: root };
  }
  const dir = path.dirname(abs);
  const root = fs.existsSync(dir) ? await repoRoot(dir) : null;
  // The file is read and sent to Codex, so it must be what the file-tool tracker would mark as this kind, classified
  // against the root git reports — --project-root is metadata and never authorizes a path (e.g. ~/.ssh/id_rsa).
  const identity = identityForTouchedPath(abs, root);
  if (identity?.kind !== kind) {
    throw new ReviewLoopError("bad_args", `${abs} is not a ${kind} (specs/**/*.md, *-design.md, *-spec.md; plans/**/*.md, *-plan.md, ~/.claude/plans/*.md)`);
  }
  const projectRoot = typeof v["project-root"] === "string" ? path.resolve(v["project-root"]) : root;
  return { identity, projectRoot };
}

/**
 * A cleared artifact's marker goes — except a PR's: it holds the resolved head remote and project root that
 * `push` needs after the pass (pendingForSession already skips a branch marker once its record is cleared).
 * @param {string} key @param {import("./lib/state.mjs").Identity} identity
 */
function clearMarker(key, identity) {
  if (identity.kind !== "branch") removeMarker(key);
}

/** @param {ReturnType<typeof newRecord>} rec */
function awaitingView(rec) {
  if (!rec.awaiting) return null;
  const options = /** @type {string[]} */ (rec.awaiting.options ?? []);
  return { reason: rec.awaiting.reason, detail: rec.awaiting.detail ?? {}, options: options.map((id) => ({ id, label: OPTION_LABELS[/** @type {keyof typeof OPTION_LABELS} */ (id)] ?? id })) };
}

/**
 * Current fingerprint without running a review (for accept/override).
 * @param {import("./lib/state.mjs").Identity} identity @param {string} key @param {ReturnType<typeof newRecord>} rec
 */
async function fingerprintNow(identity, key, rec) {
  const projectRoot = typeof rec.meta?.projectRoot === "string" ? rec.meta.projectRoot : null;
  if (identity.kind === "spec" || identity.kind === "plan") return sha256hex(readArtifact(identity.path, projectRoot));
  if (identity.kind === "impl") return (await implFingerprint(identity.path))?.fingerprint ?? null;
  const marker = readMarker(key);
  const root = marker?.projectRoot;
  const baseSha = /** @type {{ baseSha?: string }} */ (marker?.extra ?? {}).baseSha;
  if (!root || !baseSha) return null;
  const head = await headSha(root);
  const v = head ? await mergeBaseValidity(root, head, baseSha) : null;
  return v?.ok ? `${head}:${v.mergeBase}` : null;
}

/**
 * Posts the base-scoped commit status for a PR (branch) review; any other kind has no commit to mark.
 * @param {import("./lib/state.mjs").Identity} identity @param {string} key @param {string | null | undefined} fingerprint
 * @param {string | null | undefined} cwd @param {"success" | "failure"} state @param {string} description
 */
async function postBranchStatus(identity, key, fingerprint, cwd, state, description) {
  const sha = fingerprint?.split(":")[0];
  if (identity.kind !== "branch") return;
  if (!sha || !cwd) {
    emitEvent({ source: "round", event: "hook.error", code: "status_post_failed", session_id: SESSION, artifact_key: key, data: { stage: "status_post_failed" } });
    return;
  }
  await postVerdict({ slug: identity.baseRepo, sha, baseBranch: identity.baseBranch, state, description, cwd, session: SESSION, key });
}

/** @param {Record<string, string | boolean | undefined>} v */
async function cmdRun(v) {
  const started = Date.now();
  // Resolved once: every round.result of this run reports the preset its verdict was given under.
  const timing = { started, preset: readConfig().config.preset };
  const { identity, projectRoot } = await resolveIdentity(v);
  const key = identityKey(identity);
  const base = { key, kind: identity.kind, label: identityLabel(identity) };
  let lock;
  try {
    lock = acquireLock(key, SESSION);
  } catch (err) {
    return out({ ...base, status: "busy", error: { code: errorCode(err), message: /** @type {Error} */ (err).message, retryable: true } }, EXIT.BUSY);
  }
  let rec = readRecord(key) ?? newRecord(identity, { projectRoot });
  /** @type {import("./lib/round.mjs").Prepared | null} */
  let prep = null;
  /** @type {{ root: string, cleanup: () => void } | null} */
  let plugin = null;
  try {
    // First, before any early return: a round that has nothing to review still clears what killed rounds left.
    await sweepSnapshots(key);
    // We hold the lock, so a record left "reviewing" belongs to a holder that died mid-round.
    if (rec.status === "reviewing") {
      rec.status = "op_error";
      rec.lastError = { code: "interrupted", message: "previous round was interrupted", at: new Date().toISOString() };
    }
    prep = await prepare(identity, { projectRoot, key });
    if (prep.nothing) {
      clearMarker(key, identity);
      return out({ ...base, status: "nothing_to_review" }, EXIT.PASS);
    }
    resetIfNewLoop(rec, prep.fingerprint);
    if ((rec.status === "passed" || rec.status === "overridden") && rec.reviewedFingerprint === prep.fingerprint) {
      clearMarker(key, identity);
      return out({ ...base, status: rec.status, round: rec.round, coveredScope: prep.coveredScope }, EXIT.PASS);
    }
    // A plugin_pin page is about the installed plugin, not the artifact: fall through and re-verify, so a fixed plugin
    // clears it and a further-changed one is re-paged with the tree as it is now (a repin binds to that tree).
    if (rec.status === "awaiting_human" && rec.awaiting && rec.awaiting.reason !== "plugin_pin") {
      // Still the same page — but say so when the artifact moved on: accept/override on it will be refused.
      const stale = rec.awaiting.fingerprint !== prep.fingerprint;
      return out({ ...base, status: rec.status, round: rec.round, awaiting: { ...awaitingView(rec), stale } }, exitForAwaiting(rec.awaiting.reason));
    }

    let pluginRoot;
    try {
      verifyPin();
      // Test seam: the snapshot is made just after a second begins, so a companion started without the wait below
      // would share that second.
      if (process.env.REVIEW_LOOP_TEST_SEAMS === "1" && process.env.REVIEW_LOOP_TEST_SNAPSHOT_AT_SECOND_START === "1") await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 5));
      plugin = snapshotVerified(stateSubdir("ws"), key);
      pluginRoot = plugin.root;
      await afterSnapshotSecond(pluginRoot);
      await verifyUsage(pluginRoot);
    } catch (err) {
      if (!PIN_CODES.has(errorCode(err))) throw err;
      awaitHuman(
        rec,
        "plugin_pin",
        { code: errorCode(err), message: /** @type {Error} */ (err).message, ...(/** @type {ReviewLoopError} */ (err).details ?? {}), tree: installedTreeDigest() },
        prep.fingerprint
      );
      writeRecord(rec);
      roundResult(errorCode(err), key, identity, rec, EXIT.PIN, timing);
      return out({ ...base, status: rec.status, awaiting: awaitingView(rec) }, EXIT.PIN);
    }

    rec.awaiting = null;
    rec.status = "reviewing";
    rec.fingerprint = prep.fingerprint;
    rec.meta = { ...(rec.meta ?? {}), projectRoot: prep.projectRoot };
    const seamPause = process.env.REVIEW_LOOP_TEST_SEAMS === "1" ? Number(process.env.REVIEW_LOOP_TEST_BEFORE_REVIEWING_PAUSE_MS) : NaN;
    if (seamPause > 0) await new Promise((r) => setTimeout(r, seamPause));
    // The fence before paying: a holder displaced since acquireLock is stopped here (lock_lost), before runCompanion.
    writeRecord(rec);

    const focus = buildFocus({
      kind: identity.kind,
      label: prep.label,
      projectRoot: prep.projectRoot,
      instructions: prep.instructions,
      disputes: rec.disputes.map((d) => ({ title: d.title, file: d.file ?? undefined, reason: d.reason })),
      rubric: loadRubricSection()
    });
    const eff = effectiveCodex({ report: true });
    const seamTimeout = process.env.REVIEW_LOOP_TEST_SEAMS === "1" ? Number(process.env.REVIEW_LOOP_TEST_COMPANION_TIMEOUT_MS) : NaN;
    const res = await runCompanion(pluginRoot, { cwd: prep.cwd, targetArgs: prep.targetArgs, focus, codex: eff, ...(seamTimeout > 0 ? { timeoutMs: seamTimeout } : {}) });
    // The companion exits non-zero only when the Codex turn did not complete (findings alone exit 0), so a
    // well-formed payload next to a failed exit is partial output — never a verdict.
    // Codex's own words ride in details.output to the printed result only; the message is what the record keeps.
    if (res.code !== 0) {
      const output = companionFailureText(res);
      throw new ReviewLoopError("codex_failed", `codex companion exited ${res.code}${output ? "; Codex's error is in error.output" : " with no output"}`, { output });
    }
    let parsed;
    try {
      parsed = parseCompanionOutput(res.stdout);
    } catch (err) {
      if (!PIN_CODES.has(errorCode(err))) throw err;
      awaitHuman(rec, "plugin_pin", { code: errorCode(err), message: /** @type {Error} */ (err).message, tree: installedTreeDigest() });
      writeRecord(rec);
      roundResult(errorCode(err), key, identity, rec, EXIT.PIN, timing);
      return out({ ...base, status: rec.status, awaiting: awaitingView(rec) }, EXIT.PIN);
    }
    if (parsed.kind === "codex_error") throw new ReviewLoopError("codex_output_invalid", parsed.message);
    // Scoring reads findings only, so an explicit negative verdict with nothing to score would otherwise pass.
    if (parsed.verdict === "needs-attention" && parsed.findings.length === 0) {
      throw new ReviewLoopError("codex_output_invalid", "codex said needs-attention but returned no findings");
    }

    const findings = withoutWaived(parsed.findings, rec.waivers);
    const scored = scoreFindings(findings);
    const exit = applyRoundResult(rec, scored, findings, prep.fingerprint);
    rec.lastFindings = findings.map((f) => ({ title: f.title, file: f.file, severity: f.severity }));
    rec.meta = { ...(rec.meta ?? {}), codex: { model: eff.model, effort: eff.effort, source: eff.source } };
    writeRecord(rec);
    if (exit === EXIT.PASS) clearMarker(key, identity);
    const mean = scored.overall.toFixed(1);
    const baseBranch = identity.kind === "branch" ? identity.baseBranch : "";
    // A failure marks the SHA reviewed this round (rec.fingerprint); reviewedFingerprint is the older approved SHA.
    if (rec.status === "passed") await postBranchStatus(identity, key, rec.reviewedFingerprint, prep.projectRoot, "success", `review-loop passed vs ${baseBranch} (mean ${mean})`);
    else if (rec.status === "needs_fixes" || rec.status === "awaiting_human") await postBranchStatus(identity, key, rec.fingerprint, prep.projectRoot, "failure", `review-loop: not passed (mean ${mean})`);
    emitEvent({
      source: "round",
      event: "round.result",
      code: rec.status,
      artifact_key: key,
      session_id: SESSION,
      exit_code: exit,
      data: {
        kind: eventKind(identity),
        round: rec.round,
        pass: rec.status === "passed",
        mean: scored.dimensions.reduce((s, d) => s + d.tenths, 0) / (10 * scored.dimensions.length),
        dims: Object.fromEntries(scored.dimensions.map((d) => [d.name, d.score])),
        model: eff.model,
        effort: eff.effort,
        effort_source: eff.source,
        preset: timing.preset,
        duration_ms: Date.now() - started
      }
    });

    return out(
      {
        ...base,
        status: rec.status,
        round: rec.round,
        mode: rec.mode,
        nextCheckpoint: rec.mode === "capped" ? rec.nextCheckpoint : null,
        verdict: parsed.verdict,
        summary: parsed.summary,
        score: {
          overall: scored.overall,
          arithmetic: scored.arithmetic,
          pass: scored.pass,
          untagged: scored.untagged,
          dimensions: scored.dimensions.map((d) => ({ name: d.name, score: d.score, worst: d.worst, count: d.count }))
        },
        findings: findings.map((f, i) => ({
          i,
          dimension: parseDimensionTag(f.title).dimension,
          severity: f.severity,
          title: f.title,
          file: f.file,
          lines: `${f.line_start}-${f.line_end}`,
          confidence: f.confidence,
          body: f.body,
          recommendation: f.recommendation
        })),
        waived: parsed.findings.length - findings.length,
        disputes: rec.disputes,
        awaiting: awaitingView(rec),
        coveredScope: prep.coveredScope
      },
      exit
    );
  } catch (err) {
    if (err instanceof HumanNeeded) {
      awaitHuman(rec, err.reason, { ...err.detail, message: err.message });
      writeRecord(rec);
      roundResult(err.reason, key, identity, rec, exitForAwaiting(err.reason), timing);
      return out({ ...base, status: rec.status, awaiting: awaitingView(rec) }, exitForAwaiting(err.reason));
    }
    const code = errorCode(err);
    rec.status = "op_error";
    rec.lastError = { code, message: /** @type {Error} */ (err).message, at: new Date().toISOString() };
    rec.errorAttempts = (rec.errorAttempts ?? 0) + 1;
    writeRecord(rec);
    roundResult(code, key, identity, rec, EXIT.OP_ERROR, timing);
    const output = err instanceof ReviewLoopError && typeof err.details.output === "string" && err.details.output ? { output: err.details.output } : {};
    return out({ ...base, status: "op_error", error: { code, message: /** @type {Error} */ (err).message, retryable: !NON_RETRYABLE.has(code), attempts: rec.errorAttempts, ...output } }, EXIT.OP_ERROR);
  } finally {
    const stop = plugin ? await stopCompanionBroker(plugin.root, { deadline: performance.now() + STOP_DEADLINE_MS }) : null;
    const kept = stop !== null && (stop.left > 0 || stop.unattributed > 0);
    if (kept) reportStop(key, path.basename(/** @type {{ root: string }} */ (plugin).root), /** @type {import("./lib/pin.mjs").StopResult} */ (stop));
    prep && !prep.nothing && prep.cleanup();
    // A snapshot whose broker tree may still run is kept: it is the only evidence that ties the tree to this round,
    // and the next sweep retries it once this (its owner) has exited.
    if (!kept && plugin && !plugin.cleanup()) reportStop(key, path.basename(plugin.root), { left: 0, unattributed: 0, reason: "temp_unremoved" });
    lock.release();
  }
}

/**
 * The detail of a stop that left a snapshot in place, for every path that keeps one (the round's own stop and both
 * sweeps): `hook.error` `broker_stop_failed` whenever something may still run, plus `round.broker_stop` with the
 * detail. Counts and a bounded reason only; a lost line is still said on stderr, so it is never silent.
 * @param {string | null} key @param {string} snapshot @param {{ left: number, unattributed: number, reason: string | null }} s
 */
function reportStop(key, snapshot, s) {
  if (s.left + s.unattributed > 0 && !emitEvent({ source: "round", event: "hook.error", code: "broker_stop_failed", session_id: SESSION, artifact_key: key, data: { stage: "broker_stop_failed" } })) {
    process.stderr.write(`review-loop: event_write_failed ${JSON.stringify({ event: "hook.error", code: "broker_stop_failed", artifact_key: key })}\n`);
  }
  const data = { reason: s.reason ?? "members_left", left: s.left, unattributed: s.unattributed, snapshot };
  if (!emitEvent({ source: "round", event: "round.broker_stop", code: "broker_stop_failed", session_id: SESSION, artifact_key: key, data })) {
    process.stderr.write(`review-loop: event_write_failed ${JSON.stringify({ event: "round.broker_stop", code: "broker_stop_failed", artifact_key: key, left: s.left, unattributed: s.unattributed })}\n`);
  }
}

/**
 * Clears what rounds killed before their finally left in ws/ (see sweepStaleSnapshots). Logs one round.sweep whenever
 * ws/ holds any snapshot (so which partition each round looked at is on record), plus one round.broker_stop per
 * snapshot it had to keep. Counts only.
 * @param {string | null} key @param {{ all?: boolean, deadlineMs?: number }} [opts]
 */
async function sweepSnapshots(key, opts = {}) {
  const s = await sweepStaleSnapshots(stateSubdir("ws"), opts);
  for (const st of s.stops) reportStop(st.origin, st.snapshot, st);
  const skipped = [...s.skipped.values()];
  const inUse = skipped.filter((k) => k === "in_use").length;
  const unverified = skipped.length - inUse;
  const bad = s.brokersLeft + s.unattributed + s.failed + unverified > 0 || s.incomplete;
  // counted is the last count (a full sweep re-counts after acting, down to 0), so held says whether it acted.
  if (s.counted === 0 && s.held === 0 && !bad) return s;
  const data = {
    swept: s.swept, brokers_left: s.brokersLeft, failed: s.failed, unattributed: s.unattributed, incomplete: s.incomplete ? 1 : 0, in_use: inUse, unverified,
    held: s.held, partition: s.partition, partitions: s.partitions
  };
  // Two literal sites, so scripts/list-codes.mjs (and T-OBS-3) sees the code.
  const ok = bad
    ? emitEvent({ source: "round", event: "round.sweep", code: "snapshot_sweep_incomplete", session_id: SESSION, artifact_key: key, data })
    : emitEvent({ source: "round", event: "round.sweep", code: "ok", session_id: SESSION, artifact_key: key, data });
  if (!ok) process.stderr.write(`review-loop: event_write_failed ${JSON.stringify({ event: "round.sweep", code: bad ? "snapshot_sweep_incomplete" : "ok", artifact_key: key, ...data })}\n`);
  return s;
}

/**
 * `sweep`: every partition of ws/, now, without a lock (it acts only on snapshots whose owner is gone). Exit 0 only
 * when everything was examined, nothing is left, and no broker runs from a snapshot that is gone.
 */
/**
 * An operator command's outcome as an event; a line that cannot be written is said on stderr instead.
 * @param {string} event @param {string} code @param {Record<string, unknown>} data
 */
function report(event, code, data) {
  if (!emitEvent({ source: "round", event, code, session_id: SESSION, artifact_key: null, data })) {
    process.stderr.write(`review-loop: event_write_failed ${JSON.stringify({ event, code, ...data })}\n`);
  }
}

async function cmdSweep() {
  const s = await sweepSnapshots(null, { all: true, deadlineMs: SWEEP_MANUAL_DEADLINE_MS });
  const o = countOrphanBrokers(stateSubdir("ws"));
  report("round.orphans", o.verified && o.count === 0 ? "ok" : "orphaned_brokers", { verified: o.verified ? 1 : 0, count: o.count });
  const skipped = [...s.skipped.values()];
  const inUse = skipped.filter((k) => k === "in_use").length;
  const unverified = skipped.length - inUse;
  // A snapshot of a live round (in_use) is not a leftover; one that could not be judged (unverified) is not clean.
  const clean = s.brokersLeft + s.unattributed + s.failed + unverified === 0 && !s.incomplete && o.verified && o.count === 0;
  out(
    {
      status: clean ? "clean" : "incomplete", swept: s.swept, brokers_left: s.brokersLeft, unattributed: s.unattributed, failed: s.failed + (o.verified ? 0 : 1),
      incomplete: s.incomplete || !o.verified, orphans_detected: o.count, in_use: inUse, unverified
    },
    clean ? EXIT.PASS : EXIT.SWEEP_INCOMPLETE
  );
}

/**
 * `stop-orphan`: the operator's command for one broker whose snapshot is gone, built by `review-loop doctor`. It
 * re-checks the process right before each signal (see stopOrphan); nothing runs it automatically.
 * @param {Record<string, string | boolean | undefined>} v
 */
async function cmdStopOrphan(v) {
  const snapshot = typeof v.snapshot === "string" && SNAPSHOT_NAME.test(v.snapshot) ? v.snapshot : null;
  const int = (/** @type {unknown} */ x) => (typeof x === "string" && /^[1-9]\d{0,9}$/.test(x) ? Number(x) : null);
  const pid = int(v.pid);
  const started = int(v.started);
  const argsSha = typeof v["args-sha"] === "string" && /^[0-9a-f]{64}$/.test(v["args-sha"]) ? v["args-sha"] : null;
  if (snapshot === null || pid === null || pid <= 1 || started === null || argsSha === null) {
    throw new ReviewLoopError("bad_args", "stop-orphan needs --snapshot plugin-XXXXXX --pid <n> --started <epoch-seconds> --args-sha <64 hex>, as `review-loop doctor` prints them");
  }
  const status = await stopOrphan(stateSubdir("ws"), { snapshot, pid, started, argsSha });
  report("round.stop_orphan", status === "stopped" ? "ok" : "orphaned_brokers", { status });
  // pgid: the group the command acted on, for `ps -o pid,pgid,lstart,args -g <pgid>` (with leader_gone: what is left).
  out({ status, pgid: pid }, status === "stopped" ? EXIT.PASS : EXIT.SWEEP_INCOMPLETE);
}

/** @param {{ kind: string }} identity */
const eventKind = (identity) => (identity.kind === "branch" ? "pr" : identity.kind);

/**
 * A round that ended without a score: a pause for the human, or an operational error.
 * @param {string} code @param {string} key @param {{ kind: string }} identity @param {{ round: number }} rec @param {number} exit
 * @param {{ started: number, preset: string }} timing
 */
function roundResult(code, key, identity, rec, exit, timing) {
  emitEvent({
    source: "round",
    event: "round.result",
    code,
    artifact_key: key,
    session_id: SESSION,
    exit_code: exit,
    data: { kind: eventKind(identity), round: rec.round, pass: false, preset: timing.preset, duration_ms: Date.now() - timing.started }
  });
}

/** @param {Record<string, string | boolean | undefined>} v */
async function withLockedRecord(v, fn) {
  const { identity, projectRoot } = await resolveIdentity(v);
  const key = identityKey(identity);
  const lock = acquireLock(key, SESSION);
  try {
    const rec = readRecord(key) ?? newRecord(identity, { projectRoot });
    return await fn(rec, key, identity);
  } finally {
    lock.release();
  }
}

/** @param {Record<string, string | boolean | undefined>} v */
async function cmdDecide(v) {
  if (typeof v.option !== "string") throw new ReviewLoopError("bad_args", "--option is required");
  const option = v.option;
  return withLockedRecord(v, async (rec, key, identity) => {
    const fp = option === "accept" || option === "override" ? await fingerprintNow(identity, key, rec) : rec.fingerprint;
    // applyDecision validates that this record is awaiting a page that offers `option`; only then may repin bless
    // the changed plugin files (the page showed them via awaiting.detail).
    const tree = /** @type {{ tree?: { version: string, digest: string } | null }} */ (rec.awaiting?.detail ?? {}).tree;
    const reason = applyDecision(rec, option, fp);
    if (option === "repin") {
      if (!tree) throw new ReviewLoopError("decision_stale", "the pin page recorded no plugin tree to approve; re-run the round");
      writePin(tree.version, tree);
    }
    writeRecord(rec);
    if (option === "accept" || option === "override" || option === "waive") {
      emitEvent({ source: "round", event: "override", code: "ok", artifact_key: key, session_id: SESSION, data: { kind: identity.kind === "branch" ? "branch" : "artifact", action: "manual" } });
    } else {
      emitEvent({ source: "round", event: "round.decision", code: "ok", artifact_key: key, session_id: SESSION, data: { kind: eventKind(identity), option, reason } });
    }
    if (rec.status === "overridden") {
      await postBranchStatus(identity, key, rec.reviewedFingerprint, readMarker(key)?.projectRoot ?? /** @type {string | null} */ (rec.meta?.projectRoot ?? null), "success", "review-loop overridden by user (logged)");
      clearMarker(key, identity);
    }
    out({ key, label: identityLabel(identity), status: rec.status, decision: option, for: reason, mode: rec.mode, nextCheckpoint: rec.nextCheckpoint }, EXIT.PASS);
  });
}

/** @param {Record<string, string | boolean | undefined>} v */
async function cmdDispute(v) {
  const idx = Number(v.finding);
  if (!Number.isInteger(idx) || typeof v.reason !== "string" || !v.reason.trim()) {
    throw new ReviewLoopError("bad_args", "--finding <index from the last round> and --reason <evidence> are required");
  }
  return withLockedRecord(v, async (rec, key, identity) => {
    const f = /** @type {Array<{ title: string, file: string }>} */ (rec.lastFindings ?? [])[idx];
    if (!f) throw new ReviewLoopError("bad_args", `no finding #${idx} in the last round`);
    rec.disputes = rec.disputes.filter((d) => d.title !== f.title || d.file !== f.file);
    rec.disputes.push({ title: f.title, file: f.file, reason: /** @type {string} */ (v.reason).trim(), raisedAgain: 0 });
    writeRecord(rec);
    emitEvent({ source: "round", event: "round.dispute", code: "ok", artifact_key: key, session_id: SESSION, data: { kind: eventKind(identity) } });
    out({ key, disputes: rec.disputes }, EXIT.PASS);
  });
}

/** "skip review" / kill switch: a visible, logged override at the current fingerprint. */
async function cmdOverride(v) {
  const reason = typeof v.reason === "string" && v.reason.trim() ? v.reason.trim() : "user said skip review";
  return withLockedRecord(v, async (rec, key, identity) => {
    const fp = await fingerprintNow(identity, key, rec);
    if (!fp) throw new ReviewLoopError("override_unverifiable", "cannot compute the current fingerprint to override");
    rec.status = "overridden";
    rec.reviewedFingerprint = fp;
    rec.awaiting = null;
    rec.meta = { ...(rec.meta ?? {}), override: { reason, at: new Date().toISOString() } };
    writeRecord(rec);
    await postBranchStatus(identity, key, fp, readMarker(key)?.projectRoot ?? /** @type {string | null} */ (rec.meta?.projectRoot ?? null), "success", "review-loop overridden by user (logged)");
    clearMarker(key, identity);
    emitEvent({ source: "round", event: "override", code: "ok", artifact_key: key, session_id: SESSION, data: { kind: identity.kind === "branch" ? "branch" : "artifact", action: "skip_review" } });
    out({ key, label: identityLabel(identity), status: "overridden", reason, warning: "NOT reviewed — override logged" }, EXIT.PASS);
  });
}

/** @param {Record<string, string | boolean | undefined>} v */
async function cmdPush(v) {
  return withLockedRecord(v, async (rec, key, identity) => {
    if (identity.kind !== "branch") throw new ReviewLoopError("bad_args", "push applies to PR (branch) reviews only");
    const root = readMarker(key)?.projectRoot;
    const head = root ? await headSha(root) : null;
    if (!(rec.status === "passed" || rec.status === "overridden") || !head || !rec.reviewedFingerprint?.startsWith(`${head}:`)) {
      throw new ReviewLoopError("push_not_reviewed", "HEAD has not passed review; run the loop first");
    }
    // The pass covers HEAD against one merge-base. A base rewritten since then changes what the PR would show — and a
    // push to a branch with an open PR updates it with no gate in between — so re-resolve the comparison now.
    const baseSha = await ghBranchSha(identity.baseRepo, identity.baseBranch, /** @type {string} */ (root), { notFound: "pr_base_unverifiable", failed: "pr_base_unverifiable" });
    const v = await mergeBaseValidity(/** @type {string} */ (root), head, baseSha);
    if (!v.ok || `${head}:${v.mergeBase}` !== rec.reviewedFingerprint) {
      throw new ReviewLoopError("push_comparison_changed", `the PR base ${identity.baseBranch} moved since the review; re-run the round before pushing`);
    }
    try {
      const pushed = await pushBranch(identity, key, head);
      emitEvent({ source: "round", event: "round.push", code: "ok", artifact_key: key, session_id: SESSION });
      // The local commit was not on GitHub when the round posted, so that success may have been a 422.
      await postBranchStatus(identity, key, rec.reviewedFingerprint, root, "success", rec.status === "overridden" ? "review-loop overridden by user (logged)" : `review-loop passed vs ${identity.baseBranch}`);
      out({ key, pushed }, EXIT.PASS);
    } catch (err) {
      if (!(err instanceof HumanNeeded)) throw err;
      awaitHuman(rec, err.reason, { ...err.detail, message: err.message });
      writeRecord(rec);
      out({ key, status: rec.status, awaiting: awaitingView(rec) }, EXIT.HUMAN);
    }
  });
}

async function cmdStatus(v) {
  const cwd = typeof v.cwd === "string" ? v.cwd : process.cwd();
  const session = typeof v.session === "string" ? v.session : SESSION;
  const items = session ? (await pendingForSession(session, cwd)).items : [];
  const branch = listMarkers()
    .filter((m) => m.identity.kind === "branch")
    .map((m) => ({ key: m.key, label: identityLabel(m.identity), status: readRecord(m.key)?.status ?? "pending" }));
  // A status we could not fully compute is not a successful status: the scan-failure items stay in the output.
  const scanFailed = items.some((i) => i.kind === "scan");
  out({ session, items, prMarkers: branch, ...(scanFailed ? { status: "op_error" } : {}) }, scanFailed ? EXIT.OP_ERROR : EXIT.PASS);
}

const USAGE = `usage:
  review-round.mjs run   (--kind spec|plan|impl --path <p> [--project-root <r>] | --key <k>)
  review-round.mjs decide  (--key <k> | --kind --path) --option <id>
  review-round.mjs dispute (--key <k> | --kind --path) --finding <i> --reason <evidence>
  review-round.mjs override (--key <k> | --kind --path) [--reason <text>]
  review-round.mjs push --key <k>
  review-round.mjs repin
  review-round.mjs status [--cwd <dir>] [--session <id>]
  review-round.mjs sweep
  review-round.mjs stop-orphan --snapshot <plugin-XXXXXX> --pid <n> --started <epoch-seconds> --args-sha <hex>

exit codes: 0 pass/clean, 10 needs fixes, 20 checkpoint, 21 stall, 22 needs a human, 30 operational error,
  40 plugin pin, 50 busy (another round holds the lock), 60 sweep or stop-orphan incomplete`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      kind: { type: "string" },
      path: { type: "string" },
      key: { type: "string" },
      "project-root": { type: "string" },
      option: { type: "string" },
      finding: { type: "string" },
      reason: { type: "string" },
      cwd: { type: "string" },
      session: { type: "string" },
      snapshot: { type: "string" },
      pid: { type: "string" },
      started: { type: "string" },
      "args-sha": { type: "string" }
    },
    strict: true
  });
  switch (cmd) {
    case "run":
      return cmdRun(values);
    case "decide":
      return cmdDecide(values);
    case "dispute":
      return cmdDispute(values);
    case "override":
      return cmdOverride(values);
    case "push":
      return cmdPush(values);
    case "repin":
      // First-time setup only. Once a pin exists, changed plugin files are trusted only through the plugin_pin page
      // (`decide --option repin`), which shows the user what changed.
      if (fs.existsSync(pinFile())) throw new ReviewLoopError("pin_exists", "a plugin pin already exists; re-pin only from the plugin_pin page (decide --option repin)");
      return out({ pinned: writePin() }, EXIT.PASS);
    case "status":
      return cmdStatus(values);
    case "sweep":
      return cmdSweep();
    case "stop-orphan":
      return cmdStopOrphan(values);
    default:
      process.stderr.write(USAGE + "\n");
      process.exitCode = 2;
  }
}

main().catch((err) => {
  out({ status: "op_error", error: { code: errorCode(err), message: /** @type {Error} */ (err).message, retryable: !NON_RETRYABLE.has(errorCode(err)) } }, EXIT.OP_ERROR);
});
