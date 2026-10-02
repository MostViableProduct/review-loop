import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { g, tmpDir } from "../engine/helpers.mjs";
import { checkPath, coordsFor, ownerFrom, parsePrivateList, readBounded, readNoFollow, readTracked, ruleSet, scanText, GENERIC_RULES, MAX_FILE_BYTES, PRIVATE_ENV, PRIVATE_LIST_FILE } from "../../scripts/content-gate.mjs";

const GATE = path.resolve("scripts/content-gate.mjs");
// A synthetic private denylist: the author's real one is never in this repo (docs/RELEASE.md).
const ZZ_LIST = JSON.stringify([{ name: "zz_handle", pattern: "zzprivatehandle" }, { name: "zz_org", pattern: "zzprivateorg" }, { name: "zz_project", pattern: "zz-private-project" }]);
/**
 * The gate's environment with the denylist variable set to `list`, or removed when `list` is null (so only a local
 * list file, if any, applies).
 * @param {string | null} list @returns {NodeJS.ProcessEnv}
 */
function envWith(list) {
  const env = { ...process.env };
  delete env[PRIVATE_ENV];
  if (list !== null) env[PRIVATE_ENV] = list;
  return env;
}
const ZZ_ENV = envWith(ZZ_LIST);
const run = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [GATE, ...a], { encoding: "utf8", timeout: 30_000, env: ZZ_ENV });
const ZZ_RULES = (() => {
  const p = parsePrivateList(ZZ_LIST);
  if (!p.ok) throw new Error(p.reason);
  return p.rules;
})();
/** The rules a scan runs with the synthetic list: generic first, then private, as the gate orders them. */
const WITH_ZZ = ruleSet([...GENERIC_RULES, ...ZZ_RULES]);

/** A minimal package tree that satisfies the allowlist. */
function pkg() {
  const d = tmpDir();
  for (const f of ["LICENSE", "README.md", "package.json", ".claude-plugin/marketplace.json", "plugin/x.mjs", "cli/y.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), f === "package.json" ? "{}" : f === "LICENSE" ? "MIT License\n\nCopyright (c) 2026 Some Holder\n" : "clean\n");
  }
  return d;
}

test("T-REL-1 (+): the real repo's packaged set passes", () => {
  // The caller's own environment: the real private list when the author runs it, generic rules only in CI.
  const r = spawnSync(process.execPath, [GATE], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^content-gate: ok \(\d+ files\)$/m);
});

test("T-REL-1 (+): a clean extracted package passes", () => {
  const r = run("--dir", pkg());
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

for (const [rule, text] of [["users_path", "see /Users/x/notes"], ["zz_handle", "by ZZPRIVATEHANDLE"], ["zz_org", "at ZzPrivateOrg HQ"], ["zz_org", "zzprivateorg.ai"], ["zz_project", "zz-private-project a11y"], ["personal_rules", "~/.claude/rules/x.md"], ["email", "mail real.person@gmail.com"], ["email", "a@example.com.attacker.org"]]) {
  test(`T-REL-1 (−): ${rule} fails, naming file and rule but not the content (${text})`, () => {
    const d = pkg();
    fs.writeFileSync(path.join(d, "cli/y.mjs"), `ok\n${text}\n`);
    const r = run("--dir", d);
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`FAIL cli/y\\.mjs:2 rule=${rule}`));
    assert.ok(!r.stdout.includes(text) && !r.stderr.includes(text), "matched text is never printed");
  });
}

test("T-REL-1 (−): a denylisted string inside a binary (NUL-bearing) file still fails", () => {
  const d = pkg();
  fs.writeFileSync(path.join(d, "plugin/x.mjs"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("/Users/x")]));
  assert.match(run("--dir", d).stdout, /FAIL plugin\/x\.mjs:1 rule=users_path/);
});

test("T-REL-1: @example.com fixtures and the LICENSE holder line are allowed", () => {
  const d = pkg();
  fs.writeFileSync(path.join(d, "cli/y.mjs"), "t@example.com\nmail t@example.com.\n");
  fs.writeFileSync(path.join(d, "LICENSE"), "MIT License\n\nCopyright (c) 2026 zzprivateorg-holder\n");
  const r = run("--dir", d);
  assert.equal(r.status, 0, r.stdout);
});

