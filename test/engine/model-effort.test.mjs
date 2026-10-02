import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { codexDefaults, effectiveCodex, companionArgs } from "../../plugin/engine/lib/codexcfg.mjs";
import { runCompanion, stopCompanionBroker } from "../../plugin/engine/lib/pin.mjs";
import { CODES } from "../../plugin/engine/lib/codes.mjs";

/** @param {{ model: string | null, effort: string | null }} cfg */
function isolate(cfg) {
  const home = tmpDir();
  const codexHome = path.join(home, "codex");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "other"\n');
  Object.assign(process.env, { HOME: home, CODEX_HOME: codexHome, REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
  delete process.env.CLAUDE_PLUGIN_DATA;
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG ?? "", JSON.stringify({ version: 1, preset: "default", codex: cfg, rubricPath: null, events: { path: null } }));
  return codexHome;
}
const treeHash = (/** @type {string} */ dir) =>
  crypto.createHash("sha256").update(fs.readdirSync(dir).sort().map((n) => n + fs.readFileSync(path.join(dir, n))).join("|")).digest("hex");

test("codexDefaults reads top-level keys only, read-only", () => {
  const ch = isolate({ model: null, effort: null });
  const before = treeHash(ch);
  assert.deepEqual(codexDefaults(), { model: "gpt-6-luna", effort: "high" });
  assert.equal(treeHash(ch), before);
});

test("T-CFG-4: config wins and is recorded as source=config; null inherits", () => {
  isolate({ model: "m1", effort: "low" });
  assert.deepEqual(effectiveCodex(), { model: "m1", effort: "low", source: "config", passModel: "m1" });
  isolate({ model: null, effort: null });
  assert.deepEqual(effectiveCodex(), { model: "gpt-6-luna", effort: "high", source: "codex-inherited", passModel: null });
});

test("T-CFG-4: companion args carry --model when set and never --effort (P2: effort is display-only)", () => {
  isolate({ model: "m1", effort: "low" });
  const base = ["adversarial-review", "--wait", "--json"];
  const withBoth = companionArgs(base, { model: "m1", effort: "low", source: "config", passModel: "m1" });
  assert.deepEqual(withBoth.slice(0, 3), base);
  assert.ok(withBoth.includes("--model") && withBoth[withBoth.indexOf("--model") + 1] === "m1");
  assert.ok(!withBoth.includes("--effort"));
  assert.deepEqual(companionArgs(base, { model: "gpt-6-luna", effort: "high", source: "codex-inherited", passModel: null }), base, "inherit passes nothing");
});

test("P2: configured effort never reaches the companion argv, neither as a flag nor as a bare value", () => {
  isolate({ model: null, effort: "low" });
  const args = companionArgs(["adversarial-review", "--wait", "--json"], effectiveCodex());
  assert.ok(!args.includes("--effort"), "no --effort token");
  assert.ok(!args.includes("low"), "no bare effort value token");
  assert.deepEqual(args, ["adversarial-review", "--wait", "--json"]);
});

test("T-CFG-6: nothing under CODEX_HOME is ever opened for writing", () => {
  const ch = isolate({ model: "m1", effort: "low" });
  const before = treeHash(ch);
  effectiveCodex();
  codexDefaults();
  assert.equal(treeHash(ch), before);
  fs.rmSync(path.join(ch, "config.toml"));
  fs.symlinkSync("/etc/hosts", path.join(ch, "config.toml"));
  assert.deepEqual(codexDefaults(), { model: null, effort: null }, "a symlinked config.toml is not followed");
});

test("codex_config_unreadable is a registered code", () => {
  assert.equal(CODES.codex_config_unreadable.category, "internal");
});

/** A fake plugin root whose companion echoes its argv and CLAUDE_PLUGIN_DATA. */
function fakeRoot() {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(
    path.join(root, "scripts", "codex-companion.mjs"),
    "console.log(JSON.stringify({ argv: process.argv.slice(2), data: process.env.CLAUDE_PLUGIN_DATA ?? null }));\n"
  );
  return root;
}

test("runCompanion threads --model (and no --effort) before target args and focus", async () => {
  isolate({ model: "m1", effort: "low" });
  const r = await runCompanion(fakeRoot(), { cwd: tmpDir(), targetArgs: ["--base", "main"], focus: "FOCUS", codex: effectiveCodex() });
  const { argv } = JSON.parse(r.stdout);
  assert.deepEqual(argv, ["adversarial-review", "--wait", "--json", "--model", "m1", "--base", "main", "FOCUS"]);
});

test("M2: runCompanion gives the companion a round-private CLAUDE_PLUGIN_DATA inside the snapshot, never the Codex plugin's shared data dir", async () => {
  isolate({ model: null, effort: null });
  const cfgDir = tmpDir();
  const shared = path.join(cfgDir, "plugins", "data", "codex-openai-codex");
  fs.mkdirSync(shared, { recursive: true });
  const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, data: process.env.CLAUDE_PLUGIN_DATA };
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  try {
    for (const inherited of [undefined, shared]) {
      if (inherited === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = inherited;
      const root = fakeRoot();
      const r = await runCompanion(root, { cwd: tmpDir(), targetArgs: [], focus: "F", codex: effectiveCodex() });
      assert.equal(JSON.parse(r.stdout).data, path.join(root, "data"), `inherited CLAUDE_PLUGIN_DATA=${inherited ?? "unset"}`);
      assert.equal(fs.statSync(path.join(root, "data")).mode & 0o777, 0o700);
      await stopCompanionBroker(root);
    }
    assert.deepEqual(fs.readdirSync(shared), []);
  } finally {
    if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
    if (saved.data === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = saved.data;
  }
});

test("companionArgs uses the passed settings and never re-reads config (recorded == sent)", () => {
  isolate({ model: "m1", effort: "low" });
  const eff = effectiveCodex();
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG ?? "", JSON.stringify({ version: 1, preset: "default", codex: { model: "changed", effort: null }, rubricPath: null, events: { path: null } }));
  const args = companionArgs(["adversarial-review"], eff);
  assert.equal(args[args.indexOf("--model") + 1], eff.model);
  assert.equal(eff.model, "m1");
  isolate({ model: null, effort: null });
  const inherited = effectiveCodex();
  assert.equal(inherited.model, "gpt-6-luna");
  assert.ok(!companionArgs(["adversarial-review"], inherited).includes("--model"));
});

/** @param {string} eventsFile */
const codes = (eventsFile) =>
  fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).code) : [];

