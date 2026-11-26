import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  statusEntries,
  blobId,
  renameSource,
  implFingerprint,
  mergeBaseValidity,
  readShallowSet,
  fetchExactRef,
  parseGithubUrl,
  objectFormat,
  readArtifact
} from "../../plugin/engine/lib/git.mjs";
import { streamHash, streamLines } from "../../plugin/engine/lib/proc.mjs";
import { g, makeRepo, commitFile, writeFile, crissCrossRepo, tmpDir, GIT_ENV } from "./helpers.mjs";
import { repoRoot, committedPaths } from "../../plugin/engine/lib/git.mjs";

test("blobId matches git hash-object --stdin", () => {
  const repo = makeRepo();
  for (const s of ["", "hello\n", "x".repeat(10_000)]) {
    const expected = execFileSync("git", ["hash-object", "--stdin"], { cwd: repo, input: s, encoding: "utf8" }).trim();
    assert.equal(blobId(Buffer.from(s), "sha1"), expected);
  }
});

test("status parsing: staged rename, untracked, individually ignored file, collapsed ignored dir", async () => {
  const repo = makeRepo();
  writeFile(repo, ".gitignore", "node_modules/\n*.local.md\n");
  commitFile(repo, "docs/specs/a.md", "spec body");
  g(repo, "add", ".gitignore");
  g(repo, "commit", "-q", "-m", "ignore");
  g(repo, "mv", "docs/specs/a.md", "docs/specs/b.md");
  writeFile(repo, "src/new.ts", "x");
  writeFile(repo, "docs/specs/z.local.md", "ignored spec");
  writeFile(repo, "node_modules/p/q-spec.md", "deep");
  const e = await statusEntries(repo);
  assert.ok(e.some((x) => x.type === "2" && x.path === "docs/specs/b.md" && x.origPath === "docs/specs/a.md"));
  assert.ok(e.some((x) => x.type === "?" && x.path === "src/new.ts"));
  assert.ok(e.some((x) => x.type === "!" && x.path === "docs/specs/z.local.md"));
  assert.ok(e.some((x) => x.type === "!" && x.path === "node_modules/"));
  assert.ok(!e.some((x) => x.path.includes("q-spec.md")), "ignored directories are never walked");
});

test("rename evidence: staged R, plain mv with matching blob, and negatives", async () => {
  const repo = makeRepo();
  commitFile(repo, "docs/specs/a.md", "same content");
  const fmt = await objectFormat(repo);

  fs.renameSync(path.join(repo, "docs/specs/a.md"), path.join(repo, "docs/specs/b.md"));
  let e = await statusEntries(repo);
  assert.equal(renameSource(e, "docs/specs/b.md", Buffer.from("same content"), fmt), "docs/specs/a.md", "plain mv");
  assert.equal(renameSource(e, "docs/specs/b.md", Buffer.from("edited"), fmt), null, "mv + edit carries nothing");
  assert.equal(renameSource(e, "docs/specs/b.md", null, fmt), null, "unreadable (e.g. symlink) new path carries nothing");

  g(repo, "add", "-A");
  e = await statusEntries(repo);
  assert.equal(renameSource(e, "docs/specs/b.md", null, fmt), "docs/specs/a.md", "staged R100");
});

test("implFingerprint: null for doc-only changes; excluded paths ignored; code changes move it", async () => {
  const repo = makeRepo();
  commitFile(repo, "src/a.ts", "a");
  commitFile(repo, "README.md", "r");
  writeFile(repo, "README.md", "r2");
  writeFile(repo, ".claude/settings.local.json", "{}");
  writeFile(repo, "docs/specs/x.md", "spec");
  assert.equal(await implFingerprint(repo), null);

  writeFile(repo, "src/a.ts", "a2");
  const f1 = await implFingerprint(repo);
  assert.ok(f1);
  assert.deepEqual(f1.paths, ["src/a.ts"]);
  writeFile(repo, "README.md", "r3");
  assert.equal((await implFingerprint(repo))?.fingerprint, f1.fingerprint, "doc edits do not move the impl fingerprint");
  writeFile(repo, "src/a.ts", "a3");
  assert.notEqual((await implFingerprint(repo))?.fingerprint, f1.fingerprint);
});

