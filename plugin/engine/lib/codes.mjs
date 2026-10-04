// The single registry of codes, event types and CLI exit codes (spec §8.3). README tables are generated from it.
import { PRESET_NAMES } from "./presets.mjs";
import { DIMENSIONS } from "./scoring.mjs";

export const CLI_EXIT = Object.freeze({ ok: 0, user_action: 1, usage: 2, cancelled: 3, internal: 4 });

/** @typedef {"ok" | "user_action" | "usage" | "cancelled" | "internal"} Category */
/** @typedef {{ category: Category, remedy: string, details?: readonly string[], detailRemedies?: Readonly<Record<string, string>> }} CodeMeta */

const DOCTOR = "run `review-loop doctor`; if it persists, report a bug";
const RERUN = "re-run the review round";
const FETCH_FULL = `run \`git fetch --unshallow\`, then ${RERUN}`;
/** @type {CodeMeta} */
const OUTCOME = { category: "ok", remedy: "" };

/** @type {Readonly<Record<string, CodeMeta>>} */
export const CODES = Object.freeze({
  // outcomes
  ok: OUTCOME,
  reviewed: OUTCOME,
  allowed: OUTCOME,
  passed: OUTCOME,
  kill_switch: OUTCOME,
  not_pr_creation: OUTCOME,
  not_merge: OUTCOME,
  tracked: OUTCOME,
  mid_session: OUTCOME,
  skip_review: OUTCOME,
  needs_fixes: OUTCOME,
  awaiting_human: OUTCOME,
  setup_complete_unverified: { category: "ok", remedy: "run `review-loop doctor --live` to verify" },
  // registry fallbacks
  unregistered_code: { category: "internal", remedy: DOCTOR },
  unexpected_error: {
    category: "internal", remedy: DOCTOR,
    details: ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "SystemError", "module_not_found", "other"]
  },
  // CLI
  usage_noninteractive: { category: "usage", remedy: "re-run with --yes, or run it in a terminal" },
  usage_unknown_command: { category: "usage", remedy: "run `review-loop --help`" },
  usage_bad_flag: { category: "usage", remedy: "run `review-loop <command> --help`" },
  node_too_old: { category: "usage", remedy: "brew upgrade node" },
  cancelled: { category: "cancelled", remedy: "re-run the command when ready; completed steps are kept" },
  cli_busy: { category: "user_action", remedy: "another review-loop command is running; wait for it to finish" },
  claude_running: { category: "user_action", remedy: "quit all Claude Code sessions, then re-run" },
  claude_parent_process: { category: "user_action", remedy: "run this in a separate terminal, not from inside Claude Code" },
  tool_failed: {
    category: "user_action", remedy: "the named tool timed out or could not run; check it works in a terminal, then re-run",
    details: ["missing", "timeout", "output_too_large", "spawn_failed"]
  },
  claude_cli_unparseable: { category: "user_action", remedy: "update Claude Code (`claude update`), then re-run" },
  settings_invalid_json: { category: "user_action", remedy: "open ~/.claude/settings.json and correct the JSON; nothing was changed" },
  settings_target_insecure: { category: "user_action", remedy: "make ~/.claude/settings.json a regular file you own" },
  settings_writer_check_failed: { category: "user_action", remedy: "make sure `ps` and `lsof` on your PATH (/bin/ps and /usr/sbin/lsof on macOS) run for your user, then re-run" },
  settings_too_large: { category: "user_action", remedy: "settings.json is over 1 MiB, which is not a normal Claude Code settings file; check it by hand" },
  settings_concurrent_write: { category: "user_action", remedy: "close other programs editing settings.json, then re-run" },
  settings_open_elsewhere: { category: "user_action", remedy: "close the editor or sync tool that has settings.json open, then re-run" },
  settings_detached_write: { category: "user_action", remedy: "compare the reported backup with settings.json and copy over any change you need" },
  config_invalid: { category: "user_action", remedy: "run `review-loop config repair`" },
  config_missing: { category: "user_action", remedy: "run `review-loop setup` to create the config" },
  config_dir_untrusted: { category: "user_action", remedy: "make the folder holding the review-loop config (~/.config/review-loop) a real directory you own; any symlink above it (a dotfiles ~/.config) must be yours" },
  config_symlink_rejected: { category: "user_action", remedy: "replace the symlink with a regular file, or remove it (defaults apply) and run `review-loop config repair` or `review-loop setup`" },
  events_path_rejected: { category: "user_action", remedy: "choose an events path that is a regular file you own (or does not exist yet) in a real directory you own; symlinks, directories and missing parents are refused" },
  config_insecure: { category: "user_action", remedy: "the review-loop config file is owned by another user or is not a regular file: remove it or take ownership, then re-run `review-loop setup`" },
  rubric_symlink_rejected: { category: "user_action", remedy: "point rubricPath at the real file (`review-loop config set rubric <path>`)" },
  live_check_failed: {
    category: "user_action", remedy: "run the fix for the detail: the CLI prints it, and the live-check table below lists each",
    details: ["codex_missing", "codex_auth", "plugin_missing", "git_failed", "pin_mismatch", "model_invalid", "effort_invalid", "timeout", "unparseable", "unknown"],
    // One remedy per detail (spec §6.4); the CLI's failure line, setup, doctor and the README all read this map.
    detailRemedies: Object.freeze({
      codex_missing: "brew install --cask codex",
      codex_auth: "codex login",
      plugin_missing: "review-loop setup",
      git_failed: "check that `git init` works in a terminal, then re-run `review-loop doctor --live`",
      pin_mismatch: "review-loop setup   (without --yes: its pin step shows what changed)",
      model_invalid: "review-loop config set model <valid>",
      effort_invalid: "review-loop config set effort <valid>",
      timeout: "retry, and check your network or VPN",
      unparseable: "report a bug, with the output above",
      unknown: "report a bug, with the output above"
    })
  },
  preflight_failed: { category: "user_action", remedy: "fix the item marked FAIL, then re-run", details: ["claude", "codex_cli", "codex_auth", "codex_plugin"] },
  plugin_install_failed: { category: "user_action", remedy: "run `review-loop doctor`" },
  plugin_other_scope: { category: "user_action", remedy: "uninstall the project- or local-scope review-loop plugin in that project, then re-run" },
  plugin_disabled: { category: "user_action", remedy: "enable it with `claude plugin enable review-loop@review-loop`, then run migrate again" },
  plugin_uninstall_failed: { category: "user_action", remedy: "run `claude plugin uninstall review-loop@review-loop` (and `claude plugin marketplace remove review-loop`) in a terminal to see why, then re-run `review-loop uninstall`" },
  doctor_failed: { category: "user_action", remedy: "fix each check marked FAIL (each prints its fix), then re-run" },
  settings_tmp_leftover: { category: "user_action", remedy: "delete the leftover review-loop temp file next to settings.json; settings.json itself is intact" },
  rollback_skipped_modified: { category: "user_action", remedy: "the named file changed after migration; clear it and run `review-loop migrate --rollback` again to finish, or restore it by hand from the backup" },
  migration_manifest_unreadable: { category: "user_action", remedy: "check that you own ~/.claude/state/review-loop/migration.json and can read it, then re-run" },
  settings_mixed_hook_group: { category: "user_action", remedy: "move the review-loop hook into its own hook group in settings.json, then re-run" },
  settings_legacy_hook_unrecognized: { category: "user_action", remedy: "the command must be exactly `node <your Claude config dir>/review-loop/review-gate-hook.mjs <mode>`, alone in its hook group: rewrite the named hook in that form or remove it by hand, then re-run" },
  migration_archive_occupied: { category: "user_action", remedy: "move the named archive folder aside, then re-run `review-loop migrate` (to undo the earlier migration instead, run `review-loop migrate --rollback`)" },
  migration_config_dir_mismatch: { category: "user_action", remedy: "re-run with CLAUDE_CONFIG_DIR set to the Claude config dir named above, the one in use when you migrated" },
  migration_record_full: { category: "user_action", remedy: "run `review-loop migrate --rollback` to close the current migration record, then re-run `review-loop migrate`" },
  legacy_pin_invalid: { category: "user_action", remedy: "run `review-loop setup` to pin the Codex plugin again; the old pin file was left where it was" },
  migration_manifest_invalid: { category: "user_action", remedy: "restore by hand from ~/.claude/review-loop-legacy-<date>/ and the settings backups; the damaged record was kept as migration.json.corrupt-<ts>" },
  node_missing: { category: "user_action", remedy: "brew install node" },
  // doctor
  plugin_not_installed: { category: "user_action", remedy: "run `review-loop setup` to install and enable the review-loop plugin at user scope" },
  plugin_version_skew: { category: "user_action", remedy: "run `review-loop update` (or `brew upgrade review-loop`)" },
  settings_hook_present: { category: "user_action", remedy: "remove the review-loop hook named above from settings.json (`review-loop migrate --rollback` if it came from a legacy install), then re-run" },
  legacy_hooks_present: { category: "user_action", remedy: "run `review-loop migrate`: the old review-loop hooks in settings.json double-gate with the plugin" },
  ask_rules_missing: { category: "user_action", remedy: "run `review-loop setup` to add the approval rules to settings.json" },
  plugin_pin_missing: { category: "user_action", remedy: "run `review-loop setup` to pin the Codex plugin" },
  gh_unavailable: { category: "user_action", remedy: "install and sign in to gh (`brew install gh && gh auth login`) so PR heads are verified and approval marks posted" },
  events_unwritable: { category: "user_action", remedy: "run `review-loop config set events.path <file>`" },
  skill_duplicate: { category: "user_action", remedy: "run `review-loop migrate` to move the old skill at ~/.claude/skills/review-loop/ aside (it duplicates the plugin skill)" },
  // AC-23
  pr_created_head_unreviewed: { category: "user_action", remedy: "re-run the review-loop for this PR before marking it ready", details: ["drafted", "closed", "uncontained"] },
  pr_verify_unavailable: { category: "user_action", remedy: "check the PR's head commit by hand; install and sign in to gh for automatic checks" },
  pr_create_merge_compound: { category: "usage", remedy: "create the PR, let review-loop verify it, then merge in a separate command" },
  pr_merge_unbound: { category: "user_action", remedy: "merge with --match-head-commit <reviewed-sha>" },
  pr_merge_graphql_unsupported: { category: "usage", remedy: "use gh pr merge --match-head-commit" },
  pr_merge_mcp_unbindable: { category: "usage", remedy: "use gh pr merge --match-head-commit" },
  pr_merge_context_unverifiable: { category: "user_action", remedy: "install and sign in to gh, then retry the merge" },
  pr_merge_not_open: { category: "user_action", remedy: "the PR is already merged, closed or a draft: reopen it or mark it ready, then merge" },
  pr_github_api_unsupported_client: { category: "usage", remedy: "use gh (gh pr / gh api) so review-loop can check the call" },
  status_post_failed: { category: "user_action", remedy: "install and sign in to gh so approval marks can be posted" },

  // engine: our own faults
  detection_failed: { category: "internal", remedy: DOCTOR },
  spawn_failed: { category: "internal", remedy: DOCTOR },
  command_failed: { category: "internal", remedy: DOCTOR },
  output_too_large: { category: "internal", remedy: DOCTOR },
  codex_output_invalid: { category: "internal", remedy: DOCTOR },
  unknown_page_reason: { category: "internal", remedy: DOCTOR },
  hook_input_invalid: { category: "internal", remedy: DOCTOR },
  hook_input_too_large: { category: "internal", remedy: DOCTOR },
  hook_input_missing_session: { category: "internal", remedy: DOCTOR },
  lock_lost: { category: "internal", remedy: DOCTOR },
  codex_config_unreadable: { category: "internal", remedy: "check that $CODEX_HOME/config.toml (default ~/.codex/config.toml) is a regular file, not a symlink" },
  open_failed: { category: "internal", remedy: DOCTOR },
  selftest_failed: {
    category: "internal", remedy: "report a bug, naming the failed check (the detail) and the line printed above it",
    details: ["stop_blocks", "pr_gate_denies", "clean_repo_passes", "events_schema_v1", "git_failed", "hook_failed"]
  },
  broker_stop_failed: { category: "internal", remedy: "a Codex app-server broker from a review round may still be running: find it with `ps -ax | grep app-server-broker` and stop it, then report a bug" },
  snapshot_sweep_incomplete: { category: "internal", remedy: "a killed round's snapshot under the state dir's ws/ could not be cleaned up yet; the next round retries. If it repeats, check `ps -ax | grep app-server-broker`, then report a bug" },
  // engine: arguments
  bad_args: { category: "usage", remedy: "run `node \"$(review-loop engine-path)/review-round.mjs\" --help` for the flags" },
  invalid_decision: { category: "usage", remedy: "choose one of the options the page offered" },
  invalid_key: { category: "usage", remedy: "pass a key that `node \"$(review-loop engine-path)/review-round.mjs\" status` prints" },
  unknown_key: { category: "usage", remedy: "run `node \"$(review-loop engine-path)/review-round.mjs\" status` to list the keys this machine knows" },
  invalid_branch_name: { category: "usage", remedy: "pass a real branch name" },
  invalid_remote: { category: "usage", remedy: "pass the name of a configured git remote" },
  pr_via_api_unsupported: { category: "usage", remedy: "create the PR with the GitHub CLI so the review gate can verify it" },
  // engine: state the user or repo can fix
  artifact_outside_root: { category: "user_action", remedy: "keep the artifact inside the repository or ~/.claude/plans" },
  artifact_missing: { category: "user_action", remedy: "check that the artifact path exists" },
  artifact_symlink_rejected: { category: "user_action", remedy: "review the real file, not a symlink" },
  artifact_not_regular_file: { category: "user_action", remedy: "point at a regular file" },
  artifact_too_large: { category: "user_action", remedy: "split the artifact; it is over the size limit" },
  untracked_too_large: { category: "user_action", remedy: "commit or remove the oversized untracked file" },
  plans_scan_limit: { category: "user_action", remedy: "prune old files under ~/.claude/plans" },
  plans_dir_untrusted: { category: "user_action", remedy: "make ~/.claude/plans a real directory you own; any symlink above it (a dotfiles ~/.claude) must be yours" },
  shallow_file_missing: { category: "user_action", remedy: FETCH_FULL },
  shallow_file_invalid: { category: "user_action", remedy: FETCH_FULL },
  shallow_file_symlink: { category: "user_action", remedy: "replace .git/shallow with a regular file, or run `git fetch --unshallow`" },
  shallow_file_too_large: { category: "user_action", remedy: FETCH_FULL },
  git_failed: { category: "user_action", remedy: `run the failing git command by hand to see why, then ${RERUN}` },
  fetch_failed: { category: "user_action", remedy: `check your network and git remote access, then ${RERUN}` },
  unshallow_failed: { category: "user_action", remedy: `check your network and git remote access, then ${RERUN}` },
  history_incomplete: { category: "user_action", remedy: FETCH_FULL },
  history_scan_limit: { category: "user_action", remedy: `the branch history is too long to scan; rebase or squash, then ${RERUN}` },
  merge_base_unavailable: { category: "user_action", remedy: `fetch the base branch, then ${RERUN}` },
  merge_base_ambiguous: { category: "user_action", remedy: "resume the review loop in Claude (the review-loop:review-loop skill) and choose how to merge the base" },
  diff_too_large: { category: "user_action", remedy: "split the change into smaller reviews" },
  command_timeout: { category: "user_action", remedy: `a command timed out; ${RERUN}` },
  codex_failed: { category: "user_action", remedy: `check \`codex\` runs in a terminal (\`review-loop doctor\`), then ${RERUN}` },
  codex_timeout: { category: "user_action", remedy: `Codex took too long; ${RERUN}` },
  plugin_pin_mismatch: { category: "user_action", remedy: "the Codex plugin changed: resume the review loop in Claude (the review-loop:review-loop skill), look at what changed, and approve the repin" },
  companion_usage_mismatch: { category: "user_action", remedy: "update the Codex plugin, then run `review-loop setup`" },
  companion_contract_mismatch: { category: "user_action", remedy: "update the Codex plugin, then run `review-loop setup`" },
  pin_exists: { category: "user_action", remedy: "a pin already exists: to replace it, resume the review loop in Claude (the review-loop:review-loop skill) and approve the repin" },
  decision_stale: { category: "user_action", remedy: `${RERUN} to get a fresh page` },
  override_unverifiable: { category: "user_action", remedy: "make the repo readable (`git status` works), then re-run the override" },
  base_moved: { category: "user_action", remedy: `the base branch moved; ${RERUN}` },
  head_moved: { category: "user_action", remedy: `HEAD moved during the round; ${RERUN}` },
  branch_marker_missing: { category: "user_action", remedy: "run the PR creation command again so review-loop records the branch" },
  head_not_on_github: { category: "user_action", remedy: "push the branch, then retry" },
  head_unverifiable: { category: "user_action", remedy: "check that gh is signed in, then retry" },
  pr_args_unresolvable: { category: "user_action", remedy: "run PR creation from inside the repository" },
  gh_not_installed: { category: "user_action", remedy: "install gh (https://cli.github.com) and sign in, or pass --repo" },
  pr_base_repo_ambiguous: { category: "user_action", remedy: "pass --repo so the base repository is unambiguous" },
  pr_head_repo_ambiguous: { category: "user_action", remedy: "pass --head owner:branch so the head repository is unambiguous" },
  pr_base_unverifiable: { category: "user_action", remedy: "check gh is signed in and the base branch exists on GitHub, then retry" },
  pr_head_unverifiable: { category: "user_action", remedy: "check gh is signed in and the head branch exists on GitHub, then retry" },
  pr_head_mismatch: { category: "user_action", remedy: "push the reviewed commit, then retry" },
  pr_head_not_pushed: { category: "user_action", remedy: "push the branch so GitHub matches the reviewed HEAD, then retry" },
  push_comparison_changed: { category: "user_action", remedy: `the PR base moved; ${RERUN} before pushing` },
  push_destination_mismatch: { category: "user_action", remedy: `the remote no longer matches the review; ${RERUN}` },
  push_not_reviewed: { category: "user_action", remedy: "HEAD has not passed review; run the loop first" },
  push_target_protected: { category: "user_action", remedy: "push to a feature branch, not a protected one" },
  repo_lookup_failed: { category: "user_action", remedy: "check that gh is signed in and the repository exists, then retry" },
  review_pending: { category: "user_action", remedy: "let Claude finish the pending review (the review-loop:review-loop skill), then retry" },
  rubric_source_mismatch: { category: "user_action", remedy: "restore the rubric file, or point rubricPath at a different one" },
  rubric_source_missing: { category: "user_action", remedy: "restore the rubric file, or point rubricPath at a different one" },
  state_dir_insecure: { category: "user_action", remedy: "a state or repo path is not readable/writable by you, is owned by someone else, or is group/world-accessible: make the review-loop state directory yours with mode 700 (`chmod 700`) and repo paths accessible, then re-run" },
  state_missing: { category: "user_action", remedy: "run `review-loop setup`" },
  state_symlink_rejected: { category: "user_action", remedy: "replace the linked path in the state directory with a real directory" },
  too_large: { category: "user_action", remedy: "remove the oversized lock file from the state directory" },
  not_regular_file: { category: "user_action", remedy: "remove the non-file lock entry from the state directory" },
  // engine: reasons a round pauses for the human
  checkpoint: { category: "user_action", remedy: "answer Claude's question; to see it again, resume the review loop in Claude (the review-loop:review-loop skill)" },
  stall: { category: "user_action", remedy: "answer Claude's question; to see it again, resume the review loop in Claude (the review-loop:review-loop skill)" },
  dispute_deadlock: { category: "user_action", remedy: "decide the disputed finding when Claude asks; to see the question again, resume the review loop in Claude (the review-loop:review-loop skill)" },
  criss_cross: { category: "user_action", remedy: `merge the base into the branch, then ${RERUN}` },
  push_rejected: { category: "user_action", remedy: `pull the remote changes, then ${RERUN}` },
  head_diverged: { category: "user_action", remedy: `pull the remote changes or merge, then ${RERUN}` },
  plugin_pin: { category: "user_action", remedy: "look at what changed in the Codex plugin and approve the repin when Claude asks; to see the question again, resume the review loop in Claude (the review-loop:review-loop skill)" },
  busy: { category: "user_action", remedy: "another review is running for this artifact; wait for it to finish" },
  interrupted: { category: "cancelled", remedy: `${RERUN} when ready` }
});