test("T-REL-1 (−): the LICENSE exemption covers only a bare holder line, not an email or path on it, nor other files", () => {
  assert.deepEqual(scanText("LICENSE", "Copyright (c) 2026 zzprivateorg-holder\n", [], true, WITH_ZZ), []);
  assert.deepEqual(scanText("LICENSE", "Copyright (c) 2026 Holder <holder@gmail.com>\n", [], true, WITH_ZZ), ["FAIL LICENSE:1 rule=email"]);
  assert.deepEqual(scanText("README.md", "Copyright (c) 2026 zzprivateorg-holder\n", [], false, WITH_ZZ), ["FAIL README.md:1 rule=zz_org"]);
});

test("T-REL-1: the repo-coordinate exemption strips only the exact coordinates", () => {
  const coords = coordsFor("zzprivateorg-crew");
  const scan = (/** @type {string} */ text, /** @type {readonly string[]} */ c = coords) => scanText("README.md", text, c, false, WITH_ZZ);
  assert.deepEqual(scan("brew install zzprivateorg-crew/tap/review-loop\n"), []);
  assert.deepEqual(scan("https://github.com/zzprivateorg-crew/review-loop and zzprivateorg-crew/homebrew-tap\n"), []);
  assert.deepEqual(scan("zzprivateorg-crew/tap by zzprivateorg\n"), ["FAIL README.md:1 rule=zz_org"]);
  assert.deepEqual(scan("zzprivate<owner>/taporg\n", coordsFor("<owner>")), [], "a strip never joins its neighbors into a match");
  assert.deepEqual(scan("zzprivateorg-crew/other\n"), ["FAIL README.md:1 rule=zz_org"]);
});

test("the owner comes from package.json repository.url, else the literal <owner>", () => {
  assert.equal(ownerFrom(JSON.stringify({ repository: { type: "git", url: "git+https://github.com/zzprivateorg-crew/review-loop.git" } })), "zzprivateorg-crew");
  assert.equal(ownerFrom("{}"), "<owner>");
  assert.equal(ownerFrom("not json"), "<owner>");
  assert.equal(ownerFrom(JSON.stringify({ repository: { url: "https://github.com//review-loop" } })), "<owner>", "an empty owner never exempts a bare /tap");
  assert.equal(ownerFrom(JSON.stringify({ repository: { url: "https://github.com/x/other-repo" } })), "<owner>");
});

test("T-REL-2 (−): a symlink is a finding and its target is never read; an oversized file is refused unread", () => {
  const d = pkg();
  const outside = path.join(tmpDir(), "host-secret.txt");
  fs.writeFileSync(outside, "/Users/someone/.ssh/id_rsa\n");
  fs.symlinkSync(outside, path.join(d, "cli/linked.mjs"));
  const r = run("--dir", d);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL cli\/linked\.mjs rule=symlink/);
  assert.doesNotMatch(r.stdout, /users_path/, "the link target's content was not scanned");
  const e = pkg();
  fs.writeFileSync(path.join(e, "cli/huge.mjs"), "/Users/x\n" + "x".repeat(MAX_FILE_BYTES));
  const big = run("--dir", e).stdout;
  assert.match(big, /FAIL cli\/huge\.mjs rule=too_large/);
  assert.doesNotMatch(big, /huge\.mjs:1 rule=users_path/, "an oversized file is not read");
  const g = pkg();
  fs.symlinkSync(path.join(g, "plugin"), path.join(g, "cli/loop"));
  assert.match(run("--dir", g).stdout, /FAIL cli\/loop rule=symlink/, "a directory link is not descended into");
});

test("T-REL-2 (−): a non-regular file (FIFO) is a finding and never opened", () => {
  const d = pkg();
  const mk = spawnSync("mkfifo", [path.join(d, "cli/pipe.mjs")]);
  assert.equal(mk.status, 0, "mkfifo is available on macOS");
  const r = run("--dir", d);
  assert.equal(r.status, 1, "the gate finished instead of blocking on the FIFO");
  assert.match(r.stdout, /FAIL cli\/pipe\.mjs rule=not_regular/);
});

