Developer CLI and Claude Code plugin; runs on the maintainer's machine and in CI on a fresh checkout of reviewed code.
- AR-1 (2026-10-30) [Safety] class=unguarded test fixture read: tests read fixtures from this repo's own committed tree with plain readFileSync, as the existing contract tests do; a committed symlink would arrive through review, and a local checkout is the developer's own
- AR-2 (2026-10-30) [Safety] class=unguarded fixture write: fixture bootstrap writes to a path inside the developer's own checkout, never into a path taken from review input
