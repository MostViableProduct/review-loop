#!/usr/bin/env node
// Claude Code hook entry: session | track | stop | prompt | pr | prverify.
// Hooks never take the review lock and never write review records — only snapshots, markers and the pending summary.
import { fileURLToPath } from "node:url";
import { advisoryText, gateOutcome } from "./lib/presets.mjs";

const MODE = process.argv[2];
const MAX_STDIN = 16 * 1024 * 1024;

/** @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, code: string }>} */
async function readInput() {
  const chunks = [];
  let n = 0;
  for await (const c of process.stdin) {
    n += c.length;
    if (n > MAX_STDIN) return { ok: false, code: "hook_input_too_large" };
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, code: "hook_input_invalid" };
  } catch {
    return { ok: false, code: "hook_input_invalid" };
  }
}

let gateLogged = false;
/** Which PreToolUse gate is evaluating, so a crash is logged against it. @type {"pr" | "merge"} */
let activeGate = "pr";
/** The session id once parsed, so the crash path can still correlate its event. @type {string | null} */
let knownSession = null;

/**
 * The config is read on every hook call, so a preset change applies to the very next one. An unreadable config never
 * disables a gate: it reads as Default, loudly (one stderr line and one event).
 * @param {string | null} session
 * @returns {Promise<string>}
 */
async function loadPreset(session) {
  const { readConfig, configPath } = await import("./lib/config.mjs");
  const cfg = readConfig();
  if (cfg.status === "invalid") {
    // Repair refuses a linked file or folder, so only a damaged file is pointed at it.
    const { remedyFor } = await import("./lib/codes.mjs");
    const fix = cfg.code === "config_invalid" ? "run `review-loop config repair`" : remedyFor(cfg.code);
    process.stderr.write(`review-loop: config invalid (${cfg.code}) at ${configPath()}; using Default preset — ${fix}\n`);
    const { emitEvent } = await import("./lib/events.mjs");
    emitEvent({ source: "hook", event: "config.invalid", code: cfg.code, session_id: session, data: {} });
  }
  return cfg.config.preset;
}

/** Failure paths cannot afford to be noisy or to throw: an unreadable config reads as Default, already reported by the gate itself. */
async function quietPreset() {
  try {
    const { readConfig } = await import("./lib/config.mjs");
    return readConfig().config.preset;
  } catch {
    return "default";
  }
}

/**
 * The single gate.decision of one gate evaluation. Emitting never changes the decision.
 * @param {{ gate: "stop" | "pr" | "prompt" | "prverify" | "merge", outcome: "blocked" | "warned" | "denied" | "allowed" | "skipped", preset: string, code: string, session: string | null, pending: number, artifactKey?: string, detail?: string | null }} d
 */
async function logGate(d) {
  gateLogged = true;
  try {
    const { emitEvent } = await import("./lib/events.mjs");
    emitEvent({ source: "hook", event: "gate.decision", code: d.code, detail: d.detail ?? null, session_id: d.session, artifact_key: d.artifactKey ?? null, data: { gate: d.gate, outcome: d.outcome, preset: d.preset, pending_count: d.pending } });
  } catch {
    // A logging failure never changes a gate decision.
  }
}

/**
 * The PR gate's failure output: Advisory never denies, so it warns; every other preset fails closed.
 * pending_count is 1 whenever the gate flagged the attempt (denied or warned), the same on every path.
 * @param {string} code @param {string} reason @param {string | null} session @param {boolean} [log]
 */
async function prFailure(code, reason, session, log = true) {
  const preset = await quietPreset();
  if (gateOutcome(preset, activeGate, true) === "warn") {
    emit({ systemMessage: advisoryText(reason) });
    if (log) await logGate({ gate: activeGate, outcome: "warned", preset, code, session, pending: 1 });
    return;
  }
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  if (log) await logGate({ gate: activeGate, outcome: "denied", preset, code, session, pending: 1 });
}

/**
 * Unreadable input never means "nothing to do": the PR gate denies; every other mode reports loudly.
 * Stop reports rather than blocks — without readable input it cannot see stop_hook_active, so blocking could loop forever.
 * @param {string} code @param {string | null} [session]
 */
async function inputFailure(code, session = null) {
  try {
    const { emitEvent } = await import("./lib/events.mjs");
    emitEvent({ source: "hook", event: "hook.error", code, session_id: session, data: { stage: "hook_input_error", mode: MODE } });
  } catch {
    // The loud output below still happens.
  }
  const msg = `⚠ review-loop ${MODE} hook could not read its input (${code}) — review status UNKNOWN; run \`node ${JSON.stringify(fileURLToPath(new URL("./review-round.mjs", import.meta.url)))} status\``;
  if (MODE === "pr") {
    await prFailure(code, `review-loop [${code}]: the PR gate could not read the tool call; it fails closed`, session);
  } else if (MODE === "prompt") {
    emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: msg } });
  } else {
    emit({ systemMessage: msg });
  }
}

