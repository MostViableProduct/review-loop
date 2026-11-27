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
- `.claude/review-context.md` decides which findings block. Claude needs your approval to edit it, but the approval
  rules match the plain ways to do it (`Edit`, `Write`, a shell command naming the file), as they do for the kill
  switch and `override`: a path built at run time can get past them. For a pull request it is read from the base
  branch, so it changes the gate only once it is on that branch.
- At Stop, a spec or plan that arrived from outside this checkout counts as reviewed where it was written, because a
  pull, a merge of `origin/main` or a switch to a pushed branch brings in other people's work. A move of HEAD
  brings its new commits in when its new tip is contained in a tip that a remote-tracking ref shows being fetched
  before the move: a fast-forward pull, a switch to a branch already pushed, `git reset --hard origin/main`, a
  rebase onto it, a checkout of `FETCH_HEAD`. A merge brings in its second parent's side the same way, whether or
  not it stopped on a conflict. What a merge commit itself changed against every parent (a hand-resolved conflict, a
  file added in the merge) is the session's own edit and is listed, through `git log --cc`; a clean merge, or one that
  takes a side wholesale, adds nothing. review-loop reads this from the reflogs git writes: HEAD's shows each move, and a
  remote-tracking ref's shows whether a tip was fetched (before the move) or pushed. Reflog times are whole
  seconds, so a fetch in the same second as a move is not known to be earlier and the commits stay listed, except for
  a `git pull`, whose own fetch always comes first. Each commit belongs to the
  first move that made it reachable, so a commit Claude made here, a local branch it merged, a commit it pushed,
  and a tip fetched only afterwards all stay listed, and so does a merge of three or more parents. Claude can write
  false reflog entries on purpose (`git update-ref -m "pull: Fast-forward" HEAD`, and the same for a remote-tracking
  ref), and Stop then stops listing the commits that move HEAD over. A commit made in another checkout and moved in
  after being fetched is left to that checkout's own Stop, and so is a spec a collaborator merged to `main` without
  review. Moves older than the newest 100 that are not commits made here are not read, so their commits stay listed.
  The pull request review and the required check still cover those commits before they merge.
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
