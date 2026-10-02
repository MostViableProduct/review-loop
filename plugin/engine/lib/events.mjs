import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODES, EVENT_CATALOG } from "./codes.mjs";
import { readConfig } from "./config.mjs";
import { ReviewLoopError } from "./errors.mjs";
import { ensurePrivateDir, MiB } from "./fsutil.mjs";
import { stateRoot } from "./paths.mjs";

export const SCHEMA = "review-loop.event/1";
const LINE_MAX = 4096;
const ROTATE_AT = 5 * MiB;
const RUN_ID = crypto.randomUUID();
const SESSION_RE = /^[A-Za-z0-9-]{1,64}$/;
const KEY_RE = /^[0-9a-f]{24}$/;
const X64 = "x".repeat(64);
let warned = false;

/** At most one stderr warning per process, whichever failure comes first. @param {string} msg */
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  process.stderr.write(msg);
}

export const PACKAGE_VERSION = (() => {
  try {
    const manifest = new URL("../../.claude-plugin/plugin.json", import.meta.url);
    const v = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
})();

const defaultEventsPath = () => path.join(stateRoot(), "events.jsonl");

/**
 * The effective log path (spec §8.4). A configured `events.path` is used only if its parent is an existing directory
 * the user owns (lstat, so a symlinked parent fails) and the file is absent or a regular file the user owns. Otherwise:
 * the default path, plus one stderr warning with no path in it.
 */
export function eventsPath() {
  const configured = readConfig().config.events.path;
  if (configured === null) return defaultEventsPath();
  if (eventsPathProblem(configured) === null) return configured;
  warnOnce("review-loop: events.path rejected (must be a regular file you own, in a directory you own); using the default log\n");
  return defaultEventsPath();
}

/**
 * The one rule for a configured events path, shared by `eventsPath()` and `config set events.path`.
 * @param {string} file
 * @returns {null | "not_absolute" | "missing_parent" | "parent_not_directory" | "not_owned" | "symlink" | "not_regular_file"} why it is rejected, or null when usable
 */
export function eventsPathProblem(file) {
  if (!path.isAbsolute(file)) return "not_absolute";
  // lstat of the parent alone follows a link higher up (/x/link/sub/events.jsonl), so walk every ancestor. Only a
  // root-owned link is followed: the system's own (/tmp, /var on macOS), which no user can retarget.
  for (let d = path.dirname(path.resolve(file)); path.dirname(d) !== d; d = path.dirname(d)) {
    const a = fs.lstatSync(d, { throwIfNoEntry: false });
    if (a === undefined) return "missing_parent";
    if (a.isSymbolicLink() && a.uid !== 0) return "symlink";
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const owned = (/** @type {fs.Stats} */ st) => uid === null || st.uid === uid;
  let parent;
  let st;
  try {
    parent = fs.lstatSync(path.dirname(file));
    st = fs.lstatSync(file, { throwIfNoEntry: false });
  } catch {
    return "missing_parent";
  }
  if (!parent.isDirectory()) return "parent_not_directory";
  if (!owned(parent)) return "not_owned";
  if (st === undefined) return null;
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isFile()) return "not_regular_file";
  return owned(st) ? null : "not_owned";
}

/**
 * The one rule for the state directory the event writer uses, shared with `doctor`'s state_dir check. Read-only.
 * @param {string} [dir]
 * @returns {null | "absent" | "symlink" | "not_directory" | "not_owned" | "loose"} why it is unusable, "absent" (the writer creates it 0700), or null
 */
export function stateDirProblem(dir = stateRoot()) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) return "absent";
  if (st.isSymbolicLink()) return "symlink";
  if (!st.isDirectory()) return "not_directory";
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "not_owned";
  return st.mode & 0o077 ? "loose" : null;
}

/**
 * The state directory is created 0700 when absent. An existing one is only verified, never chmodded: a user's own
 * loose directory is theirs to fix, and `doctor` says how.
 */
function assertStateDir() {
  const dir = stateRoot();
  const problem = stateDirProblem(dir);
  if (problem === "absent") {
    ensurePrivateDir(dir);
    return;
  }
  if (problem !== null) {
    throw new ReviewLoopError("state_dir_insecure", "the state directory is not a private directory owned by this user");
  }
}

/**
 * @typedef {{ source: "cli" | "hook" | "round", event: string, code: string, detail?: string | null, exit_code?: number | null,
 *   session_id?: string | null, artifact_key?: string | null, data?: Record<string, unknown> }} EventInput
 */

