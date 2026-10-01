// test/contract/shim.test.mjs — T-DOC-9
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";

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

test("T-DOC-9 (−): non-PR Bash passes silently; bad state dir → decision still emitted + one warning; hostile session id → null", () => {
  const d = state();
  const ls = { session_id: "s-1", tool_name: "Bash", tool_input: { command: "ls" } };
  for (const m of ["pr", "prverify"]) { const r = run(m, ls, d); assert.equal(r.stdout, ""); }
  assert.equal(events(d).length, 0);
  const real = state();
  const link = path.join(tmpDir(), "state-link");
  fs.symlinkSync(real, link);
  const r = run("stop", { session_id: "s-1", stop_hook_active: false }, link);
  assert.match(r.stdout, /"decision":"block"/);
  assert.match(r.stderr, /^review-loop: event log not writable \((state_dir_insecure|size_cap|write_failed)\)$/m);
  assert.doesNotMatch(r.stderr, /\//);
  const d2 = state();
  run("stop", { session_id: "../../etc/passwd", stop_hook_active: false }, d2);
  assert.equal(events(d2)[0].session_id, null);
});
