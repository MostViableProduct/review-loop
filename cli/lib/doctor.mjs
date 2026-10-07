// `review-loop doctor` (spec §6.5). Read-only: every check reads state through the helper the rest of the CLI or the
// engine uses, so a check cannot disagree with the code it diagnoses, and nothing is written but main's cli.exit event.
import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { mark } from "./io.mjs";
import { remedyFor } from "../../plugin/engine/lib/codes.mjs";
import { PREFLIGHT } from "./preflight.mjs";
import { runTool } from "./run.mjs";
import { installedPlugin, pickEntry, pluginEntries, PLUGIN_ID, sameMinor } from "./plugin.mjs";
import { legacyHookCommands, leftoverTemps, missingAskRules, modifiedBackups, readSettings } from "./settings.mjs";
import { assertConfigOwner } from "./configguard.mjs";
import { LIVE_REMEDY, liveCheck } from "./livecheck.mjs";
import { configPath, readConfig } from "../../plugin/engine/lib/config.mjs";
import { loadRubricSection, resolveRubricPath } from "../../plugin/engine/lib/rubric.mjs";
import { countOrphanBrokers, readPin, verifyPin } from "../../plugin/engine/lib/pin.mjs";
import { eventsPath, eventsPathProblem, PACKAGE_VERSION, stateDirProblem } from "../../plugin/engine/lib/events.mjs";
import { claudeConfigDir, stateRoot } from "../../plugin/engine/lib/paths.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";

/** @typedef {{ status: "pass" | "fail" | "warn" | "skip", code: string | null, fix: string | null, note: string | null }} Result */
/** `tool` is the per-run memoized runner (see memoRunner). @typedef {{ live: boolean, io: import("./io.mjs").IO, tool: import("./run.mjs").Runner }} CheckCtx */
/** @typedef {{ id: string, run: (ctx: CheckCtx) => Promise<Result> }} Check */

const NOTE_MAX = 200;
/** Notes can carry tool output or error messages: bounded so one row stays one row. @param {string | null | undefined} n */
export const capNote = (n) => {
  if (n == null) return null;
  // By code point, so the cut never splits a surrogate pair into a lone half.
  const chars = Array.from(n);
  return chars.length > NOTE_MAX ? `${chars.slice(0, NOTE_MAX - 1).join("")}…` : n;
};
/** @param {string | null} [note] @returns {Result} */
const pass = (note = null) => ({ status: "pass", code: null, fix: null, note: capNote(note) });
/** @param {string} note @returns {Result} */
const skip = (note) => ({ status: "skip", code: null, fix: null, note: capNote(note) });
/** @param {string} code @param {string} fix @param {{ warn?: boolean, note?: string | null }} [o] @returns {Result} */
const fail = (code, fix, o = {}) => ({ status: o.warn ? "warn" : "fail", code, fix, note: capNote(o.note) });

/**
 * One doctor run's runner: each distinct probe (command + args) runs once, however many checks read it, so a stalled
 * tool costs one timeout, not one per check. Created per `run()`, never shared across runs.
 * @returns {import("./run.mjs").Runner}
 */
export function memoRunner() {
  /** @type {Map<string, ReturnType<typeof runTool>>} */
  const seen = new Map();
  return (cmd, args, opts) => {
    if (opts?.stdio === "inherit") return runTool(cmd, args, opts);
    const key = JSON.stringify([cmd, args]);
    let p = seen.get(key);
    if (!p) seen.set(key, (p = runTool(cmd, args, opts)));
    return p;
  };
}

/**
 * A CliError/ReviewLoopError carrying a registered code becomes that code with its registry remedy; anything else is
 * rethrown to the runner (unexpected_error). A tool that is simply not installed is a skip here: its own row
 * (claude, codex_cli, gh) already fails with the install fix, and "timed out or could not run" would be wrong.
 * @param {unknown} err @param {boolean} [warn]
 */
function fromThrown(err, warn = false) {
  if (err instanceof CliError && err.code === "tool_failed" && err.detail === "missing") return skip(`${err.message} (see its own check)`);
  if ((err instanceof CliError || err instanceof ReviewLoopError) && typeof err.code === "string") {
    return fail(err.code, remedyFor(err.code), { warn, note: err.message });
  }
  throw err;
}

/**
 * The preflight item's own check and fix. A tool that could not run (timeout, spawn failure, oversized output) is
 * tool_failed, never the item's "install it" failure.
 * @param {string} id @param {{ code: string, why?: string }} o
 * @returns {Check["run"]}
 */
