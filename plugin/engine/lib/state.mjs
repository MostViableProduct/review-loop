import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ReviewLoopError } from "./errors.mjs";
import { atomicWriteJson, readJsonValidated, isObject, sha256hex, assertNoLinkedParent } from "./fsutil.mjs";
import { stateRoot, stateSubdir } from "./paths.mjs";
import { emitEvent } from "./events.mjs";
import { OPTIONS } from "./policy.mjs";
import { isTreeRef } from "./pin.mjs";
import { trustedPs, processIdent } from "./proc.mjs";

// Moved to proc.mjs (pin.mjs uses it too, and state.mjs already imports pin.mjs); re-exported for its callers.
export { processIdent };

export { stateRoot, stateSubdir };

export const STATUSES = Object.freeze([
  "pending",
  "reviewing",
  "needs_fixes",
  "passed",
  "overridden",
  "awaiting_human",
  "op_error",
  "stopped"
]);

export const LOCK_TTL_MS = 20 * 60_000;
export const LOCK_HEARTBEAT_MS = 60_000;

/** @param {unknown} v @returns {string} */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * @typedef {{ kind: "spec" | "plan" | "impl", path: string } |
 *   { kind: "branch", baseRepo: string, baseBranch: string, headRepo: string, headBranch: string }} Identity
 * @param {Identity} identity
 */
export function identityKey(identity) {
  return sha256hex(stable(identity)).slice(0, 24);
}

/** @param {Identity} identity */
export function identityLabel(identity) {
  if (identity.kind === "branch") return `PR ${identity.headRepo}:${identity.headBranch} → ${identity.baseRepo}:${identity.baseBranch}`;
  return `${identity.kind} ${identity.path}`;
}

/** @param {unknown} v */
function isIdentity(v) {
  if (!isObject(v) || typeof v.kind !== "string") return false;
  if (v.kind === "branch") return ["baseRepo", "baseBranch", "headRepo", "headBranch"].every((k) => typeof v[k] === "string");
  return ["spec", "plan", "impl"].includes(v.kind) && typeof v.path === "string";
}

