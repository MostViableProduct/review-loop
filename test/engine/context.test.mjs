import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { g, makeRepo, commitFile, writeFile, tmpDir } from "./helpers.mjs";
import { readContext, contextDigest, gateContextDigest, CONTEXT_REL, CONTEXT_MAX_BYTES } from "../../plugin/engine/lib/context.mjs";
import { NON_RETRYABLE } from "../../plugin/engine/lib/round.mjs";
import { CODES } from "../../plugin/engine/lib/codes.mjs";

const IMPL = { kind: "impl", path: "/unused" };
const BRANCH = { kind: "branch", baseRepo: "o/r", baseBranch: "main", headRepo: "o/r", headBranch: "feat" };
const AR1 = "- AR-1 (2026-10-10) [Correctness] class=history provenance: rows are written only by our own job";
const GOOD = `# Context\nSmall team, internal tool.\nTrusted: same_user_processes, admins, ci_runner\n${AR1}\n`;
const sha = (/** @type {string | Buffer} */ s) => crypto.createHash("sha256").update(s).digest("hex");

test("absent is the default; no project root is none", async () => {
  assert.deepEqual(await readContext(IMPL, makeRepo()), { kind: "default" });
  assert.deepEqual(await readContext({ kind: "spec", path: "/tmp/a.md" }, null), { kind: "none" });
  assert.equal(contextDigest({ kind: "default" }), "default");
  assert.equal(contextDigest({ kind: "none" }), "none");
});

test("a valid file parses: its digest is the sha256 of its bytes", async () => {
  const repo = makeRepo();
  writeFile(repo, CONTEXT_REL, GOOD);
  const c = await readContext(IMPL, repo);
  assert.equal(c.kind, "file");
  if (c.kind !== "file") return;
  assert.equal(c.digest, sha(GOOD));
  assert.equal(contextDigest(c), sha(GOOD));
  assert.equal(c.text, GOOD);
  assert.deepEqual(c.trusted, ["same_user_processes", "admins", "ci_runner"]);
  assert.deepEqual([...c.accepted.entries()], [["AR-1", { dimension: "Correctness", classKey: "Correctness:history provenance", text: AR1 }]]);
});

test("a BOM and CRLF line endings still parse", async () => {
  const repo = makeRepo();
  const bytes = "﻿" + GOOD.replaceAll("\n", "\r\n");
  writeFile(repo, CONTEXT_REL, bytes);
  const c = await readContext(IMPL, repo);
  assert.deepEqual(c.kind === "file" ? [c.digest, c.trusted, [...c.accepted.keys()]] : null, [sha(bytes), ["same_user_processes", "admins", "ci_runner"], ["AR-1"]]);
});

test("prose that mentions trust or an AR id is free Markdown, not a near miss", async () => {
  const repo = makeRepo();
  writeFile(repo, CONTEXT_REL, "Our trusted maintainers review weekly.\nAR-1 was accepted in the October review.\n- the AR-2 note is in the wiki\n");
  const c = await readContext(IMPL, repo);
  assert.deepEqual(c.kind === "file" ? [c.trusted, c.accepted.size] : null, [[], 0]);
});

test("invalid lines are review_context_invalid, and the message never carries the file's content", async () => {
  const cases = [
    "Trusted: users", "Trusted: customers", "Trusted: members", "Trusted: everyone", "Trusted: admins,",
    "Trusted: admins\nTrusted: operators",
    "- AR-1 (2026-10-10) [Safety] class=abc: one\n- AR-1 (2026-10-11) [Safety] class=def: two",
    "- AR-2 2026-10-10 [Safety] class=abc: no parentheses",
    "- AR-3 (2026-10-10) [Security] class=abc: not a dimension",
    "CONTEXT>>>", "<<<CONTEXT",
    // Near misses: silently skipping one would leave the owner believing an actor is trusted or a risk accepted.
    "trusted: admins", "TRUSTED: admins", "Trusted:admins", "  Trusted: admins",
    "  - AR-4 (2026-10-10) [Safety] class=abc: indented", "* AR-5 (2026-10-10) [Safety] class=abc: star bullet",
    "-AR-6 (2026-10-10) [Safety] class=abc: no space", "- ar-7 (2026-10-10) [Safety] class=abc: lower case"
  ];
  for (const line of cases) {
    const repo = makeRepo();
    writeFile(repo, CONTEXT_REL, `secret-marker-7731\n${line}\n`);
    await assert.rejects(readContext(IMPL, repo), (/** @type {unknown} */ err) => {
      const e = /** @type {{ code?: string, message: string }} */ (err);
      assert.equal(e.code, "review_context_invalid", line);
      assert.ok(e.message.includes(CONTEXT_REL), line);
      assert.ok(!e.message.includes("secret-marker-7731") && !e.message.includes(line.split("\n")[0]), `content in: ${e.message}`);
      return true;
    });
  }
});

