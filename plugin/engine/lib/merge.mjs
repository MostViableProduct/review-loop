import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMerge, parsePrCreate } from "./cmdparse.mjs";
import { ReviewLoopError, errorCode } from "./errors.mjs";
import { ghBranchSha, ghInstalled, ghPrView } from "./github.mjs";
import { commitExists, fetchExactRef, githubRemotes, mergeBaseValidity, repoRoot } from "./git.mjs";
import { killSwitchForSession, resolveBaseSlug } from "./prgate.mjs";
import { advisoryText, gateOutcome } from "./presets.mjs";
import { identityKey, isClearedAt, readRecord } from "./state.mjs";

const SHA = /^[0-9a-f]{40}$/;
// The hook's timeout is 40 s (hooks.json); every gh and git call of one evaluation ends inside this.
const DEADLINE_MS = 30_000;
// Time a fetch must leave for the re-check (two bounded gh calls at most).
const RECHECK_RESERVE_MS = 8_000;
const UNVERIFIABLE = "pr_merge_context_unverifiable";

/**
 * The GitHub MCP merge tool's head-binding field, as Probe P7 recorded it (unverified: no server was connected, so this
 * is the documented name). It ships inside the plugin, never read from test/, because an install contains only plugin/.
 * `null` means the tool can't bind the head.
 */
export const MCP_HEAD_FIELD = (() => {
  const v = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./mcp-merge.json", import.meta.url)), "utf8"));
  return typeof v.headField === "string" && v.headField ? v.headField : null;
})();

/**
 * gate: the gate.decision this evaluation is logged under. A raw-client PR creation (`/pulls` without `/merge`) is the
 * create gate's, even though the merge classifier is the one that catches it.
 * @typedef {{ decision: "allow" | "deny" | "warn", code: string, message: string, gate: "merge" | "pr" }} MergeResult
 * @typedef {{ repo: string | null, ghRepoEnv: string | null, number: number | null, bind: string | null, admin: boolean, input: boolean }} Target
 */

/** @param {string} code @param {string} message @returns {MergeResult} */
const deny = (code, message) => ({ decision: "deny", code, message: `review-loop [${code}]: ${message}`, gate: "merge" });
const short = (/** @type {string} */ sha) => sha.slice(0, 7);

/**
 * A tokenized PR creation in the same command (ruling R-D4): a text mention (a title saying "merge") is not one. A
 * creation the parser refuses as an API create still is one; any other refusal propagates, so it fails closed.
 * @param {string} command
 */
function createsPr(command) {
  try {
    return parsePrCreate(command) !== null;
  } catch (err) {
    if (errorCode(err) === "pr_via_api_unsupported") return true;
    throw err;
  }
}

/** A configured remote for the repo, so the user's own git auth applies; else its https URL. @param {string} root @param {string} slug @param {number} deadlineAt */
async function fetchSource(root, slug, deadlineAt) {
  return (await githubRemotes(root, deadlineAt)).find((r) => r.slug === slug)?.name ?? `https://github.com/${slug}.git`;
}

/**
 * The merge gate (spec §7.1 (3)). Advisory turns every deny into a warning: it never blocks (§5.2).
 * @param {{ cwd: string, session: string | null, command?: string, mcpInput?: Record<string, unknown>, preset: string, mcpHeadField?: string | null, deadlineMs?: number }} p
 *   mcpHeadField: the MCP tool's head field; defaults to the shipped P7 value (a different server's schema can lack one).
 *   deadlineMs: the evaluation's time budget (default 30 s), as for prverify.
 * @returns {Promise<MergeResult>}
 */
export async function evaluateMergeGate(p) {
  const r = await decide(p);
  if (r.decision !== "deny" || gateOutcome(p.preset, r.gate, true) !== "warn") return r;
  return { decision: "warn", code: r.code, message: advisoryText(r.message), gate: r.gate };
}

/**
 * @param {Parameters<typeof evaluateMergeGate>[0]} p
 * @returns {Promise<MergeResult>}
 */
