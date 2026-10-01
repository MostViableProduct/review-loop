import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFindings, parseDimensionTag, DIMENSIONS, BANDS } from "../../plugin/engine/lib/scoring.mjs";

const f = (severity, dim, n = 1) =>
  Array.from({ length: n }, (_, i) => ({ severity, title: `[${dim}] finding ${i}` }));

const dim = (res, name) => res.dimensions.find((d) => d.name === name);

test("no findings: every dimension clean at 9.5, passes", () => {
  const r = scoreFindings([]);
  assert.equal(r.dimensions.length, 11);
  assert.ok(r.dimensions.every((d) => d.tenths === 95));
  assert.equal(r.overall, 9.5);
  assert.equal(r.pass, true);
});

test("each band starts at its top with one finding", () => {
  assert.equal(dim(scoreFindings(f("critical", "Safety")), "Safety").score, 4.9);
  assert.equal(dim(scoreFindings(f("high", "Safety")), "Safety").score, 6.9);
  assert.equal(dim(scoreFindings(f("medium", "Safety")), "Safety").score, 8.4);
  assert.equal(dim(scoreFindings(f("low", "Safety")), "Safety").score, 9.1);
});

test("count nudges down within the band and clamps at the band minimum", () => {
  for (const [sev, band] of Object.entries(BANDS)) {
    assert.equal(dim(scoreFindings(f(sev, "Reliability", 2)), "Reliability").tenths, band.top - band.step);
    const many = dim(scoreFindings(f(sev, "Reliability", 50)), "Reliability");
    assert.equal(many.tenths, band.min, `${sev} must clamp to its band minimum`);
  }
});

test("worst severity sets the band; lower findings in the same dimension add to the count", () => {
  const r = scoreFindings([...f("low", "Performance", 3), ...f("high", "Performance")]);
  const d = dim(r, "Performance");
  assert.equal(d.worst, "high");
  assert.equal(d.count, 4);
  assert.equal(d.tenths, 69 - 4 * 3);
});

test("a single LOW fails the gate even though the mean clears 9.2", () => {
  const r = scoreFindings(f("low", "Usability"));
  assert.ok(r.meanExact >= 9.2, `mean ${r.meanExact} should be ≥ 9.2`);
  assert.equal(dim(r, "Usability").score, 9.1);
  assert.equal(r.pass, false);
});

test("untagged and unknown-tag findings count under Correctness, never dropped", () => {
  const r = scoreFindings([
    { severity: "medium", title: "no tag here" },
    { severity: "low", title: "[Vibes] unknown dimension" }
  ]);
  assert.equal(r.untagged, 2);
  assert.equal(dim(r, "Correctness").count, 2);
  assert.equal(r.pass, false);
});

test("tag parsing is case-insensitive and tolerant of spacing", () => {
  assert.deepEqual(parseDimensionTag("[ safety ] leak"), { dimension: "Safety", tagged: true });
  assert.deepEqual(parseDimensionTag("[MAINTAINABILITY] x"), { dimension: "Maintainability", tagged: true });
});

test("arithmetic string reconciles with the dimension table", () => {
  const r = scoreFindings([...f("critical", "Safety"), ...f("medium", "Coherence")]);
  const sum = r.dimensions.reduce((s, d) => s + d.tenths, 0) / 10;
  assert.equal(r.sum, sum);
  assert.match(r.arithmetic, new RegExp(`^${sum.toFixed(1)} / ${DIMENSIONS.length} = `));
});