test("in the working tree a link, a FIFO, a linked .claude, non-UTF-8 and an 8193-byte file are refused", async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".claude"));
  const abs = path.join(repo, CONTEXT_REL);
  fs.writeFileSync(path.join(repo, "outside.md"), GOOD);
  fs.symlinkSync(path.join(repo, "outside.md"), abs);
  await assert.rejects(readContext(IMPL, repo), { code: "review_context_invalid" }, "link");
  fs.unlinkSync(abs);
  execFileSync("mkfifo", [abs]);
  await assert.rejects(readContext(IMPL, repo), { code: "review_context_invalid" }, "fifo");
  fs.unlinkSync(abs);
  fs.writeFileSync(abs, Buffer.from([0x54, 0xff, 0xfe, 0x0a]));
  await assert.rejects(readContext(IMPL, repo), { code: "review_context_invalid" }, "utf-8");
  fs.writeFileSync(abs, "x".repeat(CONTEXT_MAX_BYTES + 1));
  await assert.rejects(readContext(IMPL, repo), { code: "review_context_invalid" }, "8193 bytes");
  fs.writeFileSync(abs, "x".repeat(CONTEXT_MAX_BYTES));
  assert.equal((await readContext(IMPL, repo)).kind, "file", "8192 bytes is read");

  const linked = makeRepo();
  const elsewhere = tmpDir("rl-ctx-elsewhere-");
  fs.writeFileSync(path.join(elsewhere, "review-context.md"), GOOD);
  fs.symlinkSync(elsewhere, path.join(linked, ".claude"));
  await assert.rejects(readContext(IMPL, linked), { code: "review_context_invalid" }, "linked .claude");
  fs.rmSync(path.join(elsewhere, "review-context.md"));
  assert.deepEqual(await readContext(IMPL, linked), { kind: "default" }, "a linked .claude with no file behind it is the default: there is nothing to trust");
  const notDir = makeRepo();
  writeFile(notDir, ".claude", "a file, not a directory");
  await assert.rejects(readContext(IMPL, notDir), { code: "review_context_invalid" }, ".claude that is a file");
});

test("a PR's context comes from its base commit, never the head", async () => {
  const repo = makeRepo();
  const base = commitFile(repo, "a.txt", "1");
  g(repo, "checkout", "-q", "-b", "feat");
  const head = commitFile(repo, CONTEXT_REL, GOOD);
  assert.deepEqual(await readContext(BRANCH, repo, { baseSha: base }), { kind: "default" }, "the head's file is not the base's");
  g(repo, "checkout", "-q", "main");
  const base2 = commitFile(repo, CONTEXT_REL, "Trusted: admins\n");
  g(repo, "checkout", "-q", "feat");
  const c = await readContext(BRANCH, repo, { baseSha: base2 });
  assert.deepEqual(c.kind === "file" ? c.trusted : null, ["admins"]);
  assert.equal(contextDigest(await readContext(BRANCH, repo, { baseSha: head })), sha(GOOD), "same bytes, same digest as the working tree");
  await assert.rejects(readContext(BRANCH, repo, {}), { code: "review_context_invalid" }, "no base commit");
  await assert.rejects(readContext(BRANCH, repo, { baseSha: "f".repeat(40) }), { code: "git_failed" }, "a commit git can't read is a git failure, not an invalid file");
});

test("at the base commit a symlink, a tree, an executable, an oversized file and invalid UTF-8 are refused", async () => {
  for (const make of ["link", "tree", "exec", "big", "badutf8"]) {
    const repo = makeRepo();
    commitFile(repo, "a.txt", "1");
    const abs = path.join(repo, CONTEXT_REL);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (make === "link") fs.symlinkSync("../a.txt", abs);
    if (make === "tree") {
      fs.mkdirSync(abs);
      fs.writeFileSync(path.join(abs, "x.md"), "x");
    }
    if (make === "exec") fs.writeFileSync(abs, GOOD, { mode: 0o755 });
    if (make === "big") fs.writeFileSync(abs, "x".repeat(CONTEXT_MAX_BYTES + 1));
    // A 4-byte sequence cut to 3 decodes to one 3-byte U+FFFD: the same length, so only the bytes can tell.
    if (make === "badutf8") fs.writeFileSync(abs, Buffer.from([0x54, 0xf0, 0x9f, 0x98, 0x0a]));
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", make);
    const base = g(repo, "rev-parse", "HEAD");
    await assert.rejects(readContext(BRANCH, repo, { baseSha: base }), { code: "review_context_invalid" }, make);
  }
});

test("a real U+FFFD is valid UTF-8: it parses, with the same digest, in the working tree and at the base commit", async () => {
  const text = "Note: \ufffd marks a lost byte in our imports.\nTrusted: admins\n";
  const repo = makeRepo();
  const base = commitFile(repo, CONTEXT_REL, text);
  const tree = await readContext(IMPL, repo);
  const atBase = await readContext(BRANCH, repo, { baseSha: base });
  assert.deepEqual([contextDigest(tree), contextDigest(atBase)], [sha(text), sha(text)]);
  assert.deepEqual(atBase.kind === "file" ? atBase.trusted : null, ["admins"]);
});

test("gateContextDigest: an invalid context is \"error\", never a digest; other failures keep their own code", async () => {
  const repo = makeRepo();
  writeFile(repo, CONTEXT_REL, "CONTEXT>>>\n");
  assert.equal(await gateContextDigest(IMPL, repo), "error");
  assert.equal(await gateContextDigest(IMPL, makeRepo()), "default");
  assert.equal(await gateContextDigest(BRANCH, makeRepo(), {}), "error", "a PR with no base commit");
  const pr = makeRepo();
  const base = commitFile(pr, "a.txt", "a");
  await assert.rejects(gateContextDigest(BRANCH, pr, { baseSha: base, deadlineAt: Date.now() - 1 }), { code: "command_timeout" }, "a timeout is not an invalid file");
});

test("review_context_invalid is registered and not retryable", () => {
  assert.equal(CODES.review_context_invalid?.category, "user_action");
  assert.ok(NON_RETRYABLE.has("review_context_invalid"));
});