const isInt = (/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0;
const isStrOrNull = (/** @type {unknown} */ s) => s === null || typeof s === "string";
const isIntOrNull = (/** @type {unknown} */ n) => n === null || isInt(n);

/** @param {unknown} v */
export function isRecord(v) {
  return (
    isObject(v) &&
    v.v === 1 &&
    isIdentity(v.identity) &&
    typeof v.status === "string" &&
    STATUSES.includes(v.status) &&
    isInt(v.round) &&
    (v.mode === "capped" || v.mode === "uncapped") &&
    isInt(v.nextCheckpoint) &&
    // The loop's limits (retries, stall, uncapped ceiling) compare these: a string would never reach its bound.
    isInt(v.errorAttempts) &&
    isInt(v.sinceImprovement) &&
    isIntOrNull(v.uncappedStart) &&
    isIntOrNull(v.bestSumTenths) &&
    (v.lastError === null || (isObject(v.lastError) && typeof v.lastError.code === "string")) &&
    isObject(v.meta) &&
    (v.meta.projectRoot === undefined || typeof v.meta.projectRoot === "string") &&
    (v.meta.codex === undefined ||
      (isObject(v.meta.codex) && isStrOrNull(v.meta.codex.model) && isStrOrNull(v.meta.codex.effort) && isStrOrNull(v.meta.codex.source))) &&
    isStrOrNull(v.fingerprint) &&
    isStrOrNull(v.reviewedFingerprint) &&
    Array.isArray(v.history) &&
    v.history.every((h) => isObject(h) && isInt(h.round) && isInt(h.sumTenths)) &&
    Array.isArray(v.disputes) &&
    v.disputes.every((d) => isObject(d) && typeof d.title === "string" && typeof d.reason === "string" && isInt(d.raisedAgain)) &&
    Array.isArray(v.waivers) &&
    v.waivers.every((w) => isObject(w) && typeof w.title === "string") &&
    (v.awaiting === null || isAwaiting(v.awaiting))
  );
}

/** Every field the page renderer and applyDecision consume is checked here, so bad state is quarantined at read. */
function isAwaiting(/** @type {unknown} */ a) {
  if (!isObject(a) || typeof a.reason !== "string" || !Object.hasOwn(OPTIONS, a.reason)) return false;
  const allowed = /** @type {readonly string[]} */ (OPTIONS[/** @type {keyof typeof OPTIONS} */ (a.reason)]);
  return (
    Array.isArray(a.options) &&
    a.options.length > 0 &&
    a.options.every((o) => typeof o === "string" && allowed.includes(o)) &&
    (a.detail === undefined || isObject(a.detail)) &&
    // repin trusts detail.tree as the identity of what the user approved: exact shape, or absent (repin then refuses).
    (a.reason !== "plugin_pin" || a.detail === undefined || a.detail.tree === undefined || a.detail.tree === null || isTreeRef(a.detail.tree)) &&
    (a.fingerprint === undefined || isStrOrNull(a.fingerprint))
  );
}

/** @param {Identity} identity @param {Record<string, unknown>} [meta] */
export function newRecord(identity, meta = {}) {
  return {
    v: 1,
    identity,
    status: "pending",
    round: 0,
    mode: "capped",
    nextCheckpoint: 10,
    uncappedStart: null,
    bestSumTenths: null,
    sinceImprovement: 0,
    fingerprint: null,
    reviewedFingerprint: null,
    history: [],
    disputes: [],
    waivers: [],
    awaiting: null,
    lastError: null,
    errorAttempts: 0,
    meta,
    updatedAt: new Date().toISOString()
  };
}

/**
 * Keys become file names under the state dir, so only the exact shape identityKey produces is accepted — a caller
 * string like `../../x` must never reach a read (whose quarantine renames bad files) or a write.
 * @param {string} key
 */
export function assertKey(key) {
  if (!/^[0-9a-f]{24}$/.test(key)) throw new ReviewLoopError("invalid_key", `not a review key: ${JSON.stringify(key).slice(0, 64)}`);
  return key;
}

const recordPath = (/** @type {string} */ key) => path.join(stateRoot(), "records", `${assertKey(key)}.json`);
const markerPath = (/** @type {string} */ key) => path.join(stateRoot(), "markers", `${assertKey(key)}.json`);

/** @param {string} key */
export function readRecord(key) {
  return readJsonValidated(recordPath(key), isRecord, stateRoot());
}

/**
 * Only review-round.mjs writes records, and only while holding the artifact's lock. Fencing: once this process has
 * taken the lock, a write after losing it (reclaimed as stale while we were hung) fails with `lock_lost`.
 */
export function writeRecord(record) {
  const key = identityKey(record.identity);
  const token = heldTokens.get(key);
  if (token !== undefined && readLock(key)?.token !== token) {
    throw new ReviewLoopError("lock_lost", "the review lock was reclaimed by another process; this round's result is discarded");
  }
  record.updatedAt = new Date().toISOString();
  atomicWriteJson(recordPath(key), record, stateRoot());
}

/** @param {Identity} identity @param {string | null} fingerprint */
export function isClearedAt(identity, fingerprint) {
  if (fingerprint === null) return false;
  const r = readRecord(identityKey(identity));
  return !!r && (r.status === "passed" || r.status === "overridden") && r.reviewedFingerprint === fingerprint;
}

// ---- markers: one file per identity; written by hooks, never a shared read-modify-write ----

/** @param {unknown} v */
function isMarker(v) {
  if (!isObject(v) || v.v !== 1 || !isIdentity(v.identity) || typeof v.source !== "string" || !isObject(v.extra)) return false;
  const x = v.extra;
  return (
    // The key names a record file: it must be this identity's own key, not merely well-formed.
    v.key === identityKey(v.identity) &&
    isStrOrNull(v.projectRoot ?? null) &&
    isStrOrNull(v.session ?? null) &&
    [x.baseRemote, x.headRemote].every((r) => r === undefined || isStrOrNull(r)) &&
    (x.baseSha === undefined || typeof x.baseSha === "string")
  );
}

/**
 * @param {Identity} identity
 * @param {{ source: string, projectRoot: string | null, session: string | null, extra?: Record<string, unknown> }} data
 */
export function writeMarker(identity, data) {
  const key = identityKey(identity);
  atomicWriteJson(markerPath(key), {
    v: 1,
    identity,
    key,
    source: data.source,
    projectRoot: data.projectRoot,
    session: data.session,
    extra: data.extra ?? {},
    createdAt: new Date().toISOString()
  }, stateRoot());
  return key;
}

/** @param {string} key */
export function readMarker(key) {
  return readJsonValidated(markerPath(key), isMarker, stateRoot());
}

/** @param {string} key */
export function removeMarker(key) {
  assertNoLinkedParent(markerPath(key), stateRoot(), "state_symlink_rejected");
  fs.rmSync(markerPath(key), { force: true });
}

export function listMarkers() {
  // Even an empty listing through a link would hide every marker-only spec from Stop.
  const dir = stateSubdir("markers");
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJsonValidated(path.join(dir, n), isMarker, stateRoot()))
    .filter((m) => m !== null);
}