/** Per-event data fields: each validator returns the value or null (spec §8.2). */
const oneOf = (/** @type {readonly string[]} */ list) => (/** @type {unknown} */ v) => (typeof v === "string" && list.includes(v) ? v : null);
const int = (/** @type {number} */ min, /** @type {number} */ max) => (/** @type {unknown} */ v) => (Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max ? v : null);
const num = (/** @type {number} */ min, /** @type {number} */ max) => (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
const bool = (/** @type {unknown} */ v) => (typeof v === "boolean" ? v : null);
const token = (/** @type {unknown} */ v) => (typeof v === "string" && /^[A-Za-z0-9._:/-]{1,64}$/.test(v) && !v.startsWith("/") ? v : null);

export const GATES = Object.freeze(["stop", "pr", "prompt", "prverify", "merge"]);
export const OUTCOMES = Object.freeze(["blocked", "warned", "denied", "allowed", "skipped"]);
export const STAGES = Object.freeze(["detection_failed", "snapshot_degraded", "hook_input_error", "hook_error", "prune_failed", "summary_write_failed", "lock_invalid", "status_post_failed", "broker_stop_failed", "session", "track", "prompt", "stop", "pr", "prverify"]);
export const COMMANDS_ENUM = Object.freeze(["setup", "config", "doctor", "update", "uninstall", "migrate", "selftest", "engine-path", "version", "help"]);
export const KINDS = Object.freeze(["spec", "plan", "impl", "pr"]);
export const DECISION_OPTIONS = Object.freeze(["continue", "more", "accept", "stop", "accept-finding", "waive", "repin", "override", "merge", "pull"]);
export const PAUSE_REASONS = Object.freeze(["checkpoint", "stall", "dispute_deadlock", "criss_cross", "push_rejected", "head_diverged", "plugin_pin"]);

/** @param {unknown} v */
function dimsOf(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const rec = /** @type {Record<string, unknown>} */ (v);
  /** @type {Record<string, number>} */
  const out = {};
  for (const d of DIMENSIONS) {
    const x = rec[d];
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 10) return null;
    out[d] = x;
  }
  return Object.keys(rec).length === DIMENSIONS.length ? out : null;
}

