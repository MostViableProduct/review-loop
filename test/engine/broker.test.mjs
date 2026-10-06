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
import {
  afterSnapshotSecond, brokerArgv, deadGroupTargets, namesUpTo, hashOf, isHeld, parseProcRow, partitionCount, sameMember, stopCompanionBroker, sweepStaleSnapshots, treeMembers
} from "../../plugin/engine/lib/pin.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROUND = path.join(HERE, "..", "..", "plugin", "engine", "review-round.mjs");
const REAL_BASE = path.join(HERE, "..", "fixtures", "fake-codex-plugin");

// FAKE_BROKER_CHILD=1 gives the broker a `codex app-server` child in its group, as the real one has (its args read
// exactly `<dir>/codex app-server`: a link to node named codex, running ./app-server); =2 also gives it a grandchild. FAKE_BROKER_TERM_LEAVES_CHILD: on SIGTERM
// the broker exits without closing its child.
const BROKER = `import fs from "node:fs"; import net from "node:net"; import { spawn } from "node:child_process";
const sock = process.argv[process.argv.indexOf("--endpoint") + 1].slice("unix:".length);
const conns = new Set();
const kids = [];
if (process.env.FAKE_BROKER_CHILD) {
  const c = spawn(process.env.FAKE_CODEX_BIN, ["app-server"], { cwd: process.env.FAKE_CODEX_CWD, stdio: "ignore" });
  fs.appendFileSync(process.env.BROKER_KIDS, JSON.stringify({ pid: c.pid }) + "\\n");
  kids.push(c);
}
const stop = () => { clearTimeout(life); server.close(); for (const c of conns) c.destroy(); for (const k of kids) k.kill(); };
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
process.on("SIGTERM", () => {
  fs.appendFileSync(process.env.BROKER_LOG, "sigterm\\n");
  if (process.env.FAKE_BROKER_TERM_LEAVES_CHILD === "1") process.exit(0);
  if (process.env.FAKE_BROKER_IGNORE_SIGTERM !== "1") stop();
});
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
  if (process.env.COMPANION_START) fs.writeFileSync(process.env.COMPANION_START, JSON.stringify({ now: Date.now(), birth: fs.statSync(path.dirname(import.meta.dirname)).birthtimeMs }));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "app-server-broker.mjs"), "serve", "--endpoint", "unix:" + sock, "--cwd", process.cwd()], { detached: process.env.FAKE_BROKER_NOT_DETACHED !== "1", stdio: "ignore" });
  child.unref();
  fs.appendFileSync(process.env.BROKER_PIDS, JSON.stringify({ pid: child.pid, sessionDir }) + "\\n");
  const end = Date.now() + 10_000;
  while (!fs.existsSync(sock) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  let named = child.pid;
  if (process.env.LOOKALIKE_PID) {
    // Its args contain this snapshot's broker script and serve, but it is not \`<node> <script> serve\`.
    const l = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", path.join(import.meta.dirname, "app-server-broker.mjs"), "serve"], { detached: true, stdio: "ignore" });
    l.unref();
    fs.writeFileSync(process.env.LOOKALIKE_PID, String(l.pid));
    named = l.pid;
  }
  const decoy = process.env.FAKE_DECOY_SESSION_DIR;
  if (decoy) fs.writeFileSync(path.join(state, "broker.json"), JSON.stringify({ endpoint: "unix:" + path.join(decoy, "broker.sock"), sessionDir: decoy, pid: named }));
  else if (process.env.FAKE_NO_BROKER_JSON !== "1") fs.writeFileSync(path.join(state, "broker.json"), JSON.stringify({ endpoint: "unix:" + sock, pidFile: path.join(sessionDir, "broker.pid"), logFile: path.join(sessionDir, "broker.log"), sessionDir, pid: named }, null, 2));
  if (process.env.COMPANION_PID) fs.writeFileSync(process.env.COMPANION_PID, String(process.pid));
  fs.writeFileSync(process.env.BROKER_READY, "1");
  if (process.env.STUB_SLEEP_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STUB_SLEEP_MS));
  process.stdout.write(JSON.stringify({ result: { verdict: "approve", summary: "s", findings: [], next_steps: [] }, parseError: null }));
  process.exitCode = Number(process.env.STUB_EXIT ?? 0);
}
`;
}

