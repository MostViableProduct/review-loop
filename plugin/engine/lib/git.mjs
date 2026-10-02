import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { run, streamHash, streamLines } from "./proc.mjs";
import { ReviewLoopError } from "./errors.mjs";
import { safeReadFile, sha256hex, MiB } from "./fsutil.mjs";
import { classifyRepoPath, implExcludePathspecs, CLAUDE_PLANS_DIR } from "./classify.mjs";

export const LIMITS = Object.freeze({
  artifactBytes: 1 * MiB,
  untrackedBytes: 5 * MiB,
  diffBytes: 64 * MiB,
  shallowFileBytes: 1 * MiB,
  shallowLines: 10_000,
  historyScanCommits: 500_000,
  historyScanMs: 60_000,
  fetchMs: 10 * 60_000
});

/**
 * The one way a spec/plan is read: parent directories below the project root (or ~/.claude/plans) are
 * symlink-checked too. A file outside both anchors is checked from its own directory only.
 * @param {string} abs
 * @param {string | null} projectRoot
 */
export function readArtifact(abs, projectRoot) {
  const inside = (/** @type {string} */ r) => abs.startsWith(r + path.sep);
  // Outside a project and the plans dir nothing is a trusted anchor, so every ancestor from / is lstat'ed.
  const within = projectRoot && inside(projectRoot) ? projectRoot : inside(CLAUDE_PLANS_DIR) ? CLAUDE_PLANS_DIR : path.parse(abs).root;
  if (within === CLAUDE_PLANS_DIR) assertPlansDir();
  return safeReadFile(abs, LIMITS.artifactBytes, {}, { within });
}

/**
 * ~/.claude/plans is a trust anchor (safeReadFile checks only below it), so the anchor itself must be a real directory:
 * a link there would hand any outside Markdown to Codex as a plan. A folder above it may be a link (a dotfiles-managed
 * ~/.claude), but only one of yours or the system's, through every hop, and the folder reached must be yours: a link
 * someone else owns would point the anchor wherever they chose (author's decision, round 20).
 * @param {string} [dir]
 * @param {number} [uid] the owner to trust besides root: this process's user
 * @returns {boolean} false when it is absent
 */
export function assertPlansDir(dir = CLAUDE_PLANS_DIR, uid = typeof process.getuid === "function" ? process.getuid() : -1) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) return false;
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ReviewLoopError("plans_dir_untrusted", "~/.claude/plans is a symlink or not a directory; its plans are not read");
  assertOwnLinks(path.dirname(path.resolve(dir)), uid, 0);
  if (st.uid !== uid && st.uid !== 0) throw new ReviewLoopError("plans_dir_untrusted", "the plans folder belongs to another user; its plans are not read");
  return true;
}

/** Every symlink on `p`'s path, and on each link's target path, is owned by `uid` or root. @param {string} p @param {number} uid @param {number} depth */
function assertOwnLinks(p, uid, depth) {
  if (depth > 40) throw new ReviewLoopError("plans_dir_untrusted", "the path to the plans folder has too many symlinks; its plans are not read");
  for (let d = path.resolve(p); path.dirname(d) !== d; d = path.dirname(d)) {
    const a = fs.lstatSync(d, { throwIfNoEntry: false });
    if (!a?.isSymbolicLink()) continue;
    if (a.uid !== uid && a.uid !== 0) throw new ReviewLoopError("plans_dir_untrusted", `${d}, on the path to the plans folder, is a symlink owned by another user; its plans are not read`);
    assertOwnLinks(path.resolve(path.dirname(d), fs.readlinkSync(d)), uid, depth + 1);
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, input?: string, maxBuffer?: number }} [opts]
 */
export async function git(cwd, args, opts = {}) {
  return run("git", args, { cwd, timeoutMs: opts.timeoutMs ?? 30_000, input: opts.input, maxBuffer: opts.maxBuffer });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, input?: string, maxBuffer?: number, code?: string }} [opts]
 */
export async function gitOk(cwd, args, opts = {}) {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) {
    throw new ReviewLoopError(opts.code ?? "git_failed", `git ${args[0]} failed (${r.code}): ${r.stderr.split("\n")[0]}`);
  }
  return r.stdout;
}