/** @param {unknown} obj */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** The plugin outlives `brew uninstall review-loop`; say so once per session. A PATH lookup by fs only: no subprocess, no content. */
async function noticeIfCliMissing() {
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Tests replace the fallback directories so a machine that has the CLI installed still exercises "missing".
    const fallbacks = process.env.REVIEW_LOOP_TEST_FALLBACK_DIRS !== undefined ? process.env.REVIEW_LOOP_TEST_FALLBACK_DIRS.split(path.delimiter).filter(Boolean) : ["/opt/homebrew/bin", "/usr/local/bin"];
    const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...fallbacks];
    const found = dirs.some((d) => {
      try {
        const f = path.join(d, "review-loop");
        fs.accessSync(f, fs.constants.X_OK);
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
    if (!found) emit({ systemMessage: "review-loop: the review-loop CLI is missing (was `brew uninstall review-loop` run?). To finish uninstalling: claude plugin uninstall review-loop@review-loop — or reinstall with brew install MostViableProduct/tap/review-loop" });
  } catch {
    // The notice is advisory: any failure means no notice, never a broken session hook.
  }
}

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : null);

async function main() {
  const read = await readInput();
  if (!read.ok) return inputFailure(read.code);
  const input = read.value;
  const session = str(input.session_id);
  knownSession = session;
  const cwd = str(input.cwd) ?? process.cwd();
  const toolInput = /** @type {Record<string, unknown>} */ (typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {});

  if (MODE === "pr") {
    const toolName = str(input.tool_name) ?? "";
    const command = str(toolInput.command);
    let merge = /merge_pull_request$/.test(toolName);
    if (toolName === "Bash") {
      if (command === null) return inputFailure("hook_input_invalid", session);
      // Fast path: this runs on every Bash call; cmdparse is tiny, the gate's git/gh machinery loads only on a hit.
      const { mentionsPrCreate, mentionsMerge } = await import("./lib/cmdparse.mjs");
      merge = mentionsMerge(command);
      if (!merge && !mentionsPrCreate(command)) return;
    } else if (!merge && !/create_pull_request$/.test(toolName)) {
      return inputFailure("hook_input_invalid", session);
    }
    const preset = await loadPreset(session);
    if (merge) {
      // A merge (or a create+merge compound) is the merge gate's alone; "not_merge" falls through to the create gate.
      // The merge classifier also denies a raw-client PR creation, which it attributes to gate "pr".
      activeGate = "merge";
      const { evaluateMergeGate } = await import("./lib/merge.mjs");
      const m = toolName === "Bash" ? await evaluateMergeGate({ cwd, session, command: /** @type {string} */ (command), preset }) : await evaluateMergeGate({ cwd, session, mcpInput: toolInput, preset });
      if (m.code !== "not_merge") {
        if (m.decision === "deny") emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: m.message } });
        else if (m.message) emit({ systemMessage: m.message });
        const outcome = m.decision === "deny" ? "denied" : m.decision === "warn" ? "warned" : m.code === "kill_switch" ? "skipped" : "allowed";
        await logGate({ gate: m.gate, outcome, preset, code: m.code, session, pending: m.decision === "allow" ? 0 : 1 });
        return;
      }
      activeGate = "pr";
    }
    const { evaluatePrGate } = await import("./lib/prgate.mjs");
    const prBudget = process.env.REVIEW_LOOP_TEST_SEAMS === "1" ? Number(process.env.REVIEW_LOOP_TEST_PR_BUDGET_MS) : NaN;
    const deadlineMs = Number.isFinite(prBudget) && prBudget > 0 ? prBudget : undefined;
    const r = toolName === "Bash" ? await evaluatePrGate({ cwd, session, command: /** @type {string} */ (command), deadlineMs }) : await evaluatePrGate({ cwd, session, mcpInput: toolInput, deadlineMs });
    if (!r) return;
    /** @type {"denied" | "warned" | "allowed" | "skipped"} */
    let outcome = r.code === "kill_switch" ? "skipped" : "allowed";
    if (r.decision === "deny") {
      // Advisory warns even on a parse/argument error: it never blocks (spec §5.2).
      if (gateOutcome(preset, "pr", true) === "warn") {
        emit({ systemMessage: advisoryText(r.message) });
        outcome = "warned";
      } else {
        emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.message } });
        outcome = "denied";
      }
    } else if (r.systemMessage) {
      emit({ systemMessage: r.systemMessage });
    }
    await logGate({ gate: "pr", outcome, preset, code: r.code, session, pending: r.decision === "deny" ? 1 : 0, artifactKey: r.artifactKey });
    return;
  }

  if (MODE === "prverify") {
    const toolName = str(input.tool_name) ?? "";
    if (toolName === "Bash") {
      const { mentionsPrCreate } = await import("./lib/cmdparse.mjs");
      const command = str(toolInput.command) ?? "";
      if (!mentionsPrCreate(command)) return;
    }
    const preset = await loadPreset(session);
    const { evaluatePrVerify } = await import("./lib/prverify.mjs");
    const r = await evaluatePrVerify({ cwd, session, toolName, toolInput, toolResponse: input.tool_response, preset });
    if (r.code === "not_pr_creation") return;
    if (r.output) emit(r.output);
    await logGate({ gate: "prverify", outcome: r.outcome, preset, code: r.code, detail: r.detail, session, pending: r.outcome === "allowed" || r.outcome === "skipped" ? 0 : 1 });
    return;
  }

  if (!session) return inputFailure("hook_input_missing_session");
  const preset = await loadPreset(session);

  if (MODE === "session") {
    const { snapshotSession } = await import("./lib/detect.mjs");
    const { pruneBaselines } = await import("./lib/state.mjs");
    const { emitEvent } = await import("./lib/events.mjs");
    const { diagnosticCode } = await import("./lib/errors.mjs");
    try {
      pruneBaselines();
    } catch (err) {
      // Housekeeping only: it must never cost the session its snapshot.
      emitEvent({ source: "hook", event: "hook.error", code: diagnosticCode(err), session_id: session, data: { stage: "prune_failed", mode: MODE } });
    }
    await snapshotSession(session, cwd);
    await noticeIfCliMissing();
    return;
  }

  if (MODE === "track") {
    const file = str(toolInput.file_path) ?? str(toolInput.notebook_path);
    if (!file) return;
    const path = await import("node:path");
    const { identityForTouchedPath } = await import("./lib/detect.mjs");
    const { repoRoot } = await import("./lib/git.mjs");
    const { writeMarker, identityKey, readMarker } = await import("./lib/state.mjs");
    const abs = path.resolve(cwd, file);
    const root = await repoRoot(path.dirname(abs)).catch(() => null);
    const identity = identityForTouchedPath(abs, root);
    if (!identity) return;
    const existing = readMarker(identityKey(identity));
    writeMarker(identity, { source: "track", projectRoot: root ?? cwd, session });
    if (existing?.session !== session) {
      emit({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `review-loop: ${identity.kind} ${abs} is now pending an automated Codex review. Finish the ${identity.kind}, then run the review-loop:review-loop skill before presenting it as ready.`
        }
      });
    }
    return;
  }

  if (MODE === "stop") {
    const { pendingForSession } = await import("./lib/detect.mjs");
    const { writePendingSummary } = await import("./lib/state.mjs");
    const seamBudget = process.env.REVIEW_LOOP_TEST_SEAMS === "1" ? Number(process.env.REVIEW_LOOP_TEST_STOP_BUDGET_MS) : NaN;
    const { items, killSwitchRoot, killSwitchIgnored } = await pendingForSession(session, cwd, Number.isFinite(seamBudget) && seamBudget > 0 ? seamBudget : undefined);
    try {
      writePendingSummary(
        session,
        items.map(({ blocking, ...rest }) => rest)
      );
    } catch (err) {
      // The summary only feeds the prompt hook's reminder: failing to write it must never cost the block below.
      try {
        const { emitEvent } = await import("./lib/events.mjs");
        const { diagnosticCode } = await import("./lib/errors.mjs");
        emitEvent({ source: "hook", event: "hook.error", code: diagnosticCode(err), session_id: session, data: { stage: "summary_write_failed", mode: MODE } });
      } catch {
        // Same failing state dir; the block decision still goes out.
      }
    }
    const notes = killSwitchRoot ? [`⚠ review-loop: kill switch ${killSwitchRoot}/.claude/review-loop.off — changes in this repo are NOT reviewed (logged override).`] : [];
    if (killSwitchIgnored?.why === "tracked") notes.push(`⚠ review-loop: ${killSwitchIgnored.root}/.claude/review-loop.off is committed to the repo and is IGNORED — only a local, untracked switch disables review.`);
    if (killSwitchIgnored?.why === "mid_session") notes.push(`⚠ review-loop: ${killSwitchIgnored.root}/.claude/review-loop.off appeared during this session and is IGNORED until the next one — only a switch present when the session started disables review.`);
    const blocking = items.filter((i) => i.blocking);
    const pending = blocking.length > 0;
    const action = gateOutcome(preset, "stop", pending);
    const reason =
      `review-loop: ${blocking.length} artifact(s) changed this session and are not reviewed. Invoke the review-loop:review-loop skill and run:\n` +
      blocking.map((i) => `- ${i.label} [${i.status}${i.reason ? `: ${i.reason}` : ""}]\n  ${i.command}`).join("\n");
    const log = (/** @type {"blocked" | "warned" | "allowed" | "skipped"} */ outcome) =>
      logGate({ gate: "stop", outcome, preset, code: outcome === "skipped" ? "kill_switch" : pending ? "review_pending" : "reviewed", session, pending: blocking.length });
    if (action === "block" && input.stop_hook_active !== true) {
      emit({ decision: "block", reason, ...(notes.length ? { systemMessage: notes.join("\n") } : {}) });
      return log("blocked");
    }
    if (action === "warn") {
      const others = items.filter((i) => !i.blocking).map(itemLine);
      emit({ systemMessage: [...notes, reason, ...others].join("\n") });
      return log("warned");
    }
    const lines = items.map(itemLine);
    if (lines.length || notes.length) emit({ systemMessage: [...notes, ...lines].join("\n") });
    return log(killSwitchRoot ? "skipped" : "allowed");
  }

  if (MODE === "prompt") {
    const { readPendingSummary } = await import("./lib/state.mjs");
    const s = readPendingSummary(session);
    const count = s?.items.length ?? 0;
    if (!s || count === 0) return logGate({ gate: "prompt", outcome: "allowed", preset, code: "reviewed", session, pending: 0 });
    // Only with something pending: this runs on every prompt, and git/prgate load solely to pick the log label.
    const { repoRoot } = await import("./lib/git.mjs");
    const { killSwitchForSession } = await import("./lib/prgate.mjs");
    const root = await repoRoot(cwd).catch(() => null);
    const skipped = root !== null && (await killSwitchForSession(session, root)) === "on";
    const resume = s.items.filter((i) => i.status !== "awaiting_human" && i.status !== "stopped");
    const waiting = s.items.filter((i) => i.status === "awaiting_human");
    const parts = [];
    if (resume.length) {
      parts.push(
        "review-loop: unreviewed artifacts from this session — resume the review loop (review-loop:review-loop skill) before other work unless the user says otherwise:\n" +
          resume.map((i) => `- ${i.label} [${i.status}${i.reason ? `: ${i.reason}` : ""}] → ${i.command}`).join("\n")
      );
    }
    if (waiting.length) {
      parts.push(
        "review-loop: waiting on the user's decision (do NOT resume these; if the user's message answers the page, record it with `review-round.mjs decide`):\n" +
          waiting.map((i) => `- ${i.label} [${i.reason ?? "decision"}] key=${i.key}`).join("\n")
      );
    }
    emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: parts.join("\n\n") } });
    await logGate({ gate: "prompt", outcome: skipped ? "skipped" : "warned", preset, code: skipped ? "kill_switch" : "review_pending", session, pending: count });
  }
}

