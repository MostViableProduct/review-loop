import { test } from "node:test";
import assert from "node:assert/strict";
import { ADVISORY_REPORT_CAP, selectReported } from "../../plugin/engine/lib/value.mjs";

const FLAGS = { actorNotTrusted: false, theoretical_floored: false, unknownAcceptedRisk: false, acceptedRiskOutOfScope: false };
/** @param {{ severity?: string, impact?: string, likelihood?: string, why?: string, blocking?: boolean, ar?: string }} [o] */
const row = (o = {}) => ({
  severity: o.severity ?? "low",
  dimension: "Usability",
  value: { likelihood: o.likelihood ?? "plausible", impact: o.impact ?? "user_visible", fix_cost: "small", class: "c", actor: "none", accepted_risk: o.ar ?? "none", trigger: "t" },
  triage: { blocking: o.blocking ?? false, why: o.why ?? "low_value", likelihood: o.likelihood ?? "plausible", flags: FLAGS }
});
const idx = (/** @type {{ reported: Array<{ i: number }> }} */ s) => s.reported.map((x) => x.i);

test("selectReported: the representative of an accepted risk is its first row, not its best-ranked one", () => {
  const rows = [
    row({ why: "accepted_risk", ar: "AR-1", impact: "none" }),
    row({ why: "accepted_risk", ar: "AR-1", impact: "user_visible" }),
    ...Array.from({ length: 5 }, () => row({ impact: "operator_visible" }))
  ];
  const s = selectReported(rows);
  assert.deepEqual(idx(s).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], "row 0 represents AR-1; row 1 competes with the others and wins a cap slot; row 6 is omitted");
  assert.deepEqual([s.shown, s.omitted, s.distinct], [6, 1, 1]);
  // Row 0 ranks last on impact ("none"), so it can only be reported as the AR-1 representative, never as a capped row.
  assert.ok(idx(s).includes(0), "row 0 is reported: it is the AR-1 representative");
});

test("selectReported: the representative's text is the first row's, even when a later duplicate ranks higher", () => {
  const rows = [
    row({ why: "accepted_risk", ar: "AR-1", impact: "none" }),
    row({ why: "accepted_risk", ar: "AR-1", impact: "security" }),
    ...Array.from({ length: 5 }, () => row({ impact: "operator_visible" }))
  ];
  const s = selectReported(rows);
  // Row 1 (security) outranks every other row; if it were taken as the representative, row 0 (impact "none") would lose its cap slot.
  assert.ok(idx(s).includes(0), "row 0, the first AR-1 row, is reported as the representative");
  assert.deepEqual(idx(s), [0, 1, 2, 3, 4, 5], "row 1 is an ordinary capped row; row 6 is omitted by the cap");
});

test("selectReported: the cap is 5", () => {
  assert.equal(ADVISORY_REPORT_CAP, 5);
});

test("selectReported: eight advisory rows report five, in severity, impact, likelihood, index order", () => {
  const rows = [
    row({ impact: "none" }), // 0
    row({ impact: "operator_visible" }), // 1
    row({ impact: "user_visible" }), // 2
    row({ impact: "security" }), // 3
    row({ impact: "money_or_data" }), // 4
    row({ severity: "medium", impact: "none" }), // 5
    row({ severity: "high", impact: "none" }), // 6
    row({ impact: "user_visible", likelihood: "theoretical" }) // 7
  ];
  const s = selectReported(rows);
  // Ranked: 6 (high), 5 (medium), then low by impact: 4, 3, 2, 7 (theoretical after plausible), 1, 0. The first five.
  assert.deepEqual(idx(s), [2, 3, 4, 5, 6], "reported in original index order");
  assert.deepEqual([s.shown, s.omitted, s.distinct], [5, 3, 0]);
});

test("selectReported: fewer advisory rows than the cap are all reported", () => {
  const s = selectReported([row(), row(), row()]);
  assert.deepEqual([idx(s), s.shown, s.omitted], [[0, 1, 2], 3, 0]);
});

test("selectReported: blocking findings are never omitted", () => {
  const rows = [
    ...Array.from({ length: 12 }, () => row({ blocking: true, why: "realistic", severity: "high" })),
    ...Array.from({ length: 8 }, () => row())
  ];
  const s = selectReported(rows);
  assert.equal(s.reported.length, 12 + 5);
  assert.deepEqual([s.shown, s.omitted], [5, 3]);
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((i) => idx(s).includes(i)));
});

test("selectReported: a plausible advisory ranked last is omitted and counted (likelihood only orders)", () => {
  const rows = [...Array.from({ length: 5 }, () => row({ likelihood: "real_path" })), row({ likelihood: "plausible" })];
  const s = selectReported(rows);
  assert.deepEqual([idx(s), s.omitted], [[0, 1, 2, 3, 4], 1]);
});

test("selectReported: six distinct accepted risks are all reported, with five others", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, n) => row({ why: "accepted_risk", ar: `AR-${n + 1}`, impact: "operator_visible" })), // 0-5
    ...Array.from({ length: 6 }, () => row()) // 6-11
  ];
  const s = selectReported(rows);
  assert.deepEqual(idx(s), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([s.shown, s.omitted, s.distinct], [11, 1, 6]);
});

test("selectReported: eight findings citing one accepted risk are bounded: one representative, five others", () => {
  const rows = [
    ...Array.from({ length: 8 }, () => row({ why: "accepted_risk", ar: "AR-1", impact: "operator_visible" })), // 0-7
    ...Array.from({ length: 7 }, () => row()) // 8-14
  ];
  const s = selectReported(rows);
  assert.deepEqual(idx(s), [0, 8, 9, 10, 11, 12], "the first AR-1 row and the five best others");
  assert.deepEqual([s.shown, s.omitted, s.distinct], [6, 9, 1]);
});

test("selectReported: a row that cites an accepted risk but is not why accepted_risk is not a representative", () => {
  const s = selectReported([row({ ar: "AR-1", why: "low_value", impact: "none" }), ...Array.from({ length: 6 }, () => row())]);
  assert.deepEqual([s.distinct, s.omitted], [0, 2]);
  assert.ok(!idx(s).includes(0));
});
