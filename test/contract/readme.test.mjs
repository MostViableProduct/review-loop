import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { splice } from "../../scripts/gen-readme-tables.mjs";
import { SCHEMA } from "../../plugin/engine/lib/events.mjs";
import { CODES } from "../../plugin/engine/lib/codes.mjs";

const GEN = path.resolve("scripts/gen-readme-tables.mjs");
const README = fs.readFileSync("README.md", "utf8");
const gen = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [GEN, ...a], { encoding: "utf8" });

test("T-OBS-8 (+): the committed README's generated tables are current", () => {
  const r = gen("--check");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("T-OBS-8 (−): a hand-edited remedy fails --check", () => {
  const start = README.indexOf("<!-- troubleshooting:start -->");
  const end = README.indexOf("<!-- troubleshooting:end -->");
  const block = README.slice(start, end);
  assert.ok(block.includes("brew install node"), "the troubleshooting block carries node_missing's remedy");
  const copy = path.join(tmpDir(), "README.md");
  fs.writeFileSync(copy, README.slice(0, start) + block.replace("brew install node", "brew install nodejs") + README.slice(end));
  const r = gen("--check", "--readme", copy);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /README tables are stale/);
});

test("T-OBS-8: adjacent markers fill on the first run, and regenerating is idempotent", () => {
  const copy = path.join(tmpDir(), "README.md");
  fs.writeFileSync(copy, "# x\n<!-- exit-codes:start -->\n<!-- exit-codes:end -->\n<!-- troubleshooting:start --><!-- troubleshooting:end -->\n<!-- live-check:start --><!-- live-check:end -->\n");
  assert.equal(gen("--readme", copy).status, 0);
  const once = fs.readFileSync(copy, "utf8");
  assert.match(once, /\| 4 \| `internal` \|/);
  assert.match(once, /\| `node_missing` \| 1 \| brew install node \|/);
  assert.match(once, /\| `live_check_failed` \| `codex_auth` \| codex login \|/);
  assert.equal(gen("--readme", copy).status, 0);
  assert.equal(fs.readFileSync(copy, "utf8"), once);
  assert.equal(gen("--check", "--readme", copy).status, 0);
});

test("T-OBS-8 (−): missing markers fail rather than silently passing", () => {
  const copy = path.join(tmpDir(), "README.md");
  fs.writeFileSync(copy, "# no markers\n");
  const r = gen("--check", "--readme", copy);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing the exit-codes markers/);
  assert.equal(splice("a $& b <!-- n:start --><!-- n:end -->", "n", "$1 $&"), "a $& b <!-- n:start -->\n$1 $&\n<!-- n:end -->", "a `$` in a body is literal");
});

test("M4: the README lists every live-check detail with its fix, and the missing block fails --check", () => {
  for (const [d, r] of Object.entries(CODES.live_check_failed.detailRemedies ?? {})) {
    assert.ok(README.includes(`| \`live_check_failed\` | \`${d}\` | ${r.replaceAll("<", "&lt;").replaceAll(">", "&gt;")} |`), d);
  }
  const copy = path.join(tmpDir(), "README.md");
  fs.writeFileSync(copy, README.replace(/<!-- live-check:start -->[\s\S]*?<!-- live-check:end -->/, ""));
  const r = gen("--check", "--readme", copy);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing the live-check markers/);
});

test("README names the real event schema and field order", () => {
  assert.ok(README.includes(`\`${SCHEMA}\``), `README names ${SCHEMA}`);
  assert.ok(README.includes("`schema, ts, run_id, source, event, code, detail, exit_code, version, session_id, artifact_key, data`"));
});

test("README states the Intel CI runner ci.yml uses, and the Rosetta fallback (spec §10.3)", () => {
  const os = /^\s*os: \[([^\]]*)\]/m.exec(fs.readFileSync(".github/workflows/ci.yml", "utf8"));
  assert.ok(os, "ci.yml has an os matrix");
  const labels = os[1].split(",").map((s) => s.trim()).filter((s) => /^macos-\d+-intel$/.test(s));
  assert.ok(labels.length > 0, "ci.yml's matrix has an Intel leg");
  for (const label of new Set(labels)) assert.ok(README.includes(`\`${label}\``), `README names the Intel runner ${label}`);
  assert.ok(README.includes("`arch -x86_64`"), "README states the Rosetta fallback");
  assert.ok(README.includes("`macos-14` (arm64)"), "README names the arm64 runner");
});

test("README states the marketplace is not pinned to a tag and branch protection is the control (spec §9)", () => {
  // The statement is true only while both halves hold; pinning either one must come with a README change.
  const source = /export const MARKETPLACE_SOURCE = "([^"]*)";/.exec(fs.readFileSync("cli/lib/plugin.mjs", "utf8"))?.[1];
  assert.ok(source !== undefined && !/[#@]/.test(source), "setup adds the marketplace without a git ref");
  const entry = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8")).plugins.find((/** @type {{ name: string }} */ p) => p.name === "review-loop");
  assert.equal(entry.source, "./plugin", "the plugin's source is a path inside the marketplace repo");
  assert.ok(README.includes("### Where plugin updates come from"));
  const flat = README.replace(/\s+/g, " ");
  assert.ok(flat.includes("the marketplace is not pinned to a tag"), "README says the marketplace is unpinned");
  assert.ok(flat.includes("The control is branch protection: `main` accepts changes only through a pull request with CI passing"), "README names branch protection as the control");
});

test("README quotes the repo CLAUDE.md 'Outside the gated interfaces' list verbatim", () => {
  const claude = fs.readFileSync("CLAUDE.md", "utf8").split("\n");
  const at = claude.findIndex((l) => l.startsWith("- Outside the gated interfaces"));
  assert.ok(at !== -1, "CLAUDE.md still has the note");
  const items = [];
  for (let i = at + 1; i < claude.length && /^ {2}- /.test(claude[i]); i++) items.push(claude[i].replace(/^ {2}- /, ""));
  assert.ok(items.length >= 8, `found ${items.length} items`);
  for (const item of items) assert.ok(README.includes(item), `README is missing: ${item}`);
});

test("minor 9: bad arguments are a usage error (exit 2, no stack) and never write", () => {
  const copy = path.join(tmpDir(), "README.md");
  fs.writeFileSync(copy, "<!-- exit-codes:start --><!-- exit-codes:end -->\n<!-- troubleshooting:start --><!-- troubleshooting:end -->\n");
  for (const a of [["--readme"], ["--check", "--readme"], ["--chek", "--readme", copy], ["--readme", copy, "extra"], ["--readme", tmpDir()], ["--check", "--check", "--readme", copy], ["--readme", copy, "--readme", copy]]) {
    const r = gen(...a);
    assert.equal(r.status, 2, a.join(" "));
    assert.match(r.stderr, /usage: gen-readme-tables\.mjs/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  }
  assert.equal(fs.readFileSync(copy, "utf8").includes("| Exit |"), false, "a misspelled --check never fell through to write mode");
});

test("L14: CLAUDE.md does not describe removed behaviour as current", () => {
  const md = fs.readFileSync("CLAUDE.md", "utf8");
  assert.doesNotMatch(md, /plugin manifest, version, dependency on `codex@openai-codex`/, "plugin.json has no dependencies (R-P4)");
  assert.doesNotMatch(md, /Task 8 removes it when it emits/, "the interim PR-gate gate.decision was removed in Task 8");
});
