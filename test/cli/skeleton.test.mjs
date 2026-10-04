import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";
import { withCliLock, CLI_LOCK_KEY } from "../../cli/lib/lock.mjs";
import { readLock } from "../../plugin/engine/lib/state.mjs";
import { isRealPid, signalPid } from "../fakes/signal.mjs";

async function withStateDir(dir, fn) {
  const prev = process.env.REVIEW_LOOP_STATE_DIR;
  process.env.REVIEW_LOOP_STATE_DIR = dir;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.REVIEW_LOOP_STATE_DIR; else process.env.REVIEW_LOOP_STATE_DIR = prev;
  }
}

const BIN = path.join(process.cwd(), "cli", "review-loop.mjs");
function sandbox() {
  const home = tmpDir();
  return { home, env: { ...process.env, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"), CLAUDECODE: "", REVIEW_LOOP_TEST_SEAMS: "1" } };
}
const events = (home) => fs.readFileSync(path.join(home, "state", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("T-OBS-2: every exit path writes exactly one cli.exit whose exit_code matches", () => {
  const s = sandbox();
  const cases = [
    [["--version"], 0], [["nope"], 2], [["config", "set", "preset", "yolo"], 2],
    [["selftest", "--inject-internal-error"], 4, "Error"],
    [["doctor", "--inject-missing-module"], 4, "module_not_found"]
  ];
  for (const [args, code, detail] of cases) {
    const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { env: s.env, encoding: "utf8" });
    assert.equal(r.status, code, `${args.join(" ")}: ${r.stderr}`);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "stdout is exactly one JSON line");
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, "cli.exit");
    assert.equal(ev.exit_code, code);
    if (detail) assert.equal(ev.detail, detail);
    assert.deepEqual(validateLine(ev), []);
  }
  const all = events(s.home).filter((e) => e.event === "cli.exit");
  assert.equal(all.length, cases.length);
});

test("T-OBS-2: SIGINT → exit 3 and a cli.exit with exit_code 3", async () => {
  const s = sandbox();
  const child = spawn(process.execPath, [BIN, "setup"], { env: { ...s.env, REVIEW_LOOP_TEST_WAIT_BEFORE_PROMPT: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((r) => setTimeout(r, 500));
  child.kill("SIGINT");
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  assert.equal(code, 3);
  assert.equal(events(s.home).filter((e) => e.event === "cli.exit").at(-1).exit_code, 3);
});

test("T-OBS-2: SIGINT while a tool runs → exit 3, a cli.exit with exit_code 3, and the tool reaped", { timeout: 30_000 }, async () => {
  const s = sandbox();
  const bin = tmpDir();
  const pidFile = path.join(s.home, "claude.pid");
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 20_000);\n`, { mode: 0o755 });
  const env = { ...s.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: path.join(s.home, ".claude"), CODEX_HOME: path.join(s.home, ".codex") };
  const child = spawn(process.execPath, [BIN, "doctor"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let tool = 0;
  let gone = false;
  try {
    const end = Date.now() + 15_000;
    while (!(fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8")) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    tool = Number(fs.readFileSync(pidFile, "utf8"));
    const exited = new Promise((r) => child.once("exit", (c, sig) => r([c, sig])));
    child.kill("SIGINT");
    assert.deepEqual(await exited, [3, null], "exit 3, not killed by a re-raised SIGINT (130)");
    assert.equal(events(s.home).filter((e) => e.event === "cli.exit").at(-1).exit_code, 3);
    assert.ok(isRealPid(tool), "the fake tool recorded its pid");
    for (let i = 0; i < 80 && !gone; i++) {
      if (signalPid(tool, 0)) await new Promise((r) => setTimeout(r, 25));
      else gone = true;
    }
    assert.ok(gone, "the running tool was reaped with its group");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    // Only a tool not yet seen gone: once it is gone its pid may belong to someone else.
    if (!gone) signalPid(tool, "SIGKILL");
  }
});

test("L6: --version and --help print to stdout (so $(review-loop --version) works); with --json stdout is only the event", () => {
  const s = sandbox();
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const v = spawnSync(process.execPath, [BIN, "--version"], { env: s.env, encoding: "utf8" });
  assert.deepEqual([v.status, v.stdout, v.stderr], [0, `review-loop ${pkg.version}\n`, ""]);
  const h = spawnSync(process.execPath, [BIN, "--help"], { env: s.env, encoding: "utf8" });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /^review-loop .*\n\n {2}setup /);
  assert.equal(h.stderr, "");
  for (const args of [["--version", "--json"], ["--help", "--json"]]) {
    const j = spawnSync(process.execPath, [BIN, ...args], { env: s.env, encoding: "utf8" });
    assert.equal(JSON.parse(j.stdout).event, "cli.exit", args.join(" "));
  }
});

test("L11: a command with a payload prints it with the event embedded, as docs/TROUBLESHOOTING.md states; others print the bare event", () => {
  const s = sandbox();
  const bin = tmpDir();
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const env = { ...s.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: path.join(s.home, ".claude"), CODEX_HOME: path.join(s.home, ".codex") };
  for (const args of [["doctor"], ["selftest"], ["config", "show"]]) {
    const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { env, encoding: "utf8", timeout: 60_000 });
    const o = JSON.parse(r.stdout);
    assert.equal(o.event?.event, "cli.exit", `${args.join(" ")} embeds the event`);
    assert.notEqual(o.event, undefined);
  }
  const bare = JSON.parse(spawnSync(process.execPath, [BIN, "version", "--json"], { env, encoding: "utf8" }).stdout);
  assert.equal(bare.event, "cli.exit", "a command without a payload prints the event itself");
  const doc = fs.readFileSync(path.join(process.cwd(), "docs", "TROUBLESHOOTING.md"), "utf8").replace(/\s+/g, " ");
  assert.match(doc, /for a command with a payload \(`doctor`, `selftest`, `engine-path`, `config show`\), that payload object with the event embedded under `event`/);
});

test("piped output is complete: doctor --json (parsed) and help (bytes) through `| cat` equal a file redirect, five times each", () => {
  const s = sandbox();
  // Only node on PATH: doctor's checks then fail fast and offline, and still print the full JSON report.
  const bin = tmpDir();
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const env = { ...s.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: path.join(s.home, ".claude"), CODEX_HOME: path.join(s.home, ".codex") };
  const q = (/** @type {string} */ v) => `'${v.replace(/'/g, "'\\''")}'`;
  const sh = (/** @type {string} */ cmd) => spawnSync("/bin/sh", ["-c", cmd], { env, encoding: "utf8", timeout: 60_000 });
  for (const [args, redirect] of /** @type {const} */ ([["doctor --json", "2>/dev/null"], ["help", "2>&1"]])) {
    const file = path.join(s.home, "out.txt");
    // Twice: the first run creates the state dir, which changes what doctor reports afterwards.
    for (let i = 0; i < 2; i++) sh(`${q(process.execPath)} ${q(BIN)} ${args} >${q(file)} ${redirect}`);
    const want = fs.readFileSync(file, "utf8");
    assert.ok(want.length > 500, `${args}: the file redirect captured the output (${want.length} bytes)`);
    for (let i = 0; i < 5; i++) {
      const r = sh(`${q(process.execPath)} ${q(BIN)} ${args} ${redirect} | cat`);
      if (args.startsWith("doctor")) {
        // The event carries a timestamp, run id and duration, so the report is compared parsed, minus the event.
        assert.ok(r.stdout.endsWith("}\n"), `read ${i + 1}: the piped report is not cut short`);
        const { event: _e, ...got } = JSON.parse(r.stdout);
        const { event: _w, ...exp } = JSON.parse(want);
        assert.deepEqual(got, exp, `read ${i + 1}: the piped report equals the file redirect`);
      } else assert.equal(r.stdout, want, `${args}, read ${i + 1}: piped output equals the file redirect`);
    }
  }
});

test("T-DOC-3 (concurrency): --json is the line this run wrote, even when others append around it", () => {
  const s = sandbox();
  const log = path.join(s.home, "state", "events.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const noisy = spawn(process.execPath, ["-e", `const fs=require("fs");const end=Date.now()+3000;(function w(){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({schema:"review-loop.event/1",event:"gate.decision"})+"\\n");if(Date.now()<end)setImmediate(w);})()`], { stdio: "ignore" });
  try {
    for (let i = 0; i < 5; i++) {
      const r = spawnSync(process.execPath, [BIN, "config", "show", "--json"], { env: s.env, encoding: "utf8" });
      const ev = JSON.parse(r.stdout).event ?? JSON.parse(r.stdout);
      assert.equal(ev.event, "cli.exit");
      assert.ok(fs.readFileSync(log, "utf8").split("\n").includes(JSON.stringify(ev)), "stdout is a line in the log, verbatim");
    }
  } finally { noisy.kill(); }
});

test("T-DOC-3 (write failure): --json still prints the full, valid cli.exit event", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.home, "state", "events.jsonl"), { recursive: true });
  const r = spawnSync(process.execPath, [BIN, "version", "--json"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0);
  const ev = JSON.parse(r.stdout);
  assert.deepEqual(validateLine(ev), []);
  assert.match(r.stderr, /event log not writable/);
});