/**
 * How long one call may run: `cap`, or less when the caller's deadline (epoch ms) is nearer. A PreToolUse hook killed at
 * its timeout does not block the call, so a fail-closed gate must finish inside it; with no time left this throws.
 * @param {number | undefined} deadlineAt @param {number} cap
 */
export function budgetMs(deadlineAt, cap) {
  if (deadlineAt === undefined) return cap;
  const left = Math.min(cap, deadlineAt - Date.now());
  if (left <= 0) throw new ReviewLoopError("command_timeout", "the evaluation's time budget ran out");
  return left;
}

/** @param {string} cwd @param {number} [deadlineAt] */
export async function repoRoot(cwd, deadlineAt) {
  // LC_ALL=C: the "not a git repository" test below reads git's message, which is otherwise localized.
  const r = await run("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: budgetMs(deadlineAt, 30_000), env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" } });
  if (r.code === 0) return r.stdout.trim();
  if (r.timedOut && deadlineAt !== undefined) throw new ReviewLoopError("command_timeout", "git rev-parse --show-toplevel ran out of the time budget");
  // Only a confirmed non-repository is null. A timeout or any other git error is "could not look", never "no repo".
  if (!r.timedOut && /not a git repository/.test(r.stderr)) return null;
  throw new ReviewLoopError("repo_lookup_failed", `git rev-parse in ${cwd} failed: ${r.timedOut ? "timed out" : r.stderr.split("\n")[0] || `exit ${r.code}`}`);
}

