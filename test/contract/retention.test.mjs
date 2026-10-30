import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ADVISORY_REPORT_CAP } from "../../plugin/engine/lib/value.mjs";

const flat = (/** @type {string} */ p) => fs.readFileSync(p, "utf8").replace(/\s+/g, " ");
const THIS_SPEC = "docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md";
const PRIOR_SPEC = "docs/superpowers/specs/2026-10-10-value-triage-design.md";
const DOCS = [THIS_SPEC, PRIOR_SPEC, "plugin/skills/review-loop/SKILL.md", "README.md", "docs/TROUBLESHOOTING.md"];

test("retention: the value-triage spec carries an 'Amended by 1.2.0' note under its Outcome sentence, its non-negotiable, its rule table and its D3 advisory-reporting paragraph", () => {
  const prior = flat(PRIOR_SPEC);
  const prefix = `Amended by 1.2.0 (${THIS_SPEC})`;
  assert.equal(prior.split(prefix).length - 1, 5);
  // Each note sits immediately after the passage it amends (each anchor occurs once), so a misplaced or missing one is red.
  const after = (/** @type {string} */ anchor) => {
    assert.equal(prior.split(anchor).length - 1, 1, `anchor must occur exactly once: ${anchor}`);
    return prior.slice(prior.indexOf(anchor) + anchor.length).trimStart();
  };
  for (const anchor of ["instead of continuing.", "That is the same retention blocking findings have today.", "(they don't block).", "The `docs/EVENTS.md` table is regenerated (`node scripts/gen-readme-tables.mjs`)."]) {
    assert.ok(after(anchor).startsWith(`*${prefix}`), `no 1.2.0 note directly after: ${anchor}`);
  }
  assert.ok(after("(they don't block).").slice(0, 500).includes("advisory_omitted"), "the D3 note must point at the omitted count");
  const d7 = after("The `docs/EVENTS.md` table is regenerated (`node scripts/gen-readme-tables.mjs`).").slice(0, 600);
  for (const needle of ["why_real_path_low", "advisory_shown", "advisory_omitted", "accepted_risk_distinct"]) assert.ok(d7.includes(needle), `the D7 note must name: ${needle}`);
  const afterTable = prior.slice(prior.indexOf("| 7 | anything else | advisory | `low_value` |"));
  const note = afterTable.slice(afterTable.indexOf(prefix), afterTable.indexOf(prefix) + 700);
  for (const needle of ["rule 7 is split", "real_path_low", "why_real_path_low", "advisory_omitted"]) assert.ok(note.includes(needle), `the rule-table note must say: ${needle}`);
});

test("retention: SKILL.md, README.md and TROUBLESHOOTING.md state the cap, read from ADVISORY_REPORT_CAP", () => {
  for (const [p, needle] of [
    ["plugin/skills/review-loop/SKILL.md", `left out of this report (cap ${ADVISORY_REPORT_CAP}, plus one per accepted risk); their counts are in \`score\`". Don't change code`],
    ["README.md", `up to ${ADVISORY_REPORT_CAP} per round`],
    ["docs/TROUBLESHOOTING.md", `at most ${ADVISORY_REPORT_CAP} other advisory findings`]
  ]) assert.ok(flat(p).includes(needle), `${p} must say: ${needle}`);
});

test("retention: TROUBLESHOOTING.md says omitted findings do not enter the class history", () => {
  assert.ok(flat("docs/TROUBLESHOOTING.md").includes("they do not enter the class history"));
  assert.ok(!flat("docs/TROUBLESHOOTING.md").includes("still count toward the class history"));
});

test("retention: no document makes an unqualified 'appears in full' claim about advisory findings", () => {
  // Both specs quote the old unqualified sentence on purpose (to amend it); the amendments are asserted by the first test.
  for (const p of DOCS.filter((d) => d !== PRIOR_SPEC && d !== THIS_SPEC)) {
    for (const sentence of flat(p).split(/(?<=[.!?]) /).filter((x) => x.includes("appears in full"))) {
      assert.ok(/\bcap\b|up to \d/.test(sentence), `${p}: a retention claim with no cap qualifier in the same sentence`);
    }
  }
});