const fromPreflight = (id, o) => async (ctx) => {
  const item = PREFLIGHT.find((p) => p.id === id);
  if (!item) throw new Error(`no preflight item ${id}`);
  let r;
  try {
    r = await item.check(ctx.tool);
  } catch (err) {
    return fromThrown(err, !item.required);
  }
  if (r.status === "pass") return pass(r.note ?? null);
  const warn = r.status === "warn";
  if (r.failure && r.failure !== "missing") return fail("tool_failed", remedyFor("tool_failed"), { warn, note: r.note ?? null });
  return fail(o.code, (r.fix ?? item.fix).text, { warn, note: [r.note, o.why].filter(Boolean).join(": ") || null });
};

/** Unreadable settings are the check's failure (their own code), never a silent pass. */
function settingsObj() {
  try {
    return { obj: readSettings().obj, failure: null };
  } catch (err) {
    return { obj: {}, failure: fromThrown(err) };
  }
}

const NODE_FIXED = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
/** @param {string} p */
const executable = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The shim's lookup (plugin/bin/hook): REVIEW_LOOP_NODE_CANDIDATES alone when set; otherwise PATH, then the fixed
 * Homebrew paths. The hook runs with Claude Code's PATH, not this terminal's, so a node found only on this PATH is a
 * warning: a Claude started from the Dock may not see it.
 * @param {string[]} fixed
 * @returns {Result}
 */
export function nodeForHooks(fixed = NODE_FIXED) {
  const env = process.env.REVIEW_LOOP_NODE_CANDIDATES;
  if (env) {
    const hit = env.split(":").find(executable);
    return hit ? pass(hit) : fail("node_missing", "brew install node", { note: "no REVIEW_LOOP_NODE_CANDIDATES entry is executable" });
  }
  const hit = fixed.find(executable);
  if (hit) return pass(hit);
  const onPath = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => path.join(d, "node")).find(executable);
  if (onPath) return fail("node_missing", "brew install node", { warn: true, note: `only on this shell's PATH (${onPath}); Claude Code started outside a shell may not find it` });
  return fail("node_missing", "brew install node", { note: "the hook shim finds no node" });
}

/** @param {string} dir */
const stateDirFix = (dir) => ({
  symlink: `replace ${dir} (a link) with a real directory: move it aside; review-loop recreates it`,
  not_directory: `replace ${dir} (not a directory) with a real directory: move it aside; review-loop recreates it`,
  not_owned: `sudo chown -R "$USER" "${dir}"`,
  loose: `chmod 700 "${dir}"`
});

/** The one problem → code mapping for an unusable state directory (doctor and uninstall). @param {"symlink" | "not_directory" | "not_owned" | "loose"} why */
export const stateDirCode = (why) => (why === "symlink" || why === "not_directory" ? "state_symlink_rejected" : "state_dir_insecure");

/** @param {string} dir @param {"symlink" | "not_directory" | "not_owned" | "loose"} why */
const stateDirFailure = (dir, why) => fail(stateDirCode(why), stateDirFix(dir)[why], { note: why.replace("_", " ") });

const RUBRIC_CODES = ["rubric_source_missing", "rubric_symlink_rejected", "rubric_source_mismatch"];
const RUBRIC_FIX = "review-loop config set rubric <path>   (or: review-loop config set rubric default)";
const PIN_DRIFT_FIX = "review-loop setup   (without --yes: it shows what changed and asks before re-pinning)";
const GH = { code: "gh_unavailable" };