// ---- per-session snapshots: only artifacts that change during the session trigger a review ----

/** @param {string} session @param {string} root */
function baselinePath(session, root) {
  return path.join(stateRoot(), "baselines", sha256hex(session).slice(0, 16), `${sha256hex(root).slice(0, 16)}.json`);
}

/** @param {unknown} v */
function isBaseline(v) {
  return isObject(v) && v.v === 1 && typeof v.root === "string" && isObject(v.artifacts) && (v.killSwitchAtStart === undefined || typeof v.killSwitchAtStart === "boolean") &&
    (v.head === undefined || v.head === null || (typeof v.head === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v.head))) &&
    (v.at === undefined || (typeof v.at === "string" && !Number.isNaN(Date.parse(v.at))));
}

/** @param {string} session @param {string} root */
export function readBaseline(session, root) {
  return readJsonValidated(baselinePath(session, root), isBaseline, stateRoot());
}

/**
 * @param {string} session @param {string} root @param {Record<string, string>} artifacts
 * @param {string | null} [degraded] error code when the scan failed (artifacts is then empty on purpose)
 * @param {string | null} [head] the repo's HEAD at session start, so Stop can see commits made since
 */
export function writeBaseline(session, root, artifacts, degraded = null, killSwitchAtStart = false, head = null) {
  atomicWriteJson(baselinePath(session, root), { v: 1, root, artifacts, degraded, killSwitchAtStart, head, at: new Date().toISOString() }, stateRoot());
}

/** Drop snapshot directories untouched for 14 days. */
export function pruneBaselines(maxAgeMs = 14 * 24 * 3600_000) {
  // A recursive delete through a linked baselines dir would remove data outside the state tree.
  const dir = stateSubdir("baselines");
  const cutoff = Date.now() - maxAgeMs;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    try {
      if (fs.lstatSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT") throw err;
    }
  }
}

// ---- pending summary: written by the Stop hook, read by the prompt hook (cheap, no git calls) ----

/** @param {string} session */
function summaryPath(session) {
  return path.join(stateRoot(), "pending", `${sha256hex(session).slice(0, 16)}.json`);
}

const SUMMARY_MAX_ITEMS = 256;
const SUMMARY_MAX_TEXT = 4096;
const isText = (/** @type {unknown} */ s) => typeof s === "string" && s.length <= SUMMARY_MAX_TEXT;

/** Every field the prompt hook interpolates is checked, so a parseable but malformed summary is quarantined. @param {unknown} v */
function isSummary(v) {
  return isObject(v) && v.v === 1 && Array.isArray(v.items) && v.items.length <= SUMMARY_MAX_ITEMS &&
    v.items.every((i) => isObject(i) && isText(i.key) && isText(i.kind) && isText(i.label) && isText(i.status) && isText(i.command) && (i.reason === null || isText(i.reason)));
}

/** @param {string} session @param {Array<{ key: string, kind: string, label: string, status: string, reason: string | null, command: string }>} items */
export function writePendingSummary(session, items) {
  atomicWriteJson(summaryPath(session), { v: 1, items, at: new Date().toISOString() }, stateRoot());
}

/** @param {string} session */
export function readPendingSummary(session) {
  return readJsonValidated(summaryPath(session), isSummary, stateRoot());
}

// ---- locks ----

/** @param {number} pid */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @param {string} key */
const lockPath = (key) => {
  const p = path.join(stateRoot(), "locks", `${assertKey(key)}.lock`);
  assertNoLinkedParent(p, stateRoot(), "state_symlink_rejected");
  return p;
};

/** @type {Map<string, string>} key → token of every lock this process holds */
const heldTokens = new Map();

/** @param {string} file @returns {string | null} */
/**
 * `at` is the file's mtime — the heartbeat's only write — never a field the holder rewrites.
 * @param {{ raw: string, mtimeMs: number } | null} obs
 * @returns {{ pid: number, at: number, token: string } | null}
 */
