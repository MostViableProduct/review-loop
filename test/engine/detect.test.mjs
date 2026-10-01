import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { snapshotSession, pendingForSession, detectPlansDir, identityForTouchedPath, docFingerprint } from "../../plugin/engine/lib/detect.mjs";
import { newRecord, writeRecord, writeMarker, identityKey, acquireLock } from "../../plugin/engine/lib/state.mjs";
import { implFingerprint } from "../../plugin/engine/lib/git.mjs";
import { g, makeRepo, commitFile, writeFile, tmpDir } from "./helpers.mjs";
import { readArtifact } from "../../plugin/engine/lib/git.mjs";

beforeEach(() => {
  process.env.REVIEW_LOOP_STATE_DIR = tmpDir("rl-state-");
});

function repoWithHistory() {
  const repo = makeRepo();
  writeFile(repo, ".gitignore", "build/\n*.local.md\n");
  g(repo, "add", ".gitignore");
  commitFile(repo, "src/a.ts", "a");
  commitFile(repo, "docs/specs/old.md", "old spec");
  return repo;
}

const S = "session-1";
const repoItems = async (repo) => (await pendingForSession(S, repo)).items.filter((i) => !i.label.includes("/.claude/plans/"));

function pass(identity, fingerprint) {
  const r = newRecord(identity);
  r.status = "passed";
  r.reviewedFingerprint = fingerprint;
  writeRecord(r);
}

test("a keyless branch marker for this session cannot crash the scan; a linked state dir blocks with a code", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const branch = { kind: "branch", baseRepo: "o/r", baseBranch: "main", headRepo: "o/r", headBranch: "f" };
  const dir = path.join(process.env.REVIEW_LOOP_STATE_DIR, "markers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "x.json"), JSON.stringify({ v: 1, identity: branch, source: "pr", projectRoot: repo, session: S, extra: {} }));
  assert.deepEqual(await repoItems(repo), [], "the marker is quarantined, not dereferenced");
  fs.rmSync(dir, { recursive: true });
  fs.symlinkSync(tmpDir("rl-outside-"), dir);
  const items = await repoItems(repo);
  assert.deepEqual(items.map((i) => [i.kind, i.reason, i.blocking]), [["scan", "state_symlink_rejected", true]]);
});

test("a raw I/O error inside the scan (not a coded one) still blocks, with its errno", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const dir = path.join(process.env.REVIEW_LOOP_STATE_DIR, "markers");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o000);
  try {
    const items = await repoItems(repo);
    assert.deepEqual(items.map((i) => [i.kind, i.reason, i.blocking]), [["scan", "unexpected_error:EACCES", true]]);
    const log = path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
    fs.rmSync(log, { force: true });
    fs.mkdirSync(log);
    const unlogged = await repoItems(repo);
    assert.deepEqual(unlogged.map((i) => [i.kind, i.blocking]), [["scan", true]], "still blocks when the event log cannot be written either");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("nothing changed since session start → nothing pending", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  assert.deepEqual(await repoItems(repo), []);
});

test("a spec written via Bash (no file-tool marker) is pending and blocking, with the exact run command", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  writeFile(repo, "docs/specs/new-feature.md", "# spec");
  const items = await repoItems(repo);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "spec");
  assert.equal(items[0].blocking, true);
  assert.match(items[0].command, /^node ".*\/review-round\.mjs" run --kind spec --path ".*docs\/specs\/new-feature\.md"/);
});

test("a spec already dirty at session start is not pending until the session changes it", async () => {
  const repo = repoWithHistory();
  writeFile(repo, "docs/specs/old.md", "user's uncommitted edit");
  await snapshotSession(S, repo);
  assert.deepEqual(await repoItems(repo), []);
  writeFile(repo, "docs/specs/old.md", "claude's edit");
  assert.equal((await repoItems(repo)).length, 1);
});

test("implementation change is pending; a pass at the fingerprint clears it", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  writeFile(repo, "src/a.ts", "a2");
  const items = await repoItems(repo);
  assert.deepEqual(items.map((i) => i.kind), ["impl"]);
  pass({ kind: "impl", path: repo }, (await implFingerprint(repo))?.fingerprint);
  assert.deepEqual(await repoItems(repo), []);
});

test("rename carries a pass (plain mv, same content); rename+edit does not", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const oldAbs = path.join(repo, "docs/specs/old.md");
  pass({ kind: "spec", path: oldAbs }, docFingerprint(oldAbs).fingerprint);
  fs.renameSync(oldAbs, path.join(repo, "docs/specs/renamed.md"));
  assert.deepEqual(await repoItems(repo), [], "plain mv of a passed spec stays cleared");
  fs.appendFileSync(path.join(repo, "docs/specs/renamed.md"), "edit");
  assert.equal((await repoItems(repo)).length, 1);
});