/** @param {{ label: string, status: string, reason: string | null }} i */
function itemLine(i) {
  return `⚠ review-loop: ${i.label} — ${i.status === "awaiting_human" ? "WAITING ON YOUR DECISION" : `${i.status.toUpperCase()}, NOT reviewed`}${i.reason ? ` (${i.reason})` : ""}`;
}

main().catch(async (err) => {
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unexpected_error";
  let diagnosed = "unexpected_error";
  try {
    const { emitEvent } = await import("./lib/events.mjs");
    const { diagnosticCode } = await import("./lib/errors.mjs");
    diagnosed = diagnosticCode(err);
    emitEvent({ source: "hook", event: "hook.error", code: diagnosed, session_id: knownSession, data: { stage: "hook_error", mode: MODE } });
  } catch {
    // Logging must never mask the hook's own failure handling below.
  }
  if (MODE === "pr") {
    // The PR gate fails closed, except under Advisory, which never blocks. One decision per attempt: none if it was already logged.
    const reason = `review-loop [hook_error:${code}]: the PR gate could not evaluate this call; fix the error or use the kill switch`;
    await prFailure(diagnosed, reason, knownSession, !gateLogged);
  } else if (MODE === "prverify") {
    // Fails closed, except under Advisory, which never blocks. One decision per evaluation: none if it was already logged.
    const preset = await quietPreset();
    const text = `review-loop [hook_error:${code}]: PR verification failed; check the PR's head commit`;
    const warn = gateOutcome(preset, "prverify", true) === "warn";
    emit(warn ? { systemMessage: `⚠ ${text}` } : { continue: false, stopReason: text });
    if (!gateLogged) await logGate({ gate: "prverify", outcome: warn ? "warned" : "denied", preset, code: diagnosed, session: knownSession, pending: 1 });
  } else if (MODE === "stop" || MODE === "track" || MODE === "session") {
    emit({ systemMessage: `⚠ review-loop ${MODE} hook failed (${code}); review status unknown — run \`review-round.mjs status\`` });
  }
});