test("T-REL-2 (−): the read itself refuses a link swapped in after the lstat (O_NOFOLLOW), and bounds what it reads", () => {
  const d = tmpDir();
  const secret = path.join(d, "secret");
  fs.writeFileSync(secret, "/Users/someone\n");
  fs.symlinkSync(secret, path.join(d, "link"));
  assert.deepEqual(readNoFollow(path.join(d, "link")), { ok: false, rule: "symlink" });
  fs.writeFileSync(path.join(d, "big"), "x".repeat(MAX_FILE_BYTES + 1));
  const big = readNoFollow(path.join(d, "big"));
  assert.equal(big.ok ? "read" : big.rule, "too_large");
  const ok = readNoFollow(secret);
  assert.ok(ok.ok && ok.buf.toString() === "/Users/someone\n");
});

test("T-REL-2 (−): lstat comes first: a link, a non-regular file or an oversized file is refused without being opened", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "ok"), "fine\n");
  fs.symlinkSync(path.join(d, "ok"), path.join(d, "link"));
  fs.writeFileSync(path.join(d, "big"), "x".repeat(MAX_FILE_BYTES + 1));
  assert.equal(spawnSync("mkfifo", [path.join(d, "fifo")]).status, 0);
  /** @type {string[]} */
  const opened = [];
  const spy = (/** @type {string} */ abs, /** @type {string} */ parent) => { opened.push(path.basename(abs)); return readNoFollow(abs, parent); };
  assert.deepEqual(readBounded(d, "link", spy), { ok: false, rule: "symlink" });
  assert.deepEqual(readBounded(d, "fifo", spy), { ok: false, rule: "not_regular" });
  assert.deepEqual(readBounded(d, "big", spy), { ok: false, rule: "too_large" });
  assert.deepEqual(readBounded(d, "gone", spy), { ok: false, rule: "unreadable" });
  assert.deepEqual(opened, [], "no refused file reached the reader");
  assert.ok(readBounded(d, "ok", spy).ok);
  assert.deepEqual(opened, ["ok"]);
});

test("T-REL-2 (−): an unlisted file fails; a missing allowlisted file fails", () => {
  const d = pkg();
  fs.writeFileSync(path.join(d, "extra.txt"), "x");
  assert.match(run("--dir", d).stdout, /FAIL extra\.txt rule=unlisted/);
  const e = pkg();
  fs.rmSync(path.join(e, "LICENSE"));
  assert.match(run("--dir", e).stdout, /FAIL LICENSE rule=missing/);
});

test("--dir without a directory is a usage error, not a pass", () => {
  assert.equal(run("--dir").status, 2);
  assert.equal(run("--dir", path.join(tmpDir(), "nope")).status, 2);
});

test("--list prints only allowlisted, tracked files", () => {
  const files = run("--list").stdout.trim().split("\n");
  assert.ok(files.includes("cli/review-loop.mjs"));
  assert.ok(files.includes("README.md") && files.includes("LICENSE"));
  assert.ok(files.every((f) => !f.startsWith("test/") && !f.startsWith("scripts/") && !f.startsWith("docs/")));
});

test("--list through a shell pipe is complete (the release workflow reads it with $(…))", () => {
  const allow = /** @type {string[]} */ (JSON.parse(fs.readFileSync("package.files.json", "utf8")).files);
  const want = g(process.cwd(), "ls-files").split("\n").filter((f) => allow.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a))).sort();
  assert.ok(want.length > 20, "a list long enough to span several pipe writes");
  const quote = (/** @type {string} */ s) => `'${s.replace(/'/g, "'\\''")}'`;
  // A truncated pipe read is timing-dependent, so the read is repeated.
  for (let i = 0; i < 5; i++) {
    const got = execFileSync("/bin/sh", ["-c", `${quote(process.execPath)} ${quote(GATE)} --list | cat`], { encoding: "utf8" });
    assert.deepEqual(got.split("\n").filter(Boolean), want, `read ${i + 1}: every packaged file is listed`);
  }
});

test("the tap staging copy (homebrew-tap/) is tracked but never packaged", () => {
  assert.ok(g(process.cwd(), "ls-files", "homebrew-tap/Formula/review-loop.rb").trim() !== "", "the formula is tracked, so the exclusion below is not vacuous");
  const r = run("--list");
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.split("\n").filter(Boolean);
  assert.ok(files.length > 0);
  assert.ok(files.every((f) => !f.startsWith("homebrew-tap/")), "no tap file is in the packaged set");
});

