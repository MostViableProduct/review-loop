# Troubleshooting

Start with `review-loop doctor`. It checks the install, changes nothing, and prints the command that fixes each
problem it finds. Every error review-loop prints has the same shape:

    review-loop: <what happened>
    review-loop: <code> — <what to do>

Find the code below for more detail. If a fix says "report a bug", open an issue at
https://github.com/MostViableProduct/review-loop/issues with the code and the line printed above it.

## Every code and its fix

<!-- troubleshooting:start -->
| Code | Exit | What to do | Details |
|---|---|---|---|
| `artifact_missing` | 1 | check that the artifact path exists |  |
| `artifact_not_regular_file` | 1 | point at a regular file |  |
| `artifact_outside_root` | 1 | keep the artifact inside the repository or ~/.claude/plans |  |
| `artifact_symlink_rejected` | 1 | review the real file, not a symlink |  |
| `artifact_too_large` | 1 | split the artifact; it is over the size limit |  |
| `ask_rules_missing` | 1 | run `review-loop setup` to add the approval rules to settings.json |  |
| `bad_args` | 2 | run `node "$(review-loop engine-path)/review-round.mjs" --help` for the flags |  |
| `base_moved` | 1 | the base branch moved; re-run the review round |  |
| `branch_marker_missing` | 1 | run the PR creation command again so review-loop records the branch |  |
| `broker_stop_failed` | 4 | a Codex app-server broker from a review round may still be running: find it with `ps -ax \| grep app-server-broker` and stop it, then report a bug |  |
| `busy` | 1 | another review is running for this artifact; wait for it to finish, or follow the message if it names a stuck process or a marker file |  |
| `cancelled` | 3 | re-run the command when ready; completed steps are kept |  |
| `checkpoint` | 1 | answer Claude's question; to see it again, resume the review loop in Claude (the review-loop:review-loop skill) |  |
| `claude_cli_unparseable` | 1 | update Claude Code (`claude update`), then re-run |  |
| `claude_parent_process` | 1 | run this in a separate terminal, not from inside Claude Code |  |
| `claude_running` | 1 | quit all Claude Code sessions, then re-run |  |
| `cli_busy` | 1 | another review-loop command is running, or a stuck one is holding the CLI lock: follow the line above |  |
| `codex_config_unreadable` | 4 | check that $CODEX_HOME/config.toml (default ~/.codex/config.toml) is a regular file, not a symlink |  |
| `codex_failed` | 1 | check `codex` runs in a terminal (`review-loop doctor`), then re-run the review round |  |
| `codex_output_invalid` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `codex_timeout` | 1 | Codex took too long; re-run the review round |  |
| `command_failed` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `command_timeout` | 1 | a command timed out; re-run the review round |  |
| `companion_contract_mismatch` | 1 | update the Codex plugin, then run `review-loop setup` |  |
| `companion_usage_mismatch` | 1 | update the Codex plugin, then run `review-loop setup` |  |
| `config_dir_untrusted` | 1 | make the folder holding the review-loop config (~/.config/review-loop) a real directory you own; any symlink above it (a dotfiles ~/.config) must be yours |  |
| `config_insecure` | 1 | the review-loop config file is owned by another user or is not a regular file: remove it or take ownership, then re-run `review-loop setup` |  |
| `config_invalid` | 1 | run `review-loop config repair` |  |
| `config_missing` | 1 | run `review-loop setup` to create the config |  |
| `config_symlink_rejected` | 1 | replace the symlink with a regular file, or remove it (defaults apply) and run `review-loop config repair` or `review-loop setup` |  |
| `criss_cross` | 1 | merge the base into the branch, then re-run the review round |  |
| `decision_stale` | 1 | re-run the review round to get a fresh page |  |
| `detection_failed` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `diff_too_large` | 1 | split the change into smaller reviews |  |
| `dispute_deadlock` | 1 | decide the disputed finding when Claude asks; to see the question again, resume the review loop in Claude (the review-loop:review-loop skill) |  |
| `doctor_failed` | 1 | fix each check marked FAIL (each prints its fix), then re-run |  |
| `events_path_rejected` | 1 | choose an events path that is a regular file you own (or does not exist yet) in a real directory you own; symlinks, directories and missing parents are refused |  |
| `events_unwritable` | 1 | run `review-loop config set events.path <file>` |  |
| `fetch_failed` | 1 | check your network and git remote access, then re-run the review round |  |
| `gh_not_installed` | 1 | install gh (https://cli.github.com) and sign in, or pass --repo |  |
| `gh_unavailable` | 1 | install and sign in to gh (`brew install gh && gh auth login`) so PR heads are verified and approval marks posted |  |
| `git_failed` | 1 | run the failing git command by hand to see why, then re-run the review round |  |
| `head_diverged` | 1 | pull the remote changes or merge, then re-run the review round |  |
| `head_moved` | 1 | HEAD moved during the round; re-run the review round |  |
| `head_not_on_github` | 1 | push the branch, then retry |  |
| `head_unverifiable` | 1 | check that gh is signed in, then retry |  |
| `history_incomplete` | 1 | run `git fetch --unshallow`, then re-run the review round |  |
| `history_scan_limit` | 1 | the branch history is too long to scan; rebase or squash, then re-run the review round |  |
| `hook_input_invalid` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `hook_input_missing_session` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `hook_input_too_large` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `interrupted` | 3 | re-run the review round when ready |  |
| `invalid_branch_name` | 2 | pass a real branch name |  |
| `invalid_decision` | 2 | choose one of the options the page offered |  |
| `invalid_key` | 2 | pass a key that `node "$(review-loop engine-path)/review-round.mjs" status` prints |  |
| `invalid_remote` | 2 | pass the name of a configured git remote |  |
| `legacy_hooks_present` | 1 | run `review-loop migrate`: the old review-loop hooks in settings.json double-gate with the plugin |  |
| `legacy_pin_invalid` | 1 | run `review-loop setup` to pin the Codex plugin again; the old pin file was left where it was |  |
| `live_check_failed` | 1 | run the fix for the detail: the CLI prints it, and the live-check table below lists each | `codex_missing`, `codex_auth`, `plugin_missing`, `git_failed`, `pin_mismatch`, `model_invalid`, `effort_invalid`, `timeout`, `unparseable`, `unknown` |
| `lock_identity_unavailable` | 1 | check that `/bin/ps -p $$` runs in a terminal, then retry |  |
| `lock_lost` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `lock_marker_cleanup_failed` | 4 | the state directory refused a delete; check its permissions (`review-loop doctor`) |  |
| `merge_base_ambiguous` | 1 | resume the review loop in Claude (the review-loop:review-loop skill) and choose how to merge the base |  |
| `merge_base_unavailable` | 1 | fetch the base branch, then re-run the review round |  |
| `migration_archive_occupied` | 1 | move the named archive folder aside, then re-run `review-loop migrate` (to undo the earlier migration instead, run `review-loop migrate --rollback`) |  |
| `migration_config_dir_mismatch` | 1 | re-run with CLAUDE_CONFIG_DIR set to the Claude config dir named above, the one in use when you migrated |  |
| `migration_manifest_invalid` | 1 | restore by hand from ~/.claude/review-loop-legacy-&lt;date&gt;/ and the settings backups; the damaged record was kept as migration.json.corrupt-&lt;ts&gt; |  |
| `migration_manifest_unreadable` | 1 | check that you own ~/.claude/state/review-loop/migration.json and can read it, then re-run |  |
| `migration_record_full` | 1 | run `review-loop migrate --rollback` to close the current migration record, then re-run `review-loop migrate` |  |
| `node_missing` | 1 | brew install node |  |
| `node_too_old` | 2 | brew upgrade node |  |
| `not_regular_file` | 1 | remove the non-file lock entry from the state directory |  |
| `open_failed` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `output_too_large` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `override_unverifiable` | 1 | make the repo readable (`git status` works), then re-run the override |  |
| `pin_exists` | 1 | a pin already exists: to replace it, resume the review loop in Claude (the review-loop:review-loop skill) and approve the repin |  |
| `plans_dir_untrusted` | 1 | make ~/.claude/plans a real directory you own; any symlink above it (a dotfiles ~/.claude) must be yours |  |
| `plans_scan_limit` | 1 | prune old files under ~/.claude/plans |  |
| `plugin_disabled` | 1 | enable it with `claude plugin enable review-loop@review-loop`, then run migrate again |  |
| `plugin_install_failed` | 1 | run `review-loop doctor` |  |
| `plugin_not_installed` | 1 | run `review-loop setup` to install and enable the review-loop plugin at user scope |  |
| `plugin_other_scope` | 1 | uninstall the project- or local-scope review-loop plugin in that project, then re-run |  |
| `plugin_pin` | 1 | look at what changed in the Codex plugin and approve the repin when Claude asks; to see the question again, resume the review loop in Claude (the review-loop:review-loop skill) |  |
| `plugin_pin_mismatch` | 1 | the Codex plugin changed: resume the review loop in Claude (the review-loop:review-loop skill), look at what changed, and approve the repin |  |
| `plugin_pin_missing` | 1 | run `review-loop setup` to pin the Codex plugin |  |
| `plugin_uninstall_failed` | 1 | run `claude plugin uninstall review-loop@review-loop` (and `claude plugin marketplace remove review-loop`) in a terminal to see why, then re-run `review-loop uninstall` |  |
| `plugin_version_skew` | 1 | run `review-loop update` (or `brew upgrade review-loop`) |  |
| `pr_args_unresolvable` | 1 | run PR creation from inside the repository |  |
| `pr_base_repo_ambiguous` | 1 | pass --repo so the base repository is unambiguous |  |
| `pr_base_unverifiable` | 1 | check gh is signed in and the base branch exists on GitHub, then retry |  |
| `pr_create_merge_compound` | 2 | create the PR, let review-loop verify it, then merge in a separate command |  |
| `pr_created_head_unreviewed` | 1 | re-run the review-loop for this PR before marking it ready | `drafted`, `closed`, `uncontained` |
| `pr_github_api_unsupported_client` | 2 | use gh (gh pr / gh api) so review-loop can check the call |  |
| `pr_head_mismatch` | 1 | push the reviewed commit, then retry |  |
| `pr_head_not_pushed` | 1 | push the branch so GitHub matches the reviewed HEAD, then retry |  |
| `pr_head_repo_ambiguous` | 1 | pass --head owner:branch so the head repository is unambiguous |  |
| `pr_head_unverifiable` | 1 | check gh is signed in and the head branch exists on GitHub, then retry |  |
| `pr_merge_context_unverifiable` | 1 | install and sign in to gh, then retry the merge |  |
| `pr_merge_graphql_unsupported` | 2 | use gh pr merge --match-head-commit |  |
| `pr_merge_mcp_unbindable` | 2 | use gh pr merge --match-head-commit |  |
| `pr_merge_not_open` | 1 | the PR is already merged, closed or a draft: reopen it or mark it ready, then merge |  |
| `pr_merge_unbound` | 1 | merge with --match-head-commit &lt;reviewed-sha&gt; |  |
| `pr_verify_unavailable` | 1 | check the PR's head commit by hand; install and sign in to gh for automatic checks |  |
| `pr_via_api_unsupported` | 2 | create the PR with the GitHub CLI so the review gate can verify it |  |
| `preflight_failed` | 1 | fix the item marked FAIL, then re-run | `claude`, `codex_cli`, `codex_auth`, `codex_plugin` |
| `push_comparison_changed` | 1 | the PR base moved; re-run the review round before pushing |  |
| `push_destination_mismatch` | 1 | the remote no longer matches the review; re-run the review round |  |
| `push_not_reviewed` | 1 | HEAD has not passed review; run the loop first |  |
| `push_rejected` | 1 | pull the remote changes, then re-run the review round |  |
| `push_target_protected` | 1 | push to a feature branch, not a protected one |  |
| `repo_lookup_failed` | 1 | check that gh is signed in and the repository exists, then retry |  |
| `review_pending` | 1 | let Claude finish the pending review (the review-loop:review-loop skill), then retry |  |
| `rollback_skipped_modified` | 1 | the named file changed after migration; clear it and run `review-loop migrate --rollback` again to finish, or restore it by hand from the backup |  |
| `rubric_source_mismatch` | 1 | restore the rubric file, or point rubricPath at a different one |  |
| `rubric_source_missing` | 1 | restore the rubric file, or point rubricPath at a different one |  |
| `rubric_symlink_rejected` | 1 | point rubricPath at the real file (`review-loop config set rubric <path>`) |  |
| `selftest_failed` | 4 | report a bug, naming the failed check (the detail) and the line printed above it | `stop_blocks`, `pr_gate_denies`, `clean_repo_passes`, `events_schema_v1`, `git_failed`, `hook_failed` |
| `settings_concurrent_write` | 1 | close other programs editing settings.json, then re-run |  |
| `settings_detached_write` | 1 | compare the reported backup with settings.json and copy over any change you need |  |
| `settings_hook_present` | 1 | remove the review-loop hook named above from settings.json (`review-loop migrate --rollback` if it came from a legacy install), then re-run |  |
| `settings_invalid_json` | 1 | open ~/.claude/settings.json and correct the JSON; nothing was changed |  |
| `settings_legacy_hook_unrecognized` | 1 | the command must be exactly `node <your Claude config dir>/review-loop/review-gate-hook.mjs <mode>`, alone in its hook group: rewrite the named hook in that form or remove it by hand, then re-run |  |
| `settings_mixed_hook_group` | 1 | move the review-loop hook into its own hook group in settings.json, then re-run |  |
| `settings_open_elsewhere` | 1 | close the editor or sync tool that has settings.json open, then re-run |  |
| `settings_target_insecure` | 1 | make ~/.claude/settings.json a regular file you own |  |
| `settings_tmp_leftover` | 1 | delete the leftover review-loop temp file next to settings.json; settings.json itself is intact |  |
| `settings_too_large` | 1 | settings.json is over 1 MiB, which is not a normal Claude Code settings file; check it by hand |  |
| `settings_writer_check_failed` | 1 | make sure `ps` and `lsof` on your PATH (/bin/ps and /usr/sbin/lsof on macOS) run for your user, then re-run |  |
| `setup_complete_unverified` | 0 | run `review-loop doctor --live` to verify |  |
| `shallow_file_invalid` | 1 | run `git fetch --unshallow`, then re-run the review round |  |
| `shallow_file_missing` | 1 | run `git fetch --unshallow`, then re-run the review round |  |
| `shallow_file_symlink` | 1 | replace .git/shallow with a regular file, or run `git fetch --unshallow` |  |
| `shallow_file_too_large` | 1 | run `git fetch --unshallow`, then re-run the review round |  |
| `skill_duplicate` | 1 | run `review-loop migrate` to move the old skill at ~/.claude/skills/review-loop/ aside (it duplicates the plugin skill) |  |
| `snapshot_sweep_incomplete` | 4 | a killed round's snapshot under the state dir's ws/ could not be cleaned up yet; the next round retries. If it repeats, check `ps -ax \| grep app-server-broker`, then report a bug |  |
| `spawn_failed` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `stall` | 1 | answer Claude's question; to see it again, resume the review loop in Claude (the review-loop:review-loop skill) |  |
| `state_dir_insecure` | 1 | a state or repo path is not readable/writable by you, is owned by someone else, or is group/world-accessible: make the review-loop state directory yours with mode 700 (`chmod 700`) and repo paths accessible, then re-run |  |
| `state_missing` | 1 | run `review-loop setup` |  |
| `state_symlink_rejected` | 1 | replace the linked path in the state directory with a real directory |  |
| `status_post_failed` | 1 | install and sign in to gh so approval marks can be posted |  |
| `too_large` | 1 | remove the oversized lock file from the state directory |  |
| `tool_failed` | 1 | the named tool timed out or could not run; check it works in a terminal, then re-run | `missing`, `timeout`, `output_too_large`, `spawn_failed` |
| `unexpected_error` | 4 | run `review-loop doctor`; if it persists, report a bug | `Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `SystemError`, `module_not_found`, `other` |
| `unknown_key` | 2 | run `node "$(review-loop engine-path)/review-round.mjs" status` to list the keys this machine knows |  |
| `unknown_page_reason` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `unregistered_code` | 4 | run `review-loop doctor`; if it persists, report a bug |  |
| `unshallow_failed` | 1 | check your network and git remote access, then re-run the review round |  |
| `untracked_too_large` | 1 | commit or remove the oversized untracked file |  |
| `usage_bad_flag` | 2 | run `review-loop <command> --help` |  |
| `usage_noninteractive` | 2 | re-run with --yes, or run it in a terminal |  |
| `usage_unknown_command` | 2 | run `review-loop --help` |  |
<!-- troubleshooting:end -->

## A failed live check

`setup` and `doctor --live` run one real review. When it fails, the error names a detail, and each detail has one
fix:

<!-- live-check:start -->
| Code | Detail | What to do |
|---|---|---|
| `live_check_failed` | `codex_missing` | brew install --cask codex |
| `live_check_failed` | `codex_auth` | codex login |
| `live_check_failed` | `plugin_missing` | review-loop setup |
| `live_check_failed` | `git_failed` | check that `git init` works in a terminal, then re-run `review-loop doctor --live` |
| `live_check_failed` | `pin_mismatch` | review-loop setup   (without --yes: its pin step shows what changed) |
| `live_check_failed` | `model_invalid` | review-loop config set model &lt;valid&gt; |
| `live_check_failed` | `effort_invalid` | review-loop config set effort &lt;valid&gt; |
| `live_check_failed` | `timeout` | retry, and check your network or VPN |
| `live_check_failed` | `unparseable` | report a bug, with the output above |
| `live_check_failed` | `unknown` | report a bug, with the output above |
<!-- live-check:end -->

## Not in the tables

- **A review or command stays `busy` long after nothing should be running.** The message tells you what is holding
  it. If it names a review-loop process (`ps -p <pid>` shows it), that process is stuck: end it, and the lock frees
  itself. If it says a marker file "can't be read, so its owner is unverified", check `ps -p <pid>` first: if that
  isn't a review-loop process, delete the one file it names and retry. Don't end a process you can't identify.
- **A settings change was lost during setup.** Your editor or sync tool still has it; save it again.
- **`doctor` says the plugin is installed at the wrong scope.** It prints
  `claude plugin install review-loop@review-loop --scope user`. Claude Code accepts `--scope` there, but
  `claude plugin install --help` does not list it; `review-loop setup` and `doctor` handle it for you.

## For scripts

Every command takes `--json` and `--yes`. `review-loop <command> --help` lists each command's own options; a
command refuses any other flag (exit 2, `usage_bad_flag`) before it does anything.

- `--yes` answers every question with its default. `setup --yes` also runs the billed live check; add
  `--skip-live-check` to avoid it. `uninstall --yes` keeps your review history unless you add `--delete-history`.
- `--json` prints exactly one JSON line on stdout: the command's `cli.exit` event, or, for a command with a
  payload (`doctor`, `selftest`, `engine-path`, `config show`), that payload object with the event embedded
  under `event`. Human text goes to stderr; `--version` and `--help` print to stdout when `--json` is not given.

### Exit codes

<!-- exit-codes:start -->
| Exit | Category | Meaning |
|---|---|---|
| 0 | `ok` | success |
| 1 | `user_action` | needs your action (see the troubleshooting table) |
| 2 | `usage` | wrong command or flag |
| 3 | `cancelled` | you cancelled (Ctrl-C or answered no) |
| 4 | `internal` | internal error — please report a bug |
<!-- exit-codes:end -->
