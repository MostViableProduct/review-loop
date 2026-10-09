import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { splice, eventsTable } from "../../scripts/gen-readme-tables.mjs";
import { SCHEMA } from "../../plugin/engine/lib/events.mjs";
import { CODES, EVENT_CATALOG } from "../../plugin/engine/lib/codes.mjs";
import { MIN_CLAUDE } from "../../cli/lib/preflight.mjs";

const GEN = path.resolve("scripts/gen-readme-tables.mjs");
const README = fs.readFileSync("README.md", "utf8");
// The user docs are split by reader: the generated tables live in TROUBLESHOOTING, the gate's limits in SECURITY.
const TROUBLE = fs.readFileSync("docs/TROUBLESHOOTING.md", "utf8");
const SECURITY = fs.readFileSync("docs/SECURITY.md", "utf8");
const EVENTS = fs.readFileSync("docs/EVENTS.md", "utf8");
const CONTRIBUTING = fs.readFileSync("CONTRIBUTING.md", "utf8");
const gen = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [GEN, ...a], { encoding: "utf8" });

test("T-OBS-8 (+): the committed docs/TROUBLESHOOTING.md generated tables are current", () => {
  const r = gen("--check");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("T-OBS-8 (−): a hand-edited remedy fails --check", () => {
  const start = TROUBLE.indexOf("<!-- troubleshooting:start -->");
  const end = TROUBLE.indexOf("<!-- troubleshooting:end -->");
  const block = TROUBLE.slice(start, end);
  assert.ok(block.includes("brew install node"), "the troubleshooting block carries node_missing's remedy");
  const copy = path.join(tmpDir(), "TROUBLESHOOTING.md");
  fs.writeFileSync(copy, TROUBLE.slice(0, start) + block.replace("brew install node", "brew install nodejs") + TROUBLE.slice(end));
  const r = gen("--check", "--file", copy);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /troubleshooting tables are stale/);
});

test("T-OBS-8: adjacent markers fill on the first run, and regenerating is idempotent", () => {
  const copy = path.join(tmpDir(), "TROUBLESHOOTING.md");
  fs.writeFileSync(copy, "# x\n<!-- exit-codes:start -->\n<!-- exit-codes:end -->\n<!-- troubleshooting:start --><!-- troubleshooting:end -->\n<!-- live-check:start --><!-- live-check:end -->\n");
  assert.equal(gen("--file", copy).status, 0);
  const once = fs.readFileSync(copy, "utf8");
  assert.match(once, /\| 4 \| `internal` \|/);
  assert.match(once, /\| `node_missing` \| 1 \| brew install node \|/);
  assert.match(once, /\| `live_check_failed` \| `codex_auth` \| codex login \|/);
  assert.equal(gen("--file", copy).status, 0);
  assert.equal(fs.readFileSync(copy, "utf8"), once);
  assert.equal(gen("--check", "--file", copy).status, 0);
});

test("T-OBS-8 (−): missing markers fail rather than silently passing", () => {
  const copy = path.join(tmpDir(), "TROUBLESHOOTING.md");
  fs.writeFileSync(copy, "# no markers\n");
  const r = gen("--check", "--file", copy);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing the exit-codes markers/);
  assert.equal(splice("a $& b <!-- n:start --><!-- n:end -->", "n", "$1 $&"), "a $& b <!-- n:start -->\n$1 $&\n<!-- n:end -->", "a `$` in a body is literal");
});

test("M4: docs/TROUBLESHOOTING.md lists every live-check detail with its fix, and the missing block fails --check", () => {
  for (const [d, r] of Object.entries(CODES.live_check_failed.detailRemedies ?? {})) {
    assert.ok(TROUBLE.includes(`| \`live_check_failed\` | \`${d}\` | ${r.replaceAll("<", "&lt;").replaceAll(">", "&gt;")} |`), d);
  }
  const copy = path.join(tmpDir(), "TROUBLESHOOTING.md");
  fs.writeFileSync(copy, TROUBLE.replace(/<!-- live-check:start -->[\s\S]*?<!-- live-check:end -->/, ""));
  const r = gen("--check", "--file", copy);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing the live-check markers/);
});

test("docs/EVENTS.md names the real event schema and field order", () => {
  assert.ok(EVENTS.includes(`\`${SCHEMA}\``), `EVENTS.md names ${SCHEMA}`);
  assert.ok(EVENTS.includes("`schema, ts, run_id, source, event, code, detail, exit_code, version, session_id, artifact_key, data`"));
});

test("docs/EVENTS.md lists every event type in the catalog, with its data fields (generated)", () => {
  for (const [e, spec] of Object.entries(EVENT_CATALOG)) {
    const fields = Object.keys(spec.data).map((f) => `\`${f}\``).join(", ") || "—";
    assert.ok(EVENTS.includes(`| \`${e}\` | ${spec.sources.join(", ")} | ${fields} |`), e);
  }
  assert.ok(EVENTS.includes(`<!-- events:start -->\n${eventsTable()}\n<!-- events:end -->`), "the committed table is exactly what the generator writes");
});

test("CONTRIBUTING.md states the Intel CI runner ci.yml uses, and the Rosetta fallback (spec §10.3)", () => {
  const os = /^\s*os: \[([^\]]*)\]/m.exec(fs.readFileSync(".github/workflows/ci.yml", "utf8"));
  assert.ok(os, "ci.yml has an os matrix");
  const labels = os[1].split(",").map((s) => s.trim()).filter((s) => /^macos-\d+-intel$/.test(s));
  assert.ok(labels.length > 0, "ci.yml's matrix has an Intel leg");
  for (const label of new Set(labels)) assert.ok(CONTRIBUTING.includes(`\`${label}\``), `CONTRIBUTING.md names the Intel runner ${label}`);
  assert.ok(CONTRIBUTING.includes("`arch -x86_64`"), "CONTRIBUTING.md states the Rosetta fallback");
  assert.ok(CONTRIBUTING.includes("`macos-14` (arm64)"), "CONTRIBUTING.md names the arm64 runner");
  assert.ok(README.includes("Apple silicon or Intel"), "the README tells users both are supported");
});