// The fake `codex app-server`: node (through a link named codex) runs this file from its cwd.
const APP_SERVER = `import fs from "node:fs"; import { spawn } from "node:child_process";
if (process.env.FAKE_BROKER_CHILD === "2") {
  const g = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  fs.appendFileSync(process.env.BROKER_KIDS, JSON.stringify({ pid: g.pid, grand: true }) + "\\n");
}
setTimeout(() => process.exit(0), 120_000);
`;

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
    // Short, as a home dir's is: under the OS temp dir the companion's socket path would pass the unix socket limit,
    // and the round would (rightly) leave the companion's temp dir where it is.
    REVIEW_LOOP_STATE_DIR: path.join(fs.realpathSync(fs.mkdtempSync("/tmp/rlb-")), "state"),
    REVIEW_LOOP_PLUGIN_BASE: stubPlugin(),
    REVIEW_LOOP_PIN_FILE: path.join(dir, "pin.json"),
    REVIEW_LOOP_CONFIG: path.join(dir, "cfg.json"),
    CLAUDE_PLUGIN_DATA: parentData,
    CLAUDE_SESSION_ID: "broker-session",
    BROKER_PIDS: path.join(dir, "brokers.jsonl"),
    BROKER_LOG: path.join(dir, "broker.log"),
    BROKER_READY: path.join(dir, "ready"),
    BROKER_KIDS: path.join(dir, "kids.jsonl"),
    FAKE_CODEX_BIN: path.join(dir, "bin", "codex"),
    FAKE_CODEX_CWD: path.join(dir, "app-server-cwd")
  };
  fs.mkdirSync(path.join(dir, "bin"));
  fs.symlinkSync(process.execPath, env.FAKE_CODEX_BIN);
  fs.mkdirSync(env.FAKE_CODEX_CWD);
  fs.writeFileSync(path.join(env.FAKE_CODEX_CWD, "app-server"), APP_SERVER);
  const r = spawnSync(process.execPath, [ROUND, "repin"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

afterEach(() => {
  // The test reaps what it started, whatever the assertions said: every broker the fake companion recorded.
  for (const b of brokers()) {
    if (alive(b.pid)) signalPid(b.pid, "SIGKILL");
    fs.rmSync(b.sessionDir, { recursive: true, force: true });
  }
  for (const k of kids()) if (alive(k.pid)) signalPid(k.pid, "SIGKILL");
  for (const pid of reapAfter.splice(0)) if (alive(pid)) signalPid(pid, "SIGKILL", { group: true });
  fs.rmSync(path.dirname(env.REVIEW_LOOP_STATE_DIR), { recursive: true, force: true });
});

/** The fake broker's children and grandchildren, as each recorded itself. @returns {Array<{ pid: number, grand?: boolean }>} */
const kids = () => (fs.existsSync(env.BROKER_KIDS) ? fs.readFileSync(env.BROKER_KIDS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** Other process groups a test started, reaped after it. @type {number[]} */
const reapAfter = [];

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
  const out = lines.filter((l) => l.includes('"broker_stop_failed"') && l.includes('"hook.error"'));
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

/** The round.broker_stop details, each schema v1 and content-free (a bounded reason, counts, the snapshot's name). */
function stopDetails() {
  const f = path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
  const lines = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"round.broker_stop"')) : [];
  for (const l of lines) {
    assert.deepEqual(validateLine(JSON.parse(l)), [], "a schema-v1 line");
    for (const bad of [dir, fs.realpathSync(os.tmpdir()), "cxc-", "/Users/", "/private/"]) assert.ok(!l.includes(bad), `no path in the event (${bad})`);
  }
  return lines.map((l) => JSON.parse(l));
}

/** A `ps` on PATH whose whole-table reads (-A) fail and whose one-process reads work: the table cannot be read. */
/** The engine's ps swapped for `<bin>/ps`, through the test seam (never PATH: the engine runs /bin/ps). @param {string} bin */
const psSeam = (bin) => ({ REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_PS_PATH: path.join(bin, "ps") });

function tablePsFails() {
  const bin = path.join(dir, "table-ps-fails");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-A" ] && { echo "ps: unavailable" >&2; exit 2; }; done\nexec /bin/ps "$@"\n', { mode: 0o755 });
  return bin;
}

test("A: when the process table cannot be read, nothing is signalled and the snapshot is kept; the next round clears it", { timeout: 60_000 }, async () => {
  const r = round({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", ...psSeam(tablePsFails()) });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  const [b] = brokers();
  assert.ok(alive(b.pid), "an unverified broker is left running");
  assert.deepEqual(brokerLog(), [], "no shutdown, no signal on an unread table");
  assert.equal(brokerStopEvents().length, 1);
  assert.deepEqual(stopDetails().map((e) => [e.code, e.data.reason, e.data.left, e.data.unattributed]), [["broker_stop_failed", "ps_unavailable", 1, 0]]);
  assert.equal(snapshots().length, 1, "the snapshot is kept: it is the only evidence tying the broker to the round");
  assert.equal(round().code, 0, "a later round, with ps working");
  assert.ok(await until(() => !alive(b.pid), 5000), "the dead round's broker is stopped by the sweep");
  assert.deepEqual(snapshots(), [], "and its snapshot removed");
});

test("B: a broker that ignores broker/shutdown and SIGTERM is SIGKILLed with its whole group, its codex app-server too", { timeout: 60_000 }, async () => {
  const r = round({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_IGNORE_SIGTERM: "1", FAKE_BROKER_CHILD: "1" });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.deepEqual(brokerLog(), ["sigterm"], "the verified broker was sent SIGTERM first");
  const [k] = kids();
  assert.ok(k, "the broker started its codex app-server");
  assert.ok(await until(() => !alive(k.pid), 5000), "the child died with its group");
  await assertCleanedUp("ignored SIGTERM");
  assert.deepEqual(brokerStopEvents(), [], "nothing left, nothing to report");
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

test("H1: SIGTERM before broker.json exists still reaps the broker, found in the process table", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, STUB_SLEEP_MS: "30000", FAKE_NO_BROKER_JSON: "1" }, stdio: "ignore" });
  try {
    assert.ok(await until(() => fs.existsSync(env.BROKER_READY), 20_000), "the companion started its broker");
    const exited = new Promise((r) => child.once("exit", (_code, sig) => r(sig)));
    child.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM");
    const [b] = brokers();
    assert.ok(await until(() => !alive(b.pid), 5000), "the broker no registry names was reaped, not orphaned");
    assert.deepEqual(brokerLog(), ["sigterm"]);
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

test("H1: a broker.json naming another cxc-* dir neither redirects the shutdown nor deletes that dir", async () => {
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));
  try {
    fs.writeFileSync(path.join(decoy, "keep.txt"), "not the broker's");
    const r = round({ FAKE_DECOY_SESSION_DIR: decoy });
    assert.equal(r.code, 0, JSON.stringify(r.json));
    await assertCleanedUp("decoy");
    assert.ok(fs.existsSync(path.join(decoy, "keep.txt")), "a dir only broker.json names is never removed");
    assert.deepEqual(brokerLog(), ["shutdown"], "the shutdown went to the socket the broker's own args name");
  } finally {
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});

/** @param {number} pid */
function companionWritingPid(pid) {
  const base = env.REVIEW_LOOP_PLUGIN_BASE;
  const version = fs.readdirSync(base)[0];
  const script = path.join(base, version, "scripts", "codex-companion.mjs");
  const src = fs.readFileSync(script, "utf8");
  assert.ok(src.includes("sessionDir, pid: named }"), "the fake companion still writes broker.json the way this helper rewrites it");
  fs.writeFileSync(script, src.replace("sessionDir, pid: named }", `sessionDir, pid: ${pid} }`));
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
/** A round.sweep's code and outcome counts (its partition fields vary with the minute). @param {{ code: string, data: Record<string, number> }} e */
const outcome = (e) => [e.code, { swept: e.data.swept, brokers_left: e.data.brokers_left, failed: e.data.failed, unattributed: e.data.unattributed, incomplete: e.data.incomplete }];
const OK0 = { swept: 0, brokers_left: 0, failed: 0, unattributed: 0, incomplete: 0 };

/**
 * A round SIGKILLed mid-review (no finally, no reaper): its snapshot, its broker and the broker's cxc-* dir are left
 * behind. The orphaned companion (its own process group, asleep for 60 s) is killed here, while it is known to be ours.
 */
async function killedRound(extra = {}, opts = { keepCompanion: false }) {
  const companionPid = path.join(dir, `companion-${Date.now()}.pid`);
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, ...extra, STUB_SLEEP_MS: "60000", COMPANION_PID: companionPid }, stdio: "ignore" });
  const exited = new Promise((r) => child.once("exit", r));
  try {
    assert.ok(await until(() => fs.existsSync(env.BROKER_READY) && fs.existsSync(companionPid), 20_000), "the companion started its broker");
  } finally {
    child.kill("SIGKILL");
    await exited;
    if (fs.existsSync(companionPid)) {
      const pid = Number(fs.readFileSync(companionPid, "utf8"));
      if (opts.keepCompanion) reapAfter.push(pid);
      else signalPid(pid, "SIGKILL", { group: true });
    }
  }
  fs.rmSync(env.BROKER_READY);
  const [name, ...more] = snapshots();
  assert.equal(more.length, 0, "one snapshot left behind");
  const broker = brokers().at(-1);
  assert.ok(broker && alive(broker.pid), "its broker is left running");
  return { root: path.join(ws(), name), broker, owner: /** @type {number} */ (child.pid), companion: fs.existsSync(companionPid) ? Number(fs.readFileSync(companionPid, "utf8")) : 0 };
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
  assert.deepEqual(sweepEvents().map(outcome), [["ok", { ...OK0, swept: 1 }]]);
});

test("R2: a dead round's broker that will not stop keeps its snapshot for a later sweep, logged snapshot_sweep_incomplete", { timeout: 90_000 }, async () => {
  const left = await killedRound({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_IGNORE_SIGTERM: "1" });
  // Through the seam, SIGKILL is not sent, so the broker outlives the whole stop.
  assert.equal(round({ REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_KILL_NOOP: "1" }).code, 0);
  assert.ok(alive(left.broker.pid), "it ignored broker/shutdown and SIGTERM (afterEach reaps it)");
  assert.ok(brokerLog().includes("sigterm"), "the verified broker was sent SIGTERM");
  assert.deepEqual(snapshots(), [path.basename(left.root)], "its broker.json is kept, so the next sweep retries");
  assert.deepEqual(sweepEvents().map(outcome), [["snapshot_sweep_incomplete", { ...OK0, brokers_left: 1 }]]);
  assert.deepEqual(stopDetails().map((e) => [e.data.reason, e.data.left, e.data.snapshot]), [["members_left", 1, path.basename(left.root)]]);
});

test("R2: a snapshot whose owner is alive is never touched; a reused owner pid (another start time) counts as gone", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  const ownerFile = path.join(left.root, "owner.json");
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, started: startTime(process.pid) }));
  assert.equal(round().code, 0);
  assert.ok(alive(left.broker.pid), "a live owner's broker is left running (afterEach reaps it)");
  assert.ok(fs.existsSync(left.broker.sessionDir));
  assert.deepEqual(snapshots(), [path.basename(left.root)]);
  assert.deepEqual(sweepEvents().map(outcome), [["ok", OK0]], "nothing swept");
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
  assert.deepEqual(sweepEvents().map(outcome), [["ok", OK0]], "nothing swept");
});

