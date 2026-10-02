import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "engine", "review-gate-hook.mjs");
const NODE_DIR = path.dirname(process.execPath);

function session(pathDirs) {
  const home = tmpDir();
  const env = { HOME: home, REVIEW_LOOP_TEST_FALLBACK_DIRS: "", PATH: pathDirs.join(path.delimiter), REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") };
  return spawnSync(process.execPath, [HOOK, "session"], { env, input: JSON.stringify({ session_id: "s-notice", cwd: home }), encoding: "utf8" });
}

test("T-UN-5: no review-loop on PATH → one systemMessage naming the fix", () => {
  const r = session([tmpDir()]);
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const msg = JSON.parse(lines[0]).systemMessage;
  assert.match(msg, /review-loop CLI is missing/);
  assert.match(msg, /claude plugin uninstall review-loop@review-loop/);
});

test("T-UN-5 (+): a fake review-loop on PATH → nothing printed", () => {
  const bin = tmpDir();
  fs.writeFileSync(path.join(bin, "review-loop"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const r = session([bin, NODE_DIR]);
  assert.equal(r.stdout, "");
  assert.equal(r.status, 0);
});

test("T-UN-5 (−): a directory named review-loop on PATH does not count", () => {
  const bin = tmpDir();
  fs.mkdirSync(path.join(bin, "review-loop"));
  assert.match(session([bin]).stdout, /CLI is missing/);
});

test("T-UN-5: a review-loop in a fallback directory counts", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "review-loop"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const home = tmpDir();
  const env = { HOME: home, REVIEW_LOOP_TEST_FALLBACK_DIRS: dir, PATH: tmpDir(), REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") };
  const r = spawnSync(process.execPath, [HOOK, "session"], { env, input: JSON.stringify({ session_id: "s-notice", cwd: home }), encoding: "utf8" });
  assert.equal(r.stdout, "");
});
