import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { emitEvent, buildEvent, writeEvent, eventsPath, eventsPathProblem, validateLine, maxLineBytes } from "../../plugin/engine/lib/events.mjs";
import { EVENT_CATALOG } from "../../plugin/engine/lib/codes.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EVENTS_URL = new URL("../../plugin/engine/lib/events.mjs", import.meta.url).href;
const HOOK = path.join(ROOT, "plugin/engine/review-gate-hook.mjs");
const CLI_EXIT_EVENT = { source: "cli", event: "cli.exit", code: "ok", exit_code: 0, data: { command: "doctor", duration_ms: 1 } };

function env() {
  const home = tmpDir();
  process.env.HOME = home;
  process.env.REVIEW_LOOP_STATE_DIR = path.join(home, "state");
  process.env.REVIEW_LOOP_CONFIG = path.join(home, "cfg.json");
  return home;
}
const lines = () => fs.readFileSync(eventsPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
/** @param {string} home */
const childEnv = (home) => ({ PATH: process.env.PATH, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });

test("T-OBS-1: a written line is schema v1", () => {
  env();
  assert.equal(emitEvent({ source: "hook", event: "gate.decision", code: "reviewed", session_id: "abc-123", data: { gate: "stop", outcome: "allowed", preset: "default", pending_count: 0 } }), true);
  const [l] = lines();
  assert.equal(l.schema, "review-loop.event/1");
  assert.match(l.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.match(l.run_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(validateLine(l), []);
  assert.equal(fs.statSync(eventsPath()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(eventsPath())).mode & 0o777, 0o700);
});

test("buildEvent is pure; writeEvent appends exactly the built object", () => {
  env();
  const built = buildEvent({ source: "round", event: "round.push", code: "ok", artifact_key: "a".repeat(24) });
  assert.equal(built.event, "round.push");
  assert.ok(!fs.existsSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl")), "building writes nothing");
  assert.equal(writeEvent(built), true);
  assert.equal(fs.readFileSync(eventsPath(), "utf8"), JSON.stringify(built) + "\n");
});

test("T-OBS-4: validated by value", () => {
  env();
  emitEvent({ source: "hook", event: "gate.decision", code: "'; rm -rf", detail: "nope", data: { gate: "stop", outcome: "exploded", preset: "default", pending_count: -1 } });
  emitEvent({ source: "hook", event: "made.up", code: "reviewed" });
  const [a, b] = lines();
  assert.equal(a.code, "unregistered_code");
  assert.equal(a.detail, null);
  assert.equal(a.data.outcome, null);
  assert.equal(a.data.pending_count, null);
  assert.equal(b.event, "event_unregistered");
  for (const l of lines()) assert.deepEqual(validateLine(l), []);
});

test("T-OBS-6: every catalog entry's largest line is ≤ 4 KiB; oversized values fall back", () => {
  for (const name of Object.keys(EVENT_CATALOG)) assert.ok(maxLineBytes(name) <= 4096, `${name}: ${maxLineBytes(name)} bytes`);
  env();
  emitEvent({ source: "hook", event: "gate.decision", code: "reviewed", session_id: "x".repeat(10_000), data: { gate: "stop", outcome: "allowed", preset: "default", pending_count: 0 } });
  const raw = fs.readFileSync(eventsPath(), "utf8");
  assert.ok(Buffer.byteLength(raw) <= 4096);
  assert.equal(JSON.parse(raw).session_id, null);
});

test("T-OBS-6: rotation at 5 MiB keeps ≤ 2 files", () => {
  env();
  fs.mkdirSync(path.dirname(eventsPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(eventsPath(), "x".repeat(5 * 1024 * 1024 + 1), { mode: 0o600 });
  emitEvent(CLI_EXIT_EVENT);
  const names = fs.readdirSync(path.dirname(eventsPath())).filter((n) => n.startsWith("events.jsonl"));
  assert.deepEqual(names.sort(), ["events.jsonl", "events.jsonl.1"]);
});

test("§8.4: a symlinked events.path is rejected; its target is untouched; the default log is used", () => {
  const home = env();
  const target = path.join(home, "victim.txt");
  fs.writeFileSync(target, "keep");
  const link = path.join(home, "events-link.jsonl");
  fs.symlinkSync(target, link);
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: link } }));
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try { assert.equal(emitEvent(CLI_EXIT_EVENT), true); }
  finally { process.stderr.write = orig; }
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  assert.equal(eventsPath(), path.join(home, "state", "events.jsonl"));
  assert.equal(lines().length, 1);
  assert.ok(writes.some((w) => /events\.path rejected/.test(w)) && writes.every((w) => !w.includes(home)), "one warning, no path");
});

test("§8.4: a custom events.path in the user's own directory keeps that directory's mode", () => {
  const home = env();
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { mode: 0o755 });
  fs.chmodSync(logs, 0o755);
  const f = path.join(logs, "rl.jsonl");
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: f } }));
  assert.equal(emitEvent(CLI_EXIT_EVENT), true);
  assert.equal(fs.statSync(logs).mode & 0o777, 0o755, "not chmodded");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8").trim()).event, "cli.exit");
});