test("R2: when ps cannot answer, a live-owner snapshot and an old legacy snapshot are both left alone", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  fs.writeFileSync(path.join(left.root, "owner.json"), JSON.stringify({ pid: process.pid, started: startTime(process.pid) }));
  const legacy = path.join(ws(), "plugin-legacy-old");
  fs.mkdirSync(legacy, { mode: 0o700 });
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(legacy, old, old);
  assert.equal(round(psSeam(tablePsFails())).code, 0);
  assert.ok(alive(left.broker.pid));
  for (const kept of [path.basename(left.root), "plugin-legacy-old"]) assert.ok(snapshots().includes(kept), `${kept} is left alone`);
  assert.deepEqual(sweepEvents().map((e) => [e.code, e.data.swept, e.data.incomplete]), [["snapshot_sweep_incomplete", 0, 1]], "nothing swept, and the sweep says it could not verify");
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
  assert.deepEqual(sweepEvents().map(outcome), [["ok", { ...OK0, swept: 1 }]]);
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
    assert.ok(sweepEvents().every((e) => e.code === "ok" && e.data.swept === 0), "nothing swept");
  } finally {
    owner.kill("SIGKILL");
  }
});


/** @param {Record<string, string>} extra @param {string} [spec] a spec path to review (default: a new repo's) */
function startRound(extra = {}, spec = specRepo()) {
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", spec], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; });
  const done = new Promise((r) => child.once("close", (code) => r({ code, json: stdout ? JSON.parse(stdout) : null })));
  return { child, done: /** @type {Promise<{ code: number | null, json: { [k: string]: unknown } | null }>} */ (done) };
}

test("B: a broker killed mid-round leaves its child and grandchild: never signalled (a gone pid proves nothing), the snapshot is kept and reported until they are gone", { timeout: 90_000 }, async () => {
  const r = startRound({ STUB_SLEEP_MS: "4000", FAKE_BROKER_CHILD: "2" });
  assert.ok(await until(() => fs.existsSync(env.BROKER_READY) && kids().length === 2, 20_000), "broker, child and grandchild started");
  signalPid(brokers()[0].pid, "SIGKILL");
  const res = await r.done;
  assert.equal(res.code, 0, JSON.stringify(res.json));
  for (const k of kids()) assert.ok(alive(k.pid), `${k.grand ? "grandchild" : "child"} ${k.pid} was not signalled`);
  assert.equal(snapshots().length, 1, "the snapshot is kept while they run");
  assert.deepEqual(stopDetails().map((e) => [e.data.reason, e.data.left, e.data.unattributed]), [["unattributed", 0, 2]]);
  for (const k of kids()) signalPid(k.pid, "SIGKILL");
  for (const k of kids()) assert.ok(await until(() => !alive(k.pid), 5000));
  assert.equal(round().code, 0);
  assert.deepEqual(snapshots(), [], "the next sweep removes it once they are gone");
});

