# Contributing to review-loop

The stack, the invariants every change must keep, and where each piece lives are in [CLAUDE.md](CLAUDE.md). Changes
land on `main` only through a pull request with CI passing.

## Running the checks

    npm test                        # the whole suite; it never runs the real Claude Code, Codex, gh or brew
    npm run docs:check              # the generated tables in docs/TROUBLESHOOTING.md are current
    npm run content-gate            # no personal content in the packaged files
    npm run sabotage                # each load-bearing test goes red when its code is broken on purpose

`npm run e2e` runs one real, billed review against an isolated Claude Code config; see CLAUDE.md before running it.

## Where CI runs

Apple silicon and Intel Macs are both supported. CI runs every push on `macos-14` (arm64) and on the Intel
runner `macos-15-intel` (x86_64); if GitHub stops offering an Intel runner, the Intel leg falls back to Node
under Rosetta (`arch -x86_64`) on `macos-14`.

## The content gate

`npm run content-gate` checks every packaged file, and every file and directory name, for personal content:
home-directory paths, references to a personal Claude rules folder, and email addresses other than `@example.com`
fixtures. It prints the file, line and rule name, never the matched text.

The maintainer's handle and private org and project names are a second, **private denylist** that is not in this
repo. The gate reads it from the `CONTENT_GATE_DENYLIST` environment variable (a repository secret in CI), else from
a gitignored `.content-gate.private.json` at the repo root. Both hold a JSON array of up to 64
`{ "name": "...", "pattern": "..." }` entries: a name of 1 to 32 lowercase letters, digits or `_`, which findings
print, so keep it neutral; and a case-insensitive regular expression of up to 200 characters, which is never printed.
`node scripts/content-gate.mjs --tracked` scans every tracked file, tests and docs included, with the private rules
only.

Without the list, as on every pull request (CI passes it only on a push to `main`), the gate runs the generic rules and prints one notice. A release
fails without it (`--require-private`; see [docs/RELEASE.md](docs/RELEASE.md)).

## Releases

[docs/RELEASE.md](docs/RELEASE.md) is the release checklist.