function parseLock(obs) {
  try {
    const v = obs === null ? null : JSON.parse(obs.raw);
    if (!(isObject(v) && Number.isInteger(v.pid) && typeof v.token === "string")) return null;
    return { pid: v.pid, token: v.token, at: /** @type {{ mtimeMs: number }} */ (obs).mtimeMs };
  } catch {
    return null;
  }
}

/** @param {string} key */
export function readLock(key) {
  return parseLock(observeLock(lockPath(key)));
}

/**
 * Publish lock content atomically: a lock file is never observable empty or half-written (either would read as dead).
 * `link` fails with EEXIST instead of replacing, which is what makes creation exclusive.
 * @param {string} file @param {string} content
 */
function publishLock(file, content) {
  const tmp = publishTempName(file);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The private temp file publishLock links from. Exported so a test can pin that it never matches a marker name. @param {string} file */
export function publishTempName(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
}

const MAX_LOCK_BYTES = 4096;

/**
 * One observation of a lock file — the SAME one both judges staleness and is compared in reclaimStale: bytes, mtime
 * and inode all come from one descriptor. Lock files are untrusted: O_NOFOLLOW|O_NONBLOCK (a symlink to a FIFO can
 * neither be followed nor block), regular file only, bounded. Anything else reads as "no valid lock" (reclaimable)
 * and is logged.
 * @param {string} file
 * @returns {{ raw: string, mtimeMs: number, ino: number } | null}
 */
function observeLock(file) {
  const obs = observeFile(file);
  return obs === GONE ? null : obs;
}

const GONE = Symbol("gone");

/**
 * observeLock, keeping "no file at all" (GONE) apart from "a file that can't be read" (null): a section marker that
 * vanished was removed, while one that can't be read may still belong to a live mover.
 * @param {string} file
 * @returns {{ raw: string, mtimeMs: number, ino: number } | null | typeof GONE}
 */
function observeFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const errno = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (errno === "ENOENT") return GONE;
    lockInvalid(errno === "ELOOP" ? "state_symlink_rejected" : "open_failed");
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_LOCK_BYTES) {
      lockInvalid(st.isFile() ? "too_large" : "not_regular_file");
      return null;
    }
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return { raw: buf.subarray(0, n).toString("utf8"), mtimeMs: st.mtimeMs, ino: st.ino };
  } finally {
    fs.closeSync(fd);
  }
}

/** @type {"hook" | "round"} */
let lockEventSource = "hook";

/**
 * Which process role reads locks: the hook reads them for status, review-round.mjs for acquire/heartbeat. One role per
 * process, set once at the entrypoint.
 * @param {"hook" | "round"} source
 */
export function setLockEventSource(source) {
  lockEventSource = source;
}

/** @param {string} code */
function lockInvalid(code) {
  try {
    emitEvent({ source: lockEventSource, event: "hook.error", code, data: { stage: "lock_invalid" } });
  } catch {
    // Diagnostics only; the caller already treats the lock as invalid.
  }
}

/**
 * Compare-and-swap removal of a lock judged stale. Renaming is atomic but acts on the PATH, so the file moved aside
 * must be the very observation that was judged stale — same bytes (no takeover), same mtime (no heartbeat since:
 * liveness lives in the mtime, not the bytes) and same inode. Otherwise it is put back (link never clobbers) and the
 * caller reports busy.
 * @param {string} key @param {{ raw: string, mtimeMs: number, ino: number } | null} observed
 * @returns {boolean} true when the stale lock is gone and creation may be retried
 */
export function reclaimStale(key, observed) {
  return takeAside(lockPath(key), (now) =>
    observed === null ? now === null || parseLock(now) === null : !!now && now.raw === observed.raw && now.mtimeMs === observed.mtimeMs && now.ino === observed.ino
  );
}

/**
 * The lock CAS: move the path aside atomically, then judge the file actually moved — never an earlier read of the
 * path, which a takeover can replace in between. Judged removable → deleted; otherwise put back (link never clobbers a
 * newer lock) and false is returned. Only a mover inside the section calls this, so the file moved is the one it
 * observed, give or take a heartbeat's mtime.
 * @param {string} file @param {(moved: ReturnType<typeof observeLock>) => boolean} removable
 */
