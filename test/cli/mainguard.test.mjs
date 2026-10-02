import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI_DIR = path.join(process.cwd(), "cli");

function runVia(entry) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rl-mg-"));
  try {
    return spawnSync(process.execPath, [entry, "version"], { encoding: "utf8", env: { PATH: path.dirname(process.execPath), HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") } });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("main-guard: runs when reached through a symlinked directory", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-mg-dir-"));
  try {
    fs.symlinkSync(CLI_DIR, path.join(tmp, "x"));
    const r = runVia(path.join(tmp, "x", "review-loop.mjs"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^review-loop \d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("main-guard: runs when invoked as a symlink file named review-loop (install_symlink layout)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-mg-bin-"));
  try {
    const bin = path.join(tmp, "review-loop");
    fs.symlinkSync(path.join(CLI_DIR, "review-loop.mjs"), bin);
    const r = runVia(bin);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^review-loop \d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
