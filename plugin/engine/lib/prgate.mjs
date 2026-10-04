import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewLoopError, errorCode } from "./errors.mjs";
import { parsePrCreate } from "./cmdparse.mjs";
import { assertSlug, ghInstalled, ghDefaultRepo, ghDefaultBranch, ghBranchSha } from "./github.mjs";
import {
  budgetMs,
  git,
  repoRoot,
  headSha,
  currentBranch,
  branchRemote,
  githubRemotes,
  assertBranchName,
  commitExists,
  mergeBaseValidity
} from "./git.mjs";
import { identityKey, isClearedAt, writeMarker, readBaseline } from "./state.mjs";
import { emitEvent } from "./events.mjs";
import { reapChildren } from "./proc.mjs";

// fileURLToPath, not URL.pathname: the pathname is percent-encoded (a space reads as %20).
const REVIEW_ROUND = fileURLToPath(new URL("../review-round.mjs", import.meta.url));
/** The engine command as printed for the agent to run: the path quoted, since a plugin root may contain spaces. */
export const RR_CMD = `node ${JSON.stringify(REVIEW_ROUND)}`;

/**
 * @typedef {{ decision: "allow" | "deny", code: string, message: string, systemMessage?: string, artifactKey?: string }} GateResult
 * @typedef {{ base: string | null, head: string | null, repo: string | null, ghRepoEnv: string | null }} PrArgs
 */

/** @param {string} root */
/**
 * The switch is the user's, not the agent's: it counts only if SessionStart (a hook, not the agent) recorded it present
 * when the session began. One created mid-session — by anyone — is ignored until the next session.
 * @param {string | null} session @param {string} root @param {number} [deadlineAt]
 * @returns {Promise<"off" | "on" | "tracked" | "mid_session">}
 */
export async function killSwitchForSession(session, root, deadlineAt) {
  const ks = await killSwitchState(root, deadlineAt);
  if (ks !== "on") return ks;
  return session && readBaseline(session, root)?.killSwitchAtStart === true ? "on" : "mid_session";
}

/**
 * The switch is a local decision: a clone only brings tracked files, so a committed switch would disable review for
 * every clone. It counts only while untracked — not in the index, not in HEAD. If git cannot say, it is not honored.
 * @param {string} root
 * @param {number} [deadlineAt]
 * @returns {Promise<"off" | "on" | "tracked">}
 */
export async function killSwitchState(root, deadlineAt) {
  const rel = ".claude/review-loop.off";
  if (!fs.existsSync(path.join(root, rel))) return "off";
  const t = () => ({ timeoutMs: budgetMs(deadlineAt, 30_000) });
  const index = await git(root, ["ls-files", "--error-unmatch", "--", rel], t());
  const head = await git(root, ["cat-file", "-e", `HEAD:${rel}`], t());
  if (index.code === 0 || head.code === 0) return "tracked";
  const unborn = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"], t())).code !== 0;
  return index.code === 1 && (head.code !== 0 || unborn) ? "on" : "tracked";
}

/**
 * The repo a PR targets: -R, inline GH_REPO, process GH_REPO, gh's own default, then the single GitHub remote. Never a
 * guess. The one implementation, shared by the PR gate and post-create verification.
 * @param {string} root
 * @param {{ repo: string | null, ghRepoEnv: string | null }} args
 * @param {{ remotes?: Array<{ slug: string }>, deadlineAt?: number }} [opts]
 */
export async function resolveBaseSlug(root, args, opts = {}) {
  let baseSlug = args.repo ?? args.ghRepoEnv ?? process.env.GH_REPO ?? (await ghDefaultRepo(root, opts.deadlineAt));
  if (!baseSlug) {
    const slugs = [...new Set((opts.remotes ?? (await githubRemotes(root, opts.deadlineAt))).map((r) => r.slug))];
    if (slugs.length !== 1) {
      // Without gh the default above could not be consulted, so "run gh repo set-default" would be unactionable advice.
      if (!(await ghInstalled(root, opts.deadlineAt))) throw new ReviewLoopError("gh_not_installed", "the GitHub CLI (gh) is not installed, so the PR's repository cannot be resolved: install and sign in to gh, or pass -R owner/repo");
      throw new ReviewLoopError("pr_base_repo_ambiguous", "cannot tell which repository the PR targets: run `gh repo set-default` or pass -R owner/repo");
    }
    baseSlug = slugs[0];
  }
  return assertSlug(baseSlug);
}