/** @param {string} root */
export async function headSha(root) {
  const r = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

const MAX_COMMITTED_PATHS = 5000;

/**
 * Paths touched by commits made since the session began, on the current history (start..HEAD): a shell edit committed
 * before Stop leaves `git status` clean and no file-tool marker. The range is commits, never dates: a committer date
 * is whatever the committer sets (GIT_COMMITTER_DATE), so a date filter would let a backdated commit through. A branch
 * switch brings the other branch's commits into the range, so their specs and plans are reviewed too (over-review).
 * A commit moved off the current history (a switch away, a reset) is outside Stop's view by design (author's decision,
 * round 22): its file is not in the working tree to review, and the PR gate reviews every commit in a PR's diff
 * (head against the merge-base) before it can merge.
 * @param {string} root
 * @param {string | null} startHead HEAD at session start (null: no commit yet, so every commit is this session's)
 * @returns {Promise<string[]>} repo-relative paths
 */
export async function committedPaths(root, startHead) {
  if ((await headSha(root)) === null) return [];
  if (startHead !== null && (await git(root, ["cat-file", "-e", `${startHead}^{commit}`])).code !== 0) {
    // Git keeps an unreachable commit for weeks, so this is not a rewrite within a session; fail loud, never guess.
    throw new ReviewLoopError("detection_failed", "the commit HEAD pointed at when the session began is no longer in the repository");
  }
  const range = startHead === null ? "HEAD" : `${startHead}..HEAD`;
  const out = await gitOk(root, ["log", "--format=", "--name-only", "--no-renames", "-z", range, "--"], { maxBuffer: 8 * MiB, code: "detection_failed" });
  const paths = [...new Set(out.split("\0").map((p) => p.replace(/^\n+/, "")).filter(Boolean))];
  if (paths.length > MAX_COMMITTED_PATHS) throw new ReviewLoopError("detection_failed", `commits made this session touch ${paths.length} paths (limit ${MAX_COMMITTED_PATHS})`);
  return paths;
}

/** @param {string} root @param {number} [deadlineAt] */
export async function objectFormat(root, deadlineAt) {
  const r = await git(root, ["rev-parse", "--show-object-format"], { timeoutMs: budgetMs(deadlineAt, 30_000) });
  // Under a caller's deadline a timeout must not read as sha1 (a wrong format would reject every shallow-file id).
  if (r.timedOut && deadlineAt !== undefined) throw new ReviewLoopError("command_timeout", "git rev-parse --show-object-format timed out");
  return r.code === 0 && r.stdout.trim() === "sha256" ? "sha256" : "sha1";
}

/**
 * git's blob object id, computed in-process on bytes that already passed the safe read —
 * `git hash-object` is never pointed at a path (it would follow symlinks).
 * @param {Buffer} buf
 * @param {"sha1" | "sha256"} format
 */
export function blobId(buf, format) {
  return crypto.createHash(format).update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/**
 * @typedef {{ type: "1" | "2" | "u" | "?" | "!", xy: string, path: string, origPath?: string, hHead?: string }} StatusEntry
 * @param {string} out  output of `git status --porcelain=v2 -z`
 * @returns {StatusEntry[]}
 */
export function parseStatusV2(out) {
  const recs = out.split("\0");
  /** @type {StatusEntry[]} */
  const entries = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    const t = r[0];
    if (t === "?" || t === "!") {
      entries.push({ type: t, xy: t + t, path: r.slice(2) });
    } else if (t === "1") {
      const parts = r.split(" ");
      entries.push({ type: "1", xy: parts[1], hHead: parts[6], path: parts.slice(8).join(" ") });
    } else if (t === "2") {
      const parts = r.split(" ");
      entries.push({ type: "2", xy: parts[1], hHead: parts[6], path: parts.slice(9).join(" "), origPath: recs[i + 1] });
      i += 1;
    } else if (t === "u") {
      const parts = r.split(" ");
      entries.push({ type: "u", xy: parts[1], path: parts.slice(10).join(" ") });
    }
  }
  return entries;
}

/** @param {string} root */
export async function statusEntries(root) {
  const out = await gitOk(root, ["status", "--porcelain=v2", "-z", "--ignored=matching", "--untracked-files=all"], {
    maxBuffer: 64 * MiB,
    timeoutMs: 20_000
  });
  return parseStatusV2(out);
}

/** @param {StatusEntry} e */
export function isDeletion(e) {
  return (e.type === "1" || e.type === "2") && e.xy.includes("D");
}

/**
 * Rename evidence (the only way a pass moves to a new path):
 * a staged rename line, or an unstaged deletion whose HEAD blob id equals the new file's blob id.
 * @param {StatusEntry[]} entries
 * @param {string} relPath
 * @param {Buffer | null} content bytes of the new path, already safely read (null if unreadable)
 * @param {"sha1" | "sha256"} format
 * @returns {string | null} the previous relative path
 */
export function renameSource(entries, relPath, content, format) {
  const staged = entries.find((e) => e.type === "2" && e.path === relPath && e.xy.startsWith("R"));
  if (staged?.origPath) return staged.origPath;
  if (!content) return null;
  const id = blobId(content, format);
  const deleted = entries.find((e) => e.type === "1" && e.xy.includes("D") && e.hHead === id && e.path !== relPath);
  return deleted ? deleted.path : null;
}

/**
 * Fingerprint of "what git would commit" for implementation files only.
 * @param {string} root
 * @param {StatusEntry[]} [entriesIn]
 * @returns {Promise<{ fingerprint: string, paths: string[] } | null>} null when there is no implementation change
 */
export async function implFingerprint(root, entriesIn) {
  const entries = entriesIn ?? (await statusEntries(root));
  // A staged rename out of an implementation path (src/a.ts → docs/a.md) removes implementation code: count its source too.
  const tracked = entries.filter(
    (e) =>
      (e.type === "1" || e.type === "2" || e.type === "u") &&
      (classifyRepoPath(e.path) === "impl" || (e.type === "2" && !!e.origPath && classifyRepoPath(e.origPath) === "impl"))
  );
  const untracked = entries.filter((e) => e.type === "?" && classifyRepoPath(e.path) === "impl").map((e) => e.path).sort();
  if (tracked.length === 0 && untracked.length === 0) return null;

  const head = await headSha(root);
  const base = head ?? (await gitOk(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" })).trim();
  const diff = await streamHash(
    "git",
    ["diff", base, "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--", ".", ...implExcludePathspecs()],
    { cwd: root, maxBytes: LIMITS.diffBytes, tooLargeCode: "diff_too_large" }
  );

  const lines = [`HEAD:${head ?? "unborn"}`, `DIFF:${diff.sha256}`];
  for (const rel of untracked) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      lines.push(`U:${rel}\0L:${fs.readlinkSync(abs)}`);
    } else if (st.isFile()) {
      const buf = safeReadFile(abs, LIMITS.untrackedBytes, { tooLarge: "untracked_too_large" }, { within: root });
      // Git commits the owner-exec bit as the file's mode (100755 vs 100644), so a chmod alone is a change.
      lines.push(`U:${rel}\0F${st.mode & 0o100 ? "755" : "644"}:${sha256hex(buf)}`);
    }
  }
  const paths = [...new Set([...tracked.flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path])), ...untracked])].sort();
  return { fingerprint: sha256hex(lines.join("\n")), paths };
}

