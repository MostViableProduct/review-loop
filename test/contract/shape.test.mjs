// test/contract/shape.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const R = (p) => path.join(process.cwd(), p);
const json = (p) => JSON.parse(fs.readFileSync(R(p), "utf8"));

test("T-SHAPE-1: 9 hook entries with exact matchers, modes and timeouts", () => {
  const h = json("plugin/hooks/hooks.json").hooks;
  const flat = Object.entries(h).flatMap(([ev, groups]) => groups.map((g) => `${ev}|${g.matcher ?? ""}|${g.hooks[0].command.split(" ").pop()}|${g.hooks[0].timeout}`));
  assert.deepEqual(flat.sort(), [
    "PostToolUse|Bash|prverify|40",
    "PostToolUse|Write|Edit|MultiEdit|NotebookEdit|track|5",
    "PostToolUse|mcp__.*__create_pull_request|prverify|40",
    "PreToolUse|Bash|pr|40",
    "PreToolUse|mcp__.*__create_pull_request|pr|40",
    "PreToolUse|mcp__.*__merge_pull_request|pr|40",
    "SessionStart||session|20",
    "Stop||stop|20",
    "UserPromptSubmit||prompt|5"
  ].sort());
});

test("T-SHAPE-1b: every hooks.json mode is handled by the engine and vice versa", () => {
  const modes = new Set(Object.values(json("plugin/hooks/hooks.json").hooks).flat().map((g) => g.hooks[0].command.split(" ").pop()));
  const engine = fs.readFileSync(R("plugin/engine/review-gate-hook.mjs"), "utf8");
  const handled = new Set([...engine.matchAll(/MODE === "([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...modes].sort(), [...handled].sort());
});

test("T-SHAPE-2: commands use ${CLAUDE_PLUGIN_ROOT} only", () => {
  for (const g of Object.values(json("plugin/hooks/hooks.json").hooks).flat()) assert.match(g.hooks[0].command, /^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/hook" [a-z]+$/);
});

test("T-SHAPE-3: plugin/ never imports cli/", () => {
  const r = spawnSync("grep", ["-rEn", "from ['\"](\\.\\./)+cli/", R("plugin")], { encoding: "utf8" });
  assert.equal(r.stdout, "");
});

test("T-SHAPE-4: versions agree (package, plugin, marketplace, shim)", () => {
  const v = json("package.json").version;
  assert.equal(json("plugin/.claude-plugin/plugin.json").version, v);
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].version, v);
  assert.match(fs.readFileSync(R("plugin/bin/hook"), "utf8"), new RegExp(`^VERSION="${v.replaceAll(".", "\\.")}"$`, "m"));
});

test("T-SHAPE-5: hook text names the namespaced skill", () => {
  const engine = fs.readFileSync(R("plugin/engine/review-gate-hook.mjs"), "utf8");
  assert.ok(engine.includes("review-loop:review-loop skill"));
  assert.ok(!/Invoke the review-loop skill/.test(engine));
  const r = spawnSync("sh", ["-c", "grep -rn 'review-loop skill' plugin/ | grep -v 'review-loop:review-loop skill'"], { encoding: "utf8", cwd: process.cwd() });
  assert.equal(r.stdout, "");
});

test("claude plugin validate --strict passes on plugin and marketplace (opt-in: REVIEW_LOOP_VALIDATE=1; skipped without claude)", (t) => {
  if (process.env.REVIEW_LOOP_VALIDATE !== "1") return t.skip("set REVIEW_LOOP_VALIDATE=1 to run");
  if (spawnSync("sh", ["-c", "command -v claude"]).status !== 0) return t.skip("claude not installed");
  for (const target of ["plugin", "."]) {
    const r = spawnSync("claude", ["plugin", "validate", "--strict", R(target)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${target}: ${r.stdout}${r.stderr}`);
  }
});

test("R-P4: plugin.json declares no dependencies (an unsatisfied dependency stops the plugin loading, disabling every hook)", () => {
  assert.ok(!("dependencies" in json("plugin/.claude-plugin/plugin.json")));
});

test("PACKAGE_VERSION reads the real plugin.json version", async () => {
  const { PACKAGE_VERSION } = await import("../../plugin/engine/lib/events.mjs");
  assert.equal(PACKAGE_VERSION, json("plugin/.claude-plugin/plugin.json").version);
});