test("identical content at a different path does not share a pass", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const oldAbs = path.join(repo, "docs/specs/old.md");
  pass({ kind: "spec", path: oldAbs }, docFingerprint(oldAbs).fingerprint);
  writeFile(repo, "docs/specs/copy.md", "old spec");
  assert.equal((await repoItems(repo)).length, 1, "a copy (no rename evidence) is pending");
});

test("individually ignored spec is detected; spec inside an ignored dir needs a file-tool marker", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  writeFile(repo, "docs/specs/x.local.md", "ignored file");
  writeFile(repo, "build/specs/deep.md", "ignored dir");
  let items = await repoItems(repo);
  assert.deepEqual(items.map((i) => path.basename(i.label)), ["x.local.md"], "documented limit: ignored-dir file created by Bash is not seen");
  writeMarker({ kind: "spec", path: path.join(repo, "build/specs/deep.md") }, { source: "track", projectRoot: repo, session: S });
  items = await repoItems(repo);
  assert.ok(items.some((i) => i.label.endsWith("build/specs/deep.md")), "file-tool marker catches it");
});

test("a symlinked spec is pending with its rejection reason; its target is never read", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const secret = path.join(tmpDir(), "id_rsa");
  fs.writeFileSync(secret, "KEY");
  fs.symlinkSync(secret, path.join(repo, "docs/specs/evil.md"));
  const [item] = await repoItems(repo);
  assert.equal(item.reason, "artifact_symlink_rejected");
  assert.equal(item.blocking, true);
});

test("a spec under a symlinked parent dir is pending with its rejection reason; the outside file is never read", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const outside = tmpDir();
  fs.writeFileSync(path.join(outside, "notes.md"), "SECRET");
  fs.mkdirSync(path.join(repo, "build"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, "build/specs"));
  const abs = path.join(repo, "build/specs/notes.md");
  writeMarker({ kind: "spec", path: abs }, { source: "track", projectRoot: repo, session: S });
  const [item] = await repoItems(repo);
  assert.equal(item.reason, "artifact_symlink_rejected");
  assert.equal(item.blocking, true);
  assert.throws(() => readArtifact(abs, repo), { code: "artifact_symlink_rejected" }, "the review round reads through the same guard");
});

test("an over-limit spec edited while staying over the limit is pending; untouched it stays quiet", async () => {
  const repo = repoWithHistory();
  const big = writeFile(repo, "docs/specs/huge.md", "x".repeat(1024 * 1024 + 10));
  await snapshotSession(S, repo);
  assert.deepEqual(await repoItems(repo), [], "a pre-existing failure alone does not block");
  fs.appendFileSync(big, "edited, still too large");
  const [item] = await repoItems(repo);
  assert.deepEqual([item?.reason, item?.blocking], ["artifact_too_large", true]);
});

test("a review whose retries are exhausted still blocks, and says so — only the user can clear it", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const abs = writeFile(repo, "docs/specs/n.md", "x");
  const r = newRecord({ kind: "spec", path: abs });
  r.status = "op_error";
  r.errorAttempts = 3;
  r.lastError = { code: "codex_timeout", message: "m", at: new Date().toISOString() };
  writeRecord(r);
  const [item] = await repoItems(repo);
  assert.equal(item.blocking, true);
  assert.match(item.reason ?? "", /codex_timeout, 3 attempts — retries exhausted/);
});

test("an over-limit spec edited in place with its size and mtime restored is still pending (ctime cannot be restored)", async () => {
  const repo = repoWithHistory();
  const big = writeFile(repo, "docs/specs/huge.md", "a".repeat(1024 * 1024 + 10));
  // A whole-second mtime restores exactly (a Date round-trip would drop sub-ms digits and change mtimeMs by itself).
  const pinned = Math.floor(Date.now() / 1000) - 60;
  fs.utimesSync(big, pinned, pinned);
  const before = fs.statSync(big);
  await snapshotSession(S, repo);
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(big, "b".repeat(1024 * 1024 + 10));
  fs.utimesSync(big, pinned, pinned);
  const after = fs.statSync(big);
  assert.deepEqual([after.size, after.mtimeMs, after.ino], [before.size, before.mtimeMs, before.ino], "size, mtime and inode look untouched");
  assert.notEqual(after.ctimeMs, before.ctimeMs, "only ctime records the edit");
  const [item] = await repoItems(repo);
  assert.deepEqual([item?.reason, item?.blocking], ["artifact_too_large", true]);
});

test("awaiting_human and stopped are shown but do not block", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const abs = writeFile(repo, "docs/specs/n.md", "x");
  const r = newRecord({ kind: "spec", path: abs });
  r.status = "awaiting_human";
  r.awaiting = { reason: "checkpoint", detail: {}, options: ["continue", "more", "accept", "stop"] };
  writeRecord(r);
  const [item] = await repoItems(repo);
  assert.equal(item.status, "awaiting_human");
  assert.equal(item.blocking, false);
});