test("implFingerprint: a staged rename out of an implementation path counts (src → docs); doc → doc does not", async () => {
  const repo = makeRepo();
  commitFile(repo, "src/a.ts", "a");
  commitFile(repo, "docs/old.md", "d");
  g(repo, "mv", "docs/old.md", "docs/new.md");
  assert.equal(await implFingerprint(repo), null, "a doc-only rename is not an implementation change");
  g(repo, "mv", "src/a.ts", "docs/a.md");
  const f = await implFingerprint(repo);
  assert.ok(f, "moving code into a doc path removes implementation code");
  assert.ok(f.paths.includes("src/a.ts"));
});

test("implFingerprint: uppercase doc extensions (README.MD, NOTES.TXT) are excluded like lowercase ones", async () => {
  const repo = makeRepo();
  commitFile(repo, "src/a.ts", "a");
  commitFile(repo, "README.MD", "r");
  commitFile(repo, "NOTES.TXT", "n");
  writeFile(repo, "src/a.ts", "a2");
  const f1 = await implFingerprint(repo);
  assert.deepEqual(f1?.paths, ["src/a.ts"]);
  writeFile(repo, "README.MD", "r2");
  writeFile(repo, "NOTES.TXT", "n2");
  writeFile(repo, "GUIDE.Mdx", "new");
  assert.equal((await implFingerprint(repo))?.fingerprint, f1?.fingerprint, "doc edits in any case do not move the impl fingerprint");
});

test("implFingerprint: an untracked file's executable bit is part of what git would commit", async () => {
  const repo = makeRepo();
  commitFile(repo, "src/a.ts", "a");
  const script = writeFile(repo, "bin/run.sh", "echo hi");
  fs.chmodSync(script, 0o644);
  const before = await implFingerprint(repo);
  fs.chmodSync(script, 0o755);
  assert.notEqual((await implFingerprint(repo))?.fingerprint, before?.fingerprint, "chmod +x moves the fingerprint");
  fs.chmodSync(script, 0o644);
  assert.equal((await implFingerprint(repo))?.fingerprint, before?.fingerprint, "control: restoring the mode restores it");
});

test("implFingerprint: an untracked symlink is fingerprinted by link text, target never read", async () => {
  const repo = makeRepo();
  commitFile(repo, "src/a.ts", "a");
  const outside = path.join(tmpDir(), "secret");
  fs.writeFileSync(outside, "one");
  fs.symlinkSync(outside, path.join(repo, "src/link.ts"));
  const f1 = await implFingerprint(repo);
  fs.writeFileSync(outside, "two");
  const f2 = await implFingerprint(repo);
  assert.equal(f1?.fingerprint, f2?.fingerprint, "changing the link target must not change the fingerprint");
});

test("readArtifact: outside any project, a symlinked ancestor is refused — there is no parent anchor to trust", () => {
  const real = tmpDir("rl-real-");
  fs.writeFileSync(path.join(real, "x-spec.md"), "s");
  const d = tmpDir("rl-linkparent-");
  fs.symlinkSync(real, path.join(d, "link"));
  assert.throws(() => readArtifact(path.join(d, "link", "x-spec.md"), null), { code: "artifact_symlink_rejected" });
  assert.equal(readArtifact(path.join(real, "x-spec.md"), null).toString(), "s", "control: the real path reads");
});

test("streamHash kills the producer at the cap without buffering", async () => {
  const producer = ["-e", "const b=Buffer.alloc(65536,97);function w(){while(process.stdout.write(b)){}process.stdout.once('drain',w)}w()"];
  await assert.rejects(streamHash(process.execPath, producer, { maxBytes: 1024 * 1024, timeoutMs: 10_000 }), { code: "diff_too_large" });
});

test("streamLines enforces the history-scan limit", async () => {
  const producer = ["-e", "for(let i=0;i<1000;i++)console.log(i)"];
  await assert.rejects(
    streamLines(process.execPath, producer, { maxLines: 10, timeoutMs: 10_000, limitCode: "history_scan_limit", onLine: () => false }),
    { code: "history_scan_limit" }
  );
});

test("merge-base validity: a normal fork point is valid", async () => {
  const repo = makeRepo();
  const a = commitFile(repo, "a.txt", "1");
  g(repo, "checkout", "-q", "-b", "feature");
  const head = commitFile(repo, "b.txt", "2");
  g(repo, "checkout", "-q", "main");
  const base = commitFile(repo, "c.txt", "3");
  assert.deepEqual(await mergeBaseValidity(repo, head, base), { ok: true, mergeBase: a });
});

