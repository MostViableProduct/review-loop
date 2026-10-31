import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, readFixture, recordFixture } from "../engine/helpers.mjs";

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