test("a refused (symlinked) config.toml emits codex_config_unreadable once; an absent one is silent", () => {
  const ch = isolate({ model: null, effort: null });
  const events = path.join(tmpDir(), "events.jsonl");
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG ?? "", JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: events } }));
  fs.rmSync(path.join(ch, "config.toml"));
  assert.deepEqual(effectiveCodex({ report: true }), { model: null, effort: null, source: "codex-inherited", passModel: null });
  assert.deepEqual(codes(events), []);
  fs.symlinkSync("/etc/hosts", path.join(ch, "config.toml"));
  assert.deepEqual(effectiveCodex({ report: true }), { model: null, effort: null, source: "codex-inherited", passModel: null });
  assert.deepEqual(codes(events), ["codex_config_unreadable"]);
  effectiveCodex();
  assert.equal(codes(events).length, 1, "only the round path (report: true) emits");
});

test("config sets only effort: the inherited model is recorded but never passed, and neither is effort", async () => {
  isolate({ model: null, effort: "low" });
  const eff = effectiveCodex();
  assert.deepEqual(eff, { model: "gpt-6-luna", effort: "low", source: "config", passModel: null });
  const r = await runCompanion(fakeRoot(), { cwd: tmpDir(), targetArgs: ["--base", "main"], focus: "FOCUS", codex: eff });
  assert.deepEqual(JSON.parse(r.stdout).argv, ["adversarial-review", "--wait", "--json", "--base", "main", "FOCUS"]);
});
