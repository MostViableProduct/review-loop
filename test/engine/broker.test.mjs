// H1/M2: a round never leaves the Codex companion's detached app-server broker running, and never writes Codex's job
// files outside its own private snapshot. The fake companion mirrors companion 1.0.6: `adversarial-review` starts a
// detached `app-server-broker.mjs serve` (own session, unref'd) and records it in
// `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/broker.json` as { endpoint: "unix:<sock>", pidFile, logFile, sessionDir, pid },
// with the socket in a `cxc-*` session dir under the OS temp dir. No real Codex runs.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeRepo, commitFile, writeFile, tmpDir, GIT_ENV } from "./helpers.mjs";
import { isRealPid, signalPid } from "../fakes/signal.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROUND = path.join(HERE, "..", "..", "plugin", "engine", "review-round.mjs");
const REAL_BASE = path.join(HERE, "..", "fixtures", "fake-codex-plugin");

const BROKER = `import fs from "node:fs"; import net from "node:net";
const sock = process.argv[process.argv.indexOf("--endpoint") + 1].slice("unix:".length);
const conns = new Set();
const stop = () => { clearTimeout(life); server.close(); for (const c of conns) c.destroy(); };
// A lifetime cap, so a broker the test failed to reap still dies on its own.
const life = setTimeout(stop, 120_000);
const server = net.createServer((c) => {
  conns.add(c);
  c.on("close", () => conns.delete(c));
  c.on("data", (b) => {
    if (process.env.FAKE_BROKER_IGNORE_SHUTDOWN === "1" || !String(b).includes('"broker/shutdown"')) return;
    fs.appendFileSync(process.env.BROKER_LOG, "shutdown\\n");
    c.end(JSON.stringify({ id: 1, result: {} }) + "\\n", stop);
  });
});
process.on("SIGTERM", () => { fs.appendFileSync(process.env.BROKER_LOG, "sigterm\\n"); if (process.env.FAKE_BROKER_IGNORE_SIGTERM !== "1") stop(); });
server.listen(sock);
`;

function companion(usage) {
  return `import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "help") { console.log("Usage:\\n  ${usage}"); } else {
  const state = path.join(process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.tmpdir(), "codex-companion"), "state", "r-fake-0123456789abcdef");
  fs.mkdirSync(path.join(state, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(state, "jobs", "review-1.json"), JSON.stringify({ output: "CODEX REVIEW TEXT" }));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));
  const sock = path.join(sessionDir, "broker.sock");
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "app-server-broker.mjs"), "serve", "--endpoint", "unix:" + sock, "--cwd", process.cwd()], { detached: true, stdio: "ignore" });
  child.unref();
  fs.appendFileSync(process.env.BROKER_PIDS, JSON.stringify({ pid: child.pid, sessionDir }) + "\\n");
  const end = Date.now() + 10_000;
  while (!fs.existsSync(sock) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  fs.writeFileSync(path.join(state, "broker.json"), JSON.stringify({ endpoint: "unix:" + sock, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: child.pid }, null, 2));
  if (process.env.COMPANION_PID) fs.writeFileSync(process.env.COMPANION_PID, String(process.pid));
  fs.writeFileSync(process.env.BROKER_READY, "1");
  if (process.env.STUB_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_SLEEP_MS));
  process.stdout.write(JSON.stringify({ result: { verdict: "approve", summary: "s", findings: [], next_steps: [] }, parseError: null }));
  process.exitCode = Number(process.env.STUB_EXIT ?? 0);
}
`;
}

function stubPlugin() {
  const base = tmpDir("rl-broker-plugin-");
  const version = fs.readdirSync(REAL_BASE).filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort().pop() ?? "";
  const root = path.join(base, version);
  fs.cpSync(path.join(REAL_BASE, version), root, { recursive: true });
  const usage = fs
    .readFileSync(path.join(root, "scripts", "codex-companion.mjs"), "utf8")
    .split("\n")
    .find((l) => l.includes("codex-companion.mjs adversarial-review ["))
    ?.replace(/^\s*"|",?\s*$/g, "");
  fs.writeFileSync(path.join(root, "scripts", "codex-companion.mjs"), companion(usage ?? ""));
  fs.writeFileSync(path.join(root, "scripts", "app-server-broker.mjs"), BROKER);
  return base;
}

