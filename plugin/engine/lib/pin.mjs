import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ReviewLoopError } from "./errors.mjs";
import { safeReadFile, sha256hex, atomicWriteJson, readJsonValidated, isObject, MiB } from "./fsutil.mjs";
import { run, onReap, trustedPs } from "./proc.mjs";
import { claudeConfigDir as claudeDir, stateRoot } from "./paths.mjs";
import { SEVERITIES } from "./scoring.mjs";
import { companionArgs } from "./codexcfg.mjs";

const REGISTRY_MAX_BYTES = 1 * MiB;

/** @param {unknown} p an absolute path naming a real directory (not a link) */
function isRealDirectory(p) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return false;
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * installed_plugins.json is untrusted: its installPath picks the companion script the engine later runs. It is read
 * through the link-refusing bounded reader and any doubt falls back to the documented cache layout. The pin's content
 * hash remains the real guard on whatever directory this returns.
 */
export function pluginBase() {
  if (process.env.REVIEW_LOOP_PLUGIN_BASE) return process.env.REVIEW_LOOP_PLUGIN_BASE;
  const root = claudeDir();
  try {
    const file = path.join(root, "plugins", "installed_plugins.json");
    const data = JSON.parse(safeReadFile(file, REGISTRY_MAX_BYTES, { symlink: "plugin_pin_mismatch" }).toString("utf8"));
    const entries = isObject(data) && isObject(data.plugins) ? data.plugins["codex@openai-codex"] : null;
    const user = Array.isArray(entries) ? entries.find((e) => isObject(e) && e.scope === "user" && isRealDirectory(e.installPath)) : undefined;
    if (isObject(user) && typeof user.installPath === "string") return path.dirname(user.installPath);
  } catch {
    // Unreadable, linked or reshaped registry: fall back to the cache layout the plugin has always used.
  }
  // Recomputed per call so tests that swap HOME see it.
  return path.join(root, "plugins", "cache", "openai-codex", "codex");
}

export function pinFile() {
  return process.env.REVIEW_LOOP_PIN_FILE || path.join(stateRoot(), "plugin-pin.json");
}

/** Files that define the review's behaviour: the command wrapper, prompt, schema, and every script (arg parsing lives in lib/). */
const FIXED_FILES = ["commands/adversarial-review.md", "prompts/adversarial-review.md", "schemas/review-output.schema.json"];

/**
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function computeHashes(root) {
  /** @type {Record<string, string>} */
  const out = {};
  // A pinned file is hashed by content and executed by path, so a symlink would let its target change under an
  // unchanged pin. None ship in the plugin; any link (file or directory, at any depth) fails the pin.
  const add = (/** @type {string} */ rel) => {
    out[rel] = sha256hex(safeReadFile(path.join(root, rel), 8 * MiB, { symlink: "plugin_pin_mismatch" }, { within: root }));
  };
  for (const rel of FIXED_FILES) {
    if (!fs.existsSync(path.join(root, rel)) && !isLink(path.join(root, rel))) throw new ReviewLoopError("plugin_pin_mismatch", `pinned file missing: ${rel}`);
    add(rel);
  }
  const walk = (/** @type {string} */ relDir) => {
    for (const name of fs.readdirSync(path.join(root, relDir)).sort()) {
      const rel = path.posix.join(relDir, name);
      const st = fs.lstatSync(path.join(root, rel));
      if (st.isDirectory()) walk(rel);
      else add(rel);
    }
  };
  walk("scripts");
  return out;
}

/** @param {string} p */
function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** A plugin_pin page's record of the tree it showed. @param {unknown} v */
export function isTreeRef(v) {
  return isObject(v) && typeof v.version === "string" && VERSION_RE.test(v.version) && typeof v.digest === "string" && /^[0-9a-f]{64}$/.test(v.digest);
}

/** The version becomes a path segment of the code we execute: exact semver only (no `..`, no separators). @param {unknown} v */
export function isPin(v) {
  return (
    isObject(v) &&
    typeof v.version === "string" &&
    VERSION_RE.test(v.version) &&
    isObject(v.files) &&
    Object.values(v.files).every((h) => typeof h === "string")
  );
}

/** @param {{ readOnly?: boolean }} [opts] readOnly: a corrupt pin reads as absent but is not quarantined */
export function readPin(opts = {}) {
  return readJsonValidated(pinFile(), isPin, path.dirname(pinFile()), undefined, opts);
}

/** @param {string} base */
export function latestInstalledVersion(base = pluginBase()) {
  const versions = fs
    .readdirSync(base)
    .filter((n) => VERSION_RE.test(n))
    .sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    });
  if (!versions.length) throw new ReviewLoopError("plugin_pin_mismatch", `no installed codex plugin version under ${base}`);
  return versions[versions.length - 1];
}

/** Re-pin happens only after the human chooses it on the page. */
/**
 * Digest of the installed plugin tree a plugin_pin page is about. Null when the tree cannot be hashed at all.
 * @returns {{ version: string, digest: string } | null}
 */
export function installedTreeDigest() {
  try {
    const version = latestInstalledVersion();
    return { version, digest: treeDigest(version, computeHashes(path.join(pluginBase(), version))) };
  } catch {
    return null;
  }
}

/** @param {string} version @param {Record<string, string>} files */
const treeDigest = (version, files) => sha256hex(JSON.stringify({ version, files }));

/**
 * @param {string} [version]
 * @param {{ digest: string }} [expected] the tree the user was shown: hashed once, compared, and exactly those hashes
 *   are written — nothing can change between the check and the pin.
 */
export function writePin(version = latestInstalledVersion(), expected) {
  const root = path.join(pluginBase(), version);
  const files = computeHashes(root);
  if (expected && treeDigest(version, files) !== expected.digest) {
    throw new ReviewLoopError("decision_stale", "the plugin changed since the pin page was shown; re-run the round for a current page");
  }
  const pin = { version, files, pinnedAt: new Date().toISOString() };
  atomicWriteJson(pinFile(), pin, path.dirname(pinFile()));
  return pin;
}

/**
 * Fail closed on any drift: missing version dir, changed, added or removed file.
 * @param {{ readOnly?: boolean }} [opts] passed to readPin
 * @returns {string} the pinned plugin root
 */
export function verifyPin(opts = {}) {
  const pin = readPin(opts);
  if (!pin) throw new ReviewLoopError("plugin_pin_mismatch", `no valid pin at ${pinFile()}; run review-round.mjs repin after reviewing the plugin`);
  const root = path.join(pluginBase(), pin.version);
  if (!fs.existsSync(root)) throw new ReviewLoopError("plugin_pin_mismatch", `pinned plugin version ${pin.version} is not installed`, { version: pin.version });
  const now = computeHashes(root);
  const changed = Object.keys(pin.files).filter((k) => now[k] !== undefined && now[k] !== pin.files[k]);
  const removed = Object.keys(pin.files).filter((k) => now[k] === undefined);
  const added = Object.keys(now).filter((k) => pin.files[k] === undefined);
  if (changed.length || removed.length || added.length) {
    const parts = [
      changed.length ? `changed: ${changed.join(", ")}` : "",
      removed.length ? `removed: ${removed.join(", ")}` : "",
      added.length ? `added: ${added.join(", ")}` : ""
    ].filter(Boolean);
    throw new ReviewLoopError("plugin_pin_mismatch", `codex plugin ${pin.version} differs from the pin (${parts.join("; ")})`, { changed, removed, added });
  }
  return root;
}

/**
 * The companion's private temp dir: `<snapshot>/tmp`, or, when a socket path there would pass the unix socket limit (a
 * long state dir), a short `rl-XXXXXX` under the OS temp dir recorded in the snapshot's tmp.json and removed with it
 * (removeSnapshot). null only when even that is too long: the companion then keeps the inherited temp dir.
 * @param {string} root
 */
export function companionTmp(root) {
  const fits = (/** @type {string} */ d) => Buffer.byteLength(path.join(d, "cxc-XXXXXX", "broker.sock")) <= SOCKET_PATH_MAX;
  const inside = path.join(root, "tmp");
  if (fits(inside)) {
    fs.mkdirSync(inside, { recursive: true, mode: 0o700 });
    return inside;
  }
  if (!fits(path.join(os.tmpdir(), "rl-XXXXXX"))) return null;
  // Recorded before it is made: a kill between the two leaves a tmp.json naming a dir that is not there (removeSnapshot
  // treats that as gone), never a dir that nothing names. The token, written into the dir as soon as it exists, is
  // what proves the dir ours: a name that collides with an existing dir (EEXIST) never gets it.
  const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const token = crypto.randomBytes(16).toString("hex");
  for (let attempt = 0; ; attempt++) {
    const short = path.join(os.tmpdir(), `rl-${Array.from({ length: 6 }, () => ALNUM[crypto.randomInt(ALNUM.length)]).join("")}`);
    atomicWriteJson(path.join(root, TMP_FILE), { dir: short, token }, root);
    try {
      fs.mkdirSync(short, { mode: 0o700 });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST" || attempt >= 2) throw err;
      continue;
    }
    fs.writeFileSync(path.join(short, TMP_TOKEN_FILE), token, { flag: "wx", mode: 0o600 });
    return short;
  }
}

