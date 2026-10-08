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
import { processIdent } from "../../plugin/engine/lib/proc.mjs";
import {
  afterSnapshotSecond, brokerArgv, deadGroupTargets, namesUpTo, removeSnapshot, SWEEP_LIST_MAX, companionTmp, goneGroupsLeft, hashOf, isHeld, parseProcRow, partitionCount, runCompanion, sameMember, stopCompanionBroker, sweepStaleSnapshots, treeMembers
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
  // A dir in the snapshot that cannot be emptied: the round's own cleanup of it throws (EACCES).
  if (process.env.FAKE_COMPANION_LOCK_SNAPSHOT === "1") { const l = path.join(path.dirname(import.meta.dirname), "locked"); fs.mkdirSync(l); fs.writeFileSync(path.join(l, "f"), "x"); fs.chmodSync(l, 0o500); }
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

/**
 * A `ps` whose table reads add, for every group whose leader is gone, a row holding the leader's pid in another group:
 * what a reissued pid looks like.
 */
function reusedLeaderPs() {
  const bin = path.join(dir, "reused-leader-ps");
  fs.mkdirSync(bin, { recursive: true });
  const awk = '{ print; pid[$2] = 1; if ($4 != $2) { g[$4] = $1 } } END { for (k in g) if (!(k in pid) && k > 1) printf "%5d %5d     1     1 Thu Jan  1 00:00:00 2026 /usr/bin/true reused\\n", g[k], k }';
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\ncase " $* " in *" -A "*) /bin/ps "$@" | /usr/bin/awk '${awk}'; exit 0;; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return bin;
}

/**
 * A `ps` whose table leaves out the `codex app-server` rows of other test files running at the same time (theirs are
 * outside this test's dir). The leaderless-app-server rule counts any of this user's in the companion's pid window, so
 * another file's fake would keep this file's snapshot (correctly, for one sweep) and make the sweep's outcome depend
 * on what else runs. Every other row, this file's own app-servers included, passes through.
 */
function ownAppServersPs() {
  const bin = path.join(dir, "own-app-servers-ps");
  fs.mkdirSync(bin, { recursive: true });
  const awk = `{ if ($0 ~ /codex app-server$/ && index($0, "${path.basename(dir)}") == 0) next; print }`;
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\ncase " $* " in *" -A "*) /bin/ps "$@" | /usr/bin/awk '${awk}'; exit 0;; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  return bin;
}

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