/** @type {Record<string, string>} */
let env;
let parentData = "";
let dir = "";

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
};
/** @param {() => boolean} cond @param {number} ms */
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
}
/** @returns {Array<{ pid: number, sessionDir: string }>} */
const brokers = () => (fs.existsSync(env.BROKER_PIDS) ? fs.readFileSync(env.BROKER_PIDS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const brokerLog = () => (fs.existsSync(env.BROKER_LOG) ? fs.readFileSync(env.BROKER_LOG, "utf8").split("\n").filter(Boolean) : []);
/** Every file under the parent's CLAUDE_PLUGIN_DATA (the Codex plugin's shared data dir in real use). */
const parentDataFiles = () => fs.readdirSync(parentData, { recursive: true });

beforeEach(() => {
  dir = tmpDir("rl-broker-");
  parentData = path.join(dir, "parent-plugin-data");
  fs.mkdirSync(parentData);
  env = {
    ...GIT_ENV,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    REVIEW_LOOP_STATE_DIR: path.join(dir, "state"),
    REVIEW_LOOP_PLUGIN_BASE: stubPlugin(),
    REVIEW_LOOP_PIN_FILE: path.join(dir, "pin.json"),
    REVIEW_LOOP_CONFIG: path.join(dir, "cfg.json"),
    CLAUDE_PLUGIN_DATA: parentData,
    CLAUDE_SESSION_ID: "broker-session",
    BROKER_PIDS: path.join(dir, "brokers.jsonl"),
    BROKER_LOG: path.join(dir, "broker.log"),
    BROKER_READY: path.join(dir, "ready")
  };
  const r = spawnSync(process.execPath, [ROUND, "repin"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

afterEach(() => {
  // The test reaps what it started, whatever the assertions said: every broker the fake companion recorded.
  for (const b of brokers()) {
    if (alive(b.pid)) signalPid(b.pid, "SIGKILL");
    fs.rmSync(b.sessionDir, { recursive: true, force: true });
  }
});

function specRepo() {
  const repo = makeRepo();
  commitFile(repo, "src/a.ts", "a");
  return writeFile(repo, "docs/specs/feature.md", "# Feature\n");
}

/** @param {Record<string, string>} extra */
function round(extra = {}) {
  const r = spawnSync(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, json: JSON.parse(r.stdout) };
}

/** @param {string} what */
async function assertCleanedUp(what) {
  const started = brokers();
  assert.equal(started.length, 1, `${what}: the fake companion started one broker`);
  assert.ok(await until(() => !alive(started[0].pid), 5000), `${what}: the round's broker is not left running`);
  assert.ok(!fs.existsSync(started[0].sessionDir), `${what}: the broker's cxc-* session dir is removed`);
  assert.deepEqual(parentDataFiles(), [], `${what}: nothing is written under the parent's CLAUDE_PLUGIN_DATA`);
  assert.deepEqual(fs.readdirSync(path.join(env.REVIEW_LOOP_STATE_DIR, "ws")), [], `${what}: the snapshot (and the companion data in it) is removed`);
}

test("H1: a passing round stops its companion broker with broker/shutdown and leaves nothing behind", async () => {
  const r = round();
  assert.equal(r.code, 0, JSON.stringify(r.json));
  await assertCleanedUp("pass");
  assert.deepEqual(brokerLog(), ["shutdown"], "the broker was asked to shut down, not signalled");
});

test("H1: a broker that ignores broker/shutdown gets SIGTERM, after its args are matched to this round's snapshot", async () => {
  const r = round({ FAKE_BROKER_IGNORE_SHUTDOWN: "1" });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  await assertCleanedUp("ignored shutdown");
  assert.deepEqual(brokerLog(), ["sigterm"]);
});

test("H1: codex_failed still stops the broker", async () => {
  const r = round({ STUB_EXIT: "1" });
  assert.equal(r.code, 30);
  assert.equal(r.json.error.code, "codex_failed");
  await assertCleanedUp("codex_failed");
});

test("H1: a companion timeout still stops the broker", async () => {
  const r = round({ STUB_SLEEP_MS: "20000", REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_COMPANION_TIMEOUT_MS: "1500" });
  assert.equal(r.code, 30);
  assert.equal(r.json.error.code, "codex_timeout");
  await assertCleanedUp("timeout");
});

/** The round's hook.error broker_stop_failed events, each checked content-free: no path, pid or socket in the line. */
function brokerStopEvents() {
  const f = path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
  const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  const out = lines.filter((l) => l.includes('"broker_stop_failed"'));
  const pids = brokers().map((b) => String(b.pid));
  for (const l of out) {
    assert.deepEqual(validateLine(JSON.parse(l)), [], "a schema-v1 line");
    for (const bad of [dir, fs.realpathSync(os.tmpdir()), os.tmpdir(), "broker.sock", "cxc-", "/Users/", "/private/", "/var/"]) assert.ok(!l.includes(bad), `no path in the event (${bad})`);
    for (const p of pids) assert.ok(!l.includes(p), "no broker pid in the event");
    const ev = JSON.parse(l);
    assert.deepEqual([ev.event, ev.source, ev.code, ev.detail, ev.data], ["hook.error", "round", "broker_stop_failed", null, { stage: "broker_stop_failed", mode: null }]);
  }
  return out;
}

test("R1: a broker is never signalled when ps cannot say whose it is; the possible leak is logged as broker_stop_failed", async () => {
  const bin = path.join(dir, "failing-ps");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\necho 'ps: unavailable' >&2\nexit 2\n", { mode: 0o755 });
  const r = round({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", PATH: `${bin}:${env.PATH}` });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  const [b] = brokers();
  assert.ok(alive(b.pid), "an unverified broker is left running (afterEach reaps it)");
  assert.deepEqual(brokerLog(), [], "no SIGTERM on an unknown ps read");
  assert.equal(brokerStopEvents().length, 1);
});

test("R1: a broker that survives broker/shutdown and SIGTERM is logged as broker_stop_failed, content-free", async () => {
  const r = round({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_IGNORE_SIGTERM: "1" });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.deepEqual(brokerLog(), ["sigterm"], "the verified broker was sent SIGTERM");
  assert.ok(alive(brokers()[0].pid), "it ignored it (afterEach reaps it)");
  assert.equal(brokerStopEvents().length, 1);
});

test("H1: SIGTERM mid-round reaps the broker from the signal path", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, STUB_SLEEP_MS: "30000" }, stdio: "ignore" });
  try {
    assert.ok(await until(() => fs.existsSync(env.BROKER_READY), 20_000), "the companion started its broker");
    const exited = new Promise((r) => child.once("exit", (_code, sig) => r(sig)));
    child.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM", "the round still dies of SIGTERM");
    const [b] = brokers();
    assert.ok(await until(() => !alive(b.pid), 5000), "the broker was reaped, not orphaned");
    assert.deepEqual(brokerLog(), ["sigterm"]);
    assert.deepEqual(parentDataFiles(), [], "nothing is written under the parent's CLAUDE_PLUGIN_DATA");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("H1: a broker.json pid that is not this round's broker is never signalled", async () => {
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  try {
    // The companion writes its own broker's pid; this one replaces it with an unrelated live process of ours.
    assert.ok(isRealPid(bystander.pid), "the bystander was spawned");
    companionWritingPid(bystander.pid);
    const r = round();
    assert.equal(r.code, 0, JSON.stringify(r.json));
    // Our own child: a kill leaves a zombie that kill(pid, 0) still sees, so its exit is read from the handle.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([bystander.exitCode, bystander.signalCode], [null, null], "a pid whose args do not name this snapshot's broker is left alone");
  } finally {
    bystander.kill("SIGKILL");
  }
});

/** @param {number} pid */
function companionWritingPid(pid) {
  const base = env.REVIEW_LOOP_PLUGIN_BASE;
  const version = fs.readdirSync(base)[0];
  const script = path.join(base, version, "scripts", "codex-companion.mjs");
  fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace("sessionDir, pid: child.pid }", `sessionDir, pid: ${pid} }`));
  const r = spawnSync(process.execPath, [ROUND, "repin"], { env: { ...env, REVIEW_LOOP_PIN_FILE: path.join(dir, "pin2.json") }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
  env.REVIEW_LOOP_PIN_FILE = path.join(dir, "pin2.json");
}

test("M2: the companion's job files live only inside the round's 0700 snapshot, never in the OS temp dir", async () => {
  const shared = path.join(os.tmpdir(), "codex-companion", "state", "r-fake-0123456789abcdef");
  const before = fs.existsSync(shared);
  const r = round();
  assert.equal(r.code, 0);
  assert.deepEqual(parentDataFiles(), []);
  if (!before) assert.ok(!fs.existsSync(shared), "the companion was not left to its $TMPDIR/codex-companion fallback");
  await assertCleanedUp("pass");
});

const ws = () => path.join(env.REVIEW_LOOP_STATE_DIR, "ws");
const snapshots = () => fs.readdirSync(ws()).filter((n) => n.startsWith("plugin-")).sort();
/** @param {number} pid a process's start time as the engine records it (ps lstart, C locale, UTC) */
const startTime = (pid) => spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.trim().replace(/\s+/g, " ");
/** The round's round.sweep events, each checked schema v1 and content-free (counts only, no path). */
function sweepEvents() {
  const f = path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
  const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"round.sweep"')) : [];
  for (const l of lines) {
    assert.deepEqual(validateLine(JSON.parse(l)), [], "a schema-v1 line");
    for (const bad of [dir, fs.realpathSync(os.tmpdir()), "plugin-", "cxc-", "/Users/", "/private/"]) assert.ok(!l.includes(bad), `no path in the event (${bad})`);
  }
  return lines.map((l) => JSON.parse(l));
}

/**
 * A round SIGKILLed mid-review (no finally, no reaper): its snapshot, its broker and the broker's cxc-* dir are left
 * behind. The orphaned companion (its own process group, asleep for 60 s) is killed here, while it is known to be ours.
 */
async function killedRound(extra = {}) {
  const companionPid = path.join(dir, `companion-${Date.now()}.pid`);
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, ...extra, STUB_SLEEP_MS: "60000", COMPANION_PID: companionPid }, stdio: "ignore" });
  const exited = new Promise((r) => child.once("exit", r));
  try {
    assert.ok(await until(() => fs.existsSync(env.BROKER_READY) && fs.existsSync(companionPid), 20_000), "the companion started its broker");
  } finally {
    child.kill("SIGKILL");
    await exited;
    if (fs.existsSync(companionPid)) signalPid(Number(fs.readFileSync(companionPid, "utf8")), "SIGKILL", { group: true });
  }
  fs.rmSync(env.BROKER_READY);
  const [name, ...more] = snapshots();
  assert.equal(more.length, 0, "one snapshot left behind");
  const broker = brokers().at(-1);
  assert.ok(broker && alive(broker.pid), "its broker is left running");
  return { root: path.join(ws(), name), broker, owner: /** @type {number} */ (child.pid) };
}

test("R2: a SIGKILLed round's snapshot, broker and cxc-* dir are swept by the next round once the owner is gone", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  const owner = JSON.parse(fs.readFileSync(path.join(left.root, "owner.json"), "utf8"));
  assert.equal(owner.pid, left.owner, "the owner file names the round's pid");
  assert.equal(typeof owner.started, "string", "and its start time");
  assert.equal(fs.statSync(path.join(left.root, "owner.json")).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(left.root, "data", "state")), "Codex's job files are still there");
  const r = round();
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.ok(await until(() => !alive(left.broker.pid), 5000), "the dead round's broker is stopped");
  assert.equal(brokerLog().filter((l) => l === "shutdown").length, 2, "both brokers were asked to shut down, neither signalled");
  assert.ok(!fs.existsSync(left.broker.sessionDir), "its cxc-* session dir is removed");
  assert.deepEqual(snapshots(), [], "its snapshot (and the job files in it) is removed");
  assert.deepEqual(sweepEvents().map((e) => [e.code, e.data]), [["ok", { swept: 1, brokers_left: 0, failed: 0 }]]);
});

test("R2: a dead round's broker that will not stop keeps its snapshot for a later sweep, logged snapshot_sweep_incomplete", { timeout: 90_000 }, async () => {
  const left = await killedRound({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_IGNORE_SIGTERM: "1" });
  assert.equal(round().code, 0);
  assert.ok(alive(left.broker.pid), "it ignored broker/shutdown and SIGTERM (afterEach reaps it)");
  assert.ok(brokerLog().includes("sigterm"), "the verified broker was sent SIGTERM");
  assert.deepEqual(snapshots(), [path.basename(left.root)], "its broker.json is kept, so the next sweep retries");
  assert.deepEqual(sweepEvents().map((e) => [e.code, e.data]), [["snapshot_sweep_incomplete", { swept: 0, brokers_left: 1, failed: 0 }]]);
});

test("R2: a snapshot whose owner is alive is never touched; a reused owner pid (another start time) counts as gone", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  const ownerFile = path.join(left.root, "owner.json");
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, started: startTime(process.pid) }));
  assert.equal(round().code, 0);
  assert.ok(alive(left.broker.pid), "a live owner's broker is left running (afterEach reaps it)");
  assert.ok(fs.existsSync(left.broker.sessionDir));
  assert.deepEqual(snapshots(), [path.basename(left.root)]);
  assert.deepEqual(sweepEvents(), [], "nothing swept, nothing logged");
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, started: "Thu Jan 1 00:00:00 1970" }));
  assert.equal(round().code, 0);
  assert.ok(await until(() => !alive(left.broker.pid), 5000), "a pid now held by another process is not the owner");
  assert.deepEqual(snapshots(), []);
});