/** @param {unknown} v @returns {v is { dir: string, token: string }} */
function isTmpMarker(v) {
  return isObject(v) && Object.keys(v).length === 2 && typeof v.dir === "string" && typeof v.token === "string" && /^[0-9a-f]{32}$/.test(v.token);
}

/**
 * Removes the short temp dir tmp.json records, if it is ours; true once it is gone or proven not ours (left as it is).
 * The OS temp dir is shared, so a path checked there can be swapped (for a link) before it is used: the dir is first
 * detached by an atomic rename to `<dir>.rm`, and nothing is removed unless that is still the very directory checked
 * (same device and inode). A removal cut short leaves `<dir>.rm`, which the next call resumes from.
 * @param {{ dir: string, token: string }} v
 */
function removeShortTmp(v) {
  const hold = `${v.dir}.rm`;
  for (const p of [v.dir, hold]) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") continue;
      return false;
    }
    if (!st.isDirectory() || st.uid !== process.getuid?.()) return false;
    let held = null;
    try {
      fs.lstatSync(path.join(p, TMP_TOKEN_FILE));
      held = safeReadFile(path.join(p, TMP_TOKEN_FILE), 64, {}, { within: p }).toString("utf8");
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") return false;
    }
    // A prefix too (empty included): a token write cut short still marks the dir ours.
    if (held === null || !v.token.startsWith(held)) {
      // Empty and tokenless: a kill between its mkdir and its token (rmdir removes only an empty dir).
      if (held === null && p === v.dir && namesUpTo(p, 1).length === 0) fs.rmdirSync(p);
      continue;
    }
    if (p === v.dir) fs.renameSync(p, hold);
    const h = fs.lstatSync(hold);
    if (!h.isDirectory() || h.dev !== st.dev || h.ino !== st.ino) return false;
    // The token goes last: a removal that fails part-way leaves the dir still provably ours for the retry.
    for (const n of fs.readdirSync(hold)) if (n !== TMP_TOKEN_FILE) fs.rmSync(path.join(hold, n), { recursive: true, force: true });
    fs.rmSync(hold, { recursive: true, force: true });
  }
  return true;
}

/**
 * Removes a snapshot, after the short temp dir its tmp.json records. tmp.json is the only pointer to that dir, so the
 * snapshot is kept (false) unless the dir is confirmed gone or confirmed not ours: a tmp.json that cannot be read or is
 * not what companionTmp writes, or a removal that fails, keeps it for a later retry. The dir is removed only when it
 * holds this tmp.json's token (a real `rl-XXXXXX` directory of ours in the OS temp dir, never a link), or is empty (a
 * kill between its mkdir and its token); a dir without the token is someone else's and is left as it is. True when
 * the snapshot is removed.
 * @param {string} root
 */