/**
 * Resolve the PR's exact comparison: base repo/branch/SHA and head repo/branch/SHA, all from explicit sources or GitHub.
 * Shared by the gate and the review round so both bind to the same comparison.
 * @param {string} root
 * @param {PrArgs} args
 */
export async function resolvePrTarget(root, args) {
  const remotes = await githubRemotes(root);
  const baseSlug = await resolveBaseSlug(root, args, { remotes });

  const baseBranch = args.base ?? (await ghDefaultBranch(baseSlug, root, "pr_base_unverifiable"));
  await assertBranchName(root, baseBranch);
  const baseSha = await ghBranchSha(baseSlug, baseBranch, root, { notFound: "pr_base_unverifiable", failed: "pr_base_unverifiable" });

  const cur = await currentBranch(root);
  if (!cur) throw new ReviewLoopError("pr_head_mismatch", "HEAD is detached; check out the PR's head branch");
  const headSpec = args.head ?? cur;
  let headBranch = headSpec;
  /** @type {{ name: string, slug: string } | undefined} */
  let headRemote;
  if (headSpec.includes(":")) {
    const [owner, branch] = headSpec.split(/:(.*)/s);
    headBranch = branch;
    const matches = remotes.filter((r) => r.slug.split("/")[0] === owner.toLowerCase());
    if (matches.length !== 1) {
      throw new ReviewLoopError("pr_head_repo_ambiguous", `need exactly one git remote owned by "${owner}" (found ${matches.length})`);
    }
    headRemote = matches[0];
  } else {
    const upstream = await branchRemote(root, cur);
    headRemote = upstream ? remotes.find((r) => r.name === upstream) : undefined;
    if (!headRemote) throw new ReviewLoopError("pr_head_not_pushed", `"${cur}" has no GitHub upstream; push it with -u first`);
  }
  if (headBranch !== cur) throw new ReviewLoopError("pr_head_mismatch", `the PR head is "${headBranch}" but the checked-out branch is "${cur}"; run from the head branch`);
  await assertBranchName(root, headBranch);

  const baseRemote = remotes.find((r) => r.slug === baseSlug) ?? null;
  return {
    baseSlug,
    baseBranch,
    baseSha,
    baseRemote: baseRemote ? baseRemote.name : null,
    headSlug: headRemote.slug,
    headBranch,
    headRemote: headRemote.name,
    identity: /** @type {const} */ ({ kind: "branch", baseRepo: baseSlug, baseBranch, headRepo: headRemote.slug, headBranch })
  };
}

/** The whole evaluation's budget, as merge.mjs and prverify.mjs use, under the PreToolUse hook's 40 s timeout. */
export const DEADLINE_MS = 30_000;

/**
 * A PreToolUse hook killed at its timeout does not block the call, so a slow repository or GitHub must end in a
 * decision, not a kill: an evaluation still running at `deadlineMs` is abandoned for a deny, its git and gh children
 * killed and later spawns refused, so nothing it left keeps the hook alive past that timeout. Advisory turns the deny
 * into a warning in the hook, as for every PR-gate deny.
 * @param {{ cwd: string, session: string | null, command?: string, mcpInput?: Record<string, unknown>, deadlineMs?: number }} p
 * @returns {Promise<GateResult | null>} null = not a PR creation; let it through untouched
 */
export async function evaluatePrGate(p) {
  const budget = p.deadlineMs ?? DEADLINE_MS;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const work = evaluateUnbounded(p);
  // The abandoned evaluation may still reject once its children are killed; never an unhandled rejection.
  work.catch(() => {});
  try {
    const out = await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), budget); })]);
    if (out !== "timeout") return /** @type {GateResult | null} */ (out);
    reapChildren();
    return deny("command_timeout", `the PR gate ran past its ${Math.round(budget / 1000)} s budget before it could verify this PR; retry the PR`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{ cwd: string, session: string | null, command?: string, mcpInput?: Record<string, unknown> }} p
 * @returns {Promise<GateResult | null>}
 */