test("§8.4: an existing events log readable by others is narrowed to 0600 before the next line is written", () => {
  const home = env();
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { mode: 0o700 });
  const f = path.join(logs, "rl.jsonl");
  fs.writeFileSync(f, "", { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: f } }));
  assert.equal(emitEvent(CLI_EXIT_EVENT), true);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8").trim()).event, "cli.exit");
  // The default log too: one left at 0644 by an older version is narrowed on the next write.
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  assert.equal(emitEvent(CLI_EXIT_EVENT), true);
  const def = eventsPath();
  fs.chmodSync(def, 0o644);
  assert.equal(emitEvent(CLI_EXIT_EVENT), true);
  assert.equal(fs.statSync(def).mode & 0o777, 0o600);
});

/**
 * Run emitEvent in a fresh process, so the once-per-process warning state starts clean.
 * @param {string} home @param {number} times
 */
function emitInChild(home, times) {
  const script = `import(${JSON.stringify(EVENTS_URL)}).then((m) => { const r = []; for (let i = 0; i < ${times}; i++) r.push(m.emitEvent(${JSON.stringify({ source: "hook", event: "hook.error", code: "detection_failed", data: { stage: "stop" } })})); console.log(JSON.stringify(r)); });`;
  const r = spawnSync(process.execPath, ["-e", script], { env: childEnv(home), encoding: "utf8" });
  return { results: JSON.parse(r.stdout), stderr: r.stderr, status: r.status };
}

test("T-OBS-7: a write failure returns false, warns once, never throws", () => {
  const home = env();
  fs.mkdirSync(eventsPath(), { recursive: true });
  const r = emitInChild(home, 2);
  assert.deepEqual(r.results, [false, false]);
  assert.equal(r.status, 0);
  const warns = r.stderr.split("\n").filter((w) => w.includes("review-loop: event log not writable"));
  assert.equal(warns.length, 1);
  assert.doesNotMatch(warns[0], /\//, "no path in the warning");
});

test("R-D6: an existing 0755 state dir is never chmodded; the write is refused with one state_dir_insecure warning", () => {
  const home = env();
  const state = process.env.REVIEW_LOOP_STATE_DIR;
  fs.mkdirSync(state, { mode: 0o755 });
  fs.chmodSync(state, 0o755);
  const r = emitInChild(home, 2);
  assert.deepEqual(r.results, [false, false]);
  assert.equal(fs.statSync(state).mode & 0o777, 0o755, "mode untouched");
  assert.ok(!fs.existsSync(path.join(state, "events.jsonl")));
  const warns = r.stderr.split("\n").filter((w) => w.includes("event log not writable"));
  assert.deepEqual(warns, ["review-loop: event log not writable (state_dir_insecure)"]);
});

test("R-D6: an absent state dir is created 0700; an existing 0700 dir is used", () => {
  const home = env();
  assert.equal(emitEvent(CLI_EXIT_EVENT), true);
  assert.equal(fs.statSync(process.env.REVIEW_LOOP_STATE_DIR).mode & 0o777, 0o700);
  assert.equal(emitInChild(home, 1).results[0], true);
});

test("R-D6: a symlinked state dir is refused, and its target is untouched", () => {
  const home = env();
  const real = path.join(home, "elsewhere");
  fs.mkdirSync(real, { mode: 0o700 });
  fs.symlinkSync(real, process.env.REVIEW_LOOP_STATE_DIR);
  assert.deepEqual(emitInChild(home, 1).results, [false]);
  assert.deepEqual(fs.readdirSync(real), []);
});

test("emitting never changes a hook's decision: stdout and exit code are identical with or without a writable log", () => {
  /** @param {boolean} logWritable */
  const run = (logWritable) => {
    const home = tmpDir();
    const state = path.join(home, "state");
    fs.mkdirSync(state, { mode: 0o700 });
    if (!logWritable) fs.mkdirSync(path.join(state, "events.jsonl"));
    const r = spawnSync(process.execPath, [HOOK, "pr"], { input: "not json", env: childEnv(home), encoding: "utf8" });
    return { r, log: path.join(state, "events.jsonl") };
  };
  const a = run(true);
  const b = run(false);
  assert.match(a.r.stdout, /"permissionDecision":"deny"/, "the PR gate fails closed on unreadable input");
  assert.equal(b.r.stdout, a.r.stdout);
  assert.equal(b.r.status, a.r.status);
  assert.match(b.r.stderr, /event log not writable/);
  const [l] = fs.readFileSync(a.log, "utf8").trim().split("\n").map((x) => JSON.parse(x));
  assert.deepEqual([l.event, l.code, l.data.stage, l.data.mode, l.source], ["hook.error", "hook_input_invalid", "hook_input_error", "pr", "hook"]);
  assert.deepEqual(validateLine(l), []);
});

/**
 * Run a snippet in a fresh process (`m` is the events module), so once-per-process state starts clean.
 * @param {string} home @param {string} body
 */
function runChild(home, body) {
  const script = `import(${JSON.stringify(EVENTS_URL)}).then(async (m) => { console.log(JSON.stringify(await (async () => { ${body} })())); });`;
  const r = spawnSync(process.execPath, ["-e", script], { env: childEnv(home), encoding: "utf8" });
  return { result: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr, status: r.status };
}

test("writeEvent refuses an object that fails validateLine: returns false and writes nothing", () => {
  const home = env();
  const r = runChild(home, `const line = { ...m.buildEvent({ source: "hook", event: "round.push", code: "ok" }), code: "not_registered" }; return [m.validateLine(line).length > 0, m.writeEvent(line)];`);
  assert.deepEqual(r.result, [true, false]);
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl")));
});

test("at most one stderr warning per process: a rejected events.path then a failed write warns once", () => {
  const home = env();
  const target = path.join(home, "victim.txt");
  fs.writeFileSync(target, "keep");
  const link = path.join(home, "events-link.jsonl");
  fs.symlinkSync(target, link);
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: link } }));
  fs.mkdirSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), { recursive: true });
  const r = runChild(home, `return [m.emitEvent(${JSON.stringify(CLI_EXIT_EVENT)}), m.emitEvent(${JSON.stringify(CLI_EXIT_EVENT)})];`);
  assert.deepEqual(r.result, [false, false]);
  assert.equal(r.stderr.split("\n").filter((l) => l.startsWith("review-loop:")).length, 1, r.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
});


