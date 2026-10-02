# review-loop: Homebrew distribution — design spec

- **Status:** Draft for review (v1)
- **Date:** 2026-09-28
- **Scope:** Package the existing Claude Code ↔ Codex adversarial review loop so a semi-technical macOS
  user can `brew install` it, run one guided setup, and get Codex adversarial review enforced inside the
  Claude Code CLI.
- **Approach (chosen):** B — plugin-first. Homebrew ships a CLI; a Claude Code plugin ships the hooks,
  skill and engine.
- **Legend:** 🖊 marks a row or decision where the author's input is requested. Each 🖊 carries a
  suggested default, which applies unless the author changes it.

---

## 0. Background: the review loop today

The review loop is a single-user install at `~/.claude/review-loop/` (not a git repo). It is made of
three parts:

1. **An engine** (Node, no dependencies): `review-round.mjs`, `review-gate-hook.mjs` and 15 modules in
   `lib/`, with 186 passing tests. It:
   - detects changed specs, plans, implementations and PRs;
   - runs one Codex round per call through the OpenAI `codex@openai-codex` plugin's
     `codex-companion.mjs adversarial-review --wait --json`, pinned by sha256 in `plugin-pin.json`;
   - scores 11 dimensions against a 9.2 gate (mean ≥ 9.2 and every dimension ≥ 9.2);
   - manages checkpoints, stalls, disputes and overrides;
   - writes `events.jsonl`.
2. **Hooks** in `~/.claude/settings.json`: six entries across five events, all running
   `node /Users/<me>/.claude/review-loop/review-gate-hook.mjs <mode>`. The entries are:
   - `PreToolUse` Bash → `pr`, timeout 40;
   - `PreToolUse` `mcp__.*__create_pull_request` → `pr`, timeout 40;
   - `SessionStart` → `session`, timeout 20;
   - `PostToolUse` `Write|Edit|MultiEdit|NotebookEdit` → `track`, timeout 5;
   - `Stop` → `stop`, timeout 20;
   - `UserPromptSubmit` → `prompt`, timeout 5.
3. **A skill** at `~/.claude/skills/review-loop/SKILL.md`. It drives rounds, fixes, disputes and paging.
   `permissions.ask` holds five rules, so that overrides and the kill switch always prompt a human.

Recent hardening (all tested, including sabotage-tested):

- symlink-safe reads and writes anchored by `within`;
- a private state dir (uid match and 0700);
- lock compare-and-swap (CAS);
- process-group kill with a signal reaper;
- pflag-accurate parsing of `gh api` arguments, closing the repeated `-X` bypass;
- a linear `gh` scan;
- a Stop scan that fails closed.

Two review loops passed: loop 1 by logged override at round 29, and loop 2 at 9.50.

**Coupling that blocks distribution:**

- absolute hook paths;
- `DEFAULT_RULES_PATH` pointing at a personal rules file whose Usability text references a personal
  a11y system;
- the pin stored beside the engine;
- the instructions living in the author's global `CLAUDE.md`;
- no repository, releases or CI.

## 1. Goals, non-goals, audience

**Goal.** After `brew install` and `review-loop setup`, a user's Claude Code sessions have the same
enforced Codex review the author has today. The level of enforcement is chosen from a preset, and the
Codex model and effort are chosen at setup.

**Audience.** Semi-technical macOS users. They can paste a terminal command and follow a prompt. They
should never have to hand-edit JSON, understand hooks, or read the engine.

**Non-goals (v1).** Everything under §15 Deferred.

## 2. Acceptance criteria (final, agreed)

Each criterion (AC) is verified by the Gherkin scenarios in §12 and the TDD rows in §11. The
traceability matrix is §13.