test("B: a broker that exits on SIGTERM without closing its child still leaves nothing running", { timeout: 60_000 }, async () => {
  const r = round({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_TERM_LEAVES_CHILD: "1", FAKE_BROKER_CHILD: "1" });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  const [k] = kids();
  assert.ok(await until(() => !alive(k.pid), 5000), "the child it left behind was killed");
  await assertCleanedUp("term leaves child");
});

test("B: a broker that died before writing broker.json leaves a codex app-server that is never signalled; the snapshot is kept until it is gone", { timeout: 90_000 }, async () => {
  const r = startRound({ STUB_SLEEP_MS: "4000", FAKE_BROKER_CHILD: "1", FAKE_NO_BROKER_JSON: "1" });
  assert.ok(await until(() => fs.existsSync(env.BROKER_READY) && kids().length === 1, 20_000));
  signalPid(brokers()[0].pid, "SIGKILL");
  const res = await r.done;
  assert.equal(res.code, 0, JSON.stringify(res.json));
  const [k] = kids();
  assert.ok(alive(k.pid), "nothing ties it to this snapshot for sure, so it is not signalled");
  assert.equal(snapshots().length, 1, "and the snapshot is kept");
  assert.deepEqual(stopDetails().map((e) => [e.data.reason, e.data.left, e.data.unattributed]), [["unattributed", 0, 1]]);
  const marker = JSON.parse(fs.readFileSync(path.join(ws(), snapshots()[0], "companion.json"), "utf8"));
  const b = brokers()[0].pid;
  // A pid space that wrapped during the round (after < pid) leaves no window to check, by design.
  assert.ok(Number.isInteger(marker.pid) && Number.isInteger(marker.after), `the companion's pid window was recorded: ${JSON.stringify(marker)}`);
  if (marker.after > marker.pid) assert.ok(marker.pid < b && b < marker.after, `the window holds the broker: ${JSON.stringify(marker)} vs ${b}`);
  signalPid(k.pid, "SIGKILL");
  assert.ok(await until(() => !alive(k.pid), 5000));
  assert.equal(round().code, 0);
  assert.deepEqual(snapshots(), [], "the next sweep removes it once the process is gone");
  assert.ok(!fs.existsSync(brokers()[0].sessionDir), "and its cxc-* dir, which no broker.json named, went with it");
});

test("B: a live broker with no broker.json is found in the process table and stopped", { timeout: 60_000 }, async () => {
  const r = round({ FAKE_NO_BROKER_JSON: "1", FAKE_BROKER_CHILD: "1" });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.deepEqual(brokerLog(), ["shutdown"], "its own args name its socket, so it is asked to shut down");
  assert.ok(await until(() => !alive(kids()[0].pid), 5000));
  const [b] = brokers();
  assert.ok(await until(() => !alive(b.pid), 5000));
  assert.deepEqual(snapshots(), []);
  assert.ok(!fs.existsSync(b.sessionDir), "its cxc-* dir went with the snapshot");
});

test("B: a broker.json pid whose args merely contain the broker path is never signalled", { timeout: 60_000 }, async () => {
  const lookalike = path.join(dir, "lookalike.pid");
  const r = round({ LOOKALIKE_PID: lookalike });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  const pid = Number(fs.readFileSync(lookalike, "utf8"));
  reapAfter.push(pid);
  assert.ok(alive(pid), "`node -e … <root>/scripts/app-server-broker.mjs serve` is not the broker");
  assert.ok(await until(() => !alive(brokers()[0].pid), 5000), "the real broker, found in the table, was stopped");
  assert.deepEqual(snapshots(), []);
});

test("B: a broker that does not lead its own group is never signalled; the snapshot is kept and reported", { timeout: 60_000 }, async () => {
  const r = round({ FAKE_BROKER_NOT_DETACHED: "1", FAKE_BROKER_IGNORE_SHUTDOWN: "1" });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.ok(alive(brokers()[0].pid));
  assert.deepEqual(brokerLog(), []);
  assert.equal(snapshots().length, 1);
  assert.deepEqual(stopDetails().map((e) => e.data.reason), ["unknown_rows"]);
});

test("B: the companion starts strictly after the snapshot's creation second", { timeout: 90_000 }, async () => {
  for (let i = 0; i < 3; i++) {
    const start = path.join(dir, `start-${i}.json`);
    assert.equal(round({ COMPANION_START: start, REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_SNAPSHOT_AT_SECOND_START: "1" }).code, 0);
    const s = JSON.parse(fs.readFileSync(start, "utf8"));
    assert.ok(Math.floor(s.now / 1000) > Math.floor(s.birth / 1000), `round ${i}: ${s.now} vs ${s.birth}`);
  }
});

test("C: a round that returns early (already passed) still sweeps first", { timeout: 90_000 }, async () => {
  const spec = specRepo();
  assert.equal(spawnSync(process.execPath, [ROUND, "run", "--kind", "spec", "--path", spec], { env, encoding: "utf8" }).status, 0);
  const left = await killedRound();
  const before = brokers().length;
  const r = spawnSync(process.execPath, [ROUND, "run", "--kind", "spec", "--path", spec], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).status, "passed");
  assert.equal(brokers().length, before, "no companion ran");
  assert.ok(await until(() => !alive(left.broker.pid), 5000), "the dead round's broker was stopped");
  assert.deepEqual(snapshots(), []);
});

test("B2: a killed round's companion still running is stopped before its broker, then the snapshot removed", { timeout: 90_000 }, async () => {
  const left = await killedRound({}, { keepCompanion: true });
  assert.ok(alive(left.companion), "the companion outlived its round");
  assert.equal(round().code, 0);
  assert.ok(await until(() => !alive(left.companion) && !alive(left.broker.pid), 5000));
  assert.deepEqual(snapshots(), []);
});

test("D: `sweep` clears a dead round's snapshot and prints the documented result", { timeout: 90_000 }, async () => {
  await killedRound();
  const r = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(o), ["exit", "status", "swept", "brokers_left", "unattributed", "failed", "incomplete", "orphans_detected"]);
  assert.deepEqual(o, { exit: 0, status: "clean", swept: 1, brokers_left: 0, unattributed: 0, failed: 0, incomplete: false, orphans_detected: 0 });
  assert.deepEqual(snapshots(), []);
});

