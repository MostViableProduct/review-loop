---
name: review-loop
description: Use when the review-loop Stop gate, PR gate, or prompt hook reports an artifact (spec, plan, implementation, or PR) as pending/unreviewed, or when you have just created or substantially changed a spec, plan, implementation, or are about to open a PR. Runs the automated 11-dimension Codex adversarial review loop to a 9.2 pass, handling fixes, disputes, checkpoints and paging the user.
---

# Review Loop — automated 11-dimension Codex review

The review-loop plugin's hooks detect artifacts that changed this session and block
until they pass. This skill is how you clear them. Engine: `${CLAUDE_PLUGIN_ROOT}/engine/review-round.mjs`.

```
node "${CLAUDE_PLUGIN_ROOT}/engine/review-round.mjs"
```

Below, `$RR` stands for that command. Keep the double quotes around the path: a plugin root can contain spaces.
The commands the hooks print already quote it; run them as printed.

## Triggers (what the hooks enforce)

| Artifact | Detected by | Enforced by |
|---|---|---|
| spec (`**/specs/**/*.md`, `*-design.md`, `*-spec.md`) | Stop hook (git status vs session-start snapshot) + file-tool marker | Stop gate |
| plan (`**/plans/**/*.md`, `*-plan.md`, `~/.claude/plans/*.md`) | same | Stop gate |
| implementation (files git would commit, excl. docs/.claude/graphify-out/.remember) | Stop hook | Stop gate |
| PR (GitHub CLI or GitHub MCP create-PR) | PreToolUse gate | PR gate (hard deny) |

Order of operations: write the spec/plan → **run this loop** → only then present it and ask for "go".
Never call an artifact reviewed/ready, and never ask for "go" on it, unless its status is `passed` or
`overridden`; when you present one, show its status line.

## The loop — one round at a time

1. Run the command the hook printed (e.g. `$RR run --kind spec --path "<abs>" --project-root "<root>"`,
   `$RR run --kind impl --path "<repo>"`, or `$RR run --key <key>` for a PR) with the Bash tool using
   `run_in_background: true` and a 900000 ms timeout — a round takes ~2–8 min. You are re-invoked when it exits.
2. Read the JSON on stdout. **The exit code decides the next step:**

| Exit | Meaning | Do |
|---|---|---|
| 0 | passed (or nothing to review) | Report the dimension table, `score.arithmetic`, and `coveredScope`. Done. For a PR: `$RR push --key <key>`, then retry the PR. For a PR, the engine also posts the `review-loop/<base>` status on the reviewed commit, so branch protection can require the review to have passed. |
| 10 | needs fixes | Go to step 3. |
| 20 / 21 | checkpoint / stall | **Page** (below) with `awaiting.options`. |
| 22 | human decision (dispute deadlock, criss-cross history, head diverged, push rejected) | **Page** with `awaiting.options`. |
| 30 | operational error | If `error.retryable` and `error.attempts` < 3: wait 30 s / 60 s / 120 s (per attempt) and re-run. Otherwise stop and report `error.code` + message loudly. **Do not page.** The artifact stays blocking: only a fix, or an override the user approves, clears it. |
| 40 | plugin pin / companion contract mismatch | **Page** with `awaiting.options`; show `awaiting.detail` (changed files) first. |
| 50 | busy (another session is reviewing this artifact) | Wait in the background (poll `$RR status` or retry every 2 min, max 20 min), then re-run. |

3. **Fixes (exit 10).** Treat each finding skeptically (if the `superpowers:receiving-code-review` skill is installed, use its
   posture; otherwise verify each finding against the code before acting):
   - **Valid** → fix it with a targeted edit. For a PR review, commit the fix (`review-loop round N fixes`).
   - **Invalid** → dispute with concrete evidence (file:line, test, doc):
     `$RR dispute --key <key> --finding <i> --reason "<evidence>"` (use `--kind/--path` instead of `--key` for spec/plan/impl).
     A disputed finding still counts until Codex drops it; if Codex re-raises it twice you will get exit 22.
   - **A product or security decision** (access control, data lifecycle, user-visible behavior with no single
     right answer) → **page** with the concrete alternatives + "Stop"; do not choose silently.
   - After fixing code, **run the project's tests and show the output**, then go to step 1.