| ID | Criterion |
|---|---|
| AC-1 | On macOS 14+ (arm64 and x86_64), `brew install <owner>/tap/review-loop` installs the CLI and pulls `node` and `git`. The caveats name `review-loop setup`. |
| AC-2 | `brew install`, `brew upgrade` and `brew uninstall` change nothing under `~/.claude` or `~/.codex`. |
| AC-3 | `review-loop setup` is interactive and plain-language. Before every change it says what will change and why, and asks. |
| AC-4 | The preflight shows ✓/✗ for Claude Code, Codex CLI, Codex sign-in, the Codex plugin and `gh` (optional). Each ✗ gets a fix offer and a re-check. |
| AC-5 | Presets are **Default**, **Balanced** and **Advisory**, chosen at setup and changeable with `review-loop config`. |
| AC-6 | Codex **model** and **effort** are chosen at setup and changeable with `config`. Defaults are inherited from Codex. Every round uses the chosen values and records them. The global Codex config (`~/.codex/`) is never modified. An invalid value fails the live check with a clear message. |
| AC-7 | `settings.json` gets only our entries, with a backup first. `env` values are never printed. Writes are idempotent. |
| AC-8 | The Codex plugin version is shown and pinned. Drift pages the user (the existing re-pin flow). |
| AC-9 | Setup ends with a live Codex review. On failure it names the broken link. |
| AC-10 | After setup, the preset is enforced in every repo. **Default** is byte-for-byte today's behavior, **plus** the AC-23 PR-head binding, which is the only intended change. |
| AC-11 | Hooks survive `brew upgrade` and plugin updates. `doctor` flags version skew between the CLI and the plugin. |
| AC-12 | The kill switch, the "skip review" override and the `permissions.ask` approval prompts are preserved. |
| AC-13 | `review-loop doctor` diagnoses every known broken state and prints the exact fix command. |
| AC-14 | `review-loop uninstall` removes only our entries and our skill, asks about history, and leaves no dangling hooks. **The supported order is `review-loop uninstall`, then `brew uninstall review-loop`**, stated in the caveats, the README and `brew uninstall`'s own caveats output. If the formula is removed first: no hook dangles (the engine lives in the plugin), `doctor`-equivalent guidance is printed by the plugin's `SessionStart` hook ("review-loop CLI missing; to finish uninstalling: `claude plugin uninstall review-loop@review-loop`"), and the README gives the full recovery: `brew install <owner>/tap/review-loop && review-loop uninstall && brew uninstall review-loop`. |
| AC-15 | CI runs on macOS for every push and PR. |
| AC-16 | Release automation builds the tarball and sha256 and opens a PR on the tap. `brew test` runs a real smoke check (`review-loop selftest`). |
| AC-17 | Nothing personal ships. A build gate enforces this. |
| AC-18 | The author's Mac is migrated with a backup, preserved history and a personal-rubric override. |
| AC-19 | The README has a five-minute quickstart, troubleshooting generated from the code registry, and a cost and privacy note. |
| AC-20 | The package passes its own loop at 9.2 for the spec, the plan, the implementation and the release PR. |
| AC-21 | **Machine-readable outcomes.** Every CLI command, hook decision and review round appends one schema-v1 JSONL event to a documented file. Each event carries a stable `code` and, for commands, the exit code. A log shipper or backend can collect them without parsing human output. **Degraded mode, stated:** when the event destination cannot be written, the decision is unchanged, one content-safe stderr warning is printed, and `doctor` reports `events_writable` ✗. It is never silent. *(Added in design section 3.)* |
| AC-23 | **A PR is bound to the commit that was reviewed.**<br>(1) After a PR is created, a hook compares the PR's head commit with the reviewed SHA. On a mismatch, with `gh` available, it converts the PR to draft **and verifies** the conversion, closing the PR (also verified) if the conversion fails. It then **stops Claude** (`continue:false`) and logs an event. Without `gh`, it stops Claude with a loud "unreviewed PR #n is open" reason; this degraded state is shown by `doctor`.<br>(2) A passing PR review posts a commit status whose **context names the base branch**, `review-loop/<baseBranch>`, on the exact reviewed SHA. Branch protection on base `X` requires `review-loop/X`. A new head SHA, or a retarget to another base, therefore lacks the required check server-side.<br>(3) **A merge gate** (PreToolUse; Default and Balanced presets) allows an agent-issued merge only when it is **commit-bound** and **context-bound**. The merge must name a head SHA (`--match-head-commit`, the API `sha` field, or the MCP tool's head-binding field). The PR's own review identity — base repo and branch, head repo and branch — must have a passed review whose fingerprint equals `<that SHA>:<its merge-base with the PR's current base>`. GitHub itself then refuses the merge if the head has moved. A single Bash call that both creates and merges a PR is denied.<br>**Guarantee, stated precisely:**<br>**Scope of the gate: a guardrail, not a sandbox.** The gates cover the agent's standard GitHub interfaces:<br>• the `gh` CLI, including `gh api`;<br>• the GitHub MCP create-PR and merge tools;<br>• a best-effort denial of direct REST calls in Bash (`curl`, `wget`, `http` or `xh` against `api.github.com/…/pulls` or `…/merge`), code `pr_github_api_unsupported_client`, fix "use `gh`".<br>An arbitrary program (a script, another MCP server) that talks to GitHub itself is **outside** the gate. **Branch protection (2) is the control for everything outside it.**<br>• Under **Default and Balanced**, a merge issued through a **gated interface** can't land an unreviewed head commit in any repo; GitHub enforces the head binding (3).<br>• **The base context is enforced server-side only where branch protection requires `review-loop/<base>` (2).** In such repos, neither the head nor the base context of any merge (agent-issued or not) can be unreviewed, **under the trust assumption below**.<br>• **Trust assumption for (2).** A commit status can be posted by anyone with write access, and the statuses are posted with the user's own `gh` token, so branch protection can't restrict their source to an app. The guarantee therefore assumes **collaborators with write access don't forge `review-loop/*` statuses**. It protects against the agent and against races, not against a malicious collaborator. A source-restricted check (a GitHub App check run that rulesets can require by app) is deferred (§15 #11).<br>• In a repo **without** that protection, the gate checks the PR's base at gate time, but GitHub does not bind the merge to that base. A retarget landing between the gate's check and GitHub processing the merge can therefore merge the reviewed head into an unreviewed base context. The retarget could come from a human, another tool, or the agent in a separate call. This residual race is accepted for unprotected repos, and the README and setup's summary recommend enabling the protection.<br>• Under **Advisory**, which by definition blocks nothing (§5.2), agent merges are warned, not blocked. Only branch protection (2) prevents them, and setup's Advisory description says so.<br>• **Merges outside Claude Code** (the GitHub UI, other tools) are prevented only in repos whose branch protection requires `review-loop/<base>` (2).<br>• A PR *opened* with an unreviewed head is detected, contained (draft or closed, when `gh` is present) and stops the session (1). | *(Added at spec review round 4 by the author's decision, 2026-09-28.)* |
| AC-22 | **Deferred scope is tracked.** Once the repo is created, published and pushed, every §15 item exists as a GitHub issue labelled `deferred`, and each issue links back to this spec. *(Added at spec time.)* |

## 3. Architecture

### 3.1 Repositories (MIT)

```
<owner>/review-loop                       the product; also its own Claude Code marketplace
├── .claude-plugin/marketplace.json       marketplace "review-loop" → plugin source ./plugin
├── plugin/
│   ├── .claude-plugin/plugin.json        name "review-loop", version X.Y.Z, depends on codex@openai-codex
│   ├── hooks/hooks.json                  today's 6 entries + 2 PostToolUse `prverify` + 1 PreToolUse MCP-merge entry (§7.1) → "${CLAUDE_PLUGIN_ROOT}/bin/hook" <mode>
│   ├── bin/hook                          POSIX sh shim: locate node, fail loud if absent (§6.3)
│   ├── engine/                           today's engine (review-round.mjs, review-gate-hook.mjs, lib/)
│   │   └── lib/codes.mjs                 NEW: code registry (§8.3)
│   ├── rubric/default.md                 generic 11-dimension rubric (no personal content)
│   └── skills/review-loop/SKILL.md       today's skill + the instructions from the author's CLAUDE.md
├── cli/
│   ├── review-loop.mjs                   entry: setup | config | doctor | update | uninstall | migrate | selftest
│   └── lib/                              settings writer, preflight, doctor checks, prompts
├── test/                                 engine tests (moved) + CLI, contract, plugin-shape tests
├── scripts/                              content gate, release helpers, probe scripts
├── docs/probes/                          Phase 0 probe evidence
├── CLAUDE.md, AGENTS.md -> CLAUDE.md     stack + invariants
└── .github/workflows/{ci,release}.yml

<owner>/homebrew-tap
├── Formula/review-loop.rb                depends_on "node", "git"; installs cli/ + plugin/engine to libexec; bin shim; caveats
└── .github/workflows/tests.yml           brew style, brew audit --strict --online, install + brew test
```

### 3.2 Ownership: the single authoritative statement

| Thing | Owner | Written by | Location |
|---|---|---|---|
| `review-loop` CLI binary | Homebrew | `brew install/upgrade/uninstall` | `$(brew --prefix)/opt/review-loop` |
| Hooks, engine, skill, default rubric | Claude Code plugin system | `claude plugin install/update/uninstall` | `~/.claude/plugins/cache/review-loop/…` |
| `permissions.ask` rules (five strings, §6.2) | `review-loop` CLI | setup, migrate, uninstall | `~/.claude/settings.json` |
| User config (preset, model, effort, rubricPath, events.path) | `review-loop` CLI | setup, config | `configPath()`: `$REVIEW_LOOP_CONFIG` if set, else `$XDG_CONFIG_HOME/review-loop/config.json` if `XDG_CONFIG_HOME` is set and absolute, else `~/.config/review-loop/config.json`. Mode 0600. |
| State: markers, baselines, records, locks, pin, `events.jsonl` | Engine | hooks, rounds, setup (pin only) | `~/.claude/state/review-loop/` (0700). The pin moves here as `plugin-pin.json`. |
| Codex model/auth defaults | Codex | **never us** | `~/.codex/` is read-only to this product |

**Dependency direction** is one-way: `cli/` → `plugin/engine/lib/`. The CLI imports the engine code
shipped in its own tarball, never the installed plugin's copy. `engine/` never imports `cli/`. Enforced
by T-SHAPE-3.

**Version contract.** The CLI and plugin share one version (`X.Y.Z`). They are compatible when
`X.Y` matches. `doctor` fails on a mismatch (T-DOC-7).

### 3.3 Why these boundaries

- **Homebrew must not write to `$HOME`** (AC-2); Homebrew's own guidance forbids it. So everything under
  `~/.claude` is done by an explicit, user-run `setup`.
- **Plugins cannot set permissions or contribute `CLAUDE.md` text** (verified by research). So the CLI
  owns `permissions.ask`, and the instructions move into the skill.
- **Cleanup order doesn't matter.** Hooks point at `${CLAUDE_PLUGIN_ROOT}`, which lives as long as the
  plugin does. `brew uninstall` removes only the CLI, so no hook can dangle (AC-14).

## 4. Phase 0 probes (run before any implementation task depends on them)

These are external-behavior assumptions. Each has a mechanical pass criterion, saved evidence and a
stated fallback.

| Probe | Question | Mechanical pass criterion | Fallback if false |
|---|---|---|---|
| **P1** (hard gate) | Do plugin hooks have blocking parity with `settings.json` hooks, and does `PostToolUse` `continue:false` stop Claude? | A throwaway plugin is installed from a local-directory marketplace, then `claude -p` runs headless. **PostToolUse:** after a probe tool call, the hook returns `{"continue":false,"stopReason":"probe-stop"}`. The stream-json run ends with `probe-stop`, and no further tool call follows (a second sentinel command in the prompt never runs). **Shim path:** the real plugin, with `REVIEW_LOOP_NODE_CANDIDATES=/nonexistent` and a `PATH` without node, and a fake `gh` whose `pr create` succeeds. The session stops with the node-missing `stopReason` after the PR-create command. **Stop:** the hook's counter file reads `2`, the second call saw `stop_hook_active:true`, and the first returned `decision:block`. **PreToolUse:** Claude is asked to run `touch <sentinel> # probe-deny`; the hook returns `permissionDecision:deny`; the sentinel is **absent**, and the stream-json shows the denial reason. | **Page the author** to choose approach A (the CLI writes absolute-path hooks into `settings.json`) or C (hybrid). No fallback is chosen automatically. |
| **P2** | Can Codex effort be set per review without writing `~/.codex/config.toml`? | Candidate mechanisms, in order: (a) a companion flag; (b) forwarding a `-c model_reasoning_effort=<e>` override (Codex supports `-c`, verified) through whatever the companion launches; (c) an env var the companion forwards. **Pass:** the newest `~/.codex/sessions/**` log records the requested effort, **and** the sha256 of `~/.codex/config.toml` is unchanged. | Effort becomes display-only ("inherited from Codex: high"). Setup and `config` say so, and the **author is paged** to accept amending AC-6. Model selection is unaffected: the companion accepts `--model`, as verified in the 1.0.6 source. |
| **P3** | Is `${CLAUDE_PLUGIN_ROOT}` substituted inside plugin **skill** text? | A skill containing `echo ${CLAUDE_PLUGIN_ROOT}` shows an absolute path when Claude runs it. | The skill uses `RR="node $(review-loop engine-path)/review-round.mjs"`. `engine-path` resolves the installed plugin's `installPath` from `claude plugin list --json`. |
| **P4** | Does `plugin.json`'s dependency on `codex@openai-codex` auto-install the dependency, including its marketplace? | On a clean `HOME`, `claude plugin install review-loop@review-loop` leaves `codex@openai-codex` listed in `claude plugin list --json`. | Setup's preflight installs it explicitly (`claude plugin marketplace add openai/codex-plugin-cc` then `claude plugin install codex@openai-codex --scope user`). This path exists in setup regardless. |
| **P5** | Are non-blocking warnings (`systemMessage`) from Stop and from PreToolUse-allow shown to the user? | In a headless stream-json run, the `systemMessage` text appears in the output events, and the stop and tool call proceed. | Balanced and Advisory warnings go through `UserPromptSubmit` `additionalContext` on the next turn, plus events. The README states that warnings show on the next prompt. |

| **P6** | Does `pgrep -x claude` list every running Claude Code session: the CLI, the IDE extension host and the desktop app's CLI sessions? | With one CLI session, one VS Code session and none, `pgrep -x claude` returns the matching PID count. Verified for the CLI at spec time: two running sessions were listed. | Detect sessions via a broader match (`pgrep -f` on the Claude Code install path). If that is also unreliable, ask the user to confirm that Claude Code is closed. The interactive prompt is shown regardless. |

| **P7** | Do GitHub-side merge bindings reject a moved head? What is the MCP merge tool's head-binding field? | In a throwaway private repo: open a PR at commit A, push B, run `gh pr merge <n> --match-head-commit A` → it fails and the PR stays open. With `--auto`: record whether the expected head is bound. For each GitHub MCP server in use, record the `merge_pull_request` input schema from `tools/list` and store it as `test/fixtures/mcp-merge-schema.json`. If a head field exists, a stale-head merge through it is rejected. **P7b:** with branch protection requiring `review-loop/main` on `main` and `review-loop/release` on `release`, retarget a PR whose head carries only `review-loop/main` to `release`. The PR is not mergeable in the API (`mergeStateStatus` is `BLOCKED`). | `--match-head-commit` not enforced → the gate also re-checks `headRefOid` right before allowing, and AC-23 states the residual race. P7b failing → **page the author**, since the server-side guarantee in AC-23 (2) would not hold. No MCP head field → `pr_merge_mcp_unbindable`, as in the table. |

Evidence goes to `docs/probes/P<n>-<date>.md`, containing the command, relevant output and verdict. It
also goes to the repo's `CLAUDE.md`. **P1 and P5 are re-run by the release checklist** (§10.3), because
Claude Code can change hook semantics.

## 5. Configuration

### 5.1 The config file (`configPath()`, §3.2)

**`configPath()`** in `plugin/engine/lib/config.mjs` is the **only** resolver. Hooks, rounds, `setup`,
`config`, `doctor`, `uninstall`, `migrate` and rollback all call it. No other code builds the path, which
T-CFG-8 enforces.

```json
{ "version": 1, "preset": "default", "codex": { "model": null, "effort": null }, "rubricPath": null, "events": { "path": null } }
```

- `null` means inherit or use the built-in default. Mode is 0600 and the parent dir is 0700; both use
  `ensurePrivateDir` and `atomicWriteJson` from `lib/fsutil.mjs`.
- **Read path:** every hook invocation and every round reads the file through `readJsonValidated` with a
  64 KiB cap, symlink rejected, and a structural validator `isConfig`.
- **Invalid, unreadable or symlinked config:** behave as **Default**. This is loud:
  - one stderr line naming the file and the code;
  - the event `config.invalid` with code `config_invalid|config_symlink_rejected|config_dir_untrusted`
    (the last: the config's folder is a link, or a link above it or the folder belongs to another user);
  - `doctor` shows ✗.
  - The file is quarantined to `.corrupt` only by `review-loop config repair` or `setup`, never by a
    hook, so hooks never mutate user config.
- **Env override** follows the engine's `REVIEW_LOOP_*` convention: `REVIEW_LOOP_CONFIG`, as part of
  `configPath()`.
- Changes take effect on the **next hook invocation**. No restart is needed.

### 5.2 Presets: the only definition

The bar is identical in every preset: mean ≥ 9.2 **and** every dimension ≥ 9.2, with the first
checkpoint at 10 rounds. Presets change **enforcement only**.

| Gate | Default | Balanced | Advisory |
|---|---|---|---|
| Stop, with a changed artifact unreviewed | **block** (`decision:block`; allowed while `stop_hook_active`, as today) | **warn** (`systemMessage`; P5) | **warn** |
| PR create (`gh pr create`, `gh api …/pulls` POST, MCP create-PR) | **deny** | **deny** | **warn** and allow |
| UserPromptSubmit pending-context injection | on | on | on |
| Kill switch, "skip review", `permissions.ask` | unchanged | unchanged | unchanged |

🖊 **D5** asks you to confirm the Balanced semantics. The suggestion is above: Balanced keeps PRs
hard-gated but never blocks ending a turn.

**Setup copy** (🖊 **D8**: wording):

- **Default:** "Claude can't finish, or open a PR, until Codex approves the change. Recommended."
- **Balanced:** "Claude is reminded to get Codex review, and PRs still require approval."
- **Advisory:** "Reviews run when Claude chooses to. You get reminders, nothing is blocked — including merges of unreviewed PRs, unless your repo requires the review-loop check."

### 5.3 Codex model and effort

- **Setup and config** show:
  - "Inherit from Codex (currently: `<model>` / `<effort>`)". This is the recommended default.
  - Or a custom value.
  - The current values are read-only from `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`):
    lstat plus regular-file check, a 256 KiB cap, top-level `model =` and `model_reasoning_effort =`
    lines only. If the file is unparseable, it shows "Codex default".
- **Validation at write time:**
  - `model` must match `^[A-Za-z0-9._:/-]{1,64}$`;
  - `effort` must be one of the set P2 records from Codex's own config documentation (🖊 **D4**; suggested
    `minimal|low|medium|high|xhigh`, confirmed at P2).
  - Only the live check proves a model exists (AC-6, AC-9).
- **Per round:**
  - The engine passes `--model <m>` when set, and applies effort by the P2 mechanism.
  - It records `{model, effort, source: "config" | "codex-inherited"}` in the round record and in the
    `round.result` event.
- **Invariant:** nothing in this product opens a file under `$CODEX_HOME` for writing. This is pinned by
  T-CFG-6, which compares sha256 before and after for setup, a live check and a round.

### 5.4 Rubric resolution

1. `config.rubricPath`, when set: an absolute path to a regular file (a symlink is rejected with
   `rubric_symlink_rejected`, fix "point rubricPath at the real file").
2. Otherwise, the plugin's `rubric/default.md`.

The loader (`loadRubricSection`) is unchanged: it extracts `## Dimension definitions & boundaries` and
fails closed if any of the 11 dimensions is missing. `DEFAULT_RULES_PATH` is deleted.

## 6. CLI

### 6.1 Commands, exit codes, output

| Command | Purpose | Mutates |
|---|---|---|
| `setup [--yes] [--preset P] [--model M] [--effort E] [--skip-live-check] [--json]` | guided install and configuration (§6.4) | settings.json (ask rules), config, pin, plugin install |
| `config show [--json]` / `config set preset\|model\|effort\|rubric\|events.path <v>` / `config repair` | view and change settings | config only |
| `doctor [--json] [--live]` | read-only diagnosis (§6.5); `--live` also runs the paid live check | nothing |
| `update [--yes]` | `claude plugin marketplace update review-loop`, then `claude plugin update review-loop@review-loop`, then `doctor` | plugin |
| `uninstall [--yes] [--keep-history\|--delete-history]` | §6.6 | plugin, marketplace, ask rules, config, (history) |
| `migrate [--yes]` / `migrate --rollback [--yes]` | the author's legacy layout → package, and its exact reversal (§14) | settings.json, plugin and marketplace, skill dir, pin, config, `CLAUDE.md`, legacy dir |
| `selftest [--json]` | offline smoke test of the bundled engine (§10.4) | temp dirs only |
| `engine-path` | prints the installed plugin's engine dir (P3 fallback) | nothing |
| `--version`, `--help` | | nothing |

**CLI exit codes (the only definition):**

| Code | Category | Meaning |
|---|---|---|
| `0` | ok | done or healthy, including `setup --skip-live-check`, whose `cli.exit` code is `setup_complete_unverified`. The user explicitly opted out, so this isn't a failure. Automation distinguishes it by `code`, and `doctor` reports `live` as `warn: never verified`. |
| `1` | `user_action` | something needs the user (a failed check, invalid settings, a failed live check) |
| `2` | `usage` | bad flags or arguments, or non-interactive without `--yes` (`usage_noninteractive`) |
| `3` | `cancelled` | the user declined a step or pressed Ctrl-C (SIGINT) |
| `4` | `internal` | a bug or unexpected error (`unexpected_error`) |

The engine's `review-round.mjs` codes (`EXIT` in `lib/policy.mjs`: 0/10/20/21/22/30/40/50) are
**unchanged**, since the skill depends on them. Both tables are generated into the README from
`lib/codes.mjs`.

**`--json` shape.** With `--json`, stdout is **exactly one JSON value on one line**, and nothing else
goes to stdout. Human text goes to stderr.

- **Every command except `doctor`:** the `cli.exit` event line (§8), byte-identical to the line
  appended to `events.jsonl`.
- **`doctor`:** one report object that **embeds** that event:
  `{"schema":"review-loop.doctor/1","ok":bool,"checks":[{"id","status":"pass|fail|warn|skip","code":string|null,"fix":string|null}],"event":<the cli.exit event object>}`.
- T-DOC-3 and T-OBS-2 parse stdout with a single `JSON.parse` and fail on any trailing output.

**Human output:**

- ✓/✗ are always paired with the words `OK`/`FAIL`/`WARN`, for screen readers and `NO_COLOR`.
- Color only on a TTY, and never when `NO_COLOR` is set.
- No spinner off a TTY.
- Every prompt shows its default (`[Y/n]`).
- Every failure line is "what went wrong — the command that fixes it".

### 6.2 `settings.json` write contract

The five rules are unchanged from today, so the engine's `permissions.ask` semantics are preserved
(AC-12):

```
Bash(*review-loop.off*)   Bash(*review-round.mjs decide*)   Bash(*review-round.mjs override*)
Bash(*review-round.mjs repin*)   Edit(**/.claude/review-loop.off)
```

| Aspect | Rule |
|---|---|
| **Precondition** | No Claude Code session is running (below). The file is absent, or parses as a JSON object. Otherwise: refuse, write nothing, exit 1 with `settings_invalid_json`, fix "open the file and correct the JSON; a backup is not needed because nothing was changed". |
| **Symlink** | Resolve with `realpath`. The target must be a regular file owned by the user (else `settings_target_insecure`). Write to the target, so the dotfile-manager link survives. |
| **Backup** | The backup is a **hard link to the live pre-image inode**, `<backupDir>/settings.json.<UTC>-<sha8>`, taken in commit step 2 (below). `<backupDir>` is `<stateRoot>/settings-backups/`, created with `ensurePrivateDir` (0700, owned by the user). A hard link shares the inode's mode, so privacy comes from the **directory**: a 0644 `settings.json` stays 0644 for the user's own path, but its backup is reachable only through a 0700 directory. The target's own mode is never changed.<br>If the link fails with `EXDEV` (a dotfile-managed target on another volume), the backup is a 0600 **byte copy** in the same directory. In that case a late write through an old descriptor is not captured, and the command's output says so.<br> `sha8` is the first 8 hex digits of `base`. The backup therefore *is* the original file: the target is never absent, and any later write through a descriptor opened on the old file lands in the backup, where it is preserved.<br>The commit **never deletes a backup**. Pruning keeps our newest 5, and removes a backup only when its content still hashes to its `sha8`. A modified backup is never pruned, and `doctor` reports it as `settings_backup_modified`.<br>No backup is made when nothing changes or the file didn't exist. |
| **Atomic unit** | One read-modify-write per command. It applies all of that command's changes in a **single** commit (the protocol below), with the temp file in the target's directory and the target's mode preserved. For migrate, "remove legacy hooks + ensure ask rules" is one write. |
| **Concurrency** | Mutating commands require that no Claude Code session is running, plus a hash re-check before `rename()`. See "No-concurrent-writer precondition" below. |
| **Scope** | Setup only **adds** missing strings from the five to `permissions.ask`. Uninstall removes exactly those strings. Migrate also removes hook objects whose `command` matches `/review-loop\/review-gate-hook\.mjs/`, drops a matcher group that becomes empty, and never deletes an event key. Nothing else is touched. |
| **Idempotence** | A second identical run makes no write, no backup and no byte change. |
| **Formatting** | Output is `JSON.stringify(obj, null, 2) + "\n"`. Foreign keys are **semantically** preserved (deep-equal, same key order). Whitespace may be normalized, and the backup holds the original bytes. |
| **Disclosure** | Diff previews show only the paths we change. Values under `env` and any other foreign key never reach stdout, stderr or events (T-SET-8). |

**Commit.** The commit uses the engine's existing `atomicWriteJson` pattern (`lib/fsutil.mjs`):

1. write, fsync and chmod a temp file in the target's directory;
2. `link(target, backup)` into the private backup directory, then **hash the backup**. This is the same inode as the live target at that
   instant. If the hash no longer equals `base`, `unlink(backup)`. This is safe, because the inode is
   still linked at `target`, so only a name is removed. Then discard the temp file and redo the whole
   read-modify-write (at most 3 attempts, then exit 1 `settings_concurrent_write`);
3. `rename(tmp, target)`;
4. re-read and verify that our entries are present. A missing entry counts as a concurrent write, and
   the command retries. Then **re-hash the backup**. If it differs from `sha8`, a writer holding a
   descriptor on the old file wrote after our rename. The backup is kept, and the command exits 1 with
   `settings_detached_write` and the fix "compare <backup> with settings.json and copy over any change
   you need".
   - A write landing after this re-hash is still preserved in the backup, which is never pruned while
     modified, and `doctor` reports it (`settings_backup_modified`).

Consequences:

- **The target is never absent.** `rename()` atomically replaces it, so an interrupted commit leaves
  either the old file or the new one. A leftover temp file is removed by the next run, and `doctor`
  lists it.
- **An absent target is created.** The same `rename()` creates the file when it doesn't exist. There's
  no backup in that case, because there's no pre-image.
- **Backup:** see the Backup row.

**No-concurrent-writer precondition.** A rename-based commit cannot protect a write that another process
lands between step 2 and step 3, and neither Claude Code nor editors honor a lock. So instead of
engineering around that window, **mutating commands require that no other settings writer is active**.
That covers Claude Code sessions, editors, and dotfile or sync tools:

- Before the first settings write, `setup`, `migrate`, `migrate --rollback` and `uninstall` check for
  running Claude Code processes with `pgrep -x claude` (verified at spec time to list running sessions;
  re-verified by P6). If any is found:
  - interactive: "Quit all Claude Code sessions (they must restart to load the plugin anyway), and
    close any editor or sync tool (e.g. chezmoi, Dropbox) that has settings.json open, then press
    Enter", followed by a re-check;
  - non-interactive: exit 1 with `claude_running`.
  - The command also refuses to run when its own parent process is Claude Code (for example
    `! review-loop setup`), with the fix "run this in a separate terminal".
- **Open-file check.** `lsof -t -- <target>` (part of macOS) lists processes holding the file open.
  Any holder refuses the commit: exit 1 `settings_open_elsewhere`, naming the process names, never file
  content. This runs together with the `pgrep` check, and again immediately before step 2.
- **Recovery after a conflict.** Step 4's re-read also compares the **whole file** with the bytes we
  wrote. If they differ, a writer landed after our rename: its version stands, and we redo the
  read-modify-write on top of it, so its edit is kept.
- Setup already ends with "restart Claude Code", so this costs the user nothing extra.

**What is and isn't guaranteed (the only statement of it):**

| Situation | Outcome | Guaranteed? |
|---|---|---|
| Any interruption (crash, kill, full disk) | `settings.json` is the complete old file or the complete new one, never absent or partial | **yes**: `rename()` is atomic (T-SET-13 case 6) |
| A foreign write before our step-2 re-hash | detected; we redo the read-modify-write on top of it, and both edits are kept | **yes** (case 2) |
| A foreign write after our `rename()` | detected by step 4's whole-file compare; we redo on top of it, and both edits are kept | **yes** (case 5c) |
| A writer that opened the file **before** our rename, and writes through that descriptor afterwards (the old inode) | the write lands in the backup, which is the old inode. It is detected at step 4 (`settings_detached_write`) or later by `doctor` (`settings_backup_modified`), and it is never deleted. The user copies it over, as the fix text says. | **preserved and surfaced: yes** (case 8); **auto-merged: no** |
| Claude Code running, or any process holding the file open, when we start or re-check | we refuse to write (`claude_running`, `settings_open_elsewhere`) | **yes** (cases 4 and 5b) |
| A **replace-style** writer (it writes a temp file, then renames it over the target) that lands **entirely** between our step-2 hash and our `rename()` (a sub-millisecond window, while the precondition says no writer is active) | **its write is overwritten and not recoverable from our files.** We cannot detect it, because after the rename the replaced inode is gone. | **no.** Retention is **not** guaranteed for a writer that violates the precondition inside that window. |

**Why the last row isn't closed.** Closing it needs either an atomic exchange that returns the replaced
file (`renamex_np(RENAME_SWAP)`, which Node doesn't expose, and a native helper would be a new
dependency), or a lock the other writers honor, which they don't. The two alternatives considered, a
swap-aside with exclusive link and a commit that makes the file briefly absent, were rejected in review:
they can leave `settings.json` missing after a crash. So v1:

- **refuses** to write unless the precondition checks pass;
- keeps the window to one `stat`-free hash-then-rename, in microseconds;
- **states this row** in the README's troubleshooting ("settings change lost during setup → your editor
  or sync tool still has it; re-save it").

The row is recorded as deferred §15 #12, the atomic-exchange helper.

### 6.3 Hook shim `plugin/bin/hook`

`hooks.json` runs `"${CLAUDE_PLUGIN_ROOT}/bin/hook" <mode>`. The POSIX `sh` shim looks for node, in
order: `command -v node`, `/opt/homebrew/bin/node`, `/usr/local/bin/node`. When one is found, it
`exec`s `node "$ROOT/engine/review-gate-hook.mjs" "$mode"`.

When **no node** is found, it fails **loud**, because config can't be read and it assumes Default:

- `stop`: prints `{"decision":"block","reason":"review-loop: Node.js not found — run: brew install node"}`
  unless stdin contains `"stop_hook_active":true`, in which case it allows. This mirrors the engine's
  anti-trap rule (`review-gate-hook.mjs:144`).
- **PR-like test for `pr` and `prverify`.** Without node, the shim can't run the engine's `cmdparse`
  classifier. So it applies a deliberately **broader** test: `grep -Eiq
  'pr[^a-z0-9]+(create|merge)|/pulls|/merge|create_pull_request|merge_pull_request|createpullrequest|mergepullrequest|graphql'` on stdin. This matches
  everything the engine would classify as PR creation or a merge (§7.1 (3)), and some things it wouldn't. A false match only
  causes a loud denial while node is missing.
  - The MCP matcher entries always count as PR-like.
  - A non-PR-like Bash command exits 0 with no output and no event. So a missing node doesn't block
    ordinary shell use, and it isn't a gate evaluation (§8.2).
- `pr` (PR-like): prints a PreToolUse `permissionDecision:"deny"` with the same reason.
- `prverify` (PR-like): prints the §7.1 **PostToolUse stop shape** `{"continue":false,"stopReason":"review-loop:
  Node.js not found, so this PR could not be verified against the reviewed commit. Check it, then run:
  brew install node"}`. This fails closed, like §7.1 step 5. It uses `continue:false`, not
  `decision:block`, because PostToolUse cannot undo creation.
- **Test seam.** `REVIEW_LOOP_NODE_CANDIDATES` (a colon-separated list) replaces the fixed lookup paths,
  so tests and P1 can simulate a missing node on a machine that has one.
- `session|track|prompt`: prints the reason on stderr and exits 0.

**The shim writes its own event**, so this decision is not missing from the stream (AC-21). It appends
one fixed-shape schema-v1 line built with `printf`:

- `ts` from `date -u`;
- `run_id` from `uuidgen`, lowercased;
- `source:"hook"`, `code:"node_missing"`, `detail:null`, `exit_code:null`;
- `event`: for `stop`, `pr` and `prverify`, `gate.decision` with `data:{"gate","outcome","preset":"default","pending_count":null}`.
  For `session`, `track` and `prompt`, `hook.error` with `data:{"stage":"<mode>"}`, since these modes make
  no blocking decision without node. (`prompt` without node injects nothing, which isn't a gate outcome.)
- `version`: stamped into the shim at build time and checked by T-SHAPE-4;
- `session_id`: extracted from stdin only if it matches `"session_id":"[A-Za-z0-9-]{1,64}"`, else `null`;
- `artifact_key:null`.

It writes only to the **default** events path, because without node it cannot read the config's
`events.path`. It writes only if the state dir is a real directory owned by the user
(`[ -d ] && [ ! -L ] && [ -O ]`) and the file is under 5 MiB. It runs under `umask 077`. It never writes
content.

**If the event write fails:**

- The decision JSON is still emitted, because stdout is the decision channel.
- The shim prints one content-safe stderr line: `review-loop: event log not writable (<reason>)`,
  where `<reason>` is one of `state_dir_insecure`, `size_cap` or `write_failed`. No path or content is
  included.
- The decision also stays visible in Claude Code's own hook output.
- `doctor` reports both `node_for_hooks` and `events_writable` as ✗.
- This is the **explicitly degraded** mode of AC-21 (see AC-21's wording).

### 6.4 `setup`: steps, and the invariant each one keeps

Every step **checks real state first**, acts only if needed, and re-verifies. Re-running setup after any
failure or cancel converges, and no progress file is trusted. A cancel (exit 3) leaves completed steps in
place and prints which steps are done and which are not.

| # | Step | Check | Act (asks first) | Post-invariant |
|---|---|---|---|---|
| 1 | Preflight | `claude --version` ≥ `compat.minClaude`; `codex --version`; `codex login status`; `claude plugin list --json` has `codex@openai-codex` enabled; `gh auth status` (optional, never fails setup) | per-item fix offer (below), then re-check | all required items ✓, or exit 1 with the failing item's code |
| 2 | Preset | config | choose from §5.2 | `config.preset` set |
| 3 | Model and effort | config plus the Codex defaults (§5.3) | choose inherit or custom | `config.codex` set |
| 4 | Plugin | `claude plugin list --json` | `claude plugin marketplace add <owner>/review-loop`, then `claude plugin install review-loop@review-loop --scope user` (`--json`, exit code read) | plugin enabled at user scope, `X.Y` equal to the CLI |
| 5 | Approval rules | `settings.json` | §6.2 write | all five strings present |
| 6 | Pin | pin file vs the installed companion hashes | show version and files, then write the pin with `pin.mjs` | pin matches the installed Codex plugin |
| 7 | Live check | — | cost and privacy note, then a real round on a bundled fixture doc in a temp git repo, with the configured model and effort; 15-minute budget | pass, or exit 1 with `live_check_failed` and a `detail` naming the broken link |
| 8 | Summary | — | lists everything done, plus "restart Claude Code to load the plugin" | `cli.exit` event written |

**Preflight fix offers.** Every command was verified with `--help` at spec time and is re-verified in the
plan per `ci-deploy-patterns`.

- Codex CLI → `brew install --cask codex`.
- Sign-in → run `codex login` with inherited stdio.
- Codex plugin → the P4 fallback commands.
- Claude Code → `brew install --cask claude-code`, or the official installer URL.
- `gh` → an informational note only.

**Live-check failure `detail`** is a registered enum. Each value has one remedy line:

| `detail` | Remedy |
|---|---|
| `codex_missing` | `brew install --cask codex` |
| `codex_auth` | `codex login` |
| `plugin_missing` | run `review-loop setup` again |
| `pin_mismatch` | `review-loop setup` step 6 |
| `model_invalid` | `review-loop config set model <valid>` |
| `effort_invalid` | `review-loop config set effort <valid>` |
| `timeout` | retry; check network |
| `unparseable` | `review-loop doctor`, then report a bug |
| `unknown` | as above |

Classification of Codex error text uses a pattern table in `codes.mjs`. The raw text is shown in the
terminal only and **never** written to events.

**Cost and privacy note** (🖊 **D3**: wording): "This runs one real Codex review (usually 2–8 minutes)
billed to your OpenAI/ChatGPT account. Reviews send the changed files and repo context to OpenAI under
your account. Continue? [Y/n]"

### 6.5 `doctor`: a check registry

`DOCTOR_CHECKS` in `cli/lib/doctor.mjs` is the only list. Each check has an `id`, a runner, a failure
code and a fix. Doctor exits 1 on any `fail`; `warn` and `skip` exit 0. It makes no Codex call unless
`--live` is given.

| id | Fails when | Fix printed |
|---|---|---|
| `claude` | missing or below `compat.minClaude` | install or upgrade command |
| `codex_cli` / `codex_auth` / `codex_plugin` | as in preflight | as in preflight |
| `gh` | (warn only) missing or signed out | `gh auth login` |
| `plugin_installed` | review-loop is not installed or not enabled at user scope | `review-loop setup` |
| `version_skew` | plugin `X.Y` ≠ CLI `X.Y` | `review-loop update` (or `brew upgrade review-loop`) |
| `legacy_hooks` | any settings hook command matches the legacy regex (a double gate) | `review-loop migrate` |
| `ask_rules` | any of the five is missing | `review-loop setup` |
| `config` | invalid, symlinked or unreadable | `review-loop config repair` |
| `rubric` | it doesn't resolve, or it's missing a dimension | `review-loop config set rubric <path>` or unset |
| `pin` | differs from the installed Codex plugin | `review-loop setup` (re-pin step) |
| `state_dir` | not owned by the user, not 0700, or a symlink | the `chmod` or ownership fix command |
| `node_for_hooks` | the shim's lookup order finds no node | `brew install node` |
| `events_writable` | the events path isn't writable | `review-loop config set events.path <file>` |
| `skill_duplicate` | `~/.claude/skills/review-loop/SKILL.md` exists alongside the plugin skill | `review-loop migrate` |
| `pr_binding` (warn) | `gh` is missing or signed out, so a PR-head mismatch can be detected and stopped but not contained, and approval marks can't be posted | `brew install gh && gh auth login` |
| `settings_backup_modified` (warn) | a settings backup (under `<stateRoot>/settings-backups/`) no longer hashes to the `sha8` in its name: a late write through an old descriptor landed there | "compare <backup> with settings.json and copy over any change you need; then delete the backup" |
| `settings_tmp_leftover` (warn) | a leftover `settings.json` temp file from an interrupted commit exists | "delete <path>; settings.json itself is intact" |
| `live` | with `--live`: the live check fails (fail). Without it: no passing live check has been recorded since the last setup or config change (`warn`, no Codex call). | per `detail`; `review-loop doctor --live` |

### 6.6 `uninstall`

1. It shows the full list of what will be removed, and what will **not** be (Codex, its plugin, `gh`,
   node), then asks.
2. The order has a stated reason: **plugin first**, so hooks are gone before anything they depend on.
   - `claude plugin uninstall review-loop@review-loop --scope user --json`. If this fails, stop, exit 1,
     and remove nothing else.
   - `claude plugin marketplace remove review-loop`.
   - The §6.2 write removes the five ask strings.
   - Remove the config file at `configPath()`, and its `review-loop` directory if it is then empty. The
     path is printed in the list shown in step 1.
3. History (`~/.claude/state/review-loop/`) is asked about, default **keep**. It is deleted only on an
   explicit yes or `--delete-history`.
4. Each step is idempotent, so a re-run after partial failure completes. At the end it asserts: no hook
   in `settings.json` or in any installed plugin references `review-gate-hook.mjs` or `review-loop`'s
   plugin root.

## 7. Engine changes (inside the plugin)

- Paths:
  - `stateRoot` unchanged;
  - `pinFile()` defaults to `<stateRoot>/plugin-pin.json`;
  - `DEFAULT_RULES_PATH` removed (§5.4).
- `pluginBase()` resolves the Codex plugin through the `installPath` of `codex@openai-codex` in
  `~/.claude/plugins/installed_plugins.json` (read-only, validated). It falls back to today's cache path.
- Preset enforcement lives in `lib/policy.mjs` as a pure function
  `gateOutcome(preset, gate, pending) → "block" | "warn" | "deny" | "allow"`. This is the single decision
  point that the hooks call.
- Model and effort are threaded into the companion args in `lib/pin.mjs` and `lib/round.mjs`. The
  `FIXED_FILES` pin still covers the companion.
- Hook messages name the namespaced skill `review-loop:review-loop` (T-SHAPE-5).
- `appendEvent` becomes the schema-v1 writer (§8). Existing call sites keep their event names through
  the catalog mapping in §8.2.

### 7.1 PR-head binding (AC-23)

**The problem.** The PR gate compares the branch's current head with the reviewed SHA before it allows
the create call. GitHub's create-PR API takes a branch **name**, not a commit. So a push landing between
the gate's check and GitHub's creation opens a PR whose head was never reviewed. Two mechanisms close
this.

**(1) Post-create verification: new hook mode `prverify`.** There are two new `PostToolUse` entries,
matching the same tools as the PR gate: `Bash` (acting only when the command is classified as PR
creation by the existing `cmdparse` classifiers) and `mcp__.*__create_pull_request`.

1. **Resolve the PR:**
   - from the MCP `tool_response`:
     - `number` and `head.sha` when present;
     - otherwise, as with the **official GitHub MCP server, whose create response carries only an
       `ID` and `URL`**, the PR number is parsed from the returned `URL` (`/pull/(\d+)`, validated as
       belonging to the gated `<o>/<r>`). The head comes from
       `gh pr view <n> --repo <o/r> --json headRefOid`;
     - without `gh`, the head can't be resolved, which is §7.1 step 5 (unverifiable). So
       **MCP-only installs are stopped after each PR creation under Default and Balanced** until `gh`
       is installed. Setup's preflight and `doctor`'s `pr_binding` warn about this, with the fix
       `brew install gh && gh auth login`, and the README states it;
   - for `gh api …/pulls` (POST) creation, from the **JSON response body** on stdout: `number` and
     `head.sha`, parsed with a 1 MiB cap and validated as a positive integer and 40 hex characters;
   - otherwise from the PR URL in `gh pr create` stdout (`/pull/(\d+)`), then
     `gh pr view <n> --repo <owner/repo> --json headRefOid`.
2. **Compare** with the reviewed SHA on the PR marker (`isClearedAt`'s record).
3. **Match:** `gate.decision` with `gate:"prverify"` and `outcome:"allowed"`.
4. **Mismatch**, under the Default and Balanced presets. `PostToolUse` runs after creation and cannot
   undo it (Claude Code hooks reference), so the hook **contains** the PR and **stops the session**:
   - **Contain, with `gh`.** Run `gh pr ready <n> --repo <o/r> --undo`, then **verify** with
     `gh pr view <n> --json isDraft` that `isDraft` is `true`.
     - If the conversion or the verification fails, run `gh pr close <n> --repo <o/r> --comment
       "review-loop: head <sha7> was not reviewed"` and verify that `state` is `CLOSED`.
     - The flags for `pr ready`, `pr view` and `pr close` are verified with `--help` in the plan.
   - **Stop.** Output `{"continue":false,"stopReason":"…"}`. This ends Claude's turn processing
     outright, rather than adding feedback beside the tool result. P1 is extended to verify this for
     `PostToolUse`. The stop reason names the PR, both SHAs and what was done: "converted to draft",
     "closed", or "**could not be drafted or closed — PR #n is open and unreviewed; convert it to draft
     now**".
   - **Log** `gate.decision` with `outcome:"denied"` and code `pr_head_mismatch`, and `detail` set to
     `drafted`, `closed` or `uncontained`.
   - **Without `gh` (MCP-only):** the hook cannot act on GitHub itself. It stops Claude with the
     `uncontained` stop reason, and `doctor` shows `pr_binding` as `warn` ("install and sign in to `gh`
     for automatic containment"). This degraded state is explicit in AC-23 and the README.
5. **Unverifiable** (no PR number, or no head SHA obtainable):
   - **Default and Balanced:** stop Claude (`continue:false`) with code `pr_verify_unavailable` and the
     reason "couldn't confirm PR #n's head commit — check it before continuing". This fails closed.
   - **Advisory:** a `systemMessage` warning with the same text, and continue. The event has the same
     code with `outcome:"warned"`. Advisory never blocks (§5.2).
6. **Advisory** preset, for a mismatch: a warning only (`systemMessage`), with the same event and
   `outcome:"warned"`. **Advisory never produces `continue:false`, a block or a deny in any `prverify`
   or merge path.** T-PR-10 pins this.

**(2) A commit-bound approval mark.** Every **completed** PR round posts the status for its reviewed
SHA and base, so the check always reflects the latest verdict:

| Round outcome | Status posted on `<reviewed-sha>`, context `review-loop/<baseBranch>` |
|---|---|
| passed (exit 0) | `success`, "review-loop passed vs <base> (mean X.X)" |
| overridden by the user (a logged override) | `success`, "review-loop overridden by user (logged)" |
| needs fixes, checkpoint, stall or human decision (exit 10, 20, 21 or 22) | **`failure`**, "review-loop: not passed (mean X.X)". This invalidates any earlier `success` on the same SHA and base when that SHA is re-reviewed. |
| operational error or busy (exit 30 or 50): no verdict | no status change. The last real verdict stands. |

**An approval is bound to the policy it was given under.** Each approval mark and PR record carries the
review's **policy fingerprint**: the first 12 hex digits of `sha256(rubric text + preset + gate
threshold + "review-loop X.Y")`. It appears in the status description ("… policy 3f9a1c2b7d10") and in
the round record.

**Changing the policy does not revoke earlier approvals.** This covers `config set rubric`, a preset
change and a version upgrade. It is like a code-review approval given under an older style guide: the
new policy applies to reviews from then on, not retroactively. So:

- existing `success` statuses stay green;
- the merge gate (§7.1 (3)) continues to honor records cleared under an older policy;
- `review-loop config set rubric` (and setup, when it changes the rubric) prints this in plain words, with
  the way to re-review an open PR under the new rubric: run the loop again on it.
- A re-review that fails posts `failure` (the table above).

Automatic revocation of earlier approvals on a policy change is deferred (§15 #13): it needs a list of
every open PR the user has approved, across repos.

The command posted for a pass:

```
gh api -X POST repos/<owner>/<repo>/statuses/<reviewed-sha> -f state=success -f context=review-loop/<baseBranch> -f description="review-loop passed vs <baseBranch> (mean X.X)"
```

- The engine runs this itself; it is not a Claude tool call, so the PR gate doesn't intercept it.
- A later push creates a new SHA **without** that status.
- A retarget to base `Y` requires `review-loop/Y`, which was never posted.
- So in a repo whose branch protection requires `review-loop/<base>`, neither an unreviewed head nor an
  unreviewed base context can merge, **whoever merges**. This check is server-side and bound to both the
  head and the base.
- A base name containing characters invalid in a status context is percent-encoded, and the README
  shows the exact context to require.
- **Without `gh`,** or on a posting failure, the review still passes. The engine emits `hook.error` with
  code `status_post_failed`, and `doctor` warns that approval marks are unavailable without `gh`.
- **Trust boundary.** See AC-23's trust assumption. The README states it where it explains how to
  require the check.
- The README has a "Require review-loop before merge" section with the exact branch-protection steps. An
  automated helper is deferred (§15 #10).

**(3) Merge gate: the existing `pr` mode, with a new merge classifier in `lib/cmdparse.mjs`.**

*What counts as a merge:*

- `gh pr merge` (any flags);
- `gh api` with an effective method of `PUT` on `repos/<o>/<r>/pulls/<n>/merge`, read with the existing
  pflag-accurate `readApiArgs`, so a repeated `-X` is `pr_args_unresolvable`, as today;
- `gh api graphql` whose query text contains `mergePullRequest` or `enablePullRequestAutoMerge`;
- the MCP tool `mcp__.*__merge_pull_request`, through one new PreToolUse matcher entry.

*Rules, under the Default and Balanced presets:*

| Case | Decision | Code |
|---|---|---|
| One Bash call contains both a PR creation and a merge, in any segment (the same segment splitter as the create gate) | deny | `pr_create_merge_compound`. Fix: "create the PR, let review-loop verify it, then merge in a separate command" |
| `gh pr merge` **with** `--match-head-commit <40-hex>` that is **cleared for this PR's identity** (see "Context binding" below) | allow | — |
| `gh pr merge` without `--match-head-commit`, or with a SHA not cleared for this PR's identity | deny | `pr_merge_unbound`. The reason gives the exact command, with `--match-head-commit <reviewed-sha>` when this PR's identity has a passed review |
| `gh pr merge --auto` | allowed under the same binding rule. The plan verifies with a live probe that `--match-head-commit` binds auto-merge's expected head. If it doesn't, `--auto` is denied as `pr_merge_auto_unbound`. | — |
| `gh api … /merge` PUT with `-f sha=<sha>` (or `-F`) cleared for the PR's identity | allow | — |
| `gh api … /merge` without a reviewed `sha` field | deny | `pr_merge_unbound` |
| `gh api graphql` merge mutations | deny: their `expectedHeadOid` cannot be reliably parsed | `pr_merge_graphql_unsupported`. Fix: use `gh pr merge --match-head-commit` |
| MCP `merge_pull_request` whose **head-binding field** (the name is recorded by P7 from the server's live input schema; the official GitHub MCP server documents `expectedHeadSha`) is cleared for the PR's identity | allow | — |
| MCP `merge_pull_request` without that field, or not cleared | deny | `pr_merge_unbound` |
| MCP `merge_pull_request` on a server whose merge tool has **no** head-binding field (per P7) | deny | `pr_merge_mcp_unbindable`. Fix: use `gh pr merge --match-head-commit` |
| Any merge where the PR's context can't be resolved (no `gh`, `gh pr view` fails, or the merge-base can't be computed) | deny, failing closed | `pr_merge_context_unverifiable` |

*Details:*

*Context binding.* A reviewed SHA is not approval to merge *any* PR that has that head, because the same
head against a different base is a different diff. The gate therefore:

1. resolves the PR being merged: the number from the command or MCP input, then `gh pr view <n>
   --repo <o/r> --json baseRefName,headRefName,headRepository,headRepositoryOwner`;
2. builds the **existing** PR identity `{kind:"branch", baseRepo, baseBranch, headRepo, headBranch}`
   (`lib/prgate.mjs`);
3. computes the merge-base of the binding SHA with the PR's **current** base, using the same comparison
   helper the PR-create gate uses for its `head:mergeBase` fingerprint;
4. allows the merge only if `isClearedAt(identity, "<bindingSha>:<mergeBase>")` holds.

Consequences:

- A base retarget changes the identity or the merge-base, so it needs a new review.
- A different PR sharing the head needs its own review.
- **No new approval store is introduced;** the PR gate's records are reused.
- **Server enforcement.** GitHub rejects the merge when the head no longer equals the binding SHA. P7
  proves this for `gh pr merge --match-head-commit` and, where available, for the MCP field.
- **Advisory preset:** a warning (`systemMessage`) and allow, with the same event and `outcome:"warned"`,
  as stated in AC-23.
- **Events:** each merge evaluation emits `gate.decision` with `gate:"merge"`.

## 8. Observability: `events.jsonl` schema v1 (AC-21)

### 8.1 Envelope (every line)

```json
{"schema":"review-loop.event/1","ts":"2026-09-28T20:59:03.412Z","run_id":"5b0c…","source":"cli",
 "event":"cli.exit","code":"live_check_failed","detail":"codex_auth","exit_code":1,
 "version":"1.0.0","session_id":null,"artifact_key":null,"data":{"command":"setup","duration_ms":8123}}
```

| Field | Type | Rule |
|---|---|---|
| `schema` | const | `review-loop.event/1`. Lines without it are legacy v0 (`at` instead of `ts`), left as-is. |
| `ts` | ISO-8601 UTC ms | — |
| `run_id` | UUID v4 (`crypto.randomUUID`) | one per process |
| `source` | `cli \| hook \| round` | — |
| `event` | catalog key (§8.2) | an unknown key is dropped, and one `event_unregistered` is written instead |
| `code` | registry key (§8.3) | validated **by value**; unknown → `unregistered_code` |
| `detail` | per-code enum \| null | validated by value; unknown → `null` |
| `exit_code` | int \| null | the process exit code for `cli.exit` and `round.result` |
| `version` | the package's `X.Y.Z` | — |
| `session_id` | string \| null | the Claude Code session id from hook input, validated `^[A-Za-z0-9-]{1,64}$` |
| `artifact_key` | string \| null | the existing identity hash, never a path |
| `data` | object | per-event typed fields (§8.2); every field is validated by type and value |

### 8.2 Event catalog (`EVENT_CATALOG` in `lib/codes.mjs`)

| event | source | data fields | Written |
|---|---|---|---|
| `cli.exit` | cli | `command` (enum), `duration_ms` | once per CLI process, **success included** |
| `gate.decision` | hook | `gate` (`stop\|pr\|prompt\|prverify\|merge`), `outcome` (`blocked\|warned\|denied\|allowed\|skipped`), `preset`, `pending_count` | **every** gate evaluation, clean allows included (see "What counts as a gate evaluation" below) |
| `round.result` | round | `kind` (`spec\|plan\|impl\|pr`), `round`, `pass`, `mean`, `dims` (11 named numbers), `model`, `effort`, `effort_source`, `preset`, `duration_ms` | every round |
| `hook.error` | hook | `stage` (enum, including the modes `session\|track\|prompt`) | engine faults. Today's `detection_failed`, `snapshot_degraded`, `hook_input_error`, `prune_failed` and `summary_write_failed` become `code` values under this event. |
| `config.invalid` | hook, cli | — | §5.1 |
| `round.sweep` | round | `swept`, `brokers_left`, `failed` (counts) | a round-start sweep found a killed round's snapshot (code `ok` or `snapshot_sweep_incomplete`); added by the final re-review R2 |
| `override` | hook, round | `kind` | today's override and kill-switch events |
| `event_unregistered` | any | — | writer self-report |

**What counts as a gate evaluation (the only definition):**

| Hook invocation | Is it a gate evaluation? | Event |
|---|---|---|
| `stop` | always | one `gate.decision` (`allowed` when nothing is pending) |
| `prompt` | always | one `gate.decision` (`allowed` when nothing is pending, `warned` when context was injected) |
| `pr` where the command or tool is classified as PR creation (`gh pr create`, `gh api …/pulls` POST, MCP create-PR) | yes | one `gate.decision` |
| `pr` for any other Bash command | **no**: the gate does not apply | none. This keeps volume proportional to decisions rather than to every shell command. |
| `prverify` after a PR-creation command or tool | yes | one `gate.decision` with `gate:"prverify"` (§7.1); other `PostToolUse` Bash commands emit none |
| `pr` where the command or tool is classified as a merge (§7.1 (3)) | yes | one `gate.decision` with `gate:"merge"` |
| `session`, `track` | no: bookkeeping, not decisions | none; faults still emit `hook.error` |
| kill switch or `skip review` active | yes | `gate.decision` with outcome `skipped` |

**Volume bound.** At most one line per Stop, per prompt and per PR attempt. A heavy session with 500
turns writes about 1,000 lines, roughly 400 KB, which is within the 5 MiB rotation.

### 8.3 Code registry (`lib/codes.mjs`)

It maps each `code` → `{ exit, category: "ok" | "user_action" | "usage" | "cancelled" | "internal", remedy, details?: string[] }`.

- It **extends** `lib/errors.mjs`: `ReviewLoopError` and `errorCode` stay; the registry adds metadata. It
  covers today's 43 literal `ReviewLoopError` codes plus the CLI's codes.
- **Completeness gate (T-OBS-3):** a test greps every `ReviewLoopError("<code>"` and `fail("<code>"`
  literal in `plugin/` and `cli/`, and fails on any code missing from the registry.
- The README's troubleshooting and exit-code tables are **generated** from the registry.
  `npm run docs:check` fails when the README is stale.

### 8.4 Content discipline, bounds and failure

- **Never in an event:**
  - file paths (they carry usernames);
  - artifact text, diff text, Codex output or finding titles;
  - `settings.json` values;
  - emails or `env` values.
  - Only codes, enums, counts, scores, hashes, model and effort names.
- **Enforced by T-OBS-5.** It runs every CLI command and hook mode against fixtures containing the
  sentinel strings `SENTINEL-CONTENT-7f3a`, `/Users/`, `@example.com` and `ENVSECRET`, then asserts none
  appear anywhere in `events.jsonl`.
- **Bounded by construction, so nothing is truncated.** Every field in §8.1 and §8.2 has a declared
  maximum:
  - strings are enums, or are regex-bounded (≤ 64 chars);
  - numbers are finite;
  - `dims` has exactly 11 entries.
  - So the largest possible line of each catalog event is computable. T-OBS-6 computes it from the
    catalog and asserts it is ≤ 4 KiB, which keeps each `O_APPEND` write a single small append.
  - A value that fails its bound is **not truncated**; it is replaced by that field's registered
    fallback, `null` or `unregistered_code`, exactly as for an unknown value (§8.1). So every emitted
    line still validates against schema v1.
- **Rotation at 5 MiB** to `.1` (one generation, as today), so disk use is ≤ 10 MiB. The file is 0600 and
  the dir 0700.
- **`events.path`:** an absolute path, whose parent is an existing directory owned by the user, and which
  is not a symlink. Otherwise use the default path and emit a single stderr warning.
- **An event write can never change an exit code or a gate decision.** The writer catches its own
  errors, prints at most one stderr warning per process, and `doctor` then shows `events_writable` ✗.
  This is pinned by T-OBS-7, which makes the path a directory (EISDIR).

### 8.5 Consuming it

- **File (default):** `~/.claude/state/review-loop/events.jsonl`. Tail it with a shipper: OTel Collector
  `filelog`, Vector, Fluent Bit or the Datadog agent. The README has a copy-paste `filelog` example.
- **Stdout:** `--json` prints the command's `cli.exit` line (§6.1).

## 9. Security & compliance

- **AC-2 / Homebrew:** the formula has no `post_install` and nothing in `caveats` executes. CI snapshots
  `~/.claude` and `~/.codex` (sha256 of the file lists and contents) before and after install, test and
  uninstall, and asserts they are identical (T-REL-4).
- **Approval prompts and the kill switch** are unchanged (AC-12). Setup never adds `permissions.allow`
  entries.
- **Tap token:**
  - a fine-grained PAT scoped to `<owner>/homebrew-tap` only, with contents and pull-requests write;
  - stored as the `TAP_PR_TOKEN` secret in a `release` GitHub environment with required reviewer approval;
  - used only by the tap-bump job.
- **Supply chain:**
  - The formula pins the sha256 of the release tarball.
  - Releases come only from signed tags on a protected `main`.
  - Marketplace updates execute plugin code on users' machines, so `main` requires PR plus CI.
  - The plan verifies (via `claude plugin validate --strict`) whether a marketplace plugin entry can pin
    a git ref. If it can, each release pins its tag; if not, branch protection is the control, and this
    is stated in the README.
- **Data leaving the machine:** reviews send artifacts and repo context to OpenAI through Codex, under
  the user's own account. This is stated in setup (§6.4) and the README. Our product sends nothing
  anywhere itself; there is no telemetry.
- **File modes:**
  - config 0600;
  - state dir 0700 and events 0600;
  - backups 0600;
  - symlinks are rejected on config, rubric, events and the Codex config read (`untrusted-io` rule).
- **Licensing:** MIT. The Codex companion is not redistributed, only pinned by hash; the plugin
  dependency points at OpenAI's marketplace.

## 10. Testing, CI, release

### 10.1 Test layers (`node --test`, no new dependencies)

| Layer | Proves | Harness |
|---|---|---|
| Engine | the existing 186, plus presets, model/effort threading and the pin location | temp `HOME`, existing `test/helpers.mjs` |
| CLI | every command against fake `claude`/`codex`/`gh` executables on `PATH`. Each fake writes its argv plus a scripted response to a log, and tests assert the **exact** commands issued. | temp `HOME`, fixture `settings.json` variants |
| settings contract | §6.2 rows | byte and deep-equal comparisons |
| event contract | §8 | full-file validation after each run |
| plugin shape | `hooks.json` parses; modes ↔ engine `MODE`s; `${CLAUDE_PLUGIN_ROOT}` only; versions equal; `claude plugin validate --strict` | static |
| content gate | §10.2 | the packaged file set |
| probes P1–P6 | §4 | real `claude`/`codex` on the author's Mac |
| live end-to-end | real setup, a real round, Stop blocks, then passes | `npm run e2e` (opt-in: paid, needs sign-in); required by the release checklist |

**Sabotage.** `npm run sabotage` applies each named break from the §11 tables, asserts the named test
goes red, and restores. It runs in CI weekly and on changes to a guarded file, not on every push (the
Verifiability-vs-Efficiency arbitration).

### 10.2 No-personal-content gate (AC-17)

- `scripts/content-gate.mjs` runs over the **exact packaged file set**, derived from an explicit allowlist
  `package.files.json`. Any repo file outside the allowlist is not shipped, and any allowlisted file
  missing from the set fails the gate.
- It fails on the denylist, case-insensitive:
  - `/Users/`;
  - the author's handle and private org and project names (kept in a private denylist, not in this repo;
    the gate loads it at run time, and the release job fails without it);
  - `~/.claude/rules/`;
  - email-shaped strings other than the `@example.com` fixtures.
- It runs in CI and again on the built tarball in the release job.

### 10.3 CI & release

- **`ci.yml`** runs on push and PR:
  - **Matrix:** `macos-14` (arm64), plus an Intel runner. The current Intel label is verified in the
    plan; if GitHub offers none, the fallback is `arch -x86_64` Node under Rosetta on arm64, stated in the
    README. Node versions: Homebrew's current, plus `compat.minNode` (🖊 **D2**; suggested 22).
  - **Jobs:**
    - tests;
    - content gate;
    - plugin shape;
    - `claude plugin validate --strict plugin` and `claude plugin validate --strict .` (verified to exist);
    - `npm run docs:check`.
- **Tap `tests.yml`:** `brew style`, `brew audit --strict --online review-loop`, then
  `brew install --build-from-source` followed by `brew test`.
- **`release.yml`**, triggered by tag `vX.Y.Z`:
  1. assert the tag = `cli` version = `plugin.json` version = the marketplace entry version;
  2. full tests, the content gate and the sabotage suite;
  3. `git archive` tarball plus sha256, and a GitHub release;
  4. `claude plugin tag plugin` (verified: it creates `{name}--v{version}` and validates the manifests);
  5. open a PR on the tap bumping `url` and `sha256`.
- **Release checklist** (`docs/RELEASE.md`), with each step a command plus its expected output:
  re-run P1 and P5, `npm run e2e`, and the dogfood round (AC-20).

### 10.4 `review-loop selftest` (the `brew test` payload, AC-16)

- **Offline**, with no Claude or Codex. It makes a temp `HOME`, state and config, and a temp git repo
  with a changed `docs/specs/x-design.md`.
- It feeds `review-gate-hook.mjs` canned inputs and asserts:
  1. `session`, then `track`, then `stop` gives `decision:block`;
  2. the `pr` mode with `gh pr create` gives `permissionDecision:deny`;
  3. a repo with nothing changed gives a Stop allow;
  4. every line of `events.jsonl` validates against schema v1.
- Exit 0 on pass, or 4 with the failing assertion's code. The formula's `test do` block runs
  `system bin/"review-loop", "selftest"`.

## 11. TDD tables

Legend:

- **+** is the positive case and **−** the negative.
- **Sabotage** is the deliberate break that must turn the test red; §10.1 runs them.
- 🖊 means your input is requested.

Test files live under `test/`. Names are `file::test`.

### 11.1 Setup & preflight (AC-3, AC-4, AC-9)

| ID | Test | + | − | Sabotage | 🖊 |
|---|---|---|---|---|---|
| T-SET-1 | `cli-setup::asks before each mutating step` | With `--yes` absent and scripted answers "y", each mutating step prints a what/why line before its prompt | Answering "n" at step 4 → exit 3; the fakes show no `plugin install` call | delete the prompt call in step 4 → the "n" case still installs → red | |
| T-SET-2 | `cli-setup::non-TTY without --yes is a usage error` | `--yes` on non-TTY runs | non-TTY without `--yes` → exit 2, `usage_noninteractive`, and no fake invoked | drop the TTY guard → red | |
| T-SET-3 | `cli-preflight::each item reports and offers its fix` | all fakes healthy → five `OK` rows | each fake broken in turn → that row `FAIL`, its exact fix command offered, and a re-check after the scripted fix | make the re-check a no-op → red | 🖊 Are these the right five items? Anything a semi-technical user will hit that isn't listed? |
| T-SET-4 | `cli-preflight::gh is optional` | gh missing → `WARN`, setup continues | — | make gh required → red | |
| T-SET-5 | `cli-setup::re-run converges` | fail at step 5, fix, re-run → steps 1–4 detected done with no duplicate installs, and steps 5–8 run | — | skip the "check first" in step 4 → a duplicate `plugin install` in the argv log → red | |
| T-SET-6 | `cli-livecheck::classifies each failure` | a fake companion scripted per failure class → the matching `detail` and remedy | unknown text → `unknown` with `review-loop doctor` as the remedy | remove one pattern → red | 🖊 Paste any real Codex error lines you've seen, to seed the patterns |
| T-SET-7 | `cli-livecheck::--skip-live-check` | exit 0, `setup_complete_unverified`, and the summary says "not verified" | — | return plain `ok` → red | |

### 11.2 settings.json contract (AC-7, AC-12)

| ID | Test | + | − | Sabotage |
|---|---|---|---|---|
| T-SET-8 | `settings::never prints env` | a fixture with `env.ENVSECRET=…` → no stdout, stderr or event contains `ENVSECRET` | — | add the full settings to the diff preview → red |
| T-SET-9 | `settings::idempotent` | second run: identical bytes and mtime, no new backup | — | always write → mtime changes → red |
| T-SET-10 | `settings::foreign keys preserved` | foreign keys deep-equal, with the same order, after setup, migrate and uninstall | — | sort keys on write → red |
| T-SET-11 | `settings::invalid JSON refused` | — | trailing-comma fixture → exit 1 `settings_invalid_json`, file bytes unchanged, no backup | parse leniently → red |
| T-SET-12 | `settings::symlink target written` | the link survives, the target updates, and the target's mode is preserved | target owned by another uid (simulated with a fake `stat`) → `settings_target_insecure` | write the link path directly → the link is replaced → red |
| T-SET-13 | `settings::concurrency and crash safety` | (1) With a fake `pgrep` reporting nothing, the commit succeeds. (2) A foreign write injected after our read (before the step-2 re-hash) → retried, and both changes are present. (3) **Absent file:** setup starts with no `settings.json` → the file is created with only our ask rules and no backup. | (4) A fake `pgrep` reports a session → interactive: waits and re-checks; non-interactive: exit 1 `claude_running`, file untouched. (5) Parent process is Claude Code → refused. (5b) A fake `lsof` reports a holder → exit 1 `settings_open_elsewhere` naming only the process name, file untouched. (5c) A writer injected **after** our rename → the step-4 whole-file compare differs → redone on top, and both edits are present. (6) **Crash:** the process is killed (a test seam throws) after the temp file is written and before the rename → `settings.json` is byte-identical to before, and the next run removes the temp file. (7) Writes injected on every attempt → exit 1 `settings_concurrent_write` after 3 attempts. (9) **Backup privacy:** a 0644 `settings.json` containing `ENVSECRET` → the backup lives under `<stateRoot>/settings-backups/` (mode 0700, owned by the user); another uid cannot open the backup path (simulated with a fake `stat`/permission check); the target's mode is still 0644. (8) **Open descriptor across the rename:** a descriptor opened on `settings.json` before step 2 writes after step 3 (a) before the step-4 re-hash → exit 1 `settings_detached_write`, and the backup contains the write; (b) after the command exits → the backup contains the write, a following prune keeps it, and `doctor` reports `settings_backup_modified`. | drop the step-2 re-hash → case (2) loses the foreign write → red; write the target in place instead of renaming → the case (6) file is truncated → red; drop the `pgrep` check → case (4) proceeds → red; drop the `lsof` check → case (5b) proceeds → red; drop the step-4 whole-file compare → case (5c) reports success with our entries missing → red; make the backup a byte copy instead of a hard link → case (8) loses the write → red; create the backup beside the target instead of in the 0700 directory → case (9) is readable → red; let pruning ignore the hash-vs-name check → case (8b) backup pruned → red |
| T-SET-14 | `settings::ask rules exact` | the five strings added exactly, never a `permissions.allow` entry | a pre-existing similar but different string is not removed by uninstall | loose matching → red |

### 11.3 Presets, config, model/effort (AC-5, AC-6, AC-10)

| ID | Test | + | − | Sabotage | 🖊 |
|---|---|---|---|---|---|
| T-CFG-1 | `policy::gateOutcome matrix` | every (preset × gate × pending) cell equals §5.2 | an unknown preset → Default | swap Balanced Stop to block → red | 🖊 D5 |
| T-CFG-2 | `hooks::Default is today's behavior` | the recorded hook stdout for today's engine fixture corpus is **byte-equal** under the preset `default` | — | change the block reason text → red | |
| T-CFG-3 | `config::invalid falls back loudly` | — | corrupt, symlinked or oversized config → Default behavior + one stderr line + a `config.invalid` event, and the file is untouched | silently use Advisory → red | |
| T-CFG-4 | `round::model and effort threaded and recorded` | config `model=m1, effort=low` → the fake companion argv has `--model m1`, P2's effort mechanism is present, and the record and event show `source:"config"` | null → no `--model`, and `source:"codex-inherited"` with the values from the fixture `config.toml` | drop `--model` → red | |
| T-CFG-5 | `config::validation` | valid values stored | `effort=turbo` → exit 2 with the allowed list; a model with a space → exit 2 | accept anything → red | 🖊 D4 effort list |
| T-CFG-6 | `codex-home::never written` | the sha256 of every file under a fixture `$CODEX_HOME` is unchanged after setup, the live check (fake) and a round | — | write `model=` into `config.toml` in setup → red | |
| T-CFG-8 | `config::single resolver` | with `XDG_CONFIG_HOME=<tmp>/xdg`, setup writes `<tmp>/xdg/review-loop/config.json`, and hooks, doctor and uninstall all use that path; uninstall removes it and leaves `~/.config` untouched | a relative `XDG_CONFIG_HOME` → falls back to `~/.config`; a grep of `plugin/` and `cli/` for `".config"` or `XDG_CONFIG_HOME` finds them only in `config.mjs` | hard-code `~/.config` in uninstall → the custom-XDG config survives → red | |
| T-CFG-7 | `config::preset change applies next hook` | `config set preset advisory`, then the next `stop` evaluation → `warned`, with no restart | — | cache config at module scope across runs → red | |

### 11.4 Doctor, update, uninstall (AC-11, AC-13, AC-14)

| ID | Test | + | − | Sabotage |
|---|---|---|---|---|
| T-DOC-1 | `doctor::every check has a failing fixture` | registry completeness: each `DOCTOR_CHECKS` id is driven to `fail` (or `warn`) by a named fixture | — | add a check without a fixture → red |
| T-DOC-2 | `doctor::healthy` | all pass → exit 0, `ok:true` | — | — |
| T-DOC-3 | `doctor::json shape fixed` | stdout parses with a single `JSON.parse` into the `review-loop.doctor/1` shape, whose `event` equals the `cli.exit` line appended to `events.jsonl` | any second stdout line → fail | add a field → red; print the report and the event as two lines → red |
| T-DOC-4 | `doctor::read-only` | the sha256 of settings, config and state trees is unchanged | — | have doctor "fix" the mode → red |
| T-DOC-5 | `doctor::no paid call without --live` | the fake companion is never invoked | — | — |
| T-DOC-6 | `doctor::legacy hooks detected` | a legacy-hook fixture → `legacy_hooks` fail with the `review-loop migrate` fix | — | narrow the regex → red |
| T-DOC-7 | `doctor::version skew` | plugin 1.2.x vs CLI 1.2.y → pass; 1.3 vs 1.2 → fail | — | compare major only → red |
| T-DOC-8 | `update::issues exact commands then doctor` | the argv log is marketplace update, then plugin update, then doctor | the plugin update fails → exit 1 with its code; doctor still runs | — |
| T-DOC-9 | `shim::no node fails loud and logs` | with `REVIEW_LOOP_NODE_CANDIDATES=/nonexistent` and `PATH` without node:<br>• `stop` → a block JSON; with `stop_hook_active:true` → allow;<br>• `pr` with `gh pr create` → deny;<br>• `prverify` with `gh pr create` → **exactly** `{"continue":false,"stopReason":…}`, with no `decision` key;<br>• MCP create-PR input → deny or stop.<br>All six modes are run. Each PR-like, `stop`, `session`, `track` or `prompt` invocation appends one schema-v1 line with `code:"node_missing"` (`gate.decision` for gates, `hook.error` for the others). | (a) `pr` and `prverify` with a non-PR Bash command (`ls`) → exit 0, empty stdout, no event; (b) a state dir that is a symlink, or an events file as a directory → the decision is still emitted, with exactly one stderr line matching `^review-loop: event log not writable \((state_dir_insecure\|size_cap\|write_failed)\)$` and no path in it; (c) a hostile `session_id` → `null` | exit 0 silently → red; `prverify` emitting `decision:block` → red; drop the PR-like test (deny everything) → case (a) is denied → red; drop the stderr warning → case (b) is silent → red |
| T-UN-1 | `uninstall::order and stop-on-failure` | argv order is plugin uninstall, then marketplace remove, then settings, then config | the plugin uninstall fails → nothing else removed, exit 1 | swap the order → red |
| T-UN-2 | `uninstall::no dangling hooks` | after uninstall, no hook in settings or in installed plugins references the engine | — | skip the plugin uninstall → red |
| T-UN-3 | `uninstall::history default keep` | the default answer keeps the state dir; `--delete-history` removes it | — | — |
| T-UN-5 | `session::CLI missing guidance` | with `review-loop` absent from `PATH` (and from the Homebrew prefix fixture), the `session` hook's output contains `claude plugin uninstall review-loop@review-loop`, and appears only once per session | the CLI present → no such message | — |
| T-UN-4 | `uninstall::re-run completes` | inject a failure at step 3, re-run → completes, and no step errors on already-removed items | — | — |

### 11.5 Observability (AC-21)

| ID | Test | + | − | Sabotage |
|---|---|---|---|---|
| T-OBS-1 | `events::every line valid v1` | after the full CLI and hook corpus, each line validates | — | emit `at` instead of `ts` → red |
| T-OBS-9 | `events::every gate evaluation logged` | each row of the §8.2 "gate evaluation" table produces exactly one `gate.decision` with the stated outcome, including a **clean Stop allow** and a **clean prompt allow** with `pending_count:0` | a non-PR Bash command and `session`/`track` produce **no** `gate.decision` | skip the event on the no-pending path → red |
| T-OBS-2 | `events::cli.exit on every exit path` | exits 0, 1, 2, 3 (SIGINT) and 4 (an injected throw) each write exactly one `cli.exit` with a matching `exit_code` | — | skip on SIGINT → red |
| T-OBS-3 | `codes::registry complete` | every literal code in the source is registered | — | add `new ReviewLoopError("zzz_new")` → red |
| T-OBS-4 | `events::validated by value` | — | `code:"'; rm -rf"` → `unregistered_code`; an unknown `detail` → null; an unknown event → `event_unregistered` | allowlist keys only → red |
| T-OBS-5 | `events::content discipline` | — | no sentinel appears in `events.jsonl` (§8.4) | log the artifact path → red |
| T-OBS-6 | `events::bounds` | the computed maximum line size of every `EVENT_CATALOG` entry is ≤ 4 KiB; rotation at 5 MiB leaves ≤ 2 files | a 10 KB `session_id`, or an oversized string in any `data` field → replaced by its fallback, and the line validates as v1 and is ≤ 4 KiB | remove a field's bound from the catalog → the computed maximum exceeds 4 KiB → red |
| T-OBS-7 | `events::write failure never changes outcome` | `events.jsonl` as a directory → the Stop still blocks, the exit code is unchanged, there's one stderr warning, and doctor shows `events_writable` fail | — | rethrow the write error → red |
| T-OBS-8 | `readme::generated tables current` | `docs:check` passes | edit a remedy without regenerating → fail | — |

### 11.6 Plugin shape, content gate, release (AC-1, AC-2, AC-11, AC-15–17)

| ID | Test | + | − | Sabotage |
|---|---|---|---|---|
| T-SHAPE-1 | `shape::hooks.json matches today's six entries plus AC-23` | the events, matchers, modes and timeouts equal §0, plus the two §7.1 `PostToolUse` `prverify` entries (timeout 40) and the `mcp__.*__merge_pull_request` PreToolUse entry (mode `pr`, timeout 40): **9 entries in total** | — | drop the MCP matcher → red; drop a `prverify` entry → red; drop the merge matcher → red |
| T-SHAPE-2 | `shape::no absolute paths` | every command starts with `"${CLAUDE_PLUGIN_ROOT}/` | — | — |
| T-SHAPE-3 | `shape::dependency direction` | no file under `plugin/` imports `cli/` | — | add such an import → red |
| T-SHAPE-4 | `shape::versions equal` | cli = plugin.json = marketplace entry | — | bump one → red |
| T-SHAPE-5 | `shape::skill name namespaced in hook text` | hook messages say `review-loop:review-loop` | — | — |
| T-REL-1 | `content-gate::denylist` | a clean package passes | a fixture file containing `/Users/x` → fail naming the file and the rule, not the matched content | disable one pattern → red |
| T-REL-2 | `content-gate::allowlist` | — | an unlisted file in the package dir → fail | — |
| T-REL-3 | `selftest::asserts all four` | passes | break the Stop block in the engine → selftest exit 4 | — |
| T-REL-4 | CI `brew-no-home-writes` job | the `~/.claude` and `~/.codex` snapshots are identical before and after install, test and uninstall | — | add a `post_install` that touches `~/.claude` → red |

### 11.6a PR-head binding (AC-23)

| ID | Test | + | − | Sabotage |
|---|---|---|---|---|
| T-PR-1 | `prverify::match allows` | the fake `gh pr view` returns the reviewed SHA → no block, and `gate.decision` is `allowed` | a non-PR Bash `PostToolUse` → no event and no `gh` call | — |
| T-PR-2 | `prverify::mismatch drafts, verifies, stops` | the fake `gh` returns a different SHA (the race) → the argv log contains `pr ready <n> --repo <o/r> --undo`, then `pr view <n> --json isDraft`; the output is `continue:false`; the event is `pr_head_mismatch` with `detail:"drafted"` | (a) the draft succeeds but `isDraft` reads `false` → `pr close` is issued and `state` verified → `detail:"closed"`; (b) the close also fails → `detail:"uncontained"`, with a stop reason containing "open and unreviewed"; (c) Advisory → `systemMessage` only, no `gh` mutation, event `warned` | skip the comparison → red; skip the `isDraft` verification → case (a) reports `drafted` → red; emit `decision:block` instead of `continue:false` → red |
| T-PR-3 | `prverify::MCP paths` | (a) an MCP `tool_response` with a matching `head.sha` → allowed, and no `gh` needed; (b) **an official-server-shaped response `{"ID":…,"URL":"https://github.com/o/r/pull/7"}`** plus a fake `gh pr view 7` returning the reviewed SHA → allowed | (c) the same official-shaped response with `gh` absent → `continue:false` `pr_verify_unavailable` (Advisory: warn), and doctor `pr_binding` shows `warn`; (d) a `URL` for a different repo than the gated one → `pr_verify_unavailable` | a mismatched `head.sha` with no `gh` → `continue:false`, `detail:"uncontained"`, and doctor `pr_binding` shows `warn` | — |
| T-PR-4 | `prverify::unverifiable fails closed (Default/Balanced)` | — | no PR number in the response, or `gh pr view` fails → `continue:false` with `pr_verify_unavailable` | return allow on error → red |
| T-PR-13 | `policy::approval bound to its policy` | a pass records the policy fingerprint in the record and in the status description; after `config set rubric <other>`, the status is unchanged (no `gh` call), the merge gate still allows a merge bound to that SHA, and the command's stdout says approvals given earlier stay valid | a re-review of that PR under the new rubric that fails → `failure` posted (T-PR-5) | drop the policy fingerprint from the description → red |
| T-PR-10 | `prverify+merge::Advisory never blocks` | Advisory: for every `prverify` and merge case in T-PR-2, 4, 6 and 7, the output contains no `continue:false`, no `decision` and no `deny`, only a `systemMessage`; events have `outcome:"warned"` | — | let an unverifiable case fall through to the stop → red |
| T-PR-11 | `prverify::gh api create response` | `gh api -X POST repos/o/r/pulls` with stdout JSON `{"number":7,"head":{"sha":"<reviewed>"}}` and no URL → allowed with no `pr view` call | the same with a different `head.sha` → contained (T-PR-2 path); a malformed or oversized body → `pr_verify_unavailable` | ignore the JSON body → the matching case stops with `pr_verify_unavailable` → red |
| T-PR-12 | `gate::direct REST clients denied (best effort)` | — | `curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge`, the same with `wget` or `http`, and a `curl` POST to `/pulls` → deny `pr_github_api_unsupported_client`; `curl https://api.github.com/repos/o/r` (a GET, not pulls) → no decision | drop the client pattern → the merge is allowed → red |
| T-PR-6 | `merge::compound create and merge denied` | — | `gh pr create … && gh pr merge`, and the same with `;`, a newline, `\|\|` or a subshell → deny `pr_create_merge_compound`, with no fake-`gh` call | evaluate only the first segment → red |
| T-PR-7 | `merge::commit- and context-bound merges only` | with the fake `gh pr view` returning the reviewed PR's identity: `pr merge --match-head-commit <reviewed>`, `api -X PUT …/merge -f sha=<reviewed>`, and MCP merge using the field from the P7 schema fixture with `<reviewed>` → allow, each with a `gate.decision` `gate:"merge"` | (a) no binding → `pr_merge_unbound`, with the reason containing `--match-head-commit <reviewed-sha>`; (b) a binding to an **unreviewed** SHA → deny; (c) **the same reviewed head SHA, on a PR whose base branch differs** (retargeted, or a second PR) → deny `pr_merge_unbound`; (d) a graphql `mergePullRequest` → `pr_merge_graphql_unsupported`; (e) a repeated `-X` on `/merge` → `pr_args_unresolvable`; (f) no `gh`, or `pr view` failing → `pr_merge_context_unverifiable`; (g) the MCP input using a field **not** in the schema fixture (e.g. `sha`) → `pr_merge_unbound`; (h) a schema fixture without a head field → `pr_merge_mcp_unbindable`; (i) Advisory → warn and allow | accept any reviewed SHA regardless of identity → case (c) allows → red; skip the marker lookup → case (b) allows → red |
| T-PR-8 | `merge::non-merge commands untouched` | `gh pr view`, `gh pr checks`, `gh api -X GET …/pulls/5` → no decision and no event | — | — |
| T-PR-9 | `merge::retarget after gate check (fixture race)` | — | the fake `gh pr view` returns base `main` at gate time → allowed; a second fixture flips the base to `release` → the next merge evaluation denies `pr_merge_unbound`. The concurrent case (retarget after the gate's check) is covered by P7b against GitHub. | compare only the head SHA → the flipped case allows → red |
| T-PR-5 | `round::status reflects the latest verdict` | a PR round passes for base `main` → the fake `gh` argv is `api -X POST repos/<o>/<r>/statuses/<reviewed-sha>` with `state=success` and `context=review-loop/main`; the context for a PR against `release` is `review-loop/release`; an override → `success` with the "overridden" description | **pass, then a re-review of the same SHA and base returns needs-fixes → the second call posts `state=failure` with the same context and SHA, so the fake GitHub status store shows the check not green**; exit 30 → no status call; `gh` missing or the post failing → the round still passes (exit 0) with a `status_post_failed` event | post on the branch's current head instead of the reviewed SHA → red; skip the failure post → the pass-then-fail case stays green → red |

### 11.7 Migration (AC-18)

| ID | Test | + | − | Sabotage | 🖊 |
|---|---|---|---|---|---|
| T-MIG-1 | `migrate::single write swaps hooks` | on the author-shaped fixture, after migrate there are 0 legacy hooks, the ask rules are present, and exactly one settings write happened | the plugin install fails → settings bytes unchanged | two separate writes → red | |
| T-MIG-2 | `migrate::history preserved` | the state dir's markers and records from a fixture made by **today's** engine are readable by the packaged engine, and a subsequent Stop gives the same decision | — | change the marker validator key → red | |
| T-MIG-3 | `migrate::rubric override` | `config.rubricPath` = the fixture personal rules file, and the next round's rubric text comes from it | — | — | |
| T-MIG-4 | `migrate::old skill moved out of skills dir` | `~/.claude/skills/review-loop` is gone, and the archive holds it | — | rename in place → `skill_duplicate` doctor fail → red | |
| T-MIG-5 | `migrate::CLAUDE.md edit only on yes` | yes → the paragraph is replaced and a backup made | no → bytes unchanged | — | 🖊 D6 replacement text |
| T-MIG-6 | `migrate::legacy dir renamed only when doctor passes` | doctor passes → moved to `~/.claude/review-loop-legacy-<date>/engine` | doctor fails → not renamed, exit 1 | — | |
| T-MIG-7 | `migrate::rollback restores every resource` | after migrate, then `migrate --rollback`, on the author-shaped fixture:<br>• settings hooks are deep-equal to pre-migration;<br>• the ask rules equal pre-migration;<br>• the fake `claude` argv log shows plugin uninstall and marketplace remove;<br>• the skill dir is restored;<br>• the pin is at the legacy path;<br>• the config is absent;<br>• `CLAUDE.md` bytes are restored;<br>• the engine dir is restored;<br>• the legacy hook fixture Stop decision is the same as before migration.<br>Running it again is a no-op. | `CLAUDE.md` **or `config.json`** edited after migrate (e.g. `config set preset advisory`) → that item `rollback_skipped_modified` with its bytes unchanged, exit 1, and every other item restored | skip the plugin uninstall → the argv assertion fails → red; restore settings bytes wholesale instead of a read-modify-write → a foreign key added after migrate is lost → red | |

## 12. Gherkin scenarios

```gherkin
Feature: Install via Homebrew
  Scenario: Clean install touches nothing in HOME             # AC-1, AC-2
    Given a Mac with Homebrew and no review-loop
    When I run "brew install <owner>/tap/review-loop"
    Then node and git are installed as dependencies
    And the caveats tell me to run "review-loop setup"
    And nothing under ~/.claude or ~/.codex has changed

  Scenario: brew test runs a real smoke test                  # AC-16
    When I run "brew test review-loop"
    Then "review-loop selftest" proves a Stop block, a PR deny and a clean allow offline

Feature: Guided setup
  Background:
    Given review-loop is installed with Homebrew

  Scenario: Happy path                                        # AC-3, AC-4, AC-5, AC-6, AC-8, AC-9
    Given Claude Code, Codex (signed in) and the Codex plugin are installed
    When I run "review-loop setup" and accept the recommended choices
    Then I see a preflight table with OK for each required item
    And I am told what each change is and asked before it is made
    And the preset is "Default" and model and effort are "inherited from Codex"
    And a live Codex review passes
    And the summary tells me to restart Claude Code

  Scenario: Codex is not signed in                             # AC-4
    Given Codex is installed but not signed in
    When I run "review-loop setup"
    Then the preflight shows "FAIL Codex sign-in" and offers to run "codex login"
    And after I sign in the item is re-checked and shows OK

  Scenario: I decline a change                                # AC-3
    When I answer "n" to installing the plugin
    Then setup exits with code 3
    And the summary lists which steps completed and which did not
    And running setup again resumes without redoing completed steps

  Scenario: Invalid model name                                # AC-6, AC-9
    Given I chose the custom model "not-a-real-model"
    When the live check runs
    Then it fails with "live_check_failed: model_invalid"
    And tells me to run "review-loop config set model <valid>"
    And ~/.codex/config.toml is unchanged

  Scenario: settings.json is broken                           # AC-7
    Given ~/.claude/settings.json contains invalid JSON
    When setup reaches the approval-rules step
    Then it stops with exit code 1 and "settings_invalid_json"
    And settings.json is byte-for-byte unchanged

  Scenario: Running setup twice changes nothing               # AC-7
    Given setup completed successfully
    When I run "review-loop setup --yes --skip-live-check"
    Then settings.json has the same bytes and no new backup exists

Feature: Presets are enforced in every repo                   # AC-5, AC-10
  Scenario Outline: Ending a turn with an unreviewed spec
    Given my preset is "<preset>"
    And Claude changed docs/specs/x-design.md in any git repo
    When Claude tries to end its turn
    Then the Stop gate outcome is "<outcome>"
    Examples:
      | preset   | outcome |
      | default  | blocked |
      | balanced | warned  |
      | advisory | warned  |

  Scenario Outline: Opening a PR with unreviewed changes
    Given my preset is "<preset>"
    When Claude runs "gh pr create"
    Then the PR gate outcome is "<outcome>"
    Examples:
      | preset   | outcome |
      | default  | denied  |
      | balanced | denied  |
      | advisory | warned  |

  Scenario: Changing preset takes effect without restart
    When I run "review-loop config set preset advisory"
    Then the next Stop evaluation uses Advisory

  Scenario: Broken config falls back to Default, loudly
    Given config.json is corrupt
    Then gates behave as Default
    And a "config.invalid" event is written
    And "review-loop doctor" shows FAIL config with "review-loop config repair"

Feature: Safety controls are preserved                         # AC-12
  Scenario: Kill switch still requires my approval
    When Claude tries to create ".claude/review-loop.off"
    Then Claude Code asks me to approve it

Feature: A PR is bound to the reviewed commit                # AC-23
  Scenario: A push races PR creation
    Given the PR review passed at commit A
    And a new commit B is pushed after the PR gate allowed creation
    And gh is installed and signed in
    When the PR is created with head B
    Then the PR is converted to draft and the draft state is verified
    And Claude's session stops with "PR head B is not the reviewed A — converted to draft"
    And a "gate.decision" event with code "pr_head_mismatch" and detail "drafted" is written

  Scenario: Claude cannot merge an unreviewed head
    Given the PR review passed at commit A and the PR head is now B
    When Claude runs a gh pr merge with --match-head-commit A
    Then the gate allows it and GitHub refuses the merge because the head is B
    When Claude runs a gh pr merge without --match-head-commit
    Then the gate denies it with "pr_merge_unbound" and suggests "--match-head-commit A"

  Scenario: A reviewed head does not authorize a different base
    Given the PR review passed for head A against base "main"
    And the PR was retargeted to base "release"
    When Claude runs a gh pr merge with --match-head-commit A
    Then the gate denies it with "pr_merge_unbound"

  Scenario: A retargeted PR fails the required check
    Given branch protection on "release" requires "review-loop/release"
    And the PR's head A carries only "review-loop/main"
    When the PR is retargeted from "main" to "release"
    Then GitHub reports the PR as not mergeable until it is reviewed against "release"

  Scenario: Create and merge in one command is refused
    When Claude runs a single command that creates a PR and then merges it
    Then the gate denies it with "pr_create_merge_compound"

  Scenario: Without gh the race is detected and stopped, but not contained
    Given gh is not installed
    When a PR is created with an unreviewed head
    Then Claude's session stops with "PR #n is open and unreviewed; convert it to draft now"
    And "review-loop doctor" shows WARN pr_binding

  Scenario: The reviewed commit carries an approval mark
    When a PR review passes at commit A
    Then commit A has a "review-loop" success status on GitHub
    And a later commit B has no such status, so required-check repos cannot merge B

Feature: Diagnose, update, uninstall
  Scenario: Version skew after brew upgrade                   # AC-11, AC-13
    Given the CLI is 1.3.0 and the plugin is 1.2.4
    When I run "review-loop doctor"
    Then it shows FAIL version_skew with the fix "review-loop update"
    And exits with code 1

  Scenario: Node disappears                                   # AC-13
    Given node is not installed
    When Claude tries to end a turn with an unreviewed spec
    Then the turn is blocked with "Node.js not found — run: brew install node"

  Scenario: Uninstall leaves no dangling hooks                # AC-14
    When I run "review-loop uninstall" and keep history
    Then the plugin and marketplace are removed
    And only our five approval rules are removed from settings.json
    And no hook anywhere references the review-loop engine
    And ~/.claude/state/review-loop still exists

  Scenario: brew uninstall first, then nothing dangles and recovery is shown   # AC-14
    When I run "brew uninstall review-loop" before "review-loop uninstall"
    Then the plugin's hooks still resolve to files that exist
    And the next Claude Code session start prints how to finish uninstalling
    And following the README recovery leaves no review-loop plugin, ask rules or config

Feature: Machine-readable outcomes                            # AC-21
  Scenario: Every command leaves one exit event
    When I run any review-loop command, successfully or not
    Then exactly one "cli.exit" line with its exit_code is appended to events.jsonl
    And "--json" prints that same line on stdout

  Scenario: A clean allow is logged too
    Given nothing is pending in the repo
    When Claude ends its turn
    Then one "gate.decision" line with outcome "allowed" and pending_count 0 is appended
    And an ordinary Bash command such as "ls" appends no gate.decision line

  Scenario: No content leaks into events
    Given artifacts, paths and env values containing sentinel strings
    When hooks, rounds and commands run
    Then no sentinel appears in events.jsonl

  Scenario: Logging failure never changes a decision
    Given events.jsonl cannot be written
    When the Stop gate evaluates an unreviewed spec
    Then the turn is still blocked
    And one warning is printed and doctor reports events_writable FAIL

Feature: Migrate the author's machine                         # AC-18
  Scenario: Legacy install becomes the package
    Given hooks in settings.json point at ~/.claude/review-loop/review-gate-hook.mjs
    When I run "review-loop migrate"
    Then settings.json and the old skill are backed up
    And the plugin is installed and the legacy hooks removed in one settings write
    And review history is preserved
    And rubricPath points at my personal rubric
    And the old skill is moved out of ~/.claude/skills
    And ~/.claude/review-loop is renamed only after doctor passes
    And "review-loop migrate --rollback" is printed as the undo command

  Scenario: Rolling back a migration restores everything
    Given I migrated successfully
    When I run "review-loop migrate --rollback"
    Then the legacy hooks, skill, pin and engine directory are back
    And the review-loop plugin and marketplace are removed
    And the approval rules and CLAUDE.md are as they were before migration

Feature: Release                                              # AC-15, AC-16, AC-17, AC-20, AC-22
  Scenario: Nothing personal ships
    Given a packaged file contains "/Users/"
    Then the content gate fails naming the file and rule

  Scenario: Tagging a release updates the tap
    When I push tag v1.0.0 with matching versions
    Then CI builds the tarball and sha256 and opens a PR on the tap
    And the tap PR's CI runs brew audit and brew test

  Scenario: Deferred scope becomes issues
    Given the repo has been created, published and pushed
    When the deferred-issues task runs
    Then each §15 item exists as one open issue labelled "deferred" linking to this spec
    And running the task again creates no duplicates
```

## 13. Traceability

| AC | Gherkin feature | TDD |
|---|---|---|
| 1, 2 | Install via Homebrew | T-REL-4, T-SHAPE-* |
| 3, 4 | Guided setup | T-SET-1…5 |
| 5, 10 | Presets | T-CFG-1, 2, 3, 7 |
| 6 | Setup: invalid model | T-CFG-4, 5, 6 |
| 7 | Setup: settings | T-SET-8…14 |
| 8 | Setup: happy path | existing pin tests + setup step 6 in T-SET-5 |
| 9 | Setup: invalid model | T-SET-6, 7 |
| 11 | Diagnose: version skew | T-DOC-7, 8 |
| 12 | Safety controls | T-SET-14 + existing engine tests |
| 13 | Diagnose | T-DOC-1…9 |
| 14 | Uninstall | T-UN-1…4 |
| 15, 16 | Release | CI config + T-REL-3 |
| 17 | Release: nothing personal | T-REL-1, 2 |
| 18 | Migrate | T-MIG-1…7 |
| 19 | — | T-OBS-8 (generated tables) + README review in the loop |
| 20 | — | loop pass records on spec, plan, implementation and PR |
| 21 | Machine-readable outcomes | T-OBS-1…9 |
| 22 | Release: deferred issues | the deferred-issues task check (§15) |
| 23 | A PR is bound to the reviewed commit | T-PR-1…12, T-SHAPE-1 |

## 14. Migration of the author's Mac (runs once, after v1.0.0 is tagged)

The `review-loop migrate` steps, each backed up and each idempotent:

1. **Detect** legacy hooks, the legacy skill and the legacy pin. If none is found: "nothing to migrate",
   exit 0.
2. **Back up** `settings.json` (§6.2) and copy the old skill into `~/.claude/review-loop-legacy-<date>/skill/`.
3. **Install** the plugin (setup step 4).
4. **One settings write:** remove the six legacy hook objects and ensure the five ask rules. If step 3
   failed, this doesn't run, so the old gate stays in force. If this step fails, a double gate remains,
   which is safe and flagged by `doctor legacy_hooks`.
5. **Move the pin** into the state dir. Verify the copied file's sha256 before removing the original.
   Review history is already in the state dir and is not touched.
6. **Set the rubric:** `config.rubricPath = ~/.claude/rules/multi-dimension-review.md`.
7. **Remove** `~/.claude/skills/review-loop`. It was already copied in step 2, and it must leave the
   skills dir, or Claude would load two `review-loop` skills.
8. **Global `CLAUDE.md`:** show the diff replacing the "Automated review loop" paragraph's engine
   reference (`~/.claude/review-loop/CLAUDE.md`) with the plugin skill reference (🖊 **D6**). Apply it
   only on yes, with a backup.
9. **Run `doctor`.** Only if it exits 0, rename `~/.claude/review-loop` → `~/.claude/review-loop-legacy-<date>/engine`.
10. **Print** `review-loop migrate --rollback` as the undo command, and suggest a live round
    (`review-loop doctor --live`).

**Migration manifest.** Before each step mutates anything, it appends an entry to
`~/.claude/state/review-loop/migration.json` (0600, written with `atomicWriteJson`). An entry records:

- the resource;
- the action;
- the before-state: the sha256 and backup path, or "absent";
- the after-state sha256;
- the legacy hook objects removed, verbatim;
- the ask strings that were **added**, as opposed to already present.

**`migrate --rollback`** walks the manifest in **reverse**. Each step checks current state first, so it
is idempotent and resumable. The steps are:

1. Move `~/.claude/review-loop-legacy-<date>/engine` back to `~/.claude/review-loop`, if it was moved.
   This comes first, so restored hooks point at an existing engine.
2. Run a §6.2 settings write that re-inserts the recorded legacy hook objects and removes only the ask
   strings migrate **added**. The result is a double gate for a moment, which is safe.
3. Uninstall the plugin, then remove the marketplace, if migrate installed them.
4. Restore `~/.claude/skills/review-loop` from the archive.
5. Move the pin back.
6. **Config**, guarded like `CLAUDE.md`: act only if the current sha256 of the file at `configPath()`
   equals migrate's recorded after-sha.
   - If it does, delete the file (when migrate created it) or restore its before-bytes.
   - If it differs (the user changed the preset, model or rubric after migrating), leave it untouched
     and report `rollback_skipped_modified` for `config`. The report names the one field migrate set
     (`rubricPath`), so the user can reset it with `review-loop config set rubric`.
7. Restore `CLAUDE.md` from its backup **only if** its current sha256 equals migrate's after-sha.
   Otherwise, report `rollback_skipped_modified` for that item and leave it alone.
8. Mark the manifest `rolled_back`.

Rollback exits 1 if any item was skipped, naming each item.

## 15. Deferred (→ GitHub issues when the repo is created, published and pushed)

Each row becomes **one** GitHub issue labelled `deferred` (plus the listed label) on `<owner>/review-loop`,
with the body linking to this spec's §15.

- **Tooling:** created through the GitHub MCP, falling back to `gh issue create`, per `tooling-defaults`.
- **Idempotence:** look up an open issue with the same title first; create only if absent.
- **Gate (AC-22):** the open `deferred` issue count, looked up by title, equals the row count below; the
  plan's final task asserts this.
- **Timing:** this runs after the first push, not before, so the links resolve.

| # | Deferred item | Reason | Extra label |
|---|---|---|---|
| 1 | Linux and WSL support | macOS-only was agreed for v1; hooks, paths and CI need a second platform matrix | `platform` |
| 2 | Native Windows support | no Homebrew; shell shim and path semantics differ | `platform` |
| 3 | Submission to homebrew-core | requires notability and stable releases; our own tap first | `distribution` |
| 4 | Per-project presets | v1 has one user-global preset; per-repo needs precedence rules and a trust model for committed config | `enhancement` |
| 5 | Direct HTTP/OTLP event push | network and credentials in hooks; the file contract plus a log shipper covers v1 | `observability` |
| 6 | Automatic plugin update on `brew upgrade` | formulas must not write `$HOME`; `review-loop update` is manual in v1 | `distribution` |
| 7 | A killed round leaks `ws` temp dirs | known engine limitation carried over; needs a startup sweep with an ownership check | `engine` |
| 8 | The Stop gate fails closed on harmless text mentions | known false-positive class carried over; needs a narrower detector | `engine` |
| 9 | Override cannot work on criss-cross merge history | known engine limitation carried over | `engine` |
| 10 | `review-loop protect <repo>`: an automated branch-protection helper that requires the `review-loop` status | v1 documents the manual steps (§7.1). Automating it needs admin-scope tokens and per-repo consent. | `security`, `enhancement` |
| 11 | A source-restricted required check: a GitHub App posting check runs, which rulesets can require by app, so collaborators can't forge approval | v1's commit status (posted with the user's token) relies on trusted collaborators (AC-23). An App requires hosting, installation and key management. | `security` |
| 12 | An atomic-exchange commit for `settings.json` (`renamex_np(RENAME_SWAP)` through a tiny signed native helper), so an edit landing between the re-hash and the swap is recovered, not overwritten | Needs a native, signed binary: a new dependency and supply-chain surface. v1 refuses unless no writer is active, and states the residual window (§6.2). | `reliability` |
| 13 | Revoke earlier approval marks automatically when the policy changes (rubric, preset, version): enumerate open PRs with a `review-loop/*` success status and post `failure` or re-queue them | v1 binds each approval to its policy fingerprint and doesn't revoke retroactively (§7.1). Revocation needs cross-repo enumeration and GitHub auth over many repos. | `security`, `enhancement` |

## 16. Decisions (defaults apply unless you change them)

| ID | Decision | Suggested default |
|---|---|---|
| 🖊 D1 | GitHub owner for both repos | **none — required before publishing**; everything before publishing uses `<owner>` |
| 🖊 D2 | Minimum Node (`compat.minNode`) | 22 (LTS). The plan verifies engine APIs against it in CI. |
| 🖊 D3 | Live-check cost and privacy wording | §6.4 text |
| 🖊 D4 | Allowed effort values | `minimal\|low\|medium\|high\|xhigh`, confirmed by P2 |
| 🖊 D5 | Balanced semantics | Stop warns, PR denied (§5.2) |
| 🖊 D6 | Replacement text for your `CLAUDE.md` paragraph | "Engine, invariants and tests: the `review-loop` plugin (`review-loop doctor`; repo `<owner>/review-loop`)." |
| 🖊 D7 | MIT copyright holder name | your name |
| 🖊 D8 | Preset descriptions in setup | §5.2 text |

## 17. Maintainability: the likely next changes

| Next change | Touchpoints | Gate that fails if one is skipped |
|---|---|---|
| New error or failure code | `lib/codes.mjs` only; the README regenerates | T-OBS-3, T-OBS-8 |
| New doctor check | a `DOCTOR_CHECKS` entry plus its failing fixture | T-DOC-1 |
| New preset | the `PRESETS` table in `policy.mjs` plus setup copy | T-CFG-1 iterates `PRESETS`, so a missing matrix row fails |
| New hook event or mode | `hooks.json` plus the engine `MODE` | T-SHAPE-1 compares both directions |
| New event type | an `EVENT_CATALOG` entry | T-OBS-1 and T-OBS-4 |
| New CLI command | the `COMMANDS` table (help, dispatch, exit codes) | a test asserts every `COMMANDS` entry has help text and a test file |
| Codex companion upgrade | re-pin (the existing flow) plus a re-run of P2 | the pin gate pages on drift (AC-8) |

## 18. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A push races PR creation | low | AC-23: post-create verification, draft conversion and the commit-bound status (§7.1) |
| P1 fails: plugin hooks don't block | low–med | Hard gate; the author picks A or C. The design keeps the engine identical across approaches, so only the install layer changes. |
| P2 fails: no per-review effort | med | Display-only effort plus the author's decision (§4) |
| Claude Code changes hook semantics later | med | P1 and P5 on every release; `selftest` on every `brew test` |
| A user runs Claude from the GUI, so its PATH lacks Homebrew | med | Shim fixed-path lookup plus the `node_for_hooks` doctor check |
| A compromised marketplace `main` pushes code to users | low | Protected `main` plus CI; ref-pinning if supported (§9) |
| Codex cost surprises users | med | Setup and README cost note; doctor never spends without `--live` |