test("merge-base validity: criss-cross history is ambiguous", async () => {
  const { repo, x, y } = crissCrossRepo();
  assert.deepEqual(await mergeBaseValidity(repo, x, y), { ok: false, reason: "ambiguous" });
});

test("merge-base validity: missing commit", async () => {
  const repo = makeRepo();
  const a = commitFile(repo, "a.txt", "1");
  assert.deepEqual(await mergeBaseValidity(repo, a, "0".repeat(40)), { ok: false, reason: "missing_commit" });
});

/** Mark `sha` as a shallow cut-off commit (what a --depth clone records). */
function markShallow(repo, sha) {
  const file = path.resolve(repo, g(repo, "rev-parse", "--git-path", "shallow"));
  fs.appendFileSync(file, sha + "\n");
}

test("history completeness: a cut-off inside the comparison is incomplete", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "1");
  const mid = commitFile(repo, "a.txt", "2");
  g(repo, "checkout", "-q", "-b", "feature");
  const head = commitFile(repo, "b.txt", "x");
  g(repo, "checkout", "-q", "main");
  const base = commitFile(repo, "a.txt", "3");
  markShallow(repo, mid);
  assert.deepEqual(await mergeBaseValidity(repo, head, base), { ok: false, reason: "history_incomplete" });
});

test("history completeness: an unrelated shallow branch does not block a complete comparison", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "1");
  g(repo, "checkout", "-q", "--orphan", "other");
  const unrelated = commitFile(repo, "o.txt", "o");
  g(repo, "checkout", "-q", "main");
  const a = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "-b", "feature");
  const head = commitFile(repo, "b.txt", "x");
  markShallow(repo, unrelated);
  assert.equal(g(repo, "rev-parse", "--is-shallow-repository"), "true");
  assert.deepEqual(await mergeBaseValidity(repo, head, a), { ok: true, mergeBase: a });
});

test("linked worktree: the shallow file is found through --git-path", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "1");
  const mid = commitFile(repo, "a.txt", "2");
  const head = commitFile(repo, "a.txt", "3");
  markShallow(repo, mid);
  const wt = path.join(tmpDir(), "wt");
  g(repo, "worktree", "add", "-q", wt, "HEAD");
  assert.ok(fs.statSync(path.join(wt, ".git")).isFile(), "a linked worktree's .git is a file");
  const set = await readShallowSet(wt, "sha1");
  assert.ok(set.has(mid));
  assert.deepEqual(await mergeBaseValidity(wt, head, mid), { ok: false, reason: "history_incomplete" });
});

test("shallow file: missing, symlink, oversize and malformed all fail closed", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "1");
  await assert.rejects(readShallowSet(repo, "sha1"), { code: "shallow_file_missing" });
  const file = path.join(repo, ".git", "shallow");
  fs.writeFileSync(file, "not-a-sha\n");
  await assert.rejects(readShallowSet(repo, "sha1"), { code: "shallow_file_invalid" });
  fs.writeFileSync(file, "a".repeat(64) + "\n");
  await assert.rejects(readShallowSet(repo, "sha1"), { code: "shallow_file_invalid" }, "wrong length for sha1");
  fs.writeFileSync(file, "a".repeat(1024 * 1024 + 1));
  await assert.rejects(readShallowSet(repo, "sha1"), { code: "shallow_file_too_large" });
  fs.rmSync(file);
  fs.symlinkSync("/etc/hosts", file);
  await assert.rejects(readShallowSet(repo, "sha1"), { code: "shallow_file_symlink" });
});

test("fetchExactRef: fetches exactly one ref and never touches refs/remotes or tags", async () => {
  const upstream = makeRepo();
  commitFile(upstream, "a.txt", "1");
  g(upstream, "tag", "v1");
  g(upstream, "checkout", "-q", "-b", "develop");
  const dev = commitFile(upstream, "d.txt", "d");
  const bare = path.join(tmpDir(), "up.git");
  g(upstream, "clone", "-q", "--bare", upstream, bare);

  const local = path.join(tmpDir(), "local");
  g(tmpDir(), "clone", "-q", "--branch", "main", `file://${bare}`, local);
  const before = g(local, "for-each-ref", "refs/remotes", "refs/tags");
  commitFile(upstream, "d.txt", "d2");
  g(upstream, "push", "-q", bare, "develop");
  const fetched = await fetchExactRef(local, "origin", "develop");
  assert.equal(fetched, g(bare, "rev-parse", "refs/heads/develop"));
  assert.notEqual(fetched, dev);
  assert.equal(g(local, "for-each-ref", "refs/remotes", "refs/tags"), before, "refs/remotes and tags must be byte-identical");
});

