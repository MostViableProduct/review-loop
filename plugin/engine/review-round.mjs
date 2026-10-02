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
import { verifyPin, verifyUsage, runCompanion, parseCompanionOutput, companionFailureText, writePin, pinFile, installedTreeDigest, snapshotVerified, stopCompanionBroker, sweepStaleSnapshots } from "./lib/pin.mjs";
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

    await sweepSnapshots(key);
    let pluginRoot;
    try {
      verifyPin();
      plugin = snapshotVerified(stateSubdir("ws"));
      pluginRoot = plugin.root;
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
    if (plugin && (await stopCompanionBroker(plugin.root)) > 0) {
      emitEvent({ source: "round", event: "hook.error", code: "broker_stop_failed", session_id: SESSION, artifact_key: key, data: { stage: "broker_stop_failed" } });
    }
    prep && !prep.nothing && prep.cleanup();
    plugin?.cleanup();
    lock.release();
  }
}

/**
 * Clears what rounds killed before their finally left in ws/ (see sweepStaleSnapshots); logs counts only, and only when
 * there was something to clear.
 * @param {string} key
 */
async function sweepSnapshots(key) {
  const s = await sweepStaleSnapshots(stateSubdir("ws"));
  if (s.swept + s.brokersLeft + s.failed === 0) return;
  const data = { swept: s.swept, brokers_left: s.brokersLeft, failed: s.failed };
  // Two literal sites, so scripts/list-codes.mjs (and T-OBS-3) sees the code.
  if (s.brokersLeft + s.failed > 0) emitEvent({ source: "round", event: "round.sweep", code: "snapshot_sweep_incomplete", session_id: SESSION, artifact_key: key, data });
  else emitEvent({ source: "round", event: "round.sweep", code: "ok", session_id: SESSION, artifact_key: key, data });
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
  review-round.mjs status [--cwd <dir>] [--session <id>]`;

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
      session: { type: "string" }
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
    default:
      process.stderr.write(USAGE + "\n");
      process.exitCode = 2;
  }
}

main().catch((err) => {
  out({ status: "op_error", error: { code: errorCode(err), message: /** @type {Error} */ (err).message, retryable: !NON_RETRYABLE.has(errorCode(err)) } }, EXIT.OP_ERROR);
});