/** @type {Readonly<Record<string, { sources: readonly string[], data: Readonly<Record<string, (v: unknown) => unknown>> }>>} */
export const EVENT_CATALOG = Object.freeze({
  "cli.exit": { sources: ["cli"], data: { command: oneOf(COMMANDS_ENUM), duration_ms: int(0, 86_400_000) } },
  "gate.decision": { sources: ["hook"], data: { gate: oneOf(GATES), outcome: oneOf(OUTCOMES), preset: oneOf(PRESET_NAMES), pending_count: int(0, 10_000) } },
  "round.result": {
    sources: ["round"],
    data: {
      kind: oneOf(KINDS), round: int(0, 10_000), pass: bool, mean: num(0, 10), dims: dimsOf, model: token, effort: token,
      effort_source: oneOf(["config", "codex-inherited"]), preset: oneOf(PRESET_NAMES), duration_ms: int(0, 86_400_000)
    }
  },
  "round.decision": { sources: ["round"], data: { kind: oneOf(KINDS), option: oneOf(DECISION_OPTIONS), reason: oneOf(PAUSE_REASONS) } },
  "round.dispute": { sources: ["round"], data: { kind: oneOf(KINDS) } },
  "round.push": { sources: ["round"], data: {} },
  "round.sweep": { sources: ["round"], data: { swept: int(0, 10_000), brokers_left: int(0, 10_000), failed: int(0, 10_000) } },
  "hook.error": { sources: ["hook", "round", "cli"], data: { stage: oneOf(STAGES), mode: oneOf(STAGES) } },
  "config.invalid": { sources: ["hook", "cli", "round"], data: {} },
  override: { sources: ["hook", "round", "cli"], data: { kind: oneOf(["branch", "artifact"]), action: oneOf(["kill_switch", "kill_switch_ignored", "manual", "skip_review"]) } },
  event_unregistered: { sources: ["cli", "hook", "round"], data: {} }
});

/** @param {string} code @returns {Category} */
export function categoryOf(code) {
  return Object.hasOwn(CODES, code) ? CODES[code].category : "internal";
}
/** @param {string} code */
export function exitFor(code) {
  return CLI_EXIT[categoryOf(code)];
}
/** The detail's own remedy when the code has one for it, else the code's. @param {string} code @param {string | null} [detail] */
export function remedyFor(code, detail = null) {
  if (!Object.hasOwn(CODES, code)) return DOCTOR;
  const per = CODES[code].detailRemedies;
  return detail !== null && per && Object.hasOwn(per, detail) ? per[detail] : CODES[code].remedy;
}
