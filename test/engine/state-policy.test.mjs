import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
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
  readPendingSummary
} from "../../plugin/engine/lib/state.mjs";

const observe = (/** @type {string} */ file) => {
  const st = fs.lstatSync(file);
  return { raw: fs.readFileSync(file, "utf8"), mtimeMs: st.mtimeMs, ino: st.ino };
};
import { applyRoundResult, applyDecision, resetIfNewLoop, sameFinding, withoutWaived, EXIT } from "../../plugin/engine/lib/policy.mjs";
import { scoreFindings } from "../../plugin/engine/lib/scoring.mjs";
import { tmpDir } from "./helpers.mjs";
import { sha256hex } from "../../plugin/engine/lib/fsutil.mjs";

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