test("D: `sweep` exits 60 when a broker will not stop, and when ws/ cannot be listed", { timeout: 90_000 }, async () => {
  const left = await killedRound({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_IGNORE_SIGTERM: "1" });
  const r = spawnSync(process.execPath, [ROUND, "sweep"], { env: { ...env, REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_KILL_NOOP: "1" }, encoding: "utf8" });
  assert.equal(r.status, 60, r.stdout);
  assert.deepEqual([JSON.parse(r.stdout).status, JSON.parse(r.stdout).brokers_left], ["incomplete", 1]);
  signalPid(left.broker.pid, "SIGKILL");
  fs.chmodSync(ws(), 0o000);
  try {
    const r2 = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
    assert.equal(r2.status, 60, r2.stdout);
    assert.deepEqual([JSON.parse(r2.stdout).status, JSON.parse(r2.stdout).failed > 0], ["incomplete", true]);
  } finally {
    fs.chmodSync(ws(), 0o700);
  }
});

test("C: a lost round.broker_stop line is said on stderr, never silent", { timeout: 60_000 }, async () => {
  fs.mkdirSync(env.REVIEW_LOOP_STATE_DIR, { recursive: true, mode: 0o700 });
  const events = path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
  fs.writeFileSync(events, "", { mode: 0o400 });
  try {
    const r = spawnSync(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, ...psSeam(tablePsFails()) }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stderr, /review-loop: event_write_failed \{"event":"round\.broker_stop","code":"broker_stop_failed"/);
  } finally {
    fs.chmodSync(events, 0o600);
  }
});

test("units: brokerArgv matches only `<…/node> <root>/scripts/app-server-broker.mjs serve`", () => {
  const root = "/s/ws/plugin-AbC123";
  const script = `${root}/scripts/app-server-broker.mjs`;
  assert.equal(brokerArgv(`/opt/bin/node ${script} serve --endpoint unix:/t/x.sock`, [root]), root);
  assert.equal(brokerArgv(`/opt/bin/node ${script} serve`, ["/other", root]), root);
  for (const args of [
    `/opt/bin/node -e x ${script} serve`, `/bin/sh ${script} serve`, `/opt/bin/node ${script}`, `/opt/bin/node ${script} serves`,
    `/opt/bin/node /s/ws/plugin-XyZ789/scripts/app-server-broker.mjs serve`, `/opt/bin/node ${script}.bak serve`
  ]) assert.equal(brokerArgv(args, [root]), null, args);
});

test("units: parseProcRow reads ps's C-locale UTC row and refuses anything else", () => {
  const row = parseProcRow("  501 4242     1  4240 Mon Oct  5 09:04:01 2026     /x/codex app-server");
  assert.deepEqual(row, { uid: 501, pid: 4242, ppid: 1, pgid: 4240, lstart: "Mon Oct 5 09:04:01 2026", started: Date.UTC(2026, 9, 5, 9, 4, 1) / 1000, args: "/x/codex app-server" });
  for (const bad of ["", "UID PID", "501 x 1 2 Mon Oct  5 09:04:01 2026 a", "501 1 1 2 Mon Oct 99 09:04:01 2026 a", "501 1 1 2 lun. oct. 5 a"]) assert.equal(parseProcRow(bad), null, bad);
});

test("units: treeMembers keeps the group's later starts whatever their parent, sets same-second ones apart", () => {
  const p = (/** @type {number} */ pid, /** @type {number} */ pgid, /** @type {number} */ started, ppid = 1, uid = 501) => ({ uid, pid, ppid, pgid, lstart: String(started), started, args: "a" });
  const rows = [p(11, 10, 101), p(12, 10, 102, 11), p(13, 10, 100), p(14, 10, 99), p(15, 20, 105), p(16, 10, 103, 1, 0), p(17, 10, Number.NaN)];
  const t = treeMembers(rows, 10, 100, 501);
  assert.deepEqual(t.members.map((r) => r.pid), [11, 12], "later starts, the grandchild (parent 11) included");
  assert.deepEqual(t.unattributed.map((r) => r.pid), [13], "the snapshot's own second is ambiguous");
  assert.deepEqual(t.unknown.map((r) => r.pid), [17]);
});

test("units: deadGroupTargets kills only members already in the group at the first read; a pid reused since is never signalled", () => {
  const p = (/** @type {number} */ pid, /** @type {number} */ started, args = "a") => ({ uid: 501, pid, ppid: 1, pgid: 10, lstart: String(started), started, args });
  const first = [p(11, 101), p(12, 102)];
  // 11 is unchanged; 12 exited and its pid was reissued (other start); 13 joined the group after the first read.
  const now = [p(11, 101), p(12, 104, "b"), p(13, 105)];
  const t = deadGroupTargets(first, now, 10, 100, 501);
  assert.deepEqual(t.members.map((r) => r.pid), [11]);
  assert.deepEqual(t.unattributed.map((r) => r.pid).sort(), [12, 13]);
  assert.deepEqual(deadGroupTargets([], now, 10, 100, 501).members, [], "a group first seen after the first read: nothing");
});

test("units: sameMember differs on any of pid, start, group or args", () => {
  const a = { uid: 1, pid: 5, ppid: 1, pgid: 5, lstart: "x", started: 1, args: "a" };
  assert.ok(sameMember(a, { ...a, ppid: 9 }));
  for (const d of [{ pid: 6 }, { lstart: "y" }, { pgid: 6 }, { args: "b" }]) assert.ok(!sameMember(a, { ...a, ...d }), JSON.stringify(d));
});

test("units: partitionCount is a power of two leaving about `part` names per partition", () => {
  assert.deepEqual([0, 1, 16, 17, 33, 100, 65_536].map((n) => partitionCount(n)), [1, 1, 1, 2, 4, 8, 4096]);
  for (let n = 0; n <= 70_000; n += 7) {
    const p = partitionCount(n);
    assert.equal(p & (p - 1), 0, `n=${n}: ${p}`);
  }
});