/** Every check doctor runs, in the spec §6.5 order. The only list: T-DOC-1 requires a failing fixture per id. @type {Check[]} */
export const DOCTOR_CHECKS = [
  { id: "claude", run: fromPreflight("claude", { code: "preflight_failed" }) },
  { id: "codex_cli", run: fromPreflight("codex_cli", { code: "preflight_failed" }) },
  { id: "codex_auth", run: fromPreflight("codex_auth", { code: "preflight_failed" }) },
  { id: "codex_plugin", run: fromPreflight("codex_plugin", { code: "preflight_failed" }) },
  { id: "gh", run: fromPreflight("gh", GH) },
  { id: "plugin_installed", async run(ctx) {
    let entries;
    try { entries = await pluginEntries(PLUGIN_ID, ctx.tool); } catch (err) { return fromThrown(err); }
    const p = pickEntry(entries, "user");
    if (!p) {
      const other = entries[0];
      if (!other) return fail("plugin_not_installed", "review-loop setup", { note: "not installed" });
      return fail("plugin_not_installed", `claude plugin install ${PLUGIN_ID} --scope user`, { note: `installed at ${other.scope} scope only, not user` });
    }
    if (!p.enabled) return fail("plugin_not_installed", "review-loop setup", { note: "installed but disabled" });
    return pass(p.version);
  } },
  { id: "version_skew", async run(ctx) {
    let p;
    try { p = await installedPlugin(PLUGIN_ID, ctx.tool); } catch { return skip("the plugin list could not be read (see plugin_installed)"); }
    if (!p) return skip("plugin not installed");
    if (!p.version) return skip("the plugin list shows no version");
    const note = `plugin ${p.version}, CLI ${PACKAGE_VERSION}`;
    return sameMinor(p.version, PACKAGE_VERSION) ? pass(note) : fail("plugin_version_skew", "review-loop update   (or: brew upgrade review-loop)", { note });
  } },
  { id: "legacy_hooks", async run() {
    const s = settingsObj();
    if (s.failure) return s.failure;
    const legacy = legacyHookCommands(s.obj);
    return legacy.length ? fail("legacy_hooks_present", "review-loop migrate", { note: `${legacy.length} legacy hook command(s)` }) : pass();
  } },
  { id: "ask_rules", async run() {
    const s = settingsObj();
    if (s.failure) return s.failure;
    const missing = missingAskRules(s.obj);
    return missing.length ? fail("ask_rules_missing", "review-loop setup", { note: `missing: ${missing.join(", ")}` }) : pass();
  } },
  { id: "config", async run() {
    try { assertConfigOwner("doctor"); } catch (err) { return fromThrown(err); }
    const r = readConfig();
    if (r.status === "absent") return pass("absent; defaults in use");
    if (r.status === "ok") return pass();
    if (r.code === "config_symlink_rejected") {
      return fail("config_symlink_rejected", `replace ${configPath()} (a symlink, never followed) with a regular file, or remove it (defaults apply) and run: review-loop config repair   (or: review-loop setup)`);
    }
    return fail("config_invalid", "review-loop config repair", { note: configPath() });
  } },
  { id: "rubric", async run() {
    try {
      loadRubricSection();
      return pass(readConfig().config.rubricPath === null ? "built-in" : resolveRubricPath());
    } catch (err) {
      if (!(err instanceof ReviewLoopError)) throw err;
      return fail(RUBRIC_CODES.includes(err.code) ? err.code : "rubric_source_mismatch", RUBRIC_FIX, { note: err.message });
    }
  } },
  { id: "pin", async run() {
    let pin;
    try { pin = readPin({ readOnly: true }); } catch (err) { return fromThrown(err); }
    if (!pin) return fail("plugin_pin_missing", "review-loop setup", { note: "no valid pin" });
    try {
      verifyPin({ readOnly: true });
      return pass(`Codex plugin ${pin.version}`);
    } catch (err) {
      if (err instanceof ReviewLoopError && err.code !== "plugin_pin_mismatch") return fromThrown(err);
      // A plain fs error while hashing means the pinned plugin tree is damaged: still a drift.
      return fail("plugin_pin_mismatch", PIN_DRIFT_FIX, { note: err instanceof Error ? err.message : null });
    }
  } },
  { id: "pr_binding", run: fromPreflight("gh", { ...GH, why: "a PR-head mismatch is stopped but not contained, and approval marks are not posted" }) },
  { id: "state_dir", async run() {
    const dir = stateRoot();
    const why = stateDirProblem(dir);
    if (why === null) return pass(dir);
    if (why === "absent") return pass("absent; created 0700 on first use");
    return stateDirFailure(dir, why);
  } },
  { id: "node_for_hooks", async run() { return nodeForHooks(); } },
  { id: "events_writable", async run() {
    const configured = readConfig().config.events.path;
    if (configured !== null) {
      const why = eventsPathProblem(configured);
      if (why !== null) return fail("events_path_rejected", "review-loop config set events.path <file>", { note: `configured events.path refused (${why.replaceAll("_", " ")}); events go to the default log instead` });
    } else {
      const why = stateDirProblem();
      if (why === "absent") return pass("state dir absent; the writer creates it 0700 on first use");
      if (why !== null) return stateDirFailure(stateRoot(), why);
    }
    const file = eventsPath();
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) return fail("events_unwritable", `move ${file} aside (it is not a regular file), or: review-loop config set events.path <file>`);
    try {
      fs.accessSync(st ? file : path.dirname(file), fs.constants.W_OK);
    } catch {
      return fail("events_unwritable", "review-loop config set events.path <file>", { note: `${file} is not writable` });
    }
    return pass(file);
  } },
  { id: "skill_duplicate", async run() {
    const skill = path.join(claudeConfigDir(), "skills", "review-loop", "SKILL.md");
    return fs.lstatSync(skill, { throwIfNoEntry: false }) ? fail("skill_duplicate", "review-loop migrate", { note: skill }) : pass();
  } },
  { id: "settings_backup_modified", async run() {
    let bad;
    try { bad = modifiedBackups(); } catch (err) { return fromThrown(err, true); }
    return bad.length
      ? fail("settings_detached_write", `compare ${bad[0]} with settings.json and copy over any change you need; then delete the backup`, { warn: true, note: `${bad.length} modified backup(s)` })
      : pass();
  } },
  { id: "settings_tmp_leftover", async run() {
    const left = leftoverTemps();
    return left.length ? fail("settings_tmp_leftover", `delete ${left[0]}; settings.json itself is intact`, { warn: true, note: `${left.length} leftover temp file(s)` }) : pass();
  } },
  { id: "orphaned_brokers", async run() {
    // Read-only: it counts, and prints the operator's commands; it never signals or sweeps.
    const o = countOrphanBrokers(path.join(stateRoot(), "ws"));
    if (!o.verified) return fail("orphaned_brokers", "check that `ps -A` runs in a terminal and that the state dir's ws/ folder is readable, and inspect any ws/plugin-* entry that is not a directory of yours (`ls -la` it: a link, a file, another user's), then re-run doctor", { warn: true, note: "unverified: the process table or ws/ could not be read, or a ws/ entry is not a snapshot directory" });
    if (o.count === 0 && o.kept === 0) return pass();
    return fail("orphaned_brokers", orphanFix(o), { warn: true, note: `${o.count} Codex broker(s) running from a removed snapshot; ${o.kept} snapshot(s) of an ended round still to clean` });
  } },
  { id: "live", async run(ctx) {
    if (!ctx.live) return fail("setup_complete_unverified", "review-loop doctor --live", { warn: true, note: "not run: it is one billed Codex review" });
    const r = await liveCheck(ctx.io);
    if (r.ok) return pass("a real Codex review ran end to end");
    ctx.io.err(`${r.text.slice(-2000)}\n`);
    return fail("live_check_failed", LIVE_REMEDY[r.detail], { note: r.detail });
  } }
];