async function decide(p) {
  const headField = p.mcpHeadField === undefined ? MCP_HEAD_FIELD : p.mcpHeadField;
  /** @type {Target} */
  let target;
  /** @type {string | null} */
  let root;
  // One budget for every gh and git call of this evaluation: a PreToolUse hook killed at its 40 s timeout does not block
  // the call, so running out of time must deny here instead (fails closed).
  const deadlineAt = Date.now() + (p.deadlineMs ?? DEADLINE_MS);
  try {
    // Structural denials come first and survive the kill switch, as the PR gate's parse errors do.
    if (p.command !== undefined) {
      const m = parseMerge(p.command);
      if (!m) return { decision: "allow", code: "not_merge", message: "", gate: "merge" };
      // One call with an unreadable GraphQL body: the create gate refuses the same body, which is not a second call.
      if (m.kind === "graphql-merge" && m.unreadable) {
        return deny("pr_merge_graphql_unsupported", "a GraphQL call whose body the gate cannot read (a file, stdin or a shell expansion) may merge; inline the query, or merge with gh pr merge <number> --match-head-commit <reviewed-sha>");
      }
      if (createsPr(p.command)) return deny("pr_create_merge_compound", "create the PR, let review-loop verify it, then merge in a separate command");
      if (m.kind === "raw-client") {
        return { ...deny("pr_github_api_unsupported_client", "a raw HTTP client call to GitHub's pulls/merge API bypasses the review gate; use gh (gh pr / gh api) so review-loop can check the call"), gate: m.merge ? "merge" : "pr" };
      }
      if (m.kind === "graphql-merge") return deny("pr_merge_graphql_unsupported", "a GraphQL merge, merge-queue or auto-merge mutation's head binding cannot be reliably read; use gh pr merge <number> --match-head-commit <reviewed-sha>");
      target = m.kind === "pr-merge"
        ? { repo: m.repo, ghRepoEnv: m.ghRepoEnv, number: m.number, bind: m.bind, admin: m.admin, input: false }
        : { repo: m.repo, ghRepoEnv: m.ghRepoEnv, number: m.number, bind: m.bind, admin: false, input: m.input };
    } else {
      if (headField === null) return deny("pr_merge_mcp_unbindable", "this GitHub MCP server's merge tool can't bind the head commit; use gh pr merge <number> --match-head-commit <reviewed-sha>");
      const i = p.mcpInput ?? {};
      const num = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : typeof v === "string" && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null);
      if (i.pullNumber !== undefined && i.pull_number !== undefined && num(i.pullNumber) !== num(i.pull_number)) {
        throw new ReviewLoopError("pr_args_unresolvable", "the merge tool call gives pullNumber and pull_number that disagree; pass one");
      }
      if (typeof i.owner !== "string" || !i.owner || typeof i.repo !== "string" || !i.repo) return deny(UNVERIFIABLE, "the merge tool call names no owner/repo");
      const bind = i[headField];
      target = { repo: `${i.owner}/${i.repo}`, ghRepoEnv: null, number: num(i.pullNumber ?? i.pull_number), bind: typeof bind === "string" ? bind : null, admin: false, input: false };
    }
    // null = git confirmed "not a repository"; any other failure (a spent budget, a timeout) says so instead.
    root = await repoRoot(p.cwd, deadlineAt).catch((/** @type {unknown} */ err) => {
      throw new ReviewLoopError(UNVERIFIABLE, errorCode(err) === "command_timeout"
        ? "the merge gate's time budget ran out before the repository could be found; retry the merge"
        : `the repository could not be found (${errorCode(err)}); retry the merge`);
    });
    // Same switch, same rule as the PR gate: only one recorded at session start counts. The event is the hook's single
    // gate.decision (outcome skipped); no override event, which the PR gate owns for creations.
    if (root && (await killSwitchForSession(p.session, root, deadlineAt)) === "on") {
      return { decision: "allow", code: "kill_switch", message: "⚠ review-loop: kill switch .claude/review-loop.off is present — merge allowed WITHOUT the merge gate's check (logged)", gate: "merge" };
    }
  } catch (err) {
    const code = errorCode(err);
    return deny(code === "pr_args_unresolvable" ? code : UNVERIFIABLE, /** @type {Error} */ (err).message);
  }
  if (!root) return deny(UNVERIFIABLE, "run the merge from inside a clone of the PR's repository, so the gate can compute its merge-base");
  try {
    return await bound(root, target, deadlineAt);
  } catch (err) {
    return deny(UNVERIFIABLE, `the PR's context could not be resolved (${errorCode(err)}); install and sign in to gh, then retry the merge`);
  }
}

/**
 * Commit- and context-bound (spec §7.1 "Context binding"): the PR's own identity must have a passed review at exactly
 * `<bind>:<merge-base of bind with the PR's current base>`. Order matters: the reviewed-head binding is checked before
 * any git work (ruling R-D16), and the PR is re-read immediately before allowing (ruling R-P7a).
 * @param {string} root
 * @param {Target} target
 * @param {number} deadlineAt epoch ms: every gh and git call below ends by then
 * @returns {Promise<MergeResult>}
 */