test("units: isHeld reaches every snapshot within 2^K ticks however the count changes in between", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const hashes = Array.from({ length: 1000 }, (_, i) => hashOf(`plugin-${i}`));
  for (let seq = 0; seq < 200; seq++) {
    const t0 = Math.floor(rnd() * 100_000);
    const ps = Array.from({ length: 64 }, () => partitionCount(Math.floor(rnd() * 1025)));
    for (const h of hashes) assert.ok(ps.some((p, i) => isHeld(h, t0 + i, p)), `hash ${h} unreached from tick ${t0}`);
  }
  for (const p of [1, 4, 64]) for (const h of hashes.slice(0, 50)) assert.equal(Array.from({ length: p }, (_, i) => isHeld(h, i, p)).filter(Boolean).length, 1);
});

/**
 * A dead round's snapshot made by hand in `parent`: owner.json naming an exited pid and, unless `broker` is false, the
 * fake broker started from it strictly after the snapshot's second (detached, in broker.json).
 * @param {string} parent @param {{ broker?: boolean, env?: Record<string, string> }} [o]
 */
async function deadSnapshot(parent, o = {}) {
  const root = fs.mkdtempSync(path.join(parent, "plugin-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "app-server-broker.mjs"), BROKER);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify({ pid: gone, started: "Thu Jan 1 00:00:00 1970" }));
  if (o.broker === false) return { root, pid: 0 };
  await afterSnapshotSecond(root);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));
  const sock = path.join(sessionDir, "broker.sock");
  const b = spawn(process.execPath, [path.join(root, "scripts", "app-server-broker.mjs"), "serve", "--endpoint", `unix:${sock}`], { detached: true, stdio: "ignore", env: { ...env, ...o.env } });
  b.unref();
  const pid = /** @type {number} */ (b.pid);
  fs.appendFileSync(env.BROKER_PIDS, JSON.stringify({ pid, sessionDir }) + "\n");
  assert.ok(await until(() => fs.existsSync(sock), 5000));
  // As the real broker does at start (--pid-file).
  fs.writeFileSync(path.join(sessionDir, "broker.pid"), `${pid}\n`);
  const state = path.join(root, "data", "state", "r-fake");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "broker.json"), JSON.stringify({ endpoint: `unix:${sock}`, sessionDir, pid }));
  return { root, pid, sessionDir, registry: path.join(state, "broker.json") };
}

/** Runs `fn` with the engine's test seams set in this process. @param {Record<string, string>} seams @param {() => Promise<unknown>} fn */
async function withSeams(seams, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, { REVIEW_LOOP_TEST_SEAMS: "1", ...seams });
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("C: one partition per sweep, and every dead snapshot is reached within 2^K ticks while the directory changes", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-part");
  fs.mkdirSync(parent, { mode: 0o700 });
  for (let i = 0; i < 40; i++) await deadSnapshot(parent, { broker: false });
  const live = () => {
    const root = fs.mkdtempSync(path.join(parent, "plugin-"));
    fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify({ pid: process.pid, started: startTime(process.pid) }));
    return root;
  };
  /** @type {string[]} */
  const lives = [];
  const dead = () => fs.readdirSync(parent).filter((n) => !lives.includes(path.join(parent, n)));
  for (let t = 0; t < 64 && dead().length > 0; t++) {
    // Churn: the count moves between ticks, and with it the partition count (8 to 32 at 4 per partition).
    if (t % 3 === 0) for (let i = 0; i < 20; i++) lives.push(live());
    else if (t % 3 === 1) for (const r of lives.splice(0, 15)) fs.rmSync(r, { recursive: true });
    const before = dead();
    const res = await withSeams({ REVIEW_LOOP_TEST_SWEEP_PART: "4", REVIEW_LOOP_TEST_SWEEP_TICK: String(t) }, () => sweepStaleSnapshots(parent));
    assert.ok(res.held <= 16, `tick ${t}: held ${res.held}`);
    assert.equal(res.partition, t % res.partitions);
    const gone = before.filter((n) => !fs.existsSync(path.join(parent, n)));
    assert.ok(gone.every((n) => isHeld(hashOf(n), t, res.partitions)), `tick ${t}: only its partition was swept`);
  }
  assert.deepEqual(dead(), [], "every dead snapshot was reached within 64 ticks (P never exceeded 64)");
});

test("C: a sweep stops acting at its deadline; the first act always runs", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-deadline");
  fs.mkdirSync(parent, { mode: 0o700 });
  const stuck = { FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_IGNORE_SIGTERM: "1" };
  const made = [await deadSnapshot(parent, { env: stuck }), await deadSnapshot(parent, { env: stuck }), await deadSnapshot(parent, { env: stuck })];
  const t0 = performance.now();
  const res = await withSeams({ REVIEW_LOOP_TEST_KILL_NOOP: "1", REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { deadlineMs: 1000 }));
  const took = performance.now() - t0;
  assert.ok(took < 4500, `bounded by the deadline plus one stop's reads: ${Math.round(took)} ms`);
  assert.equal(res.incomplete, true);
  assert.ok(res.stops.length >= 1, "the first act ran");
  for (const m of made) assert.ok(fs.existsSync(m.root), "an unstopped snapshot is kept");
});

test("B: a leader whose re-check differs is not signalled, and the stop is unknown", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-recheck");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent, { env: { FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_IGNORE_SIGTERM: "1" } });
  const r = await withSeams({ REVIEW_LOOP_TEST_LEADER_RECHECK: "changed" }, () => stopCompanionBroker(s.root));
  assert.deepEqual([r.left, r.reason], [1, "unknown_rows"]);
  assert.ok(alive(s.pid), "no group signal on a changed identity");
  const r2 = await stopCompanionBroker(s.root);
  assert.deepEqual([r2.left, r2.reason], [0, null]);
  assert.ok(await until(() => !alive(s.pid), 3000));
});

