import os from "node:os";
import path from "node:path";

// Directory patterns win over suffix patterns, so docs/plans/x-design.md is a plan.
const SPEC_DIR = /(^|\/)specs\/.+\.md$/i;
const PLAN_DIR = /(^|\/)plans\/.+\.md$/i;
const SPEC_SUFFIX = /-(design|spec)\.md$/i;
const PLAN_SUFFIX = /-plan\.md$/i;
const DOC = /\.(md|mdx|txt)$/i;

/** Paths (relative to the repo root) that are harness/tooling state, never "implementation". */
export const IMPL_EXCLUDED_PREFIXES = Object.freeze([".claude/", "graphify-out/", ".remember/"]);

export const CLAUDE_PLANS_DIR = path.join(os.homedir(), ".claude", "plans");

/**
 * @param {string} relPath POSIX path relative to the repo root
 * @returns {"spec" | "plan" | "doc" | "excluded" | "impl"}
 */
export function classifyRepoPath(relPath) {
  const p = relPath.replace(/\\/g, "/");
  if (IMPL_EXCLUDED_PREFIXES.some((pre) => p.startsWith(pre))) return "excluded";
  if (PLAN_DIR.test(p)) return "plan";
  if (SPEC_DIR.test(p)) return "spec";
  if (PLAN_SUFFIX.test(p)) return "plan";
  if (SPEC_SUFFIX.test(p)) return "spec";
  if (DOC.test(p)) return "doc";
  return "impl";
}

/**
 * Classify an absolute path that may live outside any repo (e.g. ~/.claude/plans/*.md).
 * @param {string} absPath
 * @param {string | null} repoRoot
 * @returns {"spec" | "plan" | "doc" | "excluded" | "impl" | null}
 */
export function classifyAbsolutePath(absPath, repoRoot) {
  if (path.dirname(absPath) === CLAUDE_PLANS_DIR && absPath.toLowerCase().endsWith(".md")) return "plan";
  if (repoRoot && (absPath === repoRoot || absPath.startsWith(repoRoot + path.sep))) {
    return classifyRepoPath(path.relative(repoRoot, absPath));
  }
  const base = path.basename(absPath);
  if (PLAN_SUFFIX.test(base) || PLAN_DIR.test(absPath)) return "plan";
  if (SPEC_SUFFIX.test(base) || SPEC_DIR.test(absPath)) return "spec";
  return null;
}

/** Pathspecs that exclude everything that is not implementation from a `git diff`. */
export function implExcludePathspecs() {
  return [
    // icase: DOC is /i, so README.MD is a doc to the classifier and must be one to git too.
    ":(exclude,glob,icase)**/*.md",
    ":(exclude,glob,icase)**/*.mdx",
    ":(exclude,glob,icase)**/*.txt",
    ...IMPL_EXCLUDED_PREFIXES.map((p) => `:(exclude,glob)${p}**`)
  ];
}