/**
 * A git checkout holding a copy of the gate, so the default (`git ls-files`) mode runs against a tree the test controls.
 * `run` passes the synthetic private list; `runEnv` takes the environment (see `envWith`).
 * @param {string} [pkgJson]
 * @returns {{ root: string, run: (...a: string[]) => ReturnType<typeof spawnSync>, runEnv: (env: NodeJS.ProcessEnv, ...a: string[]) => ReturnType<typeof spawnSync> }}
 */
function checkout(pkgJson = "{}") {
  const root = tmpDir("rl-gate-co-");
  const files = { "scripts/content-gate.mjs": fs.readFileSync(GATE, "utf8"), "package.files.json": fs.readFileSync("package.files.json", "utf8"), "package.json": pkgJson,
    LICENSE: "MIT License\n", "README.md": "clean\n", ".claude-plugin/marketplace.json": "{}\n", "plugin/x.mjs": "clean\n", "cli/sub/a.mjs": "clean\n" };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  g(root, "init", "-q");
  g(root, "add", ".");
  g(root, "commit", "-qm", "i");
  const runEnv = (/** @type {NodeJS.ProcessEnv} */ env, /** @type {string[]} */ ...a) => spawnSync(process.execPath, [path.join(root, "scripts/content-gate.mjs"), ...a], { encoding: "utf8", timeout: 30_000, env });
  return { root, run: (...a) => runEnv(ZZ_ENV, ...a), runEnv };
}

/** A directory outside the package whose file would fail the gate if it were ever read. */
function outsideDir() {
  const o = tmpDir("rl-outside-");
  fs.writeFileSync(path.join(o, "a.mjs"), "/Users/someone/.ssh/id_rsa\n");
  return o;
}

test("I1 (−): a file or directory NAME is checked too, and the matching component is never printed", () => {
  const d = pkg();
  fs.writeFileSync(path.join(d, "plugin/zzprivatehandle-zzprivateorg-notes.md"), "clean\n");
  fs.mkdirSync(path.join(d, "cli/ZzPrivateOrgTeam"));
  fs.writeFileSync(path.join(d, "cli/ZzPrivateOrgTeam/x.mjs"), "/Users/x\n");
  fs.mkdirSync(path.join(d, "plugin/Users"));
  fs.writeFileSync(path.join(d, "plugin/Users/a.mjs"), "clean\n");
  fs.writeFileSync(path.join(d, "extra-zzprivatehandle.txt"), "clean\n");
  const r = run("--dir", d);
  assert.equal(r.status, 1, r.stdout);
  for (const line of ["FAIL plugin/<redacted> rule=zz_handle (path)", "FAIL plugin/<redacted> rule=zz_org (path)",
    "FAIL cli/<redacted>/x.mjs rule=zz_org (path)", "FAIL cli/<redacted>/x.mjs:1 rule=users_path",
    "FAIL plugin/<redacted>/a.mjs rule=users_path (path)", "FAIL <redacted> rule=zz_handle (path)", "FAIL <redacted> rule=unlisted"]) {
    assert.ok(r.stdout.split("\n").includes(line), `missing: ${line}\n${r.stdout}`);
  }
  for (const text of ["zzprivatehandle", "notes.md", "ZzPrivateOrgTeam", "/Users"]) assert.ok(!r.stdout.includes(text) && !r.stderr.includes(text), `printed ${text}`);
});

test("I1: a path keeps the coordinate exemption; a clean path prints as-is", () => {
  assert.deepEqual(checkPath("plugin/zzprivateorg-crew/tap/x.mjs", coordsFor("zzprivateorg-crew"), WITH_ZZ), { shown: "plugin/zzprivateorg-crew/tap/x.mjs", findings: [] });
  assert.deepEqual(checkPath("plugin/zzprivateorg-crew/x.mjs", coordsFor("zzprivateorg-crew"), WITH_ZZ), { shown: "plugin/<redacted>/x.mjs", findings: ["FAIL plugin/<redacted>/x.mjs rule=zz_org (path)"] });
  assert.deepEqual(checkPath("cli/y.mjs", coordsFor("<owner>")), { shown: "cli/y.mjs", findings: [] });
});