export function removeSnapshot(root) {
  const marker = path.join(root, TMP_FILE);
  let tracked = true;
  try {
    fs.lstatSync(marker);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") return false;
    tracked = false;
  }
  if (tracked) {
    const tmps = new Set([os.tmpdir()]);
    try {
      tmps.add(fs.realpathSync(os.tmpdir()));
    } catch {
      // Compared as given.
    }
    try {
      const v = readJsonValidated(marker, isTmpMarker, root, 4096, { readOnly: true });
      if (!v || !/^rl-[A-Za-z0-9]{6}$/.test(path.basename(v.dir)) || !tmps.has(path.dirname(v.dir))) return false;
      if (!removeShortTmp(v)) return false;
    } catch {
      return false;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  return true;
}

/**
 * verifyPin checks the cache path, but executing that path later is a check/use gap (a plugin auto-update in between
 * would run unverified code). So copy the pinned files into a fresh private directory through the symlink-safe reader,
 * re-hash the COPIED bytes against the pin, and execute only from there. plugin.json (client name/version metadata,
 * read at run time) is copied unpinned so adopting this does not force a repin.
 * @param {string} parentDir private (0700) directory the snapshot is created in
 * @param {string | null} [artifactKey] the round's artifact key, recorded in owner.json so a later sweep that has to
 *   keep this snapshot reports it under its own round's key (snapshotOrigin), not the sweeping round's
 * @returns {{ root: string, cleanup: () => boolean }} cleanup: false when the snapshot was kept (see removeSnapshot)
 */
export function snapshotVerified(parentDir, artifactKey = null) {
  const pin = readPin();
  if (!pin) throw new ReviewLoopError("plugin_pin_mismatch", `no valid pin at ${pinFile()}`);
  const src = path.join(pluginBase(), pin.version);
  if (isLink(src)) throw new ReviewLoopError("plugin_pin_mismatch", `plugin root ${src} is a symlink`);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(parentDir, "plugin-"));
  const cleanup = () => removeSnapshot(root);
  try {
    const copy = (/** @type {string} */ rel, /** @type {Record<string, string>} */ codes) => {
      const bytes = safeReadFile(path.join(src, rel), 8 * MiB, codes, { within: src });
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(root, rel), bytes, { mode: 0o600 });
    };
    for (const rel of Object.keys(pin.files)) copy(rel, { symlink: "plugin_pin_mismatch", missing: "plugin_pin_mismatch", notFile: "plugin_pin_mismatch" });
    copy(path.join(".claude-plugin", "plugin.json"), { symlink: "plugin_pin_mismatch", missing: "plugin_pin_mismatch", notFile: "plugin_pin_mismatch" });
    const copied = computeHashes(root);
    const same = Object.keys(copied).length === Object.keys(pin.files).length && Object.entries(pin.files).every(([k, h]) => copied[k] === h);
    if (!same) throw new ReviewLoopError("plugin_pin_mismatch", `codex plugin ${pin.version} changed while it was being verified`);
    // Written after the hash check (it is not a plugin file). A round killed without its finally leaves the snapshot;
    // the next round's sweepStaleSnapshots removes it once this owner is provably gone.
    // Before the companion can start: a snapshot whose owner cannot be named would never read as dead, so it is not
    // made at all. Written whole (rename), so a kill mid-write leaves no half-file.
    const started = startTimeOf(process.pid);
    if (started === null) throw new ReviewLoopError("snapshot_owner_unknown", "ps could not read this round's start time, so its snapshot could not be marked");
    atomicWriteJson(path.join(root, OWNER_FILE), { pid: process.pid, started, ...(artifactKey && ORIGIN_KEY.test(artifactKey) ? { key: artifactKey } : {}) }, root);
    return { root, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * The only contract text the companion exposes is the top-level `help` usage (subcommand --help runs a review).
 * @param {string} root
 */
export async function verifyUsage(root) {
  const r = await run(process.execPath, [path.join(root, "scripts", "codex-companion.mjs"), "help"], { timeoutMs: 15_000 });
  const line = (r.stdout + r.stderr).split("\n").find((l) => /codex-companion\.mjs adversarial-review /.test(l)) ?? "";
  const required = ["--wait", "--base <ref>", "--scope <auto|working-tree|branch>"];
  const missing = required.filter((flag) => !line.includes(flag));
  if (missing.length) throw new ReviewLoopError("companion_usage_mismatch", `adversarial-review usage no longer lists: ${missing.join(", ")}`);
}

/**
 * @typedef {{ severity: "critical"|"high"|"medium"|"low", title: string, body: string, file: string,
 *   line_start: number, line_end: number, confidence: number, recommendation: string }} CodexFinding
 * @param {unknown} f
 * @returns {f is CodexFinding}
 */
function isFinding(f) {
  return (
    isObject(f) &&
    typeof f.severity === "string" &&
    SEVERITIES.includes(f.severity) &&
    typeof f.title === "string" &&
    f.title.length > 0 &&
    typeof f.body === "string" &&
    typeof f.file === "string" &&
    Number.isInteger(f.line_start) &&
    Number.isInteger(f.line_end) &&
    typeof f.confidence === "number" &&
    typeof f.recommendation === "string"
  );
}

/**
 * Stdout that is not the companion's JSON payload means --json was ignored/renamed → contract mismatch (exit 40).
 * A payload where Codex itself returned bad JSON (parseError) is an operational error (exit 30).
 * @param {string} stdout
 * @returns {{ kind: "ok", verdict: string, summary: string, findings: CodexFinding[] } | { kind: "codex_error", message: string }}
 */
export function parseCompanionOutput(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new ReviewLoopError("companion_contract_mismatch", "companion stdout is not JSON (--json ignored or renamed?)");
  }
  if (!isObject(payload)) throw new ReviewLoopError("companion_contract_mismatch", "companion JSON payload is not an object");
  const result = payload.result;
  if (result === null || result === undefined) {
    const msg = typeof payload.parseError === "string" ? payload.parseError : "codex returned no structured result";
    return { kind: "codex_error", message: msg.split("\n")[0].slice(0, 300) };
  }
  if (
    !isObject(result) ||
    (result.verdict !== "approve" && result.verdict !== "needs-attention") ||
    typeof result.summary !== "string" ||
    !Array.isArray(result.findings) ||
    !result.findings.every(isFinding)
  ) {
    throw new ReviewLoopError("companion_contract_mismatch", "companion result does not match the pinned review-output schema");
  }
  return { kind: "ok", verdict: result.verdict, summary: result.summary, findings: result.findings };
}

const FAILURE_TEXT_MAX_BYTES = 2 * 1024;

/** @param {string} s @param {"head" | "tail"} end */
function capBytes(s, end) {
  const b = Buffer.from(s, "utf8");
  if (b.length <= FAILURE_TEXT_MAX_BYTES) return s;
  // Cut on a character boundary: a UTF-8 continuation byte (10xxxxxx) never starts the kept window, and the head cut
  // backs off to the lead byte of a character it would split. A split character would decode to U+FFFD (3 bytes each).
  const cont = (/** @type {number} */ i) => (b[i] & 0xc0) === 0x80;
  if (end === "head") {
    let stop = FAILURE_TEXT_MAX_BYTES;
    while (stop > 0 && cont(stop)) stop--;
    return b.subarray(0, stop).toString("utf8");
  }
  let start = b.length - FAILURE_TEXT_MAX_BYTES;
  while (start < b.length && cont(start)) start++;
  return b.subarray(start).toString("utf8");
}

/**
 * Why a companion run that exited non-zero failed, for the operator's terminal and the live-check classifier only:
 * it is Codex's own text, so it never goes into an event or a record. stderr comes first; companion 1.0.6 leaves stderr
 * empty and reports Codex's error (a signed-out 401, say) only in its stdout JSON's `parseError`.
 * @param {{ stdout: string, stderr: string }} r
 * @returns {string} at most 2 KiB of UTF-8; "" when the companion said nothing
 */
export function companionFailureText(r) {
  if (r.stderr.trim()) return capBytes(r.stderr.trim(), "tail");
  const out = r.stdout.trim();
  /** @type {unknown} */
  let payload = null;
  try {
    payload = JSON.parse(out);
  } catch {
    return capBytes(out, "tail");
  }
  if (isObject(payload)) {
    const e = payload.error;
    const codexErr = isObject(payload.codex) ? payload.codex.stderr : null;
    for (const v of [payload.parseError, typeof e === "string" ? e : isObject(e) ? e.message : null, codexErr]) {
      if (typeof v === "string" && v.trim()) return capBytes(v.trim(), "head");
    }
  }
  return capBytes(out, "tail");
}

/**
 * @param {string} root pinned plugin root
 * @param {{ cwd: string, targetArgs: string[], focus: string, codex: { model: string | null, effort: string | null, source: "config" | "codex-inherited", passModel: string | null }, timeoutMs?: number }} p codex: the round's already-resolved settings (never re-resolved here)
 */
export async function runCompanion(root, p) {
  const args = [path.join(root, "scripts", "codex-companion.mjs"), ...companionArgs(["adversarial-review", "--wait", "--json"], p.codex), ...p.targetArgs, p.focus];
  // A round-private data dir inside the 0700 snapshot, never the Codex plugin's shared one: the companion writes the
  // review's job files and broker.json there, and cleanup removes them (so these rounds no longer show in /codex:status).
  const dataDir = companionDataDir(root);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // The companion's temp dir goes with the snapshot, so the broker's cxc-* session dir does too, even when the broker
  // dies before broker.json names it.
  const tmp = companionTmp(root);
  const tmpEnv = tmp ? { TMPDIR: tmp } : {};
  // The broker outlives the companion (detached, own session), so a signal must reap it from its broker.json.
  if (!reapers.has(root)) reapers.set(root, onReap(() => reapCompanionBroker(root)));
  /** @type {number | null} */
  let companionPid = null;
  // Recorded before the companion can have started a broker: a broker that dies before writing broker.json is then
  // still bounded by this pid window (see leaderlessAppServers). A failed write kills the companion's group at once
  // (run's onSpawn contract); the round's finally still stops whatever it may have started.
  const onSpawn = (/** @type {number} */ pid) => {
    atomicWriteJson(path.join(root, COMPANION_FILE), { pid }, root);
    companionPid = pid;
  };
  let r;
  try {
    r = await run(process.execPath, args, { cwd: p.cwd, env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...tmpEnv }, timeoutMs: p.timeoutMs ?? 15 * 60_000, maxBuffer: 32 * MiB, onSpawn });
  } catch (err) {
    if (companionPid === null && !(err instanceof ReviewLoopError)) throw new ReviewLoopError("snapshot_owner_unknown", `could not record the companion's pid: ${/** @type {Error} */ (err).message}`);
    throw err;
  } finally {
    // The first pid issued after the companion is gone closes the window: every broker it started has a lower one.
    const after = companionPid === null ? null : ps(["-o", "pid=", "-p", String(process.pid)])?.pid;
    if (companionPid !== null && typeof after === "number") {
      try {
        atomicWriteJson(path.join(root, COMPANION_FILE), { pid: companionPid, after }, root);
      } catch {
        // The window stays open-ended (no `after`), which only widens what keeps the snapshot.
      }
    }
  }
  if (r.timedOut) throw new ReviewLoopError("codex_timeout", `codex review exceeded ${Math.round((p.timeoutMs ?? 15 * 60_000) / 60_000)} minutes`);
  return r;
}

/** @param {string} root the snapshot root */
export const companionDataDir = (root) => path.join(root, "data");

/** Snapshot root → its registered signal-path reaper's unregister function. @type {Map<string, () => void>} */
const reapers = new Map();

const BROKER_JSON_MAX_BYTES = 64 * 1024;
const BROKER_SCRIPT = path.join("scripts", "app-server-broker.mjs");
const COMPANION_SCRIPT = path.join("scripts", "codex-companion.mjs");
const COMPANION_FILE = "companion.json";
const TMP_FILE = "tmp.json";
/** A snapshot dir's name, exactly as snapshotVerified's mkdtemp makes it. */
export const SNAPSHOT_NAME = /^plugin-[A-Za-z0-9]{6}$/;
const TMP_TOKEN_FILE = ".review-loop-tmp";
const COMPANION_MAX_BYTES = 4096;
/** A snapshot's companion data holds one state dir per workspace; more than this is not a companion's doing. */
const REGISTRY_MAX_ENTRIES = 32;
/** A round's own stop, in its finally. */
export const STOP_DEADLINE_MS = 15_000;

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The snapshot root as given and as its realpath: Node runs the companion from its realpath (macOS /var → /private/var). @param {string} root */
function rootsOf(root) {
  const roots = [root];
  try {
    const real = fs.realpathSync(root);
    if (real !== root) roots.push(real);
  } catch {
    // Matched as given.
  }
  return roots;
}

/**
 * Which of `roots` these args run `<…/node> <root>/<script> serve` from, anchored at both ends of the script path, or
 * null. A wrapper, a debugger or a shell whose args merely contain the path never matches.
 * @param {string} args @param {string[]} roots @param {string} [script]
 * @returns {string | null}
 */
export function brokerArgv(args, roots, script = BROKER_SCRIPT) {
  const tail = script === BROKER_SCRIPT ? " serve(?: |$)" : "(?: |$)";
  for (const r of roots) if (new RegExp(`^\\S*/node ${escapeRe(path.join(r, script))}${tail}`).test(args)) return r;
  return null;
}

/** @typedef {{ uid: number, pid: number, ppid: number, pgid: number, lstart: string, started: number, args: string }} Proc */

const PROC_FIELDS = "uid=,pid=,ppid=,pgid=,lstart=,args=";
const PROC_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})(?:\s+(\S.*))?$/;

/** One `ps -o uid=,pid=,ppid=,pgid=,lstart=,args=` line (C locale, UTC), or null when any field does not parse. @param {string} line @returns {Proc | null} */
export function parseProcRow(line) {
  const m = PROC_ROW.exec(line);
  if (!m) return null;
  const lstart = squash(m[5]);
  const started = Date.parse(`${lstart} UTC`) / 1000;
  if (!Number.isFinite(started)) return null;
  return { uid: Number(m[1]), pid: Number(m[2]), ppid: Number(m[3]), pgid: Number(m[4]), lstart, started, args: m[6] ?? "" };
}

/**
 * The whole process table, read once. Exit 0 is not enough: null unless every line parses and the table holds this
 * process's own row, so an empty, header-only or truncated answer is never read as "no such process".
 * @returns {Proc[] | null}
 */
function readProcs() {
  const r = ps(["-ww", "-A", "-o", PROC_FIELDS]);
  if (r === null) return null;
  /** @type {Proc[]} */
  const rows = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    const row = parseProcRow(line);
    if (row === null) return null;
    rows.push(row);
  }
  return rows.some((p) => p.pid === process.pid && p.uid === process.getuid?.()) ? rows : null;
}

