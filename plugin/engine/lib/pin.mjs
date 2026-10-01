import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ReviewLoopError } from "./errors.mjs";
import { safeReadFile, sha256hex, atomicWriteJson, readJsonValidated, isObject, MiB } from "./fsutil.mjs";
import { run, onReap } from "./proc.mjs";
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
 * verifyPin checks the cache path, but executing that path later is a check/use gap (a plugin auto-update in between
 * would run unverified code). So copy the pinned files into a fresh private directory through the symlink-safe reader,
 * re-hash the COPIED bytes against the pin, and execute only from there. plugin.json (client name/version metadata,
 * read at run time) is copied unpinned so adopting this does not force a repin.
 * @param {string} parentDir private (0700) directory the snapshot is created in
 * @returns {{ root: string, cleanup: () => void }}
 */
export function snapshotVerified(parentDir) {
  const pin = readPin();
  if (!pin) throw new ReviewLoopError("plugin_pin_mismatch", `no valid pin at ${pinFile()}`);
  const src = path.join(pluginBase(), pin.version);
  if (isLink(src)) throw new ReviewLoopError("plugin_pin_mismatch", `plugin root ${src} is a symlink`);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(parentDir, "plugin-"));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
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
    fs.writeFileSync(path.join(root, OWNER_FILE), JSON.stringify({ pid: process.pid, started: startTimeOf(process.pid) }), { mode: 0o600, flag: "wx" });
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
  // The broker outlives the companion (detached, own session), so a signal must reap it from its broker.json.
  if (!reapers.has(root)) reapers.set(root, onReap(() => reapCompanionBroker(root)));
  const r = await run(process.execPath, args, { cwd: p.cwd, env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, timeoutMs: p.timeoutMs ?? 15 * 60_000, maxBuffer: 32 * MiB });
  if (r.timedOut) throw new ReviewLoopError("codex_timeout", `codex review exceeded ${Math.round((p.timeoutMs ?? 15 * 60_000) / 60_000)} minutes`);
  return r;
}

/** @param {string} root the snapshot root */
export const companionDataDir = (root) => path.join(root, "data");

/** Snapshot root → its registered signal-path reaper's unregister function. @type {Map<string, () => void>} */
const reapers = new Map();

const BROKER_JSON_MAX_BYTES = 64 * 1024;
const BROKER_SCRIPT = path.join("scripts", "app-server-broker.mjs");

/**
 * The brokers the companion recorded in this snapshot's data dir (companion 1.0.6 layout:
 * `<data>/state/<slug>-<hash>/broker.json` = { endpoint: "unix:<sock>", pidFile, logFile, sessionDir, pid }).
 * @param {string} root
 * @returns {Array<{ pid: number, socket: string | null, sessionDir: string | null }>}
 */
function brokerSessions(root) {
  const stateDir = path.join(companionDataDir(root), "state");
  let names = [];
  try {
    names = fs.readdirSync(stateDir).slice(0, 32);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let v;
    try {
      v = JSON.parse(safeReadFile(path.join(stateDir, name, "broker.json"), BROKER_JSON_MAX_BYTES, { symlink: "state_symlink_rejected" }, { within: root }).toString("utf8"));
    } catch {
      continue;
    }
    if (!isObject(v) || !Number.isInteger(v.pid) || /** @type {number} */ (v.pid) <= 1) continue;
    const ep = typeof v.endpoint === "string" && v.endpoint.startsWith("unix:") ? v.endpoint.slice("unix:".length) : null;
    out.push({ pid: /** @type {number} */ (v.pid), socket: ep && path.isAbsolute(ep) ? ep : null, sessionDir: typeof v.sessionDir === "string" ? v.sessionDir : null });
  }
  return out;
}

/**
 * Whether `pid` is this snapshot's broker, from its args (`node <root>/scripts/app-server-broker.mjs serve …`). The
 * root is matched as given and as its realpath: Node runs the companion from its realpath (macOS /var → /private/var).
 * "unknown" when ps could not answer.
 * @param {number} pid @param {string} root
 * @returns {"ours" | "other" | "unknown"}
 */
function brokerIdentity(pid, root) {
  const r = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  if (r.error || r.signal || (r.status !== 0 && r.status !== 1)) return "unknown";
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // The snapshot is still there while a broker is stopped; the as-given root is matched regardless.
  }
  const args = r.stdout.trim();
  return [root, real].some((p) => args.includes(`${path.join(p, BROKER_SCRIPT)} serve`)) ? "ours" : "other";
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

