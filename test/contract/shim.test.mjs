// test/contract/shim.test.mjs — T-DOC-9
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";
import { MODEL_RE, EFFORTS } from "../../plugin/engine/lib/config.mjs";

const SHIM = path.join(process.cwd(), "plugin", "bin", "hook");
const G = "g" + "h";
function run(mode, input, stateDir) {
  const env = { PATH: "/usr/bin:/bin", HOME: tmpDir(), REVIEW_LOOP_NODE_CANDIDATES: "/nonexistent/node", REVIEW_LOOP_STATE_DIR: stateDir };
  return spawnSync("/bin/sh", [SHIM, mode], { env, input: JSON.stringify(input), encoding: "utf8" });
}
function state() { const d = path.join(tmpDir(), "state"); fs.mkdirSync(d, { mode: 0o700 }); return d; }
const events = (d) => (fs.existsSync(path.join(d, "events.jsonl")) ? fs.readFileSync(path.join(d, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const prCreate = { session_id: "s-1", tool_name: "Bash", tool_input: { command: `${G} pr create --title t` } };

test("T-DOC-9: without node — stop blocks, pr denies, prverify stops, others log hook.error", () => {
  const d = state();
  assert.match(run("stop", { session_id: "s-1", stop_hook_active: false }, d).stdout, /"decision":"block"/);
  assert.equal(run("stop", { session_id: "s-1", stop_hook_active: true }, d).stdout, "");
  assert.match(run("pr", prCreate, d).stdout, /"permissionDecision":"deny"/);
  const pv = JSON.parse(run("prverify", prCreate, d).stdout);
  assert.deepEqual(Object.keys(pv).sort(), ["continue", "stopReason"]);
  assert.equal(pv.continue, false);
  for (const m of ["session", "track", "prompt"]) assert.equal(run(m, { session_id: "s-1" }, d).status, 0);
  const ev = events(d);
  assert.equal(ev.length, 7);
  for (const l of ev) { assert.deepEqual(validateLine(l), [], JSON.stringify(l)); assert.equal(l.code, "node_missing"); }
  assert.deepEqual(ev.filter((l) => l.event === "hook.error").map((l) => l.data.stage), ["session", "track", "prompt"]);
});

test("T-DOC-9: without node the Advisory preset still never blocks; any other or untrusted preset blocks", () => {
  const cfgDir = tmpDir();
  const cfg = path.join(cfgDir, "config.json");
  const write = (preset) => fs.writeFileSync(cfg, JSON.stringify({ version: 1, preset, codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  const go = (mode, input, d, config = cfg) => spawnSync("/bin/sh", [SHIM, mode], { env: { PATH: "/usr/bin:/bin", HOME: tmpDir(), REVIEW_LOOP_NODE_CANDIDATES: "/nonexistent/node", REVIEW_LOOP_STATE_DIR: d, REVIEW_LOOP_CONFIG: config }, input: JSON.stringify(input), encoding: "utf8" });
  const stop = { session_id: "s-1", stop_hook_active: false };
  write("advisory");
  const d = state();
  for (const [mode, input] of [["stop", stop], ["pr", prCreate], ["prverify", prCreate]]) {
    const out = JSON.parse(go(mode, input, d).stdout);
    assert.deepEqual(Object.keys(out), ["systemMessage"], `${mode}: a warning only, no decision`);
    assert.match(out.systemMessage, /^⚠ review-loop \(Advisory\): Node\.js not found.*allowed under Advisory$/);
  }
  assert.deepEqual(events(d).map((l) => `${l.data.gate}:${l.data.outcome}:${l.data.preset}`), ["stop:warned:advisory", "pr:warned:advisory", "prverify:warned:advisory"]);
  for (const l of events(d)) assert.deepEqual(validateLine(l), [], JSON.stringify(l));
  // Not advisory, or not trustworthy: the blocking default.
  write("balanced");
  assert.match(go("stop", stop, state()).stdout, /"decision":"block"/);
  fs.writeFileSync(cfg, JSON.stringify({ preset: ["advisory"] }));
  assert.match(go("stop", stop, state()).stdout, /"decision":"block"/, "a non-string preset");
  // Advisory counts only in a config the node reader (isConfig) would accept.
  const base = { version: 1, preset: "advisory", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } };
  fs.writeFileSync(cfg, JSON.stringify({ ...base, codex: { model: "gpt-5.5", effort: "high" }, rubricPath: "/r/rubric.md", events: { path: "/l/ev.jsonl" } }));
  assert.deepEqual(Object.keys(JSON.parse(go("stop", stop, state()).stdout)), ["systemMessage"], "a full valid config still warns");
  const { version: _v, ...noVersion } = base;
  const { events: _e, ...noEvents } = base;
  for (const bad of [
    { ...base, version: 2 },
    noVersion,
    noEvents,
    { ...base, codex: { model: "bad space", effort: null } },
    { ...base, codex: { model: "gpt\n", effort: null } },
    { ...base, codex: { model: null, effort: "max" } },
    { ...base, rubricPath: "relative.md" },
    { ...base, events: { path: 7 } },
    [base],
  ]) {
    fs.writeFileSync(cfg, JSON.stringify(bad));
    assert.match(go("stop", stop, state()).stdout, /"decision":"block"/, JSON.stringify(bad));
  }
  write("advisory");
  const link = path.join(tmpDir(), "config.json");
  fs.symlinkSync(cfg, link);
  assert.match(go("stop", stop, state(), link).stdout, /"decision":"block"/, "a symlinked config is never followed");
  assert.match(go("pr", prCreate, state(), link).stdout, /"permissionDecision":"deny"/);
  // A regular Advisory file reached through a linked folder, at the folder or higher up: without node's owner walk, the
  // blocking default (author's decision, round 31).
  const outer = tmpDir();
  fs.symlinkSync(cfgDir, path.join(outer, "review-loop"));
  const viaFolder = path.join(outer, "review-loop", "config.json");
  fs.mkdirSync(path.join(outer, "real", "review-loop"), { recursive: true });
  fs.copyFileSync(cfg, path.join(outer, "real", "review-loop", "config.json"));
  fs.symlinkSync(path.join(outer, "real"), path.join(outer, "dots"));
  const viaAncestor = path.join(outer, "dots", "review-loop", "config.json");
  for (const [config, why] of [[viaFolder, "a linked config folder"], [viaAncestor, "a link above the config folder"], ["config.json", "a relative config path"]]) {
    assert.match(go("stop", stop, state(), config).stdout, /"decision":"block"/, why);
    assert.match(go("pr", prCreate, state(), config).stdout, /"permissionDecision":"deny"/, why);
  }
  assert.deepEqual(Object.keys(JSON.parse(go("stop", stop, state(), path.join(outer, "real", "review-loop", "config.json")).stdout)), ["systemMessage"], "the same file on a link-free path still warns");
});

test("T-DOC-9: without node an events log over 5 MiB is rotated to .1, as the node writer does, and logging continues", () => {
  const d = state();
  const log = path.join(d, "events.jsonl");
  fs.writeFileSync(log, "x".repeat(5 * 1024 * 1024 + 1), { mode: 0o600 });
  const r = run("stop", { session_id: "s-1", stop_hook_active: false }, d);
  assert.match(r.stdout, /"decision":"block"/);
  assert.equal(r.stderr, "", "no not-writable warning");
  assert.equal(fs.statSync(`${log}.1`).size, 5 * 1024 * 1024 + 1, "the full log is kept as .1");
  assert.equal(events(d).length, 1, "the new event starts a fresh log");
  assert.equal(events(d)[0].data.outcome, "blocked");
});

test("T-DOC-9: without node a Stop is let through only for a top-level boolean stop_hook_active true", () => {
  const d = state();
  const raw = (body) => spawnSync("/bin/sh", [SHIM, "stop"], { env: { PATH: "/usr/bin:/bin", HOME: tmpDir(), REVIEW_LOOP_NODE_CANDIDATES: "/nonexistent/node", REVIEW_LOOP_STATE_DIR: d }, input: body, encoding: "utf8" });
  assert.equal(raw('{"session_id":"s-1","stop_hook_active":true}').stdout, "");
  assert.equal(raw('{"session_id":"s-1", "stop_hook_active": true}').stdout, "", "spacing does not matter");
  for (const body of [
    '{"session_id":"s-1","stop_hook_active":false,"last_assistant_message":"\\"stop_hook_active\\":true"}',
    '{"session_id":"s-1","nested":{"stop_hook_active":true}}',
    '{"session_id":"s-1","stop_hook_active":"true"}',
    '{"session_id":"s-1","stop_hook_active":1}',
    'x "stop_hook_active":true',
  ]) assert.match(raw(body).stdout, /"decision":"block"/, body);
});

test("T-DOC-9: without node the event log keeps the node writer's privacy: a loose state dir is refused, a loose log narrowed to 0600", () => {
  const loose = path.join(tmpDir(), "state");
  fs.mkdirSync(loose);
  fs.chmodSync(loose, 0o755);
  const r = run("stop", { session_id: "s-1", stop_hook_active: false }, loose);
  assert.match(r.stdout, /"decision":"block"/, "the decision still goes out");
  assert.match(r.stderr, /event log not writable \(state_dir_insecure\)/);
  assert.equal(fs.existsSync(path.join(loose, "events.jsonl")), false, "nothing written into a readable dir");
  assert.equal(fs.statSync(loose).mode & 0o777, 0o755, "the dir is verified, never chmodded");
  const d = state();
  const log = path.join(d, "events.jsonl");
  fs.writeFileSync(log, "");
  fs.chmodSync(log, 0o644);
  run("stop", { session_id: "s-1", stop_hook_active: false }, d);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.equal(events(d).length, 1);
});

test("T-DOC-9: without node the PR gates fail closed on every command, shell-escaped ones included; bad state dir → decision still emitted + one warning; hostile session id → null", () => {
  const d = state();
  const escaped = { session_id: "s-1", tool_name: "Bash", tool_input: { command: `${G} pr $'\\143reate' --title x` } };
  const ls = { session_id: "s-1", tool_name: "Bash", tool_input: { command: "ls" } };
  for (const input of [escaped, ls]) {
    const pr = JSON.parse(run("pr", input, d).stdout);
    assert.equal(pr.hookSpecificOutput.permissionDecision, "deny");
    assert.match(pr.hookSpecificOutput.permissionDecisionReason, /every Bash command is blocked\. In your own terminal, run: brew install node/);
    assert.equal(JSON.parse(run("prverify", input, d).stdout).continue, false);
  }
  assert.deepEqual(events(d).map((l) => `${l.data.gate}:${l.data.outcome}`), ["pr:denied", "prverify:denied", "pr:denied", "prverify:denied"]);
  const real = state();
  const link = path.join(tmpDir(), "state-link");
  fs.symlinkSync(real, link);
  const r = run("stop", { session_id: "s-1", stop_hook_active: false }, link);
  assert.match(r.stdout, /"decision":"block"/);
  assert.match(r.stderr, /^review-loop: event log not writable \((state_dir_insecure|write_failed)\)$/m);
  assert.doesNotMatch(r.stderr, /\//);
  const d2 = state();
  run("stop", { session_id: "../../etc/passwd", stop_hook_active: false }, d2);
  assert.equal(events(d2)[0].session_id, null);
});

test("the shim's copies of config.mjs's model pattern and effort list match the originals", () => {
  const shim = fs.readFileSync(SHIM, "utf8");
  assert.ok(shim.includes(`grep -Eqx '${MODEL_RE.source.slice(1, -1)}'`), "the model pattern drifted from MODEL_RE");
  assert.ok(shim.includes(`effort) case "$v" in ${EFFORTS.join("|")}) return 0`), "the effort list drifted from EFFORTS");
});