/** @param {string} root @param {number} [deadlineAt] */
export async function isShallow(root, deadlineAt) {
  return (await gitOk(root, ["rev-parse", "--is-shallow-repository"], { timeoutMs: budgetMs(deadlineAt, 30_000) })).trim() === "true";
}

/**
 * Locate the shallow file through git (correct from linked worktrees) and read it safely.
 * @param {string} root
 * @param {"sha1" | "sha256"} format
 * @param {number} [deadlineAt]
 * @returns {Promise<Set<string>>}
 */
export async function readShallowSet(root, format, deadlineAt) {
  const rel = (await gitOk(root, ["rev-parse", "--git-path", "shallow"], { timeoutMs: budgetMs(deadlineAt, 30_000) })).trim();
  const file = path.resolve(root, rel);
  const buf = safeReadFile(file, LIMITS.shallowFileBytes, {
    missing: "shallow_file_missing",
    symlink: "shallow_file_symlink",
    tooLarge: "shallow_file_too_large",
    notFile: "shallow_file_invalid"
  });
  const idRe = format === "sha256" ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{40}$/;
  const lines = buf.toString("utf8").split("\n").filter((l) => l.length > 0);
  if (lines.length > LIMITS.shallowLines) {
    throw new ReviewLoopError("shallow_file_invalid", `${file}: ${lines.length} entries exceeds ${LIMITS.shallowLines}`);
  }
  for (const l of lines) {
    if (!idRe.test(l)) throw new ReviewLoopError("shallow_file_invalid", `${file}: malformed object id entry`);
  }
  return new Set(lines);
}

/**
 * The comparison's history is complete iff no shallow cut-off commit is reachable from the given commits.
 * One streamed `git rev-list`, stopping at the first cut-off; bounded by commit count and time.
 * @param {string} root
 * @param {string[]} shas
 * @param {Set<string>} shallowSet
 * @param {number} [deadlineAt]
 */
export async function historyComplete(root, shas, shallowSet, deadlineAt) {
  if (shallowSet.size === 0) return true;
  const r = await streamLines("git", ["rev-list", ...shas], {
    cwd: root,
    maxLines: LIMITS.historyScanCommits,
    timeoutMs: budgetMs(deadlineAt, LIMITS.historyScanMs),
    limitCode: "history_scan_limit",
    onLine: (line) => shallowSet.has(line.trim())
  });
  return !r.stoppedEarly;
}

/** @param {string} root @param {string} sha @param {number} [deadlineAt] */
export async function commitExists(root, sha, deadlineAt) {
  const r = await git(root, ["cat-file", "-e", `${sha}^{commit}`], { timeoutMs: budgetMs(deadlineAt, 30_000) });
  return r.code === 0;
}

/**
 * @param {string} root
 * @param {string} head
 * @param {string} base
 * @param {number} [deadlineAt]
 * @returns {Promise<{ ok: true, mergeBase: string } | { ok: false, reason: "missing_commit" | "history_incomplete" | "ambiguous" | "none" }>}
 */
export async function mergeBaseValidity(root, head, base, deadlineAt) {
  if (!(await commitExists(root, head, deadlineAt)) || !(await commitExists(root, base, deadlineAt))) return { ok: false, reason: "missing_commit" };
  if (await isShallow(root, deadlineAt)) {
    const set = await readShallowSet(root, await objectFormat(root, deadlineAt), deadlineAt);
    if (!(await historyComplete(root, [head, base], set, deadlineAt))) return { ok: false, reason: "history_incomplete" };
  }
  const r = await git(root, ["merge-base", "--all", head, base], { timeoutMs: budgetMs(deadlineAt, 30_000) });
  const bases = r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  if (bases.length === 0) return { ok: false, reason: "none" };
  if (bases.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, mergeBase: bases[0] };
}

/**
 * Branch names reach git as argv (no shell), but a leading "-" would still be read as an option.
 * @param {string} root
 * @param {string} name
 */
