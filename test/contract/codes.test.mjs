import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listCodes } from "../../scripts/list-codes.mjs";
import { CODES, CLI_EXIT, EVENT_CATALOG, DECISION_OPTIONS, PAUSE_REASONS, exitFor, categoryOf } from "../../plugin/engine/lib/codes.mjs";
import { OPTIONS, OPTION_LABELS } from "../../plugin/engine/lib/policy.mjs";
import { STATUSES } from "../../plugin/engine/lib/state.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("T-OBS-3: every code literal in plugin/ and cli/ is registered", () => {
  const missing = listCodes(ROOT).filter((c) => !(c in CODES));
  assert.deepEqual(missing, [], `register these in plugin/engine/lib/codes.mjs: ${missing.join(", ")}`);
});

test("T-OBS-3: the extractor sees computed codes (?? fallbacks, ternaries, option values, lock diagnostics)", () => {
  const seen = listCodes(ROOT);
  const computed = [
    "artifact_missing", "artifact_symlink_rejected", "artifact_not_regular_file", "artifact_too_large", "git_failed",
    "fetch_failed", "unshallow_failed", "history_incomplete", "merge_base_unavailable", "history_scan_limit", "diff_too_large",
    "hook_input_missing_session", "too_large", "not_regular_file", "open_failed"
  ];
  assert.deepEqual(computed.filter((c) => !seen.includes(c)), [], "extractor lost a computed-code position");
});

test("T-OBS-3: statuses that become a round.result code are registered", () => {
  assert.deepEqual(["passed", "needs_fixes", "awaiting_human"].filter((s) => !STATUSES.includes(s) || !(s in CODES)), []);
});

test("T-OBS-3: every page reason and decision option the engine can emit is known to the event catalog", () => {
  assert.deepEqual([...PAUSE_REASONS].sort(), Object.keys(OPTIONS).sort(), "PAUSE_REASONS mirrors policy OPTIONS");
  assert.deepEqual(PAUSE_REASONS.filter((r) => !(r in CODES)), []);
  assert.deepEqual(Object.keys(OPTION_LABELS).filter((o) => !DECISION_OPTIONS.includes(o)), []);
  assert.ok("round.decision" in EVENT_CATALOG);
});

test("every registered code has a category, an exit code and a remedy line", () => {
  for (const [code, meta] of Object.entries(CODES)) {
    assert.ok(Object.hasOwn(CLI_EXIT, meta.category), `${code}: bad category`);
    assert.equal(exitFor(code), CLI_EXIT[meta.category]);
    assert.equal(typeof meta.remedy, "string", code);
    if (meta.category !== "ok") assert.ok(meta.remedy.length > 0, `${code}: remedy required`);
  }
  assert.equal(categoryOf("definitely_not_a_code"), "internal");
});

test("migrate's codes (Task 22, R-D29) are registered as user_action", () => {
  for (const c of ["settings_mixed_hook_group", "settings_legacy_hook_unrecognized", "legacy_pin_invalid", "migration_manifest_invalid", "migration_manifest_unreadable", "rollback_skipped_modified"]) assert.equal(categoryOf(c), "user_action", c);
});

test("T-CFG-8 (grep half): only lib/config.mjs knows the config location", () => {
  const hits = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.endsWith(".mjs") && p !== path.join(ROOT, "plugin/engine/lib/config.mjs") && /"\.config"|XDG_CONFIG_HOME/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "plugin"));
  walk(path.join(ROOT, "cli"));
  assert.deepEqual(hits, []);
});

test("M4: a code's detailRemedies name exactly its details, each with a non-empty fix", () => {
  for (const [code, meta] of Object.entries(CODES)) {
    if (!meta.detailRemedies) continue;
    assert.deepEqual(Object.keys(meta.detailRemedies).sort(), [...(meta.details ?? [])].sort(), code);
    for (const [d, r] of Object.entries(meta.detailRemedies)) assert.ok(r.trim().length > 0, `${code}/${d}`);
  }
  assert.ok(CODES.live_check_failed.detailRemedies, "live_check_failed carries its per-detail fixes");
});
