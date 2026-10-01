import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PRESETS, PRESET_NAMES, gateOutcome } from "../../plugin/engine/lib/presets.mjs";
import { PRESET_NAMES as CONFIG_PRESET_NAMES } from "../../plugin/engine/lib/config.mjs";
import { EVENT_CATALOG } from "../../plugin/engine/lib/codes.mjs";
import { newRecord, writeRecord, writePendingSummary } from "../../plugin/engine/lib/state.mjs";
import { evaluatePrGate } from "../../plugin/engine/lib/prgate.mjs";
import { tmpDir, makeRepo, commitFile, writeFile, g } from "./helpers.mjs";

const EXPECTED = {
  default: { stop: "block", pr: "deny", prompt: "inject", prverify: "stop", merge: "deny" },
  balanced: { stop: "warn", pr: "deny", prompt: "inject", prverify: "stop", merge: "deny" },
  advisory: { stop: "warn", pr: "warn", prompt: "inject", prverify: "warn", merge: "warn" }
};

test("T-CFG-1: every preset × gate × pending cell matches spec §5.2 and §7.1", () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), Object.keys(EXPECTED).sort(), "a new preset needs a matrix row here");
  for (const [preset, gates] of Object.entries(EXPECTED)) {
    for (const [gate, action] of Object.entries(gates)) {
      assert.equal(gateOutcome(preset, gate, true), action, `${preset}/${gate}/pending`);
      assert.equal(gateOutcome(preset, gate, false), "allow", `${preset}/${gate}/clean`);
    }
  }
  assert.equal(gateOutcome("bogus", "stop", true), "block", "unknown preset → Default");
});

test("preset names have one source: config validation, the matrix and both event schemas agree", () => {
  assert.deepEqual([...PRESET_NAMES].sort(), Object.keys(PRESETS).sort());
  assert.deepEqual([...CONFIG_PRESET_NAMES].sort(), [...PRESET_NAMES].sort());
  for (const event of ["gate.decision", "round.result"]) {
    for (const name of PRESET_NAMES) assert.equal(EVENT_CATALOG[event].data.preset(name), name, `${event}/${name}`);
    assert.equal(EVENT_CATALOG[event].data.preset("bogus"), null, event);
  }
});

test("Advisory never blocks", () => {
  for (const gate of Object.keys(EXPECTED.advisory)) assert.ok(!["block", "deny", "stop"].includes(gateOutcome("advisory", gate, true)));
});

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "engine", "review-gate-hook.mjs");
const GH = "g" + "h";

