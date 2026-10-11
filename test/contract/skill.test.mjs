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
    "**Advisory** findings (`blocking: false`): list each to the user in one line with its `why` and `value.likelihood`. Don't change code for one unless the user asks, and never dispute one (the engine refuses it with `dispute_advisory`)."
  ]) assert.ok(SKILL.includes(s), s);
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