test("H1: SIGTERM when the broker shows in the table only after the reaper's first read: a later read still reaps it", { timeout: 60_000 }, async () => {
  const bin = path.join(dir, "late-broker-ps");
  fs.mkdirSync(bin, { recursive: true });
  const arm = path.join(bin, "arm");
  // Armed by the test just before the signal: the next table read (the reaper's first) leaves out every broker row.
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\ncase " $* " in *" -A "*) if [ -e ${arm} ]; then rm -f ${arm}; /bin/ps "$@" | /usr/bin/grep -v app-server-broker; exit 0; fi;; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, ...psSeam(bin), STUB_SLEEP_MS: "30000", FAKE_NO_BROKER_JSON: "1" }, stdio: "ignore" });
  try {
    assert.ok(await until(() => fs.existsSync(env.BROKER_READY), 20_000), "the companion started its broker");
    fs.writeFileSync(arm, "");
    const exited = new Promise((r) => child.once("exit", (_code, sig) => r(sig)));
    child.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM");
    assert.ok(!fs.existsSync(arm), "the reaper's first read was the one that missed it");
    const [b] = brokers();
    assert.ok(await until(() => !alive(b.pid), 5000), "the broker the first read missed was reaped, not orphaned");
    assert.deepEqual(brokerLog(), ["sigterm"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("H1: SIGTERM when the reaper's first table read fails: a later read still reaps the registered broker", { timeout: 60_000 }, async () => {
  const bin = path.join(dir, "fail-once-ps");
  fs.mkdirSync(bin, { recursive: true });
  const arm = path.join(bin, "arm");
  // Armed by the test just before the signal: the next table read (the reaper's first) fails.
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\ncase " $* " in *" -A "*) if [ -e ${arm} ]; then rm -f ${arm}; exit 1; fi;; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, ...psSeam(bin), STUB_SLEEP_MS: "30000" }, stdio: "ignore" });
  try {
    assert.ok(await until(() => fs.existsSync(env.BROKER_READY), 20_000), "the companion started its broker");
    fs.writeFileSync(arm, "");
    const exited = new Promise((r) => child.once("exit", (_code, sig) => r(sig)));
    child.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM");
    assert.ok(!fs.existsSync(arm), "the reaper's first read was the one that failed");
    const [b] = brokers();
    assert.ok(await until(() => !alive(b.pid), 5000), "a failed read decided nothing: the next one reaped the broker");
    assert.deepEqual(brokerLog(), ["sigterm"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("H1: the signal path asks ps about a pid alone only once a table read matched it, however many pids broker.json names, and starts no read after its budget", { timeout: 60_000 }, async () => {
  const bin = path.join(dir, "slow-ps");
  fs.mkdirSync(bin, { recursive: true });
  const arm = path.join(bin, "arm");
  const calls = path.join(bin, "calls");
  // Once armed, every ps call is logged and each table read takes 1.5 s (under ps's 2 s timeout): a second read ends
  // past the 3 s budget, so a third must never start.
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\nif [ -e ${arm} ]; then echo "$*" >> ${calls}; case " $* " in *" -A "*) /bin/sleep 1.5;; esac; fi\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, ...psSeam(bin), STUB_SLEEP_MS: "30000" }, stdio: "ignore" });
  try {
    assert.ok(await until(() => fs.existsSync(env.BROKER_READY), 20_000), "the companion started its broker");
    assert.ok(await until(() => snapshots().length === 1, 5000));
    const state = path.join(ws(), snapshots()[0], "data", "state");
    // Filled to the registry's 32-entry cap with the companion's own: each names a live pid that is not a broker.
    for (let i = 0; i < 31; i++) {
      fs.mkdirSync(path.join(state, `extra-${i}`), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(state, `extra-${i}`, "broker.json"), JSON.stringify({ endpoint: "unix:/nonexistent", sessionDir: "/nonexistent", pid: process.pid }));
    }
    fs.writeFileSync(arm, "");
    const exited = new Promise((r) => child.once("exit", (_code, sig) => r(sig)));
    child.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM");
    const log = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean);
    const [b] = brokers();
    const tables = log.filter((l) => / -A /.test(` ${l} `));
    assert.deepEqual(log.filter((l) => !tables.includes(l)).map((l) => l.split(" ").slice(-2).join(" ")), [`-p ${b.pid}`], "one per-pid ps, for the matched broker, none for the 31 entries");
    assert.equal(tables.length, 2, `two table reads fit the budget, a third never starts: ${JSON.stringify(log)}`);
    assert.ok(await until(() => !alive(b.pid), 5000), "the broker was reaped from the first read");
    assert.deepEqual(brokerLog(), ["sigterm"], "and nothing the extra entries named was signalled");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("H1: a broker the signal path's table read matched but whose pid is another process by the signal is never signalled", { timeout: 60_000 }, async () => {
  const bin = path.join(dir, "reused-ps");
  fs.mkdirSync(bin, { recursive: true });
  const arm = path.join(bin, "arm");
  // Once armed, a single-pid ps answers as if the broker had exited and its pid been reused by another command.
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\nif [ -e ${arm} ]; then case " $* " in *" -p "*) /bin/ps "$@" | /usr/bin/sed s/app-server-broker/app-server-reused/; exit 0;; esac; fi\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [ROUND, "run", "--kind", "spec", "--path", specRepo()], { env: { ...env, ...psSeam(bin), STUB_SLEEP_MS: "30000" }, stdio: "ignore" });
  let b;
  try {
    assert.ok(await until(() => fs.existsSync(env.BROKER_READY), 20_000), "the companion started its broker");
    fs.writeFileSync(arm, "");
    const exited = new Promise((r) => child.once("exit", (_code, sig) => r(sig)));
    child.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM");
    [b] = brokers();
    assert.ok(!(await until(() => !alive(b.pid), 1500)), "a pid that is another process by the signal is not signalled");
    assert.deepEqual(brokerLog(), []);
    assert.equal(snapshots().length, 1, "the snapshot is kept for the next sweep");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (b) signalPid(b.pid, "SIGKILL", { group: true });
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

/** A pre-1.0.4 snapshot as snapshotVerified left it: no owner.json, the pinned files and plugin.json copied in. @param {string} d */
function legacySnapshot(d) {
  const pin = JSON.parse(fs.readFileSync(env.REVIEW_LOOP_PIN_FILE, "utf8"));
  for (const rel of [...Object.keys(pin.files), path.join(".claude-plugin", "plugin.json")]) {
    fs.mkdirSync(path.join(d, path.dirname(rel)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(d, rel), "");
  }
}
/** @param {number} pid a process's start time as the engine records it (ps lstart, C locale, UTC) */
const startTime = (pid) => spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).stdout.trim().replace(/\s+/g, " ");
/** owner.json naming `pid` as snapshotVerified writes it: pid, start time, full identity. @param {number} pid */
const liveOwner = (pid) => JSON.stringify({ pid, started: startTime(pid), ident: processIdent(pid) });
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
  assert.match(owner.key, /^[0-9a-f]{24}$/, "and the round's artifact key, for a later sweep's events");
  assert.equal(fs.statSync(path.join(left.root, "owner.json")).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(left.root, "data", "state")), "Codex's job files are still there");
  const r = round(psSeam(ownAppServersPs()));
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.ok(await until(() => !alive(left.broker.pid), 5000), "the dead round's broker is stopped");
  assert.equal(brokerLog().filter((l) => l === "shutdown").length, 2, "both brokers were asked to shut down, neither signalled");
  const why = () => JSON.stringify({ sweep: sweepEvents().map((e) => [e.code, e.data]), stops: stopDetails().map((e) => e.data), log: brokerLog() });
  assert.ok(!fs.existsSync(left.broker.sessionDir), `its cxc-* session dir is removed: ${why()}`);
  assert.deepEqual(snapshots(), [], `its snapshot (and the job files in it) is removed: ${why()}`);
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
  fs.writeFileSync(ownerFile, liveOwner(process.pid));
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

test("R2: a pid reused within the owner's start second (same lstart, another identity) counts as gone, not as the owner", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  fs.writeFileSync(path.join(left.root, "owner.json"), JSON.stringify({ pid: process.pid, started: startTime(process.pid), ident: "0".repeat(64) }));
  assert.equal(round().code, 0);
  assert.ok(await until(() => !alive(left.broker.pid), 5000), "the owner's identity, not its second, names it");
  assert.deepEqual(snapshots(), []);
});

test("R2: a live owner.json without an identity cannot be judged past its second: unverified, left alone", { timeout: 60_000 }, async () => {
  const snap = path.join(ws(), "plugin-NoId01");
  fs.mkdirSync(snap, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(snap, "owner.json"), JSON.stringify({ pid: process.pid, started: startTime(process.pid) }));
  const r = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  assert.deepEqual([r.status, JSON.parse(r.stdout).unverified], [60, 1], r.stdout);
  assert.ok(fs.existsSync(path.join(snap, "owner.json")));
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
  // Nothing swept, and the entry it could not judge is said: unverified, so the sweep is not clean.
  assert.deepEqual(sweepEvents().map(outcome), [["snapshot_sweep_incomplete", OK0]], "nothing swept");
  assert.deepEqual(sweepEvents().map((e) => [e.data.in_use, e.data.unverified]), [[0, 1]]);
});

test("R2: when ps cannot answer, a live-owner snapshot and an old legacy snapshot are both left alone", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  fs.writeFileSync(path.join(left.root, "owner.json"), liveOwner(process.pid));
  const legacy = path.join(ws(), "plugin-LegOld");
  legacySnapshot(legacy);
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(legacy, old, old);
  assert.equal(round(psSeam(tablePsFails())).code, 0);
  assert.ok(alive(left.broker.pid));
  for (const kept of [path.basename(left.root), "plugin-LegOld"]) assert.ok(snapshots().includes(kept), `${kept} is left alone`);
  assert.deepEqual(sweepEvents().map((e) => [e.code, e.data.swept, e.data.incomplete]), [["snapshot_sweep_incomplete", 0, 1]], "nothing swept, and the sweep says it could not verify");
});