test("fetchExactRef: --unshallow completes a shallow clone's history", async () => {
  const upstream = makeRepo();
  for (let i = 0; i < 5; i++) commitFile(upstream, "a.txt", String(i));
  const bare = path.join(tmpDir(), "up.git");
  g(upstream, "clone", "-q", "--bare", upstream, bare);
  const local = path.join(tmpDir(), "local");
  g(tmpDir(), "clone", "-q", "--depth=1", `file://${bare}`, local);
  assert.equal(g(local, "rev-parse", "--is-shallow-repository"), "true");
  await fetchExactRef(local, "origin", "main", { unshallow: true });
  assert.equal(g(local, "rev-parse", "--is-shallow-repository"), "false");
});

test("fetchExactRef rejects option-shaped branch names and sources", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "1");
  await assert.rejects(fetchExactRef(repo, "origin", "--upload-pack=evil"), { code: "invalid_branch_name" });
  await assert.rejects(fetchExactRef(repo, "--upload-pack=evil", "main"), { code: "invalid_remote" });
});

test("parseGithubUrl handles ssh, scp-style and https forms; rejects other hosts", () => {
  assert.deepEqual(parseGithubUrl("git@github.com:Owner/Repo.git"), { owner: "owner", repo: "repo" });
  assert.deepEqual(parseGithubUrl("ssh://git@github.com/o/r"), { owner: "o", repo: "r" });
  assert.deepEqual(parseGithubUrl("https://x-token@github.com/o/r.git"), { owner: "o", repo: "r" });
  assert.equal(parseGithubUrl("https://gitlab.com/o/r.git"), null);
  assert.equal(parseGithubUrl("file:///tmp/r.git"), null);
});

test("repoRoot: a repo → its root; a confirmed non-repo → null; any other git failure → repo_lookup_failed", async (t) => {
  const repo = makeRepo();
  assert.equal(fs.realpathSync(await repoRoot(repo)), fs.realpathSync(repo));
  assert.equal(await repoRoot(tmpDir()), null);
  const bin = tmpDir("rl-git-");
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho 'fatal: detected dubious ownership in repository' >&2\nexit 128\n", { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  t.after(() => (process.env.PATH = saved));
  await assert.rejects(repoRoot(repo), { code: "repo_lookup_failed" });
});

test("committedPaths: commits since the start commit, by range not date; a start commit that is gone fails loud", async () => {
  const repo = makeRepo();
  assert.deepEqual(await committedPaths(repo, null), [], "no commit yet: nothing committed");
  commitFile(repo, "a.md", "a");
  const start = g(repo, "rev-parse", "HEAD");
  assert.deepEqual(await committedPaths(repo, null), ["a.md"], "no commit at start: every commit is this session's");
  assert.deepEqual(await committedPaths(repo, start), []);
  fs.writeFileSync(path.join(repo, "old.md"), "x");
  g(repo, "add", "old.md");
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "backdated"], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" } });
  assert.deepEqual(await committedPaths(repo, start), ["old.md"], "a backdated commit is still in the range");
  await assert.rejects(committedPaths(repo, "0".repeat(40)), (e) => e.code === "detection_failed");
});

/** A bare upstream with one commit, the clone a session works in, a second clone another person commits from, and the session's start commit. */
function bareWithClones() {
  const root = tmpDir();
  const bare = path.join(root, "up.git");
  g(root, "init", "--bare", "-q", bare);
  const seed = makeRepo();
  commitFile(seed, "a.md", "a");
  g(seed, "push", "-q", bare, "HEAD:main");
  const local = path.join(root, "local");
  const other = path.join(root, "other");
  g(root, "clone", "-q", bare, local);
  g(root, "clone", "-q", bare, other);
  return { root, local, other, start: g(local, "rev-parse", "HEAD") };
}