test("R2: a symlinked ws/plugin-* entry is never followed: the linked snapshot and its broker are untouched", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  const moved = path.join(dir, "elsewhere");
  fs.renameSync(left.root, moved);
  fs.symlinkSync(moved, left.root);
  assert.equal(round().code, 0);
  assert.equal(brokerLog().filter((l) => l === "shutdown").length, 1, "only the new round's own broker was asked to stop");
  assert.ok(alive(left.broker.pid));
  assert.ok(fs.lstatSync(left.root).isSymbolicLink(), "the link is left");
  assert.ok(fs.existsSync(path.join(moved, "owner.json")), "and so is what it points at");
  assert.deepEqual(sweepEvents(), []);
});

test("R2: when ps cannot answer, a live-owner snapshot and an old legacy snapshot are both left alone", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  fs.writeFileSync(path.join(left.root, "owner.json"), JSON.stringify({ pid: process.pid, started: startTime(process.pid) }));
  const legacy = path.join(ws(), "plugin-legacy-old");
  fs.mkdirSync(legacy, { mode: 0o700 });
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(legacy, old, old);
  const bin = path.join(dir, "failing-ps");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  assert.equal(round({ PATH: `${bin}:${env.PATH}` }).code, 0);
  assert.ok(alive(left.broker.pid));
  assert.deepEqual(snapshots(), [path.basename(left.root), "plugin-legacy-old"].sort());
  assert.deepEqual(sweepEvents(), []);
});

