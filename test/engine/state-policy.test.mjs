import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  newRecord,
  writeRecord,
  readRecord,
  identityKey,
  acquireLock,
  setLockEventSource,
  writeMarker,
  listMarkers,
  isClearedAt,
  stateRoot,
  removeMarker,
  pruneBaselines,
  LOCK_TTL_MS,
  reclaimStale,
  writePendingSummary,
  readPendingSummary,
  processIdent,
  markerName,
  publishTempName,
  pendingReleaseKeys
} from "../../plugin/engine/lib/state.mjs";

const observe = (/** @type {string} */ file) => {
  const st = fs.lstatSync(file);
  return { raw: fs.readFileSync(file, "utf8"), mtimeMs: st.mtimeMs, ino: st.ino };
};
import { applyRoundResult, applyDecision, resetIfNewLoop, sameFinding, withoutWaived, EXIT } from "../../plugin/engine/lib/policy.mjs";
import { scoreFindings } from "../../plugin/engine/lib/scoring.mjs";
import { tmpDir } from "./helpers.mjs";
import { sha256hex } from "../../plugin/engine/lib/fsutil.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";

/** Readable lock names for tests, as the real key shape. @param {string} name */
const lk = (name) => sha256hex(name).slice(0, 24);

beforeEach(() => {
  process.env.REVIEW_LOOP_STATE_DIR = tmpDir("rl-state-");
});

const ID = { kind: "spec", path: "/r/docs/specs/a.md" };
const low = (t = "[Usability] x") => ({ severity: "low", title: t, file: "a.md" });
const round = (rec, findings, fp = "fp") => applyRoundResult(rec, scoreFindings(findings), findings, fp);

test("a pending summary with any item field the prompt hook reads missing or mistyped is quarantined and read as absent", () => {
  const good = { key: "k", kind: "spec", label: "spec x", status: "pending", reason: null, command: "node x" };
  writePendingSummary("s1", [good, { ...good, reason: "round_in_progress" }]);
  assert.equal(readPendingSummary("s1")?.items.length, 2, "control: a complete summary reads back");
  const dir = path.join(stateRoot(), "pending");
  const file = path.join(dir, fs.readdirSync(dir).find((n) => n.endsWith(".json")));
  const { key, command, ...noKeyCommand } = good;
  for (const items of [[{ ...good, key: undefined }], [{ ...good, command: 7 }], [noKeyCommand], [{ ...good, reason: 1 }], [{ ...good, kind: null }], [{ ...good, label: "x".repeat(5000) }], Array.from({ length: 257 }, () => good)]) {
    fs.writeFileSync(file, JSON.stringify({ v: 1, items, at: new Date().toISOString() }));
    assert.equal(readPendingSummary("s1"), null, JSON.stringify(items).slice(0, 80));
    assert.ok(fs.readdirSync(dir).some((n) => n.includes(".corrupt-")), "quarantined, not acted on");
    assert.equal(fs.existsSync(file), false);
  }
  assert.ok(key && command, "fixture sanity");
});

test("records round-trip with 0600 and validate on read", () => {
  const r = newRecord(ID);
  writeRecord(r);
  const file = path.join(stateRoot(), "records", `${identityKey(ID)}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readRecord(identityKey(ID))?.status, "pending");
});

test("pruneBaselines never deletes through a linked baselines dir; a real one drops only stale entries", () => {
  const outside = tmpDir("rl-outside-");
  const old = Date.now() / 1000 - 30 * 24 * 3600;
  fs.mkdirSync(path.join(outside, "stale"));
  fs.utimesSync(path.join(outside, "stale"), old, old);
  fs.symlinkSync(outside, path.join(stateRoot(), "baselines"));
  assert.throws(() => pruneBaselines(), { code: "state_symlink_rejected" });
  assert.deepEqual(fs.readdirSync(outside), ["stale"], "the stale directory outside the state tree survives");
  fs.rmSync(path.join(stateRoot(), "baselines"));
  const dir = path.join(stateRoot(), "baselines");
  fs.mkdirSync(path.join(dir, "stale"), { recursive: true });
  fs.mkdirSync(path.join(dir, "fresh"));
  fs.utimesSync(path.join(dir, "stale"), old, old);
  pruneBaselines();
  assert.deepEqual(fs.readdirSync(dir), ["fresh"], "control: a real dir is pruned");
});

test("a prune failure other than a concurrent removal surfaces instead of being swallowed", () => {
  const dir = path.join(stateRoot(), "baselines");
  const stale = path.join(dir, "stale");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "b.json"), "{}");
  const old = Date.now() / 1000 - 30 * 24 * 3600;
  fs.utimesSync(stale, old, old);
  fs.chmodSync(stale, 0o500);
  try {
    assert.throws(() => pruneBaselines(), (e) => typeof (/** @type {NodeJS.ErrnoException} */ (e).code) === "string" && /** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT");
  } finally {
    fs.chmodSync(stale, 0o700);
  }
});

test("release never deletes a successor's lock that took over after our token was read", (t) => {
  const key = lk("releaserace");
  const lock = acquireLock(key, "s");
  const file = path.join(stateRoot(), "locks", `${key}.lock`);
  const successor = JSON.stringify({ pid: process.pid, session: "successor", token: "succ" });
  let armed = true;
  const realRead = fs.readSync;
  t.mock.method(fs, "readSync", (...args) => {
    const n = realRead(...args);
    if (armed) {
      // Inside release's lock read: it has seen OUR token; the path is now taken over.
      armed = false;
      fs.writeFileSync(`${file}.x`, successor);
      fs.renameSync(`${file}.x`, file);
    }
    return n;
  });
  lock.release();
  assert.equal(armed, false, "the takeover was injected inside release");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, "succ", "the successor's lock survives");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".aside.")), [], "no set-aside file left behind");
});

test("existing state dirs are tightened to 0700 from the root down; a link below the root is refused, not chmod'ed", () => {
  const root = stateRoot();
  fs.mkdirSync(path.join(root, "records"), { recursive: true });
  fs.chmodSync(root, 0o777);
  fs.chmodSync(path.join(root, "records"), 0o775);
  writeRecord(newRecord(ID));
  assert.equal(fs.statSync(root).mode & 0o777, 0o700, "the root");
  assert.equal(fs.statSync(path.join(root, "records")).mode & 0o777, 0o700, "the records dir");
  const outside = tmpDir("rl-outside-");
  fs.chmodSync(outside, 0o755);
  fs.symlinkSync(outside, path.join(root, "baselines"));
  assert.throws(() => pruneBaselines(), { code: "state_symlink_rejected" });
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755, "the link's target keeps its mode");
});

test("a state dir owned by another user is refused, never written into", (t) => {
  t.mock.method(process, "getuid", () => 4242);
  assert.throws(() => writeRecord(newRecord(ID)), { code: "state_dir_insecure" });
  t.mock.restoreAll();
  assert.equal(readRecord(identityKey(ID)), null, "nothing was written");
});

test("a linked markers or locks dir is refused: nothing outside the state tree is listed, removed or locked", () => {
  const outside = tmpDir("rl-outside-");
  const key = identityKey(ID);
  fs.writeFileSync(path.join(outside, `${key}.json`), JSON.stringify({ v: 1 }));
  fs.symlinkSync(outside, path.join(stateRoot(), "markers"));
  fs.symlinkSync(outside, path.join(stateRoot(), "locks"));
  assert.throws(() => listMarkers(), { code: "state_symlink_rejected" });
  assert.throws(() => removeMarker(key), { code: "state_symlink_rejected" });
  assert.throws(() => acquireLock(key), { code: "state_symlink_rejected" });
  assert.deepEqual(fs.readdirSync(outside), [`${key}.json`], "the outside dir is untouched");
});

test("a marker whose key is missing or not its identity's own is quarantined, and the rest still list", () => {
  writeMarker(ID, { source: "track", projectRoot: "/r", session: "s" });
  const dir = path.join(stateRoot(), "markers");
  const other = { kind: "spec", path: "/r/docs/specs/b.md" };
  const good = JSON.parse(fs.readFileSync(path.join(dir, `${identityKey(ID)}.json`), "utf8"));
  const bad = [
    { ...good, identity: other, key: undefined },
    { ...good, identity: other, key: identityKey(ID) },
    { ...good, identity: other, key: identityKey(other), extra: { headRemote: 7 } },
    { ...good, identity: other, key: identityKey(other), extra: null }
  ];
  bad.forEach((m, i) => fs.writeFileSync(path.join(dir, `bad${i}.json`), JSON.stringify(m)));
  assert.deepEqual(listMarkers().map((m) => m.key), [identityKey(ID)]);
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".corrupt-")).length, bad.length);
});

test("a corrupt record is quarantined and reads as absent", () => {
  const file = path.join(stateRoot(), "records", `${identityKey(ID)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, identity: ID, status: "passed" }));
  assert.equal(readRecord(identityKey(ID)), null);
  assert.ok(fs.readdirSync(path.dirname(file)).some((n) => n.includes(".corrupt-")));
});

