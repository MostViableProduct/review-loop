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
import { g, makeRepo, commitFile, writeFile, crissCrossRepo, tmpDir } from "./helpers.mjs";
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