test("T-OBS-5 (unit): no path, email or env value survives into a line", () => {
  env();
  process.env.ENVSECRET = "ENVSECRET";
  emitEvent({ source: "hook", event: "gate.decision", code: "reviewed", session_id: "/Users/x", artifact_key: "a@example.com", data: { gate: "/Users/x", outcome: "allowed", preset: "default", pending_count: 0 } });
  const raw = fs.readFileSync(eventsPath(), "utf8");
  for (const s of ["/Users/", "@example.com", "ENVSECRET"]) assert.ok(!raw.includes(s), s);
});

test("the engine no longer carries the legacy appendEvent", () => {
  const hits = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".mjs") && fs.readFileSync(p, "utf8").includes("appendEvent")) hits.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "plugin"));
  assert.deepEqual(hits, []);
});

test("eventsPathProblem refuses a path reached through a user-owned ancestor link; root-owned system links are followed", () => {
  const real = tmpDir();
  fs.mkdirSync(path.join(real, "sub"));
  const link = path.join(tmpDir(), "link");
  fs.symlinkSync(real, link);
  assert.equal(eventsPathProblem(path.join(link, "sub", "e.jsonl")), "symlink", "an ancestor two levels up is a link");
  assert.equal(eventsPathProblem(path.join(real, "sub", "e.jsonl")), null, "control: the same directory reached directly");
  // os.tmpdir() is not realpath'd: on macOS it starts with /var, a root-owned link to /private/var.
  const sys = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  assert.equal(eventsPathProblem(path.join(sys, "e.jsonl")), null, "a root-owned system link is not a user's redirect");
  const victim = path.join(real, "sub", "victim.jsonl");
  fs.writeFileSync(victim, "keep");
  assert.equal(eventsPathProblem(path.join(link, "sub", "victim.jsonl")), "symlink", "an existing file behind the link is refused too");
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
});

test("L16: eventsPathProblem refuses a parent or a file owned by someone else (not_owned)", { skip: process.getuid?.() === 0 }, () => {
  assert.equal(eventsPathProblem("/rl-x.jsonl"), "not_owned", "/ is root-owned");
  assert.equal(eventsPathProblem("/private/etc/hosts"), "not_owned", "a root-owned file in a root-owned dir");
  const mine = path.join(tmpDir(), "e.jsonl");
  assert.equal(eventsPathProblem(mine), null, "control: a new file in my own dir");
});