test("a record whose loop counters or error state are malformed is quarantined at read (a limit it cannot reach)", () => {
  const file = path.join(stateRoot(), "records", `${identityKey(ID)}.json`);
  for (const [field, bad] of /** @type {const} */ ([
    ["errorAttempts", "corrupt"],
    ["errorAttempts", -1],
    ["errorAttempts", undefined],
    ["sinceImprovement", "2"],
    ["uncappedStart", "10"],
    ["bestSumTenths", 9.5],
    ["lastError", "boom"],
    ["lastError", { message: "no code" }],
    ["meta", null],
    ["meta", { projectRoot: 7 }]
  ])) {
    const r = /** @type {Record<string, unknown>} */ (newRecord(ID));
    r.status = "op_error";
    r[field] = bad;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r));
    assert.equal(readRecord(identityKey(ID)), null, `${field}=${JSON.stringify(bad)}`);
    assert.ok(!fs.existsSync(file), "quarantined, not left in place");
  }
  const ok = newRecord(ID);
  ok.status = "op_error";
  ok.errorAttempts = 3;
  ok.uncappedStart = 10;
  ok.bestSumTenths = 95;
  ok.lastError = { code: "codex_failed", message: "m", at: "t" };
  ok.meta = { projectRoot: "/r" };
  writeRecord(ok);
  assert.equal(readRecord(identityKey(ID))?.errorAttempts, 3, "well-formed values still read");
});

test("a record whose awaiting page is malformed is quarantined at read (options not an array / not allowed / unknown reason)", () => {
  const file = path.join(stateRoot(), "records", `${identityKey(ID)}.json`);
  for (const awaiting of [
    { reason: "checkpoint", options: "continue", detail: {} },
    { reason: "checkpoint", options: ["continue", "rm -rf"], detail: {} },
    { reason: "checkpoint", options: [], detail: {} },
    { reason: "made_up", options: ["stop"], detail: {} },
    { reason: "checkpoint", options: ["stop"], detail: "x" }
  ]) {
    const r = newRecord(ID);
    r.status = "awaiting_human";
    r.awaiting = awaiting;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r));
    assert.equal(readRecord(identityKey(ID)), null, JSON.stringify(awaiting));
    assert.ok(!fs.existsSync(file), "quarantined, not left in place");
  }
  const ok = newRecord(ID);
  ok.status = "awaiting_human";
  ok.awaiting = { reason: "checkpoint", options: ["continue", "more", "accept", "stop"], detail: { round: 10 } };
  writeRecord(ok);
  assert.equal(readRecord(identityKey(ID))?.awaiting?.reason, "checkpoint");
});

test("awaitHuman refuses a reason with no defined options (never writes an unreadable record)", async () => {
  const { awaitHuman } = await import("../../plugin/engine/lib/policy.mjs");
  assert.throws(() => awaitHuman(newRecord(ID), "made_up"), { code: "unknown_page_reason" });
});

test("gate: cleared only when passed/overridden at the exact fingerprint", () => {
  const r = newRecord(ID);
  r.status = "passed";
  r.reviewedFingerprint = "abc";
  writeRecord(r);
  assert.equal(isClearedAt(ID, "abc"), true);
  assert.equal(isClearedAt(ID, "abd"), false);
  assert.equal(isClearedAt({ kind: "spec", path: "/r/docs/specs/b.md" }, "abc"), false, "identity includes the path");
});

test("lock: exactly one of two racing processes wins; the loser gets busy", async () => {
  const key = lk("racekey");
  const script = `
    process.env.REVIEW_LOOP_STATE_DIR=${JSON.stringify(stateRoot())};
    const { acquireLock } = await import(${JSON.stringify(new URL("../../plugin/engine/lib/state.mjs", import.meta.url).href)});
    try { acquireLock(${JSON.stringify(key)}, "s"); console.log("won"); setTimeout(()=>{}, 400); }
    catch (e) { console.log(e.code); }`;
  const runOne = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let out = "";
      c.stdout.on("data", (b) => (out += b));
      c.on("close", () => resolve(out.trim()));
    });
  const results = await Promise.all([runOne(), runOne()]);
  assert.deepEqual(results.sort(), ["busy", "won"]);
});

test("lock: a dead holder's lock is reclaimed", () => {
  const file = path.join(stateRoot(), "locks", `${lk("k")}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 999_999_9, session: "x", at: Date.now(), token: "t-dead" }));
  const lock = acquireLock(lk("k"), "s");
  lock.release();
  assert.ok(!fs.existsSync(file));
});

test("lock: a lock whose heartbeat stopped for the TTL is reclaimed even if the pid is alive (hung or recycled pid)", () => {
  const file = path.join(stateRoot(), "locks", `${lk("k2")}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, session: "x", token: "t-hung" }));
  const beatStopped = (Date.now() - 21 * 60_000) / 1000;
  fs.utimesSync(file, beatStopped, beatStopped);
  acquireLock(lk("k2"), "s").release();
});