test("I2 (−): git ls-files mode: a symlinked PARENT directory is a finding and the outside file is never read", () => {
  const co = checkout();
  assert.equal(co.run().status, 0, "the clean checkout passes");
  fs.rmSync(path.join(co.root, "cli/sub"), { recursive: true });
  fs.symlinkSync(outsideDir(), path.join(co.root, "cli/sub"));
  const r = co.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL cli\/sub\/a\.mjs rule=symlink$/m);
  assert.doesNotMatch(r.stdout, /users_path/, "the outside file was not scanned");
});

test("I2 (−): --dir mode: a symlinked parent is a finding and never descended into", () => {
  const d = pkg();
  fs.symlinkSync(outsideDir(), path.join(d, "cli/sub"));
  const r = run("--dir", d);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL cli\/sub rule=symlink$/m);
  assert.doesNotMatch(r.stdout, /users_path/);
});

test("I2 (−): the ancestor walk refuses a linked parent before the reader, and the reader re-checks the parent after its open", () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, "cli"));
  fs.symlinkSync(outsideDir(), path.join(d, "cli/sub"));
  /** @type {string[]} */
  const opened = [];
  const spy = (/** @type {string} */ abs, /** @type {string} */ parent) => { opened.push(abs); return readNoFollow(abs, parent); };
  assert.deepEqual(readBounded(d, "cli/sub/a.mjs", spy), { ok: false, rule: "symlink" });
  assert.deepEqual(opened, [], "the outside file never reached the reader");
  // The race the walk can't close: a parent swapped for a link after the walk. The reader's own check catches it.
  assert.deepEqual(readNoFollow(path.join(d, "cli/sub/a.mjs"), path.join(d, "cli/sub")), { ok: false, rule: "symlink" });
});

test("minor 3: an unknown or misspelled argument is a usage error, never a silent repo check", () => {
  for (const a of [["--dri", "/x"], ["--lst"], ["extra"], ["--dir", "a", "--dir", "b"], ["--list", "--list"], ["--tracked", "--tracked"],
    ["--require-private", "--require-private"], ["--tracked", "--dir", "a"], ["--list", "--tracked"], ["--list", "--require-private"], ["--require-privat"]]) {
    const r = run(...a);
    assert.equal(r.status, 2, a.join(" "));
    assert.match(r.stderr, /usage: content-gate\.mjs/);
    assert.equal(r.stdout, "");
  }
});

test("minor 4: an unreadable directory in --dir is a finding (exit 1), not a crash", () => {
  const d = pkg();
  const locked = path.join(d, "plugin/locked");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "z.mjs"), "/Users/x\n");
  fs.chmodSync(locked, 0o000);
  try {
    const r = run("--dir", d);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^FAIL plugin\/locked rule=unreadable$/m);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("minor 4: a failing `git ls-files` exits 2 with one line and no stack", () => {
  const co = checkout();
  fs.rmSync(path.join(co.root, ".git"), { recursive: true });
  const r = co.run();
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  assert.match(r.stderr, /git ls-files. failed/);
});

test("minor 5: a coordinate never hides an overlapping match (`<owner>/tap@gmail.com`)", () => {
  assert.deepEqual(scanText("README.md", "contact <owner>/tap@gmail.com\n", coordsFor("<owner>")), ["FAIL README.md:1 rule=email"]);
  const d = pkg();
  fs.writeFileSync(path.join(d, "cli/y.mjs"), "contact <owner>/tap@gmail.com\n");
  const r = run("--dir", d);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL cli\/y\.mjs:1 rule=email/);
});

