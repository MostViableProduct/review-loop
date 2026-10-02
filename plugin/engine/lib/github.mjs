import { run } from "./proc.mjs";
import { ReviewLoopError } from "./errors.mjs";

const GH_TIMEOUT_MS = 7_000;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** @param {string} slug */
export function assertSlug(slug) {
  if (!SLUG.test(slug)) throw new ReviewLoopError("pr_base_repo_ambiguous", `not an owner/repo: ${JSON.stringify(slug)}`);
  return slug.toLowerCase();
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeoutMs]
 */
async function gh(args, cwd, timeoutMs = GH_TIMEOUT_MS) {
  return run("gh", args, { cwd, timeoutMs, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
}

/**
 * A gh call that never rejects: a missing binary, an oversized output or an exhausted deadline all read as a failed call
 * (code null), so callers on a fail-closed path take their "unavailable" branch instead of crashing the hook.
 * @param {string[]} args @param {string} cwd @param {number} [deadlineAt] epoch ms shared by every call of one evaluation
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
async function ghSafe(args, cwd, deadlineAt) {
  const left = deadlineAt === undefined ? GH_TIMEOUT_MS : Math.min(GH_TIMEOUT_MS, deadlineAt - Date.now());
  if (left <= 0) return { code: null, stdout: "", stderr: "", timedOut: true };
  try {
    return await run("gh", args, { cwd, timeoutMs: left, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  } catch {
    return { code: null, stdout: "", stderr: "", timedOut: false };
  }
}

/**
 * False only when the gh binary cannot be spawned at all. Bounded by the caller's deadline; with none left the answer is
 * unknown, which reads as installed (the caller reports the exhausted budget instead).
 * @param {string} cwd @param {number} [deadlineAt]
 */
export async function ghInstalled(cwd, deadlineAt) {
  const left = deadlineAt === undefined ? 3_000 : Math.min(3_000, deadlineAt - Date.now());
  if (left <= 0) return true;
  try {
    await run("gh", ["--version"], { cwd, timeoutMs: left, env: process.env });
    return true;
  } catch (err) {
    return !(err instanceof ReviewLoopError && err.code === "spawn_failed");
  }
}

/** The repo `gh` itself uses for PRs when no -R is given. @param {string} cwd @param {number} [deadlineAt] */
export async function ghDefaultRepo(cwd, deadlineAt) {
  const r = await ghSafe(["repo", "set-default", "--view"], cwd, deadlineAt);
  const out = r.stdout.trim();
  return r.code === 0 && SLUG.test(out) ? out.toLowerCase() : null;
}

/** @param {string} slug @param {string} cwd @param {string} failCode */
export async function ghDefaultBranch(slug, cwd, failCode) {
  const r = await gh(["api", `repos/${slug}`, "--jq", ".default_branch"], cwd);
  const out = r.stdout.trim();
  if (r.timedOut || r.code !== 0 || !out) throw new ReviewLoopError(failCode, `could not resolve the default branch of ${slug} from GitHub`);
  return out;
}

/**
 * The branch tip as GitHub has it right now — never a local ref.
 * @param {string} slug
 * @param {string} branch
 * @param {string} cwd
 * @param {{ notFound: string, failed: string }} codes
 * @param {number} [deadlineAt] epoch ms shared by every call of one evaluation; none left → codes.failed
 */
export async function ghBranchSha(slug, branch, cwd, codes, deadlineAt) {
  const refPath = branch.split("/").map(encodeURIComponent).join("/");
  const left = deadlineAt === undefined ? GH_TIMEOUT_MS : Math.min(GH_TIMEOUT_MS, deadlineAt - Date.now());
  if (left <= 0) throw new ReviewLoopError(codes.failed, `could not read ${slug}:${branch} from GitHub (time budget exhausted)`);
  const r = await gh(["api", `repos/${slug}/git/ref/heads/${refPath}`, "--jq", ".object.sha"], cwd, left);
  const out = r.stdout.trim();
  if (r.code === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(out)) return out;
  if (!r.timedOut && /HTTP 404|Not Found/i.test(r.stderr + r.stdout)) {
    throw new ReviewLoopError(codes.notFound, `${slug}:${branch} does not exist on GitHub`);
  }
  throw new ReviewLoopError(codes.failed, `could not read ${slug}:${branch} from GitHub${r.timedOut ? " (timed out)" : ""}`);
}

export const PR_LIST_LIMIT = 10;
const PR_FIELDS = "headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,state";

/** @param {unknown} v */
function parsePr(v) {
  if (typeof v !== "object" || v === null) return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  const owner = /** @type {{ login?: unknown } | undefined} */ (o.headRepositoryOwner)?.login;
  const name = /** @type {{ name?: unknown } | undefined} */ (o.headRepository)?.name;
  const head = typeof owner === "string" && owner && typeof name === "string" && name ? `${owner}/${name}`.toLowerCase() : null;
  if (typeof o.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(o.headRefOid) || typeof o.baseRefName !== "string" || typeof o.headRefName !== "string" || !head) return null;
  return { number: typeof o.number === "number" ? o.number : null, headRefOid: o.headRefOid, baseRefName: o.baseRefName, headRefName: o.headRefName, headRepo: head, isDraft: o.isDraft === true, state: String(o.state) };
}

/** @param {string} slug @param {number} n @param {string} cwd @param {number} [deadlineAt] */
export async function ghPrView(slug, n, cwd, deadlineAt) {
  const r = await ghSafe(["pr", "view", String(n), "--repo", slug, "--json", PR_FIELDS], cwd, deadlineAt);
  if (r.code !== 0) return null;
  try {
    return parsePr(JSON.parse(r.stdout));
  } catch {
    return null;
  }
}

/**
 * The OPEN PRs whose head branch is `branch`, at most `PR_LIST_LIMIT`; the caller filters by owner and base. Open only:
 * a just-created PR is open, and an old closed or merged PR of a reused branch name must never stand in for it.
 * null = the lookup failed.
 * @param {string} slug @param {string} branch @param {string} cwd @param {number} [deadlineAt]
 */
export async function ghPrListByHead(slug, branch, cwd, deadlineAt) {
  const r = await ghSafe(["pr", "list", "--repo", slug, "--head", branch, "--state", "open", "--limit", String(PR_LIST_LIMIT), "--json", `number,${PR_FIELDS}`], cwd, deadlineAt);
  if (r.code !== 0) return null;
  try {
    const list = JSON.parse(r.stdout);
    if (!Array.isArray(list)) return null;
    const prs = list.map(parsePr);
    return prs.every((x) => x !== null && x.number !== null) ? /** @type {NonNullable<ReturnType<typeof parsePr>>[]} */ (prs) : null;
  } catch {
    return null;
  }
}

/** Convert to draft, then read it back: a plan without draft support "succeeds" without converting. @param {string} slug @param {number} n @param {string} cwd @param {number} [deadlineAt] */
export async function ghPrDraft(slug, n, cwd, deadlineAt) {
  await ghSafe(["pr", "ready", String(n), "--repo", slug, "--undo"], cwd, deadlineAt);
  const r = await ghSafe(["pr", "view", String(n), "--repo", slug, "--json", "isDraft", "--jq", ".isDraft"], cwd, deadlineAt);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** @param {string} slug @param {number} n @param {string} cwd @param {string} comment @param {number} [deadlineAt] */
export async function ghPrClose(slug, n, cwd, comment, deadlineAt) {
  await ghSafe(["pr", "close", String(n), "--repo", slug, "--comment", comment], cwd, deadlineAt);
  const r = await ghSafe(["pr", "view", String(n), "--repo", slug, "--json", "state", "--jq", ".state"], cwd, deadlineAt);
  return r.code === 0 && r.stdout.trim() === "CLOSED";
}