test("a round in flight (live lock) still blocks, and says to wait rather than re-run", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  const abs = writeFile(repo, "docs/specs/n.md", "x");
  const r = newRecord({ kind: "spec", path: abs });
  r.status = "reviewing";
  writeRecord(r);
  const lock = acquireLock(identityKey({ kind: "spec", path: abs }), "s");
  try {
    const [item] = await repoItems(repo);
    assert.deepEqual([item.status, item.blocking, item.reason], ["reviewing", true, "round_in_progress"]);
    assert.match(item.command, /^wait for the running round/);
  } finally {
    lock.release();
  }
  const [stale] = await repoItems(repo);
  assert.deepEqual([stale.status, stale.blocking], ["op_error", true], "a dead round is an op_error, still blocking");
});

test("a kill switch present when the session started suppresses repo artifacts and is reported", async () => {
  const repo = repoWithHistory();
  writeFile(repo, ".claude/review-loop.off", "");
  await snapshotSession(S, repo);
  writeFile(repo, "src/a.ts", "changed");
  const res = await pendingForSession(S, repo);
  assert.equal(res.killSwitchRoot, repo);
  assert.deepEqual(res.items.filter((i) => !i.label.includes("/.claude/plans/")), []);
});

test("a kill switch created mid-session (e.g. by the agent) is ignored until the next session, and says so", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  writeFile(repo, "src/a.ts", "changed");
  writeFile(repo, ".claude/review-loop.off", "");
  const res = await pendingForSession(S, repo);
  assert.equal(res.killSwitchRoot, null);
  assert.deepEqual(res.killSwitchIgnored, { root: repo, why: "mid_session" });
  assert.deepEqual((await repoItems(repo)).map((i) => [i.kind, i.blocking]), [["impl", true]]);
  await snapshotSession("next-session", repo);
  assert.equal((await pendingForSession("next-session", repo)).killSwitchRoot, repo, "honored from the next session on");
});

test("plans dir: new top-level plan is detected; symlinks fingerprint as an error, never followed", () => {
  const dir = tmpDir("rl-plans-");
  fs.writeFileSync(path.join(dir, "a.md"), "plan a");
  fs.symlinkSync("/etc/hosts", path.join(dir, "b.md"));
  const list = detectPlansDir("/proj", dir);
  assert.equal(list.length, 2);
  assert.match(list.find((a) => a.identity.path.endsWith("b.md"))?.fingerprint ?? "", /^error:artifact_symlink_rejected:[0-9a-f]{16}$/);
});

test("plans dir that is itself a symlink (or not a directory) fails with plans_dir_untrusted; absent is an empty list", () => {
  const real = tmpDir("rl-plans-");
  fs.writeFileSync(path.join(real, "a.md"), "plan a");
  const link = path.join(tmpDir(), "plans");
  fs.symlinkSync(real, link);
  assert.throws(() => detectPlansDir("/proj", link), { code: "plans_dir_untrusted" });
  const file = path.join(tmpDir(), "plans");
  fs.writeFileSync(file, "x");
  assert.throws(() => detectPlansDir("/proj", file), { code: "plans_dir_untrusted" });
  assert.deepEqual(detectPlansDir("/proj", path.join(tmpDir(), "absent")), []);
  assert.equal(detectPlansDir("/proj", real).length, 1, "control: the real directory is read");
});

test("plans dir over the scan cap fails with plans_scan_limit instead of a partial list", () => {
  const dir = tmpDir("rl-plans-");
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(dir, `p${i}.md`), "");
  assert.equal(detectPlansDir("/proj", dir).length, 2000, "at the cap: every plan is scanned");
  fs.writeFileSync(path.join(dir, "zzz-2001.md"), "");
  assert.throws(() => detectPlansDir("/proj", dir), { code: "plans_scan_limit" });
});

test("identityForTouchedPath: specs/plans only", () => {
  assert.deepEqual(identityForTouchedPath("/r/docs/specs/a.md", "/r"), { kind: "spec", path: "/r/docs/specs/a.md" });
  assert.equal(identityForTouchedPath("/r/src/a.ts", "/r"), null);
  assert.equal(identityForTouchedPath("/r/README.md", "/r"), null);
});

test("markers from other sessions are ignored", async () => {
  const repo = repoWithHistory();
  await snapshotSession(S, repo);
  writeMarker({ kind: "spec", path: path.join(repo, "docs/specs/old.md") }, { source: "track", projectRoot: repo, session: "other" });
  fs.appendFileSync(path.join(repo, "docs/specs/old.md"), "x");
  const items = await repoItems(repo);
  assert.equal(items.length, 1, "still detected via git, exactly once");
  assert.equal(items[0].key, identityKey({ kind: "spec", path: path.join(repo, "docs/specs/old.md") }));
});