test("committedPaths: a fast-forward pull's commits are not the session's; a pushed session commit is, and so is what a merge commit holds of ours", async () => {
  const { local, other, start } = bareWithClones();

  commitFile(other, "theirs.md", "t");
  g(other, "push", "-q", "origin", "HEAD:main");
  g(local, "pull", "-q", "--ff-only");
  assert.deepEqual(await committedPaths(local, start), [], "brought in by git pull --ff-only: not flagged");

  commitFile(local, "pushed.md", "p");
  g(local, "push", "-q", "origin", "HEAD:main");
  g(local, "fetch", "-q");
  assert.deepEqual(await committedPaths(local, start), ["pushed.md"], "pushed to the remote and fetched back: still the session's");

  g(other, "pull", "-q", "--ff-only");
  commitFile(other, "theirs2.md", "t2");
  g(other, "push", "-q", "origin", "HEAD:main");
  commitFile(local, "mine.md", "m");
  g(local, "pull", "-q", "--no-rebase", "--no-edit");
  // The premise changed on purpose (merges of a fetched tip are incoming, like fast-forwards): theirs2.md came from
  // the fetched side of the merge and is no longer listed; mine.md and pushed.md were committed here and stay.
  assert.deepEqual((await committedPaths(local, start)).sort(), ["mine.md", "pushed.md"], "a pull that makes a merge commit brings the fetched side in; ours stays");
});