test("lock: a live holder's heartbeat keeps its lock past the TTL (a long round is never reclaimed)", (t) => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  t.after(() => mock.timers.reset());
  const lock = acquireLock(lk("k3"), "s");
  mock.timers.tick(LOCK_TTL_MS + 5 * 60_000);
  assert.throws(() => acquireLock(lk("k3"), "other"), { code: "busy" });
  lock.release();
  assert.ok(!fs.existsSync(path.join(stateRoot(), "locks", `${lk("k3")}.lock`)));
});

test("lock: a heartbeat never rewrites lock content — a takeover's token is never replaced by the old holder's", (t) => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  t.after(() => mock.timers.reset());
  const lock = acquireLock(identityKey(ID), "s");
  const file = path.join(stateRoot(), "locks", `${identityKey(ID)}.lock`);
  const takeover = JSON.stringify({ pid: process.pid, session: "new-holder", token: "new" });
  // Force the worst interleaving: the takeover lands inside the heartbeat, after it read our token and before it writes.
  let armed = true;
  const realFstat = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (fd, ...rest) => {
    const st = realFstat(fd, ...rest);
    if (armed) {
      // Inside the heartbeat's lock read: it holds the OLD file open (our token) while the path is taken over.
      armed = false;
      fs.writeFileSync(`${file}.x`, takeover);
      fs.renameSync(`${file}.x`, file);
    }
    return st;
  });
  mock.timers.tick(60_000);
  assert.equal(armed, false, "the takeover was injected inside a heartbeat");
  mock.timers.tick(2 * 60_000);
  assert.equal(fs.readFileSync(file, "utf8"), takeover, "the new holder's lock is untouched");
  assert.throws(() => writeRecord(newRecord(ID)), { code: "lock_lost" }, "the old holder is fenced out");
  lock.release();
  assert.equal(fs.readFileSync(file, "utf8"), takeover, "release never removes someone else's lock");
});

test("lock: reclaiming is compare-and-swap — a lock replaced after it was judged stale is put back, not deleted", () => {
  const file = path.join(stateRoot(), "locks", `${lk("cas")}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stale = JSON.stringify({ pid: 999_999_9, session: "x", at: 0, token: "old" });
  const fresh = JSON.stringify({ pid: process.pid, session: "y", at: Date.now(), token: "new" });
  fs.writeFileSync(file, stale);
  const judged = observe(file);
  fs.writeFileSync(`${file}.x`, fresh);
  fs.renameSync(`${file}.x`, file);
  assert.equal(reclaimStale(lk("cas"), judged), false, "the file at the path is no longer the one judged stale");
  assert.equal(fs.readFileSync(file, "utf8"), fresh, "the fresh lock survives intact");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".aside.")), [], "no set-aside file left behind");
  fs.writeFileSync(file, stale);
  assert.equal(reclaimStale(lk("cas"), observe(file)), true);
  assert.ok(!fs.existsSync(file));
});

test("lock: a heartbeat between the stale judgment and the reclaim wins — same bytes, newer mtime, lock restored", () => {
  const file = path.join(stateRoot(), "locks", `${lk("beat")}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, session: "slow-holder", token: "t" });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, 1, 1);
  const judged = observe(file);
  const beat = Date.now() / 1000;
  fs.utimesSync(file, beat, beat); // the delayed holder's heartbeat lands now: the bytes do not change
  assert.equal(reclaimStale(lk("beat"), judged), false);
  assert.equal(fs.readFileSync(file, "utf8"), content, "the live lock is back in place");
  assert.ok(Math.abs(fs.statSync(file).mtimeMs - beat * 1000) < 1000, "with its fresh heartbeat");
});

test("lock: fencing — a holder whose lock was taken over cannot write the record", () => {
  const lock = acquireLock(identityKey(ID), "s");
  try {
    const r = newRecord(ID);
    writeRecord(r);
    const file = path.join(stateRoot(), "locks", `${identityKey(ID)}.lock`);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, session: "z", at: Date.now(), token: "someone-else" }));
    assert.throws(() => writeRecord(r), { code: "lock_lost" });
  } finally {
    lock.release();
  }
});

