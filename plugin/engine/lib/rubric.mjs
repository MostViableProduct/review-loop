import { fileURLToPath } from "node:url";
import { readConfig } from "./config.mjs";
import { safeReadFile } from "./fsutil.mjs";
import { ReviewLoopError } from "./errors.mjs";
import { DIMENSIONS } from "./scoring.mjs";

const PLUGIN_DEFAULT_RUBRIC = fileURLToPath(new URL("../../rubric/default.md", import.meta.url));

export function resolveRubricPath() {
  return readConfig().config.rubricPath ?? PLUGIN_DEFAULT_RUBRIC;
}

/**
 * The rubric sent to Codex is the "Dimension definitions & boundaries" section of the configured rubric file.
 * Fails closed if any of the 11 dimensions has disappeared from it.
 * @param {string} [rulesPath]
 */
export function loadRubricSection(rulesPath = resolveRubricPath()) {
  const text = safeReadFile(rulesPath, 256 * 1024, { missing: "rubric_source_missing", symlink: "rubric_symlink_rejected" }).toString("utf8");
  const start = text.indexOf("## Dimension definitions & boundaries");
  if (start === -1) throw new ReviewLoopError("rubric_source_mismatch", `${rulesPath}: "Dimension definitions & boundaries" section not found`);
  const next = text.indexOf("\n## ", start + 4);
  const section = text.slice(start, next === -1 ? undefined : next).trim();
  const missing = DIMENSIONS.filter((d) => !section.includes(`**${d}**`));
  if (missing.length) throw new ReviewLoopError("rubric_source_mismatch", `${rulesPath}: dimensions missing from rubric: ${missing.join(", ")}`);
  return section;
}

/**
 * @typedef {{ title: string, file?: string, reason: string }} Dispute
 * @param {{ kind: string, label: string, projectRoot: string | null, instructions: string, disputes: Dispute[], rubric: string }} p
 */
export function buildFocus(p) {
  const disputeBlock = p.disputes.length
    ? p.disputes.map((d) => `- "${d.title}"${d.file ? ` (${d.file})` : ""} — author's rationale: ${d.reason}`).join("\n")
    : "(none)";
  return [
    `ARTIFACT UNDER REVIEW (${p.kind}): ${p.label}`,
    p.instructions,
    p.projectRoot ? `PROJECT ROOT (read-only context; read whatever you need to verify claims): ${p.projectRoot}` : null,
    "",
    "RUBRIC. Assess the artifact against ALL 11 dimensions below; do not skip any.",
    'Prefix EVERY finding title with exactly one dimension in square brackets, e.g. "[Reliability] retry is unbounded".',
    "Severity: critical = exploitable security / data loss / irreversible harm / core deliverable non-functional;",
    "high = a stated requirement unmet or a wrong result on a real path; medium = a real but bounded or edge-triggered defect;",
    "low = defensive, polish, or rare/bounded with no user-visible harm. Omit pure style/naming nits entirely.",
    "",
    p.rubric,
    "",
    "PRIOR DISPUTES. The author contends these earlier findings are not defects. Drop a finding if the rationale holds;",
    "re-raise it (same title) only with new, concrete evidence:",
    disputeBlock
  ]
    .filter((l) => l !== null)
    .join("\n");
}