test("R2: a legacy snapshot (no owner file) is swept only when older than 24 h and named by no live process", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  fs.rmSync(path.join(left.root, "owner.json"));
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(left.root, old, old);
  const unused = path.join(ws(), "plugin-legacy-unused");
  const fresh = path.join(ws(), "plugin-legacy-fresh");
  for (const d of [unused, fresh]) fs.mkdirSync(d, { mode: 0o700 });
  fs.utimesSync(unused, old, old);
  assert.equal(round().code, 0);
  assert.ok(alive(left.broker.pid), "a legacy snapshot a live broker's args name is left, broker and all");
  assert.deepEqual(snapshots(), [path.basename(left.root), "plugin-legacy-fresh"].sort(), "only the old, unreferenced one is swept");
  assert.deepEqual(sweepEvents().map((e) => [e.code, e.data]), [["ok", { swept: 1, brokers_left: 0, failed: 0 }]]);
});

test("S1: a live owner whose owner.json was written under another TZ is untouched by sweeps under any TZ", { timeout: 90_000 }, async () => {
  // The owner is a live process that created its snapshot through the engine's own snapshotVerified, under Asia/Tokyo.
  const pinUrl = new URL("../../plugin/engine/lib/pin.mjs", import.meta.url).href;
  const src = `const { snapshotVerified } = await import(${JSON.stringify(pinUrl)}); process.stdout.write(snapshotVerified(process.argv[1]).root + "\\n"); setTimeout(() => {}, 60_000);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", src, ws()], { env: { ...env, TZ: "Asia/Tokyo" }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    let out = "";
    owner.stdout.on("data", (d) => { out += d; });
    assert.ok(await until(() => out.endsWith("\n"), 15_000), "the owner created its snapshot");
    const root = out.trim();
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "owner.json"), "utf8")).pid, owner.pid);
    const { TZ: _tz, ...noTz } = env;
    for (const runEnv of [noTz, { ...noTz, TZ: "America/New_York" }]) {
      const r = spawnSync(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: runEnv, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(fs.existsSync(path.join(root, "owner.json")), `untouched with TZ=${runEnv.TZ ?? "(unset)"}`);
    }
    assert.deepEqual(sweepEvents(), [], "nothing swept, nothing logged");
  } finally {
    owner.kill("SIGKILL");
  }
});

