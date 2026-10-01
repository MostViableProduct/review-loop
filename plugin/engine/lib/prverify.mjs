import { parsePrCreate } from "./cmdparse.mjs";
import { errorCode } from "./errors.mjs";
import { PR_LIST_LIMIT, ghInstalled, ghPrClose, ghPrDraft, ghPrListByHead, ghPrView } from "./github.mjs";
import { repoRoot, currentBranch } from "./git.mjs";
import { killSwitchForSession, resolveBaseSlug } from "./prgate.mjs";
import { gateOutcome } from "./presets.mjs";
import { identityKey, readRecord } from "./state.mjs";

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_BODY = 1024 * 1024;
const MAX_MCP_TEXT = 64 * 1024;
const DEFAULT_DEADLINE_MS = 30_000;

/** @param {unknown} v @returns {Record<string, unknown>} */
const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {});

/**
 * A PostToolUse MCP response is either the tool's own object or an MCP content array (`[{type:"text", text:"<json>"}]`,
 * possibly under `content`). The real shape is unverified (no server was connected to probe it), so both are read.
 * @param {unknown} v @returns {Record<string, unknown>}
 */
function unwrapMcp(v) {
  const list = Array.isArray(v) ? v : Array.isArray(obj(v).content) ? /** @type {unknown[]} */ (obj(v).content) : null;
  if (!list) return obj(v);
  for (const item of list) {
    const o = obj(item);
    if (o.type !== "text" || typeof o.text !== "string" || o.text.length > MAX_MCP_TEXT) continue;
    try {
      return obj(JSON.parse(o.text));
    } catch {
      // Prose, not JSON: try the next part.
    }
  }
  return {};
}

/** @param {unknown} u @returns {{ repo: string, number: number } | null} */
function prUrl(u) {
  const m = typeof u === "string" ? /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/.exec(u) : null;
  return m ? { repo: m[1].toLowerCase(), number: Number(m[2]) } : null;
}

/** @param {string | null} head */
const ownerOf = (head) => (head !== null && head.includes(":") ? head.split(":")[0].toLowerCase() || null : null);

/** @param {string | null} head */
const branchOf = (head) => (head === null ? null : head.includes(":") ? head.split(/:(.*)/s)[1] : head) || null;

/**
 * What the create call said about its PR. Returns null when this call is not a PR creation. The head SHA in a create
 * response is deliberately never read: see evaluatePrVerify.
 * @param {{ toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown }} p
 * @returns {{ unresolvable: boolean, repoArgs: { repo: string | null, ghRepoEnv: string | null }, number: number | null, urlRepo: string | null, branch: string | null, headOwner: string | null, base: string | null } | null}
 */
