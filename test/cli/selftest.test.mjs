import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const HOOK_REL = path.join("plugin", "engine", "review-gate-hook.mjs");
// A minimal PATH: git and node only, so selftest provably needs no gh, claude, codex or brew.
const PATH_MIN = "/usr/bin:/bin:" + path.dirname(process.execPath);

/** Every run gets its own HOME/state so the CLI's own cli.exit event never lands in the real state dir. */
function envFor(home) {
  return { PATH: PATH_MIN, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

function selftest(root, args = ["--json"]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rl-st-home-"));
  try {
    return spawnSync(process.execPath, [path.join(root, "cli", "review-loop.mjs"), "selftest", ...args], { encoding: "utf8", env: envFor(home) });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Runs fn against a private copy of the tree; the shared source is never written (other tests run concurrently).
 * @param {(root: string) => void} fn
 */
function withCopy(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rl-st-copy-"));
  try {
    for (const p of ["cli", "plugin", "package.json"]) fs.cpSync(path.join(ROOT, p), path.join(root, p), { recursive: true });
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** An unmutated copy must really run selftest and succeed; a copy that prints nothing would make exit-4 checks vacuous. */
function assertSound(root) {
  const r = selftest(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).code, "ok");
}

/** Replaces `from` with `to` in the copy's hook; throws if `from` is absent so a drifted literal cannot pass vacuously. */
function mutateHook(root, from, to) {
  const file = path.join(root, HOOK_REL);
  const src = fs.readFileSync(file, "utf8");
  assert.ok(src.includes(from), `hook source no longer contains ${from}`);
  fs.writeFileSync(file, src.replaceAll(from, to));
}

test("T-REL-3: selftest passes offline", () => {
  const r = selftest(ROOT);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).code, "ok");
});

test("T-REL-3: human output is one short line", () => {
  const r = selftest(ROOT, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1);
});

test("T-REL-3 (−): a broken Stop block makes selftest fail with exit 4", () => {
  withCopy((root) => {
    assertSound(root);
    mutateHook(root, 'decision: "block"', 'decision: "approve"');
    // The named assertion is in the human message on stderr: the JSON event's detail is a bounded enum and drops free text.
    const r = selftest(root, []);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /selftest: Stop did not block/);
    const ev = JSON.parse(selftest(root).stdout);
    assert.deepEqual([ev.code, ev.detail, ev.exit_code], ["selftest_failed", "stop_blocks", 4], "the event names the failing check (L5)");
  });
});

test("T-REL-3 (−): a PR gate that no longer denies makes selftest fail with exit 4 naming the PR gate", () => {
  withCopy((root) => {
    assertSound(root);
    mutateHook(root, 'permissionDecision: "deny"', 'permissionDecision: "allow"');
    // The named assertion is in the human message on stderr: the JSON event's detail is a bounded enum and drops free text.
    const r = selftest(root, []);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /selftest: the PR gate did not deny/);
    const ev = JSON.parse(selftest(root).stdout);
    assert.deepEqual([ev.code, ev.detail, ev.exit_code], ["selftest_failed", "pr_gate_denies", 4], "the event names the failing check (L5)");
  });
});

test("T-REL-3 (−): a silent stop hook makes selftest fail with exit 4 naming the missing Stop output", () => {
  withCopy((root) => {
    assertSound(root);
    mutateHook(root, 'if (MODE === "stop") {', 'if (MODE === "stop") { return;');
    const r = selftest(root, []);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /selftest: the Stop hook produced no output/);
  });
});

test("T-REL-3 (−): a clean-repo Stop that allows without logging makes selftest fail with exit 4", () => {
  withCopy((root) => {
    assertSound(root);
    mutateHook(root, 'return log(killSwitchRoot ? "skipped" : "allowed");', "return;");
    const r = selftest(root, []);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /did not log an allowed decision/);
    assert.equal(JSON.parse(selftest(root).stdout).detail, "clean_repo_passes");
  });
});

test("L15: selftest never runs the user's gh, even with one first on PATH", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rl-st-home-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "rl-st-gh-"));
  try {
    const log = path.join(bin, "gh.log");
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [path.join(ROOT, "cli", "review-loop.mjs"), "selftest", "--json"], { encoding: "utf8", env: { ...envFor(home), PATH: `${bin}:${PATH_MIN}` } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", "", "the PATH's gh was never called");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
