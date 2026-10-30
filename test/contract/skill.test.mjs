import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OPTIONS, optionLabel } from "../../plugin/engine/lib/policy.mjs";

// Spec D3 "The skill": Claude acts on a round through SKILL.md, so it must say what the engine does. Whitespace is
// flattened, so a re-wrapped line still matches.
const SKILL = fs.readFileSync("plugin/skills/review-loop/SKILL.md", "utf8").replace(/\s+/g, " ");

test("SKILL.md: only blocking findings are fixed or disputed; advisory ones are listed, not changed, never disputed", () => {
  for (const s of [
    "Only **blocking** findings (`findings[].blocking: true`) hold the gate; fix or dispute those alone.",
    "**Advisory** findings (`blocking: false`): list each reported advisory finding to the user in one line with its `why` and `value.likelihood` (`findings` holds only the reported ones)."
  ]) assert.ok(SKILL.includes(s), s);
  assert.ok(SKILL.includes("Don't change code for one unless the user asks, and never dispute one (the engine refuses it with `dispute_advisory`)."));
});

test("SKILL.md: advisory findings are listed as reported, and omitted ones are count-only, on the pass path and the fix path", () => {
  const OMITTED = "N more advisory findings were left out of this report (cap 5, plus one per accepted risk); their counts are in `score`";
  assert.equal(SKILL.split(OMITTED).length - 1, 2, "the omission line is in the exit-0 row and in the exit-10 step");
  assert.ok(!SKILL.includes("list each to the user in one line"), "the unqualified wording is gone");
  assert.ok(SKILL.includes("list each reported advisory finding as in step 3"));
  assert.ok(SKILL.includes("`advisory_shown` of `advisory`"));
});

test("SKILL.md: the result report shows the blocking, advisory and unvalued counts", () => {
  assert.ok(SKILL.includes("the `score.blocking`, `score.advisory` and `score.unvalued` counts"));
});

test("SKILL.md: the diminishing_returns page, with no recommendation, and its own continue", () => {
  assert.ok(SKILL.includes("| 20 / 21 | checkpoint / stall or diminishing returns (`awaiting.reason`) |"));
  for (const s of [
    "`diminishing_returns` (exit 21)",
    "Show the triage table from `awaiting.detail.rounds` first",
    "offer `awaiting.options` in order, with none marked recommended",
    "Its `continue` resets the value counter and keeps the round limit, unlike the checkpoint and stall `continue`.",
    "the artifact, the plugin or `.claude/review-context.md` changed after the page was shown"
  ]) assert.ok(SKILL.includes(s), s);
  assert.ok(OPTIONS.diminishing_returns.every((o) => !optionLabel("diminishing_returns", o).includes("Recommended")), "the engine recommends none, as the skill says");
});

test("the spec's D5 describes the value page the engine serves: options in order, their labels, none recommended", () => {
  const spec = fs.readFileSync("docs/superpowers/specs/2026-10-10-value-triage-design.md", "utf8").replace(/\s+/g, " ");
  const d5 = spec.slice(spec.indexOf("### D5."), spec.indexOf("### D6."));
  const order = `with the options \`${JSON.stringify(OPTIONS.diminishing_returns).replaceAll(",", ", ")}\``;
  assert.ok(d5.includes(order), order);
  for (const o of OPTIONS.diminishing_returns) assert.ok(d5.includes(`"${optionLabel("diminishing_returns", o)}"`), o);
  assert.ok(!d5.includes("(Recommended)") && !spec.includes("Accept (logged override) (Recommended)"), "the spec recommends no option on this page");
});