function parseCreation(p) {
  if (p.toolName !== "Bash") {
    const i = p.toolInput;
    const repo = typeof i.owner === "string" && typeof i.repo === "string" ? `${i.owner}/${i.repo}`.toLowerCase() : null;
    const res = unwrapMcp(p.toolResponse);
    const url = prUrl(res.URL) ?? prUrl(res.url) ?? prUrl(res.html_url);
    const number = Number.isInteger(res.number) ? /** @type {number} */ (res.number) : url?.number ?? null;
    return { unresolvable: false, repoArgs: { repo, ghRepoEnv: null }, number, urlRepo: url?.repo ?? null, branch: branchOf(typeof i.head === "string" ? i.head : null), headOwner: ownerOf(typeof i.head === "string" ? i.head : null), base: typeof i.base === "string" && i.base ? i.base : null };
  }
  const command = typeof p.toolInput.command === "string" ? p.toolInput.command : "";
  /** @type {ReturnType<typeof parsePrCreate>} */
  let args = null;
  let api = false;
  try {
    args = parsePrCreate(command);
  } catch (err) {
    // Advisory lets these through, so the hook sees them: an API create (explicit or implicit POST) is a creation whose
    // repo we read from the endpoint; anything else the parser refused is a creation we cannot resolve.
    if (errorCode(err) === "pr_via_api_unsupported") api = true;
    else return { unresolvable: true, repoArgs: { repo: null, ghRepoEnv: null }, number: null, urlRepo: null, branch: null, headOwner: null, base: null };
  }
  if (!args && !api) return null;
  const stdout = typeof obj(p.toolResponse).stdout === "string" ? /** @type {string} */ (obj(p.toolResponse).stdout) : "";
  if (api) {
    const repo = /repos\/([^/\s]+\/[^/\s]+)\/pulls/.exec(command)?.[1]?.toLowerCase() ?? null;
    const head = /(?:-f|-F|--raw-field|--field)[\s=]+head=([^\s'"]+)/.exec(command)?.[1] ?? null;
    const base = /(?:-f|-F|--raw-field|--field)[\s=]+base=([^\s'"]+)/.exec(command)?.[1] ?? null;
    let number = null;
    if (stdout.length <= MAX_BODY) {
      try {
        const n = obj(JSON.parse(stdout)).number;
        number = Number.isInteger(n) ? /** @type {number} */ (n) : null;
      } catch {
        // Not JSON: no number.
      }
    }
    return { unresolvable: false, repoArgs: { repo, ghRepoEnv: null }, number, urlRepo: null, branch: branchOf(head), headOwner: ownerOf(head), base };
  }
  const url = prUrl(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.exec(stdout)?.[0]);
  return { unresolvable: false, repoArgs: { repo: args?.repo?.toLowerCase() ?? null, ghRepoEnv: args?.ghRepoEnv ?? null }, number: url?.number ?? null, urlRepo: url?.repo ?? null, branch: branchOf(args?.head ?? null), headOwner: ownerOf(args?.head ?? null), base: args?.base ?? null };
}

/**
 * @param {{ cwd: string, session: string | null, toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown, preset: string, deadlineMs?: number }} p
 * @returns {Promise<{ output: Record<string, unknown> | null, outcome: "allowed" | "warned" | "denied" | "skipped", code: string, detail: string | null }>}
 */
export async function evaluatePrVerify(p) {
  const c = parseCreation(p);
  if (!c) return { output: null, outcome: "allowed", code: "not_pr_creation", detail: null };
  const deadlineAt = Date.now() + (p.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const soft = gateOutcome(p.preset, "prverify", true) === "warn";
  const root = await repoRoot(p.cwd, deadlineAt).catch(() => null);
  if (root) {
    // The PR gate already logged the override at PreToolUse; this hook adds only its own gate.decision.
    // A switch git cannot confirm inside the budget is not honored: verification goes on and reports the spent budget.
    if ((await killSwitchForSession(p.session, root, deadlineAt).catch(() => null)) === "on") return { output: null, outcome: "skipped", code: "kill_switch", detail: null };
  }

  /** @param {string} why @param {number | null} number */
  const unavailable = (why, number) => {
    const text = number
      ? `review-loop: could not verify PR #${number} (${why}); unreviewed PR #${number} is open until its head commit is checked — convert it to draft now`
      : `review-loop: could not identify the PR that was just created (${why}); an unreviewed PR may be open — find it and check its head commit`;
    return { output: soft ? { systemMessage: `⚠ ${text}` } : { continue: false, stopReason: text }, outcome: /** @type {"warned" | "denied"} */ (soft ? "warned" : "denied"), code: "pr_verify_unavailable", detail: null };
  };
  const failure = async () => (Date.now() >= deadlineAt ? "time budget exhausted" : (await ghInstalled(p.cwd, deadlineAt)) ? "GitHub request failed" : "gh is not installed");

  if (c.unresolvable) return unavailable("the create command could not be parsed", null);
  /** @type {string} */
  let repo;
  try {
    repo = await resolveBaseSlug(root ?? p.cwd, c.repoArgs, { deadlineAt });
  } catch {
    return unavailable("the base repository could not be determined", c.number);
  }
  if (!SLUG.test(repo)) return unavailable("the base repository could not be determined", c.number);

  // GitHub's CURRENT head is authoritative (ruling R-D15). A create response's head is only a snapshot: the branch can
  // advance between creation and this hook, so it is never compared. No current head -> fail closed.
  if (c.number !== null && c.urlRepo !== null && c.urlRepo !== repo) return unavailable("the PR URL names a different repository", null);
  let number = c.number;
  let pr = null;
  if (number !== null) {
    pr = await ghPrView(repo, number, p.cwd, deadlineAt);
    if (!pr) return unavailable(await failure(), number);
  } else {
    const branch = c.branch ?? (root ? await currentBranch(root).catch(() => null) : null);
    if (!branch) return unavailable("no PR number in the create response", null);
    const listed = await ghPrListByHead(repo, branch, p.cwd, deadlineAt);
    if (listed === null) return unavailable(await failure(), null);
    if (listed.length >= PR_LIST_LIMIT) return unavailable("too many open PRs share the head branch name", null);
    // The head's owner is the input's `owner:` prefix, else the base owner. Never filter by the reviewed SHA: that would
    // be circular (the point is to compare it).
    const owner = c.headOwner ?? repo.split("/")[0];
    const found = listed.filter((x) => x.headRepo.split("/")[0] === owner && (c.base === null || x.baseRefName === c.base));
    if (found.length !== 1) return unavailable(found.length === 0 ? "no open PR found for the head branch" : "several open PRs match the head branch", null);
    pr = found[0];
    number = pr.number;
  }
  const head = pr.headRefOid;
  const identity = { kind: /** @type {const} */ ("branch"), baseRepo: repo, baseBranch: pr.baseRefName, headRepo: pr.headRepo, headBranch: pr.headRefName };
  const rec = readRecord(identityKey(identity));
  const reviewedHead = rec && (rec.status === "passed" || rec.status === "overridden") ? rec.reviewedFingerprint?.split(":")[0] ?? null : null;
  if (reviewedHead === head) return { output: null, outcome: "allowed", code: "reviewed", detail: null };

  const short = (/** @type {string | null} */ s) => (s ? s.slice(0, 7) : "none");
  const what = `PR #${number} head ${short(head)} is not the reviewed ${short(reviewedHead)}`;
  const merged = pr.state === "MERGED";
  // Advisory never blocks and never mutates the PR (spec §5.2, AC-23): it warns only.
  if (soft) {
    return { output: { systemMessage: `⚠ review-loop (Advisory): ${what}${merged ? " and it is already MERGED" : ""}` }, outcome: "warned", code: "pr_created_head_unreviewed", detail: null };
  }
  // A merged PR cannot be drafted or closed, so nothing here can contain it: report it loudly as uncontained, never "open".
  // A closed or already-draft PR is already contained and needs no mutation.
  let detail = "uncontained";
  if (!merged) {
    if (pr.state === "CLOSED") detail = "closed";
    else if (pr.isDraft) detail = "drafted";
    else if (await ghPrDraft(repo, number, p.cwd, deadlineAt)) detail = "drafted";
    else if (await ghPrClose(repo, number, p.cwd, `review-loop: head ${short(head)} was not reviewed`, deadlineAt)) detail = "closed";
  }
  const did = merged
    ? `It was MERGED unreviewed and cannot be drafted or closed; review the merged commits and revert them as appropriate.`
    : detail === "drafted"
      ? pr.isDraft ? "It was already a draft." : "It was converted to draft."
      : detail === "closed"
        ? pr.state === "CLOSED" ? "It is already closed." : "It was closed."
        : `It could not be drafted or closed — PR #${number} is open and unreviewed; convert it to draft now.`;
  return {
    output: { continue: false, stopReason: `review-loop: ${what}. ${did}${merged ? "" : " Re-run the review-loop for this PR before marking it ready."}` },
    outcome: "denied", code: "pr_created_head_unreviewed", detail
  };
}