function sandbox(/** @type {string} */ preset) {
  const home = tmpDir();
  const env = { ...process.env, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") };
  const setPreset = (/** @type {string} */ p) => fs.writeFileSync(env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: p, codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  setPreset(preset);
  const repo = makeRepo();
  commitFile(repo, "README.md", "x");
  const run = (/** @type {string} */ mode, /** @type {Record<string, unknown>} */ input, /** @type {string} */ cwd = repo, /** @type {NodeJS.ProcessEnv} */ extra = {}) =>
    spawnSync(process.execPath, [HOOK, mode], { env: { ...env, ...extra }, input: JSON.stringify({ session_id: "s1", cwd, ...input }), encoding: "utf8" });
  const hook = (/** @type {string} */ mode, /** @type {Record<string, unknown>} */ input) => run(mode, input).stdout;
  const decisions = () => {
    const f = path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "gate.decision") : [];
  };
  const pendingSpec = () => {
    hook("session", {});
    hook("track", { tool_input: { file_path: writeFile(repo, "docs/specs/x-design.md", "# x\n") } });
  };
  return { repo, env, run, hook, decisions, setPreset, pendingSpec };
}

test("T-OBS-9: clean stop and clean prompt each log one allowed decision; a non-PR Bash command logs none", () => {
  const s = sandbox("default");
  s.hook("session", {});
  s.hook("stop", { stop_hook_active: false });
  s.hook("prompt", { prompt: "hi" });
  s.hook("pr", { tool_name: "Bash", tool_input: { command: "ls" } });
  const d = s.decisions();
  assert.equal(d.length, 2);
  assert.deepEqual([d[0].data.gate, d[0].data.outcome, d[0].data.pending_count], ["stop", "allowed", 0]);
  assert.deepEqual([d[1].data.gate, d[1].data.outcome], ["prompt", "allowed"]);
});

test("T-CFG-7: a preset change applies to the very next hook, with no restart", () => {
  const s = sandbox("default");
  s.pendingSpec();
  const blocked = s.hook("stop", { stop_hook_active: false });
  assert.match(blocked, /"decision":"block"/);
  s.setPreset("advisory");
  const warned = s.hook("stop", { stop_hook_active: false });
  assert.doesNotMatch(warned, /"decision"/);
  assert.match(warned, /"systemMessage":"review-loop: 1 artifact\(s\) changed this session and are not reviewed/);
  const outcomes = s.decisions().map((x) => x.data.outcome);
  assert.deepEqual(outcomes.slice(-2), ["blocked", "warned"]);
});

test("stop: every preset × pending emits exactly one gate.decision with the matrix outcome and never blocks off Default", () => {
  const want = { default: "blocked", balanced: "warned", advisory: "warned" };
  for (const [preset, outcome] of Object.entries(want)) {
    const s = sandbox(preset);
    s.pendingSpec();
    const out = s.hook("stop", { stop_hook_active: false });
    assert.equal(/"decision":"block"/.test(out), preset === "default", preset);
    const d = s.decisions();
    assert.equal(d.length, 1, preset);
    assert.deepEqual([d[0].code, d[0].data.gate, d[0].data.outcome, d[0].data.preset, d[0].data.pending_count], ["review_pending", "stop", outcome, preset, 1]);
  }
});

test("stop with stop_hook_active under Default: non-blocking warning, outcome allowed", () => {
  const s = sandbox("default");
  s.pendingSpec();
  const out = s.hook("stop", { stop_hook_active: true });
  assert.doesNotMatch(out, /"decision"/);
  assert.deepEqual(s.decisions().map((x) => x.data.outcome), ["allowed"]);
});

test("prompt with a pending summary logs warned; the injected text is unchanged by the preset", () => {
  const s = sandbox("advisory");
  s.pendingSpec();
  s.hook("stop", { stop_hook_active: false });
  const out = s.hook("prompt", { prompt: "hi" });
  assert.match(out, /"additionalContext"/);
  const d = s.decisions();
  assert.deepEqual(d.map((x) => x.data.gate + ":" + x.data.outcome), ["stop:warned", "prompt:warned"]);
  assert.equal(d[1].data.pending_count, 1);
});

/** A repo whose session started with an untracked kill switch, so the PR gate takes the kill-switch path. */
function killSwitchSandbox() {
  const s = sandbox("default");
  writeFile(s.repo, ".claude/review-loop.off", "");
  s.hook("session", {});
  return s;
}

test("R-T7a: a PR attempt emits exactly one gate.decision — denied, kill-switch skipped, and an unresolvable argument list", () => {
  const s = killSwitchSandbox();
  const skipped = s.run("pr", { tool_name: "Bash", tool_input: { command: `${GH} pr create --base main` } });
  assert.match(skipped.stdout, /kill switch .* PR created WITHOUT review/);
  let d = s.decisions();
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].code, d[0].data.gate, d[0].data.outcome, d[0].data.preset], ["kill_switch", "pr", "skipped", "default"]);

  const outside = tmpDir();
  const denied = s.run("pr", { tool_name: "Bash", tool_input: { command: `${GH} pr create` } }, outside);
  assert.match(denied.stdout, /"permissionDecision":"deny"/);
  d = s.decisions();
  assert.equal(d.length, 2);
  assert.deepEqual([d[1].code, d[1].data.outcome], ["pr_args_unresolvable", "denied"]);
});

test("R-D12: Advisory pr — a parse/argument error warns via systemMessage, never denies, and logs warned once", () => {
  const s = sandbox("advisory");
  const outside = tmpDir();
  for (const command of [`${GH} pr create`, `${GH} pr create --title x -R a/b -R c/d`]) {
    const r = s.run("pr", { tool_name: "Bash", tool_input: { command } }, command.includes("-R") ? s.repo : outside);
    assert.doesNotMatch(r.stdout, /"permissionDecision"|"decision"|"continue"/, command);
    assert.match(r.stdout, /"systemMessage":"⚠ review-loop \(Advisory\): review-loop \[pr_args_unresolvable\]/, command);
    assert.match(r.stdout, /allowed under Advisory/, command);
  }
  const d = s.decisions();
  assert.deepEqual(d.map((x) => [x.data.gate, x.data.outcome, x.data.preset]), [["pr", "warned", "advisory"], ["pr", "warned", "advisory"]]);
});

test("R-D12: Advisory pr — an unreadable tool input warns instead of denying", () => {
  const s = sandbox("advisory");
  const r = s.run("pr", { tool_name: "Bash", tool_input: {} });
  assert.doesNotMatch(r.stdout, /"permissionDecision"/);
  assert.match(r.stdout, /"systemMessage":"⚠ review-loop \(Advisory\)/);
  assert.doesNotMatch(r.stdout, /fails closed|then retry/, "no enforcement wording under Advisory");
  assert.match(r.stdout, /allowed under Advisory/);
  const d = s.decisions();
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].code, d[0].session_id, d[0].data.outcome, d[0].data.pending_count], ["hook_input_invalid", "s1", "warned", 1]);
});