## Paging (only when human judgment is required)

A page = `PushNotification` (one line, ≤200 chars, leads with the decision, e.g.
`review-loop: spec auth-design.md at round 10, score 8.6 — continue, +10, accept, or stop?`) **plus**
`AskUserQuestion` whose options are exactly `awaiting.options[].label` (header `Review loop`).
Then record the answer:

```
$RR decide --key <key> --option <id>      # ids: continue | more | accept | stop | accept-finding | waive | repin | override | merge | pull
```

- `continue` = Continue until 9.2 (uncapped; pages again on a 3-round stall or 20 rounds later).
- `more` = 10 more rounds. `accept`/`override`/`waive` are logged overrides. `stop` = the user takes over.
- `repin`: first show the user `awaiting.detail` (which plugin files changed), then decide.
- `decision_stale` (exit 30): the artifact or plugin changed after the page was shown. Re-run the round to get a
  current page and ask again — never re-send the old answer. A re-shown page with `awaiting.stale: true` means the
  artifact moved on: tell the user before offering "accept" (it will be refused).
- `merge` / `pull`: perform the merge/pull yourself (never force-push), then re-run the round.

Never page for: routine progress, operational errors, `busy`.

## Skipping review (kill switch)

- The user says "skip review" → `$RR override --key <key> --reason "user said skip review"` (or `--kind/--path`).
  Say plainly that the artifact is NOT reviewed.
- Per repo: the USER creates `<repo>/.claude/review-loop.off` (with `! touch …` or outside Claude Code) before a session;
  it disables the Stop and PR gates there from the next session start (each PR through it is logged). A committed or
  mid-session switch is ignored. Never create it yourself — the attempt prompts the user (permissions.ask).
- `decide`, `override` and `repin` prompt the user for permission (permissions.ask) — run them only to record an answer
  the user actually gave; a denied prompt means they did not approve it.

## Status

`$RR status --cwd <dir> --session <id>` lists this session's pending artifacts and PR markers.
Every artifact's full history lives in `~/.claude/state/review-loop/records/<key>.json`; the structured
event log is `~/.claude/state/review-loop/events.jsonl` (codes and counts only — never content).

## Presets

Default blocks at Stop and denies PRs, Balanced warns at Stop but still denies PRs, and Advisory only warns.
The bar is identical in all of them (mean >= 9.2 and every dimension >= 9.2). Check yours with
`review-loop config show`.

## Automated review loop (default on)

Creating or changing a **spec**, a **plan**, an **implementation**, or opening a **PR** triggers the automated
11-dimension Codex adversarial review loop, which must reach **9.2** (mean >= 9.2 and every dimension >= 9.2).
Hooks enforce it: the Stop gate blocks while a changed artifact is unreviewed, and the PR gate denies PR
creation until the exact PR diff has passed. When a hook reports a pending artifact, use this skill. Run the
loop on a spec or plan **before** presenting it and asking for "go".

- First checkpoint at **10 rounds**: page the user (PushNotification + question) with
  Continue until 9.2 / 10 more rounds / Accept current score / Stop.
- Otherwise page the user **only** when human judgment is required (a product or security decision, a finding
  Codex re-raises twice after a dispute, plugin drift, diverged history, a rejected push). Operational errors
  are reported, not paged.
- "skip review", or a local untracked `<repo>/.claude/review-loop.off` present when the session starts, is a
  visible, logged override (a committed or mid-session switch is ignored). Overrides need the user's approval:
  `permissions.ask` prompts for `review-round.mjs override|decide|repin` and for anything that touches the switch.