/** @param {number} pid @param {number} ms */
async function exitedWithin(pid, ms) {
  const end = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
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
    if (!st.isSocket()) return resolve(undefined);
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
 * Stops the detached app-server broker(s) a round's companion started: `broker/shutdown` over its socket first, then
 * SIGTERM, which the broker handles by shutting down. A pid is signalled only when it comes from this snapshot's
 * broker.json AND its args name this snapshot's broker script, so a reused pid is never touched. Never throws.
 * @param {string} root the snapshot root, before its cleanup
 * @returns {Promise<number>} how many brokers may still be running
 */
export async function stopCompanionBroker(root) {
  let left = 0;
  try {
    for (const s of brokerSessions(root)) {
      if (s.socket) await requestShutdown(s.socket, 2000);
      if (!(await exitedWithin(s.pid, 1000))) {
        const who = brokerIdentity(s.pid, root);
        if (who === "ours") {
          try {
            process.kill(s.pid, "SIGTERM");
          } catch {
            // Exited in between.
          }
          if (!(await exitedWithin(s.pid, 2000))) left++;
        } else if (who === "unknown") left++;
      }
      removeSessionDir(s.sessionDir);
    }
  } catch {
    left++;
  } finally {
    reapers.get(root)?.();
    reapers.delete(root);
  }
  return left;
}

/** The signal-path twin of stopCompanionBroker: synchronous, SIGTERM only, same pid checks. @param {string} root */
function reapCompanionBroker(root) {
  for (const s of brokerSessions(root)) {
    if (isAlive(s.pid) && brokerIdentity(s.pid, root) === "ours") {
      try {
        process.kill(s.pid, "SIGTERM");
      } catch {
        // Exited in between.
      }
    }
  }
}

const OWNER_FILE = "owner.json";
const OWNER_MAX_BYTES = 4096;
/** Snapshots acted on (stopped and removed, or found still running) per sweep. */
export const SWEEP_MAX = 16;
/** `ws/plugin-*` entries looked at per sweep; each costs an lstat and at most one 4 KiB read. */
const SWEEP_SCAN_MAX = 256;
/** A snapshot with no owner file (the legacy engine's, or one mid-creation) is only a candidate after this long. */
export const LEGACY_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;

/**
 * `ps` in the C locale and UTC, bounded; null when it could not answer. lstart is printed in local time: without the TZ
 * pin, an owner.json written under one TZ reads as another start time under another, and a live round looks dead.
 * @param {string[]} args
 */
function ps(args) {
  const r = spawnSync("ps", args, { encoding: "utf8", timeout: 2000, maxBuffer: 16 * MiB, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return r.error || r.signal || r.status !== 0 ? null : r.stdout;
}

/** @param {string} s */
const squash = (s) => s.trim().replace(/\s+/g, " ");

/** A process's start time as `ps -o lstart=` prints it: with the pid, a reuse-safe identity. @param {number} pid */
function startTimeOf(pid) {
  const out = ps(["-o", "lstart=", "-p", String(pid)]);
  return out && squash(out) ? squash(out) : null;
}

/** Every process's start time, and every process's args, each read at most once per sweep. */
function processTable() {
  /** @type {Map<number, string> | null | undefined} */
  let starts;
  /** @type {string[] | null | undefined} */
  let args;
  return {
    starts() {
      if (starts === undefined) {
        const out = ps(["-A", "-o", "pid=,lstart="]);
        starts = out === null ? null : new Map(out.split("\n").map((l) => /^\s*(\d+)\s+(.+)$/.exec(l)).filter((m) => m !== null).map((m) => [Number(m[1]), squash(m[2])]));
      }
      return starts;
    },
    args() {
      if (args === undefined) {
        const out = ps(["-ww", "-A", "-o", "args="]);
        args = out === null ? null : out.split("\n");
      }
      return args;
    }
  };
}

/**
 * Whose snapshot this is: "none" (no owner file), "alive", "dead" (the pid is gone, or now another process), or
 * "unknown" (a linked, unreadable or malformed owner file, or ps could not answer).
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
  let v;
  try {
    v = JSON.parse(safeReadFile(file, OWNER_MAX_BYTES, { symlink: "state_symlink_rejected" }, { within: root }).toString("utf8"));
  } catch {
    return "unknown";
  }
  if (!isObject(v) || !Number.isInteger(v.pid) || /** @type {number} */ (v.pid) <= 1) return "unknown";
  const pid = /** @type {number} */ (v.pid);
  if (!isAlive(pid)) return "dead";
  if (typeof v.started !== "string") return "unknown";
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
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // Matched as given.
  }
  return lines.some((l) => l.includes(root) || l.includes(real));
}

/**
 * Round-start sweep of the `ws/plugin-*` snapshots a killed round left behind (a SIGKILL runs no finally and no
 * reaper): their companion data (Codex job files), `cxc-*` session dir and, possibly, a live detached broker.
 * A snapshot is swept only when its owner round is provably gone, or, with no owner file, when it is older than
 * LEGACY_SNAPSHOT_AGE_MS and no live process's args name it. Alive or unknown → left alone. Links are never followed:
 * the entry itself must be a real directory this user owns. Its broker is stopped by stopCompanionBroker (pid from
 * its own broker.json, args matching that snapshot); a snapshot whose broker may still run is kept for a later sweep.
 * At most SWEEP_MAX snapshots are acted on per call. Never throws.
 * @param {string} parentDir the private ws dir
 * @returns {Promise<{ swept: number, brokersLeft: number, failed: number }>}
 */
export async function sweepStaleSnapshots(parentDir) {
  const res = { swept: 0, brokersLeft: 0, failed: 0 };
  let names;
  try {
    names = fs.readdirSync(parentDir).filter((n) => n.startsWith("plugin-")).slice(0, SWEEP_SCAN_MAX);
  } catch {
    return res;
  }
  const table = processTable();
  let acted = 0;
  for (const name of names) {
    if (acted >= SWEEP_MAX) break;
    const root = path.join(parentDir, name);
    try {
      if (!ownedRealDirectory(root)) continue;
      const owner = ownerState(root, table);
      if (owner === "none") {
        if (Date.now() - fs.lstatSync(root).mtimeMs < LEGACY_SNAPSHOT_AGE_MS || referenced(root, table) !== false) continue;
      } else if (owner !== "dead") continue;
      acted++;
      const left = await stopCompanionBroker(root);
      if (left > 0) {
        res.brokersLeft += left;
        continue;
      }
      // Re-checked just before the remove: still a real directory of ours, never a link swapped in.
      if (!ownedRealDirectory(root)) continue;
      fs.rmSync(root, { recursive: true, force: true });
      res.swept++;
    } catch {
      res.failed++;
    }
  }
  return res;
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