/** Waits out the reflog's whole-second clock so a later fetch is strictly after an earlier move. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

/** git with the committer date pinned, which is also the second its reflog rows get: tests choose the order of two rows. */
const gAt = (cwd, when, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: { ...GIT_ENV, GIT_COMMITTER_DATE: `${when} +0000` }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
/** A second well before any move the tests make now, for a fetch that must precede one. */
const EARLIER = 1_700_000_000;
const NOW = () => Math.floor(Date.now() / 1000);

test("committedPaths: merging a fetched tip, with or without a conflict, brings only that side in", async () => {
  const { local, other, start } = bareWithClones();
  commitFile(other, "c.md", "other side\n");
  commitFile(other, "theirs.md", "t");
  g(other, "push", "-q", "origin", "HEAD:main");
  commitFile(local, "c.md", "local side\n");
  commitFile(local, "mine.md", "m");
  gAt(local, EARLIER, "fetch", "-q");
  assert.throws(() => g(local, "merge", "--no-edit", "origin/main"), (e) => /CONFLICT/.test(String(e.stdout)), "the merge must stop on a conflict for this test to mean anything");
  fs.writeFileSync(path.join(local, "c.md"), "resolved\n");
  g(local, "add", "c.md");
  g(local, "commit", "-q", "-m", "Merge origin/main");
  const paths = (await committedPaths(local, start)).sort();
  assert.ok(!paths.includes("theirs.md"), "theirs.md came in through the merge of a fetched tip");
  assert.ok(paths.includes("mine.md") && paths.includes("c.md"), "the commits made here stay listed");
});

test("committedPaths: a merge of a branch that was never fetched, and an octopus, stay the session's", async () => {
  const { root, local, start } = bareWithClones();
  const wt = path.join(root, "wt");
  g(local, "worktree", "add", "-q", "-b", "feat", wt);
  commitFile(wt, "feat.md", "f");
  commitFile(local, "mine.md", "m");
  g(local, "merge", "-q", "--no-edit", "feat");
  assert.deepEqual((await committedPaths(local, start)).sort(), ["feat.md", "mine.md"], "a local branch is not incoming");
  const wt2 = path.join(root, "wt2");
  g(local, "worktree", "add", "-q", "-b", "a", wt2);
  commitFile(wt2, "oa.md", "a");
  const wt3 = path.join(root, "wt3");
  g(local, "worktree", "add", "-q", "-b", "b", wt3);
  commitFile(wt3, "ob.md", "b");
  g(local, "merge", "-q", "--no-edit", "a", "b");
  assert.deepEqual((await committedPaths(local, start)).sort(), ["feat.md", "mine.md", "oa.md", "ob.md"], "an octopus is read as the session's, never partly skipped");
});

test("committedPaths: switching to, or resetting onto, what was fetched is incoming; an unpushed branch is not", async () => {
  const { root, local, other, start } = bareWithClones();
  g(other, "checkout", "-q", "-b", "topic");
  commitFile(other, "topic.md", "t");
  g(other, "push", "-q", "origin", "topic");
  gAt(local, EARLIER, "fetch", "-q");
  g(local, "checkout", "-q", "-b", "x", "origin/topic");
  assert.deepEqual(await committedPaths(local, start), [], "a branch created at a fetched tip brings nothing of ours");

  commitFile(other, "topic2.md", "t2");
  g(other, "push", "-q", "origin", "topic");
  gAt(local, EARLIER, "fetch", "-q");
  g(local, "reset", "-q", "--hard", "origin/topic");
  assert.deepEqual(await committedPaths(local, start), [], "a hard reset onto a fetched tip brings nothing of ours");

  const wt = path.join(root, "wt");
  g(local, "worktree", "add", "-q", "-b", "feat", wt);
  commitFile(wt, "feat.md", "f");
  g(local, "checkout", "-q", "--detach", "feat");
  assert.deepEqual(await committedPaths(local, start), ["feat.md"], "a branch that was never pushed and fetched is the session's");
});

test("committedPaths: rebasing onto a fetched tip brings the base in; the rebased commits stay the session's", async () => {
  const { local, other, start } = bareWithClones();
  commitFile(local, "mine.md", "m");
  commitFile(other, "theirs.md", "t");
  g(other, "push", "-q", "origin", "HEAD:main");
  gAt(local, EARLIER, "fetch", "-q");
  g(local, "rebase", "-q", "origin/main");
  assert.deepEqual(await committedPaths(local, start), ["mine.md"], "theirs.md is the new base; mine.md was committed here, and again by the rebase");
});

test("committedPaths: a branch committed in another worktree and pushed, but never fetched, is the session's", async () => {
  const { root, local, start } = bareWithClones();
  const wt = path.join(root, "wt");
  g(local, "worktree", "add", "-q", "-b", "feat", wt);
  commitFile(wt, "feat.md", "f");
  // A push from a linked worktree moves the shared remote-tracking ref, logged `update by push`, not as a fetch.
  g(wt, "push", "-q", "origin", "feat");
  g(local, "merge", "-q", "--ff-only", "feat");
  assert.deepEqual(await committedPaths(local, start), ["feat.md"]);
});

test("committedPaths: a tip that is really fetched after the move does not make the move incoming", async () => {
  const { root, local, other, start } = bareWithClones();
  const wt = path.join(root, "wt");
  g(local, "worktree", "add", "-q", "-b", "feat", wt);
  commitFile(wt, "feat.md", "f");
  g(local, "merge", "-q", "--ff-only", "feat");
  await nextSecond();
  // The commit reaches the remote through another clone, so this checkout learns of it only by a later fetch.
  g(other, "fetch", "-q", local, "main");
  g(other, "push", "-q", "origin", "FETCH_HEAD:refs/heads/feat3");
  g(local, "fetch", "-q");
  assert.match(g(local, "reflog", "show", "--format=%gs", "refs/remotes/origin/feat3"), /^fetch/, "the tracking ref was moved by a fetch, not a push");
  assert.deepEqual(await committedPaths(local, start), ["feat.md"]);
});

test("committedPaths: the oldest reflog row has no known predecessor and is never read as a move", async () => {
  const { local } = bareWithClones();
  // The clone's first row is a fetched tip holding the whole history. With no start commit every commit is the session's,
  // so reading that row as a move would hand all of it to "incoming".
  assert.deepEqual(await committedPaths(local, null), ["a.md"]);
});

test("committedPaths: a fetch in the same second as a move is not known to be earlier, except for a pull's own", async () => {
  const { root, local, other, start } = bareWithClones();
  const wt = path.join(root, "wt");
  g(local, "worktree", "add", "-q", "-b", "feat", wt);
  commitFile(wt, "feat.md", "f");
  const T = NOW() + 300;
  gAt(local, T, "merge", "-q", "--ff-only", "feat");
  // The tip reaches the remote through another clone and is fetched in the very second of the merge: the order is unknowable.
  g(other, "fetch", "-q", local, "main");
  g(other, "push", "-q", "origin", "FETCH_HEAD:refs/heads/feat3");
  gAt(local, T, "fetch", "-q");
  assert.match(g(local, "reflog", "show", "--format=%gs", "refs/remotes/origin/feat3"), /^fetch/, "the tracking ref was moved by a fetch");
  assert.deepEqual(await committedPaths(local, start), ["feat.md"], "a tie between a move and a fetch keeps the commits listed");

  // A pull in one second: its own fetch and its fast-forward cannot be told apart by time, and it is the order that is certain.
  const fresh = bareWithClones();
  commitFile(fresh.other, "theirs.md", "t");
  g(fresh.other, "push", "-q", "origin", "HEAD:main");
  gAt(fresh.local, NOW() + 300, "pull", "-q", "--ff-only");
  assert.deepEqual(await committedPaths(fresh.local, fresh.start), [], "a pull's commits are incoming though its fetch and move share a second");
});

test("committedPaths: a commit that arrived unfetched is not made incoming by a later move onto a fetched tip that contains it", async () => {
  const { root, local, other, start } = bareWithClones();
  const wt = path.join(root, "wt");
  g(local, "worktree", "add", "-q", "-b", "feat", wt);
  commitFile(wt, "feat.md", "f");
  g(local, "merge", "-q", "--ff-only", "feat");
  await nextSecond();
  g(local, "push", "-q", "origin", "HEAD:main");
  g(other, "pull", "-q", "--ff-only");
  commitFile(other, "theirs.md", "t");
  g(other, "push", "-q", "origin", "HEAD:main");
  // Strictly between the two moves: after the merge that brought feat.md in, before the checkout that brings theirs.md.
  gAt(local, NOW() + 60, "fetch", "-q");
  gAt(local, NOW() + 120, "checkout", "-q", "--detach", "origin/main");
  assert.deepEqual(await committedPaths(local, start), ["feat.md"], "feat.md arrived before any fetch of it; theirs.md arrived with the fetched tip");
});

test("committedPaths: a local branch fast-forwarded in is the session's work, pushed or not", async () => {
  const { root, local, start } = bareWithClones();

  // Made in a linked worktree (no entry in this HEAD's reflog) and never pushed.
  const wt = path.join(root, "wt");
  g(local, "worktree", "add", "-q", "-b", "feat", wt);
  commitFile(wt, "feat.md", "f");
  g(local, "merge", "-q", "--ff-only", "feat");
  assert.deepEqual(await committedPaths(local, start), ["feat.md"], "a local branch is not an incoming commit");

  // Pushing a later branch that contains it puts it under a remote-tracking ref, but a push is not a fetch.
  g(local, "checkout", "-q", "-b", "feat2");
  commitFile(local, "feat2.md", "f2");
  g(local, "push", "-q", "origin", "feat2");
  g(local, "checkout", "-q", "main");
  g(local, "merge", "-q", "--ff-only", "feat2");
  assert.deepEqual((await committedPaths(local, start)).sort(), ["feat.md", "feat2.md"], "pushing it, or a branch holding it, does not make it incoming");
});

test("committedPaths: fetching a local fast-forward's tip afterwards does not make it incoming", async () => {
  const { root, local, start } = bareWithClones();
  const wt = path.join(root, "wt");
  g(local, "worktree", "add", "-q", "-b", "feat", wt);
  commitFile(wt, "feat.md", "f");
  g(local, "merge", "-q", "--ff-only", "feat");
  // Reflog times are whole seconds. Pushed by URL, no tracking ref moves; the fetch then records the tip as fetched.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  g(local, "push", "-q", path.join(root, "up.git"), "feat:refs/heads/feat3");
  g(local, "fetch", "-q");
  assert.deepEqual(await committedPaths(local, start), ["feat.md"]);
});

test("committedPaths: a commit this checkout made stays the session's when a fast-forward pull brings it back with someone else's", async () => {
  const { local, other, start } = bareWithClones();
  g(local, "checkout", "-q", "-b", "side");
  commitFile(local, "mine.md", "m");
  g(local, "push", "-q", "origin", "side:main");
  g(local, "checkout", "-q", "main");
  g(other, "pull", "-q", "--ff-only");
  commitFile(other, "theirs.md", "t");
  g(other, "push", "-q", "origin", "HEAD:main");
  g(local, "pull", "-q", "--ff-only");
  assert.deepEqual(await committedPaths(local, start), ["mine.md"], "theirs.md arrived by the pull; mine.md was committed here");
});

test("committedPaths: a commit made under another committer identity and date is still the session's", async () => {
  const repo = makeRepo();
  commitFile(repo, "a.md", "a");
  const start = g(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "forged.md"), "x");
  g(repo, "add", "forged.md");
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "forged"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com", GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" }
  });
  assert.deepEqual(await committedPaths(repo, start), ["forged.md"]);
});
