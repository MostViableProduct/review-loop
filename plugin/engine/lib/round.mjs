import fs from "node:fs";
import path from "node:path";
import { ReviewLoopError, errorCode } from "./errors.mjs";
import { sha256hex } from "./fsutil.mjs";
import { run } from "./proc.mjs";
import {
  readArtifact,
  gitOk,
  headSha,
  currentBranch,
  implFingerprint,
  isShallow,
  mergeBaseValidity,
  commitExists,
  fetchExactRef,
  isAncestor,
  statusEntries,
  assertPushDestination
} from "./git.mjs";
import { ghBranchSha } from "./github.mjs";
import { stateSubdir, readMarker, identityLabel } from "./state.mjs";
import { IMPL_EXCLUDED_PREFIXES } from "./classify.mjs";

/** Codes where retrying the same round cannot help; the skill reports them instead of retrying. */
export const NON_RETRYABLE = new Set([
  "artifact_symlink_rejected",
  "artifact_too_large",
  "artifact_missing",
  "artifact_not_regular_file",
  "pr_head_mismatch",
  "invalid_branch_name",
  "invalid_remote",
  "push_destination_mismatch",
  "pin_exists",
  "push_comparison_changed",
  "decision_stale",
  "bad_args",
  "invalid_key",
  "unknown_key",
  "state_symlink_rejected",
  "rubric_source_mismatch",
  "rubric_source_missing",
  "untracked_too_large",
  "diff_too_large",
  "history_scan_limit",
  "shallow_file_missing",
  "shallow_file_symlink",
  "shallow_file_too_large",
  "shallow_file_invalid",
  "branch_marker_missing"
]);

