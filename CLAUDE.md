# review-loop

Enforced Codex adversarial review inside Claude Code, packaged as a Homebrew CLI plus a Claude Code plugin.

## Stack

- Node >= 22, ESM, no dependencies, tests on `node:test`.
- A Claude Code plugin (`plugin/`: engine, hooks, skill, rubric) plus a CLI (`cli/`).
- A Homebrew tap lives in a separate repo (staged under `homebrew-tap/`, pushed in Task 28).
- Test baseline at Task 1: 186 engine tests, plus the no-`any` contract tests.
- Engine tests use `test/fixtures/fake-codex-plugin` as a source fixture and copy it into temp dirs that they point `REVIEW_LOOP_PLUGIN_BASE` at, so `npm test` needs no installed Codex plugin.

## Layout

| Path | Responsibility | Task |
|---|---|---|
| `package.json` | `name`, `version`, `type:"module"`, `engines.node >=22`, `scripts` (test, sabotage, docs:check, content-gate, e2e), `bin` | 1 |
| `LICENSE` | MIT, copyright holder from D7 (default: the git `user.name`) | 1 |
| `CLAUDE.md`, `AGENTS.md -> CLAUDE.md` | stack, invariants and probe results (repo-local, generic) | 1 (then every task) |
| `.claude-plugin/marketplace.json` | marketplace `review-loop` → `./plugin` | 11 |
| `plugin/.claude-plugin/plugin.json` | plugin manifest and version; no `dependencies` (R-P4: setup installs `codex@openai-codex` explicitly) | 11 |
| `plugin/hooks/hooks.json` | 9 hook entries (§3.1, T-SHAPE-1) | 11 |
| `plugin/bin/hook` | POSIX sh shim (§6.3) | 11 |
| `plugin/engine/review-round.mjs`, `review-gate-hook.mjs`, `lib/*.mjs` | the engine (moved in Task 1) | 1, 6–14 |
| `plugin/engine/lib/config.mjs` | `configPath`, `isConfig`, `readConfig`, `writeConfig`, `DEFAULT_CONFIG` | 6 |
| `plugin/engine/lib/codes.mjs` | code registry, `EVENT_CATALOG`, `CLI_EXIT` | 7 |
| `plugin/engine/lib/events.mjs` | `emitEvent(input)` (= `writeEvent(buildEvent(input))`), `buildEvent`, `writeEvent`, `eventsPath`, `eventsPathProblem`, `stateDirProblem`, `validateLine`, `maxLineBytes`, `PACKAGE_VERSION`: the schema-v1 writer (replaces `appendEvent`); the two `*Problem` predicates are the writer's own rules, shared with `config set` and doctor | 7, 19, 20 |
| `plugin/engine/lib/paths.mjs` | `stateRoot`, `stateSubdir` (re-exported by `state.mjs`), `claudeConfigDir` (`CLAUDE_CONFIG_DIR` or `~/.claude`; used by `pin.mjs`, `settings.mjs`, doctor) | 7, 20 |
| `scripts/list-codes.mjs` | `listCodes(root)`: every code literal the source can emit; T-OBS-3 uses it | 7 |
| `plugin/engine/lib/presets.mjs` | `PRESETS`, `gateOutcome` | 8 |
| `plugin/engine/lib/prverify.mjs` | post-create verification (§7.1 (1)) | 12 |
| `plugin/engine/lib/merge.mjs`, `mcp-merge.json` | merge gate `evaluateMergeGate`, `MCP_HEAD_FIELD` (§7.1 (3)); the classifier `mentionsMerge`/`parseMerge` lives in `cmdparse.mjs` | 13 |
| `plugin/engine/lib/status.mjs` | commit-status posting and the policy fingerprint (§7.1 (2)) | 14 |
| `plugin/rubric/default.md` | generic rubric (the Dimension definitions section only) | 9 |
| `plugin/skills/review-loop/SKILL.md` | skill (namespaced `review-loop:review-loop`) | 11 |
| `cli/review-loop.mjs` | entry point and the `COMMANDS` table | 15 |
| `cli/lib/io.mjs` | prompts, TTY/NO_COLOR output, OK/FAIL/WARN words | 15 |
| `cli/lib/run.mjs` | `runTool(cmd,args)` wrapper plus last-JSON-line parsing | 17 |
| `cli/lib/settings.mjs` | §6.2 read-modify-write and commit | 16 |
| `cli/lib/preflight.mjs` | the five preflight items | 17 |
| `cli/lib/setup.mjs`, `livecheck.mjs` | setup steps 1–8 and the live check | 18 |
| `cli/lib/doctor.mjs` | `DOCTOR_CHECKS` (the only check list; T-DOC-1 needs a failing fixture per id), `run`, `nodeForHooks`. Read-only: every check reuses the helper the CLI/engine uses (`PREFLIGHT`, `installedPlugin`, settings' `missingAskRules`/`legacyHookCommands`/`modifiedBackups`/`leftoverTemps`, `readConfig` + `assertConfigOwner`, `loadRubricSection`, `readPin`/`verifyPin` with `readOnly`, `stateDirProblem`, `eventsPathProblem`, `liveCheck` + `LIVE_REMEDY`) | 20 |
| `cli/lib/uninstall.mjs`, `update.mjs` | §6.6 and the update command; plugin removal is `plugin.mjs`'s `uninstallPlugin`/`removeMarketplace`, shared with `migrate --rollback` | 21, 22 |
| `cli/lib/migrate.mjs` | §14 and the rollback: the manifest `<stateRoot>/migration.json` (`isManifest`, the one hook predicate `isRemovedHook` for what migrate removes and rollback restores), every path derived by `paths(date)`, never read from the manifest | 22 |
| `cli/lib/selftest.mjs` | §10.4 | 23 |
| `cli/fixtures/livecheck-doc.md` | the fixture doc the live check reviews | 18 |
| `test/engine/*.test.mjs` | moved engine tests | 1 |
| `test/cli/*.test.mjs`, `test/contract/*.test.mjs`, `test/fakes/` | new tests and fake executables | 15+ |
| `scripts/content-gate.mjs`, `package.files.json` | §10.2 | 24 |
| `scripts/gen-readme-tables.mjs` | the generated tables in `docs/TROUBLESHOOTING.md`, from the registry | 24 |
| `scripts/sabotage.mjs`, `scripts/sabotage-registry.mjs` | applies each sabotage from §11 and asserts red; the registry of breaks | 25 |
| `scripts/probes/*.sh`, `docs/probes/*.md` | P1–P7 | 2–5 |
| `.github/workflows/ci.yml`, `sabotage.yml`, `release.yml` | §10.3 | 25, 26 |
| `scripts/bump-version.mjs`, `scripts/release-check.mjs`, `scripts/tap-formula.mjs` | version stamping (4 places), the tag-equality check, and the tap formula for a release (template + archive url/sha256; refuses a placeholder or malformed sha256) | 26 |
| `test/e2e/live.test.mjs`, `isolation.mjs` | the opt-in paid live e2e (`npm run e2e`); its config-dir guard and child env, tested free by `isolation.test.mjs` | 27 |
| `docs/RELEASE.md`, `docs/allowed_signers` | release checklist and the release key that verifies tags | 24, 26 |
| `README.md`, `docs/TROUBLESHOOTING.md`, `docs/SECURITY.md`, `docs/EVENTS.md`, `CONTRIBUTING.md` | user docs, split by reader: first-time user (README), every code and script use, the gate's limits, the log pipeline, contributors. `readme.test.mjs` pins each statement in the file that holds it, and checks every relative link and `#anchor` | 24, 26 |
| `homebrew-tap/Formula/review-loop.rb`, `homebrew-tap/.github/workflows/tests.yml`, `homebrew-tap/README.md`, `homebrew-tap/.github/dependabot.yml` | the formula template (its all-zero sha256 never reaches the tap: Task 28 pushes the tap WITHOUT `Formula/`, and the first release adds it) and tap CI, staged here and pushed as its own repo in Task 28; never packaged (not in `package.files.json`; a content-gate test fails if it ever is) | 26, 28 |
| `.github/dependabot.yml` | weekly `github-actions` pin bumps (same file in the tap) | 26 |

## Invariants

These are copied from the spec, and every task implicitly includes them.

- **Platform:** macOS 14+, arm64 and x86_64. **Node:** `compat.minNode = 22`, and the CLI refuses to
  run on an older Node with exit 2 `node_too_old`.
- **No new dependencies.** Node built-ins only; `package.json` has no `dependencies` and no
  `devDependencies`. A native helper is explicitly out (deferred §15 #12).
- **No `any`** in JSDoc types; use `unknown` plus narrowing.
- **No comments explaining obvious code.** Comment only a gotcha or a *why*.
- **Never write under `$CODEX_HOME` (default `~/.codex`).** Read `config.toml` only, with lstat, a
  regular-file check and a 256 KiB cap.
- **Homebrew never touches `~/.claude` or `~/.codex`.** The formula has no `post_install`.
- **CLI exit codes:** `0` ok, `1` user_action, `2` usage, `3` cancelled, `4` internal. The engine's
  `review-round.mjs` codes are unchanged (`EXIT` in `lib/policy.mjs`).
- **Events:**
  - schema `review-loop.event/1`;
  - no paths, content, emails or env values;
  - enums validated by value;
  - lines ≤ 4 KiB by construction;
  - rotation at 5 MiB to `.1`;
  - file 0600 and dir 0700;
  - a failed event write never changes a decision.
- **Presets:** `default | balanced | advisory`. The bar is identical in all of them (mean ≥ 9.2 and
  every dimension ≥ 9.2, first checkpoint at 10 rounds). The gate matrix is §5.2 plus §7.1.
- **Advisory never blocks:** no `decision:block`, `deny` or `continue:false` in any gate.
  This includes the PR gate's parse/argument errors and unreadable-input failures: under `advisory` they warn (`systemMessage`, R-D12). Under `default` and `balanced` they stay `deny` (fail closed).
- **One `gate.decision` per gate evaluation**, emitted by `review-gate-hook.mjs` only (never by `prgate.mjs`). A non-PR Bash command emits none.
  A Stop or prompt hook crash emits `hook.error` only, with no `gate.decision`, because the gate did not evaluate. Under a kill switch, Stop, prompt and PR log outcome `skipped` with code `kill_switch`. The prompt hook resolves the kill switch only when something is pending (nothing pending logs `allowed`), so an idle prompt spends no git call. `pending_count` on a PR decision is 1 whenever the gate flagged the attempt (denied or warned) and 0 for an allow. The `pr` hook mode dispatches a merge (Bash or `mcp__*__merge_pull_request`), including a create+merge compound, to the merge gate alone (`gate:"merge"`); a Bash command the merge classifier returns `not_merge` for falls through to the create gate, so one evaluation still logs one decision. A raw-client PR *creation* (`curl … /pulls` without `/merge`), which the merge classifier catches, is logged under `gate:"pr"`. The merge gate emits no `override` event under a kill switch (the PR gate owns those), and its structural denials (compound, raw client, graphql, unparseable) come before the kill switch, as the PR gate's parse errors do.
- **Hook fast paths are linear.** `mentionsPrCreate` and `mentionsMerge` run on every Bash call. A killed PreToolUse hook does not block the call, so a super-linear regex is a fail-open: never write `\bgh\b[\s\S]*\bpr\b…`. Use `inOrder` or token scans; the 100 KB latency test in `merge-bypass.test.mjs` fails on a regression.
- **`settings.json`:** we write only the five `permissions.ask` strings (§6.2), plus removal of legacy
  hook objects in `migrate`. Writes follow the §6.2 commit protocol, with the precondition that no
  Claude Code or other writer is active.
- **Per-user state:** files 0600, dirs 0700, via `ensurePrivateDir` / `atomicWriteJson` (a delegate of
  `atomicWriteText`, the one write-then-rename) / `readJsonValidated` / `quarantine` from `lib/fsutil.mjs`. Reuse these; never re-implement them.
- **Locks** (`state.mjs`; one `<key>.lock` per artifact, plus the CLI's reserved key):
  - **Contract.** At most one process returns from `acquireLock` for a key until the lock is released, or until its
    HOLDER is judged stale (dead PID, or no heartbeat for `LOCK_TTL_MS`; a holder judged stale while alive is fenced
    by `writeRecord`'s `lock_lost`, which runs before `runCompanion`). A reclaimer or releaser never moves a lock other
    than the one it observed, however long it is suspended. This holds among 1.0.3+ processes; a pre-1.0.3 process
    still running during an upgrade moves the path without the section, as before, and is fenced the same way.
  - **The mover section.** Every operation that moves the lock path (a stale reclaim, a release) runs in a per-key
    section; publishing into an empty path needs none (`link` is exclusive). Each contender publishes its own marker
    `<key>.lock.reclaim.<pid>.<16 hex>` (`{pid, ident, token}`, via `publishLock`) and enters only if no other marker is
    live; contenders that see each other back off at random, at most 4 attempts, then `busy`.
  - **A marker is live while its owner process exists. No time limit.** Stale only when the name's PID is dead, or the
    marker is verified (well-formed, agreeing with its name) and `processIdent(pid)` differs. `ident` is the sha256 of
    `/bin/ps -ww -o lstart=,command=` under a fixed env (`TZ=UTC`, `LC_ALL=C`): absolute path, so a PATH shim can't
    fake "another process"; command line included, so a PID reused within the same `lstart` second differs unless
    it also runs the identical command. `lstart` has one-second resolution and nothing finer is reachable without a
    native addon; macOS assigns PIDs sequentially and wraps only at 99999, so that case needs ~100,000 process
    creations within one second (`kern.maxproc` is a few thousand). If it ever happened, the marker would read as live
    for that process's lifetime, the same "blocked while its owner lives" case below. Unreadable or
    inconsistent markers, and a failing `ps`, count as live while the name's PID lives. No identity → no marker
    (`lock_identity_unavailable`). Nothing in review-loop may set `process.title` (a test greps for it).
  - **When a key stays blocked**: for as long as a marker's owner lives (stuck, suspended, or a reused PID behind an
    unreadable marker). `busy` says how to clear it: a verified owner's PID to end, or, unverified, the one marker file
    to delete after checking `ps` (never "end it" for an unverified PID).
  - **Cleanup.** Our own marker's unlink never throws: a failure logs `lock_marker_cleanup_failed`
    (`lock_marker_cleanup`), and the path is retried on the next `acquireLock`/`release` and in an exit handler. A
    release that finds the section busy is deferred as `key → token` (`lock_release_deferred`) and retried the same
    way, removing the lock only while it still carries that token.
  - Pinned by the `lock section:` tests in `state-policy.test.mjs`, the e2e "fenced before paying" test, and sabotage
    rows `lock-section-exclusive`, `lock-marker-no-expiry`, `lock-ident-fixed-env`, `lock-release-own-only`.
  - Every engine `ps` whose answer decides identity (this lock, and `pin.mjs`'s broker verification and sweep since
    1.0.4) runs `trustedPs()` (`proc.mjs`: `/bin/ps`, or `REVIEW_LOOP_TEST_PS_PATH` behind `REVIEW_LOOP_TEST_SEAMS`)
    under a fixed env; pinned by "B: a ps on PATH is never consulted" and sabotage row `trusted-ps`. **Known
    follow-up (Coherence):** `cli/lib/settings.mjs`'s writer check still resolves `ps` through PATH (it only reports
    a running Claude, never signals); its tests stub `ps` on PATH.
- **Symlinks** are rejected on config, rubric, events path, the Codex config read and the state dir.
- **The literal string of the GitHub CLI PR-create command** must not appear in any shell command you
  run in Claude Code: the author's live PR gate denies it. Build it from parts in scripts
  (`const G = "g" + "h"`), or run edits from script files.
- **Commit messages** end with the attribution lines from the session's system reminder.
- **Symlinked `~/.claude/settings.json` is followed: an author decision, 2026-09-28, re-confirmed at the
  plan's round-10 checkpoint.** This keeps chezmoi/stow/yadm setups working (spec AC-7, T-SET-12).
  Guards: the target must be a regular file the user owns, ≤ 1 MiB; it is opened `O_NOFOLLOW` after
  `realpath`; a dangling link is refused; and the write is an atomic rename beside the target, after a
  backup. **Accepted residual risk:** if the user's own settings link points at some other file they
  own, that file is rewritten as settings, with a backup kept. Don't "fix" this by refusing links;
  that reverses the decision.
- **No `any` type anywhere** (the author's global rule): not in JSDoc (`@type`, `@param`, `@returns`,
  `@typedef`), not in casts. Use `unknown` plus narrowing. Task 1 adds `test/contract/no-any.test.mjs`,
  which fails the suite on any occurrence under `plugin/`, `cli/`, `scripts/` or `test/`.
- **A piped test command must not hide a failure.** Every `npm test … | tail/grep` in this plan is
  wrapped as `(set -o pipefail; …)`, so its exit status is the test run's. Keep that when adding
  commands. A gate reads the status **and** the `# fail 0` line.

## Deviations from the spec

- User docs split (docs-usability PR, 2026-10-03): the generated exit-code and troubleshooting tables (§8.3) and the `--json` contract moved from the README to `docs/TROUBLESHOOTING.md`; the Intel runner and Rosetta fallback (§10.3) to `CONTRIBUTING.md`; the unpinned marketplace (§9) and "Outside the gated interfaces" to `docs/SECURITY.md`; the events section to `docs/EVENTS.md`. The README now serves a first-time user. Each test that pinned README text pins the new file.
- `pr_created_head_unreviewed` (Task 7): the engine already uses `pr_head_mismatch` for the push path, so §7.1's post-create head mismatch gets its own code, and one code never means two things. Tasks 12-13 use it.
- `round.decision` event (Task 7): not in the spec's §8.2 catalog. It records `cmdDecide`'s non-override options (`continue`, `more`, `stop`, `accept-finding`, `repin`, `merge`, `pull`) with `{kind, option, reason}`, so every engine decision is observable. The override-type options emit `override` instead.
- Interim PR-gate `gate.decision` (Task 7, ruling R-T7a): removed in Task 8. `review-gate-hook.mjs` now emits the one `gate.decision` per PR evaluation (see Invariants).
- AC-6 amendment (Task 10, ruling R-P2; probe P2, `docs/probes/P2-2026-09-28.md`): effort is display-only in v1. The companion's `adversarial-review` has no effort flag (an unknown `--effort` becomes focus text), so `companionArgs` never emits `--effort`; `--model` is still passed when configured. `effort` and `effort_source` are still resolved and recorded in the round record and `round.result`.
- No `dependencies` in `plugin.json` (Task 11, ruling R-P4; probe P4, `docs/probes/P4-2026-09-28.md`): an unsatisfied plugin dependency stops Claude Code loading the plugin, which would silently turn off every hook. Setup's preflight installs `codex@openai-codex` explicitly and doctor reports it missing. A shape test asserts the key is absent.
- Companion data dir and broker teardown (final review H1/M2, controller ruling): `runCompanion` sets `CLAUDE_PLUGIN_DATA` to `<snapshot>/data` (0700, inside the `ws/plugin-*` snapshot that cleanup removes), never the Codex plugin's shared `plugins/data/codex-openai-codex` nor its `$TMPDIR/codex-companion` fallback, so Codex's job files are private and deleted with the round (and `uninstall --delete-history` leaves none elsewhere). **Accepted tradeoff: review-loop rounds no longer appear in `/codex:status`.** Companion 1.0.6 starts a detached `app-server-broker.mjs serve` (own session, no idle timeout) per cwd and records it in `<data>/state/<slug>-<hash>/broker.json`; `cmdRun`'s `finally` calls `stopCompanionBroker(root)` before cleanup (the whole-tree contract is the "Broker trees" bullet below); broker.json is read bounded and link-refusing; the `cxc-*` session dir is removed only when a live, verified broker's own args name it and it is a real directory in the OS temp dir owned by this user; broker.json's `sessionDir` never removes anything (since 1.0.4 the dir is inside the snapshot's `TMPDIR` and goes with it). Signal paths reap it too (`proc.mjs` `onReap`, the same pid checks, SIGTERM only). A broker that may still be running logs `hook.error` `broker_stop_failed` (plus `round.broker_stop` with the reason) and keeps the snapshot. Pinned by `test/engine/broker.test.mjs` and sabotage rows `broker-stop-finally`, `broker-reap-signal`, `companion-private-data`, `broker-unknown-never-signalled`, `broker-stop-failed-event`. The test seam `REVIEW_LOOP_TEST_COMPANION_TIMEOUT_MS` (with `REVIEW_LOOP_TEST_SEAMS=1`) shortens the companion timeout.
- `--json` output shape (final review L11): spec §6.1 says `--json` prints the `cli.exit` event and only doctor embeds it. Every command with a payload prints `{…payload, event}` (`doctor`, `selftest`, `engine-path` (R-D47), `config show`); the rest print the bare event. The README states this rule. `--version`/`--help` print to stdout without `--json` (L6).
- Stale-snapshot sweep (re-review R2): a round killed before its `finally` (SIGKILL runs no handler) leaves `ws/plugin-*` (with `data/`, Codex's job files), the broker's `cxc-*` dir and possibly the detached broker. `snapshotVerified` writes `<snapshot>/owner.json` (0600, `{pid, started}`; `started` is `ps -o lstart=` with `LC_ALL=C` and `TZ=UTC` pinned on every engine ps call, so pid reuse is detected and a TZ change between rounds never makes a live owner look dead) after the hash check. `cmdRun` calls `sweepStaleSnapshots(ws)` under the artifact lock, first thing (before any early return): for each `plugin-*` entry of this run's partition (see "Broker trees") that is a real directory this user owns (lstat; a link is never followed), an owner that is gone (`kill(pid,0)` ESRCH, or a different start time) → its companion is stopped, then `stopCompanionBroker(root)`, then the snapshot is re-lstat'd and removed. A broker that may still run keeps its snapshot for the next sweep. An owner alive, or unknown (unreadable/linked/malformed owner file, `ps` failed) → left alone. No owner file (the legacy engine's snapshots, or one mid-creation) → swept only when its mtime is over 24 h old AND `ps -ww -A -o args=` succeeds and no line contains the snapshot path. Event `round.sweep` (counts and the partition only), code `ok` or `snapshot_sweep_incomplete`, emitted whenever `ws/` holds a snapshot. Pinned by the R2 tests in `test/engine/broker.test.mjs` (a real SIGKILLed round) and sabotage rows `snapshot-sweep-call`, `snapshot-sweep-unknown-leaves`, `snapshot-sweep-nofollow`, `snapshot-owner-tz-pin`.
- **Broker trees (1.0.4; a snapshot is deleted only after its broker tree is gone).** On the author's machine 80
  brokers ran for days from deleted snapshots: the finally deleted a snapshot whose broker survived, a stop gave up
  after SIGTERM and signalled only the broker's pid, and early-returning rounds never swept. The contract now:
  - **Which brokers.** The union of broker.json's pids and the process table's rows whose args match
    `brokerArgv` (`^\S*/node <root>/scripts/app-server-broker.mjs serve`, anchored; root as given or realpath),
    for this uid, and only while the broker leads its own group (the companion starts it detached; a non-leader is
    never signalled: `unknown_rows`). The table (`readProcs`, `ps -ww -A -o uid=,pid=,ppid=,pgid=,lstart=,args=`)
    counts only when every line parses and it holds this process's own row; an exit-0 empty/garbage answer is a
    failure, never "no broker".
  - **The stop.** `broker/shutdown`, SIGTERM to the broker, then, on a fresh table, SIGKILL to the whole group
    after `signalGroupIfSame` re-reads the leader (`sameMember`: pid, lstart, pgid, args). A verified broker that
    dies during the stop has its group emptied member by member (`deadGroupTargets`): the group's members started
    strictly after the snapshot's creation second (PPID ignored: grandchildren) AND already there, unchanged, at the
    stop's first read, each re-checked just before its SIGKILL. A broker.json pid already gone at the first read is
    never a group to signal (author's decision, 2026-10-06: its number may have been reissued): what still runs in
    it is `unattributed`, the snapshot kept and reported. The same holds for a dead companion's group (sweep). A
    pid held by a process other than the broker first read is never taken to mean "group gone" (`goneGroupsLeft`, the
    stop, `stop-orphan`): the group itself is read, whoever holds the number. The one exception: a newcomer
    leading a group of that very id means the old group had emptied (an id is never reissued while its group
    lives), so `stop-orphan` stops there and signals nothing more.
    `cmdRun` waits past the
    snapshot's second before the companion starts (`afterSnapshotSecond`), so a same-second member is never the
    round's own: `unattributed`, never signalled. A `codex app-server` in a leaderless group inside the companion's
    pid window (`companion.json` = `{pid, after}`, written through `run`'s `onSpawn` and right after the companion
    exits) is `unattributed` too. Known limit: a broker that dies before broker.json AND whose app-server dies too
    leaves its grandchildren unattributed and unreported (no evidence names them; `ps -E` would read every process's
    environment and macOS hides it for platform binaries such as shells and git — author's decision 2026-10-06:
    kept as a documented limit).
  - **Temp dir.** The companion runs with `TMPDIR` inside the snapshot (`companionTmp`), so a broker's `cxc-*` dir
    goes with the snapshot even when no broker.json names it; when that socket path would pass 103 bytes (a long
    state dir), a short `rl-XXXXXX` under the OS temp dir, recorded in `tmp.json` (`{dir, token}`) before it is
    made, the token then written into it whole (`.review-loop-tmp`, by rename from `.part`). `removeSnapshot`
    removes that dir first, token last, only when it holds exactly that token (in the token file, or still in
    its `.part` after a failed rename or a kill); any other dir (tokenless, empty, a
    partial or another token) is never touched: a kill before the token leaves at most an empty dir in the OS temp
    dir, for the OS to clear. It is detached first (atomic rename to `<dir>.rm`, checked to be
    the same device and inode), so a path swapped for a link after the check removes nothing behind it; a removal
    cut short resumes from `<dir>.rm`.
    The snapshot is kept (`temp_unremoved`) unless the dir is confirmed gone or not ours.
  - **Fail closed.** Anything unverifiable (`ps_unavailable`, `registry_unreadable`, `deadline`, `unknown_rows`,
    `members_left`, `unattributed`, `temp_unremoved`: `BROKER_STOP_REASONS`) signals nothing more and keeps the snapshot; every path that keeps one (the round's own stop, both
    sweeps) logs `hook.error` `broker_stop_failed` when something may still run (`reportStop`), and `round.broker_stop` (reason, counts, the `plugin-XXXXXX` name; for a swept snapshot, the `artifact_key` of
    the round that made it, from owner.json's `key`, never the sweeping round's), and a lost line is said on stderr
    (`event_write_failed`). The owner marker is written whole before the companion can start; when ps cannot name
    the round, `snapshot_owner_unknown` (exit 30) and no companion. A damaged owner.json in a snapshot older than
    24 h goes by the legacy rule.
  - **The sweep.** Only entries named as snapshotVerified names them (`SNAPSHOT_NAME`, `plugin-` + 6 alphanumerics)
    are snapshots; any other `plugin-*` is not touched (one that happens to fit, such as `plugin-backup`, cannot be
    told apart by name). An owner-less one is a legacy snapshot only when it holds nothing but a snapshot's files
    (`onlySnapshotFiles`: every entry a directory or a regular file at a pinned path or `.claude-plugin/plugin.json`,
    the companion among them, no links, no other file); any other is unverified and kept, so a sweep only ever removes
    copies of plugin files. A leftover from a plugin version whose file set differs stays unverified. The walk is
    streamed against its cap (`namesUpTo`, `lstat` per entry), never a whole listing. Right before each remove,
    `sweepOne` re-checks `ws/` itself against its device/inode from the sweep's start (`dirIdentity`) and leaves the
    entry unverified on any change: this narrows, but cannot close, a same-user swap of `ws/` for a link (Node has
    no `unlinkat`); a same-user process could delete the target itself, so no privilege boundary is crossed (known
    limit, author's decision 2026-10-07). The round's `finally` releases its lock in an inner `finally`, and a
    snapshot cleanup that throws is reported as `failed_remove`. A damaged broker.json (unparseable, or not
    `{pid: int > 1}`) is set aside (`quarantine`, `broker.json.corrupt-<ts>`) and the stop goes on the process table
    alone, as for a missing one (`hook.error` `broker_registry_quarantined`); a linked, oversized or unreadable one
    stays fail closed (`registry_unreadable`) (author's decision 2026-10-07). The sweep's deadline is checked before
    every judgment, not only after one acted, and owner identities are read once per pid per sweep (`processTable`). A snapshot it leaves alone is `in_use` (owner alive, fresh, or referenced) or `unverified` (not a
    real dir of ours, an owner that cannot be read); the manual `sweep` is `clean` only with no `unverified` left, and
    both counts go in its output and in `round.sweep`. Doctor's `orphaned_brokers` judges each snapshot with the same
    `judgeSnapshot`, so it is unverified exactly where the sweep is. An owner's `started` is compared only when it is a
    real `ps` lstart (`isLstart`: every field read back from the parsed date); anything else is unknown, never a
    mismatch, so a corrupt owner.json never makes a live round read as dead. Within the same second, `ident`
    (`processIdent`, the locks' start-time-plus-command-line hash, in proc.mjs) decides: another identity is dead, an
    owner.json without one is unknown. A sweep step that throws is reported on
    its snapshot as `failed_<judge|companion|broker|remove>` (`BROKER_STOP_REASONS`), never the error's text; it counts
    nothing, so `reportStop` emits `hook.error` `broker_stop_failed` for it on the reason alone. A companion stop signals nothing once the budget is spent
    (`deadline`, snapshot kept). Two streaming passes over `ws/` (count, then hold one partition: `partitionCount(n)` is a power
    of two leaving ~16 per partition, `isHeld(hashOf(name), tick, P)` with `tick` = the minute). Powers of two nest,
    so every snapshot is examined within 2^K minutes however `n` changes. A round's sweep has a 10 s deadline (the
    first act always runs; each stop gets the time left; a round's own stop gets 15 s). A dead owner's companion is
    stopped before its brokers (`stopSnapshotCompanion`).
  - **Operator surface.** `review-round.mjs sweep` (every partition, frozen count, exit 0 clean / 60 incomplete),
    `review-round.mjs stop-orphan` (one broker whose snapshot is gone; re-checks pid, start, args hash, group and
    the snapshot's absence before each signal), and doctor's `orphaned_brokers` (read-only: counts, prints those
    commands; never signals). Brokers whose snapshot is gone are never killed automatically (author's decision):
    without the snapshot only a command line ties them to review-loop.
  - Pinned by the `A:`/`B:`/`B2:`/`C:`/`D:`/`units:` tests in `test/engine/broker.test.mjs`, the `orphaned_brokers`
    tests in `test/cli/doctor.test.mjs`, and sabotage rows `round-keeps-unstopped-snapshot`, `broker-group-sigkill`,
    `broker-leaderless-tree`, `broker-registry-union`, `broker-argv-anchored`, `companion-after-snapshot-second`,
    `sweep-before-early-returns`, `doctor-read-only`, `sweep-partitions-pow2`, `sweep-partitions-all`,
    `broker-leader-recheck`, `ps-table-self-row`, `leaderless-app-server-guard`, `companion-pid-onspawn`,
    `owner-marker-required`, `sweep-deadline`, `stop-honours-deadline`, `stop-orphan-recheck`,
    `sweep-stops-companion`. Test seams (all behind `REVIEW_LOOP_TEST_SEAMS=1`): `REVIEW_LOOP_TEST_KILL_NOOP`,
    `REVIEW_LOOP_TEST_LEADER_RECHECK`, `REVIEW_LOOP_TEST_SWEEP_TICK`, `REVIEW_LOOP_TEST_SWEEP_PART`,
    `REVIEW_LOOP_TEST_SNAPSHOT_AT_SECOND_START`.
  - The legacy engine outside this repo got its own minimal fix on 2026-10-05 (it stopped one broker tree per round
    from leaking); migrating to the plugin replaces it.
- `hook.error` carries a `mode` field (Task 7): the hook mode for `hook_input_error` and `hook_error`, validated against the existing STAGES enum.
- Post-create verification uses GitHub's current head only (Task 12, ruling R-D15): `prverify` runs a fresh `gh pr view` (or a lookup by head branch when the create response has no PR number) and never compares the head in the create response, deviating from spec T-PR-3(a)/T-PR-11. This closes a create-to-verify race (the branch can advance between creation and the hook). It costs one extra `gh pr view` per PR creation. Verification fails closed: a missing gh, a failed GitHub request, or an exhausted 30 s budget gives `pr_verify_unavailable` (a stop under Default and Balanced), never a crash or a silent pass.
- Unverified MCP shape (Task 12): the real PostToolUse `tool_response` of a GitHub MCP `create_pull_request` has not been observed (no server was connected). `prverify` accepts a plain object with `number`/`url`/`URL`/`html_url` or an MCP content array (`[{type:"text", text:"<json>"}]`, also under `content`), and otherwise looks the PR up by head branch, proceeding only on exactly one match. Task 27's e2e should record the real shape and pin it.
- Merge gate (Task 13) additions beyond §7.1's table:
  - `pr_merge_not_open` is a new code: a bound, cleared merge of a PR that is already merged, closed or a draft is denied loudly instead of being left for GitHub to reject.
  - The PR's head is re-read with `gh pr view` immediately before allowing (ruling R-P7a), so an allowed merge costs two `gh pr view` calls.
  - A `gh pr merge` the parser can't isolate (inside `bash -c "…"`, after `echo`, behind an unknown pre-subcommand flag, or two merges in one command) is `pr_args_unresolvable`, the create gate's rule. The same text accounting means a commit message that contains that command text is denied too.
  - `gh api` on `…/pulls/<n>/merge` with any non-GET effective method (an implicit POST from `-f` included) is gated as a merge.
    - The endpoint is canonicalized first: the `#fragment` and query are dropped, and a full URL may spell the API host in any case, with a trailing dot or `:443`.
    - Any other `gh api` word containing `/merge` (also percent-decoded) with a non-GET method is `pr_args_unresolvable`: `repositories/<id>/…`, an encoded path, a second endpoint or a field value. So is a non-github.com `--hostname`.
    - With `--input`, gh sends `-f`/`-F` as query parameters, so the merge is `pr_merge_unbound` even with `-f sha`.
    - A `?` query on a merge endpoint is `pr_args_unresolvable`; it could carry its own `sha`.
    - A non-GET `gh api` call with any gh placeholder other than `{owner}/{repo}` or `:owner/:repo` is `pr_args_unresolvable`, on any path, since gh can expand it to `pulls/<n>/merge`. The placeholder pattern is gh's own, `\{[a-z]+\}|:(owner|repo|branch)\b` (`{branch}`, `:branch`).
    - GraphQL is recognized on the canonical path (`apiPath`), so `graphql`, `/graphql`, `graphql/` and `https://api.github.com/graphql` are all GraphQL, in the merge gate and in the create gate's unreadable-body check.
    - The route is compared percent-decoded and lower-cased (`decodedApiPath`), so `%67raphql` and `graphq%6C` are GraphQL in both gates. A malformed `%` escape on a non-GET call is unreadable: `pr_args_unresolvable` in the merge gate, `pr_via_api_unsupported` in the create gate.
    - A GraphQL call whose body the gate cannot read (`--input`, `-F …=@file`, a shell expansion) may hold a merge mutation. It is `pr_merge_graphql_unsupported` under `gate:"merge"`, checked before the compound rule.
    - A non-GET `gh api` whose `-f`/`-F` text holds a merge mutation is `pr_merge_graphql_unsupported`, whatever the endpoint.
    - When a command mentions an API or GraphQL merge next to `gh … api`, every `gh` command word that reaches `api` must be a call the parser read. So `timeout 30 gh api …`, `bash -c "gh api …"`, `gh -f … api graphql` and `gh api user && gh -f … api graphql` are `pr_args_unresolvable` under `gate:"merge"`. The create gate uses the same count.
  - Counting gh calls (`countGhCalls` in `cmdparse.mjs`, one counter for `api`, `pr merge` and `pr create`). **Invariant: it may over-count, never under-count.** Each parser compares the count with the calls it isolated and read; a surplus is `pr_args_unresolvable`.
    - Words are the unquoted text cut at whitespace, shell operators, `$`, backticks and brace syntax (`{`, `}`, `,`), so `$(echo gh)`, `x=gh` and `{gh,api}` all yield their words. A gh word matches `(^|\W)gh$` case-insensitively, since macOS resolves `GH` to gh.
    - A gh word counts when the subcommand's words follow it in order. Before each of those words, any word that is not a plain subcommand name (a flag, a redirection such as `2>&1`, an expansion such as `$E`) lets the next subcommand word appear anywhere later. A plain lowercase word that is not the subcommand stops that gh word.
    - Each gh word is judged alone in one right-to-left pass, and no word resets another's count. A `gh` inside a flag value (`gh -f 'x=gh y' api …`), a value the splitter cuts up (`gh -t 'a b' pr merge 5`) and a redirection (`gh pr 2>/dev/null merge 5`) therefore cannot hide a call.
    - Fail-closed false positives this accepts: a pre-subcommand flag followed anywhere later by the subcommand counts, so `gh -R o/r pr view 5 && gh pr merge 5 …` is `pr_args_unresolvable`. Quoted text counts as well. The create gate refuses a command that mentions pulls, graphql or createPullRequest when an `api` word in a title is reachable from a gh word, so `gh pr create --title "gh api pulls"` and `gh -R o/r pr create --title "Add api for pulls"` are `pr_args_unresolvable`. A title that mentions api, pulls or graphql after a plain `gh pr create`, as in `gh pr create --title "Add api for pulls"`, is read normally.
  - Shell rewriting (`assertNoShellRewrite`, both gates, `pr_args_unresolvable`). The shell rewrites these before gh runs, so no parser can read them. They are refused in any command that *names gh, pr or api*: the unquoted text contains one of those words (`api.github.com` is a host, not `api`), read as is and with brace syntax cheaply expanded (a sequence collapsed to its first element, list braces and commas dropped or spaced), so `{g..g}h`, `g{h..h}` and `{p..p}r` name them too.
    - Brace expansion, wherever the word sits, the command word included: a `{a,b}` list outside quotes (the tokenizer's quote state), or a `{x..y}` sequence anywhere, quoted or not, since it may sit inside `bash -c "…"`. So `gh pr {m..m}erge 5`, `{g..g}h api …`, `gh api repos/o/r/pulls/5/merge {-X,} PUT` (a PUT) and `gh pr create {-B,} dev` (names a base) are refused. gh placeholders like `{owner}` and quoted jq or GraphQL comma lists are not brace expansions.
    - ANSI-C quoting with an escape, `$'\…'` anywhere in the raw text: `gh pr $'\155erge' 5`, `gh $'\x61pi' …`. A `$'…'` with no backslash is read as its literal text (`gh pr $'merge' 5` is an ordinary `gh pr merge 5`).
    - A fast-path arm routes any command with a brace expansion or an escaped `$'…'` that names gh, pr or api to the parsers, and it reaches the merge gate first, so the merge gate logs every such refusal, a creation's included (`{gh,api} -X POST …/pulls` is `gate:"merge"`).
    - A raw client or API host spelled by a brace sequence (`{c..c}url`, `{a..a}pi.github.com`) is read expanded, so it is still `pr_github_api_unsupported_client`.
    - Accepted fail-closed false positives: any brace expansion in a command that names gh, for example `for i in {1,2}; do gh pr view $i; done` or `mkdir -p src/{a,b} && gh pr list`; any escaped `$'…'`, for example `gh pr create --body $'line1\nline2'`; and a quoted `{1..3}`-style sequence in a gh argument.
  - gh aliases: `gh alias set` or `gh alias import` anywhere in a command is `pr_args_unresolvable` in the merge gate (counted by `countGhCalls`, so flag-first and wrapped forms count). An alias the agent defines would run `gh pr merge` or `gh api` under a name no parser reads. The message tells the agent to run the gh command itself, or to ask the user to define the alias outside the agent. `gh alias list` and `gh alias delete` pass.
    - `gh api` has no `-R` (`gh api --help`): `{owner}/{repo}` placeholders resolve through `resolveBaseSlug` with the inline `GH_REPO`.
  - `gh pr merge` flags are read as pflag reads them. Grouped shorthands are walked letter by letter: `-st 5` is a subject and no PR number, and `-sRx/y` names repo x/y. An unknown short or long flag is `pr_args_unresolvable`.
  - A raw client (`curl`, `wget`, `http`/`https`, `xh`) is denied only on a write: a method word in any case, a body flag, or an HTTPie/xh data item. A plain GET of pulls passes. The API host matches in any case, with a trailing dot or `:443`.
  - `pullNumber` and `pull_number` both present and disagreeing in an MCP merge is `pr_args_unresolvable`.
  - A `gh pr merge` naming a branch instead of a number or URL is `pr_merge_context_unverifiable`.
  - Whole-evaluation budget: every gh and git call finishes within 30 s (`deadlineMs`), and running out is `pr_merge_context_unverifiable`. The deadline is threaded through `repoRoot` (a timeout on a live deadline is `command_timeout`, never an absent repo), `killSwitchForSession`, `resolveBaseSlug`, `ghPrView`, `ghBranchSha`, `githubRemotes`, `commitExists` and `mergeBaseValidity` (`budgetMs` in `git.mjs`). A killed PreToolUse hook does not block the call, so a fail-closed gate must finish inside the 40 s hook timeout.
  - The Advisory rewording is `advisoryText` in `presets.mjs`, shared by the hook and the merge gate. `pr_merge_auto_unbound` was removed, since P7-auto showed `--auto` is bound.
- Settings writer session check (Task 16, rulings R-P6/R-P6b; probe P6, `docs/probes/P6-2026-09-28.md`): §6.2's `pgrep -x claude` is replaced by `listClaudeProcesses()` in `cli/lib/settings.mjs`, which classifies `ps -Ao pid=,ppid=,args=` rows. It counts every `claude` executable (`(^|/)claude( |$)`) or `/claude-code/cli.js` process except pure helpers (first argument `daemon`, `bg-pty-host` or `bg-spare`) and the Chrome native host (first argument `--chrome-native-host`, or EVERY argument one of `--chrome-native-host`, `chrome-extension://…`, `--parent-window=…`; ps's `\012` newline escape separates arguments). ps shows no argv boundaries, so any other word (a prompt, `-p`) counts the process. Overcount is the safe direction. `ps -ww` keeps procps from truncating the args column. `ps` and `lsof` are resolved through PATH. A `ps` that fails, times out, or prints no parseable table is `settings_writer_check_failed`. This CLI's own ancestry is not counted as a running session; a Claude Code ancestor is `claude_parent_process` (in addition to `CLAUDECODE=1`), so an unset `CLAUDECODE` cannot hide the parent session. The open-file check is `lsof -F c` (process names), not `lsof -t`. The post-rename backup re-hash compares the full sha256 with `base` (a superset of the spec's sha8 compare).
  - Step-2 re-check (Task 16 fix round 1): a matching backup hash is not enough. A replace-style writer (temp + rename) swaps the inode at the target and leaves the backup's hash equal to `base`, so the target must also still be the backup's inode (`ino` and `dev`). On a mismatch the backup name is removed and the read-modify-write retries (the same 3-attempt bound). On the EXDEV copy path the TARGET is re-hashed, because a copy sees neither kind of write. The §6.2 unrecoverable window therefore runs from this inode compare to `rename()`, not from the hash.
- Outside the gated interfaces (branch protection is the control): AC-23's gate is a guardrail for the agent's standard GitHub interfaces, not a sandbox. It does not see:
  - `GH_HOST` or other GitHub Enterprise hosts (`gh api --hostname` other than github.com is refused, but `GH_HOST` in the environment is not read);
  - curl URL globbing (`api.github.com/repos/o/r/{pulls,x}/5/merge`, `[1-9]` ranges);
  - a gh command or subcommand spelled only by a run-time expansion the text doesn't show: a glob (`/opt/homebrew/bin/g[h]`, filesystem-dependent), a variable, a shell alias or function, or `eval`;
  - gh aliases defined outside the agent (the user's gh config);
  - an IP address or another hostname for the API, with a `Host: api.github.com` header;
  - scripting languages and SDKs (python `requests`, `node -e fetch(...)`, octokit, `gh` extensions);
  - HTTPie `--raw` bodies and other clients the spec does not name;
  - branch merges that need no PR: the GraphQL `mergeBranch` mutation and `POST repos/o/r/merges`.

  In a repo whose branch protection requires `review-loop/<base>` (AC-23 (2)), none of these can land an unreviewed head or base context. `docs/SECURITY.md` quotes this list verbatim, and `test/contract/readme.test.mjs` fails when an item here is missing from it: edit both together.
- GraphQL merge queue (Task 13, review ruling): §7.1 lists `mergePullRequest` and `enablePullRequestAutoMerge`. The gate also denies `enqueuePullRequest`, and any mutation whose name pairs PullRequest with merge or enqueue, as `pr_merge_graphql_unsupported` (fails closed). Disabling auto-merge and dequeuing are not merges.
  - A base tip or head that is missing locally is fetched, via the matching git remote, else `https://github.com/<slug>.git`. The fetch is bounded by `fetchExactRef`'s new `timeoutMs` option and leaves 8 s for the re-check. A failed or out-of-time fetch is `pr_merge_context_unverifiable`.
- MCP merge field (Task 13, P7-mcp), verified from the server source on 2026-09-30: `plugin/engine/lib/mcp-merge.json` ships `expectedHeadSha`, which `github/github-mcp-server@5a1a386` declares on `merge_pull_request` and passes as the REST merge `sha`. `test/fixtures/mcp-merge-schema.json` holds that input schema, and tests pin the field to it. A live hook payload from a connected server is still uncaptured.
- Success status is posted at round completion AND at `push` (Task 14): the spec says "every completed round posts", but the first post may 422 before the commit is pushed to GitHub, so `push` re-posts it. A failure status marks the SHA reviewed this round (`rec.fingerprint`), not the earlier approved SHA (ruling R-D18). A failed post is `status_post_failed` (event `hook.error`, stage `status_post_failed`) and never fails the round.
  - An MCP merge without that field is `pr_merge_unbound` (fails closed).
  - Task 27's e2e should record the real `merge_pull_request` input schema from `tools/list`. If the field name differs, update both files; if there is no head field, set `headField` to `null` (the gate then returns `pr_merge_mcp_unbindable`).
- Content gate and README (Task 24):
  - `scripts/content-gate.mjs` scans `git ls-files` ∩ `package.files.json` (or `--dir <extracted>`; `--list` prints the set). Findings print `FAIL <file>[:<line>] rule=<name>`, never the text. Rules beyond §10.2's denylist: `symlink`, `not_regular`, `too_large` (> 2 MiB), `unreadable` (also an unlistable `--dir` subdirectory), `unlisted` (`--dir` only), `missing`. Paths are content too: the denylist runs over `/<rel>` and a hit prints `FAIL <shown> rule=<name> (path)`, where `<shown>` (used in EVERY finding for that file) replaces each component overlapping a match with `<redacted>`. Unknown arguments exit 2; a failing `git ls-files` exits 2 with one line.
  - Private denylist: only the generic rules (`users_path`, `personal_rules`, `email`) live in code. The author's handle and private org and project names are never written in this repo (not in code, tests, docs or commit messages); they are rules loaded at run time from `CONTENT_GATE_DENYLIST` (JSON array of `{name, pattern}`; a blank value counts as absent, which is how a missing secret arrives), else the gitignored `.content-gate.private.json` at the repo root (read with `readBounded`, so a link is refused). `parsePrivateList` validates strictly: 1–64 entries, names `^[a-z0-9_]{1,32}$`, unique and not a generic or operational rule name, patterns 1–200 chars that compile case-insensitive and don't match `""`. Invalid → exit 2 with a reason that never prints a pattern or an invalid name; private rule NAMES are printed in findings (keep them neutral). No list: generic rules plus one stderr notice; `--require-private` (the release job) makes that exit 2. `--tracked` scans EVERY `git ls-files` file with the private rules only (tests legitimately hold `/Users/x`), same redaction and exemptions; a tracked symlink is scanned as its target text via `readTracked` (readlink, never followed). A tracked `.content-gate.private.json` is `rule=private_list_tracked` in both git modes. Tests use a synthetic list (`zzprivatehandle`, `zzprivateorg`, `zz-private-project`) injected through the env var or a list file in a temp checkout. CI (`ci.yml`) passes the secret to the packaged and `--tracked` gate steps only on a push to `main`, never to a pull request (its code is the PR branch's), and degrades without it; `release.yml` passes it only to its three gate runs, each with `--require-private`, before `npm test`. `release.test.mjs` pins both. Sabotage rows: `content-gate-require-private`, `content-gate-private-bounds`, `release-require-private`, `ci-denylist-push-only`.
  - Reads: `readBounded(root, rel)` lstats EVERY component from the (realpath'd) package root down, so a linked parent directory is `symlink` and a refused file never reaches the reader (spy test). Then an `O_NOFOLLOW | O_NONBLOCK` descriptor, a post-open `realpath(parent)` re-check (a parent swapped for a link after the walk), `fstat` regular-file check and a cap on the bytes actually read. Binary files are scanned too (no NUL skip).
  - Recorded exemptions only: a LICENSE line that is exactly `Copyright (c) YYYY <holder>` (holder: letters, digits, space, `.,'-`; an email or path on it still fails), and the coordinates `<owner>/review-loop`, `<owner>/homebrew-tap`, `<owner>/tap`, with `<owner>` from `package.json` `repository.url` (`github.com/<owner>/review-loop`), else the literal `<owner>`. Nothing is stripped: a rule match is exempt only when it lies wholly inside an exact coordinate occurrence, so `<owner>/tap@gmail.com` still fails. `package.json` has no `repository` field until Task 28.
  - `scripts/gen-readme-tables.mjs` fills the `exit-codes`, `troubleshooting` and `live-check` marker blocks in `docs/TROUBLESHOOTING.md` (`--file` for another file) from `codes.mjs` (`live-check`: one row per `detailRemedies` entry; `live_check_failed.detailRemedies` is the single source of the §6.4 per-detail fixes, re-exported as `LIVE_REMEDY`, printed by setup as `Fix: …`, by doctor as the check's fix, and by the CLI failure line through `remedyFor(code, detail)`; final review M4) (every code with a non-empty remedy, `setup_complete_unverified` included). `splice` matches `(<!-- N:start -->)[\s\S]*?(<!-- N:end -->)` (R-D31) with a replacer function, so a `$` in a remedy is literal. Adding a code needs only `npm run docs:check` → regenerate.
  - CLI options (`cli/review-loop.mjs`): each `COMMANDS` entry's `options` is the whole list it accepts. `main()` handles `<command> --help`/`-h` (usage, options, example on stdout; stderr under `--json`; exit 0) and refuses any other flag, a missing option value or an extra word (`usage_bad_flag`, exit 2) BEFORE the command loads, so help or a typo never prompts, locks, writes or calls a tool. `config`'s first three words are its own (a model name may start with `-`); `configcmd.mjs` refuses extras after `show`/`repair`. `test/cli/help.test.mjs` runs every command with its loader replaced by a failing one; sabotage rows `cli-help-before-load`, `cli-unknown-flag`.
  - T-OBS-5 (`test/contract/content-discipline.test.mjs`) runs every `COMMANDS_ENUM` command and every hook mode through `plugin/bin/hook` (with and without node), and asserts the `cli.exit` command set equals `COMMANDS_ENUM` and the `gate.decision` gate set equals `GATES`: a new command or gate fails it until added.
- `doctor` (Task 20):
  - Each `--json` check is `{id, status, code, fix, note}`; `note` (beyond §6.5's code and fix) says why, e.g. "not installed" vs "timed out", so a tool that could not run never reads as missing (`tool_failed`).
  - `live` without `--live` always warns: nothing records a passing live check yet, so §6.5's "no pass recorded since the last setup or config change" is always true.
  - `node_for_hooks`: a node found only on this shell's PATH (not `REVIEW_LOOP_NODE_CANDIDATES` or the fixed Homebrew paths) is a warn, because hooks run with Claude Code's PATH.
  - `version_skew` is `skip` when the plugin is absent, shows no version, or the plugin list cannot be read (`plugin_installed` reports those).
  - The pin is read with `readOnly` (`readJsonValidated`'s new option): a corrupt pin reads as `plugin_pin_missing` and is left in place, not quarantined, because doctor writes nothing but `cli.exit`.
  - New codes, so each remedy fits its failure: `plugin_not_installed`, `plugin_version_skew`, `legacy_hooks_present`, `ask_rules_missing`, `plugin_pin_missing`, `gh_unavailable` (the `gh` and `pr_binding` warns), `events_unwritable`, `skill_duplicate`.
  - One code, one meaning (final review L13): a failing doctor run (and migrate's doctor gate) is `doctor_failed`, not `preflight_failed` (setup's preflight and doctor's four preflight-item rows keep it); a failed `claude plugin uninstall`/`marketplace remove` or a plugin still listed after uninstall is `plugin_uninstall_failed`; the leftover settings temp file warn is `settings_tmp_leftover`. `selftest` failures are `selftest_failed` with the failing check id as the detail (L5).
  - `plugin_installed` at a non-user scope prints `claude plugin install review-loop@review-loop --scope user` (the brief's `review-loop setup` loops: setup skips an already-enabled plugin). Not installed or disabled still prints `review-loop setup`.
  - A tool that is simply not installed makes the checks that depend on it `skip`, not `tool_failed`; its own row (claude, codex_cli, gh) fails with the install fix.
  - Each distinct tool probe runs once per doctor run (`memoRunner`, threaded through `PREFLIGHT[i].check(run)` and `installedPlugin(id, run)`), so a stalled tool costs one timeout. The memo lives only for one `run()`.
  - Notes are capped at 200 characters; the `codex_cli` note is the parsed version, not raw stdout.
  - A linked or non-directory `settings-backups` path warns as `state_symlink_rejected` and is never read through.
  - T-OBS-2's `module_not_found` case uses the test seam `--inject-missing-module` (with `REVIEW_LOOP_TEST_SEAMS=1`), not a not-yet-written command.
- `config` command (Task 19, ruling R-P2): `config set effort` validates against `EFFORTS` and stores the value, but effort is display-only. `config show` labels it "recorded, display only; not sent to Codex" rather than describing it as applied. `set` on an invalid or symlinked config refuses (`config_invalid` / `config_symlink_rejected`) instead of overwriting it with defaults plus the one change; `config repair` is the way out and quarantines through `fsutil.quarantine`. The owner check (`config_insecure`) is shared with setup in `cli/lib/configguard.mjs`. The config's folder gets the plans folder's trust rule (`assertConfigDir`, sharing `fsutil.assertOwnLinks`): never itself a link; a link above it, through every hop, and the folder are yours or root's, else `config_dir_untrusted`. Reads treat that as invalid (Default applies); every writer (config set/repair, setup, migrate and its rollback, uninstall) refuses before changing anything. `set rubric` and `events.path` store the resolved absolute path.

- `migrate` (Task 22, ruling R-D29):
  - A hook group is removed only when every hook in it EQUALS `node ${claudeConfigDir()}/review-loop/review-gate-hook.mjs <mode>` (mode `pr|session|track|stop|prompt`; keys `type`/`command`/`timeout` only, group keys `matcher`/`hooks` only), the same predicate rollback validates (fix round 1: an any-prefix regex let a manifest restore a hook at a foreign path). A group mixing a legacy hook with a foreign one is `settings_mixed_hook_group`; a legacy hook in any other shape (`$HOME`, quotes, another mode, extra keys) is the new code `settings_legacy_hook_unrecognized`. Both refuse before the plugin install and before any write.
  - All up-front refusals (settings readable, hook shapes, no running Claude Code, config owner) happen before the plugin install, so a refusal changes nothing.
  - A manifest left `in_progress` or `done` is continued, never overwritten, so a re-run after a crash or a failed doctor gate keeps the first run's undo data; a `rolled_back` one starts fresh. The legacy engine dir counts as legacy for detection, so a re-run after fixing doctor moves it. An `in_progress` record is always resumed through the full flow, even when nothing legacy is left: each step checks before acting, so a crash after any step still gets the later ones (rubric, CLAUDE.md pointer) and nothing is recorded twice. The doctor gate runs only while there is an engine dir to move.
  - Plugin install is verified (listed and enabled) before the settings write, as setup does.
  - Rollback no-ops a step whose resource still equals its before-state (a crash between the manifest entry and the mutation), restores `CLAUDE.md` only from a backup whose sha equals the recorded before-sha, and reports (never overwrites) a legacy folder re-created since migrating.
  - An invalid config is never overwritten: the rubric step is skipped with a `config repair` note.
  - `--yes` applies the `CLAUDE.md` reference edit without asking (the brief's contract); interactively it asks, default no. A symlinked `CLAUDE.md` is never edited; the change is printed for the user.
  - The edit replaces the whole backticked token `` `~/.claude/review-loop/CLAUDE.md` `` with ``the `review-loop` plugin (`review-loop doctor`; https://github.com/<MARKETPLACE_SOURCE>)``: no nested backticks, no other line touched. While `MARKETPLACE_SOURCE` is not a concrete `owner/repo` (the `<owner>` placeholder until Task 28), the edit is skipped with a note and nothing is recorded. Tests supply an owner via `REVIEW_LOOP_TEST_MARKETPLACE_SOURCE` (honored only with `REVIEW_LOOP_TEST_SEAMS=1`). A `CLAUDE.md` over 1 MiB is not edited, with a note.
  - Refused before any change: an archive target (`review-loop-legacy-<date>/skill` or `/engine`) that already holds a folder (`migration_archive_occupied`), and a record that this run could push past 64 steps (`migration_record_full`; `record()` enforces the cap too).
  - The archive date is the user's local date. When doctor fails, the record stays `in_progress` (the engine step is pending), no "Migrated" line is printed, and `preflight_failed` says how to finish or undo.
  - Rollback under a different `CLAUDE_CONFIG_DIR`: a record that would be valid if the config dir were one other dir (every recorded hook names that same dir, in the exact legacy form, and it is a real directory this user owns) exits 1 `migration_config_dir_mismatch` naming that dir, and is left in place. Anything else invalid is still quarantined, and rollback still restores only hooks naming the CURRENT config dir. The placeholder-owner CLAUDE.md skip prints the exact hand edit (`` `~/.claude/review-loop/CLAUDE.md` `` → ``the `review-loop` plugin (`review-loop doctor`)``).
  - The config step records its after-sha (from `fsutil.jsonText`, the exact text `atomicWriteJson` writes) before the write. Rollback of a half-done pin move removes the copy only when it and the original both hash to the recorded pin, and says so.
  - Test seams `--skip-doctor-gate` / `--force-engine-move` are accepted only with `REVIEW_LOOP_TEST_SEAMS=1`; otherwise they are `usage_bad_flag` (refused by `badUsage` in `cli/review-loop.mjs`, with the other seam flags).
- CI and sabotage (Task 25):
  - `ci.yml` (push to `main`, and pull requests; a newer run cancels an older one on the same ref): matrix `macos-14` (arm64) × `macos-15-intel` (x64) × Node {Homebrew's current, `22.x`}, plus one `macos-14` leg at the exact floor `22.0.0` (`engines >=22`, the CLI's `MIN_NODE = 22`, spec D2). Jobs: `npm test`, `npm test` again with fresh `mktemp -d` `HOME`/`CODEX_HOME`, `content-gate` (packaged set) and `content-gate --tracked`, both with the `CONTENT_GATE_DENYLIST` secret when available, `docs:check`, plus `plugin-validate`. CI sets `TEST_CONCURRENCY: 2` (`npm test` reads `${TEST_CONCURRENCY:-4}`), and the merge test helpers pass `deadlineMs: 120_000` so a slow runner doesn't trip the 30 s production budget (tests that pin budget semantics pass their own small deadlines). `settings.mjs`'s `TOOL_TIMEOUT_MS` (10 s, ps/lsof) has no test seam, so an overloaded machine can still fail the uninstall/migrate tests that shell out to them. Actions are pinned by commit SHA (checkout and setup-node v4.4.0, SHAs checked against the tags with `git ls-remote`). If `macos-15-intel` is retired use `macos-26-intel`; with no Intel label, Node under Rosetta (`arch -x86_64`) on `macos-14`. The README states this, and `test/contract/readme.test.mjs` fails if the README doesn't name every Intel label in ci.yml's `os` matrix or drops the Rosetta fallback.
  - plugin-validate (CI): not verified locally whether it needs auth — the first CI run decides; if it prompts for auth, delete the job per Task 25's fallback and keep validation local (docs/RELEASE.md). The `claude` CLI there is CI-only, pinned to `@anthropic-ai/claude-code@2.1.285` (= `MIN_CLAUDE`), never a package dependency.
  - `scripts/sabotage-registry.mjs` is the extension point for a new load-bearing gate: add one row (`find` must match exactly once; `expect` is a literal substring of the test NAME as written in the test file, so a template-built name can only be matched by its literal part), then add the row's `file` AND `test` to BOTH `sabotage.yml` `paths` lists (`on.push` and `on.pull_request`; the test parses them structurally, so a commented-out or `paths-ignore` entry doesn't count). `test/contract/sabotage-registry.test.mjs` fails until both are done, and on a `find` a refactor made stale. A gate enforced in two places in one file takes a second edit, `also: { find, replace }`, applied and restored with the first (`merge-identity` is the one user).
  - `scripts/sabotage.mjs` (`npm run sabotage`, `--only <id>`): per row, baseline green, apply the break as a byte splice, require a `not ok … <expect>` line, restore in `finally` and compare bytes. Every read and write goes through an `O_NOFOLLOW` descriptor whose inode/device must match what `checkTarget` recorded. `checkTarget` also refuses a file with another hard link (`nlink !== 1`), and a break is never written into a file that has gained one. The restore is still allowed through a link gained mid-run (it writes the original bytes into the same checked inode) and prints `WARN <file> gained N hard link(s)`: on the author's Mac, Google Drive for desktop (syncing `~/Code`) hard-links every file it sees change into `~/Code/.tmp.driveupload/` while it uploads, and refusing the restore left the break in the repo. Before `checkTarget` and again before writing the break, the runner waits (up to 120 s, `WAIT <file>` printed) for such a link to go away, then refuses if it hasn't. The sync tool uploads the broken bytes briefly; the restore re-uploads the original. Stops at once (exit 1) on a stale `find`, a refused path, a file swapped before the break is written (`FAIL identity-changed <file>`, nothing written), or a failed restore (`FAIL restore <file>`). The loop is async (`spawn`, not `spawnSync`) so SIGINT/SIGTERM/SIGHUP handlers run mid-row: they abort the running test, the row is restored, and the run exits 130 (`EXIT_INTERRUPTED`) printing `INTERRUPTED <id>`. Each `node --test` runs in its own process group, SIGKILLed whole on abort or timeout, so a test file's spinning `spawnSync` child is never orphaned (final review L2; rows `sabotage-group-kill`, `sabotage-sighup`); `merge-bypass`'s latency child also runs under `ulimit -t 30` with `killSignal: SIGKILL`; a test run ended by any signal other than the runner's own 10-minute timeout counts as an interrupt, never as a verdict. Child `node --test` runs drop `NODE_TEST_CONTEXT` (inherited under a test runner it makes the child exit 0 with no TAP). Run it only when nothing else is running the tests: it edits guarded files in place for the length of one test file.
- Release (Task 26):
  - `scripts/bump-version.mjs X.Y.Z` stamps `package.json`, `plugin/.claude-plugin/plugin.json`, the `review-loop` entry of `.claude-plugin/marketplace.json` and the `VERSION="…"` line of `plugin/bin/hook`. Every target is lstat-checked (regular, not a link, inside the repo) and every new text computed before the first write; each write is temp-then-rename in the same directory with the original mode (the shim stays executable). JSON files are rewritten with 2-space indentation, so the first bump reflows the one-line objects. `scripts/release-check.mjs X.Y.Z` exits 0 only if all four equal the tag, 1 naming each file that differs, 2 for a tag that is not X.Y.Z (so the tag is safe in the workflow's paths and sed).
  - `brew test` runs selftest inside Homebrew's sandbox (Homebrew 7: `deny_read_home`, no network, `TMPDIR=/private/tmp`, HOME = the test dir), where `git` on PATH is Homebrew's `shims/shared/git`. That shim exits 1 without `HOMEBREW_LIBRARY`, which selftest's rebuilt environment drops, so v1.0.0's tap test failed at `git init`. Since v1.0.1, selftest resolves the real binary via `git --exec-path` with the full environment and puts a `git` wrapper first on its own PATH. Reproduce without installing: `brew ruby` with Homebrew's `Sandbox` (`allow_write_temp_and_cache`, `deny_read_home`, `deny_all_network`) around `node cli/review-loop.mjs selftest`, from a copy outside $HOME. v1.0.0 is a GitHub release only and never reached the tap.
  - `release.yml` has two jobs. `release` (contents: write): release-check, the tagged commit is on `origin/main`, the content gate (packaged set, then `--tracked`, both `--require-private` with the `CONTENT_GATE_DENYLIST` secret), `npm test`, sabotage, the tarball, the GitHub release (`--generate-notes`; there is no CHANGELOG) and `claude plugin tag plugin --push` (flag verified with `--help`; whether it needs sign-in on a runner is unverified, see docs/RELEASE.md). `tap-bump` (the only reader of `TAP_PR_TOKEN`, `environment: release`, `permissions: {}`) writes the formula whole from the release job's `tap-formula.mjs` output (base64 job output; this job has no checkout), checks its sha256 line, and opens the tap PR. The tap's CI treats a missing base formula as the first release. The tarball list is captured as its own statement (`FILES="$(node scripts/content-gate.mjs --list)"`) in a `shell: bash` step under `set -euo pipefail`, guarded non-empty, split on newlines only, then the extracted file set is diffed against it and re-gated with `--dir`. `test/contract/release.test.mjs` pins all of this.
  - **Never a bare `process.exit()` after writing output** (CLI, scripts, test fakes): on macOS a stdout/stderr pipe is asynchronous, and an immediate exit truncated piped output (`content-gate --list` gave 25 or 42 of 55 files; `doctor --json | wc -c` gave 512 or 1024 of ~2.8 KB; `help 2>&1` gave 512 of 775). Set `process.exitCode` and let Node drain; an early usage exit throws a sentinel caught at the entry point. The one exception is the CLI's SIGINT path, which must stop a command mid-flight: `exitAfterDrain` sets the code and exits once both streams flush (bounded at 2 s). After SIGINT, `finish()` ignores a later non-cancelled result, so exactly one `cli.exit` is written. The CLI sets `proc.mjs`'s `setSignalMode("reap-only")`: the reaper (prepended, so it runs first) still SIGKILLs running tool groups but does not re-raise a signal another listener handles, so Ctrl-C mid-tool exits 3, not 130 (final review M1); a signal nothing else handles (SIGTERM, SIGHUP) is still re-raised. The engine keeps the default `reap-and-reraise`, which removes any other listener before re-raising so it always dies of the signal. Pinned by T-OBS-2's tool-running case (sabotage row `cli-sigint-reap-only`) and `proc.test.mjs`. Pinned by pipe tests in `content-gate.test.mjs` and `skeleton.test.mjs` and sabotage rows `content-gate-list-pipe` and `cli-pipe-drain`.
  - The `<owner>` placeholder: `release.test.mjs` lists every file in Task 28's sed scope that holds it, split into files to substitute and files where it is literal text (`plugin/engine/lib/cmdparse.mjs`, `scripts/content-gate.mjs`, each pinned to its exact lines), which Task 28 must exclude from its sed. A new occurrence anywhere, including a new line in a literal file, fails the test until it is classified.
  - Workflow credentials: the release checkout has `persist-credentials: false`; only the `GitHub release` and `Plugin tag` steps get `github.token`, and every clone or push authenticates through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0=http.https://github.com/.extraheader`/`GIT_CONFIG_VALUE_0` (env, masked), never a token in a URL, argv or `.git/config`. The tap CI job sets `HOMEBREW_NO_AUTO_UPDATE: 1`. The formula needs Homebrew >= 6.0.3 (`formula_opt_bin`).
  - The marketplace is not pinned to a git ref (`MARKETPLACE_SOURCE` has none; the entry's source is `./plugin`), so branch protection on `main` is the control (spec §9). `docs/SECURITY.md` says so, and `readme.test.mjs` fails if either half changes without it.

## Probes

| Probe | Date | Verdict | Evidence |
|---|---|---|---|
| P1 plugin hook parity | 2026-09-28 | pass | `docs/probes/P1-2026-09-28.md` |
| P5 non-blocking warnings | 2026-09-28 | pass | `docs/probes/P5-2026-09-28.md` |
| P2 per-review Codex effort | 2026-09-28 | fail mechanism=none (adversarial-review ignores --effort; --effort exists only on task, which the engine does not use) P2.efforts=none,minimal,low,medium,high,xhigh decision=display-only | `docs/probes/P2-2026-09-28.md` |
| P3 skill root substitution | 2026-09-28 | pass (absolute ROOT=/... substituted by a dependency-free plugin; path is the marketplace source dir for a local marketplace) decision=use ${CLAUDE_PLUGIN_ROOT} | `docs/probes/P3-2026-09-28.md` |
| P4 dependency auto-install | 2026-09-28 | fail (dependencies field accepted but not auto-installed, with or without the openai-codex marketplace added) decision=explicit Codex install | `docs/probes/P4-2026-09-28.md` |
| P6 running-session detection | 2026-09-28 | pass fail-safe (ruling R-P6: overcount OK, undercount unsafe; headless -p, stream-json and mcp serve are COUNTED; only pure helpers daemon/bg-pty-host/bg-spare/--chrome-native-host excluded; executable matched on full args as (^\|/)claude( \|$) or /claude-code/cli.js; no tty required; robust count 3 with 3 sessions open, same result as the earlier 2 to 3 N+1 run; naive pgrep -x claude is unreliable) P6.cmd=see scripts/probes/p6-sessions.sh | `docs/probes/P6-2026-09-28.md` |
| P7a match-head-commit | 2026-09-28 | rejected, mechanism unconfirmed: GitHub text 'Base branch was modified'; no matching-head control was run. Task 13 always re-checks headRefOid (ruling R-P7a) | `docs/probes/P7-2026-09-28.md` |
| P7b base-scoped required check blocks retarget | 2026-09-28 | pass P7b=CLEAN then BLOCKED (private repo protection worked) | `docs/probes/P7-2026-09-28.md` |
| P7-auto --auto with stale head | 2026-09-28 | pass P7-auto=bound (rejected, no autoMergeRequest armed) | `docs/probes/P7-2026-09-28.md` |
| P7-mcp GitHub MCP merge tool | 2026-09-30 | verified from source: headField=expectedHeadSha (github/github-mcp-server@5a1a386, maps to the REST merge `sha`); live payload uncaptured | `docs/probes/P7-2026-09-28.md` |
| e2e | 2026-09-30 | pass (attempt 2, after the probe re-sign-in; attempt 1 failed at Claude auth, $0). Isolated config (`CLAUDE_CONFIG_DIR` = the probe home), Claude Code 2.1.285, codex plugin 1.0.6, review-loop 0.1.0 from the working tree (6cc9d58). Round exit 10 (needs_fixes, mean 9.26, Verifiability 6.9, 1 finding), then `override`; Stop blocked (pending 1) → allowed (`reviewed`, pending 0) in the SAME resumed session; no broker from the round's snapshot survived. Spend: session 1 $0.110, session 2 $0.119 (sonnet), one Codex round. Before any spawn the test refuses a `CLAUDE_CONFIG_DIR` that is unset, missing, not a directory, or the real `~/.claude` (realpath or inode). Children get no `CLAUDE*` (except `CLAUDE_CONFIG_DIR`), `ANTHROPIC_*`, `CODEX_COMPANION_*` or `REVIEW_LOOP_*` variables; `REVIEW_LOOP_E2E_KEEP_API_KEY=1` keeps `ANTHROPIC_API_KEY` alone | `test/e2e/live.test.mjs`, guards in `test/e2e/isolation.mjs` (tested free by `isolation.test.mjs`) |
| published | 2026-10-03 | v1.0.1 is the first tap release (`brew install MostViableProduct/tap/review-loop`, tap PR #3). v1.0.0 is a GitHub release only: its tap PR #2 failed `brew test` (Homebrew's git shim, fixed in 1.0.1) and was closed. Deferred work is in issues #4–#16. Both tags verify with `docs/allowed_signers` | GitHub releases v1.0.0 and v1.0.1, MostViableProduct/homebrew-tap |

### Live e2e record (Task 27, 2026-09-30)

- `npm run e2e` runs only with `CLAUDE_CONFIG_DIR` set to the isolated probe config, after `claude plugin install codex@openai-codex --scope user` (P4: not auto-installed) and the working-tree marketplace install of `review-loop@review-loop`. The test pins the installed Codex plugin into its temp state dir (R-D8b), strips the parent session's `CLAUDE*` (except `CLAUDE_CONFIG_DIR`), `ANTHROPIC_*` (unless `REVIEW_LOOP_E2E_KEEP_API_KEY=1`, which keeps `ANTHROPIC_API_KEY` only), `CODEX_COMPANION_*` and `REVIEW_LOOP_*` variables from every child (an inherited `CLAUDE_PLUGIN_DATA` would point the companion at the parent's real plugin data), runs `claude` with `--model sonnet`, and adds a test-side `--settings` hook that records only the key NAMES of the Stop and PostToolUse(Write) hook input.
- `claude auth status` reported `loggedIn: true` for a token that then failed to refresh; it does not prove the session works. After the failed refresh it reports `loggedIn: false`.
- `claude plugin install … --scope user` was accepted on Claude Code 2.1.285 (`codex@openai-codex` and `review-loop@review-loop`, both listed `enabled: true`).
- Free rehearsal of the round step (installed engine, temp state with a written pin, EMPTY `CODEX_HOME`): exit 30 `codex_failed`, message `codex companion exited 1: no stderr`, which `classify` reads as `unknown`. The companion (1.0.6) puts Codex's error only in its stdout JSON `parseError` (`unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, …`) and exits 1 with empty stderr, and the round dropped that text, so a signed-out Codex showed as `unknown`, not `codex_auth`. Fixed in Task 27a:
  - `companionFailureText` (`lib/pin.mjs`) takes stderr when non-empty (tail), else the stdout JSON's `parseError`, `error`/`error.message` or `codex.stderr` (head), else the stdout tail; always capped at 2 KiB of UTF-8.
  - The round prints it as `error.output` on a `codex_failed` result only. It is Codex's own text: it never goes into an event, a record (`lastError.message` is now just `codex companion exited N; …`) or a marker. The e2e test scans the whole state dir for it; T-SET-9b checks setup and `doctor --live` read it as `codex_auth` / `codex login` with no event holding it (sabotage row `codex-failure-text`).
  - The classifier matches 401 only as an HTTP status (`(HTTP|status|code)[\s:/]*401`, `401 Unauthorized`) plus `unauthorized`, `not logged in` and `codex login`: the round output also carries a hex key and temp paths (`/tmp/rl-e2e-401-x`) where a bare `401` can occur.
  - The 2 KiB cut is on a UTF-8 character boundary (continuation bytes skipped at the tail, backed off at the head), so the excerpt never exceeds 2048 bytes and never starts or ends with U+FFFD.
  - Re-run of the free rehearsal on the real companion: exit 30 `codex_failed`, `error.output` = the 401 line, classified `codex_auth`, no state file holding it.
- Real Codex error lines (codex-cli 0.159.0, empty `CODEX_HOME`) are pinned in T-SET-6 (`test/cli/livecheck.test.mjs`): the 401 line from `codex exec` and the companion's `parseError`, and `Not logged in` from `codex login status`. With no auth, a bogus `-m` model and `-c model_reasoning_effort=turbo` both fail on the same 401, so no real `model_invalid`/`effort_invalid` line was captured.
- Hook-input KEY shapes observed live (attempt 2; names only, sorted, recorded by the test-side `--settings` hook):
  - Stop: `background_tasks`, `cwd`, `effort`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`, `transcript_path` (3 Stops: the block, the `stop_hook_active` re-stop, the resumed session's).
  - PostToolUse(Write): `cwd`, `duration_ms`, `effort`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_response`, `tool_use_id`, `transcript_path`; `tool_input`: `content`, `file_path`; `tool_response` (an object): `content`, `filePath`, `originalFile`, `structuredPatch`, `type`, `userModified`.
  - The engine reads `session_id`, `cwd`, `stop_hook_active`, `tool_input.file_path`, `tool_name` and `tool_response`: all present.
- Not exercised: the MCP `create_pull_request` response and `merge_pull_request` schema (no GitHub MCP server in the probe config).
- `~/.codex` during attempt 2 (names, sizes, mtimes only; contents never read): nothing added; one removed (`shell_snapshots/<id>.sh`); 30 changed, all at 22:34:34–22:35:10Z, the round's Codex run: `logs_2.sqlite`(-wal), `state_5.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`, `queue_1.sqlite-wal`, `models_cache.json`, `tmp/arg0`, `cache/codex_apps_*`, `cache/remote_plugin_catalog/*`, `plugins/cache/*-remote/*/.codex-remote-plugin-install.json` and their directories. All are written by the Codex CLI itself (the companion runs `codex` with the default `CODEX_HOME`); none is a path review-loop writes.
