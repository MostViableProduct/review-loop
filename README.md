# review-loop

review-loop gives Claude Code a second opinion it can't skip. When Claude writes a spec, a plan or code, or
tries to open a pull request, review-loop has OpenAI's Codex review the work. Codex scores it on 11 qualities,
such as correctness, safety and usability. Claude fixes what Codex finds and asks again, until every score is
at least 9.2 out of 10. You are interrupted only when a decision is genuinely yours.

## What you need

- A Mac running macOS 14 or newer, Apple silicon or Intel
- [Homebrew](https://brew.sh) 6.0.3 or newer
- [Claude Code](https://claude.com/claude-code) 2.1.285 or newer
- An OpenAI or ChatGPT account that can use Codex. Reviews are billed to it (see [Cost and privacy](#cost-and-privacy)).
- Recommended: GitHub's `gh` command, signed in, if Claude opens pull requests for you

`review-loop setup` offers to install anything missing: Claude Code, the Codex CLI, the Codex sign-in, and the
Codex plugin for Claude Code.

## Install

1. Install the command:

       brew install MostViableProduct/tap/review-loop

2. Quit Claude Code. In a normal terminal window (not inside Claude Code), run:

       review-loop setup

   Setup checks each requirement and shows the exact command for anything missing. It asks before every
   change, then runs one real review to prove everything works.
3. Start Claude Code again.

To check the install at any time, run `review-loop doctor`. It changes nothing, and each problem it finds
comes with the command that fixes it.

## What you'll see

1. **You work with Claude as usual.**
2. **Claude finishes a turn after changing a spec, a plan or code.** review-loop stops it with a message like:

   > review-loop: 1 artifact(s) changed this session and are not reviewed. Invoke the review-loop:review-loop skill and run: …

   This is expected. Claude starts a review on its own.
3. **Claude runs a review round.** A round is one Codex review and usually takes 2–8 minutes in the background.
   Claude reads the findings, fixes the valid ones, argues the wrong ones with evidence, and runs the next round.
4. **The work passes when all 11 scores reach 9.2.** Claude shows you the score table and carries on.
5. **Pull requests are held to the same bar.** Claude can't open a pull request until its exact changes have
   passed. With `gh` signed in, review-loop then marks the commit on GitHub as reviewed (a
   `review-loop/<base branch>` status).

Claude asks you, with a notification and a question, only when:

- 10 rounds have run without passing. You choose: keep going until 9.2, run 10 more rounds, accept the current
  score, or stop.
- Scores stop improving, or Claude and Codex disagree about a finding twice.
- A finding needs a product or security decision.
- The Codex plugin changed since setup, so review-loop asks before trusting it again.
- Git history needs a merge or pull that Claude shouldn't decide alone.

### What gets reviewed

| Kind | Which files |
|---|---|
| Spec | Markdown in a `specs/` folder, or named `*-design.md` or `*-spec.md` |
| Plan | Markdown in a `plans/` folder, or named `*-plan.md`, and plans in `~/.claude/plans` |
| Code | Any other file git would commit, except Markdown and text files (`.md`, `.mdx`, `.txt`) and tool folders (`.claude/`, `graphify-out/`, `.remember/`) |
| Pull request | Any pull request Claude opens with `gh` or GitHub's MCP tools |

## Words you'll see

| Word | Meaning |
|---|---|
| artifact | a piece of work that gets reviewed: a spec, a plan, a code change or a pull request |
| round | one Codex review of one artifact |
| dimension | one of the 11 qualities Codex scores |
| page | a notification plus a question, when Claude needs your decision |
| checkpoint | the page after 10 rounds without passing |
| preset | how strictly review-loop stops Claude (below) |
| kill switch | a way to turn review off on purpose (below) |
| pin | review-loop's record of the Codex plugin it trusts; a change to that plugin needs your OK |

## Presets

| Preset | Finishing with unreviewed work | Opening a pull request | Merging an unreviewed pull request |
|---|---|---|---|
| `default` (recommended) | blocked | blocked | blocked |
| `balanced` | reminded | blocked | blocked |
| `advisory` | reminded | reminded | reminded, unless your repo requires the `review-loop/<base branch>` check |

Change it any time, for example `review-loop config set preset balanced`. The bar (every score at least 9.2)
is the same in every preset.

## The kill switch: skipping review on purpose

- **For one piece of work:** tell Claude "skip review".
- **For a whole repo:** create an empty file `.claude/review-loop.off` in the repo before you start Claude
  Code, and don't commit it.

Either way, Claude Code asks for your approval first, and the skip is logged. A switch committed to the repo
is ignored, and one created during a session takes effect only from the next session.

## Cost and privacy

- Every round is a real Codex run, billed to **your** OpenAI or ChatGPT account. The checkpoint after 10
  rounds is your spending limit: Claude can't run more without asking you.
- `setup` runs one review to prove the install works. `setup --skip-live-check` and `doctor` spend nothing;
  `doctor --live` runs one review.
- Reviews send the changed files and some repo context to OpenAI, **under your account**.
- review-loop sends nothing anywhere else; there is no telemetry. Its log
  (`~/.claude/state/review-loop/events.jsonl`) holds codes, counts, scores and model names only: never file
  paths, file contents, review text, emails or environment values.

## Common problems

Run `review-loop doctor` first. Each line marked FAIL names the problem and the command that fixes it.

| You see | Do this |
|---|---|
| `claude_running` | Quit every Claude Code window, then re-run the command. |
| `claude_parent_process` | Run the command in a normal terminal, not inside Claude Code. |
| `codex_auth` or "not signed in" | Run `codex login`. |
| `codex_failed` or `codex_timeout` | Check that `codex` works in a terminal, then ask Claude to re-run the review. |
| Claude keeps stopping with "not reviewed" | That's the gate working: let Claude finish the review, or use the [kill switch](#the-kill-switch-skipping-review-on-purpose). |
| `plugin_pin_mismatch` | The Codex plugin was updated. Ask Claude to resume the review, check what changed, and approve it. |
| `gh_unavailable` | Run `brew install gh && gh auth login`. |
| `plugin_version_skew` | Run `review-loop update`. |

Every code, with its fix: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Commands

| Command | What it does |
|---|---|
| `review-loop setup` | guided install; safe to re-run |
| `review-loop doctor [--live]` | checks everything and changes nothing; `--live` also runs one real (billed) review |
| `review-loop config show` | shows your settings |
| `review-loop config set <key> <value>` | changes a setting: `preset`, `model`, `effort`, `rubric` or `events.path` |
| `review-loop update` | updates the Claude Code plugin after `brew upgrade review-loop`, then runs `doctor` |
| `review-loop uninstall` | removes the plugin, its approval rules and its settings; asks whether to keep your review history |
| `review-loop migrate [--rollback]` | moves a hand-installed review loop to the plugin, or undoes that |
| `review-loop selftest` | an offline check of the installed files (what `brew test` runs) |
| `review-loop engine-path` | prints where the plugin's review engine is installed |

`review-loop <command> --help` explains a command and its options. For scripts, `--yes` skips the questions
(`setup --yes` also runs the billed review unless you add `--skip-live-check`), and `--json` prints one line of
JSON. Exit codes and script use: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#for-scripts).

## For teams: require review before merging

review-loop marks each pull request it approves with a GitHub status named `review-loop/<base branch>`.
To make GitHub itself refuse unreviewed merges:

1. On GitHub, open the repo's **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.
2. Target your protected branch (for example `main`) and set **Enforcement** to **Active**.
3. Turn on **Require status checks to pass**, choose **Add checks**, and add `review-loop/main`. A base
   branch name with characters a status name can't hold is percent-encoded: for `release/1.x`, add
   `review-loop/release%2F1.x`.

Without this, review-loop stops only the merges Claude makes. It can't stop a merge from GitHub's website or
another tool. What review-loop can and can't stop, and the risks that remain:
[docs/SECURITY.md](docs/SECURITY.md).

## Uninstall

Run these in order:

    review-loop uninstall
    brew uninstall review-loop

If you ran `brew uninstall` first, Claude Code shows the leftover command at its next start
(`claude plugin uninstall review-loop@review-loop`), or recover fully:

    brew install MostViableProduct/tap/review-loop && review-loop uninstall && brew uninstall review-loop

## More

- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): every error code and its fix, exit codes, script use
- [docs/SECURITY.md](docs/SECURITY.md): what the gate can and can't stop, and where plugin updates come from
- [docs/EVENTS.md](docs/EVENTS.md): sending the event log to your log pipeline
- [CONTRIBUTING.md](CONTRIBUTING.md): developing review-loop, and the content gate
- [docs/RELEASE.md](docs/RELEASE.md): how releases are made and verified

## License

MIT