test("Balanced and Default keep a pr input failure closed", () => {
  for (const preset of ["default", "balanced"]) {
    const r = sandbox(preset).run("pr", { tool_name: "Bash", tool_input: {} });
    assert.match(r.stdout, /"permissionDecision":"deny"/, preset);
  }
});

/** A pushed feature branch with GitHub answered by a stub `gh` on the child's PATH only. */
function prSandbox(/** @type {string} */ preset) {
  const s = sandbox(preset);
  const pr = s.repo;
  const base = g(pr, "rev-parse", "HEAD");
  g(pr, "checkout", "-q", "-b", "feature");
  const head = commitFile(pr, "f.txt", "feat");
  g(pr, "remote", "add", "origin", "https://github.com/me/proj.git");
  g(pr, "config", "branch.feature.remote", "origin");
  const bin = tmpDir("rl-bin-");
  const map = path.join(bin, "map.json");
  fs.writeFileSync(map, JSON.stringify({
    "repo set-default --view": { code: 1, stderr: "no default repository has been set" },
    "api repos/me/proj/git/ref/heads/main --jq .object.sha": { stdout: base },
    "api repos/me/proj/git/ref/heads/feature --jq .object.sha": { stdout: head }
  }));
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const hit = JSON.parse(fs.readFileSync(${JSON.stringify(map)}, "utf8"))[process.argv.slice(2).join(" ")] ?? { code: 1, stderr: "gh: HTTP 404: Not Found" };
if (hit.stdout) process.stdout.write(hit.stdout + "\\n");
if (hit.stderr) process.stderr.write(hit.stderr + "\\n");
process.exitCode = hit.code ?? 0;
`, { mode: 0o755 });
  const pathEnv = { PATH: `${bin}:${process.env.PATH}` };
  const create = () => s.run("pr", { tool_name: "Bash", tool_input: { command: `${GH} pr create --base main` } }, pr, pathEnv);
  return { ...s, base, head, create };
}

test("pr: unreviewed PR — Default denies, Balanced denies, Advisory warns; each logs exactly one decision", () => {
  const want = { default: ["denied", true], balanced: ["denied", true], advisory: ["warned", false] };
  for (const [preset, [outcome, denies]] of Object.entries(want)) {
    const s = prSandbox(preset);
    s.hook("session", {});
    const out = s.create().stdout;
    assert.equal(/"permissionDecision":"deny"/.test(out), denies, preset);
    if (!denies) {
      assert.match(out, /"systemMessage":"⚠ review-loop \(Advisory\): review-loop \[review_pending\]/);
      assert.doesNotMatch(out, /then retry/, "no enforcement wording under Advisory");
      assert.match(out, /allowed under Advisory/);
    }
    const d = s.decisions();
    assert.equal(d.length, 1, preset);
    assert.equal(d[0].session_id, "s1", preset);
    assert.match(d[0].artifact_key, /^[0-9a-f]{24}$/, preset);
    assert.deepEqual([d[0].code, d[0].data.outcome, d[0].data.preset], ["review_pending", outcome, preset]);
  }
});

test("pr: a reviewed PR logs exactly one allowed decision (code reviewed)", () => {
  const s = prSandbox("default");
  s.hook("session", {});
  const prev = process.env.REVIEW_LOOP_STATE_DIR;
  process.env.REVIEW_LOOP_STATE_DIR = s.env.REVIEW_LOOP_STATE_DIR;
  try {
    const r = newRecord({ kind: "branch", baseRepo: "me/proj", baseBranch: "main", headRepo: "me/proj", headBranch: "feature" });
    r.status = "passed";
    r.reviewedFingerprint = `${s.head}:${s.base}`;
    writeRecord(r);
  } finally {
    if (prev === undefined) delete process.env.REVIEW_LOOP_STATE_DIR;
    else process.env.REVIEW_LOOP_STATE_DIR = prev;
  }
  assert.equal(s.create().stdout, "");
  const d = s.decisions();
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].code, d[0].data.outcome], ["reviewed", "allowed"]);
  assert.match(d[0].artifact_key, /^[0-9a-f]{24}$/);
});

test("evaluatePrGate itself emits no gate.decision (the hook owns the single emission)", async () => {
  const s = sandbox("default");
  const prev = process.env.REVIEW_LOOP_STATE_DIR;
  process.env.REVIEW_LOOP_STATE_DIR = s.env.REVIEW_LOOP_STATE_DIR;
  try {
    const r = await evaluatePrGate({ cwd: tmpDir(), session: "s1", command: `${GH} pr create` });
    assert.equal(r?.code, "pr_args_unresolvable");
  } finally {
    if (prev === undefined) delete process.env.REVIEW_LOOP_STATE_DIR;
    else process.env.REVIEW_LOOP_STATE_DIR = prev;
  }
  assert.equal(s.decisions().length, 0);
});

test("invalid config → Default behavior, one stderr line, a config.invalid event, file untouched", () => {
  const s = sandbox("default");
  fs.writeFileSync(s.env.REVIEW_LOOP_CONFIG, "{corrupt");
  s.pendingSpec();
  const r = s.run("stop", { stop_hook_active: false });
  assert.match(r.stdout, /"decision":"block"/);
  const lines = r.stderr.split("\n").filter((l) => l.includes("config invalid"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("config_invalid") && lines[0].includes(s.env.REVIEW_LOOP_CONFIG), "the line names the code and the file");
  assert.equal(fs.readFileSync(s.env.REVIEW_LOOP_CONFIG, "utf8"), "{corrupt");
  const events = fs.readFileSync(path.join(s.env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8");
  assert.match(events, /"event":"config.invalid"/);
});

test("Stop under a kill switch logs exactly one skipped decision with code kill_switch", () => {
  const s = killSwitchSandbox();
  s.hook("track", { tool_input: { file_path: writeFile(s.repo, "docs/specs/x-design.md", "# x\n") } });
  const out = s.hook("stop", { stop_hook_active: false });
  assert.match(out, /kill switch .* NOT reviewed/);
  assert.doesNotMatch(out, /"decision"/);
  const d = s.decisions();
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].code, d[0].data.gate, d[0].data.outcome], ["kill_switch", "stop", "skipped"]);
});

test("prompt under a kill switch: nothing pending logs allowed (nothing to skip); something pending logs skipped/kill_switch", () => {
  const s = killSwitchSandbox();
  s.hook("prompt", { prompt: "hi" });
  const d = s.decisions();
  assert.deepEqual(d.map((x) => [x.data.gate, x.data.outcome, x.code]), [["prompt", "allowed", "reviewed"]]);
  const prev = process.env.REVIEW_LOOP_STATE_DIR;
  process.env.REVIEW_LOOP_STATE_DIR = s.env.REVIEW_LOOP_STATE_DIR;
  try {
    writePendingSummary("s1", [{ key: "k", kind: "spec", label: "spec x", status: "pending", reason: null, command: "node x" }]);
  } finally {
    if (prev === undefined) delete process.env.REVIEW_LOOP_STATE_DIR;
    else process.env.REVIEW_LOOP_STATE_DIR = prev;
  }
  assert.match(s.hook("prompt", { prompt: "again" }), /additionalContext/, "the reminder is still injected");
  assert.deepEqual(s.decisions().slice(1).map((x) => [x.data.outcome, x.code, x.data.pending_count]), [["skipped", "kill_switch", 1]]);
  const plain = sandbox("default");
  plain.hook("session", {});
  plain.hook("prompt", { prompt: "hi" });
  assert.deepEqual(plain.decisions().map((x) => [x.data.outcome, x.code]), [["allowed", "reviewed"]]);
});

/** The real engine, copied, with `evaluatePrGate` replaced by one that throws: the hook's top-level crash path. */
function crashingEngine() {
  const engine = path.join(tmpDir("rl-engine-"), "engine");
  fs.cpSync(path.dirname(HOOK), engine, { recursive: true });
  const lib = path.join(engine, "lib");
  fs.renameSync(path.join(lib, "prgate.mjs"), path.join(lib, "prgate-real.mjs"));
  fs.writeFileSync(path.join(lib, "prgate.mjs"), `export * from "./prgate-real.mjs";\nexport async function evaluatePrGate() { throw new Error("boom"); }\n`);
  return path.join(engine, "review-gate-hook.mjs");
}

test("hook crash in the PR gate: Advisory warns, Default denies, each with exactly one gate.decision", () => {
  const hook = crashingEngine();
  for (const [preset, warns] of [["advisory", true], ["default", false], ["balanced", false]]) {
    const s = sandbox(preset);
    const r = spawnSync(process.execPath, [hook, "pr"], { env: s.env, input: JSON.stringify({ session_id: "s1", cwd: s.repo, tool_name: "Bash", tool_input: { command: `${GH} pr create` } }), encoding: "utf8" });
    if (warns) {
      assert.match(r.stdout, /"systemMessage":"⚠ review-loop \(Advisory\): review-loop \[hook_error:/, preset);
      assert.doesNotMatch(r.stdout, /permissionDecision|kill switch/, preset);
    } else {
      assert.match(r.stdout, /"permissionDecision":"deny"/, preset);
    }
    const d = s.decisions();
    assert.equal(d.length, 1, preset);
    assert.deepEqual([d[0].data.outcome, d[0].session_id, d[0].data.pending_count], [warns ? "warned" : "denied", "s1", 1], preset);
  }
});
