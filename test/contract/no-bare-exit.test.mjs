import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// A bare process.exit() truncates piped stdout/stderr on macOS (pipes are asynchronous). The behavioural pipe tests only
// go red when that race fires; this gate pins the invariant deterministically.
const ROOTS = ["cli", "plugin", "scripts"];

// Raw-line scan, deliberately NOT a tokenizer: a regex literal holding a quote would desync any string/comment stripper
// and blank the code after it. Only whole-line comments are skipped; anything else that mentions these forms is flagged.
const FORBIDDEN = [
  /\bprocess\s*\.\s*exit\b/,
  /\bprocess\s*\[/,
  /\{[^}]*\bexit\b[^}]*\}\s*=\s*process\b/,
  /\bexit\b[^;]*\bfrom\s+["'](?:node:)?process["']/,
];

// In this file "@" stands for the word process, so the file's own source never matches a forbidden form.
const P = (s) => s.replaceAll("@", "process");

// Each entry is one exact trimmed line, never a whole file.
const ALLOWED = [
  { file: "cli/review-loop.mjs", line: P("setTimeout(() => @.exit(code), EXIT_DRAIN_MS);"), why: "exitAfterDrain: fallback timer" },
  { file: "cli/review-loop.mjs", line: P("const flushed = () => { if (--pending === 0) @.exit(code); };"), why: "exitAfterDrain: after both streams flushed" },
  { file: "scripts/sabotage-registry.mjs", line: P("{ id: \"cli-pipe-drain\", file: \"cli/review-loop.mjs\", find: \"  main(@.argv.slice(2), realIO()).then((code) => { @.exitCode = code; });\", replace: \"  main(@.argv.slice(2), realIO()).then((code) => @.exit(code));\", test: \"test/contract/no-bare-exit.test.mjs\", expect: \"no bare @.exit() in any shipped entry point or script\" },"), why: "registry row cli-pipe-drain: its find/replace text" },
  { file: "scripts/sabotage-registry.mjs", line: P("{ id: \"content-gate-list-pipe\", file: \"scripts/content-gate.mjs\", find: \"  @.exitCode = code;\", replace: \"  @.exit(code);\", test: \"test/contract/no-bare-exit.test.mjs\", expect: \"no bare @.exit() in any shipped entry point or script\" },"), why: "registry row content-gate-list-pipe: its find/replace text" },
];

export function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

export function bareExits(file, src, allowed = ALLOWED) {
  const hits = [];
  src.split("\n").forEach((line, idx) => {
    if (isCommentLine(line) || !FORBIDDEN.some((re) => re.test(line))) return;
    if (allowed.some((a) => a.file === file && a.line === line.trim())) return;
    hits.push(`${file}:${idx + 1}: ${line.trim()}`);
  });
  return hits;
}

function walk(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else if (e.name.endsWith(".mjs") || p === "plugin/bin/hook") files.push(p);
  }
  return files;
}

const shipped = ROOTS.flatMap((r) => walk(r));

test("no bare process.exit() in any shipped entry point or script", () => {
  assert.ok(shipped.length > 10, "the scan found the shipped files");
  const hits = shipped.flatMap((f) => bareExits(f, fs.readFileSync(f, "utf8")));
  assert.deepEqual(hits, [], "set process.exitCode (or use exitAfterDrain) so piped output drains");
});

test("every allowlisted line still exists in its file", () => {
  for (const a of ALLOWED) {
    const lines = fs.readFileSync(a.file, "utf8").split("\n").map((l) => l.trim());
    assert.ok(lines.includes(a.line), `${a.file}: ${a.why} not found; remove the stale allowlist entry`);
  }
});

test("the scanner flags every exit form, skips whole-line comments, and honours the allowlist", () => {
  const flagged = [
    "main().then((c) => @.exit(c));",
    "@.exit (0)",
    '@["exit"](1)',
    "@['exit'](1)",
    "const { exit } = @;",
    "const { argv, exit: quit } = @;",
    "const quit = @.exit;",
    'import { exit } from "node:@";',
    "const re = /[\"']/;\n@.exit(1);",
    "const re = /a\\/;\n@.exit(1);",
  ];
  for (const f of flagged) assert.ok(bareExits("x.mjs", P(f)).length >= 1, `must flag: ${f}`);
  const ignored = ["// @.exit(0)", "/* @.exit(1)", " * @.exit(2) */", "@.exitCode = 1;", "const { exitCode } = @;"];
  for (const f of ignored) assert.equal(bareExits("x.mjs", P(f)).length, 0, `must not flag: ${f}`);
  const a = [{ file: "x.mjs", line: P("@.exit(0);") }];
  assert.equal(bareExits("x.mjs", P("  @.exit(0);"), a).length, 0);
  assert.equal(bareExits("y.mjs", P("@.exit(0);"), a).length, 1);
});