export async function assertBranchName(root, name) {
  if (!name || name.startsWith("-")) throw new ReviewLoopError("invalid_branch_name", `invalid branch name: ${JSON.stringify(name)}`);
  const r = await git(root, ["check-ref-format", "--branch", name]);
  if (r.code !== 0) throw new ReviewLoopError("invalid_branch_name", `invalid branch name: ${JSON.stringify(name)}`);
}

/**
 * Fetch exactly refs/heads/<branch>. Empty --refmap= disables git's opportunistic
 * remote-tracking update and --no-tags skips tags, so only objects, FETCH_HEAD and the shallow file change.
 * @param {string} root
 * @param {string} source  a configured remote name or an https URL built from owner/repo
 * @param {string} branch
 * @param {{ unshallow?: boolean, timeoutMs?: number }} [opts] timeoutMs: a hook's remaining budget (default LIMITS.fetchMs)
 * @returns {Promise<string>} the fetched commit
 */
export async function fetchExactRef(root, source, branch, opts = {}) {
  await assertBranchName(root, branch);
  if (source.startsWith("-")) throw new ReviewLoopError("invalid_remote", `invalid fetch source: ${JSON.stringify(source)}`);
  const args = ["fetch", "--no-tags", "--refmap=", ...(opts.unshallow ? ["--unshallow"] : []), source, `refs/heads/${branch}`];
  const r = await git(root, args, { timeoutMs: opts.timeoutMs ?? LIMITS.fetchMs });
  if (r.timedOut || r.code !== 0) {
    throw new ReviewLoopError(opts.unshallow ? "unshallow_failed" : "fetch_failed", `git fetch from ${source} failed: ${r.stderr.split("\n")[0]}`);
  }
  return (await gitOk(root, ["rev-parse", "FETCH_HEAD"])).trim();
}

/**
 * Raw configured URLs (not insteadOf-expanded), so identity is the URL the user configured.
 * @param {string} root
 * @param {number} [deadlineAt]
 * @returns {Promise<{ name: string, url: string }[]>}
 */
export async function remoteUrls(root, deadlineAt) {
  const r = await git(root, ["config", "--get-regexp", "^remote\\..*\\.url$"], { timeoutMs: budgetMs(deadlineAt, 30_000) });
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => /^remote\.(.+)\.url (.+)$/.exec(l.trim()))
    .filter((m) => m !== null)
    .map((m) => ({ name: m[1], url: m[2] }));
}

/**
 * @param {string} url
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGithubUrl(url) {
  const m =
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url) ||
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url) ||
    /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() } : null;
}

/** @param {string} root @param {number} [deadlineAt] */
export async function githubRemotes(root, deadlineAt) {
  return (await remoteUrls(root, deadlineAt))
    .map((r) => ({ ...r, gh: parseGithubUrl(r.url) }))
    .filter((r) => r.gh !== null)
    .map((r) => ({ name: r.name, url: r.url, slug: `${r.gh?.owner}/${r.gh?.repo}` }));
}

/**
 * The push destination must be the reviewed head repo at push time. Checked on the EFFECTIVE push URLs — what
 * `git push` will actually contact after pushurl, insteadOf and pushInsteadOf — each of which must be a GitHub URL
 * of `headRepo`. (A configured-URL check alone is defeated by an insteadOf rewrite.)
 * @param {string} root @param {string} remote @param {string} headRepo
 */
export async function assertPushDestination(root, remote, headRepo) {
  const effective = (await gitOk(root, ["remote", "get-url", "--push", "--all", remote])).split("\n").map((l) => l.trim()).filter(Boolean);
  const bad = effective.find((u) => {
    const gh = parseGithubUrl(u);
    return !gh || `${gh.owner}/${gh.repo}` !== headRepo;
  });
  if (effective.length === 0 || bad !== undefined) {
    throw new ReviewLoopError("push_destination_mismatch", `remote "${remote}" would push to a destination other than github.com/${headRepo}`);
  }
}

/** @param {string} root */
export async function currentBranch(root) {
  const r = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** @param {string} root @param {string} branch */
export async function branchRemote(root, branch) {
  const r = await git(root, ["config", `branch.${branch}.remote`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** @param {string} root @param {string} ancestor @param {string} descendant */
export async function isAncestor(root, ancestor, descendant) {
  const r = await git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return r.code === 0;
}
