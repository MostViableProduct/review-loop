import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// GitHub retires a macOS runner image on a schedule; its jobs are cancelled during brownouts and fail for good after
// the date (actions/runner-images#13518 for macos-14). Both the repo's workflows and the tap's staged workflow, which
// the release job copies into a tap PR, must name a macOS runner that still exists.
const DIRS = [".github/workflows", "homebrew-tap/.github/workflows"];
const RETIRED = /\bmacos-(?:1[0-4]|[0-9])(?![0-9])/;
const files = DIRS.flatMap((d) => fs.readdirSync(d).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(d, f)));

test("no workflow runs on a retired macOS runner", () => {
  assert.ok(files.length >= 4, "the scan finds the repo's and the tap's workflows");
  for (const f of files) {
    const hit = fs.readFileSync(f, "utf8").split("\n").findIndex((l) => RETIRED.test(l));
    assert.equal(hit, -1, `${f}:${hit + 1} names a retired macOS runner (macos-14 or older)`);
  }
});

test("the scan is not vacuous: the workflows do name macos-15 runners", () => {
  for (const f of [".github/workflows/ci.yml", "homebrew-tap/.github/workflows/tests.yml"]) {
    assert.match(fs.readFileSync(f, "utf8"), /\bmacos-15\b/, `${f} runs on macos-15`);
  }
});