/**
 * The operator's commands for `orphaned_brokers`: the sweep first, then, per broker whose snapshot is gone, how to
 * look at its tree and the `stop-orphan` command that re-checks it right before signalling. A broker whose snapshot
 * was deleted by hand could still belong to a running round, which is why doctor never stops one itself.
 * @param {ReturnType<typeof countOrphanBrokers>} o
 */
function orphanFix(o) {
  const engine = 'node "$(review-loop engine-path)/review-round.mjs"';
  const lines = [`${engine} sweep`];
  for (const b of o.orphans.slice(0, 10)) {
    lines.push(
      `      then, if broker ${b.pid} is still listed: ps -o pid,pgid,args -g ${b.pgid}`,
      `      and if that tree is a leftover (no review running): ${engine} stop-orphan --snapshot ${b.snapshot} --pid ${b.pid} --started ${b.started} --args-sha ${b.argsSha}`
    );
  }
  if (o.orphans.length > 10) lines.push(`      (${o.orphans.length - 10} more: run doctor again after these)`);
  return lines.join("\n");
}

/** Only the error's class, never its message or path. @param {unknown} err */
const errorClass = (err) => (err instanceof Error ? err.name : "other");

/**
 * @param {string[]} args @param {import("./io.mjs").IO} io @param {{ json: boolean }} ctx
 * @returns {Promise<{ code: string, json: { schema: string, ok: boolean, checks: Array<{ id: string } & Result> }> }>}
 */
export async function run(args, io, ctx) {
  const live = args.includes("--live");
  const tool = memoRunner();
  /** @type {Array<{ id: string } & Result>} */
  const checks = [];
  for (const c of DOCTOR_CHECKS) {
    /** @type {Result} */
    let r;
    try {
      r = await c.run({ live, io, tool });
    } catch (err) {
      r = fail("unexpected_error", `report a bug: the ${c.id} check crashed`, { note: errorClass(err) });
    }
    checks.push({ id: c.id, ...r });
    if (!ctx.json) io.err(`${mark(r.status, io.color)}  ${c.id}${r.note ? ` — ${r.note}` : ""}\n${r.fix && r.status !== "pass" ? `      Fix: ${r.fix}\n` : ""}`);
  }
  const ok = checks.every((c) => c.status !== "fail");
  if (!ctx.json) {
    const n = (/** @type {Result["status"]} */ s) => checks.filter((c) => c.status === s).length;
    io.err(`\n${n("fail")} failed, ${n("warn")} warning(s), ${n("pass")} ok\n`);
  }
  return { code: ok ? "ok" : "doctor_failed", json: { schema: "review-loop.doctor/1", ok, checks } };
}