test("R2: a legacy snapshot (no owner file) is swept only when older than 24 h and named by no live process", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  fs.rmSync(path.join(left.root, "owner.json"));
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(left.root, old, old);
  const unused = path.join(ws(), "plugin-LegUnu");
  const fresh = path.join(ws(), "plugin-LegFrs");
  for (const d of [unused, fresh]) legacySnapshot(d);
  fs.utimesSync(unused, old, old);
  assert.equal(round().code, 0);
  assert.ok(alive(left.broker.pid), "a legacy snapshot a live broker's args name is left, broker and all");
  assert.deepEqual(snapshots(), [path.basename(left.root), "plugin-LegFrs"].sort(), "only the old, unreferenced one is swept");
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

test("B: a broker that exits on SIGTERM leaving a child, its pid then held by another process, still leaves nothing running", { timeout: 60_000 }, async () => {
  const r = round({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_TERM_LEAVES_CHILD: "1", FAKE_BROKER_CHILD: "1", ...psSeam(reusedLeaderPs()) });
  assert.equal(r.code, 0, JSON.stringify(r.json));
  const [k] = kids();
  assert.ok(await until(() => !alive(k.pid), 5000), "a reissued leader pid did not hide the child it left behind");
  await assertCleanedUp("reused leader pid");
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

test("B: a broker that died before writing broker.json, its pid then held by another process: its app-server still keeps the snapshot, and the sweep says so", { timeout: 90_000 }, async () => {
  const seam = psSeam(reusedLeaderPs());
  const r = startRound({ STUB_SLEEP_MS: "4000", FAKE_BROKER_CHILD: "1", FAKE_NO_BROKER_JSON: "1", ...seam });
  assert.ok(await until(() => fs.existsSync(env.BROKER_READY) && kids().length === 1, 20_000));
  signalPid(brokers()[0].pid, "SIGKILL");
  const res = await r.done;
  const [k] = kids();
  try {
    assert.equal(res.code, 0, JSON.stringify(res.json));
    assert.ok(alive(k.pid), "never signalled");
    assert.equal(snapshots().length, 1, "a reissued leader pid did not make its group look led: the snapshot is kept");
    assert.deepEqual(stopDetails().map((e) => [e.code, e.data.reason, e.data.left, e.data.unattributed]), [["broker_stop_failed", "unattributed", 0, 1]]);
    const sweep = spawnSync(process.execPath, [ROUND, "sweep"], { env: { ...env, ...seam }, encoding: "utf8" });
    assert.equal(sweep.status, 60, sweep.stdout);
    assert.deepEqual([JSON.parse(sweep.stdout).status, JSON.parse(sweep.stdout).unattributed], ["incomplete", 1]);
    const lines = fs.readFileSync(path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.filter((e) => e.event === "round.sweep").slice(-1).map((e) => [e.code, e.data.unattributed]), [["snapshot_sweep_incomplete", 1]]);
  } finally {
    signalPid(k.pid, "SIGKILL");
  }
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
  assert.deepEqual(Object.keys(o), ["exit", "status", "swept", "brokers_left", "unattributed", "failed", "incomplete", "orphans_detected", "in_use", "unverified"]);
  assert.deepEqual(o, { exit: 0, status: "clean", swept: 1, brokers_left: 0, unattributed: 0, failed: 0, incomplete: false, orphans_detected: 0, in_use: 0, unverified: 0 });
  assert.deepEqual(snapshots(), []);
  // Its orphan check is an event either way: verified and clean, then (no process table) unverified.
  const r2 = spawnSync(process.execPath, [ROUND, "sweep"], { env: { ...env, ...psSeam(tablePsFails()) }, encoding: "utf8" });
  assert.equal(r2.status, 60, r2.stdout);
  const orphanEvents = fs.readFileSync(path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "round.orphans");
  assert.deepEqual(orphanEvents.map((e) => [e.code, e.data.verified, e.data.count]), [["ok", 1, 0], ["orphaned_brokers", 0, 0]]);
});

test("D: `sweep` exits 60 when a broker will not stop, and when ws/ cannot be listed", { timeout: 90_000 }, async () => {
  const left = await killedRound({ FAKE_BROKER_IGNORE_SHUTDOWN: "1", FAKE_BROKER_IGNORE_SIGTERM: "1" });
  const origin = JSON.parse(fs.readFileSync(path.join(left.root, "owner.json"), "utf8")).key;
  const r = spawnSync(process.execPath, [ROUND, "sweep"], { env: { ...env, REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_KILL_NOOP: "1" }, encoding: "utf8" });
  assert.equal(r.status, 60, r.stdout);
  assert.deepEqual([JSON.parse(r.stdout).status, JSON.parse(r.stdout).brokers_left], ["incomplete", 1]);
  // The manual sweep has no artifact of its own: the kept snapshot's event names the review that left it.
  assert.deepEqual(stopDetails().slice(-1).map((e) => e.artifact_key), [origin]);
  // And the same hook.error a round's own stop logs, so a consumer counting failures sees this one too.
  const errors = fs.readFileSync(path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "hook.error" && e.code === "broker_stop_failed");
  assert.deepEqual(errors.slice(-1).map((e) => e.artifact_key), [origin]);
  assert.match(origin, /^[0-9a-f]{24}$/);
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
    fs.writeFileSync(path.join(root, "owner.json"), liveOwner(process.pid));
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

test("B: companion.json and broker.json are read safely: a link, an oversized or extra-keyed file, or a linked or oversized registry signal nothing", { timeout: 60_000 }, async () => {
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
  // A linked or oversized broker.json stays fail closed. (A damaged one is set aside instead: see "a damaged
  // broker.json (cut short, or the wrong shape) is set aside".)
  for (const make of [() => fs.symlinkSync(target, bj), () => fs.writeFileSync(bj, " ".repeat(5 * 1024 * 1024))]) {
    fs.rmSync(bj, { force: true });
    make();
    assert.deepEqual((await stopCompanionBroker(s.root)).reason, "registry_unreadable");
    assert.ok(alive(s.pid));
    assert.ok(fs.readdirSync(path.dirname(bj)).every((n) => !n.startsWith("broker.json.corrupt-")), "never set aside");
  }
  fs.rmSync(bj, { force: true });
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

test("B: a broker gone before its stop: broker.json's word never removes a dir outside the snapshot, broker-shaped or not", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-deaddir");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent);
  signalPid(s.pid, "SIGKILL");
  assert.ok(await until(() => !alive(s.pid), 3000));
  const r = await stopCompanionBroker(s.root);
  assert.deepEqual([r.left, r.unattributed], [0, 0]);
  assert.ok(fs.existsSync(s.sessionDir), "even its own-looking session dir: nothing binds broker.json's claim to it");
  fs.rmSync(s.sessionDir, { recursive: true, force: true });

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

test("B: a broker.json pid since held by a process in another group still has the broker's old group counted", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-registry-reissued");
  fs.mkdirSync(parent, { mode: 0o700 });
  const before = kids().length;
  const s = await deadSnapshot(parent, { env: { FAKE_BROKER_CHILD: "2" } });
  assert.ok(await until(() => kids().length === before + 2, 10_000), "the broker started its app-server and grandchild");
  const mine = kids().slice(before);
  const app = /** @type {{ pid: number }} */ (mine.find((k) => !k.grand));
  const grand = /** @type {{ pid: number }} */ (mine.find((k) => k.grand));
  // Only a member no app-server rule recognises (`sleep`) is left, so nothing but the registry pid's group counts it.
  for (const pid of [s.pid, app.pid]) signalPid(pid, "SIGKILL");
  assert.ok(await until(() => !alive(s.pid) && !alive(app.pid), 3000));
  try {
    // The fake ps shows the dead broker's pid held by a newcomer in another group, its grandchild still in the old one.
    const r = await withSeams(psSeam(reusedLeaderPs()), () => stopCompanionBroker(s.root));
    assert.equal(r.unattributed, 1, `the old group's member is counted, so the snapshot stays: ${JSON.stringify(r)}`);
    assert.ok(alive(grand.pid), "and never signalled");
  } finally {
    signalPid(grand.pid, "SIGKILL");
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

test("D: `sweep` is clean beside a live round's snapshot, and incomplete beside one whose owner cannot be read", { timeout: 60_000 }, async () => {
  const live = path.join(ws(), "plugin-Live01");
  fs.mkdirSync(live, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(live, "owner.json"), liveOwner(process.pid));
  const a = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  assert.equal(a.status, 0, a.stdout);
  assert.deepEqual([JSON.parse(a.stdout).status, JSON.parse(a.stdout).in_use, JSON.parse(a.stdout).unverified], ["clean", 1, 0]);
  const odd = path.join(ws(), "plugin-Odd001");
  fs.mkdirSync(odd, { mode: 0o700 });
  // A live pid whose start time is not a string: its owner cannot be told apart.
  fs.writeFileSync(path.join(odd, "owner.json"), JSON.stringify({ pid: process.pid, started: 0 }));
  const b = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  assert.equal(b.status, 60, b.stdout);
  assert.deepEqual([JSON.parse(b.stdout).status, JSON.parse(b.stdout).in_use, JSON.parse(b.stdout).unverified], ["incomplete", 1, 1]);
  const ev = fs.readFileSync(path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "round.sweep");
  assert.deepEqual(ev.slice(-1).map((e) => [e.code, e.data.in_use, e.data.unverified]), [["snapshot_sweep_incomplete", 1, 1]]);
  assert.ok(fs.existsSync(live) && fs.existsSync(odd), "neither is touched");
});

test("B: a dead round's companion that ignores SIGTERM is not SIGKILLed once the sweep's budget is spent", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-companion-deadline");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent, { broker: false });
  await afterSnapshotSecond(s.root);
  const script = path.join(s.root, "scripts", "codex-companion.mjs");
  const ready = path.join(dir, "companion-deadline.ready");
  fs.writeFileSync(script, `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1000);`.replace('require("node:fs")', '(await import("node:fs")).default'));
  const launch = `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(script)}], { detached: true, stdio: "ignore" }); c.unref(); process.stdout.write(String(c.pid));`;
  const companionPid = Number(spawnSync(process.execPath, ["-e", launch], { encoding: "utf8" }).stdout);
  reapAfter.push(companionPid);
  assert.ok(await until(() => fs.existsSync(ready), 5000));
  try {
    // The budget runs out while the stop waits on SIGTERM.
    const res = await withSeams({ REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { all: true, deadlineMs: 1200 }));
    assert.ok(alive(companionPid), "no SIGKILL after the deadline");
    assert.deepEqual(res.stops.map((st) => st.reason), ["deadline"], JSON.stringify(res));
    assert.ok(fs.existsSync(s.root), "and the snapshot is kept for the next sweep");
  } finally {
    signalPid(companionPid, "SIGKILL", { group: true });
  }
});

test("B: a snapshot whose data/state is a link to an empty dir is an unreadable registry: nothing is signalled", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-state-link");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent);
  const state = path.dirname(path.dirname(s.registry));
  const empty = path.join(dir, "empty-state");
  fs.mkdirSync(empty);
  fs.renameSync(state, path.join(dir, "real-state"));
  fs.symlinkSync(empty, state);
  try {
    const r = await stopCompanionBroker(s.root);
    assert.equal(r.reason, "registry_unreadable", JSON.stringify(r));
    assert.ok(alive(s.pid), "its broker was not signalled on the say-so of a linked registry");
  } finally {
    signalPid(s.pid, "SIGKILL", { group: true });
  }
});

test("D: a live owner whose start time is corrupt is unverified, never taken for dead: its snapshot is untouched", { timeout: 60_000 }, async () => {
  const snap = path.join(ws(), "plugin-Garb01");
  fs.mkdirSync(snap, { recursive: true, mode: 0o700 });
  for (const started of ["garbage", "Thu Jan 1 00:00:00", "Xyz Jan 1 00:00:00 2026", "Mon Feb 30 10:00:00 2026", "Fri Jan 1 00:00:00 2026"]) {
    fs.writeFileSync(path.join(snap, "owner.json"), JSON.stringify({ pid: process.pid, started }));
    const r = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
    assert.equal(r.status, 60, r.stdout);
    assert.deepEqual([JSON.parse(r.stdout).swept, JSON.parse(r.stdout).unverified], [0, 1], `${started}: ${r.stdout}`);
    assert.ok(fs.existsSync(path.join(snap, "owner.json")), `${started}: the live round's snapshot is left alone`);
  }
});

test("R2: an aged snapshot whose owner.json is too damaged to name anyone goes by the legacy rule and is swept; a fresh one is left alone", { timeout: 60_000 }, async () => {
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  /** @param {string} name @param {string} body @param {boolean} aged */
  const at = (name, body, aged) => {
    const d = path.join(ws(), name);
    legacySnapshot(d);
    fs.writeFileSync(path.join(d, "owner.json"), body);
    if (aged) fs.utimesSync(d, old, old);
    return d;
  };
  const aged = [at("plugin-Dmg001", '{"pid":', true), at("plugin-Dmg002", JSON.stringify({ pid: "x" }), true)];
  const fresh = at("plugin-Dmg003", '{"pid":', false);
  const r = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.swept, out.unverified], [2, 1], r.stdout);
  for (const d of aged) assert.ok(!fs.existsSync(d), `${path.basename(d)}: a killed round's aged snapshot is not stranded by its damaged owner.json`);
  assert.ok(fs.existsSync(path.join(fresh, "owner.json")), "a fresh damaged owner could still be a live round: left alone");
});

test("H1: a link in place of the snapshot's data/ or tmp/ is refused before the companion starts, never written through", { timeout: 60_000 }, async (t) => {
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  for (const name of ["data", "tmp"]) {
    // Short enough that the companion's temp dir is <root>/tmp, not the short-dir fallback.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rl-l"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.ok(Buffer.byteLength(path.join(root, "tmp", "cxc-XXXXXX", "broker.sock")) <= 103, "the in-snapshot temp dir fits");
    fs.symlinkSync(outside, path.join(root, name));
    const run = name === "data" ? () => runCompanion(root, { cwd: root, targetArgs: [], focus: "", codex: { model: null, effort: null, source: "config", passModel: null }, timeoutMs: 5000 }) : async () => companionTmp(root);
    await assert.rejects(run, (e) => /** @type {{ code?: string }} */ (e).code === "state_symlink_rejected", `${name}: refused`);
    assert.deepEqual(fs.readdirSync(outside), [], `${name}: nothing made through the link`);
  }
});

test("C: a sweep step that throws is reported on its snapshot, by step (failed_remove), and keeps it", { timeout: 60_000 }, async (t) => {
  const parent = path.join(dir, "ws-step-fail");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent, { broker: false });
  const rm = fs.rmSync;
  t.mock.method(fs, "rmSync", (/** @type {Parameters<typeof fs.rmSync>} */ ...a) => {
    if (a[0] === s.root) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    return rm(...a);
  });
  try {
    const res = await withSeams({ REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { all: true }));
    assert.deepEqual(res.stops.map((st) => [st.snapshot, st.reason]), [[path.basename(s.root), "failed_remove"]], JSON.stringify(res));
    assert.equal(res.failed, 1);
    assert.ok(fs.existsSync(s.root), "the snapshot is kept for the next sweep");
  } finally {
    t.mock.restoreAll();
  }
});

test("R2: a ws/plugin-* directory not shaped like a snapshot (plugin-old, plugin-backup-2026) is never swept, however old", { timeout: 60_000 }, async () => {
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  const theirs = ["plugin-old", "plugin-backup-2026"].map((name) => {
    const d = path.join(ws(), name);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(d, "keep.txt"), "the user's");
    fs.utimesSync(d, old, old);
    return d;
  });
  const r = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  assert.equal(JSON.parse(r.stdout).swept, 0, r.stdout);
  for (const d of theirs) assert.ok(fs.existsSync(path.join(d, "keep.txt")), `${path.basename(d)}: a name snapshotVerified never makes is not a snapshot`);
});

test("R2: a sweep step that throws on a real error (EACCES) emits hook.error as well as its round.broker_stop", { timeout: 60_000 }, async () => {
  const snap = path.join(ws(), "plugin-Lock01");
  legacySnapshot(snap);
  // A pinned dir made read-only: still all snapshot files, but its entries cannot be unlinked.
  const locked = path.join(snap, "scripts", "lib");
  assert.ok(fs.readdirSync(locked).length > 0, "the pin has files under scripts/lib");
  fs.chmodSync(locked, 0o500);
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(snap, old, old);
  try {
    const r = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
    assert.notEqual(r.status, 0, r.stdout);
    assert.deepEqual(stopDetails().map((e) => [e.data.snapshot, e.data.reason]), [["plugin-Lock01", "failed_remove"]]);
    assert.equal(brokerStopEvents().length, 1, "a step that threw counted nothing, so it is still said as a failure");
    assert.ok(fs.existsSync(snap), "the snapshot is kept for the next sweep");
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("R2: an old owner-less dir named exactly like a snapshot is swept only when it holds nothing but a snapshot's files", { timeout: 60_000 }, async () => {
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  const at = (/** @type {string} */ name) => path.join(ws(), name);
  const userFile = (/** @type {string} */ d) => fs.writeFileSync(path.join(d, "keep.txt"), "the user's");
  fs.mkdirSync(at("plugin-Decoy1"), { recursive: true, mode: 0o700 });
  userFile(at("plugin-Decoy1"));
  // The two files a layout check would look for, around a user file.
  fs.mkdirSync(path.join(at("plugin-Decoy2"), "scripts"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(at("plugin-Decoy2"), "scripts", "codex-companion.mjs"), "");
  userFile(at("plugin-Decoy2"));
  // Every pinned file, plus one more.
  legacySnapshot(at("plugin-Decoy3"));
  userFile(at("plugin-Decoy3"));
  // Every pinned file, the companion a link to a real file.
  legacySnapshot(at("plugin-Decoy4"));
  fs.writeFileSync(path.join(dir, "elsewhere.mjs"), "");
  fs.rmSync(path.join(at("plugin-Decoy4"), "scripts", "codex-companion.mjs"));
  fs.symlinkSync(path.join(dir, "elsewhere.mjs"), path.join(at("plugin-Decoy4"), "scripts", "codex-companion.mjs"));
  const decoys = ["plugin-Decoy1", "plugin-Decoy2", "plugin-Decoy3", "plugin-Decoy4"].map(at);
  for (const d of decoys) fs.utimesSync(d, old, old);
  const r = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  assert.equal(r.status, 60, r.stdout);
  assert.deepEqual([JSON.parse(r.stdout).swept, JSON.parse(r.stdout).unverified], [0, 4], r.stdout);
  for (const d of decoys.slice(0, 3)) assert.ok(fs.existsSync(path.join(d, "keep.txt")), `${path.basename(d)}: the user's file is left`);
  assert.ok(fs.lstatSync(path.join(decoys[3], "scripts", "codex-companion.mjs")).isSymbolicLink());
});

test("A: a snapshot cleanup that throws still releases the round's lock, and is reported (failed_remove)", { timeout: 90_000 }, async () => {
  const r = round({ FAKE_COMPANION_LOCK_SNAPSHOT: "1" });
  try {
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.deepEqual(fs.readdirSync(path.join(env.REVIEW_LOOP_STATE_DIR, "locks")).filter((n) => n.endsWith(".lock")), [], "the lock is released");
    assert.deepEqual(stopDetails().map((e) => e.data.reason), ["failed_remove"]);
    assert.equal(brokerStopEvents().length, 1);
    assert.equal(snapshots().length, 1, "the snapshot is kept for a later sweep");
  } finally {
    for (const s of snapshots()) if (fs.existsSync(path.join(ws(), s, "locked"))) fs.chmodSync(path.join(ws(), s, "locked"), 0o700);
  }
});

test("C: ws/ swapped for a link after the sweep began: nothing behind the link is removed (unverified)", { timeout: 60_000 }, async (t) => {
  const parent = path.join(dir, "ws-swap");
  const outside = path.join(dir, "ws-outside");
  const name = "plugin-Swap01";
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  for (const d of [parent, outside]) {
    fs.mkdirSync(d, { mode: 0o700 });
    legacySnapshot(path.join(d, name));
    fs.utimesSync(path.join(d, name), old, old);
  }
  // Swapped as the snapshot is first read (its files checked), after the walks that found it.
  const opendir = fs.opendirSync;
  let swapped = false;
  t.mock.method(fs, "opendirSync", (/** @type {Parameters<typeof fs.opendirSync>} */ ...a) => {
    const h = opendir(...a);
    if (!swapped && a[0] === path.join(parent, name)) {
      swapped = true;
      fs.renameSync(parent, `${parent}.real`);
      fs.symlinkSync(outside, parent);
    }
    return h;
  });
  try {
    const res = await withSeams({ REVIEW_LOOP_PIN_FILE: env.REVIEW_LOOP_PIN_FILE, REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { all: true }));
    assert.ok(swapped, "the swap happened");
    assert.equal(res.swept, 0, JSON.stringify(res));
    assert.ok(fs.existsSync(path.join(outside, name, "scripts", "codex-companion.mjs")), "the dir behind the link is untouched");
  } finally {
    t.mock.restoreAll();
  }
});

test("C: a legacy snapshot's files are streamed against their cap, never listed whole", { timeout: 60_000 }, async (t) => {
  const parent = path.join(dir, "ws-big");
  fs.mkdirSync(parent, { mode: 0o700 });
  const snap = path.join(parent, "plugin-Big001");
  legacySnapshot(snap);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(snap, `extra-${i}`), "");
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  fs.utimesSync(snap, old, old);
  const readdir = fs.readdirSync;
  /** @type {string[]} */
  const listed = [];
  t.mock.method(fs, "readdirSync", (/** @type {Parameters<typeof fs.readdirSync>} */ ...a) => (listed.push(String(a[0])), readdir(...a)));
  try {
    const res = await withSeams({ REVIEW_LOOP_PIN_FILE: env.REVIEW_LOOP_PIN_FILE, REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { all: true }));
    assert.equal(res.swept, 0, JSON.stringify(res));
    assert.deepEqual(listed.filter((p) => p.startsWith(snap)), [], "no listing of the snapshot was buffered whole");
    assert.ok(fs.existsSync(snap));
  } finally {
    t.mock.restoreAll();
  }
});

test("B: a damaged broker.json (cut short, or the wrong shape) is set aside and the live broker is stopped from the process table", { timeout: 90_000 }, async () => {
  for (const [i, body] of ['{"endpoint":"unix:/x","pi', JSON.stringify({ pid: "12" })].entries()) {
    const parent = path.join(dir, `ws-damaged-${i}`);
    fs.mkdirSync(parent, { mode: 0o700 });
    const s = await deadSnapshot(parent, { env: { FAKE_BROKER_IGNORE_SHUTDOWN: "1" } });
    fs.writeFileSync(s.registry, body);
    const r = await stopCompanionBroker(s.root);
    assert.deepEqual([r.left, r.unattributed, r.quarantined], [0, 0, 1], JSON.stringify(r));
    assert.ok(await until(() => !alive(s.pid), 5000), "the broker ps shows running from the snapshot was stopped");
    const kept = fs.readdirSync(path.dirname(s.registry));
    assert.ok(!kept.includes("broker.json") && kept.some((n) => n.startsWith("broker.json.corrupt-")), `set aside, never read again: ${kept}`);
  }
});

test("R2: a killed round's damaged broker.json does not strand its snapshot: the sweep stops the broker, removes it, and says so under that round's key", { timeout: 90_000 }, async () => {
  const left = await killedRound();
  const state = path.join(left.root, "data", "state");
  const [slug] = fs.readdirSync(state);
  fs.writeFileSync(path.join(state, slug, "broker.json"), "{not json");
  const origin = JSON.parse(fs.readFileSync(path.join(left.root, "owner.json"), "utf8")).key;
  assert.match(String(origin), /^[0-9a-f]{24}$/, "the killed round recorded its key");
  // The manual sweep has no artifact of its own: the event can only carry the snapshot's.
  const sw = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  assert.equal(sw.status, 0, sw.stdout);
  assert.ok(await until(() => !alive(left.broker.pid), 5000), "the broker is stopped");
  assert.deepEqual(snapshots(), [], "and the snapshot removed");
  const f = path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
  const q = fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"broker_registry_quarantined"'));
  assert.equal(q.length, 1, "one hook.error, never silent");
  assert.deepEqual(validateLine(JSON.parse(q[0])), []);
  assert.equal(JSON.parse(q[0]).artifact_key, origin, "under the round that made the snapshot");
  assert.ok(!q[0].includes(dir) && !q[0].includes("broker.json"), "no path in it");
});

test("C: owner identities are asked once per pid, and a sweep stops at its deadline even when every snapshot is in use", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-slow-ident");
  fs.mkdirSync(parent, { mode: 0o700 });
  for (const n of ["plugin-Slow01", "plugin-Slow02", "plugin-Slow03", "plugin-Slow04"]) {
    fs.mkdirSync(path.join(parent, n), { mode: 0o700 });
    fs.writeFileSync(path.join(parent, n, "owner.json"), liveOwner(process.pid));
  }
  const bin = path.join(dir, "slow-ident-ps");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(bin, "calls");
  // The identity read (`-o lstart=,command=`) is slow; the table read is not.
  fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\ncase " $* " in *"lstart=,command="*) echo x >> ${log}; /bin/sleep 0.4;; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
  const all = await withSeams({ ...psSeam(bin), REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { all: true }));
  assert.equal(all.skipped.size, 4, JSON.stringify([...all.skipped]));
  assert.equal(calls(), 1, "one identity read for the one owner pid, however many snapshots name it");
  fs.rmSync(log);
  const short = await withSeams({ ...psSeam(bin), REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { deadlineMs: 100 }));
  assert.deepEqual([short.skipped.size, short.incomplete], [1, true], "judged one, then stopped at the deadline");
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

test("units: removeSnapshot keeps the snapshot unless the temp dir its tmp.json names is confirmed gone or not ours", () => {
  const token = "0123456789abcdef0123456789abcdef";
  const mk = () => {
    const root = fs.mkdtempSync(path.join(dir, "plugin-"));
    return root;
  };
  const absent = mk();
  assert.equal(removeSnapshot(absent), true);
  assert.ok(!fs.existsSync(absent), "no tmp.json: removed");

  const stuck = mk();
  const short = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  fs.mkdirSync(path.join(short, "locked"));
  fs.writeFileSync(path.join(short, "locked", "f"), "");
  fs.chmodSync(path.join(short, "locked"), 0o000);
  fs.writeFileSync(path.join(short, ".review-loop-tmp"), token);
  fs.writeFileSync(path.join(stuck, "tmp.json"), JSON.stringify({ dir: short, token }));
  try {
    assert.equal(removeSnapshot(stuck), false);
    assert.ok(fs.existsSync(path.join(stuck, "tmp.json")), "a temp dir that would not go keeps the only pointer to it");
  } finally {
    // Detached before the removal began: the rest of it waits at <dir>.rm.
    fs.chmodSync(path.join(fs.existsSync(short) ? short : `${short}.rm`, "locked"), 0o700);
  }
  assert.equal(removeSnapshot(stuck), true, "and the retry clears both");
  assert.ok(!fs.existsSync(short) && !fs.existsSync(`${short}.rm`) && !fs.existsSync(stuck));

  const bad = mk();
  fs.writeFileSync(path.join(bad, "tmp.json"), "{not json");
  assert.equal(removeSnapshot(bad), false, "an unreadable tmp.json keeps the snapshot");
  const gone = mk();
  fs.writeFileSync(path.join(gone, "tmp.json"), JSON.stringify({ dir: path.join(os.tmpdir(), "rl-Gone12"), token }));
  assert.equal(removeSnapshot(gone), true, "a temp dir already gone: removed");

  // A dir by that name that is not ours (no token, or another's): never removed; the pointer is all that goes.
  for (const held of [null, "ffffffffffffffffffffffffffffffff"]) {
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    fs.writeFileSync(path.join(foreign, "keep.txt"), "someone else's");
    if (held) fs.writeFileSync(path.join(foreign, ".review-loop-tmp"), held);
    const s = mk();
    fs.writeFileSync(path.join(s, "tmp.json"), JSON.stringify({ dir: foreign, token }));
    try {
      assert.equal(removeSnapshot(s), true);
      assert.ok(fs.existsSync(path.join(foreign, "keep.txt")), `a dir without this token (${held ?? "none"}) is left as it is`);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  }
  // Not the exact token (the token is written whole, by rename): empty, partial or absent, it proves nothing, and
  // the dir is left as it is, even an empty one that might be a killed round's.
  for (const held of ["", token.slice(0, 7), null]) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
    if (held !== null) fs.writeFileSync(path.join(d, ".review-loop-tmp"), held);
    const s = mk();
    fs.writeFileSync(path.join(s, "tmp.json"), JSON.stringify({ dir: d, token }));
    try {
      assert.equal(removeSnapshot(s), true, "the pointer goes");
      assert.ok(fs.existsSync(d), `a dir holding ${held === null ? "no token" : held ? "a partial token" : "an empty token"} is left as it is`);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

test("units: a token left in its .part (the rename failed or the round died) still marks the temp dir ours: removed", (t) => {
  const root = fs.mkdtempSync(path.join(dir, "plugin-"));
  const long = path.join(root, "y".repeat(120));
  fs.mkdirSync(long, { recursive: true });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (/** @type {Parameters<typeof fs.renameSync>} */ ...a) => {
    if (path.basename(String(a[1])) === ".review-loop-tmp") throw Object.assign(new Error("EIO"), { code: "EIO" });
    return rename(...a);
  });
  assert.throws(() => companionTmp(long), /EIO/);
  t.mock.restoreAll();
  const short = JSON.parse(fs.readFileSync(path.join(long, "tmp.json"), "utf8")).dir;
  try {
    assert.deepEqual(fs.readdirSync(short), [".review-loop-tmp.part"], "the token never left its .part");
    assert.equal(removeSnapshot(long), true);
    assert.ok(!fs.existsSync(short) && !fs.existsSync(`${short}.rm`), "the dir is removed, not leaked");
  } finally {
    fs.rmSync(short, { recursive: true, force: true });
  }
});

test("units: removeSnapshot never removes through a temp dir swapped for a link after its check", (t) => {
  const token = "0123456789abcdef0123456789abcdef";
  const short = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  fs.writeFileSync(path.join(short, ".review-loop-tmp"), token);
  const victim = fs.mkdtempSync(path.join(dir, "victim-"));
  fs.writeFileSync(path.join(victim, "precious.txt"), "not the round's");
  const root = fs.mkdtempSync(path.join(dir, "plugin-"));
  fs.writeFileSync(path.join(root, "tmp.json"), JSON.stringify({ dir: short, token }));
  const rename = fs.renameSync;
  // The swap lands between the checks and the detach: the checked dir moves aside and a link takes its name.
  t.mock.method(fs, "renameSync", (/** @type {string} */ from, /** @type {string} */ to) => {
    if (from === short) {
      rename(short, `${short}.real`);
      fs.symlinkSync(victim, short);
    }
    return rename(from, to);
  });
  try {
    assert.equal(removeSnapshot(root), false, "kept: what was detached is not the dir that was checked");
    assert.ok(fs.existsSync(path.join(victim, "precious.txt")), "and nothing behind the link was removed");
  } finally {
    t.mock.restoreAll();
    for (const p of [short, `${short}.rm`, `${short}.real`]) fs.rmSync(p, { recursive: true, force: true });
  }
});

test("units: round.sweep's counts fit every sweep the engine can run (SWEEP_LIST_MAX snapshots)", async () => {
  const { EVENT_CATALOG } = await import("../../plugin/engine/lib/codes.mjs");
  const d = EVENT_CATALOG["round.sweep"].data;
  for (const k of ["swept", "brokers_left", "failed", "unattributed", "held", "in_use", "unverified"]) assert.equal(d[k](SWEEP_LIST_MAX), SWEEP_LIST_MAX, k);
});

test("D: a clean sweep whose round.sweep line cannot be written says so on stderr", { timeout: 90_000 }, async () => {
  await killedRound();
  fs.mkdirSync(path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl"));
  const r = spawnSync(process.execPath, [ROUND, "sweep"], { env, encoding: "utf8" });
  assert.equal(JSON.parse(r.stdout).status, "clean", r.stdout);
  assert.match(r.stderr, /event_write_failed .*"event":"round\.sweep".*"code":"ok"/);
});

test("units: goneGroupsLeft counts a gone broker's group even when its pid number is held again", () => {
  const row = (/** @type {number} */ pid, /** @type {number} */ pgid, /** @type {number} */ started) => ({ pid, pgid, uid: 501, started, args: "x" });
  const rows = [row(700, 900, 2000), row(701, 700, 2000), row(702, 700, 1000)];
  assert.equal(goneGroupsLeft(rows, [700], 1500, 501), 1, "pid 700 is held by a process in another group; group 700's later member still counts");
  assert.equal(goneGroupsLeft(rows, [700], 1500, 502), 0, "another user's processes are not ours to count");
  assert.equal(goneGroupsLeft([row(700, 900, 2000)], [700], 1500, 501), 0, "an empty group: nothing left");
});

test("units: companionTmp records the short temp dir before making it", (t) => {
  const root = fs.mkdtempSync(path.join(dir, "plugin-"));
  const long = path.join(root, "y".repeat(120));
  fs.mkdirSync(long, { recursive: true });
  /** @type {boolean[]} */
  const namedFirst = [];
  const marker = path.join(long, "tmp.json");
  const check = (/** @type {unknown} */ p) => {
    if (typeof p !== "string" || !path.basename(p).startsWith("rl-")) return;
    namedFirst.push(fs.existsSync(marker) && (path.basename(p) === "rl-" || JSON.parse(fs.readFileSync(marker, "utf8")).dir === p));
  };
  const mkdir = fs.mkdirSync;
  const mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdirSync", (/** @type {Parameters<typeof fs.mkdirSync>} */ ...a) => (check(a[0]), mkdir(...a)));
  t.mock.method(fs, "mkdtempSync", (/** @type {Parameters<typeof fs.mkdtempSync>} */ ...a) => (check(a[0]), mkdtemp(...a)));
  const short = companionTmp(long);
  try {
    assert.ok(short && /^rl-[A-Za-z0-9]{6}$/.test(path.basename(short)), String(short));
    assert.deepEqual(namedFirst, [true], "tmp.json named the dir before it existed");
    const rec = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(rec.dir, short);
    assert.equal(fs.readFileSync(path.join(short, ".review-loop-tmp"), "utf8"), rec.token, "and the dir holds tmp.json's token");
  } finally {
    t.mock.restoreAll();
    if (short) fs.rmSync(short, { recursive: true, force: true });
  }
});

test("B: a companion marker whose pid is held by a process that is not the companion still has its group counted", { timeout: 60_000 }, async () => {
  const parent = path.join(dir, "ws-companion-reused");
  fs.mkdirSync(parent, { mode: 0o700 });
  const s = await deadSnapshot(parent, { broker: false });
  await afterSnapshotSecond(s.root);
  // A live leader that is not a companion (its args name no companion script), with a child in its group.
  const src = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stdout.write(String(c.pid) + "\\n"); setInterval(() => {}, 1000);`;
  const leader = spawn(process.execPath, ["-e", src], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const childPid = await new Promise((res) => leader.stdout.once("data", (d) => res(Number(String(d).trim()))));
  try {
    fs.writeFileSync(path.join(s.root, "companion.json"), JSON.stringify({ pid: leader.pid }));
    const res = await withSeams({ REVIEW_LOOP_TEST_SWEEP_TICK: "0" }, () => sweepStaleSnapshots(parent, { all: true }));
    assert.deepEqual([res.swept, res.brokersLeft], [0, 1], JSON.stringify(res));
    assert.ok(fs.existsSync(s.root), "the snapshot is kept");
    assert.ok(alive(childPid) && alive(/** @type {number} */ (leader.pid)), "and nothing was signalled");
  } finally {
    signalPid(childPid, "SIGKILL");
    signalPid(/** @type {number} */ (leader.pid), "SIGKILL");
  }
});
