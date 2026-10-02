import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tapFormula, TEMPLATE } from "../../scripts/tap-formula.mjs";

const template = fs.readFileSync(TEMPLATE, "utf8");
const SHA = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881";

test("tap-formula fills in the release's url and sha256 and changes nothing else in the template", () => {
  const r = tapFormula(template, "1.2.3", SHA);
  assert.ok(r.ok);
  const lines = r.formula.split("\n");
  assert.ok(lines.includes('  url "https://github.com/MostViableProduct/review-loop/releases/download/v1.2.3/review-loop-1.2.3.tar.gz"'));
  assert.ok(lines.includes(`  sha256 "${SHA}"`));
  const changed = template.split("\n").filter((l, i) => l !== lines[i]);
  assert.equal(changed.length, 2, "only the url and sha256 lines differ");
  assert.ok(!/0{64}/.test(r.formula));
});

test("tap-formula refuses a placeholder or malformed sha256, a bad version, and an ambiguous template", () => {
  const no = (/** @type {ReturnType<typeof tapFormula>} */ r, /** @type {RegExp} */ re) => assert.ok(!r.ok && re.test(r.reason), JSON.stringify(r));
  no(tapFormula(template, "1.2.3", "0".repeat(64)), /all-zero placeholder/);
  no(tapFormula(template, "1.2.3", SHA.toUpperCase()), /64 lowercase hex/);
  no(tapFormula(template, "1.2.3", SHA.slice(1)), /64 lowercase hex/);
  no(tapFormula(template, "1.2", SHA), /X\.Y\.Z/);
  no(tapFormula(`${template}\n  url "x"\n`, "1.2.3", SHA), /exactly one url line/);
});

test("tap-formula as a script: a placeholder sha256 exits non-zero and prints no formula", () => {
  const bad = spawnSync(process.execPath, ["scripts/tap-formula.mjs", "1.2.3", "0".repeat(64)], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /refusing: the sha256 is the all-zero placeholder/);
  const good = spawnSync(process.execPath, ["scripts/tap-formula.mjs", "1.2.3", SHA], { encoding: "utf8" });
  assert.equal(good.status, 0);
  assert.match(good.stdout, new RegExp(`^ {2}sha256 "${SHA}"$`, "m"));
});