/** Outcomes that need a human decision rather than a retry. */
export class HumanNeeded extends Error {
  /** @param {string} reason @param {Record<string, unknown>} detail @param {string} message */
  constructor(reason, detail, message) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * @typedef {import("./state.mjs").Identity} Identity
 * @typedef {{ nothing: true } | { nothing: false, fingerprint: string, cwd: string, targetArgs: string[], label: string,
 *   instructions: string, coveredScope: string, projectRoot: string | null, cleanup: () => void }} Prepared
 */

/**
 * @param {Identity} identity
 * @param {{ projectRoot: string | null, key: string }} ctx
 * @returns {Promise<Prepared>}
 */
export async function prepare(identity, ctx) {
  if (identity.kind === "spec" || identity.kind === "plan") return prepareDoc(identity, ctx.projectRoot);
  if (identity.kind === "impl") return prepareImpl(identity.path);
  return prepareBranch(identity, ctx.key);
}

/**
 * Specs/plans are reviewed in a fresh scratch repo holding a verbatim copy (never a link), so git status of the
 * user's repo is irrelevant, non-git plans work, and the plugin's 24 KB untracked-file cap never applies.
 * @param {{ kind: "spec" | "plan", path: string }} identity
 * @param {string | null} projectRoot
 * @returns {Promise<Prepared>}
 */
async function prepareDoc(identity, projectRoot) {
  const content = readArtifact(identity.path, projectRoot);
  const fingerprint = sha256hex(content);
  const rel =
    projectRoot && identity.path.startsWith(projectRoot + path.sep) ? path.relative(projectRoot, identity.path) : path.basename(identity.path);
  const ws = fs.mkdtempSync(path.join(stateSubdir("ws"), "r-"));
  const cleanup = () => fs.rmSync(ws, { recursive: true, force: true });
  try {
    const cfg = ["-c", "user.name=review-loop", "-c", "user.email=review-loop@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
    await gitOk(ws, ["init", "-q"]);
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "", { mode: 0o600 });
    await gitOk(ws, [...cfg, "add", "--", rel]);
    await gitOk(ws, [...cfg, "commit", "-q", "--no-verify", "-m", "empty base"]);
    fs.writeFileSync(abs, content, { mode: 0o600 });
  } catch (err) {
    cleanup();
    throw err;
  }
  return {
    nothing: false,
    fingerprint,
    cwd: ws,
    targetArgs: ["--scope", "working-tree"],
    label: identity.path,
    projectRoot,
    instructions:
      `The file "${rel}" in this scratch repository is a verbatim copy of ${identity.path}. Review THAT DOCUMENT as a ${identity.kind}: ` +
      `its correctness, completeness, internal consistency, and fit with the real codebase at PROJECT ROOT. ` +
      `Cite "${rel}" as the finding file, or the project file when the defect is a ${identity.kind}↔code mismatch.`,
    coveredScope: `${identity.kind} ${identity.path} (full file, reviewed verbatim)${projectRoot ? `; project ${projectRoot} readable as context` : ""}`,
    cleanup
  };
}

/** @param {string} root @returns {Promise<Prepared>} */
async function prepareImpl(root) {
  const impl = await implFingerprint(root, await statusEntries(root));
  if (!impl) return { nothing: true };
  const listed = impl.paths.slice(0, 200);
  return {
    nothing: false,
    fingerprint: impl.fingerprint,
    cwd: root,
    targetArgs: ["--scope", "working-tree"],
    label: `implementation changes in ${root}`,
    projectRoot: root,
    instructions:
      `Review the uncommitted IMPLEMENTATION changes (working tree vs HEAD). In scope: ${listed.join(", ")}` +
      `${impl.paths.length > listed.length ? ` (+${impl.paths.length - listed.length} more)` : ""}. ` +
      `Markdown/text docs, specs and plans are reviewed separately — do not report findings on them.`,
    coveredScope:
      `implementation: files git would commit in ${root}, excluding *.md/*.mdx/*.txt and ${IMPL_EXCLUDED_PREFIXES.join(", ")}. ` +
      `Not covered: files inside git-ignored directories.`,
    cleanup: () => {}
  };
}

/**
 * The PR comparison: fresh base SHA from GitHub, local HEAD (fix commits are pushed only after the pass),
 * complete history (exact-ref unshallow, head first), and exactly one merge-base.
 * @param {{ kind: "branch", baseRepo: string, baseBranch: string, headRepo: string, headBranch: string }} identity
 * @param {string} key
 * @returns {Promise<Prepared>}
 */
async function prepareBranch(identity, key) {
  const marker = readMarker(key);
  if (!marker || !marker.projectRoot) throw new ReviewLoopError("branch_marker_missing", "no PR marker for this key; retry the PR so the gate records it");
  const root = marker.projectRoot;
  const extra = /** @type {{ baseRemote?: string | null, headRemote?: string | null }} */ (marker.extra ?? {});
  const baseSource = extra.baseRemote ?? `https://github.com/${identity.baseRepo}.git`;
  const headSource = extra.headRemote ?? `https://github.com/${identity.headRepo}.git`;

  if ((await currentBranch(root)) !== identity.headBranch) {
    throw new ReviewLoopError("pr_head_mismatch", `check out "${identity.headBranch}" to review this PR`);
  }
  const head = await headSha(root);
  if (!head) throw new ReviewLoopError("pr_head_mismatch", "no commits on the head branch");

  // GitHub's head must be an ancestor of local HEAD (we are ahead by unpushed fix commits), never diverged.
  let ghHead = null;
  try {
    ghHead = await ghBranchSha(identity.headRepo, identity.headBranch, root, { notFound: "head_not_on_github", failed: "head_unverifiable" });
  } catch (err) {
    if (errorCode(err) !== "head_not_on_github") throw err;
  }
  if (ghHead && ghHead !== head) {
    if (!(await commitExists(root, ghHead))) {
      const fetched = await fetchExactRef(root, headSource, identity.headBranch);
      if (fetched !== ghHead) throw new ReviewLoopError("head_moved", `${identity.headRepo}:${identity.headBranch} moved during the fetch`);
    }
    if (!(await isAncestor(root, ghHead, head))) {
      throw new HumanNeeded("head_diverged", { github: ghHead, local: head }, `GitHub ${identity.headRepo}:${identity.headBranch} is at ${ghHead.slice(0, 7)}, local is ${head.slice(0, 7)} — they have diverged`);
    }
  }

  // Fresh base SHA each round; make it available locally with an exact-ref fetch (re-resolve if it moves).
  let baseSha = "";
  for (let attempt = 0; ; attempt++) {
    baseSha = await ghBranchSha(identity.baseRepo, identity.baseBranch, root, { notFound: "pr_base_unverifiable", failed: "pr_base_unverifiable" });
    if (await commitExists(root, baseSha)) break;
    const fetched = await fetchExactRef(root, baseSource, identity.baseBranch);
    if (fetched === baseSha) break;
    if (attempt >= 2) throw new ReviewLoopError("base_moved", `${identity.baseRepo}:${identity.baseBranch} kept moving during the fetch`);
  }

  let v = await mergeBaseValidity(root, head, baseSha);
  if (!v.ok && v.reason === "history_incomplete" && ghHead) {
    await fetchExactRef(root, headSource, identity.headBranch, { unshallow: true });
    v = await mergeBaseValidity(root, head, baseSha);
  }
  if (!v.ok && v.reason === "history_incomplete" && (await isShallow(root))) {
    const fetched = await fetchExactRef(root, baseSource, identity.baseBranch, { unshallow: true });
    if (fetched !== baseSha) throw new ReviewLoopError("base_moved", `${identity.baseRepo}:${identity.baseBranch} moved during the fetch`);
    v = await mergeBaseValidity(root, head, baseSha);
  }
  if (!v.ok) {
    if (v.reason === "ambiguous") {
      throw new HumanNeeded("criss_cross", { base: identity.baseBranch, head: identity.headBranch }, "more than one best merge-base (criss-cross history)");
    }
    throw new ReviewLoopError(v.reason === "history_incomplete" ? "history_incomplete" : "merge_base_unavailable", `cannot establish the PR comparison (${v.reason})`);
  }
  const mb = v.mergeBase;
  return {
    nothing: false,
    fingerprint: `${head}:${mb}`,
    cwd: root,
    targetArgs: ["--base", mb],
    label: identityLabel(identity),
    projectRoot: root,
    instructions:
      `Review the pull-request diff ${mb.slice(0, 12)}..HEAD (${identity.headRepo}:${identity.headBranch} → ${identity.baseRepo}:${identity.baseBranch}). ` +
      `This is exactly the diff GitHub will show for the PR.`,
    coveredScope: `PR diff ${mb.slice(0, 12)}..${head.slice(0, 12)} (merge-base with ${identity.baseRepo}:${identity.baseBranch}@${baseSha.slice(0, 7)})`,
    cleanup: () => {}
  };
}

/**
 * Push after a branch pass: exact destination, never forced, never to a protected branch; then verify GitHub's head.
 * @param {{ kind: "branch", baseRepo: string, baseBranch: string, headRepo: string, headBranch: string }} identity
 * @param {string} key
 */
export async function pushBranch(identity, key, reviewedSha) {
  const marker = readMarker(key);
  if (!marker?.projectRoot) throw new ReviewLoopError("branch_marker_missing", "no PR marker for this key");
  const root = marker.projectRoot;
  const protectedNames = new Set(["main", "master", "develop", identity.baseBranch]);
  if (protectedNames.has(identity.headBranch)) {
    throw new ReviewLoopError("push_target_protected", `refusing to push to protected branch "${identity.headBranch}"`);
  }
  const remote = /** @type {{ headRemote?: string | null }} */ (marker.extra ?? {}).headRemote;
  if (!remote || remote.startsWith("-")) throw new ReviewLoopError("pr_head_repo_ambiguous", "no resolved head remote to push to");
  await assertPushDestination(root, remote, identity.headRepo);
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(reviewedSha)) throw new ReviewLoopError("push_not_reviewed", "no reviewed commit to push");
  // Push the reviewed commit by SHA, never `HEAD`: HEAD can move between the caller's check and this push.
  const head = reviewedSha;
  const r = await run("git", ["push", remote, `${head}:refs/heads/${identity.headBranch}`], { cwd: root, timeoutMs: 5 * 60_000 });
  if (r.code !== 0) {
    throw new HumanNeeded("push_rejected", { remote, branch: identity.headBranch }, `push to ${remote} ${identity.headBranch} was rejected: ${r.stderr.split("\n").find((l) => l.includes("rejected")) ?? r.stderr.split("\n")[0]}`);
  }
  const gh = await ghBranchSha(identity.headRepo, identity.headBranch, root, { notFound: "pr_head_not_pushed", failed: "pr_head_unverifiable" });
  if (gh !== head) throw new ReviewLoopError("pr_head_not_pushed", `after push GitHub is at ${gh.slice(0, 7)}, local HEAD is ${head?.slice(0, 7)}`);
  return { remote, branch: identity.headBranch, head };
}
