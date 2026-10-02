# homebrew-tap

The Homebrew tap for [review-loop](https://github.com/MostViableProduct/review-loop): enforced Codex adversarial review
inside Claude Code.

    brew install MostViableProduct/tap/review-loop
    review-loop setup

Requires Homebrew 6.0.3 or newer: the formula uses `formula_opt_bin`, which older versions lack. If the install
fails to load the formula, run `brew update` and try again.

Installing, upgrading and uninstalling the formula never touch `~/.claude` or `~/.codex`: the formula has no
`post_install`, and its caveats only print text. `review-loop setup`, which you run yourself, makes the
changes, asking before each one.

To remove review-loop completely, in this order:

    review-loop uninstall
    brew uninstall review-loop

## How this tap changes

Every formula change is a pull request opened by review-loop's release workflow, bumping `url` and `sha256`
to the new release tarball (the first one adds the formula: before it, this tap has none, so `brew install`
reports no available formula rather than failing a checksum). The `tests` workflow runs on each one, on `macos-14` (arm64) and `macos-15-intel`:
`brew style`, `brew audit --strict --online`, an upgrade from the released formula (a plain install for the
very first release), `brew test` (which runs `review-loop selftest`), and `brew uninstall`. It snapshots
`~/.claude` and `~/.codex` (file metadata and content hashes) before and after, and fails on any difference.

## License

MIT