test("B: companion.json and broker.json are read safely: a link, an oversized or extra-keyed file, or a broken registry signal nothing", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-safe");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent);
  const marker = path.join(s.root, "companion.json");
  const target = path.join(dir, "elsewhere.json");
  fs.writeFileSync(target, JSON.stringify({ pid: 2 }));
  for (const make of [
    () => fs.symlinkSync(target, marker),
    () => fs.writeFileSync(marker, " ".repeat(5 * 1024 * 1024)),
    () => fs.writeFileSync(marker, JSON.stringify({ pid: 5, other: 1 }))
  ]) {
    fs.rmSync(marker, { force: true });
    make();
    const r = await stopCompanionBroker(s.root);
    assert.deepEqual([r.left, r.reason], [1, "registry_unreadable"]);
    assert.ok(alive(s.pid));
  }
  fs.rmSync(marker, { force: true });
  const bj = path.join(s.root, "data", "state", "r-fake", "broker.json");
  const saved = fs.readFileSync(bj, "utf8");
  fs.writeFileSync(bj, "{");
  assert.deepEqual((await stopCompanionBroker(s.root)).reason, "registry_unreadable");
  assert.ok(alive(s.pid));
  fs.writeFileSync(bj, saved);
  assert.equal((await stopCompanionBroker(s.root)).left, 0);
});

test("B: a ps that exits 0 without a real table (empty, header only, garbage) is never read as 'no broker'", { timeout: 90_000 }, async () => {
  const bin = path.join(dir, "hollow-ps");
  fs.mkdirSync(bin);
  for (const [i, body] of ["", "  UID   PID  PPID  PGID STARTED ARGS\n", "x y z\n"].entries()) {
    fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "-A" ] && { printf '%s' ${JSON.stringify(body)}; exit 0; }; done\nexec /bin/ps "$@"\n`, { mode: 0o755 });
    const r = round({ ...psSeam(bin), FAKE_BROKER_IGNORE_SHUTDOWN: "1" });
    assert.equal(r.code, 0, JSON.stringify(r.json));
    const b = brokers().at(-1);
    assert.ok(b && alive(b.pid), `case ${i}: the broker was not signalled`);
    assert.equal(stopDetails().at(-1)?.data.reason, "ps_unavailable", `case ${i}`);
    assert.equal(snapshots().length, i + 1, `case ${i}: its snapshot is kept`);
  }
});

test("A: a round whose start time ps cannot read starts no companion and leaves no snapshot (snapshot_owner_unknown)", { timeout: 60_000 }, async () => {
  const bin = path.join(dir, "no-ps");
  fs.mkdirSync(bin);
  // Fails every read but the lock's own identity read (which this test is not about).
  fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\ncase "$*" in *"lstart=,command="*) exec /bin/ps "$@" ;; esac\nexit 2\n', { mode: 0o755 });
  const r = round(psSeam(bin));
  assert.equal(r.code, 30, JSON.stringify(r.json));
  assert.equal(r.json.error.code, "snapshot_owner_unknown");
  assert.deepEqual(brokers(), [], "no companion ran");
  assert.deepEqual(snapshots(), [], "and no snapshot is left that would never read as dead");
});

test("B: a broker gone before its stop: its cxc-* dir goes too, but only when it holds nothing but a broker's files", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-deaddir");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent);
  signalPid(s.pid, "SIGKILL");
  assert.ok(await until(() => !alive(s.pid), 3000));
  const r = await stopCompanionBroker(s.root);
  assert.deepEqual([r.left, r.unattributed], [0, 0]);
  assert.ok(!fs.existsSync(s.sessionDir), "the dead broker's session dir is removed");

  const t = await deadSnapshot(parent);
  signalPid(t.pid, "SIGKILL");
  assert.ok(await until(() => !alive(t.pid), 3000));
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));
  try {
    fs.writeFileSync(path.join(decoy, "keep.txt"), "not a broker's");
    fs.writeFileSync(t.registry, JSON.stringify({ endpoint: `unix:${path.join(decoy, "broker.sock")}`, sessionDir: decoy, pid: t.pid }));
    const r2 = await stopCompanionBroker(t.root);
    assert.deepEqual([r2.left, r2.unattributed], [0, 0]);
    assert.ok(fs.existsSync(path.join(decoy, "keep.txt")), "a dir holding anything else is never removed");
  } finally {
    fs.rmSync(decoy, { recursive: true, force: true });
  }

  // Broker-shaped dirs (nothing but a broker's files) that are not this dead broker's: one whose broker.pid names
  // another broker, one a live process still names as its socket. Both are kept.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));
  const inUse = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));
  const unbound = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-"));
  const user = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", "--", "--endpoint", `unix:${path.join(inUse, "broker.sock")}`], { stdio: "ignore" });
  try {
    assert.ok(await until(() => spawnSync("/bin/ps", ["-ww", "-o", "args=", "-p", String(user.pid)], { encoding: "utf8" }).stdout.includes(inUse), 3000), "the in-use dir's user is running");
    for (const [d, pidText] of [[other, "1"], [inUse, null], [unbound, "none"]]) {
      fs.writeFileSync(path.join(d, "broker.log"), "");
      if (pidText && pidText !== "none") fs.writeFileSync(path.join(d, "broker.pid"), pidText);
      const u = await deadSnapshot(parent);
      signalPid(u.pid, "SIGKILL");
      assert.ok(await until(() => !alive(u.pid), 3000));
      if (!pidText) fs.writeFileSync(path.join(d, "broker.pid"), String(u.pid));
      fs.writeFileSync(u.registry, JSON.stringify({ endpoint: `unix:${path.join(d, "broker.sock")}`, sessionDir: d, pid: u.pid }));
      const r3 = await stopCompanionBroker(u.root);
      assert.deepEqual([r3.left, r3.unattributed], [0, 0]);
      assert.ok(fs.existsSync(path.join(d, "broker.log")), `${{ 1: "another broker's", none: "an unbound" }[pidText ?? ""] ?? "an in-use"} broker-shaped dir is kept`);
    }
  } finally {
    user.kill("SIGKILL");
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(inUse, { recursive: true, force: true });
    fs.rmSync(unbound, { recursive: true, force: true });
  }
});

test("B: a broker.json pid alive as another process is never a group to empty, even when that process exits mid-stop", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-foreign");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent, { env: { FAKE_BROKER_IGNORE_SHUTDOWN: "1" } });
  // Not a broker: a detached leader with a child in its group (started after the snapshot's second), whose leader
  // exits while the stop is between its two table reads.
  const src = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(c.pid) + "\\n"); setTimeout(() => process.exit(0), 700);`;
  const foreign = spawn(process.execPath, ["-e", src], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const childPid = await new Promise((res) => foreign.stdout.once("data", (d) => res(Number(String(d).trim()))));
  try {
    fs.writeFileSync(s.registry, JSON.stringify({ endpoint: `unix:${path.join(s.sessionDir, "broker.sock")}`, sessionDir: s.sessionDir, pid: foreign.pid }));
    const r = await stopCompanionBroker(s.root);
    assert.ok(!alive(/** @type {number} */ (foreign.pid)) || foreign.exitCode !== null, "the foreign leader exited during the stop");
    assert.ok(alive(childPid), "its group's member was not SIGKILLed");
    assert.deepEqual([r.left, r.unattributed], [0, 0]);
    assert.ok(await until(() => !alive(s.pid), 3000), "the real broker was still stopped");
  } finally {
    signalPid(childPid, "SIGKILL");
  }
});

test("B: a dead companion whose group still has a member keeps its snapshot; the member is never signalled", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-companion-group");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent, { broker: false });
  await afterSnapshotSecond(s.root);
  // A detached leader (standing in for the companion) that leaves a child in its group and exits.
  const src = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(c.pid) + "\\n"); setTimeout(() => process.exit(0), 100);`;
  const leader = spawn(process.execPath, ["-e", src], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const childPid = await new Promise((res) => leader.stdout.once("data", (d) => res(Number(String(d).trim()))));
  try {
    await new Promise((res) => leader.once("exit", res));
    fs.writeFileSync(path.join(s.root, "companion.json"), JSON.stringify({ pid: leader.pid }));
    const res = await withSeams({ REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { all: true }));
    assert.deepEqual([res.swept, res.brokersLeft], [0, 1], JSON.stringify(res));
    assert.ok(fs.existsSync(s.root), "the snapshot is kept");
    assert.ok(alive(childPid), "the member was not signalled");
  } finally {
    signalPid(childPid, "SIGKILL");
  }
});

test("B: a state dir too long for a socket path gets a short private temp dir, removed with the snapshot", { timeout: 60_000 }, async () => {
  const long = path.join(path.dirname(env.REVIEW_LOOP_STATE_DIR), "x".repeat(60), "state");
  env.REVIEW_LOOP_STATE_DIR = long;
  const r = round();
  assert.equal(r.code, 0, JSON.stringify(r.json));
  const [b] = brokers();
  const tmpRoot = path.dirname(b.sessionDir);
  assert.match(path.basename(tmpRoot), /^rl-[A-Za-z0-9]{6}$/, `the broker's session dir was in a short private temp dir: ${b.sessionDir}`);
  assert.ok(!fs.existsSync(tmpRoot), "which went with the snapshot");
  assert.deepEqual(snapshots(), []);
  fs.rmSync(path.dirname(path.dirname(long)), { recursive: true, force: true });
});

