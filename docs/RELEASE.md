# Releasing review-loop

Every step is a command with its expected output. Stop at the first mismatch.

## One-time setup (before the first release)

- `main` is protected: changes land only through a pull request with CI green. The marketplace is not pinned
  to a tag (see the README, "Where plugin updates come from"), so this protection is what stands between a
  bad commit and every user's next `claude plugin update`.
- A `release` environment on `MostViableProduct/review-loop` (Settings → Environments) with a required reviewer. It holds
  one secret, `TAP_PR_TOKEN`: a fine-grained token limited to `MostViableProduct/homebrew-tap`, with Contents and Pull
  requests write. Only the workflow's `tap-bump` job reads it, and only after the reviewer approves.
  - Deployment branches and tags: **Selected** → add the tag rule `v*.*.*`, so no other ref can start the job.
  - Turn on **Prevent self-review**: the person who pushed the tag can't approve their own tap bump.
- The private content-gate denylist as a repository secret, `CONTENT_GATE_DENYLIST` (Settings → Secrets and
  variables → Actions → New repository secret): a JSON array of `{ "name": "...", "pattern": "..." }`, the same
  list as your local `.content-gate.private.json` (gitignored, never committed). It holds the author's handle and
  private org and project names, which must never appear in this repo. Limits: at most 64 entries; each name is
  1–32 characters of `a-z`, `0-9` and `_`, and is printed in findings, so use neutral names such as `private_1`;
  each pattern is a case-insensitive regular expression of at most 200 characters that can't match an empty
  string, and is never printed. Check it locally first: `CONTENT_GATE_DENYLIST="$(cat .content-gate.private.json)"
  node scripts/content-gate.mjs --tracked --require-private` → `content-gate: ok (… tracked files, private rules)`.
  The `release` job passes `--require-private` to every gate run, so it fails at its first gate step when the secret
  is missing, empty or invalid. CI passes the secret only on a push to `main` (merged code); a pull request, even from a branch of
  this repo, never gets it and runs the generic rules with a notice.
- A tag ruleset (Settings → Rules → Rulesets → New tag ruleset) targeting `v*`: restrict creations, updates and
  deletions to the release maintainers, so only they can start a release.
- Tags are signed (spec §9), but CI doesn't verify the signature; it checks only that the tagged commit is on
  `main`. The releaser verifies the signature locally before pushing: `git tag -v vX.Y.Z` → `Good signature`.
- Homebrew floor: the formula uses `formula_opt_bin`, which Homebrew has had since 6.0.3. On an older Homebrew
  the formula fails to load; `brew update` fixes it.

## Each release

1. `node scripts/bump-version.mjs X.Y.Z && node scripts/release-check.mjs X.Y.Z; echo "exit=$?"`
   → `version X.Y.Z stamped in 4 files`, `release-check: all four versions are X.Y.Z`, `exit=0`
2. `claude plugin validate --strict plugin && claude plugin validate --strict .` → both exit 0
3. `(set -o pipefail; npm test 2>&1 | tail -3)` → `# fail 0`; with your local `.content-gate.private.json`,
   `node scripts/content-gate.mjs --require-private` → `content-gate: ok (…)` and
   `node scripts/content-gate.mjs --tracked --require-private` → `content-gate: ok (… tracked files, private rules)`;
   `npm run docs:check` → `README tables are current`; `npm run sabotage` →
   `sabotage: every break went red for its named test`
4. Re-run probes P1 and P5 against the installed Claude Code, in an empty directory holding a signed-in
   `.claude` (never your real one):
   `PROBE_HOME=<that dir> sh scripts/probes/p1-p5/run.sh` → every `P1.…` and `P5.…` line shows the value its
   `(expect …)` names
5. `npm run e2e` (paid; needs Codex sign-in) → `# fail 0`
6. Dogfood (AC-20): the release PR itself passes the review loop at 9.2. Before the author has migrated
   (Task 29), that is the legacy loop running the same engine; afterwards it is the plugin. `$RR status`
   shows the PR marker with `status: passed`.
7. Merge the release PR, then `git tag -s vX.Y.Z -m "review-loop X.Y.Z" && git tag -v vX.Y.Z` → `Good signature`;
   then `git push origin vX.Y.Z` → the
   `release` workflow's `release` job goes green: a GitHub release with `review-loop-X.Y.Z.tar.gz`, and the
   plugin tag `review-loop--vX.Y.Z`
8. Approve the `tap-bump` job (the `release` environment) → a PR titled `review-loop X.Y.Z` appears on
   `MostViableProduct/homebrew-tap`
9. The tap PR's `tests` workflow is green on both runners → merge it
10. On a clean Mac user: `brew install MostViableProduct/tap/review-loop && review-loop --version && brew test review-loop`
    → `review-loop X.Y.Z` (on stdout), and `brew test` exits 0

## If the workflow fails part-way

- **Before the `GitHub release` step:** nothing was published. Fix the cause on `main`, delete the tag
  (`git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`), bump to the next patch version and start again
  from step 1.
- **At or after `GitHub release`, in the `release` job:** fix a transient cause (a network error, a failed
  install) and re-run the failed jobs from the Actions page. The re-run finds the published release and requires
  its archive to be the one it rebuilt, byte for byte. It uploads the archive if the release has none, and skips
  the plugin tag when that tag is already on this commit. It stops with an error instead of replacing a different
  archive or moving the tag. If the cause needs a code change, delete the release and its tag
  (`gh release delete vX.Y.Z --cleanup-tag --yes`), delete the plugin tag if it was pushed
  (`git push origin :refs/tags/review-loop--vX.Y.Z`), then continue as above.
- **`Plugin tag` needs sign-in on the runner:** delete that step from `release.yml` in a PR, and from then on
  run `claude plugin tag plugin --push` locally, right after step 7's workflow run passes its version check.
- **In the `tap-bump` job:** the release is already published. Re-run only that job from the Actions page; it
  reuses the `release` job's version and sha256. A branch `review-loop-X.Y.Z` that is already on the tap is
  reused when it carries this exact formula, and an existing PR for it is not opened twice. A branch with a
  different formula stops the job: delete that branch on the tap, then re-run.