async function bound(root, target, deadlineAt) {
  /** @type {string} */
  let repo;
  try {
    repo = await resolveBaseSlug(root, target, { deadlineAt });
  } catch (err) {
    return deny(UNVERIFIABLE, `cannot tell which repository the PR is in (${errorCode(err)}); pass -R owner/repo`);
  }
  if (target.number === null) return deny(UNVERIFIABLE, "name the PR by number: gh pr merge <number> -R owner/repo --match-head-commit <reviewed-sha>");
  const n = target.number;
  const pr = await ghPrView(repo, n, root, deadlineAt);
  if (!pr) {
    const why = (await ghInstalled(root, deadlineAt)) ? "the GitHub request failed" : "gh is not installed";
    return deny(UNVERIFIABLE, `could not read PR #${n} from GitHub (${why}); install and sign in to gh, then retry the merge`);
  }
  const identity = { kind: /** @type {const} */ ("branch"), baseRepo: repo, baseBranch: pr.baseRefName, headRepo: pr.headRepo, headBranch: pr.headRefName };
  const rec = readRecord(identityKey(identity));
  const reviewedHead = rec && (rec.status === "passed" || rec.status === "overridden") ? rec.reviewedFingerprint?.split(":")[0] ?? null : null;
  const fix = reviewedHead
    ? `; merge with --match-head-commit ${reviewedHead}`
    : `; PR #${n} has no passed review against its current base: run the review-loop for it first`;
  const bind = target.bind;
  if (target.input) return deny("pr_merge_unbound", `with --input, gh sends -f/-F fields as query parameters, so the sha field does not bind the head; drop --input and pass -f sha=<reviewed-sha>${fix}`);
  if (bind === null || !SHA.test(bind)) return deny("pr_merge_unbound", `the merge must name the reviewed head commit${fix}`);
  if (bind !== reviewedHead) return deny("pr_merge_unbound", `commit ${short(bind)} has no passed review for PR #${n}${fix}`);
  if (pr.headRefOid !== bind) return deny("pr_merge_unbound", `PR #${n}'s head moved to ${short(pr.headRefOid)} after the review of ${short(bind)}; run the review-loop for the new head first`);

  const baseTip = await ghBranchSha(repo, pr.baseRefName, root, { notFound: UNVERIFIABLE, failed: UNVERIFIABLE }, deadlineAt);
  // A fetch must end inside the budget and leave room for the re-check.
  const fetch = async (/** @type {string} */ slug, /** @type {string} */ branch) => {
    const timeoutMs = deadlineAt - Date.now() - RECHECK_RESERVE_MS;
    if (timeoutMs <= 0) throw new ReviewLoopError(UNVERIFIABLE, "no time left to fetch");
    await fetchExactRef(root, await fetchSource(root, slug, deadlineAt), branch, { timeoutMs });
  };
  if (!(await commitExists(root, baseTip, deadlineAt))) await fetch(repo, pr.baseRefName);
  if (!(await commitExists(root, bind, deadlineAt))) await fetch(pr.headRepo, pr.headRefName);
  const v = await mergeBaseValidity(root, bind, baseTip, deadlineAt);
  if (!v.ok) return deny(UNVERIFIABLE, `the merge-base of ${short(bind)} with PR #${n}'s base can't be computed (${v.reason})`);
  if (!isClearedAt(identity, `${bind}:${v.mergeBase}`)) {
    return deny("pr_merge_unbound", `commit ${short(bind)} was reviewed against a different base than PR #${n}'s current one; run the review-loop for PR #${n} again`);
  }

  if (pr.state === "MERGED") return deny("pr_merge_not_open", `PR #${n} is already merged`);
  if (pr.state !== "OPEN") return deny("pr_merge_not_open", `PR #${n} is closed; reopen it before merging`);
  if (pr.isDraft) return deny("pr_merge_not_open", `PR #${n} is a draft; mark it ready (gh pr ready ${n}) before merging`);

  // GitHub's rejection of a stale --match-head-commit (probe P7a) said "Base branch was modified", which does not prove
  // the head binding: so the head is re-read here, as the last step before allowing.
  const again = await ghPrView(repo, n, root, deadlineAt);
  if (!again) return deny(UNVERIFIABLE, `could not re-read PR #${n} right before the merge; retry the merge`);
  if (again.headRefOid !== bind) return deny("pr_merge_unbound", `PR #${n}'s head moved to ${short(again.headRefOid)} during the gate's check; run the review-loop for the new head first`);
  if (again.baseRefName !== pr.baseRefName || again.headRepo !== pr.headRepo || again.headRefName !== pr.headRefName) {
    return deny("pr_merge_unbound", `PR #${n} was retargeted during the gate's check; run the review-loop for it against its new base`);
  }
  const note = target.admin ? `⚠ review-loop: --admin bypasses branch protection, including a required review-loop/<base> check; PR #${n} is merged on the gate's check of ${short(bind)} only` : "";
  return { decision: "allow", code: "reviewed", message: note, gate: "merge" };
}
