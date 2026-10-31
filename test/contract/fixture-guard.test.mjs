import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, readFixture, recordFixture, listFixtures } from "../engine/helpers.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

// A secret outside the checkout that a reviewed symlink would point at.
function sentinel() {
  const outside = tmpDir("rl-outside-");
  const file = path.join(outside, "secret.txt");
  fs.writeFileSync(file, "SENTINEL-SECRET");
  return { outside, file };
}

test("fixture guard: the live e2e fixture reads as a regular file", () => {
  assert.match(readFixture(REPO, "cli", "fixtures", "livecheck-doc.md"), /\S/);
});

test("fixture guard: readFixture refuses a symlinked fixture and a symlinked parent", () => {
  const root = tmpDir("rl-root-");
  const { outside, file } = sentinel();
  fs.mkdirSync(path.join(root, "fixtures"));
  fs.symlinkSync(file, path.join(root, "fixtures", "doc.md"));
  assert.throws(() => readFixture(root, "fixtures", "doc.md"), /symlinks are never followed/);
  fs.rmSync(path.join(root, "fixtures"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "fixtures"));
  fs.writeFileSync(path.join(outside, "doc.md"), "x");
  assert.throws(() => readFixture(root, "fixtures", "doc.md"));
});

test("fixture guard: recordFixture writes a regular file in a real directory", () => {
  const root = tmpDir("rl-root-");
  recordFixture(root, path.join(root, "test", "fixtures", "golden"), "a.json", "{}");
  assert.equal(fs.readFileSync(path.join(root, "test", "fixtures", "golden", "a.json"), "utf8"), "{}");
});

test("fixture guard: recordFixture never writes through a symlinked directory or file", () => {
  const root = tmpDir("rl-root-");
  const { outside, file } = sentinel();
  fs.mkdirSync(path.join(root, "test"));
  fs.symlinkSync(outside, path.join(root, "test", "fixtures"));
  assert.throws(() => recordFixture(root, path.join(root, "test", "fixtures", "golden"), "a.json", "{}"), /not a real directory/);
  assert.deepEqual(fs.readdirSync(outside), ["secret.txt"], "nothing was created in the link's target");

  fs.rmSync(path.join(root, "test", "fixtures"));
  const real = path.join(root, "test", "fixtures");
  fs.mkdirSync(real);
  fs.symlinkSync(file, path.join(real, "a.json"));
  assert.throws(() => recordFixture(root, real, "a.json", "{}"));
  assert.equal(fs.readFileSync(file, "utf8"), "SENTINEL-SECRET", "the link's target is untouched");
});

test("fixture guard: recordFixture refuses a directory outside the root", () => {
  const root = tmpDir("rl-root-");
  assert.throws(() => recordFixture(root, tmpDir("rl-elsewhere-"), "a.json", "{}"), /outside/);
});

test("fixture guard: listFixtures refuses a symlinked directory and a symlinked entry", () => {
  const root = tmpDir("rl-root-");
  const { outside, file } = sentinel();
  fs.mkdirSync(path.join(root, "test"));
  fs.symlinkSync(outside, path.join(root, "test", "golden"));
  assert.throws(() => listFixtures(root, path.join(root, "test", "golden")), /not a real directory/);

  fs.rmSync(path.join(root, "test", "golden"));
  const real = path.join(root, "test", "golden");
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, "a.json"), "{}");
  assert.deepEqual(listFixtures(root, real), ["a.json"]);
  fs.symlinkSync(file, path.join(real, "b.json"));
  assert.throws(() => listFixtures(root, real), /not a regular file/);
});

test("fixture guard: the golden comparison reads fixtures through the guard", () => {
  const src = fs.readFileSync(path.join(REPO, "test", "engine", "golden.test.mjs"), "utf8");
  assert.match(src, /listFixtures\(ROOT, DIR\)/, "the directory is listed through listFixtures");
  assert.match(src, /readFixture\(ROOT,/, "each case file is read through readFixture");
  assert.doesNotMatch(src, /fs\.(readdirSync|readFileSync|writeFileSync)\(\s*(DIR|path\.join\(DIR)/, "no raw fs call on the fixture directory");
});

/**
 * Test files under `dir` whose text names `needle`. A link is skipped, never followed, and every file is read through
 * readFixture (lstat, a size cap), so an added `test/x.mjs` can't make this scan read outside the tree or hang.
 * @param {string} root @param {string} dir @param {string} needle @returns {string[]} paths relative to dir
 */
function filesMentioning(root, dir, needle) {
  const out = [];
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".mjs")) continue;
    const rel = path.relative(dir, path.join(e.parentPath, e.name));
    if (readFixture(root, path.relative(root, dir), rel).includes(needle)) out.push(rel);
  }
  return out;
}

test("fixture guard: the scan skips links and refuses oversized files", () => {
  const root = tmpDir("rl-root-");
  const { file } = sentinel();
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "test", "a.mjs"), "needle");
  fs.symlinkSync(file, path.join(root, "test", "link.mjs"));
  assert.deepEqual(filesMentioning(root, path.join(root, "test"), "needle"), ["a.mjs"], "the link is skipped, not read");
  fs.writeFileSync(path.join(root, "test", "big.mjs"), Buffer.alloc(300 * 1024));
  assert.throws(() => filesMentioning(root, path.join(root, "test"), "needle"), /exceeds/);
});

test("fixture guard: the companion fixture, which tests hand to a child process, is only read through readFixture", () => {
  const dir = path.join(REPO, "test");
  const found = filesMentioning(REPO, dir, "companion-1.0.6-signed-out.json").filter((f) => f !== path.join("contract", "fixture-guard.test.mjs"));
  assert.ok(found.length >= 3, "the scan finds the three tests that use it");
  for (const f of found) {
    const src = readFixture(REPO, "test", f);
    assert.match(src, /readFixture\(.*companion-1\.0\.6-signed-out\.json/, `${f} reads it through readFixture`);
    assert.doesNotMatch(src, /fs\.(readFileSync|copyFileSync)\(.*companion-1\.0\.6/, `${f} has no raw fs read of it`);
  }
});
