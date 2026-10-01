import fs from "node:fs";
import path from "node:path";
import { ReviewLoopError, errorCode, diagnosticCode } from "./errors.mjs";
import { sha256hex } from "./fsutil.mjs";
import { classifyRepoPath, classifyAbsolutePath, CLAUDE_PLANS_DIR } from "./classify.mjs";
import { repoRoot, statusEntries, implFingerprint, objectFormat, renameSource, isDeletion, readArtifact, assertPlansDir, headSha, committedPaths } from "./git.mjs";
import {
  identityKey,
  identityLabel,
  isClearedAt,
  readRecord,
  readBaseline,
  writeBaseline,
  listMarkers,
  removeMarker,
  isLockLive,
  readLock
} from "./state.mjs";
import { emitEvent } from "./events.mjs";
import { reapChildren } from "./proc.mjs";
import { killSwitchState, killSwitchForSession, RR_CMD } from "./prgate.mjs";

const MAX_PLAN_FILES = 2000;
/**
 * Pseudo baseline scope, written as SessionStart's LAST step. Its absence means the snapshot never completed — the
 * hook crashed, timed out, or never ran — so Stop over-reviews a repo it has no baseline for instead of snapshotting it.
 */
const START_OK = "session-start-completed";

/**
 * @typedef {import("./state.mjs").Identity} Identity
 * @typedef {{ identity: Identity, key: string, fingerprint: string, projectRoot: string | null, carriedFrom?: Identity }} Artifact
 */

/**
 * Content fingerprint of a spec/plan. Unreadable (symlink, oversize) → an error fingerprint, which never clears.
 * @param {string} abs
 * @param {string | null} projectRoot
 * @returns {{ fingerprint: string, content: Buffer | null }}
 */
export function docFingerprint(abs, projectRoot) {
  try {
    const content = readArtifact(abs, projectRoot);
    return { fingerprint: sha256hex(content), content };
  } catch (err) {
    return { fingerprint: errorFingerprint(errorCode(err), [abs]), content: null };
  }
}

/**
 * "error:<code>:<stat signature>". The code alone would compare equal across snapshots even after an edit (an
 * over-limit file edited but still over the limit); the lstat signature (no reads; ctime + identity, so restoring
 * size and mtime does not hide an edit) changes whenever a path is touched, so an untouched pre-existing failure stays
 * quiet while a changed one is pending — and blocking.
 * @param {string} code @param {string[]} paths absolute
 */
export function errorFingerprint(code, paths) {
  const sig = paths
    .slice()
    .sort()
    .map((p) => {
      try {
        const st = fs.lstatSync(p);
        // ctime: the kernel bumps it on every write or metadata change, and unlike mtime it cannot be set back.
        return `${p}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}\0${st.dev}\0${st.mode}${st.isSymbolicLink() ? `\0${fs.readlinkSync(p)}` : ""}`;
      } catch {
        return `${p}\0missing`;
      }
    })
    .join("\n");
  return `error:${code}:${sha256hex(sig).slice(0, 16)}`;
}

/**
 * @param {string} root
 * @returns {Promise<Artifact[]>}
 */
