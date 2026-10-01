import crypto from "node:crypto";
import { readConfig } from "./config.mjs";
import { emitEvent, PACKAGE_VERSION } from "./events.mjs";
import { safeReadFile } from "./fsutil.mjs";
import { run } from "./proc.mjs";
import { resolveRubricPath } from "./rubric.mjs";
import { PASS_TENTHS } from "./scoring.mjs";

/** @param {string} baseBranch */
export function statusContext(baseBranch) {
  return `review-loop/${encodeURIComponent(baseBranch)}`;
}

/** Binds an approval to the policy it was given under (spec §7.1: approvals are not revoked retroactively). */
export function policyFingerprint() {
  let rubric = "";
  try {
    rubric = safeReadFile(resolveRubricPath(), 256 * 1024, { symlink: "rubric_symlink_rejected" }).toString("utf8");
  } catch {
    rubric = "<unreadable>";
  }
  const majorMinor = PACKAGE_VERSION.split(".").slice(0, 2).join(".");
  return crypto.createHash("sha256").update([rubric, readConfig().config.preset, (PASS_TENTHS / 10).toFixed(1), `review-loop ${majorMinor}`].join("\0")).digest("hex").slice(0, 12);
}

/**
 * Never throws and never fails a round: a failed post is logged and surfaced by doctor.
 * @param {{ slug: string, sha: string, baseBranch: string, state: "success" | "failure", description: string, cwd: string, session: string | null, key: string | null }} p
 */
export async function postVerdict(p) {
  const suffix = ` · policy ${policyFingerprint()}`;
  const description = p.description.slice(0, 140 - suffix.length) + suffix;
  try {
    const r = await run("gh", ["api", "-X", "POST", `repos/${p.slug}/statuses/${p.sha}`, "-f", `state=${p.state}`, "-f", `context=${statusContext(p.baseBranch)}`, "-f", `description=${description}`], {
      cwd: p.cwd, timeoutMs: 7_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }
    });
    if (r.code === 0) return true;
  } catch {
    // Treated as a failed post below.
  }
  emitEvent({ source: "round", event: "hook.error", code: "status_post_failed", session_id: p.session, artifact_key: p.key, data: { stage: "status_post_failed" } });
  return false;
}