/** One process now: its row, "gone", or null when ps could not answer. @param {number} pid @returns {Proc | "gone" | null} */
function procRow(pid) {
  const r = spawnSync(trustedPs(), ["-ww", "-o", PROC_FIELDS, "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: psEnv() });
  if (r.error || r.signal) return null;
  const lines = r.stdout.split("\n").filter((l) => l.trim());
  if (r.status === 1 && lines.length === 0) return "gone";
  if (r.status !== 0 || lines.length !== 1) return null;
  const row = parseProcRow(lines[0]);
  return row && row.pid === pid ? row : null;
}

/** The same process, unchanged: a pid that was reused differs in start time, group or args. @param {Proc} a @param {Proc} b */
export const sameMember = (a, b) => a.pid === b.pid && a.lstart === b.lstart && a.pgid === b.pgid && a.args === b.args;

/**
 * The members of a dead leader's group `pgid` that this snapshot's round can have started: they began strictly after
 * the snapshot's creation second (the companion starts only after it). Same-second ones are `unattributed` (never
 * signalled); a row whose start did not parse is `unknown`. PPID is not used: a grandchild's parent is a member.
 * @param {Proc[]} rows @param {number} pgid @param {number} snapshotSec @param {number | undefined} uid
 */
export function treeMembers(rows, pgid, snapshotSec, uid) {
  /** @type {{ members: Proc[], unattributed: Proc[], unknown: Proc[] }} */
  const out = { members: [], unattributed: [], unknown: [] };
  for (const p of rows) {
    if (p.pgid !== pgid || p.uid !== uid) continue;
    if (!Number.isFinite(p.started)) out.unknown.push(p);
    else if (p.started > snapshotSec) out.members.push(p);
    else if (p.started === snapshotSec) out.unattributed.push(p);
  }
  return out;
}

/**
 * What still runs in the groups of brokers that were gone before the stop began. A process now holding one of those
 * pids proves nothing (it may be a reissue), so each group's members are counted whoever holds the number: they are
 * unattributed, keep the snapshot, and are never signalled.
 * @param {Proc[]} rows @param {number[]} pgids @param {number} snapshotSec @param {number | undefined} uid
 */
export function goneGroupsLeft(rows, pgids, snapshotSec, uid) {
  let n = 0;
  for (const pgid of pgids) {
    const t = treeMembers(rows, pgid, snapshotSec, uid);
    n += t.members.length + t.unattributed.length + t.unknown.length;
  }
  return n;
}

/** The snapshot root's creation second, which every process its round starts is strictly after. @param {string} root */
export function snapshotSecond(root) {
  return Math.floor(fs.lstatSync(root).birthtimeMs / 1000);
}

/**
 * Waits until the clock is past the snapshot's creation second, so no process the round starts can share it: a
 * same-second process (lstart has one-second resolution) could be another's, and is never signalled.
 * @param {string} root
 */
export async function afterSnapshotSecond(root) {
  const wait = (snapshotSecond(root) + 1) * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/**
 * A directory's names, streamed and abandoned past `max`, so an untrusted directory is never buffered whole:
 * "too_large" past the cap; an open or read error is thrown.
 * @param {string} dir @param {number} max
 * @returns {string[] | "too_large"}
 */
export function namesUpTo(dir, max) {
  const d = fs.opendirSync(dir);
  try {
    /** @type {string[]} */
    const names = [];
    for (let ent = d.readSync(); ent !== null; ent = d.readSync()) {
      if (names.length >= max) return "too_large";
      names.push(ent.name);
    }
    return names;
  } finally {
    d.closeSync();
  }
}

/**
 * The brokers the companion recorded in this snapshot's data dir (companion 1.0.6 layout:
 * `<data>/state/<slug>-<hash>/broker.json` = { endpoint: "unix:<sock>", pidFile, logFile, sessionDir, pid }).
 * `ok` is false when the registry exists but cannot be read whole: a stop then signals nothing.
 * @param {string} root
 * @returns {{ ok: boolean, sessions: Array<{ pid: number, socket: string | null, sessionDir: string | null }> }}
 */
function brokerRegistry(root) {
  const stateDir = path.join(companionDataDir(root), "state");
  // Never followed: data/ and data/state must each be a real directory of ours (or absent: no registry yet).
  for (const d of [companionDataDir(root), stateDir]) {
    const st = wsState(d);
    if (st === "absent") return { ok: true, sessions: [] };
    if (st === "failed") return { ok: false, sessions: [] };
  }
  let names;
  try {
    names = namesUpTo(stateDir, REGISTRY_MAX_ENTRIES);
  } catch (e) {
    return { ok: /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT", sessions: [] };
  }
  if (names === "too_large") return { ok: false, sessions: [] };
  const sessions = [];
  for (const name of names) {
    const file = path.join(stateDir, name, "broker.json");
    try {
      fs.lstatSync(file);
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { ok: false, sessions: [] };
    }
    let v;
    try {
      v = JSON.parse(safeReadFile(file, BROKER_JSON_MAX_BYTES, { symlink: "state_symlink_rejected" }, { within: root }).toString("utf8"));
    } catch {
      return { ok: false, sessions: [] };
    }
    if (!isObject(v) || !Number.isInteger(v.pid) || /** @type {number} */ (v.pid) <= 1) return { ok: false, sessions: [] };
    const ep = typeof v.endpoint === "string" && v.endpoint.startsWith("unix:") ? v.endpoint.slice("unix:".length) : null;
    sessions.push({ pid: /** @type {number} */ (v.pid), socket: ep && path.isAbsolute(ep) ? ep : null, sessionDir: typeof v.sessionDir === "string" ? v.sessionDir : null });
  }
  return { ok: true, sessions };
}

/** @param {unknown} v @returns {v is { pid: number, after?: number }} */
function isCompanionMarker(v) {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  const posInt = (/** @type {unknown} */ x) => Number.isInteger(x) && /** @type {number} */ (x) > 1;
  return posInt(v.pid) && (v.after === undefined || posInt(v.after)) && keys.every((k) => k === "pid" || k === "after");
}

/**
 * The companion's pid window, read only through the safe reader (no link followed, size-bounded, shape-checked).
 * @param {string} root
 * @returns {{ state: "absent" } | { state: "bad" } | { state: "ok", pid: number, after: number | undefined }}
 */
function readCompanionMarker(root) {
  const file = path.join(root, COMPANION_FILE);
  try {
    fs.lstatSync(file);
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? { state: "absent" } : { state: "bad" };
  }
  try {
    const v = readJsonValidated(file, isCompanionMarker, root, COMPANION_MAX_BYTES, { readOnly: true });
    return v ? { state: "ok", pid: v.pid, after: v.after } : { state: "bad" };
  } catch {
    return { state: "bad" };
  }
}

const APP_SERVER_ARGS = /^(?:\S*\/)?codex app-server$/;
/** The session dir a broker's own args name. */
const ENDPOINT_ARG = / --endpoint unix:(\/\S+)\/broker\.sock(?: |$)/;

/**
 * `codex app-server` processes whose broker died before anyone recorded it: in a group whose leader is gone, started
 * strictly after the snapshot's second, and (with the companion's pid window) in a group the companion could have
 * started. They cannot be tied to this snapshot for sure, so they are never signalled; they keep the snapshot.
 * Groups of brokers already attributed are skipped. Narrow on purpose: a desktop session always has leaderless groups
 * of its own (crash handlers, a terminal's helpers), and a rule matching every one would keep every snapshot.
 * @param {Proc[]} rows @param {number} snapshotSec @param {ReturnType<typeof readCompanionMarker>} marker @param {Set<number>} known
 */
function leaderlessAppServers(rows, snapshotSec, marker, known) {
  const uid = process.getuid?.();
  // A group's leader is the process that leads it: a row merely holding the number (a reissued pid, in another group)
  // does not make the group led.
  const led = new Set(rows.filter((p) => p.pid === p.pgid).map((p) => p.pid));
  const inWindow = (/** @type {number} */ pgid) => {
    if (marker.state !== "ok") return true;
    if (marker.after === undefined) return pgid > marker.pid;
    // A PID space that wrapped during the round leaves no usable window.
    if (marker.after < marker.pid) return true;
    return pgid > marker.pid && pgid < marker.after;
  };
  return rows.filter((p) => p.uid === uid && !known.has(p.pgid) && !led.has(p.pgid) && p.started > snapshotSec && APP_SERVER_ARGS.test(p.args) && inWindow(p.pgid)).length;
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** @param {number} pid @param {number} ms */
async function exitedWithin(pid, ms) {
  const end = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= end) return false;
    await sleep(50);
  }
  return true;
}

/** @param {number} pid negative for a group @param {NodeJS.Signals} sig */
function signal(pid, sig) {
  // kill(-0) is this process's own group and kill(-1) every process the user owns.
  if (Math.abs(pid) <= 1) return;
  // A broker that outlives even SIGKILL (uninterruptible sleep) cannot be made in a test: the seam stands in for it.
  if (sig === "SIGKILL" && process.env.REVIEW_LOOP_TEST_SEAMS === "1" && process.env.REVIEW_LOOP_TEST_KILL_NOOP === "1") return;
  try {
    process.kill(pid, sig);
  } catch {
    // Exited in between.
  }
}

/** The companion's own shutdown request, bounded; any failure falls through to SIGTERM. @param {string} socket @param {number} ms */
function requestShutdown(socket, ms) {
  return new Promise((resolve) => {
    let st;
    try {
      st = fs.lstatSync(socket);
    } catch {
      return resolve(undefined);
    }
    if (!st.isSocket() || ms <= 0) return resolve(undefined);
    const conn = net.createConnection(socket);
    const done = () => {
      clearTimeout(timer);
      conn.destroy();
      resolve(undefined);
    };
    const timer = setTimeout(done, ms);
    conn.on("connect", () => conn.write(JSON.stringify({ id: 1, method: "broker/shutdown", params: {} }) + "\n"));
    conn.on("data", done);
    conn.on("error", done);
    conn.on("close", done);
  });
}

/** Removes the broker's `cxc-*` session dir only when it is a real directory in the OS temp dir that this user owns. @param {string | null} dir */
function removeSessionDir(dir) {
  if (!dir || !path.isAbsolute(dir) || !path.basename(dir).startsWith("cxc-")) return;
  const tmp = os.tmpdir();
  let realTmp = tmp;
  try {
    realTmp = fs.realpathSync(tmp);
  } catch {
    // Compared as given.
  }
  if (path.dirname(dir) !== tmp && path.dirname(dir) !== realTmp) return;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Gone already, or not ours to remove.
  }
}

/**
 * Sends `sig` to `p`'s whole group, but only while a fresh read of `p` is still the very process recorded, so a group
 * id that changed hands is never signalled. Returns false when that could not be confirmed.
 * @param {Proc} p @param {NodeJS.Signals} sig
 */
function signalGroupIfSame(p, sig, guard = () => true) {
  const seam = process.env.REVIEW_LOOP_TEST_SEAMS === "1" && process.env.REVIEW_LOOP_TEST_LEADER_RECHECK === "changed";
  const now = seam ? { ...p, lstart: "Thu Jan 1 00:00:00 1970" } : procRow(p.pid);
  if (now === "gone") return true;
  if (now === null || !sameMember(now, p)) return false;
  // The caller's own precondition, last of all, right before the signal.
  if (!guard()) return false;
  signal(-p.pid, sig);
  return true;
}

/** @typedef {{ left: number, unattributed: number, reason: string | null }} StopResult */

/**
 * Empties the process groups of the brokers a round's companion started from this snapshot, and says whether any may
 * still run. A broker is this snapshot's when broker.json names it or the process table shows it running this
 * snapshot's broker script (anchored), and either way only while it leads its own group (the companion starts it
 * detached). Order: `broker/shutdown` over its socket, SIGTERM to the broker, then SIGKILL to its whole group (the
 * `codex app-server` child and whatever that started). A leader that already died leaves members that are signalled
 * one by one after a re-read. Nothing is signalled when the table or the registry cannot be read whole, and nothing
 * after `deadline` (performance.now() ms): those return `left` ≥ 1, so the caller keeps the snapshot. Never throws.
 * @param {string} root the snapshot root, before its cleanup
 * @param {{ deadline?: number }} [opts]
 * @returns {Promise<StopResult>}
 */
export async function stopCompanionBroker(root, opts = {}) {
  const deadline = opts.deadline ?? Infinity;
  const remaining = () => deadline - performance.now();
  /** @type {StopResult} */
  const res = { left: 0, unattributed: 0, reason: null };
  const keep = (/** @type {string} */ reason) => {
    res.left = Math.max(res.left, 1);
    if (res.reason === null) res.reason = reason;
  };
  try {
    const uid = process.getuid?.();
    const roots = rootsOf(root);
    const snapshotSec = snapshotSecond(root);
    const reg = brokerRegistry(root);
    const marker = readCompanionMarker(root);
    const table = readProcs();
    if (table === null) {
      keep("ps_unavailable");
      return res;
    }
    if (!reg.ok || marker.state === "bad") {
      keep("registry_unreadable");
      return res;
    }
    /** @type {Map<number, Proc>} */
    const leaders = new Map();
    /** @type {number[]} */
    const goneRegistered = [];
    for (const s of reg.sessions) {
      const row = table.find((p) => p.pid === s.pid);
      if (row) {
        if (row.uid === uid && brokerArgv(row.args, roots)) leaders.set(row.pid, row);
      } else if (isAlive(s.pid)) keep("unknown_rows");
      else goneRegistered.push(s.pid);
    }
    for (const p of table) if (p.uid === uid && brokerArgv(p.args, roots)) leaders.set(p.pid, p);
    // Only verified brokers are stopped. A registry pid already gone at the first read has no identity left (its number
    // may have been reissued), so its group is never signalled: what still runs there is counted unattributed (the
    // snapshot is kept and reported), the author's choice over killing on a pid number alone.
    const groups = new Set(leaders.keys());
    // broker.json is persisted, untrusted input: its socket and session dir are used only when they are the ones a
    // verified broker's own args name (`--endpoint unix:<dir>/broker.sock`).
    /** @type {Map<number, string>} */
    const ownDirs = new Map();
    for (const b of leaders.values()) {
      const ep = ENDPOINT_ARG.exec(b.args);
      if (ep) ownDirs.set(b.pid, ep[1]);
    }

    for (const b of leaders.values()) {
      if (b.pgid !== b.pid) {
        keep("unknown_rows");
        continue;
      }
      const dir = ownDirs.get(b.pid);
      if (dir) await requestShutdown(path.join(dir, "broker.sock"), Math.min(2000, remaining()));
      if (await exitedWithin(b.pid, Math.min(1000, remaining()))) continue;
      if (remaining() <= 0) {
        keep("deadline");
        continue;
      }
      const now = procRow(b.pid);
      if (now === null) keep("unknown_rows");
      else if (now !== "gone" && sameMember(now, b)) {
        signal(b.pid, "SIGTERM");
        await exitedWithin(b.pid, Math.min(2000, remaining()));
      }
    }
    if (res.left > 0) return res;

    // Second pass, on a fresh table: SIGKILL whatever of each tree is still running.
    const again = readProcs();
    if (again === null) {
      keep("ps_unavailable");
      return res;
    }
    let killed = false;
    for (const pgid of groups) {
      if (remaining() <= 0) {
        keep("deadline");
        return res;
      }
      const leaderNow = again.find((p) => p.pid === pgid);
      const leaderThen = leaders.get(pgid);
      // The same broker still there: its whole group is killed. Any other holder of the pid (a reissue) proves nothing
      // about the group, so it is handled as a gone leader's: only members seen unchanged at the first read.
      if (leaderNow && leaderThen && sameMember(leaderNow, leaderThen)) {
        if (!signalGroupIfSame(leaderThen, "SIGKILL")) keep("unknown_rows");
        killed = true;
        continue;
      }
      const t = deadGroupTargets(table, again, pgid, snapshotSec, uid);
      if (t.unknown.length) keep("unknown_rows");
      for (const m of t.members) {
        if (remaining() <= 0) {
          keep("deadline");
          return res;
        }
        const now = procRow(m.pid);
        if (now === null) keep("unknown_rows");
        else if (now !== "gone" && sameMember(now, m)) {
          signal(m.pid, "SIGKILL");
          killed = true;
        }
      }
    }
    // A tree that could not be verified is reported as such, not counted again below.
    if (res.left > 0) return res;
    if (killed) await sleep(Math.min(1000, remaining()));

    const last = readProcs();
    if (last === null) {
      keep("ps_unavailable");
      return res;
    }
    for (const pgid of groups) {
      const leaderNow = last.find((p) => p.pid === pgid);
      const leaderThen = leaders.get(pgid);
      if (leaderNow && leaderThen && sameMember(leaderNow, leaderThen)) {
        res.left++;
        continue;
      }
      const t = deadGroupTargets(table, last, pgid, snapshotSec, uid);
      if (t.members.length || t.unknown.length) res.left++;
      res.unattributed += t.unattributed.length;
    }
    res.unattributed += goneGroupsLeft(last, goneRegistered, snapshotSec, uid);
    res.unattributed += leaderlessAppServers(last, snapshotSec, marker, new Set([...groups, ...goneRegistered]));
    if (res.left > 0) res.reason ??= "members_left";
    else if (res.unattributed > 0) res.reason ??= "unattributed";
    if (res.left === 0) {
      // Only a dir a live, verified broker's own args name. broker.json's sessionDir binds nothing (it is the broker's
      // own claim): a gone broker's dir is never removed from it. Since 1.0.4 that dir is inside the snapshot's TMPDIR
      // (companionTmp) and goes with the snapshot; an older one in the OS temp dir is left to the OS.
      for (const dir of ownDirs.values()) removeSessionDir(dir);
    }
  } catch {
    keep("unknown_rows");
  } finally {
    reapers.get(root)?.();
    reapers.delete(root);
  }
  return res;
}

/**
 * The members of a group whose leader is gone that a stop may SIGKILL: treeMembers of the group now, kept only when
 * already in the group, unchanged, at the stop's first read. A member that joined since could belong to a new group
 * that reused the pid after the broker's own group emptied, so it is unattributed (kept, reported), never signalled.
 * @param {Proc[]} first the stop's first table @param {Proc[]} now @param {number} pgid @param {number} snapshotSec
 * @param {number | undefined} uid
 */
export function deadGroupTargets(first, now, pgid, snapshotSec, uid) {
  const t = treeMembers(now, pgid, snapshotSec, uid);
  const seen = (/** @type {Proc} */ m) => first.some((p) => sameMember(p, m));
  return { members: t.members.filter(seen), unattributed: [...t.unattributed, ...t.members.filter((m) => !seen(m))], unknown: t.unknown };
}

/** The signal-path twin of stopCompanionBroker: synchronous, SIGTERM only, same identity checks. @param {string} root */
function reapCompanionBroker(root) {
  const roots = rootsOf(root);
  const uid = process.getuid?.();
  const pids = new Set(brokerRegistry(root).sessions.map((s) => s.pid));
  // A broker started before the companion wrote broker.json is only in the process table.
  for (const p of readProcs() ?? []) if (p.uid === uid && p.pgid === p.pid && brokerArgv(p.args, roots)) pids.add(p.pid);
  for (const pid of pids) {
    const now = procRow(pid);
    if (now !== null && now !== "gone" && now.uid === uid && brokerArgv(now.args, roots)) signal(pid, "SIGTERM");
  }
}

/**
 * Stops a dead round's companion before its brokers: a round killed without its finally leaves the companion (its own
 * process group) running from the snapshot, where it could start another broker. Found by companion.json's pid and by
 * the table, and only while its args run this snapshot's companion script and it leads its group. Returns false when
 * it could not be confirmed gone.
 * @param {string} root @param {Proc[]} table @param {() => number} remaining
 */
async function stopSnapshotCompanion(root, table, remaining) {
  const uid = process.getuid?.();
  const roots = rootsOf(root);
  const marker = readCompanionMarker(root);
  if (marker.state === "bad") return false;
  const found = table.filter((p) => p.uid === uid && brokerArgv(p.args, roots, COMPANION_SCRIPT));
  if (marker.state === "ok") {
    const row = table.find((p) => p.pid === marker.pid);
    if (row && row.uid === uid && brokerArgv(row.args, roots, COMPANION_SCRIPT) && !found.includes(row)) found.push(row);
  }
  // A companion gone before this stop leaves no identity for its group (its pid may have been reissued): members still
  // there keep the snapshot, and are never signalled.
  if (marker.state === "ok" && !found.some((c) => c.pid === marker.pid)) {
    const t = treeMembers(table, marker.pid, snapshotSecond(root), uid);
    if (t.members.length || t.unattributed.length || t.unknown.length) return false;
  }
  if (found.length === 0) return true;
  if (found.some((c) => c.pgid !== c.pid)) return false;
  // No signal once the sweep's budget is spent: the snapshot is kept (reason "deadline") for the next sweep.
  if (remaining() <= 0) return false;
  for (const c of found) if (!signalGroupIfSame(c, "SIGTERM")) return false;
  for (const c of found) await exitedWithin(c.pid, Math.min(2000, remaining()));
  if (remaining() <= 0) return false;
  for (const c of found) if (isAlive(c.pid) && !signalGroupIfSame(c, "SIGKILL")) return false;
  for (const c of found) await exitedWithin(c.pid, Math.min(1000, remaining()));
  // A companion that exits on SIGTERM can leave a child in its group, and with the leader gone that group is not
  // signalled again (see above): the snapshot is kept while anything of it remains.
  const after = readProcs();
  if (after === null) return false;
  return found.every((c) => !after.some((p) => p.pid === c.pid || (p.pgid === c.pid && p.uid === uid)));
}

const OWNER_FILE = "owner.json";
const ORIGIN_KEY = /^[0-9a-f]{24}$/;

/**
 * The artifact key of the round that made a snapshot (owner.json's `key`), or null when it is absent, unreadable or
 * not a key: the events of a kept snapshot name the review that left it, never the round that happened to sweep it.
 * @param {string} root
 */
function snapshotOrigin(root) {
  try {
    const v = JSON.parse(safeReadFile(path.join(root, OWNER_FILE), OWNER_MAX_BYTES, {}, { within: root }).toString("utf8"));
    return isObject(v) && typeof v.key === "string" && ORIGIN_KEY.test(v.key) ? v.key : null;
  } catch {
    return null;
  }
}
const OWNER_MAX_BYTES = 4096;
/** Snapshot names per partition: about this many are examined per sweep, however many there are. */
export const SWEEP_PART = 16;
/** `ws/` entries counted per sweep; past this the state is an anomaly, reported and not walked. */
export const SWEEP_LIST_MAX = 65_536;
/** A round's sweep stops acting once this much time has passed (the first act always runs). */
export const SWEEP_DEADLINE_MS = 10_000;
/** The manual `sweep` subcommand's budget. */
export const SWEEP_MANUAL_DEADLINE_MS = 300_000;
/** A snapshot with no owner file (the legacy engine's, or one mid-creation) is only a candidate after this long. */
export const LEGACY_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;

/**
 * `ps` in the C locale and UTC, bounded: its stdout and the pid it ran as, or null when it could not answer. lstart is
 * printed in local time: without the TZ pin, an owner.json written under one TZ reads as another start time under
 * another, and a live round looks dead.
 * @param {string[]} args
 * @returns {{ out: string, pid: number } | null}
 */
function ps(args) {
  const r = spawnSync(trustedPs(), args, { encoding: "utf8", timeout: 2000, maxBuffer: 16 * MiB, env: psEnv() });
  return r.error || r.signal || r.status !== 0 ? null : { out: r.stdout, pid: r.pid };
}

/** Every `ps` here runs in the C locale and UTC (see ps). */
const psEnv = () => ({ PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" });

/** @param {string} s */
const squash = (s) => s.trim().replace(/\s+/g, " ");

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * `ps -o lstart=` in the C locale, squashed (`Wed Oct 7 09:51:14 2026`), and a real moment: every field read back from
 * the parsed date matches, so a weekday or day that Date.parse would quietly ignore or roll over is refused.
 * @param {string} s
 */
const isLstart = (s) => {
  const m = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(s);
  const t = m ? Date.parse(`${s} UTC`) : NaN;
  if (!m || !Number.isFinite(t)) return false;
  const d = new Date(t);
  return DAYS[d.getUTCDay()] === m[1] && MONTHS[d.getUTCMonth()] === m[2] && d.getUTCDate() === Number(m[3]) && d.getUTCHours() === Number(m[4]) && d.getUTCMinutes() === Number(m[5]) && d.getUTCSeconds() === Number(m[6]) && d.getUTCFullYear() === Number(m[7]);
};

/** A process's start time as `ps -o lstart=` prints it: with the pid, a reuse-safe identity. @param {number} pid */
function startTimeOf(pid) {
  const r = ps(["-o", "lstart=", "-p", String(pid)]);
  return r && squash(r.out) ? squash(r.out) : null;
}

/** The process table, read at most once per sweep and shared by every check in it. */
function processTable() {
  /** @type {Proc[] | null | undefined} */
  let procs;
  return {
    procs() {
      if (procs === undefined) procs = readProcs();
      return procs;
    },
    starts() {
      const p = this.procs();
      return p === null ? null : new Map(p.map((r) => [r.pid, r.lstart]));
    },
    args() {
      const p = this.procs();
      return p === null ? null : p.map((r) => r.args);
    }
  };
}

/**
 * Whose snapshot this is: "none" (no owner file, or one too damaged to name anyone in a snapshot older than
 * LEGACY_SNAPSHOT_AGE_MS: both go by the legacy rule), "alive", "dead" (the pid is gone, or now another process), or
 * "unknown" (a linked or unreadable owner file, a fresh damaged one, or ps could not answer).
 * @param {string} root @param {ReturnType<typeof processTable>} table
 * @returns {"none" | "alive" | "dead" | "unknown"}
 */
function ownerState(root, table) {
  const file = path.join(root, OWNER_FILE);
  try {
    fs.lstatSync(file);
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? "none" : "unknown";
  }
  const damaged = () => (Date.now() - fs.lstatSync(root).mtimeMs >= LEGACY_SNAPSHOT_AGE_MS ? "none" : "unknown");
  let v;
  try {
    v = JSON.parse(safeReadFile(file, OWNER_MAX_BYTES, { symlink: "state_symlink_rejected" }, { within: root }).toString("utf8"));
  } catch (e) {
    return e instanceof SyntaxError ? damaged() : "unknown";
  }
  if (!isObject(v) || !Number.isInteger(v.pid) || /** @type {number} */ (v.pid) <= 1) return damaged();
  const pid = /** @type {number} */ (v.pid);
  if (!isAlive(pid)) return "dead";
  // Only a start time in ps's own shape can be compared: anything else (corrupt, hand-edited) is unknown, never a
  // mismatch, so it can never make a live owner read as dead.
  if (typeof v.started !== "string" || !isLstart(squash(v.started))) return "unknown";
  const starts = table.starts();
  if (starts === null) return "unknown";
  const now = starts.get(pid);
  if (now === undefined) return isAlive(pid) ? "unknown" : "dead";
  return now === squash(v.started) ? "alive" : "dead";
}

/**
 * Whether any live process's args name this snapshot; null when ps could not answer. A plain substring test, so a
 * sibling that shares the prefix also counts: a false "referenced" only leaves a snapshot in place.
 * @param {string} root @param {ReturnType<typeof processTable>} table
 */
function referenced(root, table) {
  const lines = table.args();
  if (lines === null) return null;
  return lines.some((l) => rootsOf(root).some((r) => l.includes(r)));
}

/** The first 4 bytes of sha256(name), unsigned: a snapshot's fixed place in every partitioning. @param {string} name */
export function hashOf(name) {
  return crypto.createHash("sha256").update(name).digest().readUInt32BE(0);
}

/**
 * How many partitions `n` snapshots are split into: the smallest power of two that leaves about `part` per partition
 * (at most 4096). Powers of two nest, which is what makes coverage survive a changing `n`: see isHeld.
 * @param {number} n @param {number} [part]
 */
export function partitionCount(n, part = SWEEP_PART) {
  let p = 1;
  while (p * part < n && p < 4096) p *= 2;
  return p;
}

/**
 * Whether the snapshot with this hash is examined at `tick` when there are `p` partitions. For P ≤ 2^K throughout any
 * 2^K consecutive ticks, the one tick t ≡ hash (mod 2^K) also satisfies t ≡ hash (mod P), so every snapshot is reached
 * within 2^K ticks however `n` (and with it P) changes in between.
 * @param {number} hash @param {number} tick @param {number} p
 */
export const isHeld = (hash, tick, p) => hash % p === ((tick % p) + p) % p;

/** The minute, or the test seam's fixed value. */
function sweepTick() {
  const seam = process.env.REVIEW_LOOP_TEST_SEAMS === "1" ? Number(process.env.REVIEW_LOOP_TEST_SWEEP_TICK) : NaN;
  return Number.isInteger(seam) ? seam : Math.floor(Date.now() / 60_000);
}

function sweepPart() {
  const seam = process.env.REVIEW_LOOP_TEST_SEAMS === "1" ? Number(process.env.REVIEW_LOOP_TEST_SWEEP_PART) : NaN;
  return Number.isInteger(seam) && seam > 0 ? seam : SWEEP_PART;
}

/**
 * Streams `parentDir`'s `plugin-*` names without buffering the directory: `onName` sees each one. Stops early (and
 * says so) past SWEEP_LIST_MAX entries or the deadline.
 * @param {string} parentDir @param {(name: string) => void} onName @param {() => number} remaining
 * @returns {"done" | "absent" | "failed" | "too_large" | "deadline"}
 */
function walkSnapshots(parentDir, onName, remaining) {
  const ws = wsState(parentDir);
  if (ws !== "ok") return ws;
  let dir;
  try {
    dir = fs.opendirSync(parentDir);
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? "absent" : "failed";
  }
  try {
    let seen = 0;
    for (let ent = dir.readSync(); ent !== null; ent = dir.readSync()) {
      if (++seen > SWEEP_LIST_MAX) return "too_large";
      if (seen % 256 === 0 && remaining() <= 0) return "deadline";
      // Only the shape snapshotVerified makes (mkdtemp "plugin-"): a `plugin-backup` of the user's is not a snapshot.
      if (SNAPSHOT_NAME.test(ent.name)) onName(ent.name);
    }
    return "done";
  } catch {
    return "failed";
  } finally {
    dir.closeSync();
  }
}

/**
 * @typedef {{ swept: number, brokersLeft: number, unattributed: number, failed: number, incomplete: boolean,
 *   held: number, partition: number, partitions: number, counted: number,
 *   stops: Array<{ snapshot: string, origin: string | null, reason: string, left: number, unattributed: number }>,
 *   skipped: Map<string, "in_use" | "unverified"> }} SweepResult
 * skipped: the snapshots left alone, by name (a full sweep can visit one more than once): "in_use" (its round is
 * alive, or it is fresh or referenced), "unverified" (not a real directory of ours, or an owner that cannot be read).
 */

/**
 * Round-start sweep of the `ws/plugin-*` snapshots a killed round left behind (a SIGKILL runs no finally and no
 * reaper): their companion, companion data (Codex job files), `cxc-*` session dir and broker trees.
 * A snapshot is swept only when its owner round is provably gone, or, with no owner file, when it is older than
 * LEGACY_SNAPSHOT_AGE_MS and no live process's args name it. Alive or unknown → left alone. Links are never followed:
 * the entry itself must be a real directory this user owns. One partition of the names is examined per sweep (see
 * isHeld); `opts.all` examines every partition against one frozen count, re-counting until two counts agree (at most
 * three cycles). Acting stops at the deadline (the first act always runs). Never throws.
 * @param {string} parentDir the private ws dir
 * @param {{ all?: boolean, deadlineMs?: number }} [opts]
 * @returns {Promise<SweepResult>}
 */
export async function sweepStaleSnapshots(parentDir, opts = {}) {
  const deadline = performance.now() + (opts.deadlineMs ?? SWEEP_DEADLINE_MS);
  const remaining = () => deadline - performance.now();
  const tick = sweepTick();
  const part = sweepPart();
  /** @type {SweepResult} */
  const res = { swept: 0, brokersLeft: 0, unattributed: 0, failed: 0, incomplete: false, held: 0, partition: 0, partitions: 1, counted: 0, stops: [], skipped: new Map() };
  const table = processTable();
  let acted = 0;
  const count = () => {
    let n = 0;
    const w = walkSnapshots(parentDir, () => n++, remaining);
    return { n, w };
  };
  let { n, w } = count();
  for (let cycle = 0; ; cycle++) {
    if (w === "absent") return res;
    if (w !== "done") {
      res.failed++;
      res.incomplete = true;
      return res;
    }
    res.counted = n;
    const p = partitionCount(n, part);
    res.partitions = p;
    const residues = opts.all ? [...Array(p).keys()] : [((tick % p) + p) % p];
    // One pass holds what every residue needs (see isHeld): one partition for a round, all of them for the manual
    // sweep. A round's partition holding more than 4 × part names stops collecting (vanishingly rare, and loud).
    /** @type {Map<number, string[]>} */
    const buckets = new Map(residues.map((k) => [k, []]));
    let over = false;
    const hw = walkSnapshots(parentDir, (name) => {
      const held = buckets.get(hashOf(name) % p);
      if (!held) return;
      if (!opts.all && held.length >= 4 * part) over = true;
      else held.push(name);
    }, remaining);
    if (hw !== "done" && hw !== "absent") {
      res.failed++;
      res.incomplete = true;
      return res;
    }
    if (over) res.incomplete = true;
    for (const k of residues) {
      res.partition = k;
      const held = /** @type {string[]} */ (buckets.get(k));
      res.held += held.length;
      // A held snapshot judged without the process table was not examined at all.
      if (held.length > 0 && table.procs() === null) {
        res.failed++;
        res.incomplete = true;
        return res;
      }
      held.sort((a, b) => hashOf(a) - hashOf(b) || (a < b ? -1 : 1));
      const start = held.length ? ((tick % held.length) + held.length) % held.length : 0;
      for (const name of [...held.slice(start), ...held.slice(0, start)]) {
        if (acted > 0 && remaining() <= 0) {
          res.incomplete = true;
          break;
        }
        const r = await sweepOne(path.join(parentDir, name), name, table, remaining);
        if (r === "in_use" || r === "unverified") {
          res.skipped.set(name, r);
          continue;
        }
        res.skipped.delete(name);
        acted++;
        if (r === "swept") res.swept++;
        else {
          res.brokersLeft += r.left;
          res.unattributed += r.unattributed;
          // Nothing runs, but the snapshot stayed (its temp dir did not go): not clean either.
          if (r.left + r.unattributed === 0) res.failed++;
          res.stops.push({ snapshot: name, origin: snapshotOrigin(path.join(parentDir, name)), reason: r.reason ?? "members_left", left: r.left, unattributed: r.unattributed });
        }
      }
    }
    if (!opts.all) return res;
    const again = count();
    if (again.w === w && again.n === n) return res;
    if (cycle >= 2) {
      res.incomplete = true;
      return res;
    }
    ({ n, w } = again);
  }
}

/**
 * What a sweep makes of a snapshot before acting, shared with doctor (countOrphanBrokers) so the two never disagree:
 * "stale" (its round is gone: a sweep acts on it), "in_use" (owner alive, or fresh or referenced), "unverified" (not
 * a real directory of ours, an owner that cannot be judged, or ps could not answer).
 * @param {string} root @param {ReturnType<typeof processTable>} table
 * @returns {"stale" | "in_use" | "unverified"}
 */
function judgeSnapshot(root, table) {
  if (!ownedRealDirectory(root)) return "unverified";
  const owner = ownerState(root, table);
  if (owner === "alive") return "in_use";
  if (owner === "dead") return "stale";
  if (owner !== "none") return "unverified";
  if (Date.now() - fs.lstatSync(root).mtimeMs < LEGACY_SNAPSHOT_AGE_MS) return "in_use";
  const ref = referenced(root, table);
  if (ref === null) return "unverified";
  return ref ? "in_use" : "stale";
}

/**
 * One snapshot: left alone ("in_use" or "unverified", see SweepResult.skipped), removed ("swept"), kept with what is
 * still running (an unexpected error: reason `failed_<step>`, one of BROKER_STOP_REASONS).
 * @param {string} root @param {string} name @param {ReturnType<typeof processTable>} table @param {() => number} remaining
 * @returns {Promise<"in_use" | "unverified" | "swept" | StopResult>}
 */
async function sweepOne(root, name, table, remaining) {
  // The step an unexpected error interrupts, so the snapshot's event says where (a bounded reason, never a message).
  let step = "judge";
  try {
    const j = judgeSnapshot(root, table);
    if (j !== "stale") return j;
    // Fresh, not the sweep's cached table: a decision to signal or to delete rests on what runs now.
    const procs = readProcs();
    if (procs === null) return { left: 1, unattributed: 0, reason: "ps_unavailable" };
    step = "companion";
    if (!(await stopSnapshotCompanion(root, procs, remaining))) return { left: 1, unattributed: 0, reason: remaining() <= 0 ? "deadline" : "unknown_rows" };
    step = "broker";
    const stop = await stopCompanionBroker(root, { deadline: performance.now() + Math.max(0, remaining()) });
    if (stop.left > 0 || stop.unattributed > 0) return stop;
    step = "remove";
    // Re-checked just before the remove: still a real directory of ours, never a link swapped in, and nothing runs
    // from it now (a fresh read; an unreadable table keeps it).
    if (!ownedRealDirectory(root)) return "unverified";
    if (runsFrom(root)) return { left: 1, unattributed: 0, reason: "members_left" };
    return removeSnapshot(root) ? "swept" : { left: 0, unattributed: 0, reason: "temp_unremoved" };
  } catch {
    return { left: 0, unattributed: 0, reason: `failed_${step}` };
  }
}

/** Whether a companion or broker of this user runs from `root` now; true when that cannot be read. @param {string} root */
function runsFrom(root) {
  const procs = readProcs();
  if (procs === null) return true;
  const roots = rootsOf(root);
  return procs.some((p) => p.uid === process.getuid?.() && (brokerArgv(p.args, roots) !== null || brokerArgv(p.args, roots, COMPANION_SCRIPT) !== null));
}

/** Below every supported platform's sun_path size (macOS 104, Linux 108), less a terminating byte. */
const SOCKET_PATH_MAX = 103;

/** The snapshot parent as it is (never followed): a real directory of ours, absent, or anything else ("failed"). @param {string} p */
function wsState(p) {
  try {
    const ls = fs.lstatSync(p);
    return ls.isDirectory() && ls.uid === process.getuid?.() ? "ok" : "failed";
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? "absent" : "failed";
  }
}

/** @param {string} p */
function ownedRealDirectory(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && st.uid === process.getuid?.();
  } catch {
    return false;
  }
}

/**
 * missing_snapshot: a group-leading broker whose snapshot is gone (stop-orphan can act on it). not_leader: the same,
 * but in a group it does not lead (its launcher's), which stop-orphan never signals: listed for the operator only.
 * @typedef {{ kind: "missing_snapshot", pid: number, pgid: number, snapshot: string, started: number, argsSha: string }
 *   | { kind: "not_leader", pid: number, pgid: number, snapshot: string }} Orphan
 */

/**
 * Read-only, for doctor: brokers this user runs from a `ws/plugin-*` snapshot that is gone (nothing can attribute
 * them now, so nothing signals them automatically), and snapshots a sweep would still act on (`kept`: an owner that is
 * dead, whose brokers the next sweep stops). One table read; never signals. `verified` is false when the table or
 * `ws/` could not be read.
 * @param {string} parentDir the private ws dir
 * @returns {{ count: number, kept: number, verified: boolean, orphans: Orphan[] }}
 */
export function countOrphanBrokers(parentDir) {
  /** @type {{ count: number, kept: number, verified: boolean, orphans: Orphan[] }} */
  const res = { count: 0, kept: 0, verified: false, orphans: [] };
  const table = processTable();
  const procs = table.procs();
  if (procs === null) return res;
  const uid = process.getuid?.();
  const re = new RegExp(`^\\S*/node (?:${rootsOf(parentDir).map(escapeRe).join("|")})/(plugin-[A-Za-z0-9]{6})/${escapeRe(BROKER_SCRIPT)} serve(?: |$)`);
  for (const p of procs) {
    const m = p.uid === uid ? re.exec(p.args) : null;
    if (!m) continue;
    // Only a real directory of ours is the broker's snapshot; a link, a file or another user's entry by that name is
    // not, and is not "gone" either: the check is unverified, for the operator to inspect.
    const st = wsState(path.join(parentDir, m[1]));
    if (st === "ok") continue;
    if (st === "failed") return res;
    if (p.pgid !== p.pid) res.orphans.push({ kind: "not_leader", pid: p.pid, pgid: p.pgid, snapshot: m[1] });
    else res.orphans.push({ kind: "missing_snapshot", pid: p.pid, pgid: p.pgid, snapshot: m[1], started: p.started, argsSha: sha256hex(p.args) });
  }
  let odd = 0;
  const w = walkSnapshots(parentDir, (name) => {
    let j;
    try {
      j = judgeSnapshot(path.join(parentDir, name), table);
    } catch {
      j = "unverified";
    }
    if (j === "unverified") odd++;
    else if (j === "stale") res.kept++;
  }, () => Infinity);
  // Judged as the sweep judges it: an entry it cannot judge leaves this check unverified too.
  if ((w !== "done" && w !== "absent") || odd > 0) return res;
  res.count = res.orphans.length;
  res.verified = true;
  return res;
}

/** @param {Proc | "gone"} now the row holding the leader's pid now @param {Proc} first the leader stop-orphan verified */
const leaderReissued = (now, first) => now !== "gone" && !sameMember(now, first) && now.pgid === first.pid;

/**
 * The operator's `stop-orphan`: ends one broker tree whose snapshot is gone, re-reading the leader right before each
 * signal and acting only while it is still the very process doctor listed (pid, start second, args hash), still leads
 * its group, still runs `<parentDir>/<snapshot>`'s broker script, and that snapshot is still missing.
 * @param {string} parentDir @param {{ snapshot: string, pid: number, started: number, argsSha: string }} o
 * @returns {Promise<"stopped" | "mismatch" | "still_running" | "unverified" | "leader_gone">} see STOP_ORPHAN_STATUSES
 */
export async function stopOrphan(parentDir, o) {
  const check = () => {
    const now = procRow(o.pid);
    if (now === null) return "unverified";
    if (now === "gone") return "gone";
    try {
      fs.lstatSync(path.join(parentDir, o.snapshot));
      return "mismatch";
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") return "unverified";
    }
    const ok = now.uid === process.getuid?.() && now.pgid === now.pid && now.started === o.started && sha256hex(now.args) === o.argsSha && brokerArgv(now.args, rootsOf(parentDir).map((r) => path.join(r, o.snapshot))) !== null;
    return ok ? now : "mismatch";
  };
  /** @returns {"absent" | "mismatch" | "unverified"} */
  const snapshotPresent = () => {
    try {
      fs.lstatSync(path.join(parentDir, o.snapshot));
      return "mismatch";
    } catch (e) {
      return /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? "absent" : "unverified";
    }
  };
  /** Test seam: the snapshot comes back at a chosen signal ("term" or "kill"), just before its last check. @param {string} at */
  const restoreSeam = (at) => {
    const v = process.env.REVIEW_LOOP_TEST_SEAMS === "1" ? process.env.REVIEW_LOOP_TEST_RESTORE_SNAPSHOT : undefined;
    if (v === at || (at === "kill" && v === "1")) fs.mkdirSync(path.join(parentDir, o.snapshot), { recursive: true });
  };
  const first = check();
  // A broker gone before this command leaves no identity for its group (its pid may have been reissued): what still
  // runs there is reported (`leader_gone`, with the group to inspect), never signalled. Doctor does not list it: a
  // leaderless app-server has nothing tying it to review-loop rather than another Codex client.
  if (first === "gone") {
    const table = readProcs();
    if (table === null) return "unverified";
    return table.some((p) => p.pgid === o.pid && p.uid === process.getuid?.()) ? "leader_gone" : "mismatch";
  }
  if (typeof first === "string") return first;
  // The whole identity again, then inside signalGroupIfSame the leader once more and, last, the snapshot still gone,
  // right at the signal: a changed leader or a restored snapshot is never signalled.
  const now = check();
  if (typeof now === "string") return now === "gone" ? "mismatch" : now;
  if (!sameMember(now, first)) return "mismatch";
  /** @type {"absent" | "mismatch" | "unverified"} */
  let atTerm = "absent";
  const stillGone = () => {
    restoreSeam("term");
    atTerm = snapshotPresent();
    return atTerm === "absent";
  };
  if (!signalGroupIfSame(first, "SIGTERM", stillGone)) return atTerm === "absent" ? "mismatch" : atTerm;
  await exitedWithin(first.pid, 5000);
  // Then the group as it is now, read afresh each pass until it is empty: a member started after any one read (one
  // the broker spawns on its way out) is still found. Whoever holds the leader's pid now (a reissue proves nothing),
  // the group is stopped only once it has no members.
  const uid = process.getuid?.();
  const until = performance.now() + STOP_DEADLINE_MS;
  // "stopped" only while the snapshot is still gone: a restored one makes the tree a round's again.
  const stoppedIfStillGone = () => {
    const back = snapshotPresent();
    return back === "absent" ? "stopped" : back;
  };
  for (;;) {
    const table = readProcs();
    if (table === null) return "unverified";
    // Another process now leading group <pid>: the pid was reissued, so the broker's group had emptied (an id is never
    // reissued while its group lives) and every member now is the newcomer's. A reissue into another group proves
    // nothing about the old group, which is still emptied below.
    if (leaderReissued(table.find((p) => p.pid === first.pid) ?? "gone", first)) return stoppedIfStillGone();
    const members = table.filter((p) => p.pgid === first.pid && p.uid === uid);
    if (members.length === 0) return "stopped";
    if (performance.now() >= until) return "still_running";
    for (const m of members) {
      const now = procRow(m.pid);
      if (now === null) return "unverified";
      if (now === "gone" || !sameMember(now, m)) continue;
      const lead = procRow(first.pid);
      if (lead === null) return "unverified";
      if (leaderReissued(lead, first)) return stoppedIfStillGone();
      // Still an orphan's tree only while its snapshot is still gone, checked last, right at each signal: a restored
      // snapshot makes the tree a round's again.
      restoreSeam("kill");
      const back = snapshotPresent();
      if (back !== "absent") return back;
      signal(m.pid, "SIGKILL");
    }
    await sleep(500);
  }
}