test("lock: eight processes racing to reclaim one stale lock → exactly one holder", async () => {
  const key = lk("stalerace");
  const file = path.join(stateRoot(), "locks", `${key}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 999_999_9, session: "x", token: "dead" }));
  fs.utimesSync(file, 0, 0);
  const script = `
    process.env.REVIEW_LOOP_STATE_DIR=${JSON.stringify(stateRoot())};
    const { acquireLock } = await import(${JSON.stringify(new URL("../../plugin/engine/lib/state.mjs", import.meta.url).href)});
    try { acquireLock(${JSON.stringify(key)}, "s"); console.log("won"); setTimeout(()=>{}, 800); }
    catch (e) { console.log(e.code); }`;
  const runOne = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let out = "";
      c.stdout.on("data", (b) => (out += b));
      c.on("close", () => resolve(out.trim()));
    });
  const results = await Promise.all(Array.from({ length: 8 }, runOne));
  assert.equal(results.filter((r) => r === "won").length, 1, results.join(","));
  assert.ok(results.every((r) => r === "won" || r === "busy"), results.join(","));
});

test("a plugin_pin page whose tree is malformed is quarantined at read (repin trusts it as the approved identity)", () => {
  const r = newRecord(ID);
  r.status = "awaiting_human";
  r.awaiting = { reason: "plugin_pin", detail: { tree: { version: "1.0.6", digest: "a".repeat(64) } }, options: ["repin", "override", "stop"], fingerprint: null };
  writeRecord(r);
  assert.ok(readRecord(identityKey(ID)), "a well-formed tree is accepted");
  for (const tree of [{ version: "../evil", digest: "a".repeat(64) }, { version: "1.0.6", digest: "not-a-digest" }, "x"]) {
    r.awaiting = { ...r.awaiting, detail: { tree } };
    writeRecord(r);
    assert.equal(readRecord(identityKey(ID)), null, JSON.stringify(tree));
  }
});

test("lock: a lock path that is a symlink to a FIFO, or an oversized file, never blocks or buffers — it is reclaimed and logged", () => {
  const dir = path.join(stateRoot(), "locks");
  fs.mkdirSync(dir, { recursive: true });
  const fifo = path.join(tmpDir(), "fifo");
  execFileSync("mkfifo", [fifo]);
  fs.symlinkSync(fifo, path.join(dir, `${lk("fifo")}.lock`));
  const t0 = Date.now();
  acquireLock(lk("fifo"), "s").release();
  assert.ok(Date.now() - t0 < 5000, "returned promptly");
  assert.ok(fs.lstatSync(fifo).isFIFO(), "the FIFO itself is untouched");
  fs.writeFileSync(path.join(dir, `${lk("big")}.lock`), "x".repeat(10 * 1024 * 1024));
  const readSync = mock.method(fs, "readSync");
  try {
    acquireLock(lk("big"), "s").release();
    assert.equal(readSync.mock.calls.filter((c) => c.arguments[3] > 4096).length, 0, "never reads more than the lock bound");
  } finally {
    readSync.mock.restore();
  }
  const logged = fs.readFileSync(path.join(stateRoot(), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(logged.some((l) => l.event === "hook.error" && l.data.stage === "lock_invalid" && l.code === "too_large" && l.source === "hook"));
  setLockEventSource("round");
  try {
    fs.rmSync(path.join(stateRoot(), "events.jsonl"));
    fs.writeFileSync(path.join(dir, `${lk("big")}.lock`), "x".repeat(10 * 1024 * 1024));
    acquireLock(lk("big"), "s").release();
    const asRound = fs.readFileSync(path.join(stateRoot(), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(asRound.some((l) => l.data.stage === "lock_invalid" && l.source === "round"));
  } finally {
    setLockEventSource("hook");
  }
});

test("markers are one file per identity", () => {
  writeMarker(ID, { source: "track", projectRoot: "/r", session: "s1" });
  writeMarker(ID, { source: "track", projectRoot: "/r", session: "s2" });
  const ms = listMarkers();
  assert.equal(ms.length, 1);
  assert.equal(ms[0].session, "s2");
});

test("pass: sets reviewedFingerprint and exits 0", () => {
  const r = newRecord(ID);
  assert.equal(round(r, [], "fp1"), EXIT.PASS);
  assert.equal(r.status, "passed");
  assert.equal(r.reviewedFingerprint, "fp1");
});

test("capped mode: checkpoint at 10 → '10 more' → checkpoint at 20 with the same options", () => {
  const r = newRecord(ID);
  for (let i = 1; i < 10; i++) assert.equal(round(r, [low()]), EXIT.NEEDS_FIXES);
  assert.equal(round(r, [low()]), EXIT.CHECKPOINT);
  assert.deepEqual(r.awaiting?.options, ["continue", "more", "accept", "stop"]);
  applyDecision(r, "more", "fp");
  for (let i = 11; i < 20; i++) assert.equal(round(r, [low()]), EXIT.NEEDS_FIXES);
  assert.equal(round(r, [low()]), EXIT.CHECKPOINT);
  assert.equal(r.round, 20);
  assert.deepEqual(r.awaiting?.options, ["continue", "more", "accept", "stop"]);
});

test("uncapped mode: a stall (no improvement for 3 rounds) pages with the same options", () => {
  const r = newRecord(ID);
  for (let i = 0; i < 10; i++) round(r, [low()]);
  applyDecision(r, "continue", "fp");
  assert.equal(r.mode, "uncapped");
  assert.equal(round(r, [low()]), EXIT.NEEDS_FIXES);
  assert.equal(round(r, [low()]), EXIT.NEEDS_FIXES);
  assert.equal(round(r, [low()]), EXIT.STALL);
  assert.deepEqual(r.awaiting?.options, ["continue", "more", "accept", "stop"]);
});

test("uncapped mode: improvement resets the stall counter; ceiling is 20 rounds after it began", () => {
  const r = newRecord(ID);
  for (let i = 0; i < 10; i++) round(r, [{ severity: "critical", title: "[Safety] a" }]);
  applyDecision(r, "continue", "fp");
  const exits = ["high", "medium", "low", "low", "low", "low"].map((sev) => round(r, [{ severity: sev, title: "[Safety] a" }]));
  // high/medium/low each improve (counter stays 0); then three flat rounds → stall on the third.
  assert.deepEqual(exits, [10, 10, 10, 10, 10, 21]);
  assert.equal(r.round, 16);
});

test("uncapped ceiling alone: 20 improving-or-flat rounds without a 3-round stall still checkpoint", () => {
  const r = newRecord(ID);
  for (let i = 0; i < 10; i++) round(r, [{ severity: "critical", title: "[Safety] a" }]);
  applyDecision(r, "continue", "fp");
  r.sinceImprovement = 0;
  let exit;
  for (let i = 0; i < 20; i++) {
    r.bestSumTenths = -1; // force "improved" every round to isolate the ceiling
    exit = round(r, [low()]);
  }
  assert.equal(exit, EXIT.CHECKPOINT);
  assert.equal(r.round, 30);
});

test("disputes: dropped by Codex → resolved; re-raised twice → dispute_deadlock page", () => {
  const r = newRecord(ID);
  r.disputes.push({ title: "[Safety] token logged", file: "a.md", reason: "it is redacted", raisedAgain: 0 });
  round(r, [low("[Usability] other")]);
  assert.equal(r.disputes.length, 0, "dropped dispute is resolved");

  r.disputes.push({ title: "[Safety] token logged", file: "a.md", reason: "redacted", raisedAgain: 0 });
  const f = { severity: "medium", title: "[Safety] Token is logged", file: "a.md" };
  assert.equal(round(r, [f]), EXIT.NEEDS_FIXES);
  assert.equal(round(r, [f]), EXIT.HUMAN);
  assert.equal(r.awaiting?.reason, "dispute_deadlock");
  assert.deepEqual(r.awaiting?.options, ["accept-finding", "waive", "stop"]);
});

test("waive: the waived finding is excluded from later scoring", () => {
  const r = newRecord(ID);
  r.disputes.push({ title: "[Safety] x", file: "a.md", reason: "r", raisedAgain: 2 });
  r.status = "awaiting_human";
  r.awaiting = { reason: "dispute_deadlock", detail: { title: "[Safety] x", file: "a.md" }, options: ["accept-finding", "waive", "stop"] };
  applyDecision(r, "waive", "fp");
  const remaining = withoutWaived([{ severity: "high", title: "[Safety] x", file: "a.md" }], r.waivers);
  assert.equal(remaining.length, 0);
  assert.equal(round(r, remaining), EXIT.PASS);
});

test("decisions: invalid option rejected; accept clears only at the fingerprint the page scored", () => {
  const r = newRecord(ID);
  for (let i = 0; i < 10; i++) round(r, [low()], "fp-scored");
  assert.equal(r.awaiting?.fingerprint, "fp-scored");
  assert.throws(() => applyDecision(r, "waive", "fp-scored"), { code: "invalid_decision" });
  assert.throws(() => applyDecision(r, "accept", "fp-edited-after-the-page"), { code: "decision_stale" });
  assert.throws(() => applyDecision(r, "accept", null), { code: "decision_stale" });
  assert.equal(r.status, "awaiting_human", "a refused decision leaves the page in place");
  applyDecision(r, "accept", "fp-scored");
  assert.equal(r.status, "overridden");
  assert.equal(r.reviewedFingerprint, "fp-scored");
});

test("a changed artifact after a terminal outcome starts a fresh loop", () => {
  const r = newRecord(ID);
  round(r, [], "fp1");
  assert.equal(resetIfNewLoop(r, "fp1"), false);
  assert.equal(resetIfNewLoop(r, "fp2"), true);
  assert.equal(r.round, 0);
  assert.equal(r.status, "pending");
});

test("sameFinding: file must match; titles compared after stripping the tag", () => {
  assert.ok(sameFinding({ title: "[Safety] Token is logged!", file: "a" }, { title: "[Reliability] token is logged", file: "a" }));
  assert.ok(!sameFinding({ title: "[Safety] token logged", file: "a" }, { title: "[Safety] token logged", file: "b" }));
  assert.ok(!sameFinding({ title: "[Safety] retry unbounded", file: "a" }, { title: "[Safety] symlink followed", file: "a" }));
});

test("lock: a symlinked lock file (ELOOP) is logged as state_symlink_rejected, not a generic open failure", () => {
  const dir = path.join(stateRoot(), "locks");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(tmpDir(), "elsewhere");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, path.join(dir, `${lk("eloop")}.lock`));
  acquireLock(lk("eloop"), "s").release();
  const logged = fs.readFileSync(path.join(stateRoot(), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const hit = logged.filter((l) => l.event === "hook.error" && l.data.stage === "lock_invalid");
  assert.ok(hit.length >= 1, "the invalid lock is logged");
  assert.ok(hit.every((l) => l.code === "state_symlink_rejected"), JSON.stringify(hit.map((l) => l.code)));
  assert.equal(fs.readFileSync(target, "utf8"), "{}", "the link target is untouched");
});

// ---- the mover section (see CLAUDE.md "Locks") ----

const STATE_MJS = new URL("../../plugin/engine/lib/state.mjs", import.meta.url).href;
const locksDir = () => path.join(stateRoot(), "locks");
const lockFile = (/** @type {string} */ key) => path.join(locksDir(), `${key}.lock`);
const HEX = "0123456789abcdef";
const markerFile = (/** @type {string} */ key, /** @type {number} */ pid, hex = HEX) => path.join(locksDir(), `${key}.lock.reclaim.${pid}.${hex}`);
const markersOf = (/** @type {string} */ key) => fs.readdirSync(locksDir()).filter((n) => markerName(key, n) !== null);
const pause = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {() => unknown} pred */
async function waitFor(pred, ms = 10_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await pause(10);
  }
}

/** A lock whose holder is dead, so the next acquirer has to reclaim it through the section. @param {string} key */
function staleLock(key) {
  fs.mkdirSync(locksDir(), { recursive: true });
  fs.writeFileSync(lockFile(key), JSON.stringify({ pid: 999_999_9, session: "x", token: "dead" }));
  fs.utimesSync(lockFile(key), 0, 0);
}

/** A real process to name in markers; alive until stopped. */
function sleeper() {
  const c = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
  let exited = false;
  c.on("exit", () => (exited = true));
  return {
    pid: /** @type {number} */ (c.pid),
    stop: () => (exited ? Promise.resolve() : new Promise((r) => { c.on("exit", r); c.kill(); }))
  };
}

/** A well-formed marker body for `pid`, as the owner itself writes one. */
const markerBody = (/** @type {number} */ pid, /** @type {string | null} */ ident, hex = HEX) => JSON.stringify({ pid, ident, token: hex + "f".repeat(16) });

/** What /bin/ps prints for `pid`, exactly as processIdent hashes it. @param {number} pid */
const psLine = (pid) =>
  execFileSync("/bin/ps", ["-ww", "-o", "lstart=,command=", "-p", String(pid)], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).toString("utf8").trim();

/** acquireLock in a child process: prints `won` (then holds the lock for holdMs) or the error code. */
function contender(/** @type {string} */ key, { env = {}, holdMs = 1000 } = {}) {
  const script = `
    process.env.REVIEW_LOOP_STATE_DIR=${JSON.stringify(stateRoot())};
    const { acquireLock } = await import(${JSON.stringify(STATE_MJS)});
    try { acquireLock(${JSON.stringify(key)}, "s"); console.log("won"); setTimeout(()=>{}, ${holdMs}); }
    catch (e) { console.log(e.code); }`;
  const c = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env } });
  let out = "";
  c.stdout.on("data", (b) => (out += b));
  return { pid: /** @type {number} */ (c.pid), done: /** @type {Promise<string>} */ (new Promise((resolve) => c.on("close", () => resolve(out.trim())))) };
}

/** An assert.throws validator: a `busy` whose message passes `ok`. @param {(message: string) => boolean} ok */
const busyWith = (ok) => (/** @type {unknown} */ e) => e instanceof ReviewLoopError && e.code === "busy" && ok(e.message);

const lockEvents = () => {
  const file = path.join(stateRoot(), "events.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const cleanupFailures = () => lockEvents().filter((e) => e.event === "hook.error" && e.code === "lock_marker_cleanup_failed" && e.data.stage === "lock_marker_cleanup");

test("lock: eight processes racing to reclaim a stale lock, 25 rounds → exactly one holder every round", { timeout: 240_000 }, async () => {
  for (let i = 0; i < 25; i++) {
    const key = lk(`stress-${i}`);
    staleLock(key);
    const results = await Promise.all(Array.from({ length: 8 }, () => contender(key).done));
    assert.equal(results.filter((r) => r === "won").length, 1, `round ${i}: ${results.join(",")}`);
    assert.ok(results.every((r) => r === "won" || r === "busy"), `round ${i}: ${results.join(",")}`);
  }
});

test("lock section: a marker is never visible empty or half-written", async () => {
  const key = lk("atomic");
  const script = `
    process.env.REVIEW_LOOP_STATE_DIR=${JSON.stringify(stateRoot())};
    const { acquireLock } = await import(${JSON.stringify(STATE_MJS)});
    for (let i = 0; i < 150; i++) acquireLock(${JSON.stringify(key)}, "s").release();`;
  fs.mkdirSync(locksDir(), { recursive: true });
  const c = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_MARKER_CHECK_PAUSE_MS: "2" } });
  let running = true;
  c.on("close", () => (running = false));
  let seen = 0;
  while (running) {
    for (const n of fs.readdirSync(locksDir())) {
      if (markerName(key, n) === null) continue;
      let raw;
      try {
        raw = fs.readFileSync(path.join(locksDir(), n), "utf8");
      } catch {
        continue;
      }
      const v = JSON.parse(raw);
      assert.ok(Number.isInteger(v.pid) && /^[0-9a-f]{64}$/.test(v.ident) && /^[0-9a-f]{32}$/.test(v.token), raw);
      seen++;
    }
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(seen > 0, "the poller saw markers while they existed");
  const src = fs.readFileSync(new URL(STATE_MJS), "utf8");
  assert.match(src, /publishLock\(own, /, "markers are published by link(), like the lock itself");
  assert.doesNotMatch(src, /"wx"/);
});

test("lock section: a mover paused inside the section keeps it; contenders arriving meanwhile get busy, and its lock is the one on disk", async () => {
  const key = lk("sec-pause");
  staleLock(key);
  const a = contender(key, { env: { REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_SECTION_PAUSE_MS: "2000" }, holdMs: 0 });
  await waitFor(() => markersOf(key).length > 0);
  await pause(150);
  const others = await Promise.all([contender(key).done, contender(key).done]);
  assert.deepEqual(others, ["busy", "busy"]);
  assert.equal(await a.done, "won");
  assert.equal(JSON.parse(fs.readFileSync(lockFile(key), "utf8")).pid, a.pid);
});

test("lock section: two contenders that publish, then both check, never both enter", async () => {
  const key = lk("sec-both");
  staleLock(key);
  const env = { REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_MARKER_CHECK_PAUSE_MS: "300" };
  const results = await Promise.all([contender(key, { env }).done, contender(key, { env }).done]);
  assert.ok(results.filter((r) => r === "won").length <= 1, results.join(","));
  assert.ok(results.every((r) => r === "won" || r === "busy"), results.join(","));
});

test("lock section: a suspended mover keeps its section however old its marker looks", async () => {
  const key = lk("sec-suspended");
  staleLock(key);
  const a = contender(key, { env: { REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_SECTION_PAUSE_MS: "2500" }, holdMs: 0 });
  await waitFor(() => markersOf(key).length > 0);
  await pause(150);
  const old = (Date.now() - 10 * 3600_000) / 1000;
  for (const n of markersOf(key)) fs.utimesSync(path.join(locksDir(), n), old, old);
  assert.equal(await contender(key).done, "busy", "A's PID is alive with the same identity: its marker is live");
  assert.equal(await a.done, "won");
  assert.equal(JSON.parse(fs.readFileSync(lockFile(key), "utf8")).pid, a.pid);
});

test("lock section: release never moves a lock it doesn't own — a holder judged stale while alive leaves its successor untouched", async () => {
  const id = { kind: "spec", path: "/r/docs/specs/release.md" };
  const key = identityKey(id);
  const h = acquireLock(key, "s");
  fs.utimesSync(lockFile(key), 0, 0); // H's heartbeat stopped: alive, but judged stale
  assert.equal(await contender(key, { holdMs: 0 }).done, "won");
  const successor = fs.readFileSync(lockFile(key), "utf8");
  const ino = fs.lstatSync(lockFile(key)).ino;
  assert.throws(() => writeRecord(newRecord(id)), { code: "lock_lost" }, "the stale holder is fenced, as always");
  const rename = mock.method(fs, "renameSync");
  try {
    h.release();
  } finally {
    rename.mock.restore();
  }
  assert.equal(rename.mock.calls.filter((c) => c.arguments[0] === lockFile(key)).length, 0, "the successor's lock was never moved aside");
  assert.equal(fs.readFileSync(lockFile(key), "utf8"), successor);
  assert.equal(fs.lstatSync(lockFile(key)).ino, ino);
});

test("lock section: a release that finds the section busy is deferred with its token; the retry never removes a successor's lock", async (t) => {
  const s = sleeper();
  t.after(s.stop);
  const key = lk("deferred");
  const h = acquireLock(key, "s");
  const blocker = markerFile(key, s.pid);
  fs.writeFileSync(blocker, markerBody(s.pid, processIdent(s.pid)));
  h.release();
  assert.deepEqual(pendingReleaseKeys(), [key]);
  assert.ok(lockEvents().some((e) => e.code === "busy" && e.data.stage === "lock_release_deferred"));
  fs.rmSync(blocker);
  fs.utimesSync(lockFile(key), 0, 0);
  assert.equal(await contender(key, { holdMs: 0 }).done, "won");
  const successor = fs.readFileSync(lockFile(key), "utf8");
  const ino = fs.lstatSync(lockFile(key)).ino;
  acquireLock(lk("deferred-next"), "s").release(); // any later lock call retries the deferred release
  assert.deepEqual(pendingReleaseKeys(), []);
  assert.equal(fs.readFileSync(lockFile(key), "utf8"), successor, "the successor's lock is untouched");
  assert.equal(fs.lstatSync(lockFile(key)).ino, ino);

  // Control: with no successor, the same retry removes our own lock.
  const key2 = lk("deferred-own");
  const h2 = acquireLock(key2, "s");
  fs.writeFileSync(markerFile(key2, s.pid), markerBody(s.pid, processIdent(s.pid)));
  h2.release();
  assert.deepEqual(pendingReleaseKeys(), [key2]);
  fs.rmSync(markerFile(key2, s.pid));
  acquireLock(lk("deferred-next"), "s").release();
  assert.deepEqual(pendingReleaseKeys(), []);
  assert.ok(!fs.existsSync(lockFile(key2)));
});

test("lock: a pre-1.0.3 mover (no section) that displaces a holder during an upgrade is fenced by writeRecord, as before", () => {
  const id = { kind: "spec", path: "/r/docs/specs/skew.md" };
  const key = identityKey(id);
  const h = acquireLock(key, "s");
  const old = JSON.stringify({ pid: process.pid, session: "v1.0.2", token: "0".repeat(32) });
  // What a 1.0.2 reclaimer does without a section: move the path aside, publish its own lock.
  fs.renameSync(lockFile(key), `${lockFile(key)}.aside.old`);
  fs.writeFileSync(lockFile(key), old);
  assert.throws(() => writeRecord(newRecord(id)), { code: "lock_lost" });
  h.release();
  assert.equal(fs.readFileSync(lockFile(key), "utf8"), old, "and our release leaves the old version's lock alone");
});

test("lock section: a marker is stale only when its owner is gone — a dead PID, or a different process at that PID", async (t) => {
  const s = sleeper();
  t.after(s.stop);
  const key = lk("owner");
  const dead = /** @type {number} */ (spawnSync("/usr/bin/true").pid);
  /** @param {number} pid @param {string} ident */
  const reclaimedPast = (pid, ident) => {
    staleLock(key);
    fs.writeFileSync(markerFile(key, pid), markerBody(pid, ident));
    acquireLock(key, "s").release();
    return !fs.existsSync(markerFile(key, pid));
  };
  assert.ok(reclaimedPast(dead, sha256hex("x")), "dead PID: stale, removed");
  assert.ok(reclaimedPast(s.pid, sha256hex("Thu Jan  1 00:00:00 1970  node x")), "a reused PID: another process's identity");
  assert.ok(reclaimedPast(s.pid, sha256hex(psLine(s.pid).replace("sleep", "sleeq"))), "same start second, different command");
  staleLock(key);
  fs.writeFileSync(markerFile(key, s.pid), markerBody(s.pid, processIdent(s.pid)));
  assert.throws(() => acquireLock(key, "s"), busyWith((m) => m.includes(`process ${s.pid}`) && /end it/.test(m)));
  fs.rmSync(markerFile(key, s.pid));
});

test("lock section: names outside PID 2–99999 are never markers — they never block, and kill() is never asked about 0 or 1", () => {
  const key = lk("pid-range");
  staleLock(key);
  for (const pid of ["0", "1", "100000", "01234"]) fs.writeFileSync(path.join(locksDir(), `${key}.lock.reclaim.${pid}.${HEX}`), markerBody(Number(pid), "a".repeat(64)));
  const kill = mock.method(process, "kill");
  try {
    acquireLock(key, "s").release();
  } finally {
    kill.mock.restore();
  }
  assert.equal(kill.mock.calls.filter((c) => c.arguments[0] === 0 || c.arguments[0] === 1).length, 0);
  assert.equal(markerName(key, `${key}.lock.reclaim.1.${HEX}`), null);
  assert.equal(markerName(key, `${key}.lock.reclaim.100000.${HEX}`), null);
  assert.deepEqual(markerName(key, `${key}.lock.reclaim.2.${HEX}`), { pid: 2, hex: HEX });
});

test("lock section: an owner's identity reads the same from another time zone and after a clock jump", async (t) => {
  const key = lk("zone");
  staleLock(key);
  const a = contender(key, { env: { TZ: "Asia/Tokyo", REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_SECTION_PAUSE_MS: "2500" }, holdMs: 0 });
  await waitFor(() => markersOf(key).length > 0);
  await pause(150);
  const prevTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 3600_000 });
  t.after(() => {
    mock.timers.reset();
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });
  const body = JSON.parse(fs.readFileSync(path.join(locksDir(), markersOf(key)[0]), "utf8"));
  assert.equal(body.ident, processIdent(a.pid), "owner and checker read the same identity");
  assert.throws(() => acquireLock(key, "s"), { code: "busy" });
  assert.equal(await a.done, "won");
});

test("lock section: identity comes from /bin/ps alone — a PATH ps can't fake a mismatch, and a failing ps counts as live", async (t) => {
  const s = sleeper();
  t.after(s.stop);
  acquireLock(lk("ps-warm"), "s").release(); // this process's own identity is read once, and cached
  const key = lk("ps");
  const live = /** @type {string} */ (processIdent(s.pid));
  const bin = tmpDir("rl-ps-");
  fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\necho 'Thu Jan  1 00:00:00 1970  liar'\n", { mode: 0o755 });
  const saved = { PATH: process.env.PATH, SEAMS: process.env.REVIEW_LOOP_TEST_SEAMS, PS: process.env.REVIEW_LOOP_TEST_PS_PATH };
  t.after(() => {
    process.env.PATH = saved.PATH;
    for (const [k, v] of [["REVIEW_LOOP_TEST_SEAMS", saved.SEAMS], ["REVIEW_LOOP_TEST_PS_PATH", saved.PS]]) {
      if (v === undefined) delete process.env[/** @type {string} */ (k)];
      else process.env[/** @type {string} */ (k)] = v;
    }
  });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  staleLock(key);
  fs.writeFileSync(markerFile(key, s.pid), markerBody(s.pid, live));
  assert.throws(() => acquireLock(key, "s"), { code: "busy" }, "a misleading ps on PATH is never consulted");
  process.env.REVIEW_LOOP_TEST_SEAMS = "1";
  for (const [label, body] of [["exits 1", "exit 1"], ["prints nothing", "exit 0"], ["hangs", "exec /bin/sleep 5"]]) {
    fs.writeFileSync(path.join(bin, "badps"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    process.env.REVIEW_LOOP_TEST_PS_PATH = path.join(bin, "badps");
    assert.throws(() => acquireLock(key, "s"), { code: "busy" }, `a ps that ${label} leaves the marker live`);
  }
  fs.rmSync(markerFile(key, s.pid));
  const fresh = lk("ps-self");
  staleLock(fresh);
  fs.writeFileSync(path.join(bin, "badps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const own = contender(fresh, { env: { REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_PS_PATH: path.join(bin, "badps") } });
  assert.equal(await own.done, "lock_identity_unavailable");
  assert.deepEqual(fs.readdirSync(locksDir()).filter((n) => n.startsWith(`${fresh}.lock.reclaim.`)), [], "no identity, no marker");

  const src = fs.readFileSync(new URL(STATE_MJS), "utf8");
  assert.match(src, /: "\/bin\/ps";/);
  assert.match(src, /env: \{ PATH: "\/usr\/bin:\/bin", LC_ALL: "C", TZ: "UTC" \}/);
  assert.doesNotMatch(src, /execFileSync\("ps"/);
  const root = new URL("../../", import.meta.url).pathname;
  for (const dir of ["plugin", "cli"]) {
    for (const rel of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      if (!String(rel).endsWith(".mjs")) continue;
      assert.doesNotMatch(fs.readFileSync(path.join(root, dir, String(rel)), "utf8"), /process\.title\s*=/, `${dir}/${rel} must not change the command line identity hashes`);
    }
  }
});

test("lock section: a marker that can't be read, or doesn't agree with its own name, is judged by the PID in its name — live while that PID lives, whatever its age", { skip: process.getuid?.() === 0 }, async (t) => {
  const s = sleeper();
  t.after(s.stop);
  const key = lk("unverified");
  const ident = /** @type {string} */ (processIdent(s.pid));
  const target = path.join(tmpDir("rl-mk-"), "real.json");
  fs.writeFileSync(target, markerBody(s.pid, ident));
  /** @type {Record<string, (f: string) => void>} */
  const variants = {
    unreadable: (f) => fs.writeFileSync(f, markerBody(s.pid, ident), { mode: 0o000 }),
    symlink: (f) => fs.symlinkSync(target, f),
    fifo: (f) => execFileSync("mkfifo", [f]),
    oversized: (f) => fs.writeFileSync(f, "x".repeat(10 * 1024 * 1024)),
    "bad JSON": (f) => fs.writeFileSync(f, "{"),
    "pid differs from the name": (f) => fs.writeFileSync(f, markerBody(s.pid + 1, ident)),
    "ident not 64 hex": (f) => fs.writeFileSync(f, markerBody(s.pid, "abc")),
    "token not the name's": (f) => fs.writeFileSync(f, JSON.stringify({ pid: s.pid, ident, token: "e".repeat(32) }))
  };
  const readSync = mock.method(fs, "readSync");
  try {
    for (const [label, make] of Object.entries(variants)) {
      staleLock(key);
      const f = markerFile(key, s.pid);
      make(f);
      const old = (Date.now() - 10 * 3600_000) / 1000;
      fs.lutimesSync(f, old, old);
      assert.throws(
        () => acquireLock(key, "s"),
        busyWith((m) => m.includes(f) && m.includes(`pid ${s.pid}`) && !/end it/.test(m)),
        label
      );
      fs.rmSync(f); // what the message tells the operator to do, after checking `ps`
      acquireLock(key, "s").release();
    }
  } finally {
    readSync.mock.restore();
  }
  assert.equal(readSync.mock.calls.filter((c) => c.arguments[3] > 4096).length, 0, "never reads more than the lock bound");
  staleLock(key);
  fs.writeFileSync(markerFile(key, s.pid), "{");
  await s.stop();
  acquireLock(key, "s").release();
  assert.ok(!fs.existsSync(markerFile(key, s.pid)), "once the named PID is dead, the next contender removes it");
});

// Marker unlinks fail. Temp files are spared: on Node 22, publishLock's rmSync goes through the public unlinkSync.
const realUnlink = fs.unlinkSync.bind(fs);
const isMarkerPath = (/** @type {fs.PathLike} */ p) => String(p).includes(".lock.reclaim.") && !String(p).endsWith(".tmp");
const failMarkerUnlinks = () =>
  mock.method(fs, "unlinkSync", (/** @type {fs.PathLike} */ p) => {
    if (isMarkerPath(p)) throw Object.assign(new Error("EACCES: refused"), { code: "EACCES" });
    return realUnlink(p);
  });

test("lock section: a marker that can't be removed never costs the acquirer its lock; it is logged and retried (won path, then release)", () => {
  const key = lk("strand-a");
  staleLock(key);
  const m = failMarkerUnlinks();
  let h;
  try {
    h = acquireLock(key, "s");
  } finally {
    m.mock.restore();
  }
  assert.equal(JSON.parse(fs.readFileSync(lockFile(key), "utf8")).pid, process.pid, "the lock was published and its handle returned");
  assert.equal(cleanupFailures().length, 1);
  assert.equal(markersOf(key).length, 1, "the stranded marker");
  h.release();
  assert.deepEqual(fs.readdirSync(locksDir()).filter((n) => n.startsWith(key)), [], "release removed the stranded marker and the lock");
  assert.equal(cleanupFailures().length, 1, "a successful retry logs nothing");

  // The failure kept through release(): the lock still goes; each failed unlink is logged once.
  const key2 = lk("strand-b");
  staleLock(key2);
  const m2 = failMarkerUnlinks();
  try {
    acquireLock(key2, "s").release();
  } finally {
    m2.mock.restore();
  }
  assert.ok(!fs.existsSync(lockFile(key2)));
  assert.equal(cleanupFailures().length, 4, "1 from the first case, then acquire's marker, release's retry of it, and release's own marker");
  acquireLock(lk("strand-next"), "s").release();
  assert.deepEqual(markersOf(key2), [], "the next lock call clears both");
});

test("lock section: busy path — stranded markers of a live process are retried on its next lock call, then a contender gets in", async (t) => {
  const s = sleeper();
  t.after(s.stop);
  const key = lk("strand-c");
  staleLock(key);
  fs.writeFileSync(markerFile(key, s.pid), markerBody(s.pid, processIdent(s.pid)));
  const m = failMarkerUnlinks();
  try {
    assert.throws(() => acquireLock(key, "s"), { code: "busy" });
  } finally {
    m.mock.restore();
  }
  const failed = cleanupFailures().length;
  assert.equal(failed, 4, "one per section attempt");
  assert.equal(markersOf(key).length, 5, "four of ours, stranded, plus the blocker");
  acquireLock(lk("strand-c-next"), "s").release();
  assert.deepEqual(markersOf(key), [path.basename(markerFile(key, s.pid))], "ours are gone; only the blocker is left");
  assert.equal(cleanupFailures().length, failed, "no new failures");
  await s.stop();
  assert.equal(await contender(key, { holdMs: 0 }).done, "won");
});

test("lock section: the exit handler retries a stranded marker; if it still fails the PID's death frees it", async () => {
  /** @param {string} key @param {boolean} restoreBeforeExit */
  const run = (key, restoreBeforeExit) =>
    new Promise((resolve) => {
      const script = `
        process.env.REVIEW_LOOP_STATE_DIR=${JSON.stringify(stateRoot())};
        const fs = (await import("node:fs")).default;
        const real = fs.unlinkSync;
        fs.unlinkSync = (p, ...r) => { if (String(p).includes(".lock.reclaim.") && !String(p).endsWith(".tmp")) throw Object.assign(new Error("refused"), { code: "EACCES" }); return real.call(fs, p, ...r); };
        const { acquireLock } = await import(${JSON.stringify(STATE_MJS)});
        acquireLock(${JSON.stringify(key)}, "s");
        if (${restoreBeforeExit}) fs.unlinkSync = real;
        process.exit(0);`;
      spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }).on("close", resolve);
    });
  const key = lk("strand-d");
  staleLock(key);
  await run(key, false);
  assert.equal(cleanupFailures().length, 2, "acquire's unlink, then the exit handler's retry");
  assert.equal(markersOf(key).length, 1);
  acquireLock(key, "s").release(); // the subprocess is gone: its lock and its marker are both stale
  assert.deepEqual(markersOf(key), []);

  const key2 = lk("strand-d2");
  staleLock(key2);
  await run(key2, true);
  assert.equal(cleanupFailures().length, 3, "acquire's unlink only");
  assert.deepEqual(markersOf(key2), [], "the exit handler removed it");
});

test("lock section: publishLock's temp files are never markers, and litter past the TTL is removed", (t) => {
  const s = sleeper();
  t.after(s.stop);
  const key = lk("litter");
  staleLock(key);
  const marker = markerFile(key, s.pid);
  const tmp = publishTempName(marker);
  fs.writeFileSync(tmp, '{"pid":');
  acquireLock(key, "s").release();
  assert.ok(fs.existsSync(tmp), "a fresh temp file is left alone, and didn't block");
  const old = (Date.now() - LOCK_TTL_MS - 60_000) / 1000;
  fs.utimesSync(tmp, old, old);
  staleLock(key);
  acquireLock(key, "s").release();
  assert.ok(!fs.existsSync(tmp), "litter past the TTL is removed by name");
  assert.equal(markerName(key, path.basename(tmp)), null);
  assert.deepEqual(markerName(key, path.basename(marker)), { pid: s.pid, hex: HEX });
  assert.equal(markerName(lk("another"), path.basename(marker)), null);
  assert.equal(markerName(key, `${path.basename(marker)}.x`), null);
});

test("lock section: no leftovers — after a won race only the lock remains, after release nothing", () => {
  const key = lk("leftovers");
  staleLock(key);
  const h = acquireLock(key, "s");
  assert.deepEqual(fs.readdirSync(locksDir()).filter((n) => n.startsWith(key)), [`${key}.lock`]);
  h.release();
  assert.deepEqual(fs.readdirSync(locksDir()).filter((n) => n.startsWith(key)), []);
});