function takeAside(file, removable) {
  const aside = `${file}.aside.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(file, aside);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return true;
    throw e;
  }
  if (removable(observeLock(aside))) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  try {
    fs.linkSync(aside, file);
  } catch {
    // Only a mover outside the section (a pre-1.0.3 process during an upgrade) can publish in this gap; the holder it
    // displaced is fenced out by writeRecord's token check.
  }
  fs.rmSync(aside, { force: true });
  return false;
}

/** @param {{ pid: number, at: number } | null} lock */
export function isLockLive(lock, now = Date.now()) {
  return !!lock && now - lock.at < LOCK_TTL_MS && isPidAlive(lock.pid);
}

// ---- the mover section ----
// Every operation that MOVES the lock path (a stale reclaim, a release) runs inside a per-key section, one process at
// a time. Publishing into an empty path needs none: link() is already exclusive. Each contender publishes its own
// marker, then enters only if no other marker is live; a marker stays live for as long as its owner process exists,
// with no time limit, so a suspended mover never loses its section. See CLAUDE.md "Locks".

const SECTION_ATTEMPTS = 4;
const MIN_MARKER_PID = 2;
const MAX_MARKER_PID = 99_999;

/** @param {string} name */
function seamMs(name) {
  if (process.env.REVIEW_LOOP_TEST_SEAMS !== "1") return 0;
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** @param {number} ms */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @type {string | null} this process's own identity, read once it succeeds */
let selfIdent = null;

/**
 * A section marker's name: `<key>.lock.reclaim.<pid>.<first 16 hex of its token>`, the PID from 2 to 99999 (macOS
 * PIDs never exceed 99999; 0 is the caller's process group to kill(), 1 is launchd). Anything else under the prefix,
 * publishLock's temp files included, is litter, never a marker.
 * @param {string} key @param {string} name @returns {{ pid: number, hex: string } | null}
 */
export function markerName(key, name) {
  const m = new RegExp(`^${assertKey(key)}\\.lock\\.reclaim\\.([1-9]\\d{0,4})\\.([0-9a-f]{16})$`).exec(name);
  if (m === null) return null;
  const pid = Number(m[1]);
  return pid >= MIN_MARKER_PID && pid <= MAX_MARKER_PID ? { pid, hex: m[2] } : null;
}

/**
 * Judge another contender's marker. Stale only when its owner is provably gone: the name's PID is dead, or the marker
 * is verified and the process now at that PID has a different identity. Everything else is live — a suspended owner,
 * a marker that can't be read or doesn't agree with its own name, a /bin/ps that fails — because revoking a live
 * mover's section is what lets two movers in. No branch reads the mtime: there is no time limit.
 * @param {string} file @param {{ pid: number, hex: string }} named
 * @returns {{ live: false } | { live: true, verified: boolean }}
 */
function markerState(file, named) {
  // Our own PID: every section in this process is synchronous and already finished, so this is one we stranded.
  if (named.pid === process.pid) return { live: false };
  if (!isPidAlive(named.pid)) return { live: false };
  const obs = observeFile(file);
  if (obs === GONE) return { live: false };
  /** @type {unknown} */
  let v = null;
  try {
    v = obs === null ? null : JSON.parse(obs.raw);
  } catch {
    v = null;
  }
  const verified =
    isObject(v) &&
    v.pid === named.pid &&
    typeof v.ident === "string" &&
    /^[0-9a-f]{64}$/.test(v.ident) &&
    typeof v.token === "string" &&
    /^[0-9a-f]{32}$/.test(v.token) &&
    v.token.startsWith(named.hex);
  if (!verified) return { live: true, verified: false };
  const now = processIdent(named.pid);
  if (now !== null && now !== v.ident) return { live: false };
  return { live: true, verified: true };
}

/** @param {string} file @param {number} pid @param {boolean} verified */
function busyBy(file, pid, verified) {
  return new ReviewLoopError(
    "busy",
    verified
      ? `the review-loop lock is being changed by review-loop process ${pid} (\`ps -p ${pid}\`); if that process is stuck, end it, and the lock frees itself`
      : `a review-lock marker can't be read, so its owner is unverified: ${file} (named for pid ${pid}). Check \`ps -p ${pid}\`: if that is not a review-loop process, delete that one file and retry`,
    { pid, verified, ...(verified ? {} : { marker: file }) }
  );
}