test("item 6: an https repository.url (Task 28's form) yields the owner, and the coordinate exemption passes end to end", () => {
  assert.equal(ownerFrom(JSON.stringify({ repository: { type: "git", url: "https://github.com/acme/review-loop.git" } })), "acme");
  assert.deepEqual(scanText("README.md", "brew install acme/tap/review-loop\n", coordsFor("acme")), []);
  const co = checkout(JSON.stringify({ repository: { type: "git", url: "https://github.com/zzprivateorg-crew/review-loop.git" } }));
  fs.writeFileSync(path.join(co.root, "README.md"), "brew install zzprivateorg-crew/tap/review-loop\nhttps://github.com/zzprivateorg-crew/review-loop\n");
  const ok = co.run();
  assert.equal(ok.status, 0, ok.stdout);
  fs.writeFileSync(path.join(co.root, "README.md"), "brew install zzprivateorg-crew/tap/review-loop from zzprivateorg\n");
  assert.match(co.run().stdout, /FAIL README\.md:1 rule=zz_org/);
});

test("fix 2: a listable but unsearchable parent (EACCES on lstat) is rule=unreadable on the redacted path, with no error text", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root ignores directory modes, so EACCES can't be provoked");
  const d = pkg();
  const dir = path.join(d, "plugin/zzprivatehandle-dir");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.mjs"), "c\n");
  fs.chmodSync(dir, 0o644);
  try {
    const r = run("--dir", d);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL plugin\/<redacted>\/a\.mjs rule=unreadable$/m);
    for (const text of ["zzprivatehandle", "EACCES", "Error"]) assert.ok(!r.stdout.includes(text) && !r.stderr.includes(text), `printed ${text}`);
    assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test("fix 2: the last-resort guard prints only an error class and exits 2, never the message or stack", () => {
  const co = checkout();
  fs.writeFileSync(path.join(co.root, "package.files.json"), "{ not json from zzprivatehandle /Users/x");
  const r = co.run();
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "content-gate: ERROR internal (SyntaxError)\n");
});

/** Adds and commits `files` (path → text) to a checkout. @param {string} root @param {Record<string, string>} files */
function commit(root, files) {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  g(root, "add", "-f", ...Object.keys(files));
  g(root, "commit", "-qm", "c");
}

/** @param {string} s */
const lines = (s) => s.split("\n").filter(Boolean);

test("private list: the local .content-gate.private.json applies when the variable is unset or blank; the variable wins over it", () => {
  const co = checkout();
  fs.writeFileSync(path.join(co.root, "README.md"), "by zzprivatehandle\n");
  fs.writeFileSync(path.join(co.root, PRIVATE_LIST_FILE), JSON.stringify([{ name: "zz_file_rule", pattern: "zzprivatehandle" }]));
  for (const env of [envWith(null), envWith(""), envWith("  \n")]) {
    const r = co.runEnv(env);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(lines(r.stdout), ["FAIL README.md:1 rule=zz_file_rule", "content-gate: 1 finding(s)"]);
    assert.equal(r.stderr, "", "no notice: a list was found");
  }
  const viaEnv = co.runEnv(envWith(ZZ_LIST));
  assert.match(viaEnv.stdout, /^FAIL README\.md:1 rule=zz_handle$/m);
  assert.doesNotMatch(viaEnv.stdout, /zz_file_rule/, "the variable replaces the file, it doesn't add to it");
});

// Every bad list holds the marker `zzsecret` in a pattern or a name: the message must never print it.
const BAD_LISTS = [
  ["not JSON", "not json zzsecret"],
  ["not an array", JSON.stringify({ name: "a", pattern: "zzsecret" })],
  ["empty", "[]"],
  ["65 entries", JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ name: `n${i}`, pattern: `zzsecret${i}` })))],
  ["a 201-character pattern", JSON.stringify([{ name: "a", pattern: `zzsecret${"x".repeat(193)}` }])],
  ["an uppercase name", JSON.stringify([{ name: "Zzsecret", pattern: "zzsecret" }])],
  ["a 33-character name", JSON.stringify([{ name: `zzsecret${"x".repeat(25)}`, pattern: "abc" }])],
  ["a name with a dash", JSON.stringify([{ name: "zz-secret", pattern: "abc" }])],
  ["a pattern that does not compile", JSON.stringify([{ name: "a", pattern: "zzsecret(" }])],
  ["a pattern that matches the empty string", JSON.stringify([{ name: "a", pattern: "zzsecret|" }])],
  ["an empty pattern", JSON.stringify([{ name: "a", pattern: "" }])],
  ["a non-string pattern", JSON.stringify([{ name: "a", pattern: 5 }])],
  ["an extra key", JSON.stringify([{ name: "a", pattern: "zzsecret", note: "zzsecret" }])],
  ["a duplicate name", JSON.stringify([{ name: "a", pattern: "zzsecret" }, { name: "a", pattern: "zzsecret2" }])],
  ["a generic rule's name", JSON.stringify([{ name: "email", pattern: "zzsecret" }])],
  ["an operational rule's name", JSON.stringify([{ name: "symlink", pattern: "zzsecret" }])],
  ["a null entry", JSON.stringify([null])]
];

