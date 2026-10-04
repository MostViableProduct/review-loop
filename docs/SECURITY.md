# What review-loop can and can't stop

review-loop is a guardrail for Claude Code, not a sandbox. It stops Claude from finishing with unreviewed work and
from opening or merging unreviewed pull requests through Claude Code's standard GitHub tools. For a team, **branch
protection is the real control**: it makes GitHub itself refuse an unreviewed merge, whoever or whatever attempts it.

## Require review before merging

review-loop posts a commit status named `review-loop/<base branch>` on every pull request it approves. Add that
status as a **required check** in the branch protection or ruleset of each protected branch (the steps are in the
[README](../README.md#for-teams-require-review-before-merging)). A base branch name with characters a status name
can't hold is percent-encoded: for base `release/1.x`, require `review-loop/release%2F1.x`.

## Risks that remain

- The status is posted with your own `gh` token. A collaborator with write access could post a fake
  success. Require it only in repos where you trust your collaborators.
- Without a required check, review-loop can only stop merges that go through Claude Code's standard
  GitHub interfaces (`gh`, `gh api` and the GitHub MCP tools). A merge from the web UI or another tool
  is not stopped.
- In a repo without the required check, a PR retargeted to another base between review-loop's check and
  GitHub processing the merge can land the reviewed head on an unreviewed base.
- Approvals given before a policy change (rubric, preset, version) stay valid. To review an open PR under
  the new policy, re-run the loop on it.
- Without `gh` (GitHub MCP tools only), review-loop can't check or contain a new PR's head commit, so
  under `default` and `balanced` Claude is stopped after each PR it creates. Install and sign in to `gh`
  (`brew install gh && gh auth login`) for automatic checks.

## Outside the gated interfaces

This list is quoted from the "Outside the gated interfaces" note in this repo's
[`CLAUDE.md`](../CLAUDE.md). The gate does not see:

> - `GH_HOST` or other GitHub Enterprise hosts (`gh api --hostname` other than github.com is refused, but `GH_HOST` in the environment is not read);
> - curl URL globbing (`api.github.com/repos/o/r/{pulls,x}/5/merge`, `[1-9]` ranges);
> - a gh command or subcommand spelled only by a run-time expansion the text doesn't show: a glob (`/opt/homebrew/bin/g[h]`, filesystem-dependent), a variable, a shell alias or function, or `eval`;
> - gh aliases defined outside the agent (the user's gh config);
> - an IP address or another hostname for the API, with a `Host: api.github.com` header;
> - scripting languages and SDKs (python `requests`, `node -e fetch(...)`, octokit, `gh` extensions);
> - HTTPie `--raw` bodies and other clients the spec does not name;
> - branch merges that need no PR: the GraphQL `mergeBranch` mutation and `POST repos/o/r/merges`.
>
> In a repo whose branch protection requires `review-loop/<base>`, none of these can land an unreviewed
> head or base context.

## Where plugin updates come from

The `review-loop` CLI you install with Homebrew is pinned: the formula names one release tarball and its
sha256. The Claude Code plugin is not. `setup` adds this repository as a plugin marketplace without a git ref,
and the plugin's source is `./plugin` in the same repository, so the marketplace is not pinned to a tag and
`claude plugin update` installs what is on `main`. The control is branch protection: `main` accepts changes
only through a pull request with CI passing, and releases are tagged only from `main`.