test("docs/SECURITY.md states the marketplace is not pinned to a tag and branch protection is the control (spec §9)", () => {
  // The statement is true only while both halves hold; pinning either one must come with a SECURITY.md change.
  const source = /export const MARKETPLACE_SOURCE = "([^"]*)";/.exec(fs.readFileSync("cli/lib/plugin.mjs", "utf8"))?.[1];
  assert.ok(source !== undefined && !/[#@]/.test(source), "setup adds the marketplace without a git ref");
  const entry = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8")).plugins.find((/** @type {{ name: string }} */ p) => p.name === "review-loop");
  assert.equal(entry.source, "./plugin", "the plugin's source is a path inside the marketplace repo");
  assert.ok(SECURITY.includes("## Where plugin updates come from"));
  const flat = SECURITY.replace(/\s+/g, " ");
  assert.ok(flat.includes("the marketplace is not pinned to a tag"), "SECURITY.md says the marketplace is unpinned");
  assert.ok(flat.includes("The control is branch protection: `main` accepts changes only through a pull request with CI passing"), "SECURITY.md names branch protection as the control");
  assert.ok(README.includes("[docs/SECURITY.md](docs/SECURITY.md)"), "the README links it");
});

test("docs/SECURITY.md quotes the repo CLAUDE.md 'Outside the gated interfaces' list verbatim", () => {
  const claude = fs.readFileSync("CLAUDE.md", "utf8").split("\n");
  const at = claude.findIndex((l) => l.startsWith("- Outside the gated interfaces"));
  assert.ok(at !== -1, "CLAUDE.md still has the note");
  const items = [];
  for (let i = at + 1; i < claude.length && /^ {2}- /.test(claude[i]); i++) items.push(claude[i].replace(/^ {2}- /, ""));
  assert.ok(items.length >= 8, `found ${items.length} items`);
  for (const item of items) assert.ok(SECURITY.includes(item), `SECURITY.md is missing: ${item}`);
});

test("minor 9: bad arguments are a usage error (exit 2, no stack) and never write", () => {
  const copy = path.join(tmpDir(), "TROUBLESHOOTING.md");
  fs.writeFileSync(copy, "<!-- exit-codes:start --><!-- exit-codes:end -->\n<!-- troubleshooting:start --><!-- troubleshooting:end -->\n");
  for (const a of [["--file"], ["--check", "--file"], ["--chek", "--file", copy], ["--file", copy, "extra"], ["--file", tmpDir()], ["--check", "--check", "--file", copy], ["--file", copy, "--file", copy]]) {
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

const USER_DOCS = ["README.md", "docs/TROUBLESHOOTING.md", "docs/SECURITY.md", "docs/EVENTS.md", "CONTRIBUTING.md", "docs/RELEASE.md"];

/** GitHub's heading anchor: lowercased, punctuation other than `-` and `_` dropped, spaces to `-`. @param {string} h */
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-");

test("every relative link in the user docs reaches a file, and every #anchor a heading in it", () => {
  for (const doc of USER_DOCS) {
    const text = fs.readFileSync(doc, "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const [file, anchor] = target.split("#");
      const dest = file === "" ? doc : path.join(path.dirname(doc), file);
      assert.ok(fs.existsSync(dest), `${doc}: ${target} points at a missing file`);
      if (anchor === undefined) continue;
      const headings = fs.readFileSync(dest, "utf8").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")));
      assert.ok(headings.includes(anchor), `${doc}: ${target} has no heading #${anchor} (headings: ${headings.join(", ")})`);
    }
  }
});

test("the README explains the loop to a first-time user: what it needs, what they'll see, the words it uses, and what it costs", () => {
  const flat = README.replace(/\s+/g, " ");
  for (const h of ["## What you need", "## Install", "## What you'll see", "## Words you'll see", "## Cost and privacy", "## Common problems"]) {
    assert.ok(README.includes(`\n${h}\n`), `README has ${h}`);
  }
  for (const word of ["artifact", "round", "dimension", "page", "checkpoint", "preset", "kill switch", "pin"]) {
    assert.match(README, new RegExp(`^\\| ${word} \\| `, "m"), `the README defines "${word}"`);
  }
  assert.ok(flat.includes(`Claude Code](https://claude.com/claude-code) ${MIN_CLAUDE} or newer`), "the README names the Claude Code minimum preflight enforces");
  assert.ok(flat.includes("The checkpoint after 10 rounds is your spending limit"), "the README names the spend bound");
  assert.ok(flat.includes("`review-loop <command> --help`"), "the README points at per-command help");
});

test("the docs, the hooks and the skill call skipping review the same thing: the kill switch", () => {
  const hook = fs.readFileSync("plugin/engine/review-gate-hook.mjs", "utf8");
  const skill = fs.readFileSync("plugin/skills/review-loop/SKILL.md", "utf8");
  assert.ok(hook.includes("kill switch") && skill.includes("kill switch") && README.includes("## The kill switch"), "one name in all three");
  for (const doc of USER_DOCS) assert.doesNotMatch(fs.readFileSync(doc, "utf8"), /skip switch|off switch/i, `${doc} uses another name`);
});