test("B: a dead round's companion that exits on SIGTERM and leaves a child keeps its snapshot", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-companion-child");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent, { broker: false });
  await afterSnapshotSecond(s.root);
  const script = path.join(s.root, "scripts", "codex-companion.mjs");
  const kidFile = path.join(dir, "companion-kid.pid");
  // The child names itself only once its SIGTERM handler is in place.
  fs.writeFileSync(script, `import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.KID_FILE, String(process.pid)); setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`);
  // Started through a parent that exits at once, so it is reparented like a dead round's companion (never a zombie
  // of this test process, which a stop would still see as running).
  const launch = `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: "ignore", env: { ...process.env, KID_FILE: ${JSON.stringify(kidFile)} } }); c.unref(); process.stdout.write(String(c.pid));`;
  const companionPid = Number(spawnSync(process.execPath, ["-e", launch], { encoding: "utf8" }).stdout);
  reapAfter.push(companionPid);
  assert.ok(await until(() => fs.existsSync(kidFile) && fs.readFileSync(kidFile, "utf8").length > 0, 5000));
  const childPid = Number(fs.readFileSync(kidFile, "utf8"));
  try {
    const res = await withSeams({ REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { all: true }));
    assert.ok(await until(() => !alive(companionPid), 3000), "the companion was stopped");
    assert.deepEqual([res.swept, res.brokersLeft], [0, 1], JSON.stringify(res));
    assert.ok(fs.existsSync(s.root), "the snapshot is kept while its child runs");
    assert.ok(alive(childPid));
  } finally {
    signalPid(childPid, "SIGKILL");
  }
});

test("units: namesUpTo stops reading past its cap instead of listing the whole directory", () => {
  const d = path.join(dir, "many");
  fs.mkdirSync(d);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(d, `f${i}`), "");
  assert.equal(namesUpTo(d, 5), "too_large");
  assert.equal(namesUpTo(d, 200).length, 200);
  assert.equal(namesUpTo(d, 199), "too_large");
  assert.throws(() => namesUpTo(path.join(d, "absent"), 5), { code: "ENOENT" });
});

test("B: a dead broker's broker.pid that is a link is never followed: its dir is kept", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-pidlink");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent);
  signalPid(s.pid, "SIGKILL");
  assert.ok(await until(() => !alive(s.pid), 3000));
  const outside = path.join(dir, "outside.pid");
  fs.writeFileSync(outside, `${s.pid}\n`);
  fs.rmSync(path.join(s.sessionDir, "broker.pid"));
  fs.symlinkSync(outside, path.join(s.sessionDir, "broker.pid"));
  const r = await stopCompanionBroker(s.root);
  assert.deepEqual([r.left, r.unattributed], [0, 0]);
  assert.ok(fs.existsSync(s.sessionDir), "a pid file that is a link binds nothing");
});

test("B: a ps on PATH is never consulted for broker identity: a shim that fails every read changes nothing", { timeout: 60_000 }, async () => {
  const bin = path.join(dir, "path-ps");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  const r = round({ PATH: `${bin}:${env.PATH}`, FAKE_BROKER_IGNORE_SHUTDOWN: "1" });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  await assertCleanedUp("PATH ps");
  assert.deepEqual(brokerLog(), ["sigterm"], "identity came from /bin/ps, so the broker was matched and stopped");
});
