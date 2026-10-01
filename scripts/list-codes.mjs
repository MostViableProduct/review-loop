// Every code literal the source can emit, extracted from the syntactic positions codes appear in.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LITERAL = /"([a-z][a-z0-9_]*)"/g;

/** Codes written as a bare literal in a fixed syntactic position. */
const PATTERNS = [
  /\b(?:ReviewLoopError|CliError)\(\s*"([a-z][a-z0-9_]*)"/g,
  /\b(?:missing|symlink|linkedParent|tooLarge|notFile|notFound|failed|failCode|limitCode|tooLargeCode)\s*:\s*"([a-z][a-z0-9_]*)"/g,
  /\b(?:failCode|limitCode|tooLargeCode)\s*=\s*"([a-z][a-z0-9_]*)"/g,
  /\bcode\s*:\s*"([a-z][a-z0-9_]*)"/g,
  /\b(?:deny|fail|stop|warnOnly)\(\s*"([a-z][a-z0-9_]*)"/g
];

/**
 * Codes computed in place: `new ReviewLoopError(codes.x ?? "fallback", …)`, a ternary between two codes, or the
 * argument of a helper that logs a code. Every string literal inside the code argument is a code the source can emit.
 */
const ARGUMENT_PATTERNS = [/\b(?:ReviewLoopError|CliError)\(([^,\n]*),/g, /\b(?:lockInvalid|inputFailure)\(([^\n]*)\)/g];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.name.endsWith(".mjs") ? [p] : [];
  });
}

/** @param {string} [root] */
export function listCodes(root = process.cwd()) {
  const found = new Set();
  for (const f of [...walk(path.join(root, "plugin")), ...walk(path.join(root, "cli"))]) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of PATTERNS) for (const m of text.matchAll(re)) found.add(m[1]);
    for (const re of ARGUMENT_PATTERNS) for (const m of text.matchAll(re)) for (const lit of m[1].matchAll(LITERAL)) found.add(lit[1]);
  }
  return [...found].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(listCodes().join("\n"));