/** @param {string} code @param {string} stage */
function lockEvent(code, stage) {
  try {
    emitEvent({ source: lockEventSource, event: "hook.error", code, data: { stage } });
  } catch {
    // Diagnostics only; emitEvent itself never throws.
  }
}

/**
 * Unlink a file by exact name; a name already gone is fine. Returns false (logged) when it can't be removed.
 * @param {string} file
 */
function unlinkMarker(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return true;
    lockEvent("lock_marker_cleanup_failed", "lock_marker_cleanup");
    return false;
  }
}

/**
 * List the other markers for `key`. Stale ones are removed by exact name (names are never reused, so this can't hit
 * a live marker); litter past LOCK_TTL_MS goes too. Returns the busy error for the first live one, or null.
 * @param {string} key @param {string} dir @param {string} ownName
 */
function othersLive(key, dir, ownName) {
  const prefix = `${key}.lock.reclaim.`;
  for (const n of fs.readdirSync(dir)) {
    if (!n.startsWith(prefix) || n === ownName) continue;
    const file = path.join(dir, n);
    if (strandedMarkers.has(file)) continue; // ours, retried on its own; judging it here would log its failure twice
    const named = markerName(key, n);
    if (named === null) {
      try {
        if (Date.now() - fs.lstatSync(file).mtimeMs > LOCK_TTL_MS) unlinkMarker(file);
      } catch {
        // Gone already, or unreadable litter: never a marker either way.
      }
      continue;
    }
    const st = markerState(file, named);
    if (!st.live) {
      unlinkMarker(file);
      continue;
    }
    return busyBy(file, named.pid, st.verified);
  }
  return null;
}

/** @type {Set<string>} our own markers whose unlink failed — exact paths, never another process's */
const strandedMarkers = new Set();
/** @type {Map<string, string>} key → the token of a release that found the section busy */
const pendingReleases = new Map();
let exitHooked = false;

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    try {
      retryPendingReleases();
    } catch {
      // An exit handler can't report a throw; a lock left behind is reclaimed once this PID is gone.
    }
    retryStrandedMarkers();
  });
}

function retryStrandedMarkers() {
  for (const file of strandedMarkers) if (unlinkMarker(file)) strandedMarkers.delete(file);
}

function retryPendingReleases() {
  for (const [key, token] of pendingReleases) {
    if (!carriesToken(lockPath(key), token)) {
      pendingReleases.delete(key);
      continue;
    }
    try {
      withSection(key, () => removeOwnLock(key, token));
      pendingReleases.delete(key);
    } catch (e) {
      if (!isSectionRefusal(e)) throw e;
    }
  }
}

/** @param {unknown} e */
const isSectionRefusal = (e) => e instanceof ReviewLoopError && (e.code === "busy" || e.code === "lock_identity_unavailable");

/**
 * Run `fn` inside `key`'s mover section. Each attempt publishes a fresh marker, then lists the others: a contender
 * that created its marker before checking is always seen by every later checker, so at most one enters. Two that see
 * each other both withdraw; a short random backoff lets one of them in on a later attempt.
 * @template T @param {string} key @param {() => T} fn @returns {T}
 */
function withSection(key, fn) {
  // No identity, no marker: a marker without one could never be told apart from a reused PID's.
  selfIdent ??= processIdent(process.pid);
  if (selfIdent === null) {
    throw new ReviewLoopError("lock_identity_unavailable", "could not read this process's identity from /bin/ps, so the review lock can't be changed safely");
  }
  const dir = path.dirname(lockPath(key));
  /** @type {ReviewLoopError | null} */
  let blocked = null;
  for (let attempt = 0; attempt < SECTION_ATTEMPTS; attempt++) {
    if (attempt > 0) sleepSync(crypto.randomInt(1, 8 << attempt));
    const token = crypto.randomBytes(16).toString("hex");
    const name = `${key}.lock.reclaim.${process.pid}.${token.slice(0, 16)}`;
    const own = path.join(dir, name);
    publishLock(own, JSON.stringify({ pid: process.pid, ident: selfIdent, token }));
    try {
      sleepSync(seamMs("REVIEW_LOOP_TEST_MARKER_CHECK_PAUSE_MS"));
      blocked = othersLive(key, dir, name);
      if (blocked === null) return fn();
    } finally {
      // Never throws: a published lock always gets its handle back. A failure is logged and retried later.
      if (!unlinkMarker(own)) {
        strandedMarkers.add(own);
        hookExit();
      }
    }
  }
  throw /** @type {ReviewLoopError} */ (blocked);
}