/** @param {EventInput} e */
function build(e) {
  const known = Object.hasOwn(EVENT_CATALOG, e.event);
  const spec = known ? EVENT_CATALOG[e.event] : EVENT_CATALOG.event_unregistered;
  const code = Object.hasOwn(CODES, e.code) ? e.code : "unregistered_code";
  const details = CODES[code]?.details ?? [];
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const [field, check] of Object.entries(spec.data)) data[field] = check(e.data?.[field]);
  return {
    schema: SCHEMA,
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    source: ["cli", "hook", "round"].includes(e.source) ? e.source : "hook",
    event: known ? e.event : "event_unregistered",
    code,
    detail: typeof e.detail === "string" && details.includes(e.detail) ? e.detail : null,
    exit_code: Number.isInteger(e.exit_code) && /** @type {number} */ (e.exit_code) >= 0 && /** @type {number} */ (e.exit_code) <= 255 ? e.exit_code : null,
    version: PACKAGE_VERSION,
    session_id: typeof e.session_id === "string" && SESSION_RE.test(e.session_id) ? e.session_id : null,
    artifact_key: typeof e.artifact_key === "string" && KEY_RE.test(e.artifact_key) ? e.artifact_key : null,
    data
  };
}

/** @typedef {ReturnType<typeof build>} EventLine */

/** The validated line object, exactly as it will be written. @param {EventInput} e @returns {EventLine} */
export function buildEvent(e) {
  return build(e);
}

/**
 * Build and append one schema-v1 line. Never throws and never changes the caller's decision.
 * @param {EventInput} e @returns {boolean}
 */
export function emitEvent(e) {
  try {
    return writeEvent(build(e));
  } catch {
    return false;
  }
}

/**
 * Append one already-built line; a line that fails `validateLine` is refused. Never throws: a logging failure must not change a gate decision or an exit code.
 * @param {EventLine} obj
 * @returns {boolean}
 */
export function writeEvent(obj) {
  try {
    if (validateLine(obj).length > 0) throw new Error("invalid_line");
    const line = JSON.stringify(obj) + "\n";
    if (Buffer.byteLength(line) > LINE_MAX) throw new Error("line_cap");
    const file = eventsPath();
    if (file === defaultEventsPath()) assertStateDir();
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) throw new Error("not_regular");
    if (st && st.size > ROTATE_AT) fs.renameSync(file, `${file}.1`);
    // O_NOFOLLOW: a symlink swapped in after the lstat fails the open (ELOOP) instead of redirecting the append.
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      // The open's 0o600 applies only to a file it creates: an existing log (configured, or older) keeps its mode.
      const fst = fs.fstatSync(fd);
      if (!fst.isFile()) throw new Error("not_regular");
      if ((fst.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    const reason = err instanceof ReviewLoopError && err.code === "state_dir_insecure" ? "state_dir_insecure" : "write_failed";
    warnOnce(`review-loop: event log not writable (${reason})\n`);
    return false;
  }
}

/** @param {Record<string, unknown>} line @returns {string[]} problems; empty when valid */
export function validateLine(line) {
  const problems = [];
  const keys = ["schema", "ts", "run_id", "source", "event", "code", "detail", "exit_code", "version", "session_id", "artifact_key", "data"];
  if (JSON.stringify(Object.keys(line)) !== JSON.stringify(keys)) problems.push("keys");
  if (line.schema !== SCHEMA) problems.push("schema");
  if (!Object.hasOwn(EVENT_CATALOG, String(line.event))) problems.push("event");
  if (!Object.hasOwn(CODES, String(line.code))) problems.push("code");
  const spec = Object.hasOwn(EVENT_CATALOG, String(line.event)) ? EVENT_CATALOG[String(line.event)] : undefined;
  if (spec) {
    const d = /** @type {Record<string, unknown>} */ (line.data ?? {});
    if (JSON.stringify(Object.keys(d)) !== JSON.stringify(Object.keys(spec.data))) problems.push("data.keys");
    for (const [k, check] of Object.entries(spec.data)) if (d[k] !== null && check(d[k]) === null) problems.push(`data.${k}`);
  }
  return problems;
}

/** The largest line this event can produce, from the catalog's bounds (T-OBS-6). @param {string} name */
export function maxLineBytes(name) {
  const spec = EVENT_CATALOG[name];
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const k of Object.keys(spec.data)) data[k] = k === "dims" ? Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Dimension${i}Name`, 10.0])) : X64;
  const worst = { schema: SCHEMA, ts: new Date().toISOString(), run_id: RUN_ID, source: "round", event: name, code: X64, detail: X64, exit_code: 255, version: "999.999.999", session_id: X64, artifact_key: "f".repeat(24), data };
  return Buffer.byteLength(JSON.stringify(worst) + "\n");
}