export async function detectRepoArtifacts(root) {
  /** @type {Artifact[]} */
  const out = [];
  let entries;
  try {
    entries = await statusEntries(root);
  } catch (err) {
    // Never report "nothing changed" when we could not look.
    throw new ReviewLoopError("detection_failed", `git status failed in ${root}: ${/** @type {Error} */ (err).message}`);
  }
  const format = await objectFormat(root);
  for (const e of entries) {
    if (e.path.endsWith("/") || isDeletion(e)) continue;
    const kind = classifyRepoPath(e.path);
    if (kind !== "spec" && kind !== "plan") continue;
    const abs = path.join(root, e.path);
    const { fingerprint, content } = docFingerprint(abs, root);
    const identity = /** @type {Identity} */ ({ kind, path: abs });
    const from = renameSource(entries, e.path, content, format);
    const fromKind = from ? classifyRepoPath(from) : null;
    out.push({
      identity,
      key: identityKey(identity),
      fingerprint,
      projectRoot: root,
      ...(from && (fromKind === "spec" || fromKind === "plan") ? { carriedFrom: { kind: fromKind, path: path.join(root, from) } } : {})
    });
  }
  try {
    const impl = await implFingerprint(root, entries);
    if (impl) {
      const identity = /** @type {Identity} */ ({ kind: "impl", path: root });
      out.push({ identity, key: identityKey(identity), fingerprint: impl.fingerprint, projectRoot: root });
    }
  } catch (err) {
    const identity = /** @type {Identity} */ ({ kind: "impl", path: root });
    const touched = entries.flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path])).map((p) => path.join(root, p));
    out.push({ identity, key: identityKey(identity), fingerprint: errorFingerprint(errorCode(err), touched), projectRoot: root });
  }
  return out;
}

/**
 * Top-level *.md in ~/.claude/plans (not a git repo). Over MAX_PLAN_FILES → `plans_scan_limit`, never a partial list.
 * @param {string | null} projectRoot
 * @param {string} [dir]
 * @returns {Artifact[]}
 */
export function detectPlansDir(projectRoot, dir = CLAUDE_PLANS_DIR) {
  if (!assertPlansDir(dir)) return [];
  const names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md"));
  if (names.length > MAX_PLAN_FILES) {
    throw new ReviewLoopError("plans_scan_limit", `${dir} holds ${names.length} plans (limit ${MAX_PLAN_FILES}); archive old plans`);
  }
  return names
    .sort()
    .map((n) => {
      const abs = path.join(dir, n);
      const identity = /** @type {Identity} */ ({ kind: "plan", path: abs });
      return { identity, key: identityKey(identity), fingerprint: docFingerprint(abs, projectRoot).fingerprint, projectRoot };
    });
}

/**
 * Specs and plans committed since the session began (author's decision: committed code stays with the PR and merge
 * gates). A committed doc is pending at its current content until a review passes at that fingerprint.
 * @param {string} root @param {string | null} startHead
 * @returns {Promise<Artifact[]>}
 */