test("private list (−): an invalid list exits 2 in every mode, with a reason that never prints a pattern or name", () => {
  const co = checkout();
  for (const [what, list] of BAD_LISTS) {
    for (const mode of [[], ["--tracked"], ["--dir", pkg()], ["--require-private"]]) {
      const r = co.runEnv(envWith(list), ...mode);
      assert.equal(r.status, 2, `${what} ${mode.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "", what);
      assert.match(r.stderr, /^content-gate: invalid private denylist: CONTENT_GATE_DENYLIST: [^\n]+\n$/, what);
      assert.ok(!r.stderr.toLowerCase().includes("zzsecret"), `${what}: printed the marker: ${r.stderr}`);
    }
  }
});

test("private list: the bounds are inclusive (64 entries, 200-character patterns, 32-character names)", () => {
  const max = Array.from({ length: 64 }, (_, i) => ({ name: `n${i}`, pattern: `p${i}x` }));
  assert.ok(parsePrivateList(JSON.stringify(max)).ok);
  assert.ok(parsePrivateList(JSON.stringify([{ name: "a".repeat(32), pattern: "z".repeat(200) }])).ok);
  const p = parsePrivateList(JSON.stringify([{ name: "a", pattern: "ZZ" }]));
  assert.ok(p.ok && p.rules[0].re.flags.includes("i"), "patterns are case-insensitive");
});

test("private list (−): an invalid or linked .content-gate.private.json exits 2; a link is never followed", () => {
  const co = checkout();
  const file = path.join(co.root, PRIVATE_LIST_FILE);
  fs.writeFileSync(file, "not json zzsecret");
  const bad = co.runEnv(envWith(null));
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr, `content-gate: invalid private denylist: ${PRIVATE_LIST_FILE}: not valid JSON\n`);
  fs.rmSync(file);
  const outside = path.join(tmpDir(), "list.json");
  fs.writeFileSync(outside, ZZ_LIST);
  fs.symlinkSync(outside, file);
  const linked = co.runEnv(envWith(null));
  assert.equal(linked.status, 2, linked.stdout);
  assert.equal(linked.stderr, `content-gate: invalid private denylist: ${PRIVATE_LIST_FILE}: symlink\n`);
});

test("--require-private (−): with no private list, the gate exits 2 in every mode instead of passing on generic rules", () => {
  const co = checkout();
  for (const env of [envWith(null), envWith("")]) {
    for (const mode of [[], ["--tracked"], ["--dir", pkg()]]) {
      const r = co.runEnv(env, ...mode, "--require-private");
      assert.equal(r.status, 2, `${mode.join(" ")}: ${r.stdout}`);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, `content-gate: --require-private: no private denylist (set ${PRIVATE_ENV} or create ${PRIVATE_LIST_FILE})\n`);
    }
  }
  const ok = co.run("--require-private");
  assert.equal(ok.status, 0, "with a list, --require-private passes a clean tree");
  assert.equal(ok.stderr, "");
});

test("no private list: the generic rules still run, with exactly one notice line; --tracked checks nothing", () => {
  const co = checkout();
  fs.writeFileSync(path.join(co.root, "README.md"), "by zzprivatehandle\n");
  const r = co.runEnv(envWith(null));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^content-gate: ok \(\d+ files\)$/m);
  assert.deepEqual(lines(r.stderr), [`content-gate: notice: no private denylist (set ${PRIVATE_ENV} or create ${PRIVATE_LIST_FILE}); generic rules only`]);
  fs.writeFileSync(path.join(co.root, "README.md"), "see /Users/x\n");
  const generic = co.runEnv(envWith(""));
  assert.equal(generic.status, 1);
  assert.match(generic.stdout, /^FAIL README\.md:1 rule=users_path$/m);
  const tracked = co.runEnv(envWith(null), "--tracked");
  assert.equal(tracked.status, 0);
  assert.equal(tracked.stdout, "");
  assert.deepEqual(lines(tracked.stderr), [`content-gate: notice: no private denylist (set ${PRIVATE_ENV} or create ${PRIVATE_LIST_FILE}); --tracked checked nothing`]);
});

test("--tracked: every tracked file is scanned with the private rules only, with the same redaction and exemptions", () => {
  const co = checkout(JSON.stringify({ repository: { type: "git", url: "https://github.com/zzprivateorg-crew/review-loop.git" } }));
  commit(co.root, { "test/a.test.mjs": "/Users/x and a@gmail.com and ~/.claude/rules/x.md\n", "docs/clean.md": "brew install zzprivateorg-crew/tap/review-loop\n",
    LICENSE: "MIT License\n\nCopyright (c) 2026 zzprivateorg-holder\n" });
  const clean = co.run("--tracked");
  assert.equal(clean.status, 0, clean.stdout);
  assert.match(clean.stdout, /^content-gate: ok \(\d+ tracked files, private rules\)$/m);
  commit(co.root, { "docs/notes.md": "ok\nby ZzPrivateHandle\n", "docs/zzprivateorg-plans/x.md": "clean\n", "test/b.mjs": "zz-private-project\n" });
  const r = co.run("--tracked");
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(lines(r.stdout), ["FAIL docs/notes.md:2 rule=zz_handle", "FAIL docs/<redacted>/x.md rule=zz_org (path)", "FAIL test/b.mjs:1 rule=zz_project", "content-gate: 3 finding(s)"]);
  for (const text of ["zzprivatehandle", "ZzPrivateHandle", "zzprivateorg-plans", "zz-private-project"]) assert.ok(!r.stdout.includes(text) && !r.stderr.includes(text), `printed ${text}`);
});

test("--tracked: a tracked symlink is scanned as its target text, never followed; a linked parent is still a finding", () => {
  const co = checkout();
  const outside = outsideDir();
  fs.writeFileSync(path.join(outside, "b.mjs"), "zzprivatehandle\n");
  fs.symlinkSync("README.md", path.join(co.root, "AGENTS.md"));
  fs.symlinkSync(path.join(outside, "b.mjs"), path.join(co.root, "plugin/linked.mjs"));
  g(co.root, "add", "AGENTS.md", "plugin/linked.mjs");
  g(co.root, "commit", "-qm", "links");
  const ok = co.run("--tracked");
  assert.equal(ok.status, 0, `${ok.stdout}: the outside file's content was never read`);
  fs.rmSync(path.join(co.root, "AGENTS.md"));
  fs.symlinkSync("docs/zzprivateorg.md", path.join(co.root, "AGENTS.md"));
  assert.deepEqual(lines(co.run("--tracked").stdout), ["FAIL AGENTS.md:1 rule=zz_org", "content-gate: 1 finding(s)"]);
  fs.rmSync(path.join(co.root, "cli/sub"), { recursive: true });
  fs.symlinkSync(outside, path.join(co.root, "cli/sub"));
  assert.deepEqual(readTracked(co.root, "cli/sub/a.mjs"), { ok: false, rule: "symlink" });
  assert.match(co.run("--tracked").stdout, /^FAIL cli\/sub\/a\.mjs rule=symlink$/m);
});

test("a committed private list fails both git modes (rule=private_list_tracked)", () => {
  const co = checkout();
  commit(co.root, { [PRIVATE_LIST_FILE]: JSON.stringify([{ name: "zz_x", pattern: "zzqqq" }]) });
  for (const mode of [[], ["--tracked"]]) {
    const r = co.run(...mode);
    assert.equal(r.status, 1, mode.join(" "));
    assert.match(r.stdout, /^FAIL \.content-gate\.private\.json rule=private_list_tracked$/m);
  }
});

test("this repo ignores the private list file, so it can't be committed by accident", () => {
  const r = spawnSync("git", ["check-ignore", "-q", "--no-index", PRIVATE_LIST_FILE], { encoding: "utf8" });
  assert.equal(r.status, 0, `${PRIVATE_LIST_FILE} is not gitignored`);
});