async function evaluateUnbounded(p) {
  /** @type {PrArgs | null} */
  let args;
  try {
    if (p.command !== undefined) {
      args = parsePrCreate(p.command);
      if (!args) return null;
    } else {
      const i = p.mcpInput ?? {};
      const str = (/** @type {unknown} */ v) => (typeof v === "string" && v.length ? v : null);
      const owner = str(i.owner);
      const repo = str(i.repo);
      args = { base: str(i.base), head: str(i.head), repo: owner && repo ? `${owner}/${repo}` : null, ghRepoEnv: null };
    }
  } catch (err) {
    return deny(errorCode(err), /** @type {Error} */ (err).message);
  }

  const root = await repoRoot(p.cwd);
  if (!root) return deny("pr_args_unresolvable", "run PR creation from inside the repository so the review gate can verify it");
  const ks = await killSwitchForSession(p.session, root);
  if (ks === "tracked" || ks === "mid_session") emitEvent({ source: "hook", event: "override", code: ks, session_id: p.session, data: { kind: "branch", action: "kill_switch_ignored" } });
  if (ks === "on") {
    emitEvent({ source: "hook", event: "override", code: "kill_switch", session_id: p.session, data: { kind: "branch", action: "kill_switch" } });
    return { decision: "allow", code: "kill_switch", message: "", systemMessage: `⚠ review-loop: kill switch ${root}/.claude/review-loop.off is present — PR created WITHOUT review (logged override)` };
  }

  try {
    const t = await resolvePrTarget(root, args);
    const localHead = await headSha(root);
    const ghHead = await ghBranchSha(t.headSlug, t.headBranch, root, { notFound: "pr_head_not_pushed", failed: "pr_head_unverifiable" });
    if (localHead !== ghHead) {
      throw new ReviewLoopError(
        "pr_head_not_pushed",
        `GitHub ${t.headSlug}:${t.headBranch} is at ${ghHead.slice(0, 7)} but the reviewed HEAD is ${localHead?.slice(0, 7)}; push, then retry`
      );
    }
    let fingerprint = null;
    if (await commitExists(root, t.baseSha)) {
      const v = await mergeBaseValidity(root, ghHead, t.baseSha);
      if (v.ok) fingerprint = `${ghHead}:${v.mergeBase}`;
      else if (v.reason === "ambiguous") {
        const ambiguousKey = writePending(root, t, p.session, "merge_base_ambiguous");
        return deny("merge_base_ambiguous", `${t.baseBranch} and ${t.headBranch} have more than one best merge-base; run the review-loop:review-loop skill to decide`, ambiguousKey);
      }
    }
    if (fingerprint && isClearedAt(t.identity, fingerprint)) {
      return { decision: "allow", code: "reviewed", message: "", artifactKey: identityKey(t.identity) };
    }
    const key = writePending(root, t, p.session, fingerprint ? "not_reviewed_at_fingerprint" : "comparison_unverified");
    return deny(
      "review_pending",
      `review-loop: PR ${t.headSlug}:${t.headBranch} → ${t.baseSlug}:${t.baseBranch}@${t.baseSha.slice(0, 7)} pending — ` +
        `invoke the review-loop:review-loop skill (${RR_CMD} run --key ${key}), then retry the PR`,
      key
    );
  } catch (err) {
    return deny(errorCode(err), /** @type {Error} */ (err).message);
  }
}

/**
 * @param {string} root
 * @param {Awaited<ReturnType<typeof resolvePrTarget>>} t
 * @param {string | null} session
 * @param {string} why
 */
function writePending(root, t, session, why) {
  return writeMarker(t.identity, {
    source: "pr",
    projectRoot: root,
    session,
    extra: { baseSha: t.baseSha, baseRemote: t.baseRemote, headRemote: t.headRemote, why }
  });
}

/** @param {string} code @param {string} message @param {string} [artifactKey] @returns {GateResult} */
function deny(code, message, artifactKey) {
  return { decision: "deny", code, message: `review-loop [${code}]: ${message}`, ...(artifactKey ? { artifactKey } : {}) };
}
