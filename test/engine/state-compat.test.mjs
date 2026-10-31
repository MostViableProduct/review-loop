import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { newRecord, writeRecord, readRecord, identityKey, stateRoot } from "../../plugin/engine/lib/state.mjs";
import { applyRoundResult } from "../../plugin/engine/lib/policy.mjs";
import { scoreFindings } from "../../plugin/engine/lib/scoring.mjs";
import { classify, triageCounts } from "../../plugin/engine/lib/value.mjs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpDir } from "./helpers.mjs";

const FIXTURE_PATH = "test/fixtures/record-1.1.0.json";
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const WHY_1_1_0 = ["critical", "unvalued", "accepted_risk", "money_data_security", "repeat_class", "realistic", "low_value"];
// 1.1.0's rule for a history entry's triage.why, written out here and not imported: exactly these keys, counts that
// add up to blocking + advisory.
const legacyHistoryOk = (/** @type {Array<{ triage?: { why: Record<string, number>, blocking: number, advisory: number } }>} */ history) =>
  history.every((e) => e.triage === undefined || (
    Object.keys(e.triage.why).length === WHY_1_1_0.length &&
    WHY_1_1_0.every((k) => Object.hasOwn(e.triage?.why ?? {}, k)) &&
    Object.values(e.triage.why).reduce((a, b) => a + b, 0) === e.triage.blocking + e.triage.advisory));

beforeEach(() => {
  process.env.REVIEW_LOOP_STATE_DIR = tmpDir("rl-state-");
});

/** Put the committed record on disk as 1.1.0 left it: writeRecord makes the directory, then the raw bytes replace the file. */
function installFixture() {
  const key = identityKey(FIXTURE.identity);
  writeRecord(newRecord(FIXTURE.identity));
  const file = path.join(stateRoot(), "records", `${key}.json`);
  fs.writeFileSync(file, fs.readFileSync(FIXTURE_PATH));
  return { key, file };
}

test("the committed 1.1.0 record satisfies the literal 1.1.0 check, and covers history, a dispute, a waiver and classes", () => {
  assert.equal(FIXTURE.history.length, 3);
  assert.ok(FIXTURE.disputes.length >= 1 && FIXTURE.waivers.length >= 1 && FIXTURE.classes.length >= 1);
  assert.ok(legacyHistoryOk(FIXTURE.history), "control: the check accepts what 1.1.0 wrote");
});

test("a committed 1.1.0 record reads unchanged under 1.2.0: history, dispute, waiver and classes", () => {
  const { key } = installFixture();
  const back = readRecord(key);
  assert.ok(back, "not quarantined");
  assert.deepEqual(back.history, FIXTURE.history);
  assert.deepEqual(back.disputes, FIXTURE.disputes);
  assert.deepEqual(back.waivers, FIXTURE.waivers);
  assert.deepEqual(back.classes, FIXTURE.classes);
});

/** Run one 1.2.0 round with a real-path low on the committed record and write it, as the engine would. */
function roundWithRealPathLow() {
  const { key, file } = installFixture();
  const rec = readRecord(key);
  assert.ok(rec);
  const value = { likelihood: "real_path", impact: "user_visible", fix_cost: "small", class: "error copy", actor: "none", accepted_risk: "none", trigger: "t" };
  const finding = { severity: "low", title: "[Usability] vague copy", file: "a.md" };
  const triage = classify({ severity: "low", title: finding.title, value }, { trustedActors: new Set(), acceptedRisks: new Map(), priorClasses: new Set() });
  const counts = triageCounts([{ severity: "low", dimension: "Usability", value, triage }]);
  applyRoundResult(rec, scoreFindings([finding]), [finding], "fp-new", { context: "default", triage: counts.history });
  writeRecord(rec);
  return { key, file };
}

test("after a 1.2.0 round with a real-path low on the committed record, the file satisfies 1.1.0's check and keeps what 1.1.0 wrote", () => {
  const { file } = roundWithRealPathLow();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.history.length, 4);
  assert.ok(legacyHistoryOk(raw.history), "a 1.1.0 validator accepts every history entry, including the new one");
  assert.deepEqual(raw.history.slice(0, 3), FIXTURE.history, "what 1.1.0 wrote is untouched");
  assert.equal(raw.history[3].triage.why.realistic, 1, "the real-path low is counted under realistic");
  assert.deepEqual(raw.waivers, FIXTURE.waivers);
  assert.ok(FIXTURE.classes.every((/** @type {{ key: string }} */ c) => raw.classes.some((/** @type {{ key: string }} */ x) => x.key === c.key)), "its classes are kept");
});

test("the real v1.1.0 reader (extracted from the tag) accepts that record: the downgrade case, run against the old code", () => {
  const { key } = roundWithRealPathLow();
  const old = tmpDir("rl-v110-");
  const archive = spawnSync("git", ["archive", "v1.1.0", "plugin/engine"], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(archive.status, 0, "the v1.1.0 tag must be present: run `git fetch --tags` (CI checks out with fetch-depth: 0)");
  assert.equal(spawnSync("tar", ["-x", "-C", old], { input: archive.stdout }).status, 0);
  const url = pathToFileURL(path.join(old, "plugin/engine/lib/state.mjs")).href;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import { readRecord } from ${JSON.stringify(url)}; const r = readRecord(process.argv[1]); console.log(JSON.stringify(r === null ? null : { status: r.status, history: r.history, disputes: r.disputes, waivers: r.waivers, classes: r.classes, lastFindings: r.lastFindings }));`, key], { encoding: "utf8", env: process.env });
  assert.equal(run.status, 0, `v1.1.0 readRecord: ${run.stderr}`);
  const seenByOld = JSON.parse(run.stdout);
  assert.ok(seenByOld, "the v1.1.0 reader did not quarantine the record");
  assert.equal(seenByOld.history.length, 4);
  const seenByNew = readRecord(key);
  assert.ok(seenByNew);
  // Every compatibility-sensitive field must read the same through both versions; dropping or rewriting one makes this red.
  for (const field of ["status", "history", "disputes", "waivers", "classes", "lastFindings"]) {
    assert.deepEqual(seenByOld[field], JSON.parse(JSON.stringify(seenByNew[field])), `the v1.1.0 reader sees a different ${field}`);
  }
  assert.deepEqual(seenByOld.history.slice(0, 3), FIXTURE.history, "the old reader still sees what 1.1.0 wrote");
});

test("a history why with an eighth key real_path_low is quarantined: the persisted shape does not change", () => {
  const { key, file } = installFixture();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.history[2].triage.why = { ...raw.history[2].triage.why, real_path_low: 1, realistic: raw.history[2].triage.why.realistic - 1 };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(readRecord(key), null);
});
