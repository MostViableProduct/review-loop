import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyRepoPath, classifyAbsolutePath, CLAUDE_PLANS_DIR } from "../../plugin/engine/lib/classify.mjs";
import { loadRubricSection, buildFocus } from "../../plugin/engine/lib/rubric.mjs";
import { DIMENSIONS } from "../../plugin/engine/lib/scoring.mjs";
import { tmpDir } from "./helpers.mjs";

test("spec patterns", () => {
  for (const p of ["docs/superpowers/specs/2026-01-01-x.md", "specs/a.md", "docs/auth-design.md", "x/y-spec.md"]) {
    assert.equal(classifyRepoPath(p), "spec", p);
  }
});

test("plan patterns, and plan directory wins over a spec suffix", () => {
  for (const p of ["docs/superpowers/plans/2026-01-01-x.md", "rollout-plan.md", "docs/plans/foo-design.md"]) {
    assert.equal(classifyRepoPath(p), "plan", p);
  }
});

test("negatives: docs, implementation, excluded harness state", () => {
  assert.equal(classifyRepoPath("README.md"), "doc");
  assert.equal(classifyRepoPath("notes/specs.txt"), "doc");
  assert.equal(classifyRepoPath("src/specs/helper.ts"), "impl");
  assert.equal(classifyRepoPath("src/plan.ts"), "impl");
  assert.equal(classifyRepoPath(".claude/settings.local.json"), "excluded");
  assert.equal(classifyRepoPath("graphify-out/graph.json"), "excluded");
});

test("~/.claude/plans/*.md is a plan even outside any repo", () => {
  assert.equal(classifyAbsolutePath(path.join(CLAUDE_PLANS_DIR, "cozy-plan.md"), null), "plan");
  assert.equal(classifyAbsolutePath("/tmp/random.md", null), null);
});

test("the bundled default rubric names all 11 dimensions", () => {
  const section = loadRubricSection();
  for (const d of DIMENSIONS) assert.ok(section.includes(`**${d}**`), d);
});

test("rubric fails closed when a dimension disappears from the rules file", () => {
  const d = tmpDir();
  const file = path.join(d, "rules.md");
  fs.writeFileSync(file, "## Dimension definitions & boundaries\n- **Correctness** — x\n## Next\n");
  assert.throws(() => loadRubricSection(file), { code: "rubric_source_mismatch" });
});

test("focus carries artifact, project root, tagging instruction, rubric and disputes", () => {
  const focus = buildFocus({
    kind: "spec",
    label: "/r/docs/specs/a.md",
    projectRoot: "/r",
    instructions: "Review the spec.",
    disputes: [{ title: "[Safety] x", file: "a.md", reason: "covered by y" }],
    rubric: "RUBRIC-TEXT"
  });
  assert.match(focus, /ARTIFACT UNDER REVIEW \(spec\): \/r\/docs\/specs\/a\.md/);
  assert.match(focus, /PROJECT ROOT .*: \/r/);
  assert.match(focus, /Prefix EVERY finding title/);
  assert.match(focus, /RUBRIC-TEXT/);
  assert.match(focus, /"\[Safety\] x" \(a\.md\) — author's rationale: covered by y/);
});