async function committedDocs(root, startHead) {
  /** @type {Artifact[]} */
  const out = [];
  for (const rel of await committedPaths(root, startHead)) {
    const kind = classifyRepoPath(rel);
    if (kind !== "spec" && kind !== "plan") continue;
    const abs = path.join(root, rel);
    // Deleted (or no longer a file) since: nothing left to review, as for a deletion in `git status`.
    if (!fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    const identity = /** @type {Identity} */ ({ kind, path: abs });
    out.push({ identity, key: identityKey(identity), fingerprint: docFingerprint(abs, root).fingerprint, projectRoot: root });
  }
  return out;
}

/** @param {Artifact[]} list */
const toMap = (list) => Object.fromEntries(list.map((a) => [a.key, a.fingerprint]));

/**
 * SessionStart: record what already exists so only changes made during the session trigger a review.
 * @param {string} session
 * @param {string} cwd
 */
export async function snapshotSession(session, cwd) {
  let root = null;
  try {
    root = await repoRoot(cwd);
  } catch (err) {
    // Unknown root: no repo baseline can be keyed, and START_OK is withheld so Stop over-reviews.
    emitEvent({ source: "hook", event: "hook.error", code: diagnosticCode(err), session_id: session, data: { stage: "snapshot_degraded" } });
    await snapshotScope(session, CLAUDE_PLANS_DIR, async () => detectPlansDir(cwd));
    return;
  }
  if (root) {
    const switchOn = (await killSwitchState(root).catch(() => "off")) === "on";
    const head = await headSha(root).catch(() => null);
    await snapshotScope(session, root, async () => detectRepoArtifacts(root), switchOn, head);
  }
  await snapshotScope(session, CLAUDE_PLANS_DIR, async () => detectPlansDir(root ?? cwd));
  if (!readBaseline(session, START_OK)) writeBaseline(session, START_OK, {});
}

/**
 * First snapshot wins: SessionStart also fires on resume/compact with the same session id, and re-snapshotting then
 * would absorb this session's own unreviewed edits into the baseline.
 * @param {string} session @param {string} baseRoot @param {() => Promise<Artifact[]>} scan
 * @param {boolean} [killSwitchAtStart] the only record that makes a kill switch count this session
 * @param {string | null} [head] the repo's HEAD now, so Stop can see commits made since
 */
async function snapshotScope(session, baseRoot, scan, killSwitchAtStart = false, head = null) {
  if (readBaseline(session, baseRoot)) return;
  try {
    writeBaseline(session, baseRoot, toMap(await scan()), null, killSwitchAtStart, head);
  } catch (err) {
    // An empty, degraded snapshot makes every later artifact look changed: over-review, never silently skip.
    writeBaseline(session, baseRoot, {}, errorCode(err), killSwitchAtStart, head);
    emitEvent({ source: "hook", event: "hook.error", code: diagnosticCode(err), session_id: session, data: { stage: "snapshot_degraded" } });
  }
}

/**
 * "Could not look" is a blocking item, never an empty list.
 * @param {string} session @param {string} scope @param {unknown} err @param {string} statusCwd
 * @returns {PendingItem}
 */
function scanFailure(session, scope, err, statusCwd) {
  // errno (EACCES, EIO…) is a bounded classifier for the operator's item; the event log never carries it.
  const errno = /** @type {NodeJS.ErrnoException} */ (err)?.code;
  const io = !(err instanceof ReviewLoopError) && typeof errno === "string" && /^E[A-Z]+$/.test(errno) ? errno : null;
  try {
    emitEvent({ source: "hook", event: "hook.error", code: diagnosticCode(err), session_id: session, data: { stage: "detection_failed" } });
  } catch {
    // The state dir may be the very thing failing; the blocking item below must not depend on the log.
  }
  return {
    key: `scan:${scope}`,
    kind: "scan",
    label: `review status of ${scope}`,
    status: "op_error",
    reason: io ? `${errorCode(err)}:${io}` : errorCode(err),
    command: `${RR_CMD} status --cwd ${JSON.stringify(statusCwd)} --session ${JSON.stringify(session)}`,
    blocking: true
  };
}

/**
 * @typedef {{ key: string, kind: string, label: string, status: string, reason: string | null, command: string, blocking: boolean }} PendingItem
 */

/** Stop's scan budget, under the hook's 20 s timeout (hooks.json): node start-up, the summary write and the reply need the rest. */
export const STOP_SCAN_BUDGET_MS = 12_000;

/**
 * Everything this session changed that is not cleared at its current fingerprint. A scan still running at `budgetMs`
 * is abandoned for a blocking item: the hook's timeout would otherwise end the hook with no decision at all, and a
 * Stop with no decision lets the session end unreviewed. Its git children are killed and later spawns refused, so
 * nothing it left keeps the hook process alive past that timeout.
 * @param {string} session
 * @param {string} cwd
 * @param {number} [budgetMs]
 * @returns {Promise<{ items: PendingItem[], killSwitchRoot: string | null, killSwitchIgnored: { root: string, why: "tracked" | "mid_session" } | null, timedOut?: true }>}
 */
export async function pendingForSession(session, cwd, budgetMs = STOP_SCAN_BUDGET_MS) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    const scan = scanSession(session, cwd);
    // The losing scan may still reject once its children are killed; that must not surface as an unhandled rejection.
    scan.catch(() => {});
    const out = await Promise.race([scan, new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); })]);
    if (out !== null) return /** @type {Awaited<typeof scan>} */ (out);
    reapChildren();
    const err = new ReviewLoopError("command_timeout", `the scan ran past its ${budgetMs} ms budget`);
    return { items: [scanFailure(session, "this session's changes", err, cwd)], killSwitchRoot: null, killSwitchIgnored: null, timedOut: true };
  } catch (err) {
    // The Stop hook's crash handler only warns, so every scan failure — coded or a raw I/O error — must block here.
    // Blocking cannot trap the session: Stop blocks only while stop_hook_active is false.
    return { items: [scanFailure(session, "review-loop state", err, cwd)], killSwitchRoot: null, killSwitchIgnored: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} session
 * @param {string} cwd
 * @returns {Promise<{ items: PendingItem[], killSwitchRoot: string | null, killSwitchIgnored: { root: string, why: "tracked" | "mid_session" } | null }>}
 */
async function scanSession(session, cwd) {
  /** @type {Artifact[]} */
  const candidates = [];
  let killSwitchRoot = null;
  /** @type {{ root: string, why: "tracked" | "mid_session" } | null} */
  let killSwitchIgnored = null;

  const scopes = /** @type {Array<{ baseRoot: string, list: Artifact[] }>} */ ([]);
  /** @type {PendingItem[]} */
  const scanFailures = [];
  /** @type {string | null} */
  let root = null;
  try {
    root = await repoRoot(cwd);
  } catch (err) {
    scanFailures.push(scanFailure(session, cwd, err, cwd));
  }
  if (root) {
    const ks = await killSwitchForSession(session, root);
    if (ks === "tracked" || ks === "mid_session") {
      killSwitchIgnored = { root, why: ks };
      emitEvent({ source: "hook", event: "override", code: ks, session_id: session, data: { kind: "artifact", action: "kill_switch_ignored" } });
    }
    if (ks === "on") killSwitchRoot = root;
    else {
      try {
        scopes.push({ baseRoot: root, list: await detectRepoArtifacts(root) });
      } catch (err) {
        scanFailures.push(scanFailure(session, root, err, root));
      }
    }
  }
  try {
    scopes.push({ baseRoot: CLAUDE_PLANS_DIR, list: detectPlansDir(root ?? cwd) });
  } catch (err) {
    scanFailures.push(scanFailure(session, CLAUDE_PLANS_DIR, err, root ?? cwd));
  }

  for (const { baseRoot, list } of scopes) {
    const baseline = readBaseline(session, baseRoot);
    if (!baseline) {
      // No snapshot from this session's start: the repo's current state may already include this session's edits —
      // SessionStart never completed, or the session reached the repo later (cwd changed) and edited it through the
      // shell, which leaves no file-tool marker. Over-review rather than adopt those edits as the baseline.
      const head = baseRoot === CLAUDE_PLANS_DIR ? null : await headSha(baseRoot).catch(() => null);
      writeBaseline(session, baseRoot, {}, readBaseline(session, START_OK) ? "first_seen_mid_session" : "session_start_failed", false, head);
      candidates.push(...list);
      continue;
    }
    for (const a of list) if (baseline.artifacts[a.key] !== a.fingerprint) candidates.push(a);
    // A baseline without `head` predates commit tracking: its start commit is unknown, so there is no range to scan.
    if (baseRoot === CLAUDE_PLANS_DIR || baseline.head === undefined) continue;
    try {
      for (const a of await committedDocs(baseRoot, baseline.head)) {
        if (!candidates.some((c) => c.key === a.key)) candidates.push(a);
      }
    } catch (err) {
      scanFailures.push(scanFailure(session, baseRoot, err, baseRoot));
    }
  }

  // Markers: file-tool edits anywhere (incl. ignored dirs / non-git dirs) and PR-gate denials from this session.
  for (const m of listMarkers()) {
    if (m.session !== session || candidates.some((c) => c.key === m.key)) continue;
    if (m.identity.kind === "branch") {
      const rec = readRecord(m.key);
      if (rec && (rec.status === "passed" || rec.status === "overridden")) continue;
      candidates.push({ identity: m.identity, key: m.key, fingerprint: "branch", projectRoot: m.projectRoot });
      continue;
    }
    if (!fs.existsSync(m.identity.path)) {
      removeMarker(m.key);
      continue;
    }
    if (killSwitchRoot && m.identity.path.startsWith(killSwitchRoot + path.sep)) continue;
    const identity = /** @type {Identity} */ (m.identity);
    const a = { identity, key: m.key, fingerprint: docFingerprint(identity.path, m.projectRoot).fingerprint, projectRoot: m.projectRoot };
    // A marker whose file still matches the session-start snapshot was touched but not changed.
    const scopeRoot = identity.kind === "plan" && path.dirname(identity.path) === CLAUDE_PLANS_DIR ? CLAUDE_PLANS_DIR : root;
    const baseline = scopeRoot ? readBaseline(session, scopeRoot) : null;
    if (baseline && baseline.artifacts[a.key] === a.fingerprint) continue;
    candidates.push(a);
  }

  /** @type {PendingItem[]} */
  const items = [...scanFailures];
  for (const a of candidates) {
    if (a.identity.kind !== "branch") {
      const cleared = isClearedAt(a.identity, a.fingerprint) || (a.carriedFrom ? isClearedAt(a.carriedFrom, a.fingerprint) : false);
      if (cleared) {
        removeMarker(a.key);
        continue;
      }
    }
    const rec = readRecord(a.key);
    let status = rec?.status ?? "pending";
    if (status === "reviewing" && !isLockLive(readLock(a.key))) status = "op_error";
    // A running round is not a pass, and neither is a review that kept failing: both block (once per turn). Retries
    // exhausted means report the error and let the user decide (fix, or an override they approve) — never proceed.
    const blocking = !["awaiting_human", "stopped"].includes(status);
    const exhausted = rec?.status === "op_error" && rec.errorAttempts >= 3;
    const runCommand =
      a.identity.kind === "branch"
        ? `${RR_CMD} run --key ${a.key}`
        : `${RR_CMD} run --kind ${a.identity.kind} --path ${JSON.stringify(a.identity.path)}${a.projectRoot ? ` --project-root ${JSON.stringify(a.projectRoot)}` : ""}`;
    items.push({
      key: a.key,
      kind: a.identity.kind,
      label: identityLabel(a.identity),
      status,
      reason:
        status === "reviewing"
          ? "round_in_progress"
          : exhausted
            ? `${rec?.lastError?.code ?? "op_error"}, ${rec?.errorAttempts} attempts — retries exhausted: report it; the user decides`
            : rec?.awaiting?.reason ?? rec?.lastError?.code ?? (a.fingerprint.startsWith("error:") ? a.fingerprint.split(":")[1] : null),
      command: status === "reviewing" ? `wait for the running round to finish and act on its exit code (re-running now returns busy): ${runCommand}` : runCommand,
      blocking
    });
  }
  return { items, killSwitchRoot, killSwitchIgnored };
}

/**
 * Classify a path touched by a file tool; returns the identity to mark, or null.
 * @param {string} absPath
 * @param {string | null} root
 * @returns {Identity | null}
 */
export function identityForTouchedPath(absPath, root) {
  // Classify where the file really lives: a linked parent (`/tmp/specs -> ~/notes`) would otherwise lend any .md a
  // spec's name. ~/.claude/plans is itself a trust anchor and keeps its spelling (detectPlansDir keys plans by it).
  const dir = path.dirname(absPath);
  let real = absPath;
  try {
    if (dir !== CLAUDE_PLANS_DIR) real = path.join(fs.realpathSync(dir), path.basename(absPath));
  } catch {
    // Unresolvable: keep the spelling; readArtifact's ancestor walk still refuses any link on it.
  }
  const kind = classifyAbsolutePath(real, root);
  if (kind === "spec" || kind === "plan") return { kind, path: real };
  return null;
}