/**
 * Whether the lock at `file` still carries `token`. Without it there is nothing for a release to move — the lock is
 * gone (even with its directory, as after `uninstall --delete-history`) or someone else's — so no section is needed.
 * @param {string} file @param {string} token
 */
const carriesToken = (file, token) => parseLock(observeLock(file))?.token === token;

/**
 * Inside the section: remove the lock only while it still carries `token`. A lock we don't own is never moved.
 * @param {string} key @param {string} token
 */
function removeOwnLock(key, token) {
  const file = lockPath(key);
  if (!carriesToken(file, token)) return;
  sleepSync(seamMs("REVIEW_LOOP_TEST_SECTION_PAUSE_MS"));
  takeAside(file, (moved) => parseLock(moved)?.token === token);
}

/** Keys with a deferred release, for tests. */
export function pendingReleaseKeys() {
  return [...pendingReleases.keys()];
}

/**
 * Exclusive per-artifact lock. Held → throws `busy` immediately (callers never wait inside a hook).
 * The holder refreshes `at` every LOCK_HEARTBEAT_MS, so a round of any length keeps its lock; a lock whose PID is
 * gone, or whose heartbeat stopped for LOCK_TTL_MS (hung holder, or a recycled PID), is reclaimed.
 *
 * Contract: at most one process returns from acquireLock for a key until that lock is released, or until its HOLDER
 * is judged stale by that rule (a holder judged stale while alive is fenced by writeRecord's `lock_lost`). A reclaimer
 * or releaser never moves a lock other than the one it observed, however long it is suspended. This holds among
 * 1.0.3+ processes; a pre-1.0.3 process still running during an upgrade moves the path without the section, as it
 * always did, and the holder it displaces is fenced by writeRecord.
 * @param {string} key
 * @param {string | null} session
 */
export function acquireLock(key, session) {
  stateSubdir("locks");
  const file = lockPath(key);
  retryStrandedMarkers();
  retryPendingReleases();
  const token = crypto.randomBytes(16).toString("hex");
  const content = JSON.stringify({ pid: process.pid, session, token });
  try {
    publishLock(file, content);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST") throw e;
    const cur = parseLock(observeLock(file));
    if (isLockLive(cur)) throw new ReviewLoopError("busy", `another review is running for this artifact (pid ${cur?.pid})`);
    withSection(key, () => {
      // Re-observed inside the section: the observation above may be out of date by the time we got in.
      const observed = observeLock(file);
      const now = parseLock(observed);
      if (isLockLive(now)) throw new ReviewLoopError("busy", `another review is running for this artifact (pid ${now?.pid})`);
      sleepSync(seamMs("REVIEW_LOOP_TEST_SECTION_PAUSE_MS"));
      if (!reclaimStale(key, observed)) throw new ReviewLoopError("busy", "the review lock changed hands while reclaiming it");
      try {
        publishLock(file, content);
      } catch (err) {
        // A first-time acquirer won the empty path; we moved only the stale lock, so nobody was displaced.
        if (/** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") throw new ReviewLoopError("busy", "another review took the lock first");
        throw err;
      }
    });
  }
  heldTokens.set(key, token);
  let released = false;
  const beat = setInterval(() => {
    const cur = readLock(key);
    if (!cur || cur.token !== token) return clearInterval(beat);
    // mtime only, never content: a heartbeat racing a takeover can at worst freshen the NEW holder's lock — it can
    // never put our token back (the takeover itself is fenced by writeRecord).
    const now = Date.now() / 1000;
    fs.utimesSync(file, now, now);
  }, LOCK_HEARTBEAT_MS);
  beat.unref();
  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      heldTokens.delete(key);
      retryStrandedMarkers();
      retryPendingReleases();
      if (!carriesToken(file, token)) return;
      try {
        withSection(key, () => removeOwnLock(key, token));
      } catch (e) {
        if (!isSectionRefusal(e)) throw e;
        // Deferred with OUR token: a retry removes the lock only while it still carries it.
        pendingReleases.set(key, token);
        hookExit();
        lockEvent(/** @type {ReviewLoopError} */ (e).code, "lock_release_deferred");
      }
    }
  };
}