test("T-SET-2: non-TTY without --yes → exit 2 usage_noninteractive, nothing invoked", () => {
  const s = sandbox();
  const r = spawnSync(process.execPath, [BIN, "setup", "--json"], { env: s.env, encoding: "utf8", input: "" });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).code, "usage_noninteractive");
});

test("[RF-5] a second mutating command while one holds the lock → cli_busy", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.home, "state", "locks"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(s.home, "state", "locks", "00000000000000000000c11c.lock"), JSON.stringify({ pid: process.pid, session: "other", token: "t".repeat(32) }), { mode: 0o600 });
  const r = spawnSync(process.execPath, [BIN, "config", "set", "preset", "balanced", "--json"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, "cli_busy");
});

test("R-D21: a non-zero exit in text mode prints the message line, then the code + remedy line", () => {
  const s = sandbox();
  const r = spawnSync(process.execPath, [BIN, "config", "set", "preset", "yolo"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 2);
  const lines = r.stderr.trim().split("\n");
  assert.equal(lines.length, 2, r.stderr);
  assert.match(lines[0], /^review-loop: unknown preset/);
  assert.match(lines[1], /^review-loop: usage_bad_flag — /);
});

test("R-D28: an unusable state dir (EACCES on lock acquisition) → exit 1 state_dir_insecure, not 4", { skip: process.getuid?.() === 0 }, () => {
  const s = sandbox();
  const state = path.join(s.home, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  fs.chmodSync(state, 0o500);
  try {
    const r = spawnSync(process.execPath, [BIN, "config", "set", "preset", "balanced", "--json"], { env: s.env, encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout).code, "state_dir_insecure");
  } finally { fs.chmodSync(state, 0o700); }
});

test("lock: an EEXIST thrown by the command propagates once and is never retried", async () => {
  const s = sandbox();
  await withStateDir(path.join(s.home, "state"), async () => {
    let runs = 0;
    const boom = Object.assign(new Error("target exists"), { code: "EEXIST" });
    await assert.rejects(withCliLock(async () => { runs++; throw boom; }), (e) => e === boom);
    assert.equal(runs, 1);
    assert.equal(readLock(CLI_LOCK_KEY), null, "released after the throw");
  });
});

test("lock: the lock is a complete, parseable record for the whole time the command runs", async () => {
  const s = sandbox();
  await withStateDir(path.join(s.home, "state"), async () => {
    await withCliLock(async () => {
      const held = readLock(CLI_LOCK_KEY);
      assert.ok(held && held.pid === process.pid && typeof held.token === "string", "never observed empty or partial");
    });
  });
});

test("lock: an empty or garbage lock file (a crashed older writer) is reclaimed, not treated as busy", async () => {
  const s = sandbox();
  await withStateDir(path.join(s.home, "state"), async () => {
    fs.mkdirSync(path.join(s.home, "state", "locks"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(s.home, "state", "locks", `${CLI_LOCK_KEY}.lock`), "");
    let ran = false;
    await withCliLock(async () => { ran = true; });
    assert.ok(ran);
  });
});

test("lock: a command interrupted by SIGINT while holding the lock leaves a lock the next run reclaims", async () => {
  const s = sandbox();
  const lockFile = path.join(s.home, "state", "locks", `${CLI_LOCK_KEY}.lock`);
  const child = spawn(process.execPath, [BIN, "setup"], { env: { ...s.env, REVIEW_LOOP_TEST_WAIT_BEFORE_PROMPT: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(fs.existsSync(lockFile), "the first command holds the lock while it waits");
  child.kill("SIGINT");
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  assert.equal(code, 3);
  assert.equal(events(s.home).filter((e) => e.event === "cli.exit").length, 1);
  const r = spawnSync(process.execPath, [BIN, "config", "set", "preset", "balanced", "--json"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(JSON.parse(r.stdout).code, "cli_busy");
});
