#!/usr/bin/env node
// README exit-code and troubleshooting tables are generated from plugin/engine/lib/codes.mjs (spec §8.3).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODES, CLI_EXIT, exitFor } from "../plugin/engine/lib/codes.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** @type {Record<keyof typeof CLI_EXIT, string>} */
const EXIT_TEXT = {
  ok: "success",
  user_action: "needs your action (see the troubleshooting table)",
  usage: "wrong command or flag",
  cancelled: "you cancelled (Ctrl-C or answered no)",
  internal: "internal error — please report a bug"
};

/**
 * One GFM table cell. Pipes are escaped everywhere (GFM splits cells before parsing code spans); `<` and `>` only
 * outside code spans, so a placeholder like `<date>` in prose isn't swallowed as an HTML tag.
 * @param {string} s
 */
const cell = (s) => s.split("`").map((part, i) => (i % 2 ? part : part.replaceAll("<", "&lt;").replaceAll(">", "&gt;")).replaceAll("|", "\\|")).join("`");

export function exitTable() {
  const rows = Object.entries(CLI_EXIT).map(([k, v]) => `| ${v} | \`${k}\` | ${EXIT_TEXT[/** @type {keyof typeof CLI_EXIT} */ (k)]} |`);
  return ["| Exit | Category | Meaning |", "|---|---|---|", ...rows].join("\n");
}

/** Every code with a remedy, including `setup_complete_unverified` (exit 0, but it tells you what to run next). */
export function troubleshootingTable() {
  const rows = Object.entries(CODES)
    .filter(([, m]) => m.remedy !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, m]) => `| \`${c}\` | ${exitFor(c)} | ${cell(m.remedy)} | ${(m.details ?? []).map((d) => `\`${d}\``).join(", ")} |`);
  return ["| Code | Exit | What to do | Details |", "|---|---|---|---|", ...rows].join("\n");
}

/** Every code with per-detail remedies (today `live_check_failed`): one row per detail. */
export function detailTable() {
  const rows = Object.entries(CODES)
    .filter(([, m]) => m.detailRemedies)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([c, m]) => Object.entries(m.detailRemedies ?? {}).map(([d, r]) => `| \`${c}\` | \`${d}\` | ${cell(r)} |`));
  return ["| Code | Detail | What to do |", "|---|---|---|", ...rows].join("\n");
}

/**
 * Replace what lies between one marker pair. Adjacent markers (an empty block) work on the first run (ruling R-D31).
 * A replacer function, so a `$` in a remedy is never read as a replacement pattern.
 * @param {string} text @param {string} name @param {string} body @returns {string | null} null when the markers are missing
 */
export function splice(text, name, body) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) return null;
  return text.replace(re, (_m, start, end) => `${start}\n${body}\n${end}`);
}

/** @param {string} msg @returns {number} */
function usage(msg) {
  process.stderr.write(`gen-readme-tables: ${msg}\nusage: gen-readme-tables.mjs [--check] [--readme <path>]\n`);
  return 2;
}

/** @param {string[]} args @returns {number} */
function main(args) {
  let check = false;
  let readme = path.join(ROOT, "README.md");
  let readmeSet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check" && !check) check = true;
    else if (a === "--readme" && !readmeSet) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) return usage("--readme needs a file path");
      readme = path.resolve(v);
      readmeSet = true;
    } else return usage(`unknown or repeated argument ${JSON.stringify(a.slice(0, 40))}`);
  }
  let before;
  try {
    before = fs.readFileSync(readme, "utf8");
  } catch (err) {
    return usage(`cannot read ${readme} (${err instanceof Error && "code" in err ? String(err.code) : "error"})`);
  }
  let after = before;
  for (const [name, body] of [["exit-codes", exitTable()], ["troubleshooting", troubleshootingTable()], ["live-check", detailTable()]]) {
    const next = splice(after, name, body);
    if (next === null) {
      process.stdout.write(`README is missing the ${name} markers\n`);
      return 1;
    }
    after = next;
  }
  if (check) {
    if (after !== before) {
      process.stdout.write("README tables are stale: run `node scripts/gen-readme-tables.mjs`\n");
      return 1;
    }
    process.stdout.write("README tables are current\n");
    return 0;
  }
  if (after !== before) fs.writeFileSync(readme, after);
  process.stdout.write("README tables written\n");
  return 0;
}

const isMain = (() => { try { return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
// Not process.exit(): on macOS a stdout pipe is asynchronous, and an immediate exit truncates what was written.
if (isMain) process.exitCode = main(process.argv.slice(2));
