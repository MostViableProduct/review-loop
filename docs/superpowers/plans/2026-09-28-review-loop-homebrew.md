# review-loop Homebrew distribution — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Ship the existing Claude Code ↔ Codex review loop as a Homebrew-installed CLI (`review-loop`)
plus a Claude Code plugin (hooks, engine, skill), with guided setup, presets, Codex model/effort, JSONL
events, PR-head binding, and release automation.

**Architecture:**

- Two repos: `<owner>/review-loop`, which is the product and its own plugin marketplace, and
  `<owner>/homebrew-tap`.
- The engine moves from `~/.claude/review-loop/` into `plugin/engine/` **unchanged first**, then gains
  presets, config, events v1 and PR-head binding.
- A dependency-free Node CLI in `cli/` owns setup, config, doctor, update, uninstall, migrate and
  selftest. It imports the engine code shipped in its own tarball, and never the other way round.

**Tech stack:**

- Node ≥ 22 (ESM `.mjs`), `node:test` and `node:assert/strict`, no npm dependencies;
- a POSIX `sh` hook shim;
- GitHub Actions on macOS;
- a Homebrew formula (Ruby DSL).

**Spec:** `docs/superpowers/specs/2026-09-28-review-loop-homebrew-design.md` (status: overridden by the
author at 9.16, 2026-09-28). **Read it alongside this plan.** Section references like "§6.2" point
into it.

## Global Constraints

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
- **`settings.json`:** we write only the five `permissions.ask` strings (§6.2), plus removal of legacy
  hook objects in `migrate`. Writes follow the §6.2 commit protocol, with the precondition that no
  Claude Code or other writer is active.
- **Per-user state:** files 0600, dirs 0700, via `ensurePrivateDir` / `atomicWriteJson` /
  `readJsonValidated` from `lib/fsutil.mjs`. Reuse these; never re-implement them.
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

## Review Focus

These are the inputs the spec implies but that no spec test names. Each line below is pinned by a test
in its owning task, marked **[RF-n]**.

1. **[RF-1] A `settings.json` with a UTF-8 BOM or CRLF line endings** (a Windows-edited dotfile).
   Expected: parsed correctly; the output is normalized to LF, with no BOM; foreign keys deep-equal.
   Owner: Task 16.
2. **[RF-2] A repo path containing spaces or unicode** in hook input `cwd` and in artifact paths.
   Expected: every gate works, and no event contains the path. Owner: Task 8.
3. **[RF-3] `HOME` itself is a symlink** (common with some macOS setups).
   Expected: the state dir resolves and is accepted, the way today's `ensurePrivateDir(dir, root)`
   stats the root. Setup, doctor and hooks all work. Owner: Task 6.
4. **[RF-4] `claude plugin … --json` printing warnings or extra lines before its JSON result.**
   Expected: the CLI parses the **last** line that parses as a JSON object; otherwise
   `claude_cli_unparseable` with exit 1. Owner: Task 17.
5. **[RF-5] A second `review-loop setup` running concurrently** (two terminals).
   Expected: the second refuses on the CLI lock (`<stateRoot>/locks/<CLI_LOCK_KEY>.lock`, taken with the
   engine's `acquireLock`), with exit 1 `cli_busy`. Neither corrupts config or settings. Owner: Task 15.

---

## File structure (all paths relative to the `review-loop` repo root)

| Path | Responsibility | Task |
|---|---|---|
| `package.json` | `name`, `version`, `type:"module"`, `engines.node >=22`, `scripts` (test, sabotage, docs:check, content-gate, e2e), `bin` | 1 |
| `LICENSE` | MIT, copyright holder from D7 (default: the git `user.name`) | 1 |
| `CLAUDE.md`, `AGENTS.md -> CLAUDE.md` | stack, invariants and probe results (repo-local, generic) | 1 (then every task) |
| `.claude-plugin/marketplace.json` | marketplace `review-loop` → `./plugin` | 11 |
| `plugin/.claude-plugin/plugin.json` | plugin manifest, version, dependency on `codex@openai-codex` | 11 |
| `plugin/hooks/hooks.json` | 9 hook entries (§3.1, T-SHAPE-1) | 11 |
| `plugin/bin/hook` | POSIX sh shim (§6.3) | 11 |
| `plugin/engine/review-round.mjs`, `review-gate-hook.mjs`, `lib/*.mjs` | the engine (moved in Task 1) | 1, 6–14 |
| `plugin/engine/lib/config.mjs` | `configPath`, `isConfig`, `readConfig`, `writeConfig`, `DEFAULT_CONFIG` | 6 |
| `plugin/engine/lib/codes.mjs` | code registry, `EVENT_CATALOG`, `CLI_EXIT` | 7 |
| `plugin/engine/lib/events.mjs` | `emit(event)`, the schema-v1 writer (replaces `appendEvent`'s body) | 7 |
| `plugin/engine/lib/presets.mjs` | `PRESETS`, `gateOutcome` | 8 |
| `plugin/engine/lib/prverify.mjs` | post-create verification (§7.1 (1)) | 12 |
| `plugin/engine/lib/merge.mjs` | merge classifier and gate (§7.1 (3)) | 13 |
| `plugin/engine/lib/status.mjs` | commit-status posting and the policy fingerprint (§7.1 (2)) | 14 |
| `plugin/rubric/default.md` | generic rubric (the Dimension definitions section only) | 9 |
| `plugin/skills/review-loop/SKILL.md` | skill (namespaced `review-loop:review-loop`) | 11 |
| `cli/review-loop.mjs` | entry point and the `COMMANDS` table | 15 |
| `cli/lib/io.mjs` | prompts, TTY/NO_COLOR output, OK/FAIL/WARN words | 15 |
| `cli/lib/run.mjs` | `runTool(cmd,args)` wrapper plus last-JSON-line parsing | 17 |
| `cli/lib/settings.mjs` | §6.2 read-modify-write and commit | 16 |
| `cli/lib/preflight.mjs` | the five preflight items | 17 |
| `cli/lib/setup.mjs`, `livecheck.mjs` | setup steps 1–8 and the live check | 18 |
| `cli/lib/doctor.mjs` | `DOCTOR_CHECKS` | 20 |
| `cli/lib/uninstall.mjs`, `update.mjs` | §6.6 and the update command | 21 |
| `cli/lib/migrate.mjs` | §14 and the rollback | 22 |
| `cli/lib/selftest.mjs` | §10.4 | 23 |
| `cli/fixtures/livecheck-doc.md` | the fixture doc the live check reviews | 18 |
| `test/engine/*.test.mjs` | moved engine tests | 1 |
| `test/cli/*.test.mjs`, `test/contract/*.test.mjs`, `test/fakes/` | new tests and fake executables | 15+ |
| `scripts/content-gate.mjs`, `package.files.json` | §10.2 | 24 |
| `scripts/gen-readme-tables.mjs` | README tables from the registry | 24 |
| `scripts/sabotage.mjs`, `scripts/sabotage-registry.mjs` | applies each sabotage from §11 and asserts red; the registry of breaks | 25 |
| `scripts/probes/*.sh`, `docs/probes/*.md` | P1–P7 | 2–5 |
| `.github/workflows/ci.yml`, `sabotage.yml`, `release.yml` | §10.3 | 25, 26 |
| `scripts/bump-version.mjs`, `scripts/release-check.mjs` | version stamping (4 places) and the tag-equality check | 26 |
| `test/e2e/live.test.mjs` | the opt-in paid live e2e (`npm run e2e`) | 27 |
| `docs/RELEASE.md`, `README.md` | release checklist, user docs | 24, 26 |
| `homebrew-tap/Formula/review-loop.rb`, `homebrew-tap/.github/workflows/tests.yml` | the formula and tap CI, staged here and pushed as its own repo in Task 28; never packaged | 26, 28 |

**Task order and dependencies:**

- Tasks 1–5 come first. **Task 2 (P1) is a hard gate:** if it fails, stop and page the author.
- Tasks 6–14 build the engine: 6 → 7 → 8, then 9–14 in order.
- Tasks 15–23 build the CLI. It depends on the engine (6, 7) and follows the numbered order.
- Tasks 24–26 are release. Task 27 is the pre-release live e2e, in an isolated Claude config.
- Task 28 is publishing, AC-22 and v1.0.0. Task 29 is the author's migration, which spec §14 schedules after v1.0.0 is tagged.

---
## Phase 0: bootstrap and probes

### Task 1: Repo bootstrap and move the engine unchanged

**Files:**
- Create: `package.json`, `LICENSE`, `.gitignore`, `CLAUDE.md`, `AGENTS.md` (symlink)
- Create (copy): `plugin/engine/review-round.mjs`, `plugin/engine/review-gate-hook.mjs`, `plugin/engine/lib/*.mjs` (15 files)
- Create (copy and re-path): `test/engine/*.mjs` (11 files, including `helpers.mjs`)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs `node --test test/`. The engine lives at `plugin/engine/`. Test helpers
  live at `test/engine/helpers.mjs` (`g`, `tmpDir`, `makeRepo`, `commitFile`, `writeFile`,
  `crissCrossRepo`).

**Precondition:** `~/.claude/review-loop/` exists (the legacy engine) and `node --test` passes there.

- [ ] **Step 1: Prove the legacy baseline is green**

  Run: `(set -o pipefail; cd ~/.claude/review-loop && node --test test/ 2>&1 | tail -5)`

  Expected: `# pass 186` and `# fail 0`. If the count differs, record the actual number in
  `CLAUDE.md` and use it as the baseline for Step 5.

- [ ] **Step 2: Copy the engine and tests**

```bash
cd ~/Code/review-loop
mkdir -p plugin/engine/lib test/engine
cp ~/.claude/review-loop/review-round.mjs ~/.claude/review-loop/review-gate-hook.mjs plugin/engine/
cp ~/.claude/review-loop/lib/*.mjs plugin/engine/lib/
cp ~/.claude/review-loop/test/*.mjs test/engine/
# Tests moved one level deeper and away from the engine: re-point imports.
sed -i '' -e 's#"\.\./lib/#"../../plugin/engine/lib/#g' test/engine/*.mjs
sed -i '' -e 's#path\.join(HERE, "\.\.", "review-round\.mjs")#path.join(HERE, "..", "..", "plugin", "engine", "review-round.mjs")#' \
          -e 's#path\.join(HERE, "\.\.", "review-gate-hook\.mjs")#path.join(HERE, "..", "..", "plugin", "engine", "review-gate-hook.mjs")#' test/engine/*.mjs
grep -n '"\.\./lib/\|HERE, "\.\.", "review' test/engine/*.mjs
```

  Expected: the final `grep` prints nothing.

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "review-loop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Enforced Codex adversarial review inside Claude Code",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "bin": { "review-loop": "cli/review-loop.mjs" },
  "scripts": {
    "test": "node --test --test-concurrency=4 'test/**/*.test.mjs'",
    "sabotage": "node scripts/sabotage.mjs",
    "docs:check": "node scripts/gen-readme-tables.mjs --check",
    "content-gate": "node scripts/content-gate.mjs",
    "e2e": "REVIEW_LOOP_E2E=1 node --test test/e2e/live.test.mjs"
  }
}
```

  The `bin` entry is documentation only. Homebrew installs its own shim (Task 26), and the package is
  never published to npm (`private: true`).

- [ ] **Step 4: Write `.gitignore`, `LICENSE`, `CLAUDE.md` and the `AGENTS.md` symlink**

`.gitignore`:
```
node_modules/
dist/
*.tgz
.DS_Store
docs/probes/raw/
```

`LICENSE`: the standard MIT text, with the line `Copyright (c) 2026 <D7 holder>`. D7 defaults to the
output of `git config user.name`.

`CLAUDE.md` must contain at least these sections, filled with the facts stated:
- `## Stack`: Node ≥ 22 ESM, no dependencies, `node:test`; a plugin (`plugin/`) plus a CLI (`cli/`);
  a Homebrew tap in a separate repo.
- `## Layout`: the file-structure table from this plan.
- `## Invariants`: copy the "Global Constraints" list from this plan verbatim.
- `## Probes`: an empty table with columns `Probe | Date | Verdict | Evidence`. Tasks 2–5 fill it.

```bash
cd ~/Code/review-loop && ln -s CLAUDE.md AGENTS.md && ls -l AGENTS.md
```

  Expected: `AGENTS.md -> CLAUDE.md`.

- [ ] **Step 5: Run the moved suite**

  Run: `(set -o pipefail; cd ~/Code/review-loop && npm test 2>&1 | tail -5)`

  Expected: `# pass 186` (or the Step 1 baseline) and `# fail 0`. If a test fails because of a
  hard-coded `~/.claude/review-loop` path, fix only the **test's** path expression, never engine
  behavior, and re-run.

- [ ] **Step 6: Commit**

```bash
cd ~/Code/review-loop
git add -A
git commit -m "chore: bootstrap repo and move review-loop engine unchanged"
```

- [ ] **Step 7b: Add the no-`any` gate**

```js
// test/contract/no-any.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const TAG = /@(?:type|param|returns?|typedef|template|property|prop|satisfies|this|enum|callback)\s*\{/g;

/**
 * Every JSDoc type expression in `src`, with nesting (`{{ a: X }}`) and multi-line blocks handled by brace counting.
 * @param {string} src @returns {Array<{ expr: string, line: number }>}
 */
export function typeExprs(src) {
  const out = [];
  for (const m of src.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const block = m[0];
    for (const t of block.matchAll(TAG)) {
      let depth = 1;
      let i = /** @type {number} */ (t.index) + t[0].length;
      const from = i;
      for (; i < block.length && depth > 0; i++) depth += block[i] === "{" ? 1 : block[i] === "}" ? -1 : 0;
      const line = src.slice(0, /** @type {number} */ (m.index) + from).split("\n").length;
      out.push({ expr: block.slice(from, i - 1), line });
    }
  }
  return out;
}

const W = "an" + "y";  // built, so this file's own fixtures never match the scan below
const hasAny = (/** @type {string} */ src) => typeExprs(src).some((t) => new RegExp(`\\b${W}\\b`).test(t.expr));

test("the scanner catches nested, generic and multi-line forms; ignores prose", () => {
  assert.ok(hasAny(`/** @param {{value: ${W}}} input */`));
  assert.ok(hasAny(`/** @type {Array<${W}>} */`));
  assert.ok(hasAny(`/** @returns {Record<string, ${W}>} */`));
  assert.ok(hasAny(`/**\n * @param {{\n *   deep: { inner: ${W} }\n * }} x\n */`));
  assert.ok(hasAny(`const y = /** @type {${W}} */ (x);`));
  assert.ok(!hasAny(`/** @param {{ many: string }} x ${W}thing, company, "${W}" in prose */`));
  assert.ok(!hasAny(`/** @type {unknown} */`));
});

const files = (/** @type {string} */ d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")).map((f) => path.join(d, f)) : []);

test("no `any` type in any source or test file", () => {
  const hits = [];
  for (const f of ["plugin", "cli", "scripts", "test"].flatMap(files)) {
    for (const t of typeExprs(fs.readFileSync(f, "utf8"))) if (new RegExp(`\\b${W}\\b`).test(t.expr)) hits.push(`${f}:${t.line}`);
  }
  assert.deepEqual(hits, []);
});
```

  **Sabotage:** add a two-line JSDoc block whose second line is ` * @param {{ v: any }} x`, above any
  function under `cli/`. The test goes red and names the file and line. Revert.

**Gate:** `npm test` prints `# fail 0` with the baseline pass count plus the no-`any` test, and
`git ls-files plugin/engine/lib | wc -l` prints `15`.

---

### Task 2: Probe P1 (plugin hook parity: hard gate) and P5 (non-blocking warnings)

**Files:**
- Create: `scripts/probes/p1-p5/plugin/.claude-plugin/plugin.json`, `scripts/probes/p1-p5/plugin/hooks/hooks.json`, `scripts/probes/p1-p5/plugin/hook.sh`, `scripts/probes/p1-p5/.claude-plugin/marketplace.json`, `scripts/probes/p1-p5/run.sh`
- Create: `docs/probes/P1-2026-MM-DD.md`, `docs/probes/P5-2026-MM-DD.md`

**Interfaces:**
- Produces: the verdicts `P1=pass|fail` and `P5=pass|fail` in `CLAUDE.md`'s Probes table. Tasks 8, 11
  and 12 read them.

**Isolation.** Every probe runs Claude Code with `CLAUDE_CONFIG_DIR="$PROBE_HOME/.claude"`, so the
author's real `~/.claude` is untouched. Confirm that the flag exists first:
`claude --help | grep -i config-dir || env | grep -i CLAUDE_CONFIG_DIR`. If `CLAUDE_CONFIG_DIR` is not
honored (the probe's `settings.json` stays empty after an install), **stop and ask the author** before
running anything against the real `~/.claude`.

**Sign-in inside the probe home.** Headless `claude -p` needs auth. `CLAUDE_CONFIG_DIR` isolates
credentials, so the author signs in once inside the probe home with
`CLAUDE_CONFIG_DIR=$PROBE_HOME/.claude claude` then `/login`, **or** exports `ANTHROPIC_API_KEY` for the
probe run. Ask the author which they prefer. Never copy their credentials.

- [ ] **Step 1: Write the throwaway plugin**

`scripts/probes/p1-p5/.claude-plugin/marketplace.json`:
```json
{ "name": "rl-probe", "owner": { "name": "probe" }, "plugins": [ { "name": "rl-probe", "source": "./plugin", "version": "0.0.1" } ] }
```

`scripts/probes/p1-p5/plugin/.claude-plugin/plugin.json`:
```json
{ "name": "rl-probe", "version": "0.0.1", "description": "review-loop probe P1/P5" }
```

`scripts/probes/p1-p5/plugin/hooks/hooks.json`:
```json
{
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hook.sh\" stop", "timeout": 10 } ] } ],
    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hook.sh\" pre", "timeout": 10 } ] } ],
    "PostToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/hook.sh\" post", "timeout": 10 } ] } ]
  }
}
```

`scripts/probes/p1-p5/plugin/hook.sh` (make it executable with `chmod +x`):
```sh
#!/bin/sh
# Probe hook. Records every call under $PROBE_OUT, then answers per mode and $PROBE_CASE.
mode="$1"; input=$(cat); n_file="$PROBE_OUT/$mode.count"
n=$(( $(cat "$n_file" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$n_file"
printf '%s\n' "$input" >> "$PROBE_OUT/$mode.inputs.jsonl"
case "$PROBE_CASE:$mode" in
  block:stop)
    case "$input" in *'"stop_hook_active":true'*) exit 0;; esac
    printf '{"decision":"block","reason":"probe-block: say DONE and stop"}\n';;
  deny:pre)
    case "$input" in *probe-deny*) printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"probe-deny-reason"}}\n';; esac;;
  stop:post)
    case "$input" in *probe-first*) printf '{"continue":false,"stopReason":"probe-stop"}\n';; esac;;
  warn:stop)
    printf '{"systemMessage":"probe-warning-stop"}\n';;
  warn:pre)
    printf '{"systemMessage":"probe-warning-pre"}\n';;
esac
exit 0
```

- [ ] **Step 2: Write `scripts/probes/p1-p5/run.sh`**

```sh
#!/bin/sh
# Runs P1 (block, deny, PostToolUse stop) and P5 (systemMessage) in an isolated CLAUDE_CONFIG_DIR.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PROBE_HOME=${PROBE_HOME:?set PROBE_HOME to an empty dir with a signed-in .claude}
export CLAUDE_CONFIG_DIR="$PROBE_HOME/.claude"
WORK=$(mktemp -d); cd "$WORK"; git init -q
claude plugin marketplace add "$HERE" >/dev/null
claude plugin install rl-probe@rl-probe --scope user >/dev/null
run_case() { # $1 case, $2 prompt
  out="$WORK/out-$1"; mkdir -p "$out"
  PROBE_OUT="$out" PROBE_CASE="$1" claude -p "$2" --output-format stream-json --verbose \
    --allowedTools "Bash" > "$out/stream.jsonl" 2> "$out/stderr.txt" || true
  echo "$out"
}
B=$(run_case block "Reply with the word HELLO and nothing else.")
D=$(run_case deny "Run this exact bash command: touch $WORK/sentinel-deny # probe-deny")
S=$(run_case stop "Run the bash command 'echo probe-first', then run the bash command 'touch $WORK/sentinel-after-stop'.")
W=$(run_case warn "Run the bash command 'echo hi', then reply OK.")
echo "P1.stop.count=$(cat "$B/stop.count")  (expect 2)"
echo "P1.stop.second_active=$(sed -n 2p "$B/stop.inputs.jsonl" | grep -c '"stop_hook_active":true')  (expect 1)"
echo "P1.deny.sentinel_exists=$([ -e "$WORK/sentinel-deny" ] && echo yes || echo no)  (expect no)"
echo "P1.deny.reason_seen=$(grep -c probe-deny-reason "$D/stream.jsonl")  (expect >=1)"
echo "P1.post.stop_seen=$(grep -c probe-stop "$S/stream.jsonl")  (expect >=1)"
echo "P1.post.sentinel_after_stop=$([ -e "$WORK/sentinel-after-stop" ] && echo yes || echo no)  (expect no)"
echo "P5.warning_stop_seen=$(grep -c probe-warning-stop "$W/stream.jsonl")  (expect >=1)"
echo "P5.warning_pre_seen=$(grep -c probe-warning-pre "$W/stream.jsonl")  (expect >=1)"
echo "P5.tool_ran=$(grep -c '"hi' "$W/stream.jsonl")  (expect >=1)"
echo "WORK=$WORK"
```

- [ ] **Step 3: Run it**

  Run: `chmod +x scripts/probes/p1-p5/run.sh scripts/probes/p1-p5/plugin/hook.sh && PROBE_HOME=<dir> scripts/probes/p1-p5/run.sh`

  Expected: every line's value matches its `(expect …)`.

- [ ] **Step 4: Record the evidence**

  Write `docs/probes/P1-<date>.md` and `docs/probes/P5-<date>.md`. Each contains the command, the
  `claude --version` output, the printed lines, and the verdict. Copy raw stream files to
  `docs/probes/raw/`, which is gitignored. Add a row to the `CLAUDE.md` Probes table.

- [ ] **Step 5: Apply the gate**

  - **Any P1 line fails:** STOP the plan. Page the author (PushNotification plus AskUserQuestion) with
    the options "A: CLI writes absolute-path hooks into settings.json", "C: hybrid", "Stop". Do not
    continue to Task 3 without an answer.
  - **A P5 line fails:** continue. Record `P5=fail`; Task 8 then uses the P5 fallback, which delivers
    warnings via `UserPromptSubmit` `additionalContext`.

- [ ] **Step 6: Commit**

```bash
git add scripts/probes/p1-p5 docs/probes/P1-*.md docs/probes/P5-*.md CLAUDE.md
git commit -m "test(probe): P1 plugin hook parity and P5 warnings"
```

**Gate:** `grep -E '^\| P1 .*\| pass' CLAUDE.md` matches. If it doesn't, the plan is stopped at
Step 5.

---

### Task 3: Probe P2 (per-review Codex effort without writing `~/.codex`)

**Files:**
- Create: `scripts/probes/p2-effort.mjs`, `docs/probes/P2-<date>.md`

**Interfaces:**
- Produces: `CLAUDE.md` Probes row `P2`, with a verdict and the **mechanism**: `flag:<name>`,
  `config-override`, `env:<NAME>` or `none`. It also records the **allowed effort values**, which
  resolve D4. Task 10 reads both.

- [ ] **Step 1: Read the companion's argument and spawn code**

  Run: `grep -n "effort\|reasoning\|\"-c\"\|config" ~/.claude/plugins/cache/openai-codex/codex/*/scripts/lib/codex.mjs ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | head -60`

  Record, in the probe doc, how `task --effort` reaches Codex: a turn parameter, a `-c` override, or
  an env var. Record whether `adversarial-review` shares that path.

- [ ] **Step 2: Write `scripts/probes/p2-effort.mjs`**

```js
// P2: does a per-review effort reach Codex without touching $CODEX_HOME/config.toml?
// Usage: node scripts/probes/p2-effort.mjs <mechanism> <effort>   mechanism: flag | env | none
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [mechanism, effort = "low"] = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const cfg = path.join(codexHome, "config.toml");
const hash = () => crypto.createHash("sha256").update(fs.readFileSync(cfg)).digest("hex");
const before = hash();
const base = path.join(os.homedir(), ".claude/plugins/cache/openai-codex/codex");
const version = fs.readdirSync(base).sort().at(-1);
const companion = path.join(base, version, "scripts", "codex-companion.mjs");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p2-"));
spawnSync("git", ["init", "-q"], { cwd: repo });
fs.writeFileSync(path.join(repo, "a.md"), "# probe\n");
const args = [companion, "adversarial-review", "--wait", "--json", "--scope", "working-tree"];
const env = { ...process.env };
if (mechanism === "flag") args.push("--effort", effort);
if (mechanism === "env") env.CODEX_REASONING_EFFORT = effort;
args.push("Review a.md briefly.");
const started = Date.now();
const r = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout: 15 * 60_000 });
const sessions = path.join(codexHome, "sessions");
const newest = spawnSync("sh", ["-c", `find "${sessions}" -name '*.jsonl' -newermt "@${Math.floor(started / 1000)}" | tail -1`], { encoding: "utf8" }).stdout.trim();
const log = newest ? fs.readFileSync(newest, "utf8") : "";
console.log(JSON.stringify({
  mechanism, effort, exit: r.status,
  configUnchanged: hash() === before,
  effortInLog: new RegExp(`"(effort|reasoning_effort|model_reasoning_effort)"\\s*:\\s*"${effort}"`).test(log),
  sessionLog: newest ? path.basename(newest) : null
}));
```

  If Step 1 found a different mechanism, for example a `-c model_reasoning_effort=…` override that the
  companion forwards through an env var, add it as a third `mechanism` branch before running.

- [ ] **Step 3: Run each mechanism**

  Run: `node scripts/probes/p2-effort.mjs flag low; node scripts/probes/p2-effort.mjs env low`

  Expected for a **pass**: one line with `"configUnchanged":true` and `"effortInLog":true`.

- [ ] **Step 4: Record the verdict and the allowed values**

  Get the allowed effort values from `codex --help` and the Codex config docs referenced in its help.
  Record them as `P2.efforts=minimal|low|medium|high|xhigh`, or whatever the actual set is.

  - **No mechanism passes:** record `P2=fail mechanism=none`. Page the author, with the options
    "Effort display-only (amend AC-6)" and "Stop". Task 10 implements whichever they choose.
  - **A mechanism passes:** record it, e.g. `P2=pass mechanism=flag:--effort`.

- [ ] **Step 5: Commit**

```bash
git add scripts/probes/p2-effort.mjs docs/probes/P2-*.md CLAUDE.md
git commit -m "test(probe): P2 per-review Codex effort"
```

**Gate:** the `CLAUDE.md` row `P2` exists with `mechanism=` set, plus `P2.efforts=`.

---

### Task 4: Probes P3 (skill substitution) and P4 (dependency auto-install)

**Files:**
- Create: `scripts/probes/p3-p4/…` (the same layout as Task 2, with a skill and a dependency), `docs/probes/P3-*.md`, `docs/probes/P4-*.md`

**Interfaces:**
- Produces: `P3=pass|fail` and `P4=pass|fail` in `CLAUDE.md`.
  - P3 fail means Task 11's SKILL.md uses `$(review-loop engine-path)`.
  - P4 fail means Task 18's preflight always offers the explicit Codex plugin install (that path
    exists regardless).

- [ ] **Step 1: Write the probe plugin**

`scripts/probes/p3-p4/plugin/.claude-plugin/plugin.json`:
```json
{ "name": "rl-probe2", "version": "0.0.1", "description": "probe P3/P4",
  "dependencies": [ { "name": "codex", "marketplace": "openai-codex" } ] }
```

  **Before running,** confirm the exact dependency schema. Run
  `claude plugin validate --strict scripts/probes/p3-p4/plugin`. If it reports an unrecognized
  field, adjust to the shape its error names, and record the accepted shape in the P4 doc.

`scripts/probes/p3-p4/plugin/skills/probe/SKILL.md`:
```markdown
---
name: probe
description: Use when the user says "run probe three".
---
Run this bash command exactly and report its output: `echo ROOT=${CLAUDE_PLUGIN_ROOT}`
```

`scripts/probes/p3-p4/.claude-plugin/marketplace.json`:
```json
{ "name": "rl-probe2", "owner": { "name": "probe" }, "plugins": [ { "name": "rl-probe2", "source": "./plugin", "version": "0.0.1" } ] }
```

- [ ] **Step 2: Run in a fresh isolated home**

```sh
export CLAUDE_CONFIG_DIR="$PROBE_HOME2/.claude"   # a NEW empty dir, signed in as in Task 2
claude plugin marketplace add "$PWD/scripts/probes/p3-p4"
claude plugin install rl-probe2@rl-probe2 --scope user
claude plugin list --json > /tmp/p4-list.json
node -e 'const l=JSON.parse(require("fs").readFileSync("/tmp/p4-list.json"));const a=Array.isArray(l)?l:(l.plugins||[]);console.log("P4.codex_installed="+a.some(p=>String(p.id||p.name).startsWith("codex")))'
claude -p "run probe three" --output-format stream-json --verbose --allowedTools Bash > /tmp/p3.jsonl
grep -o 'ROOT=/[^"\\ ]*' /tmp/p3.jsonl | head -1
```

  Expected for a pass:
  - `P4.codex_installed=true`;
  - a `ROOT=/…/rl-probe2/…` absolute path. A literal `ROOT=${CLAUDE_PLUGIN_ROOT}` or `ROOT=` means P3
    **fails**.

- [ ] **Step 3: Record and commit**

```bash
git add scripts/probes/p3-p4 docs/probes/P3-*.md docs/probes/P4-*.md CLAUDE.md
git commit -m "test(probe): P3 skill root substitution and P4 dependency install"
```

**Gate:** `CLAUDE.md` has `P3` and `P4` rows with verdicts.

---

### Task 5: Probes P6 (running-session detection) and P7 (GitHub merge binding)

**Files:**
- Create: `scripts/probes/p6-sessions.sh`, `scripts/probes/p7-merge.mjs`, `docs/probes/P6-*.md`, `docs/probes/P7-*.md`, `test/fixtures/mcp-merge-schema.json`

**Interfaces:**
- Produces:
  - `P6=pass|fail` with the detection command, which Task 16 uses;
  - `P7a` (`--match-head-commit` enforced), `P7-auto` (binding for `--auto`) and `P7b`
    (base-scoped required check blocks a retarget);
  - `test/fixtures/mcp-merge-schema.json`, the MCP merge tool's input schema, or `{"absent":true}`.

**Outward-facing actions need the author's confirmation.** P7 creates a **private** throwaway GitHub
repo under the author's account, pushes to it, sets branch protection, and deletes it at the end.
Before Step 3, ask: "P7 will create the private repo `<user>/review-loop-probe-<date>`, set branch
protection on it, and delete it afterwards (deletion needs the `delete_repo` scope; otherwise you
delete it manually). OK?" Proceed only on yes.

- [ ] **Step 1: Write and run `scripts/probes/p6-sessions.sh`**

```sh
#!/bin/sh
# P6: does `pgrep -x claude` list running Claude Code sessions?
echo "pgrep -x claude: $(pgrep -x claude | wc -l | tr -d ' ')"
echo "pgrep -f claude-code: $(pgrep -f 'claude' | wc -l | tr -d ' ')"
ps -Ao pid,comm | awk '$2 ~ /claude|[0-9]+\.[0-9]+\.[0-9]+/' | head
```

  Run it once with **no** Claude Code session open (from Terminal.app, with every session quit), and
  once with one CLI session plus one VS Code session open.

  Expected for a pass: the `pgrep -x claude` count equals the number of sessions (0, then 2). Record
  the command that worked as `P6.cmd=`.

- [ ] **Step 2: Record the MCP merge schema**

  If a GitHub MCP server is connected in the author's Claude Code, find its merge tool with
  ToolSearch (`merge pull request`). Save its `parameters` JSON to `test/fixtures/mcp-merge-schema.json`.
  Note whether it has a head-binding field (for example `expectedHeadSha`) and that field's name.

  If no server is connected, write
  `{"absent":true,"documented":"github/github-mcp-server merge_pull_request","headField":"expectedHeadSha"}`,
  and mark `P7-mcp=unverified` in `CLAUDE.md`.

- [ ] **Step 3: Write and run `scripts/probes/p7-merge.mjs`** (only after the author says yes)

```js
// P7: GitHub enforces --match-head-commit (P7a); and base-scoped required statuses block a retarget (P7b).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const G = "g" + "h";
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryRun = (cmd, args, cwd) => { try { return { ok: true, out: sh(cmd, args, cwd) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message).slice(0, 300) }; } };
const user = sh(G, ["api", "user", "--jq", ".login"]);
const name = `review-loop-probe-${Date.now()}`;
const slug = `${user}/${name}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p7-"));
sh(G, ["repo", "create", slug, "--private", "--add-readme"]);
sh("git", ["clone", "-q", `https://github.com/${slug}.git`, dir]);
const commit = (f, msg) => { fs.writeFileSync(path.join(dir, f), msg); sh("git", ["add", f], dir); sh("git", ["commit", "-qm", msg], dir); return sh("git", ["rev-parse", "HEAD"], dir); };
sh("git", ["checkout", "-qb", "release"], dir); sh("git", ["push", "-q", "-u", "origin", "release"], dir);
sh("git", ["checkout", "-q", "main"], dir);
sh("git", ["checkout", "-qb", "feat"], dir);
const A = commit("a.txt", "A"); sh("git", ["push", "-q", "-u", "origin", "feat"], dir);
const create = [G, "pr", "create"].slice(1);
const prUrl = sh(G, [...create, "--repo", slug, "--base", "main", "--head", "feat", "--title", "probe", "--body", "probe"], dir);
const n = prUrl.split("/").pop();
const B = commit("b.txt", "B"); sh("git", ["push", "-q"], dir);
const p7a = tryRun(G, ["pr", "merge", n, "--repo", slug, "--merge", "--match-head-commit", A], dir);
const stateA = sh(G, ["pr", "view", n, "--repo", slug, "--json", "state", "--jq", ".state"], dir);
// P7b: require review-loop/<base> on both bases, post only review-loop/main on B, then retarget to release.
for (const base of ["main", "release"]) {
  const body = { required_status_checks: { strict: false, contexts: [`review-loop/${base}`] }, enforce_admins: true, required_pull_request_reviews: null, restrictions: null };
  const f = path.join(dir, `prot-${base}.json`);
  fs.writeFileSync(f, JSON.stringify(body));
  sh(G, ["api", "-X", "PUT", `repos/${slug}/branches/${base}/protection`, "--input", f], dir);
}
sh(G, ["api", "-X", "POST", `repos/${slug}/statuses/${B}`, "-f", "state=success", "-f", "context=review-loop/main"], dir);
const mergeState = () => sh(G, ["pr", "view", n, "--repo", slug, "--json", "mergeStateStatus", "--jq", ".mergeStateStatus"], dir);
const before = mergeState();
sh(G, ["pr", "edit", n, "--repo", slug, "--base", "release"], dir);
let after = "";
for (let i = 0; i < 10; i++) {
  after = mergeState();
  if (after !== "UNKNOWN") break;
  await new Promise((r) => setTimeout(r, 3000));
}
const del = tryRun(G, ["repo", "delete", slug, "--yes"], dir);
console.log(JSON.stringify({
  slug, pr: n,
  p7a_rejected: !p7a.ok, p7a_state_after: stateA,
  p7b_before_retarget: before, p7b_after_retarget: after,
  deleted: del.ok, deleteNote: del.ok ? "" : `delete manually: ${slug}`
}));
```

  Branch protection on private repos needs a paid plan. If the protection `PUT` fails with 403/404
  "Upgrade to GitHub Pro", re-run P7b with `--public` instead of `--private`, **after asking the author
  again**, since a public throwaway repo holds only the letters A and B.

  Expected for a pass:
  - `p7a_rejected: true` and `p7a_state_after: "OPEN"`;
  - `p7b_before_retarget: "CLEAN"` (or `"UNSTABLE"`), then `p7b_after_retarget: "BLOCKED"`.

- [ ] **Step 4: Record the verdicts and apply the gates**

  - **P7a fails:** record it. Task 13 adds the fallback (re-check `headRefOid` immediately before
    allowing), and the AC-23 residual wording goes into the README (Task 24).
  - **P7b fails:** **page the author.** AC-23 (2)'s server-side claim does not hold, so the options
    are "Narrow AC-23 (2) to advisory marks" and "Stop".
  - **P7-auto:** repeat P7a with `--auto`, and record whether the merge was bound. Task 13 reads this.
  - Record `P6.cmd`, `P7a`, `P7b`, `P7-auto` and `P7-mcp` in `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add scripts/probes/p6-sessions.sh scripts/probes/p7-merge.mjs docs/probes/P6-*.md docs/probes/P7-*.md test/fixtures/mcp-merge-schema.json CLAUDE.md
git commit -m "test(probe): P6 session detection and P7 GitHub merge binding"
```

**Gate:** `CLAUDE.md` has rows `P6`, `P7a`, `P7b`, `P7-auto` and `P7-mcp`, and
`test/fixtures/mcp-merge-schema.json` parses as JSON.

---
## Phase 1: engine inside the plugin

### Task 6: Config module (`configPath`, `readConfig`, `writeConfig`)

**Files:**
- Create: `plugin/engine/lib/config.mjs`
- Test: `test/engine/config.test.mjs`

**Interfaces:**
- Consumes: `safeReadFile`, `atomicWriteJson`, `isObject` from `lib/fsutil.mjs`; `ReviewLoopError` from `lib/errors.mjs`.
- Produces:
  - `configPath(): string`;
  - `defaultConfig(): Config`;
  - `isConfig(v: unknown): v is Config`;
  - `readConfig(): {status:"ok"|"absent", config: Config} | {status:"invalid", config: Config, code: "config_invalid"|"config_symlink_rejected"}`;
  - `writeConfig(c: Config): void`;
  - the constants `PRESET_NAMES`, `MODEL_RE`, `EFFORTS` and `CONFIG_MAX_BYTES`;
  - the typedef `Config = {version:1, preset:"default"|"balanced"|"advisory", codex:{model:string|null, effort:string|null}, rubricPath:string|null, events:{path:string|null}}`.

**Invariants (spec §5.1):**
- `configPath()` is the **only** place the path is built.
- `readConfig` **never** writes, renames or quarantines. Hooks call it.
- `writeConfig` tightens only the `review-loop` directory itself, never `~/.config`.

- [ ] **Step 1: Write the failing tests**

```js
// test/engine/config.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { configPath, readConfig, writeConfig, defaultConfig, isConfig } from "../../plugin/engine/lib/config.mjs";

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("configPath: REVIEW_LOOP_CONFIG > absolute XDG_CONFIG_HOME > ~/.config (T-CFG-8)", () => {
  const home = tmpDir();
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    assert.equal(configPath(), path.join(home, ".config", "review-loop", "config.json"));
  });
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: path.join(home, "xdg") }, () => {
    assert.equal(configPath(), path.join(home, "xdg", "review-loop", "config.json"));
  });
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: "relative/xdg" }, () => {
    assert.equal(configPath(), path.join(home, ".config", "review-loop", "config.json"), "a relative XDG is ignored");
  });
  withEnv({ REVIEW_LOOP_CONFIG: "/tmp/x.json" }, () => assert.equal(configPath(), "/tmp/x.json"));
});

test("readConfig: absent → default, no file created", () => {
  const home = tmpDir();
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    const r = readConfig();
    assert.equal(r.status, "absent");
    assert.deepEqual(r.config, defaultConfig());
    assert.equal(fs.existsSync(path.join(home, ".config")), false);
  });
});

test("readConfig: corrupt, symlinked, oversized → invalid + Default, file untouched (T-CFG-3)", () => {
  const home = tmpDir();
  const file = path.join(home, "cfg", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withEnv({ REVIEW_LOOP_CONFIG: file }, () => {
    fs.writeFileSync(file, "{not json");
    let r = readConfig();
    assert.deepEqual([r.status, r.code, r.config.preset], ["invalid", "config_invalid", "default"]);
    assert.equal(fs.readFileSync(file, "utf8"), "{not json", "never quarantined by a reader");
    fs.writeFileSync(file, JSON.stringify({ ...defaultConfig(), preset: "yolo" }));
    assert.equal(readConfig().code, "config_invalid");
    fs.writeFileSync(file, "x".repeat(70 * 1024));
    assert.equal(readConfig().code, "config_invalid");
    fs.rmSync(file);
    const real = path.join(home, "real.json");
    fs.writeFileSync(real, JSON.stringify(defaultConfig()));
    fs.symlinkSync(real, file);
    assert.equal(readConfig().code, "config_symlink_rejected");
  });
});

test("writeConfig: 0600 file, 0700 dir, never chmods the parent (~/.config)", () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, ".config"), { mode: 0o755 });
  fs.chmodSync(path.join(home, ".config"), 0o755);
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    writeConfig({ ...defaultConfig(), preset: "balanced" });
    const f = configPath();
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, ".config")).mode & 0o777, 0o755);
    assert.equal(readConfig().config.preset, "balanced");
  });
});

test("isConfig: validates by value (T-CFG-5)", () => {
  const ok = defaultConfig();
  assert.equal(isConfig(ok), true);
  assert.equal(isConfig({ ...ok, codex: { model: "gpt 5", effort: null } }), false);
  assert.equal(isConfig({ ...ok, codex: { model: null, effort: "turbo" } }), false);
  assert.equal(isConfig({ ...ok, rubricPath: "rel/path.md" }), false);
  assert.equal(isConfig({ ...ok, events: { path: "rel.jsonl" } }), false);
  assert.equal(isConfig({ ...ok, codex: { model: "gpt-6-luna", effort: "high" } }), true);
});

test("[RF-3] HOME reached through a symlink still works", () => {
  const real = tmpDir();
  const link = path.join(tmpDir(), "home-link");
  fs.symlinkSync(real, link);
  withEnv({ HOME: link, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    writeConfig({ ...defaultConfig(), preset: "advisory" });
    assert.equal(readConfig().config.preset, "advisory");
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --test test/engine/config.test.mjs`

  Expected: FAIL with `Cannot find module …/plugin/engine/lib/config.mjs`.

- [ ] **Step 3: Implement `plugin/engine/lib/config.mjs`**

```js
import os from "node:os";
import path from "node:path";
import { ReviewLoopError } from "./errors.mjs";
import { atomicWriteJson, isObject, safeReadFile } from "./fsutil.mjs";

export const PRESET_NAMES = Object.freeze(["default", "balanced", "advisory"]);
export const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
/** Replace with the exact set Probe P2 recorded in CLAUDE.md ("P2.efforts=") before this task is committed. */
export const EFFORTS = Object.freeze(["minimal", "low", "medium", "high", "xhigh"]);
export const CONFIG_MAX_BYTES = 64 * 1024;

/**
 * @typedef {{ version: 1, preset: "default" | "balanced" | "advisory", codex: { model: string | null, effort: string | null },
 *   rubricPath: string | null, events: { path: string | null } }} Config
 */

/** @returns {Config} */
export function defaultConfig() {
  return { version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } };
}

export function configPath() {
  const override = process.env.REVIEW_LOOP_CONFIG;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "review-loop", "config.json");
}

/** @param {unknown} v @param {(x: unknown) => boolean} ok */
const nullOr = (v, ok) => v === null || ok(v);
/** @param {unknown} p */
const absPath = (p) => typeof p === "string" && path.isAbsolute(p);

/** @param {unknown} v @returns {v is Config} */
export function isConfig(v) {
  if (!isObject(v) || v.version !== 1 || typeof v.preset !== "string" || !PRESET_NAMES.includes(v.preset)) return false;
  if (!isObject(v.codex) || !isObject(v.events)) return false;
  return (
    nullOr(v.codex.model, (m) => typeof m === "string" && MODEL_RE.test(m)) &&
    nullOr(v.codex.effort, (e) => typeof e === "string" && EFFORTS.includes(e)) &&
    nullOr(v.rubricPath, absPath) &&
    nullOr(v.events.path, absPath)
  );
}

/**
 * Read on every hook invocation, so it never mutates the file: quarantine belongs to `config repair` and setup.
 * @returns {{ status: "ok" | "absent", config: Config } | { status: "invalid", config: Config, code: "config_invalid" | "config_symlink_rejected" }}
 */
export function readConfig() {
  let raw;
  try {
    raw = safeReadFile(configPath(), CONFIG_MAX_BYTES, { missing: "config_missing", symlink: "config_symlink_rejected", tooLarge: "config_invalid", notFile: "config_invalid" });
  } catch (err) {
    const code = err instanceof ReviewLoopError ? err.code : "config_invalid";
    if (code === "config_missing") return { status: "absent", config: defaultConfig() };
    return { status: "invalid", config: defaultConfig(), code: code === "config_symlink_rejected" ? code : "config_invalid" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: "invalid", config: defaultConfig(), code: "config_invalid" };
  }
  return isConfig(parsed) ? { status: "ok", config: parsed } : { status: "invalid", config: defaultConfig(), code: "config_invalid" };
}

/** @param {Config} config */
export function writeConfig(config) {
  if (!isConfig(config)) throw new ReviewLoopError("config_invalid", "refusing to write an invalid config");
  const file = configPath();
  // `within` is the review-loop dir itself: ensurePrivateDir chmods every dir from `within` down, and ~/.config is not ours.
  atomicWriteJson(file, config, path.dirname(file));
}
```

  **Before committing, set `EFFORTS`** to the exact list in `CLAUDE.md` `P2.efforts=`. If P2 recorded
  `mechanism=none` and the author chose "display-only", keep the list: it still validates what
  `config set effort` stores for display.

- [ ] **Step 4: Run the tests and see them pass**

  Run: `(set -o pipefail; node --test test/engine/config.test.mjs && npm test 2>&1 | tail -3)`

  Expected: all config tests pass, and `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add plugin/engine/lib/config.mjs test/engine/config.test.mjs
git commit -m "feat(engine): user config with a single path resolver"
```

**Gate:** `grep -rn '"\.config"\|XDG_CONFIG_HOME' plugin cli | grep -v 'lib/config.mjs'` prints
nothing. This is T-CFG-8's grep half, and Task 7 adds it as a test.

---

### Task 7: Code registry and schema-v1 events (`codes.mjs`, `events.mjs`, `paths.mjs`)

**Files:**
- Create: `plugin/engine/lib/paths.mjs`, `plugin/engine/lib/codes.mjs`, `plugin/engine/lib/events.mjs`, `scripts/list-codes.mjs`
- Modify: `plugin/engine/lib/state.mjs`: move `stateRoot` and `stateSubdir` into `paths.mjs` and re-export them; delete `appendEvent`
- Modify: every `appendEvent` call site (13 sites in `lib/detect.mjs`, `lib/prgate.mjs`, `lib/state.mjs`, `review-gate-hook.mjs` and `review-round.mjs`)
- Test: `test/contract/events.test.mjs`, `test/contract/codes.test.mjs`

**Interfaces:**
- Consumes: `readConfig` (Task 6).
- Produces:
  - `buildEvent(e: EventInput): EventLine`, the validated, bounded line object (pure);
  - `writeEvent(line: EventLine): boolean`, which appends exactly that object; `false` on failure, never
    throws;
  - `emitEvent(e: EventInput): boolean`, which is `writeEvent(buildEvent(e))`;
  - `EventInput = { source: "cli"|"hook"|"round", event: string, code: string, detail?: string|null, exit_code?: number|null, session_id?: string|null, artifact_key?: string|null, data?: Record<string, unknown> }`;
  - `eventsPath(): string`;
  - from `codes.mjs`: `CODES`, `EVENT_CATALOG`, `CLI_EXIT`, `categoryOf(code): Category`, `exitFor(code): number`, `remedyFor(code): string`;
  - `PACKAGE_VERSION`, read from `plugin/.claude-plugin/plugin.json` at load, or `"0.0.0-dev"` before Task 11 exists.

**Invariants (spec §8):**
- A line is written **only** after every field is validated by value.
- An unknown `event` becomes `event_unregistered`; an unknown `code` becomes `unregistered_code`; an
  unknown `detail` or data value becomes `null`.
- Emitting never throws and never changes a caller's decision.
- At most one stderr warning per process.

**Deviation from the spec, recorded here and in `CLAUDE.md`:** the engine already uses `pr_head_mismatch`
(for the push path). §7.1's post-create mismatch therefore uses the new code
**`pr_created_head_unreviewed`**, so that one code never means two things. Tasks 12–13 use it.

- [ ] **Step 1: Generate the code inventory mechanically**

  Write `scripts/list-codes.mjs`. It prints every code literal in `plugin/` and `cli/`, one per line,
  sorted and unique. T-OBS-3 uses the same extractor.

```js
// Every code literal the source can emit, extracted from the syntactic positions codes appear in.
import fs from "node:fs";
import path from "node:path";

const PATTERNS = [
  /\b(?:ReviewLoopError|CliError)\(\s*"([a-z][a-z0-9_]*)"/g,
  /\b(?:missing|symlink|linkedParent|tooLarge|notFile|notFound|failed|failCode)\s*:\s*"([a-z][a-z0-9_]*)"/g,
  /\bcode\s*:\s*"([a-z][a-z0-9_]*)"/g,
  /\b(?:deny|fail|stop|warnOnly)\(\s*"([a-z][a-z0-9_]*)"/g
];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.name.endsWith(".mjs") ? [p] : [];
  });
}

export function listCodes(root = process.cwd()) {
  const found = new Set();
  for (const f of [...walk(path.join(root, "plugin")), ...walk(path.join(root, "cli"))]) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of PATTERNS) for (const m of text.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(listCodes().join("\n"));
```

  Run: `node scripts/list-codes.mjs | wc -l`

  Expected: 60 or more lines, the 43 `ReviewLoopError` codes plus code-object literals. Save the output
  with `node scripts/list-codes.mjs > /tmp/codes.txt`.

- [ ] **Step 2: Write the failing contract tests**

```js
// test/contract/codes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { listCodes } from "../../scripts/list-codes.mjs";
import { CODES, CLI_EXIT, exitFor, categoryOf } from "../../plugin/engine/lib/codes.mjs";

test("T-OBS-3: every code literal in plugin/ and cli/ is registered", () => {
  const missing = listCodes().filter((c) => !(c in CODES));
  assert.deepEqual(missing, [], `register these in plugin/engine/lib/codes.mjs: ${missing.join(", ")}`);
});

test("every registered code has a category, an exit code and a remedy line", () => {
  for (const [code, meta] of Object.entries(CODES)) {
    assert.ok(Object.hasOwn(CLI_EXIT, meta.category), `${code}: bad category`);
    assert.equal(exitFor(code), CLI_EXIT[meta.category]);
    assert.equal(typeof meta.remedy, "string", code);
    if (meta.category !== "ok") assert.ok(meta.remedy.length > 0, `${code}: remedy required`);
  }
  assert.equal(categoryOf("definitely_not_a_code"), "internal");
});
```

```js
// test/contract/events.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { emitEvent, eventsPath, validateLine, maxLineBytes } from "../../plugin/engine/lib/events.mjs";
import { EVENT_CATALOG } from "../../plugin/engine/lib/codes.mjs";

function env() {
  const home = tmpDir();
  process.env.HOME = home;
  process.env.REVIEW_LOOP_STATE_DIR = path.join(home, "state");
  process.env.REVIEW_LOOP_CONFIG = path.join(home, "cfg.json");
  return home;
}
const lines = () => fs.readFileSync(eventsPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("T-OBS-1: a written line is schema v1", () => {
  env();
  assert.equal(emitEvent({ source: "hook", event: "gate.decision", code: "reviewed", session_id: "abc-123", data: { gate: "stop", outcome: "allowed", preset: "default", pending_count: 0 } }), true);
  const [l] = lines();
  assert.equal(l.schema, "review-loop.event/1");
  assert.match(l.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.match(l.run_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(validateLine(l), []);
  assert.equal(fs.statSync(eventsPath()).mode & 0o777, 0o600);
});

test("T-OBS-4: validated by value", () => {
  env();
  emitEvent({ source: "hook", event: "gate.decision", code: "'; rm -rf", detail: "nope", data: { gate: "stop", outcome: "exploded", preset: "default", pending_count: -1 } });
  emitEvent({ source: "hook", event: "made.up", code: "reviewed" });
  const [a, b] = lines();
  assert.equal(a.code, "unregistered_code");
  assert.equal(a.detail, null);
  assert.equal(a.data.outcome, null);
  assert.equal(a.data.pending_count, null);
  assert.equal(b.event, "event_unregistered");
  for (const l of lines()) assert.deepEqual(validateLine(l), []);
});

test("T-OBS-6: every catalog entry's largest line is ≤ 4 KiB; oversized values fall back", () => {
  for (const name of Object.keys(EVENT_CATALOG)) assert.ok(maxLineBytes(name) <= 4096, `${name}: ${maxLineBytes(name)} bytes`);
  env();
  emitEvent({ source: "hook", event: "gate.decision", code: "reviewed", session_id: "x".repeat(10_000), data: { gate: "stop", outcome: "allowed", preset: "default", pending_count: 0 } });
  const raw = fs.readFileSync(eventsPath(), "utf8");
  assert.ok(Buffer.byteLength(raw) <= 4096);
  assert.equal(JSON.parse(raw).session_id, null);
});

test("T-OBS-6: rotation at 5 MiB keeps ≤ 2 files", () => {
  env();
  fs.mkdirSync(path.dirname(eventsPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(eventsPath(), "x".repeat(5 * 1024 * 1024 + 1), { mode: 0o600 });
  emitEvent({ source: "cli", event: "cli.exit", code: "ok", exit_code: 0, data: { command: "doctor", duration_ms: 1 } });
  const names = fs.readdirSync(path.dirname(eventsPath())).filter((n) => n.startsWith("events.jsonl"));
  assert.deepEqual(names.sort(), ["events.jsonl", "events.jsonl.1"]);
});

test("§8.4: a symlinked events.path is rejected; its target is untouched; the default log is used", () => {
  const home = env();
  const target = path.join(home, "victim.txt");
  fs.writeFileSync(target, "keep");
  const link = path.join(home, "events-link.jsonl");
  fs.symlinkSync(target, link);
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: link } }));
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try { assert.equal(emitEvent({ source: "cli", event: "cli.exit", code: "ok", exit_code: 0, data: { command: "doctor", duration_ms: 1 } }), true); }
  finally { process.stderr.write = orig; }
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  assert.equal(eventsPath(), path.join(home, "state", "events.jsonl"));
  assert.equal(lines().length, 1);
  assert.ok(writes.some((w) => /events\.path rejected/.test(w)) && writes.every((w) => !w.includes(home)), "one warning, no path");
});

test("§8.4: a custom events.path in the user's own directory keeps that directory's mode", () => {
  const home = env();
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { mode: 0o755 });
  fs.chmodSync(logs, 0o755);
  const f = path.join(logs, "rl.jsonl");
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: f } }));
  assert.equal(emitEvent({ source: "cli", event: "cli.exit", code: "ok", exit_code: 0, data: { command: "doctor", duration_ms: 1 } }), true);
  assert.equal(fs.statSync(logs).mode & 0o777, 0o755, "not chmodded");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8").trim()).event, "cli.exit");
});

test("T-OBS-7: a write failure returns false, warns once, never throws", () => {
  env();
  fs.mkdirSync(eventsPath(), { recursive: true });
  const writes = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { writes.push(String(s)); return true; };
  try {
    assert.equal(emitEvent({ source: "hook", event: "hook.error", code: "detection_failed", data: { stage: "stop" } }), false);
    assert.equal(emitEvent({ source: "hook", event: "hook.error", code: "detection_failed", data: { stage: "stop" } }), false);
  } finally { process.stderr.write = orig; }
  const warns = writes.filter((w) => w.includes("review-loop: event log not writable"));
  assert.equal(warns.length, 1);
  assert.doesNotMatch(warns[0], /\//, "no path in the warning");
});

test("T-OBS-5 (unit): no path, email or env value survives into a line", () => {
  env();
  process.env.ENVSECRET = "ENVSECRET";
  emitEvent({ source: "hook", event: "gate.decision", code: "reviewed", session_id: "/Users/x", artifact_key: "a@example.com", data: { gate: "/Users/x", outcome: "allowed", preset: "default", pending_count: 0 } });
  const raw = fs.readFileSync(eventsPath(), "utf8");
  for (const s of ["/Users/", "@example.com", "ENVSECRET"]) assert.ok(!raw.includes(s), s);
});
```

- [ ] **Step 3: Run the tests and see them fail**

  Run: `node --test test/contract/`

  Expected: FAIL with `Cannot find module …/codes.mjs`.

- [ ] **Step 4: Create `plugin/engine/lib/paths.mjs` and re-export from `state.mjs`**

```js
// plugin/engine/lib/paths.mjs — the state root lives here so events.mjs can use it without importing state.mjs.
import os from "node:os";
import path from "node:path";
import { ensurePrivateDir } from "./fsutil.mjs";

export function stateRoot() {
  return process.env.REVIEW_LOOP_STATE_DIR || path.join(os.homedir(), ".claude", "state", "review-loop");
}

/**
 * A state subdirectory (created 0700 when missing), verified to be a real directory: a link there would carry a
 * listing, a recursive prune or a scratch workspace outside the state tree.
 * @param {string} name
 */
export function stateSubdir(name) {
  const dir = path.join(stateRoot(), name);
  ensurePrivateDir(dir, stateRoot());
  return dir;
}
```

  In `state.mjs`, delete the `stateRoot` and `stateSubdir` function bodies and add
  `export { stateRoot, stateSubdir } from "./paths.mjs";` plus
  `import { stateRoot, stateSubdir } from "./paths.mjs";` for internal use. Delete `appendEvent` and
  its section comment.

- [ ] **Step 5: Write `plugin/engine/lib/codes.mjs`**

  The categories and remedies below are normative. Add **every** code from `/tmp/codes.txt` that
  isn't listed, using these rules:
  - a code ending in `_failed`, `_error` or `_invalid` that describes our own fault
    (`unexpected_error`, `spawn_failed`, `command_failed`, `codex_output_invalid`,
    `unknown_page_reason`, `detection_failed`) is category `internal`, with the remedy
    "run `review-loop doctor`; if it persists, report a bug";
  - a code that the user or their repo state can fix is `user_action`, with a one-line imperative
    remedy naming the command;
  - an argument or flag problem is `usage`;
  - a status or outcome word (`reviewed`, `allowed`, `passed`, `ok`, `kill_switch`, `tracked`,
    `mid_session`) is category `ok` with remedy `""`.

```js
// The single registry of codes, event types and CLI exit codes (spec §8.3). README tables are generated from it.
export const CLI_EXIT = Object.freeze({ ok: 0, user_action: 1, usage: 2, cancelled: 3, internal: 4 });

/** @typedef {"ok" | "user_action" | "usage" | "cancelled" | "internal"} Category */
/** @typedef {{ category: Category, remedy: string, details?: readonly string[] }} CodeMeta */

const DOCTOR = "run `review-loop doctor`; if it persists, report a bug";

/** @type {Readonly<Record<string, CodeMeta>>} */
export const CODES = Object.freeze({
  // outcomes
  ok: { category: "ok", remedy: "" },
  reviewed: { category: "ok", remedy: "" },
  allowed: { category: "ok", remedy: "" },
  passed: { category: "ok", remedy: "" },
  kill_switch: { category: "ok", remedy: "" },
  tracked: { category: "ok", remedy: "" },
  mid_session: { category: "ok", remedy: "" },
  setup_complete_unverified: { category: "ok", remedy: "run `review-loop doctor --live` to verify" },
  // registry fallbacks
  unregistered_code: { category: "internal", remedy: DOCTOR },
  unexpected_error: { category: "internal", remedy: DOCTOR },
  // CLI
  usage_noninteractive: { category: "usage", remedy: "re-run with --yes, or run it in a terminal" },
  usage_unknown_command: { category: "usage", remedy: "run `review-loop --help`" },
  usage_bad_flag: { category: "usage", remedy: "run `review-loop <command> --help`" },
  node_too_old: { category: "usage", remedy: "brew upgrade node" },
  cancelled: { category: "cancelled", remedy: "re-run the command when ready; completed steps are kept" },
  cli_busy: { category: "user_action", remedy: "another review-loop command is running; wait for it to finish" },
  claude_running: { category: "user_action", remedy: "quit all Claude Code sessions, then re-run" },
  claude_parent_process: { category: "user_action", remedy: "run this in a separate terminal, not from inside Claude Code" },
  tool_failed: {
    category: "user_action", remedy: "the named tool timed out or could not run; check it works in a terminal, then re-run",
    details: ["missing", "timeout", "output_too_large", "spawn_failed"]
  },
  claude_cli_unparseable: { category: "user_action", remedy: "update Claude Code (`claude update`), then re-run" },
  settings_invalid_json: { category: "user_action", remedy: "open ~/.claude/settings.json and correct the JSON; nothing was changed" },
  settings_target_insecure: { category: "user_action", remedy: "make ~/.claude/settings.json a regular file you own" },
  settings_writer_check_failed: { category: "user_action", remedy: "make sure /usr/bin/pgrep and /usr/sbin/lsof run for your user, then re-run" },
  settings_too_large: { category: "user_action", remedy: "settings.json is over 1 MiB, which is not a normal Claude Code settings file; check it by hand" },
  settings_concurrent_write: { category: "user_action", remedy: "close other programs editing settings.json, then re-run" },
  settings_open_elsewhere: { category: "user_action", remedy: "close the editor or sync tool that has settings.json open, then re-run" },
  settings_detached_write: { category: "user_action", remedy: "compare the reported backup with settings.json and copy over any change you need" },
  config_invalid: { category: "user_action", remedy: "run `review-loop config repair`" },
  config_symlink_rejected: { category: "user_action", remedy: "replace the config symlink with a regular file (`review-loop config repair`)" },
  rubric_symlink_rejected: { category: "user_action", remedy: "point rubricPath at the real file (`review-loop config set rubric <path>`)" },
  live_check_failed: {
    category: "user_action", remedy: "see the detail's remedy",
    details: ["codex_missing", "codex_auth", "plugin_missing", "pin_mismatch", "model_invalid", "effort_invalid", "timeout", "unparseable", "unknown"]
  },
  preflight_failed: { category: "user_action", remedy: "fix the item marked FAIL, then re-run", details: ["claude", "codex_cli", "codex_auth", "codex_plugin"] },
  plugin_install_failed: { category: "user_action", remedy: "run `review-loop doctor`" },
  rollback_skipped_modified: { category: "user_action", remedy: "the named file changed after migration; restore it by hand from the backup if you want" },
  legacy_pin_invalid: { category: "user_action", remedy: "run `review-loop setup` to pin the Codex plugin again" },
  migration_manifest_unreadable: { category: "user_action", remedy: "check that you own ~/.claude/state/review-loop/migration.json and can read it, then re-run" },
  migration_manifest_invalid: { category: "user_action", remedy: "restore by hand from ~/.claude/review-loop-legacy-<date>/ and the settings backups; the damaged record was kept as migration.json.corrupt-<ts>" },
  node_missing: { category: "user_action", remedy: "brew install node" },
  // AC-23
  pr_created_head_unreviewed: { category: "user_action", remedy: "re-run the review-loop for this PR before marking it ready", details: ["drafted", "closed", "uncontained"] },
  pr_verify_unavailable: { category: "user_action", remedy: "check the PR's head commit by hand; install and sign in to gh for automatic checks" },
  pr_create_merge_compound: { category: "usage", remedy: "create the PR, let review-loop verify it, then merge in a separate command" },
  pr_merge_unbound: { category: "user_action", remedy: "merge with --match-head-commit <reviewed-sha>" },
  pr_merge_graphql_unsupported: { category: "usage", remedy: "use gh pr merge --match-head-commit" },
  pr_merge_mcp_unbindable: { category: "usage", remedy: "use gh pr merge --match-head-commit" },
  pr_merge_context_unverifiable: { category: "user_action", remedy: "install and sign in to gh, then retry the merge" },
  pr_merge_auto_unbound: { category: "user_action", remedy: "merge without --auto after the review passes" },
  pr_github_api_unsupported_client: { category: "usage", remedy: "use gh (gh pr / gh api) so review-loop can check the call" },
  status_post_failed: { category: "user_action", remedy: "install and sign in to gh so approval marks can be posted" }
  // …plus every remaining code from /tmp/codes.txt, per the rules above this block.
});

/** Per-event data fields: each validator returns the value or null (spec §8.2). */
const oneOf = (/** @type {readonly string[]} */ list) => (/** @type {unknown} */ v) => (typeof v === "string" && list.includes(v) ? v : null);
const int = (/** @type {number} */ min, /** @type {number} */ max) => (/** @type {unknown} */ v) => (Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max ? v : null);
const num = (/** @type {number} */ min, /** @type {number} */ max) => (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
const bool = (/** @type {unknown} */ v) => (typeof v === "boolean" ? v : null);
const token = (/** @type {unknown} */ v) => (typeof v === "string" && /^[A-Za-z0-9._:/-]{1,64}$/.test(v) && !v.startsWith("/") ? v : null);

export const GATES = Object.freeze(["stop", "pr", "prompt", "prverify", "merge"]);
export const OUTCOMES = Object.freeze(["blocked", "warned", "denied", "allowed", "skipped"]);
export const STAGES = Object.freeze(["detection_failed", "snapshot_degraded", "hook_input_error", "hook_error", "prune_failed", "summary_write_failed", "lock_invalid", "status_post_failed", "session", "track", "prompt", "stop", "pr", "prverify"]);
export const COMMANDS_ENUM = Object.freeze(["setup", "config", "doctor", "update", "uninstall", "migrate", "selftest", "engine-path", "version", "help"]);
export const KINDS = Object.freeze(["spec", "plan", "impl", "pr"]);

/** @type {Readonly<Record<string, { sources: readonly string[], data: Readonly<Record<string, (v: unknown) => unknown>> }>>} */
export const EVENT_CATALOG = Object.freeze({
  "cli.exit": { sources: ["cli"], data: { command: oneOf(COMMANDS_ENUM), duration_ms: int(0, 86_400_000) } },
  "gate.decision": { sources: ["hook"], data: { gate: oneOf(GATES), outcome: oneOf(OUTCOMES), preset: oneOf(["default", "balanced", "advisory"]), pending_count: int(0, 10_000) } },
  "round.result": {
    sources: ["round"],
    data: {
      kind: oneOf(KINDS), round: int(0, 10_000), pass: bool, mean: num(0, 10), dims: dimsOf, model: token, effort: token,
      effort_source: oneOf(["config", "codex-inherited"]), preset: oneOf(["default", "balanced", "advisory"]), duration_ms: int(0, 86_400_000)
    }
  },
  "round.dispute": { sources: ["round"], data: { kind: oneOf(KINDS) } },
  "round.push": { sources: ["round"], data: {} },
  "hook.error": { sources: ["hook", "round", "cli"], data: { stage: oneOf(STAGES) } },
  "config.invalid": { sources: ["hook", "cli", "round"], data: {} },
  override: { sources: ["hook", "round", "cli"], data: { kind: oneOf(["branch", "artifact"]), action: oneOf(["kill_switch", "kill_switch_ignored", "manual", "skip_review"]) } },
  event_unregistered: { sources: ["cli", "hook", "round"], data: {} }
});

import { DIMENSIONS } from "./scoring.mjs";
/** @param {unknown} v */
function dimsOf(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const rec = /** @type {Record<string, unknown>} */ (v);
  /** @type {Record<string, number>} */
  const out = {};
  for (const d of DIMENSIONS) {
    const x = rec[d];
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 10) return null;
    out[d] = x;
  }
  return Object.keys(rec).length === DIMENSIONS.length ? out : null;
}

/** @param {string} code @returns {Category} */
export function categoryOf(code) {
  return Object.hasOwn(CODES, code) ? CODES[code].category : "internal";
}
/** @param {string} code */
export function exitFor(code) {
  return CLI_EXIT[categoryOf(code)];
}
/** @param {string} code */
export function remedyFor(code) {
  return Object.hasOwn(CODES, code) ? CODES[code].remedy : DOCTOR;
}
```

  Move the `import { DIMENSIONS }` line to the top of the file. It appears near `dimsOf` above only for
  reading order, and ESM hoists imports anyway, so both positions work, but the house style puts
  imports first.

- [ ] **Step 6: Write `plugin/engine/lib/events.mjs`**

```js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODES, EVENT_CATALOG } from "./codes.mjs";
import { readConfig } from "./config.mjs";
import { ensurePrivateDir, MiB } from "./fsutil.mjs";
import { stateRoot } from "./paths.mjs";

export const SCHEMA = "review-loop.event/1";
const LINE_MAX = 4096;
const ROTATE_AT = 5 * MiB;
const RUN_ID = crypto.randomUUID();
const SESSION_RE = /^[A-Za-z0-9-]{1,64}$/;
const KEY_RE = /^[0-9a-f]{24}$/;
let warned = false;

export const PACKAGE_VERSION = (() => {
  try {
    const manifest = new URL("../../.claude-plugin/plugin.json", import.meta.url);
    const v = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
})();

const defaultEventsPath = () => path.join(stateRoot(), "events.jsonl");
let pathWarned = false;

/**
 * The effective log path (spec §8.4). A configured `events.path` is used only if its parent is an existing directory
 * the user owns (lstat, so a symlinked parent fails) and the file is absent or a regular file the user owns. Otherwise:
 * the default path, plus one stderr warning with no path in it.
 */
export function eventsPath() {
  const configured = readConfig().config.events.path;
  if (configured === null) return defaultEventsPath();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const owned = (/** @type {fs.Stats} */ st) => uid === null || st.uid === uid;
  try {
    const parent = fs.lstatSync(path.dirname(configured));
    const st = fs.lstatSync(configured, { throwIfNoEntry: false });
    if (parent.isDirectory() && owned(parent) && (st === undefined || (st.isFile() && owned(st)))) return configured;
  } catch {
    // Unreadable parent: rejected below.
  }
  if (!pathWarned) {
    pathWarned = true;
    process.stderr.write("review-loop: events.path rejected (must be a regular file you own, in a directory you own); using the default log\n");
  }
  return defaultEventsPath();
}

/**
 * @typedef {{ source: "cli" | "hook" | "round", event: string, code: string, detail?: string | null, exit_code?: number | null,
 *   session_id?: string | null, artifact_key?: string | null, data?: Record<string, unknown> }} EventInput
 */

/** @param {EventInput} e */
function build(e) {
  const known = Object.hasOwn(EVENT_CATALOG, e.event);
  const spec = known ? EVENT_CATALOG[e.event] : EVENT_CATALOG.event_unregistered;
  const code = Object.hasOwn(CODES, e.code) ? e.code : "unregistered_code";
  const details = CODES[code]?.details ?? [];
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const [field, check] of Object.entries(spec.data)) data[field] = check(e.data?.[field]);
  return {
    schema: SCHEMA,
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    source: ["cli", "hook", "round"].includes(e.source) ? e.source : "hook",
    event: known ? e.event : "event_unregistered",
    code,
    detail: typeof e.detail === "string" && details.includes(e.detail) ? e.detail : null,
    exit_code: Number.isInteger(e.exit_code) && /** @type {number} */ (e.exit_code) >= 0 && /** @type {number} */ (e.exit_code) <= 255 ? e.exit_code : null,
    version: PACKAGE_VERSION,
    session_id: typeof e.session_id === "string" && SESSION_RE.test(e.session_id) ? e.session_id : null,
    artifact_key: typeof e.artifact_key === "string" && KEY_RE.test(e.artifact_key) ? e.artifact_key : null,
    data
  };
}

/** @typedef {ReturnType<typeof build>} EventLine */

/** The validated line object, exactly as it will be written. @param {EventInput} e @returns {EventLine} */
export function buildEvent(e) {
  return build(e);
}

/** Build and append one schema-v1 line. @param {EventInput} e @returns {boolean} */
export function emitEvent(e) {
  return writeEvent(build(e));
}

/**
 * Append one already-built line. Never throws: a logging failure must not change a gate decision or an exit code.
 * @param {EventLine} obj
 * @returns {boolean}
 */
export function writeEvent(obj) {
  try {
    const line = JSON.stringify(obj) + "\n";
    if (Buffer.byteLength(line) > LINE_MAX) throw new Error("line_cap");
    const file = eventsPath();
    // Only review-loop's own state dir is created or tightened; a user-chosen log directory keeps its mode.
    if (file === defaultEventsPath()) ensurePrivateDir(stateRoot(), stateRoot());
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) throw new Error("not_regular");
    if (st && st.size > ROTATE_AT) fs.renameSync(file, `${file}.1`);
    // O_NOFOLLOW: a symlink swapped in after the lstat fails the open (ELOOP) instead of redirecting the append.
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
    return true;
  } catch (err) {
    if (!warned) {
      warned = true;
      const reason = err && typeof err === "object" && "code" in err && err.code === "state_dir_insecure" ? "state_dir_insecure" : "write_failed";
      process.stderr.write(`review-loop: event log not writable (${reason})\n`);
    }
    return false;
  }
}

/** @param {Record<string, unknown>} line @returns {string[]} problems; empty when valid */
export function validateLine(line) {
  const problems = [];
  const keys = ["schema", "ts", "run_id", "source", "event", "code", "detail", "exit_code", "version", "session_id", "artifact_key", "data"];
  if (JSON.stringify(Object.keys(line)) !== JSON.stringify(keys)) problems.push("keys");
  if (line.schema !== SCHEMA) problems.push("schema");
  if (!Object.hasOwn(EVENT_CATALOG, String(line.event))) problems.push("event");
  if (!Object.hasOwn(CODES, String(line.code))) problems.push("code");
  const spec = EVENT_CATALOG[String(line.event)];
  if (spec) {
    const d = /** @type {Record<string, unknown>} */ (line.data ?? {});
    if (JSON.stringify(Object.keys(d)) !== JSON.stringify(Object.keys(spec.data))) problems.push("data.keys");
    for (const [k, check] of Object.entries(spec.data)) if (d[k] !== null && check(d[k]) === null) problems.push(`data.${k}`);
  }
  return problems;
}

/** The largest line this event can produce, from the catalog's bounds (T-OBS-6). @param {string} name */
export function maxLineBytes(name) {
  const spec = EVENT_CATALOG[name];
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const k of Object.keys(spec.data)) data[k] = k === "dims" ? Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Dimension${i}Name`, 10.0])) : "x".repeat(64);
  const worst = { schema: SCHEMA, ts: new Date().toISOString(), run_id: RUN_ID, source: "round", event: name, code: "x".repeat(64), detail: "x".repeat(64), exit_code: 255, version: "999.999.999", session_id: "x".repeat(64), artifact_key: "f".repeat(24), data };
  return Buffer.byteLength(JSON.stringify(worst) + "\n");
}
```

  In T-OBS-6, a `ROTATE` via `renameSync` over an existing `.1` replaces it. That is intended: one
  generation.

- [ ] **Step 7: Re-point the 13 `appendEvent` call sites**

  Map each site mechanically. `session` becomes `session_id`, and `key` becomes `artifact_key`.

| Old | New |
|---|---|
| `appendEvent({ event: "detection_failed", code, errno?, session })` | `emitEvent({ source: "hook", event: "hook.error", code, session_id: session, data: { stage: "detection_failed" } })`. The errno stays out, since it's content-free but unbounded. |
| `appendEvent({ event: "snapshot_degraded", … })` | the same, with `stage: "snapshot_degraded"` |
| `"hook_input_error"`, `"hook_error"`, `"prune_failed"`, `"summary_write_failed"`, `"lock_invalid"` | `event: "hook.error"`, `stage` = the old event name, `source` = `"hook"` (use `"round"` for `lock_invalid` when it comes from `review-round.mjs`) |
| `appendEvent({ event: "kill_switch_ignored", code: ks, kind?, session })` | `emitEvent({ source: "hook", event: "override", code: ks, session_id, data: { kind: kind ?? "artifact", action: "kill_switch_ignored" } })` |
| `appendEvent({ event: "override", code: "kill_switch", kind, session })` | `… event: "override", code: "kill_switch", data: { kind, action: "kill_switch" }` |
| `appendEvent({ event: "override", … })` in `review-round.mjs` (the manual override) | `… data: { kind: identity.kind === "branch" ? "branch" : "artifact", action: "manual" }`, `code: "ok"` |
| `appendEvent({ event: "pr_gate", code, key?, session? })` | removed. Task 8 emits `gate.decision` for every PR evaluation instead. |
| `appendEvent({ event: "round", … })` (4 sites) | `emitEvent({ source: "round", event: "round.result", code: <old code>, artifact_key: key, session_id: SESSION, exit_code: <the process exit>, data: { kind: identity.kind === "branch" ? "pr" : identity.kind, round: rec.round, pass: rec.status === "passed", mean: sumTenths / 110, dims: <name→score>, model, effort, effort_source, preset, duration_ms } })`. Fields not yet available until Task 10 are passed as `null`. |
| `appendEvent({ event: "dispute", … })` | `emitEvent({ source: "round", event: "round.dispute", code: "ok", artifact_key: key, session_id: SESSION, data: { kind } })` |
| `appendEvent({ event: "push", code: "ok", … })` | `emitEvent({ source: "round", event: "round.push", code: "ok", artifact_key: key, session_id: SESSION })` |

  Run: `grep -rn "appendEvent" plugin/ test/ | grep -v "^test/engine/.*//"`

  Expected: no hits in `plugin/`. Update the engine tests that read `events.jsonl` to assert the new
  shape: `l.event === "hook.error" && l.data.stage === "…"` instead of `l.event === "…"`.

- [ ] **Step 8: Run everything**

  Run: `(set -o pipefail; npm test 2>&1 | tail -3)`

  Expected: `# fail 0`. The contract tests pass, and the engine tests pass with the updated
  assertions.

- [ ] **Step 9: Commit**

```bash
git add -A plugin/engine test scripts/list-codes.mjs
git commit -m "feat(engine): code registry and schema-v1 event writer"
```

**Gate:**
- `node --test test/contract/codes.test.mjs` passes.
- Sabotage: add `throw new ReviewLoopError("zzz_new", "x")` to any lib file; T-OBS-3 must go red. Then
  revert. Record the red output in the commit message body.

---

### Task 8: Presets and gate outcomes in the hooks (Default byte-equal)

**Files:**
- Create: `plugin/engine/lib/presets.mjs`, `test/engine/golden.test.mjs`, `test/fixtures/golden/*.json`
- Modify: `plugin/engine/review-gate-hook.mjs` (the `stop`, `prompt` and `pr` branches)
- Test: `test/engine/presets.test.mjs`

**Interfaces:**
- Consumes: `readConfig` (Task 6) and `emitEvent` (Task 7).
- Produces:
  - `PRESETS: Record<"default"|"balanced"|"advisory", Record<Gate, Action>>`, where
    `Gate = "stop"|"pr"|"prompt"|"prverify"|"merge"` and `Action = "block"|"deny"|"stop"|"warn"|"inject"`;
  - `gateOutcome(preset: string, gate: Gate, pending: boolean): Action | "allow"`.

**Invariants:**
- Under `default`, hook stdout is byte-equal to the pre-change engine's, for the golden corpus, after
  normalizing two things: the engine path to `<ENGINE>`, and the skill name `review-loop skill` to
  `review-loop:review-loop skill`.
- **Deviation from the spec, recorded:** Task 11 renames the skill reference because plugin skills are
  namespaced, so the golden normalization covers it. §5.2 and AC-10's "byte-for-byte" holds modulo
  those two substitutions.
- Every gate evaluation emits exactly one `gate.decision` (§8.2 table). A non-PR Bash command emits
  none.

- [ ] **Step 1: Record goldens from the UNCHANGED engine**

  Write `test/engine/golden.test.mjs`. With `REVIEW_LOOP_GOLDEN=record` it writes fixtures; otherwise it
  compares against them. The corpus uses the `e2e.test.mjs` harness style: spawn the hook with
  `process.execPath`, `HOME` and state in temp dirs, and a temp git repo.

  The cases, keyed by name:
  - `stop-pending-spec`: session start, then write `docs/specs/x-design.md`, then track, then stop;
  - `stop-active`: the same, with `stop_hook_active: true`;
  - `stop-clean`: a repo with no changes;
  - `prompt-pending`: stop, then prompt;
  - `pr-pending`: `pr` mode with a PR-create Bash command, using the `prgate.test.mjs` `gh` stub map for
    a pushed branch;
  - `pr-nonpr`: `pr` mode with `ls`;
  - `session`: session mode only;
  - `[RF-2] stop-pending-unicode`: repo dir `tmpDir("rl sp ü-")`, spec `docs/specs/ünï code-design.md`.

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeRepo, commitFile, writeFile } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "..", "plugin", "engine", "review-gate-hook.mjs");
const ENGINE = path.dirname(HOOK);
const DIR = path.join(HERE, "..", "fixtures", "golden");
const G = "g" + "h";

function envFor(home) {
  return { ...process.env, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") };
}
function hook(mode, input, env) {
  const r = spawnSync(process.execPath, [HOOK, mode], { env, input: JSON.stringify(input), encoding: "utf8" });
  return r.stdout;
}
const normalize = (s) => s.split(ENGINE).join("<ENGINE>").replaceAll("review-loop:review-loop skill", "review-loop skill").replace(/tmp[^\s"\]]*/g, "<TMP>");

function corpus() {
  const out = {};
  const run = (name, repoDir, steps) => {
    const home = tmpDir();
    const env = envFor(home);
    let last = "";
    for (const [mode, input] of steps) last = hook(mode, { session_id: `s-${name}`, cwd: repoDir, ...input }, env);
    out[name] = normalize(last);
  };
  const repo = makeRepo(); commitFile(repo, "README.md", "x");
  const spec = () => writeFile(repo, "docs/specs/x-design.md", "# x\n");
  run("session", repo, [["session", {}]]);
  run("stop-clean", repo, [["session", {}], ["stop", { stop_hook_active: false }]]);
  run("stop-pending-spec", repo, [["session", {}], ["track", { tool_input: { file_path: spec() } }], ["stop", { stop_hook_active: false }]]);
  run("stop-active", repo, [["session", {}], ["track", { tool_input: { file_path: spec() } }], ["stop", { stop_hook_active: true }]]);
  run("prompt-pending", repo, [["session", {}], ["track", { tool_input: { file_path: spec() } }], ["stop", { stop_hook_active: false }], ["prompt", { prompt: "hi" }]]);
  run("pr-nonpr", repo, [["pr", { tool_name: "Bash", tool_input: { command: "ls" } }]]);
  const uni = makeRepo(tmpDir("rl sp ü-")); commitFile(uni, "README.md", "x");
  run("stop-pending-unicode", uni, [["session", {}], ["track", { tool_input: { file_path: writeFile(uni, "docs/specs/ünï code-design.md", "# u\n") } }], ["stop", { stop_hook_active: false }]]);
  return out;
}

test("T-CFG-2: Default preset hook output is byte-equal to the recorded pre-preset engine", () => {
  const got = corpus();
  if (process.env.REVIEW_LOOP_GOLDEN === "record") {
    fs.mkdirSync(DIR, { recursive: true });
    for (const [k, v] of Object.entries(got)) fs.writeFileSync(path.join(DIR, `${k}.json`), JSON.stringify(v));
    return;
  }
  for (const [k, v] of Object.entries(got)) assert.equal(v, JSON.parse(fs.readFileSync(path.join(DIR, `${k}.json`), "utf8")), k);
});
```

  Add the `pr-pending` case using the `gh` stub pattern from `test/engine/prgate.test.mjs` lines 11–28.
  Copy that stub setup into this file, and do not import it, since the stub mutates `process.env.PATH`
  at module load.

  Run: `REVIEW_LOOP_GOLDEN=record node --test test/engine/golden.test.mjs && ls test/fixtures/golden | wc -l`

  Expected: `8` files. **Commit the fixtures now**, before any engine change:
  `git add test && git commit -m "test: golden hook output of the pre-preset engine"`.

- [ ] **Step 2: Write the failing preset tests**

```js
// test/engine/presets.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, gateOutcome } from "../../plugin/engine/lib/presets.mjs";

const EXPECTED = {
  default: { stop: "block", pr: "deny", prompt: "inject", prverify: "stop", merge: "deny" },
  balanced: { stop: "warn", pr: "deny", prompt: "inject", prverify: "stop", merge: "deny" },
  advisory: { stop: "warn", pr: "warn", prompt: "inject", prverify: "warn", merge: "warn" }
};

test("T-CFG-1: every preset × gate × pending cell matches spec §5.2 and §7.1", () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), Object.keys(EXPECTED).sort(), "a new preset needs a matrix row here");
  for (const [preset, gates] of Object.entries(EXPECTED)) {
    for (const [gate, action] of Object.entries(gates)) {
      assert.equal(gateOutcome(preset, gate, true), action, `${preset}/${gate}/pending`);
      assert.equal(gateOutcome(preset, gate, false), "allow", `${preset}/${gate}/clean`);
    }
  }
  assert.equal(gateOutcome("bogus", "stop", true), "block", "unknown preset → Default");
});

test("Advisory never blocks", () => {
  for (const gate of Object.keys(EXPECTED.advisory)) assert.ok(!["block", "deny", "stop"].includes(gateOutcome("advisory", gate, true)));
});
```

- [ ] **Step 3: Implement `plugin/engine/lib/presets.mjs`**

```js
// Enforcement per preset (spec §5.2, §7.1). The review bar is the same in every preset; only enforcement differs.
export const PRESETS = Object.freeze({
  default: Object.freeze({ stop: "block", pr: "deny", prompt: "inject", prverify: "stop", merge: "deny" }),
  balanced: Object.freeze({ stop: "warn", pr: "deny", prompt: "inject", prverify: "stop", merge: "deny" }),
  advisory: Object.freeze({ stop: "warn", pr: "warn", prompt: "inject", prverify: "warn", merge: "warn" })
});

/**
 * @param {string} preset
 * @param {"stop" | "pr" | "prompt" | "prverify" | "merge"} gate
 * @param {boolean} pending
 */
export function gateOutcome(preset, gate, pending) {
  if (!pending) return "allow";
  const table = Object.hasOwn(PRESETS, preset) ? PRESETS[/** @type {keyof typeof PRESETS} */ (preset)] : PRESETS.default;
  return table[gate];
}
```

- [ ] **Step 4: Wire the presets into `review-gate-hook.mjs`**

  1. At the start of `main()`, after reading input: `const { readConfig } = await import("./lib/config.mjs");
     const cfg = readConfig();`. If `cfg.status === "invalid"`, write one stderr line
     `review-loop: config invalid (<code>); using Default preset — run \`review-loop config repair\``
     and emit `{source:"hook", event:"config.invalid", code: cfg.code, session_id}`. Set
     `const preset = cfg.config.preset;`.
  2. **`stop` branch.** Compute `const pending = blocking.length > 0;` and
     `const action = gateOutcome(preset, "stop", pending);`.
     - `action === "block"` **and** `stop_hook_active !== true`: emit today's `decision:"block"` object
       unchanged, with outcome `blocked`.
     - `action === "warn"` (P5 pass): emit `{ systemMessage: <the same reason text> + notes }`, with
       outcome `warned`. If P5 failed, emit nothing here: the prompt hook already injects the pending
       list on the next turn. The outcome is still `warned`.
     - Otherwise, keep today's non-blocking `systemMessage` behavior, with outcome `allowed`, or
       `skipped` when `killSwitchRoot` is set.
     - Then, exactly once:
       `emitEvent({ source:"hook", event:"gate.decision", code: pending ? "review_pending" : "reviewed", session_id: session, data:{ gate:"stop", outcome, preset, pending_count: blocking.length } })`.
  3. **`prompt` branch.** Always emit one `gate.decision`, with `gate:"prompt"`, outcome `warned` when
     `additionalContext` was injected and `allowed` otherwise, and `pending_count: s?.items.length ?? 0`.
  4. **`pr` branch.**
     - After the fast path (a non-PR Bash command returns early **without** an event), compute
       `const action = gateOutcome(preset, "pr", r.decision === "deny" && r.code !== "reviewed");`.
     - If `action === "warn"`, replace the deny with `emit({ systemMessage: "⚠ review-loop (Advisory): " + r.message })` and set outcome `warned`.
     - Otherwise keep today's emit, with outcome `denied`, `allowed`, or `skipped` for `r.code === "kill_switch"`.
     - Emit one `gate.decision` with `gate:"pr"` and `code: r.code`.
     - **Parse and argument errors (`pr_args_unresolvable` and similar) stay `deny` in every preset,**
       because they mean "could not evaluate", not "unreviewed". This is recorded as an invariant in
       `CLAUDE.md`.

- [ ] **Step 5: Add hook-level tests**

  Append to `test/engine/presets.test.mjs`:

```js
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeRepo, commitFile, writeFile } from "./helpers.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "engine", "review-gate-hook.mjs");

function sandbox(preset) {
  const home = tmpDir();
  const env = { ...process.env, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") };
  const setPreset = (p) => fs.writeFileSync(env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: p, codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  setPreset(preset);
  const repo = makeRepo();
  commitFile(repo, "README.md", "x");
  const hook = (mode, input) => spawnSync(process.execPath, [HOOK, mode], { env, input: JSON.stringify({ session_id: "s1", cwd: repo, ...input }), encoding: "utf8" }).stdout;
  const decisions = () => {
    const f = path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event === "gate.decision") : [];
  };
  return { repo, hook, decisions, setPreset };
}

test("T-OBS-9: clean stop and clean prompt each log one allowed decision; a non-PR Bash command logs none", () => {
  const s = sandbox("default");
  s.hook("session", {});
  s.hook("stop", { stop_hook_active: false });
  s.hook("prompt", { prompt: "hi" });
  s.hook("pr", { tool_name: "Bash", tool_input: { command: "ls" } });
  const d = s.decisions();
  assert.equal(d.length, 2);
  assert.deepEqual([d[0].data.gate, d[0].data.outcome, d[0].data.pending_count], ["stop", "allowed", 0]);
  assert.deepEqual([d[1].data.gate, d[1].data.outcome], ["prompt", "allowed"]);
});

test("T-CFG-7: a preset change applies to the very next hook, with no restart", () => {
  const s = sandbox("default");
  s.hook("session", {});
  s.hook("track", { tool_input: { file_path: writeFile(s.repo, "docs/specs/x-design.md", "# x\n") } });
  const blocked = s.hook("stop", { stop_hook_active: false });
  assert.match(blocked, /"decision":"block"/);
  s.setPreset("advisory");
  const warned = s.hook("stop", { stop_hook_active: false });
  assert.doesNotMatch(warned, /"decision"/);
  const outcomes = s.decisions().map((x) => x.data.outcome);
  assert.deepEqual(outcomes.slice(-2), ["blocked", "warned"]);
});

test("invalid config → Default behavior, one stderr line, a config.invalid event, file untouched", () => {
  const home = tmpDir();
  const env = { ...process.env, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") };
  fs.writeFileSync(env.REVIEW_LOOP_CONFIG, "{corrupt");
  const repo = makeRepo();
  commitFile(repo, "README.md", "x");
  const run = (mode, input) => spawnSync(process.execPath, [HOOK, mode], { env, input: JSON.stringify({ session_id: "s2", cwd: repo, ...input }), encoding: "utf8" });
  run("session", {});
  run("track", { tool_input: { file_path: writeFile(repo, "docs/specs/y-design.md", "# y\n") } });
  const r = run("stop", { stop_hook_active: false });
  assert.match(r.stdout, /"decision":"block"/);
  assert.equal(r.stderr.split("\n").filter((l) => l.includes("config invalid")).length, 1);
  assert.equal(fs.readFileSync(env.REVIEW_LOOP_CONFIG, "utf8"), "{corrupt");
  const events = fs.readFileSync(path.join(env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8");
  assert.match(events, /"event":"config.invalid"/);
});
```

- [ ] **Step 6: Run everything**

  Run: `(set -o pipefail; npm test 2>&1 | tail -3)`

  Expected: `# fail 0`. `golden.test.mjs` passes, so Default is byte-equal after normalization.

- [ ] **Step 7: Commit**

```bash
git add -A plugin/engine test
git commit -m "feat(engine): presets drive gate enforcement; every gate evaluation is logged"
```

**Gate:** sabotage. Change the `stop` block `reason` text by one character; T-CFG-2 goes red. Revert.
Then change `balanced.stop` to `"block"`; T-CFG-1 goes red. Revert.

---
### Task 9: Rubric resolution, pin location and Codex plugin discovery

**Files:**
- Create: `plugin/rubric/default.md`
- Modify: `plugin/engine/lib/rubric.mjs` (delete `DEFAULT_RULES_PATH`; add `resolveRubricPath()`), `plugin/engine/lib/pin.mjs` (`pinFile()` and `pluginBase()`), `plugin/engine/review-round.mjs` (the call site of `loadRubricSection`)
- Test: `test/engine/rubric-pin.test.mjs`

**Interfaces:**
- Consumes: `readConfig` (Task 6) and `stateRoot` (Task 7, `paths.mjs`).
- Produces:
  - `resolveRubricPath(): string`: `config.rubricPath` if set, else `<plugin>/rubric/default.md`;
  - `loadRubricSection(rulesPath = resolveRubricPath())`, unchanged otherwise;
  - `pinFile()`: `REVIEW_LOOP_PIN_FILE`, else `<stateRoot>/plugin-pin.json`;
  - `pluginBase()`: `REVIEW_LOOP_PLUGIN_BASE`, else the parent of the `installPath` of
    `codex@openai-codex` in `~/.claude/plugins/installed_plugins.json`, else today's cache path.

- [ ] **Step 1: Create `plugin/rubric/default.md`**

```bash
{ echo "# review-loop default rubric"; echo; \
  awk '/^## Dimension definitions & boundaries/{f=1} f&&/^## /&&!/Dimension definitions/{exit} f' ~/.claude/rules/multi-dimension-review.md; } > plugin/rubric/default.md
grep -icE '<private names>|/Users/' plugin/rubric/default.md
```

  Expected: the final `grep` prints `0`, and the file has about 75 lines, with all 11 bold dimension
  names. (`<private names>`: the author's handle and private org and project names as one alternation,
  kept in a private denylist.)

- [ ] **Step 2: Write the failing tests**

```js
// test/engine/rubric-pin.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { loadRubricSection, resolveRubricPath } from "../../plugin/engine/lib/rubric.mjs";
import { pinFile, pluginBase } from "../../plugin/engine/lib/pin.mjs";

function isolate() {
  const home = tmpDir();
  Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
  delete process.env.REVIEW_LOOP_PIN_FILE;
  delete process.env.REVIEW_LOOP_PLUGIN_BASE;
  return home;
}

test("default rubric resolves inside the plugin and names all 11 dimensions", () => {
  isolate();
  assert.match(resolveRubricPath(), /plugin[\\/]rubric[\\/]default\.md$/);
  assert.match(loadRubricSection(), /\*\*Usability\*\*/);
});

test("T-MIG-3: config.rubricPath overrides; a symlink is rejected", () => {
  const home = isolate();
  const mine = path.join(home, "mine.md");
  fs.copyFileSync(resolveRubricPath(), mine);
  fs.appendFileSync(mine, "\nPERSONAL-MARKER\n");
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: mine, events: { path: null } }));
  assert.equal(resolveRubricPath(), mine);
  const link = path.join(home, "link.md");
  fs.symlinkSync(mine, link);
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: link, events: { path: null } }));
  assert.throws(() => loadRubricSection(), { code: "rubric_symlink_rejected" });
});

test("pin lives in the state dir; pluginBase follows installed_plugins.json", () => {
  const home = isolate();
  assert.equal(pinFile(), path.join(home, "state", "plugin-pin.json"));
  const install = path.join(home, "custom", "codex", "1.0.9");
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "codex@openai-codex": [{ scope: "user", installPath: install, version: "1.0.9" }] } }));
  assert.equal(pluginBase(), path.dirname(install));
});
```

  **Before writing Step 3, confirm the real shape** of `~/.claude/plugins/installed_plugins.json`
  (`node -e 'console.log(JSON.stringify(require(process.env.HOME+"/.claude/plugins/installed_plugins.json"),null,1).slice(0,600))'`).
  If it differs from `{version, plugins: {id: [{installPath}]}}`, change both the fixture above and the
  reader below to the observed shape.

- [ ] **Step 3: Implement**

  In `rubric.mjs`, replace the `DEFAULT_RULES_PATH` constant and the default parameter:

```js
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.mjs";

const PLUGIN_DEFAULT_RUBRIC = fileURLToPath(new URL("../../rubric/default.md", import.meta.url));

export function resolveRubricPath() {
  return readConfig().config.rubricPath ?? PLUGIN_DEFAULT_RUBRIC;
}

/** @param {string} [rulesPath] */
export function loadRubricSection(rulesPath = resolveRubricPath()) {
  const text = safeReadFile(rulesPath, 256 * 1024, { missing: "rubric_source_missing", symlink: "rubric_symlink_rejected" }).toString("utf8");
  // …the rest of the function body is unchanged
}
```

  In `pin.mjs`:

```js
import { stateRoot } from "./paths.mjs";
import { isObject } from "./fsutil.mjs";

export function pluginBase() {
  if (process.env.REVIEW_LOOP_PLUGIN_BASE) return process.env.REVIEW_LOOP_PLUGIN_BASE;
  try {
    const file = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
    const data = JSON.parse(safeReadFile(file, 4 * MiB, { symlink: "plugin_pin_mismatch" }).toString("utf8"));
    const entries = isObject(data) && isObject(data.plugins) ? data.plugins["codex@openai-codex"] : null;
    const user = Array.isArray(entries) ? entries.find((e) => isObject(e) && e.scope === "user" && typeof e.installPath === "string") : null;
    if (user && path.isAbsolute(/** @type {string} */ (user.installPath))) return path.dirname(/** @type {string} */ (user.installPath));
  } catch {
    // Unreadable or reshaped registry: fall back to the cache layout the plugin has always used.
  }
  // Recomputed per call so tests that swap HOME see it.
  return path.join(os.homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
}

export function pinFile() {
  return process.env.REVIEW_LOOP_PIN_FILE || path.join(stateRoot(), "plugin-pin.json");
}
```

- [ ] **Step 4: Run the tests**

  Run: `(set -o pipefail; node --test test/engine/rubric-pin.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add -A plugin test
git commit -m "feat(engine): generic default rubric, config override, pin in state dir"
```

**Gate:** `grep -rn "DEFAULT_RULES_PATH\|\.claude\", \"rules\"\|\.claude\", \"review-loop\"" plugin/`
prints nothing.

---

### Task 10: Codex model and effort per round

**Files:**
- Create: `plugin/engine/lib/codexcfg.mjs` (read-only reader for the Codex defaults)
- Modify: `plugin/engine/lib/pin.mjs` (`runCompanion` args), `plugin/engine/review-round.mjs` (record fields)
- Test: `test/engine/model-effort.test.mjs`

**Interfaces:**
- Consumes: `readConfig` (Task 6), `emitEvent` (Task 7), and the P2 mechanism from `CLAUDE.md`.
- Produces:
  - `codexDefaults(): {model: string|null, effort: string|null}`, which reads
    `$CODEX_HOME/config.toml` read-only;
  - `effectiveCodex(): {model, effort, source: "config"|"codex-inherited"}`;
  - `companionArgs(base: string[], eff): string[]`.

- [ ] **Step 1: Write the failing tests**

```js
// test/engine/model-effort.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { codexDefaults, effectiveCodex, companionArgs } from "../../plugin/engine/lib/codexcfg.mjs";

function isolate(cfg) {
  const home = tmpDir();
  const codexHome = path.join(home, "codex");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "other"\n');
  Object.assign(process.env, { HOME: home, CODEX_HOME: codexHome, REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: cfg, rubricPath: null, events: { path: null } }));
  return codexHome;
}
const treeHash = (dir) => crypto.createHash("sha256").update(fs.readdirSync(dir).sort().map((n) => n + fs.readFileSync(path.join(dir, n))).join("|")).digest("hex");

test("codexDefaults reads top-level keys only, read-only", () => {
  const ch = isolate({ model: null, effort: null });
  const before = treeHash(ch);
  assert.deepEqual(codexDefaults(), { model: "gpt-6-luna", effort: "high" });
  assert.equal(treeHash(ch), before);
});

test("T-CFG-4: config wins and is recorded as source=config; null inherits", () => {
  isolate({ model: "m1", effort: "low" });
  assert.deepEqual(effectiveCodex(), { model: "m1", effort: "low", source: "config" });
  isolate({ model: null, effort: null });
  assert.deepEqual(effectiveCodex(), { model: "gpt-6-luna", effort: "high", source: "codex-inherited" });
});

test("T-CFG-4: companion args carry --model when set, and effort via the P2 mechanism", () => {
  const base = ["adversarial-review", "--wait", "--json"];
  const withBoth = companionArgs(base, { model: "m1", effort: "low", source: "config" });
  assert.deepEqual(withBoth.slice(0, 3), base);
  assert.ok(withBoth.includes("--model") && withBoth[withBoth.indexOf("--model") + 1] === "m1");
  assert.deepEqual(companionArgs(base, { model: "gpt-6-luna", effort: "high", source: "codex-inherited" }), base, "inherit passes nothing");
});

test("T-CFG-6: nothing under CODEX_HOME is ever opened for writing", () => {
  const ch = isolate({ model: "m1", effort: "low" });
  const before = treeHash(ch);
  effectiveCodex(); codexDefaults();
  assert.equal(treeHash(ch), before);
  fs.rmSync(path.join(ch, "config.toml"));
  fs.symlinkSync("/etc/hosts", path.join(ch, "config.toml"));
  assert.deepEqual(codexDefaults(), { model: null, effort: null }, "a symlinked config.toml is not followed");
});
```

- [ ] **Step 2: Implement `plugin/engine/lib/codexcfg.mjs`**

```js
import os from "node:os";
import path from "node:path";
import { readConfig } from "./config.mjs";
import { safeReadFile } from "./fsutil.mjs";

/** P2 mechanism (CLAUDE.md "P2 … mechanism="). This is the `flag:--effort` form; see the note below the block. @param {string} e */
const EFFORT_ARGS = (e) => ["--effort", e];

/** Read-only view of Codex's own defaults. This product never writes under $CODEX_HOME (spec §5.3). */
export function codexDefaults() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  let text;
  try {
    text = safeReadFile(file, 256 * 1024, { symlink: "codex_config_unreadable", missing: "codex_config_unreadable", tooLarge: "codex_config_unreadable", notFile: "codex_config_unreadable" }).toString("utf8");
  } catch {
    return { model: null, effort: null };
  }
  /** @type {{ model: string | null, effort: string | null }} */
  const out = { model: null, effort: null };
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break; // Only top-level keys: a [profile] table's `model` is not the default.
    const m = /^\s*(model|model_reasoning_effort)\s*=\s*"([^"]{1,64})"\s*(#.*)?$/.exec(line);
    if (m) out[m[1] === "model" ? "model" : "effort"] = m[2];
  }
  return out;
}

export function effectiveCodex() {
  const c = readConfig().config.codex;
  if (c.model !== null || c.effort !== null) {
    const d = codexDefaults();
    return { model: c.model ?? d.model, effort: c.effort ?? d.effort, source: /** @type {const} */ ("config") };
  }
  return { ...codexDefaults(), source: /** @type {const} */ ("codex-inherited") };
}

/**
 * @param {string[]} base companion args up to (not including) target args and focus
 * @param {{ model: string | null, effort: string | null, source: "config" | "codex-inherited" }} eff
 */
export function companionArgs(base, eff) {
  if (eff.source === "codex-inherited") return base;
  const c = readConfig().config.codex;
  const out = [...base];
  if (c.model) out.push("--model", c.model);
  if (c.effort) out.push(...EFFORT_ARGS(c.effort));
  return out;
}
```

  Register the new code `codex_config_unreadable` in `codes.mjs` as `internal`, with the remedy "check
  that ~/.codex/config.toml is a regular file". T-OBS-3 fails until you do.

  **P2 determines `EFFORT_ARGS`.** The sample uses the `flag` form. Keep it, or replace that one line,
  according to `CLAUDE.md`, then make the T-CFG-4 test assert the same shape:
  - `mechanism=flag:--effort`: `const EFFORT_ARGS = (e) => ["--effort", e];`
  - `mechanism=env:NAME`: `const EFFORT_ARGS = () => [];`, and `runCompanion` adds `NAME=<effort>` to
    the child env instead.
  - `mechanism=none`: `const EFFORT_ARGS = () => [];`. Effort is display-only, per the author's P2
    decision, and `effort_source` is still recorded.

- [ ] **Step 3: Thread it into `runCompanion` and the round record**

  In `pin.mjs`, `runCompanion` builds its args as
  `companionArgs(["adversarial-review", "--wait", "--json"], effectiveCodex())`, then `...p.targetArgs`,
  then `p.focus`, all prefixed by the companion path.

  In `review-round.mjs`, after a completed round, add
  `rec.meta.codex = { model, effort, source }`. Extend `isRecord` in `state.mjs` to accept an optional
  `meta.codex` object whose three fields are each `string|null`. Pass the same values into
  `round.result`'s `data` (Task 7 left them `null`).

- [ ] **Step 4: Run the tests**

  Run: `(set -o pipefail; npm test 2>&1 | tail -3)`

  Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add -A plugin test
git commit -m "feat(engine): per-round Codex model/effort, recorded; Codex config read-only"
```

**Gate:** sabotage. Make `companionArgs` drop `--model`; T-CFG-4 goes red. Revert.

---

### Task 11: Plugin packaging (manifest, marketplace, hooks, shim, skill)

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin/hooks/hooks.json`, `plugin/bin/hook`, `plugin/skills/review-loop/SKILL.md`
- Test: `test/contract/shape.test.mjs`, `test/contract/shim.test.mjs`

**Interfaces:**
- Consumes: the P1, P3, P4 and P5 verdicts.
- Produces:
  - hook modes `session|track|stop|prompt|pr|prverify`;
  - the shim's test seam `REVIEW_LOOP_NODE_CANDIDATES`;
  - the namespaced skill `review-loop:review-loop`.

- [ ] **Step 1: Write the manifests**

`plugin/.claude-plugin/plugin.json` (the dependency shape is the one P4 recorded as accepted):
```json
{
  "name": "review-loop",
  "version": "0.1.0",
  "description": "Enforced Codex adversarial review for Claude Code: presets, PR-head binding, JSONL events.",
  "license": "MIT",
  "dependencies": [ { "name": "codex", "marketplace": "openai-codex" } ]
}
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "review-loop",
  "owner": { "name": "<owner>" },
  "plugins": [ { "name": "review-loop", "source": "./plugin", "version": "0.1.0", "description": "Enforced Codex adversarial review for Claude Code" } ]
}
```

  `<owner>` stays a literal placeholder until D1 is answered, and Task 28 replaces it. The content
  gate allows exactly this token.

`plugin/hooks/hooks.json` (9 entries; the timeouts match today's `settings.json`):
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" pr", "timeout": 40 } ] },
      { "matcher": "mcp__.*__create_pull_request", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" pr", "timeout": 40 } ] },
      { "matcher": "mcp__.*__merge_pull_request", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" pr", "timeout": 40 } ] }
    ],
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" session", "timeout": 20 } ] } ],
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit|NotebookEdit", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" track", "timeout": 5 } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" prverify", "timeout": 40 } ] },
      { "matcher": "mcp__.*__create_pull_request", "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" prverify", "timeout": 40 } ] }
    ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" stop", "timeout": 20 } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/bin/hook\" prompt", "timeout": 5 } ] } ]
  }
}
```

- [ ] **Step 2: Write the shim `plugin/bin/hook`** (then `chmod 755`)

```sh
#!/bin/sh
# Claude Code hook entry for the review-loop plugin. Finds node; without it, fails loud (spec §6.3).
mode="$1"
root=$(cd "$(dirname "$0")/.." && pwd)
VERSION="0.1.0"

find_node() {
  if [ -n "${REVIEW_LOOP_NODE_CANDIDATES:-}" ]; then
    IFS=:; for c in $REVIEW_LOOP_NODE_CANDIDATES; do [ -x "$c" ] && { echo "$c"; return 0; }; done; unset IFS; return 1
  fi
  command -v node 2>/dev/null && return 0
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$c" ] && { echo "$c"; return 0; }; done
  return 1
}

if node_bin=$(find_node); then
  exec "$node_bin" "$root/engine/review-gate-hook.mjs" "$mode"
fi

input=$(cat)
reason="review-loop: Node.js not found — run: brew install node"

pr_like() {
  printf '%s' "$input" | grep -Eiq 'pr[^a-z0-9]+(create|merge)|/pulls|/merge|create_pull_request|merge_pull_request|createpullrequest|mergepullrequest|graphql'
}

log_event() { # $1 event, $2 data-json
  state="${REVIEW_LOOP_STATE_DIR:-$HOME/.claude/state/review-loop}"
  file="$state/events.jsonl"
  sid=$(printf '%s' "$input" | sed -n 's/.*"session_id":"\([A-Za-z0-9-]\{1,64\}\)".*/\1/p' | head -n 1)
  [ -n "$sid" ] && sid="\"$sid\"" || sid=null
  why=""
  if [ ! -d "$state" ] || [ -L "$state" ] || [ ! -O "$state" ]; then why=state_dir_insecure
  elif [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then why=write_failed  # >> would follow a link
  elif [ -f "$file" ] && [ "$(stat -f %z "$file" 2>/dev/null || echo 0)" -gt 5242880 ]; then why=size_cap
  fi
  if [ -z "$why" ]; then
    ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    rid=$(uuidgen | tr 'A-Z' 'a-z')
    ( umask 077; printf '{"schema":"review-loop.event/1","ts":"%s","run_id":"%s","source":"hook","event":"%s","code":"node_missing","detail":null,"exit_code":null,"version":"%s","session_id":%s,"artifact_key":null,"data":%s}\n' \
      "$ts" "$rid" "$1" "$VERSION" "$sid" "$2" >> "$file" ) 2>/dev/null || why=write_failed
  fi
  [ -n "$why" ] && printf 'review-loop: event log not writable (%s)\n' "$why" >&2
  return 0
}

case "$mode" in
  stop)
    case "$input" in *'"stop_hook_active":true'*) log_event gate.decision '{"gate":"stop","outcome":"allowed","preset":"default","pending_count":null}'; exit 0;; esac
    log_event gate.decision '{"gate":"stop","outcome":"blocked","preset":"default","pending_count":null}'
    printf '{"decision":"block","reason":"%s"}\n' "$reason";;
  pr)
    pr_like || exit 0
    log_event gate.decision '{"gate":"pr","outcome":"denied","preset":"default","pending_count":null}'
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason";;
  prverify)
    pr_like || exit 0
    log_event gate.decision '{"gate":"prverify","outcome":"denied","preset":"default","pending_count":null}'
    printf '{"continue":false,"stopReason":"review-loop: Node.js not found, so this PR could not be verified against the reviewed commit. Check it, then run: brew install node"}\n';;
  session|track|prompt)
    log_event hook.error "{\"stage\":\"$mode\"}"
    printf '%s\n' "$reason" >&2;;
esac
exit 0
```

  **The `VERSION` line is stamped at release** (Task 26), and T-SHAPE-4 checks that it equals
  `plugin.json`'s `version`.

- [ ] **Step 3: Write the skill `plugin/skills/review-loop/SKILL.md`**

  Start from `~/.claude/skills/review-loop/SKILL.md`, with these changes only:
  1. **Frontmatter `name: review-loop`.** Plugin skills are namespaced automatically as
     `review-loop:review-loop`.
  2. **The engine path.** If P3 passed, `RR="node ${CLAUDE_PLUGIN_ROOT}/engine/review-round.mjs"`. If P3
     failed, `RR="node $(review-loop engine-path)/review-round.mjs"`.
  3. **Replace** "The harness (hooks in `~/.claude/settings.json`)" with "The review-loop plugin's hooks".
     **Delete** the `~/.claude/review-loop/CLAUDE.md` reference.
  4. **Append a section `## Presets`.** One paragraph: Default blocks, Balanced warns at Stop but denies
     PRs, Advisory only warns. The bar is identical. Check yours with `review-loop config show`.
  5. **Append the author's former global `CLAUDE.md` instructions,** generalized: the "Automated
     review loop" section, with "page me" changed to "page the user", and without the 10-round wording
     tied to one person.
  6. **In the exit table's `0` row,** add: "For a PR, the engine also posts the `review-loop/<base>`
     status; see §7.1 of the spec."

  In `review-gate-hook.mjs`, replace `Invoke the review-loop skill` with
  `Invoke the review-loop:review-loop skill` everywhere (2 sites). The golden normalization in Task 8
  already accounts for this.

- [ ] **Step 4: Write the shape and shim tests**

```js
// test/contract/shape.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const R = (p) => path.join(process.cwd(), p);
const json = (p) => JSON.parse(fs.readFileSync(R(p), "utf8"));

test("T-SHAPE-1: 9 hook entries with exact matchers, modes and timeouts", () => {
  const h = json("plugin/hooks/hooks.json").hooks;
  const flat = Object.entries(h).flatMap(([ev, groups]) => groups.map((g) => `${ev}|${g.matcher ?? ""}|${g.hooks[0].command.split(" ").pop()}|${g.hooks[0].timeout}`));
  assert.deepEqual(flat.sort(), [
    "PostToolUse|Bash|prverify|40",
    "PostToolUse|Write|Edit|MultiEdit|NotebookEdit|track|5",
    "PostToolUse|mcp__.*__create_pull_request|prverify|40",
    "PreToolUse|Bash|pr|40",
    "PreToolUse|mcp__.*__create_pull_request|pr|40",
    "PreToolUse|mcp__.*__merge_pull_request|pr|40",
    "SessionStart||session|20",
    "Stop||stop|20",
    "UserPromptSubmit||prompt|5"
  ].sort());
});

test("T-SHAPE-1b: every hooks.json mode is handled by the engine and vice versa", () => {
  const modes = new Set(Object.values(json("plugin/hooks/hooks.json").hooks).flat().map((g) => g.hooks[0].command.split(" ").pop()));
  const engine = fs.readFileSync(R("plugin/engine/review-gate-hook.mjs"), "utf8");
  const handled = new Set([...engine.matchAll(/MODE === "([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...modes].sort(), [...handled].sort());
});

test("T-SHAPE-2: commands use ${CLAUDE_PLUGIN_ROOT} only", () => {
  for (const g of Object.values(json("plugin/hooks/hooks.json").hooks).flat()) assert.match(g.hooks[0].command, /^"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/hook" [a-z]+$/);
});

test("T-SHAPE-3: plugin/ never imports cli/", () => {
  const r = spawnSync("grep", ["-rEn", "from ['\"](\\.\\./)+cli/", R("plugin")], { encoding: "utf8" });
  assert.equal(r.stdout, "");
});

test("T-SHAPE-4: versions agree (package, plugin, marketplace, shim)", () => {
  const v = json("package.json").version;
  assert.equal(json("plugin/.claude-plugin/plugin.json").version, v);
  assert.equal(json(".claude-plugin/marketplace.json").plugins[0].version, v);
  assert.match(fs.readFileSync(R("plugin/bin/hook"), "utf8"), new RegExp(`^VERSION="${v.replaceAll(".", "\\.")}"$`, "m"));
});

test("T-SHAPE-5: hook text names the namespaced skill", () => {
  const engine = fs.readFileSync(R("plugin/engine/review-gate-hook.mjs"), "utf8");
  assert.ok(engine.includes("review-loop:review-loop skill"));
  assert.ok(!/Invoke the review-loop skill/.test(engine));
});

test("claude plugin validate --strict passes on plugin and marketplace (skipped without claude)", (t) => {
  if (spawnSync("sh", ["-c", "command -v claude"]).status !== 0) return t.skip("claude not installed");
  for (const target of ["plugin", "."]) {
    const r = spawnSync("claude", ["plugin", "validate", "--strict", R(target)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${target}: ${r.stdout}${r.stderr}`);
  }
});
```

```js
// test/contract/shim.test.mjs — T-DOC-9
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";

const SHIM = path.join(process.cwd(), "plugin", "bin", "hook");
const G = "g" + "h";
function run(mode, input, stateDir) {
  const env = { PATH: "/usr/bin:/bin", HOME: tmpDir(), REVIEW_LOOP_NODE_CANDIDATES: "/nonexistent/node", REVIEW_LOOP_STATE_DIR: stateDir };
  return spawnSync("/bin/sh", [SHIM, mode], { env, input: JSON.stringify(input), encoding: "utf8" });
}
function state() { const d = path.join(tmpDir(), "state"); fs.mkdirSync(d, { mode: 0o700 }); return d; }
const events = (d) => (fs.existsSync(path.join(d, "events.jsonl")) ? fs.readFileSync(path.join(d, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const prCreate = { session_id: "s-1", tool_name: "Bash", tool_input: { command: `${G} pr create --title t` } };

test("T-DOC-9: without node — stop blocks, pr denies, prverify stops, others log hook.error", () => {
  const d = state();
  assert.match(run("stop", { session_id: "s-1", stop_hook_active: false }, d).stdout, /"decision":"block"/);
  assert.equal(run("stop", { session_id: "s-1", stop_hook_active: true }, d).stdout, "");
  assert.match(run("pr", prCreate, d).stdout, /"permissionDecision":"deny"/);
  const pv = JSON.parse(run("prverify", prCreate, d).stdout);
  assert.deepEqual(Object.keys(pv).sort(), ["continue", "stopReason"]);
  assert.equal(pv.continue, false);
  for (const m of ["session", "track", "prompt"]) assert.equal(run(m, { session_id: "s-1" }, d).status, 0);
  const ev = events(d);
  assert.equal(ev.length, 7);
  for (const l of ev) { assert.deepEqual(validateLine(l), [], JSON.stringify(l)); assert.equal(l.code, "node_missing"); }
  assert.deepEqual(ev.filter((l) => l.event === "hook.error").map((l) => l.data.stage), ["session", "track", "prompt"]);
});

test("T-DOC-9 (−): non-PR Bash passes silently; bad state dir → decision still emitted + one warning; hostile session id → null", () => {
  const d = state();
  const ls = { session_id: "s-1", tool_name: "Bash", tool_input: { command: "ls" } };
  for (const m of ["pr", "prverify"]) { const r = run(m, ls, d); assert.equal(r.stdout, ""); }
  assert.equal(events(d).length, 0);
  const real = state();
  const link = path.join(tmpDir(), "state-link");
  fs.symlinkSync(real, link);
  const r = run("stop", { session_id: "s-1", stop_hook_active: false }, link);
  assert.match(r.stdout, /"decision":"block"/);
  assert.match(r.stderr, /^review-loop: event log not writable \((state_dir_insecure|size_cap|write_failed)\)$/m);
  assert.doesNotMatch(r.stderr, /\//);
  const d2 = state();
  run("stop", { session_id: "../../etc/passwd", stop_hook_active: false }, d2);
  assert.equal(events(d2)[0].session_id, null);
});
```

- [ ] **Step 5: Run the tests**

  Run: `(set -o pipefail; chmod 755 plugin/bin/hook && npm test 2>&1 | tail -3)`

  Expected: `# fail 0`. The `validate --strict` test runs if `claude` is on `PATH`.

- [ ] **Step 6: Commit**

```bash
git add -A plugin .claude-plugin test
git commit -m "feat(plugin): manifest, marketplace, 9 hooks, node shim, namespaced skill"
```

**Gate:**
- `claude plugin validate --strict plugin` exits 0.
- `claude plugin validate --strict .` exits 0.
- Sabotage: drop the `mcp__.*__merge_pull_request` entry; T-SHAPE-1 goes red. Revert.
- Sabotage: make the shim print `{"decision":"block"}` for `prverify`; T-DOC-9 goes red. Revert.

---
## Phase 2: PR-head binding (AC-23)

### Task 12: Shared fake executables, and post-create verification (`prverify`)

**Files:**
- Create: `test/fakes/fakebin.mjs`, `plugin/engine/lib/prverify.mjs`
- Modify: `plugin/engine/lib/github.mjs` (add `ghPrView`, `ghPrDraft`, `ghPrClose`), `plugin/engine/review-gate-hook.mjs` (add the `prverify` branch)
- Test: `test/engine/prverify.test.mjs`

**Interfaces:**
- Consumes: `parsePrCreate` and `tokenize` (`cmdparse.mjs`), `readRecord` and `identityKey` (`state.mjs`), `gateOutcome` (Task 8), `emitEvent` (Task 7).
- Produces:
  - `makeFakeBin(dir, name, responses): {log(): string[][]}`. It writes an executable `dir/name` that
    answers from `responses` keyed by `args.join(" ")`, with a `"*"` fallback, and records every argv.
    The CLI tests in Tasks 15–23 reuse it.
  - `ghPrView(slug, n, cwd): Promise<{headRefOid, baseRefName, headRefName, headRepo, isDraft, state} | null>`
  - `ghPrDraft(slug, n, cwd): Promise<boolean>` and `ghPrClose(slug, n, cwd, comment): Promise<boolean>`,
    each returning a **verified** result.
  - `evaluatePrVerify(p): Promise<{ output: object | null, outcome: "allowed"|"warned"|"denied", code: string, detail: string|null }>`,
    where `p = { cwd, session, toolName, toolInput, toolResponse, preset }`.

**Invariants (§7.1 (1)):**
- A Bash command that isn't PR creation returns `{output:null}` with no event.
- The **reviewed head** is `rec.reviewedFingerprint.split(":")[0]` for the PR's identity
  `{kind:"branch", baseRepo, baseBranch, headRepo, headBranch}`, from a record with status `passed` or
  `overridden`.
- A mismatch under Default or Balanced gives `{continue:false, stopReason}`; under Advisory it gives
  `{systemMessage}`.
- An unresolvable PR is `pr_verify_unavailable`: a stop under Default or Balanced, a warning under
  Advisory.

- [ ] **Step 1: Write `test/fakes/fakebin.mjs`**

```js
// A fake CLI for tests: answers from a response map keyed by the joined argv and records every call.
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} dir directory to put on PATH
 * @param {string} name executable name (gh, claude, codex, pgrep, lsof)
 * @param {Record<string, FakeResponse | FakeResponse[]>} responses keys: argv joined by " ", or "*". An array is
 *   consumed in order, one entry per call, and its last entry repeats (models "installed, then removed").
 */
export function makeFakeBin(dir, name, responses) {
  fs.mkdirSync(dir, { recursive: true });
  const map = path.join(dir, `${name}.responses.json`);
  const log = path.join(dir, `${name}.log.jsonl`);
  const counts = path.join(dir, `${name}.counts.json`);
  fs.writeFileSync(map, JSON.stringify(responses));
  fs.writeFileSync(log, "");
  fs.writeFileSync(counts, "{}");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const map = JSON.parse(fs.readFileSync(${JSON.stringify(map)}, "utf8"));
const key = Object.hasOwn(map, args.join(" ")) ? args.join(" ") : Object.hasOwn(map, "*") ? "*" : null;
let hit = key === null ? { code: 1, stderr: "fake ${name}: no response for " + args.join(" ") } : map[key];
if (Array.isArray(hit)) {
  const c = JSON.parse(fs.readFileSync(${JSON.stringify(counts)}, "utf8"));
  const i = c[key] ?? 0;
  c[key] = i + 1;
  fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify(c));
  hit = hit[Math.min(i, hit.length - 1)];
}
if (hit.stdout) process.stdout.write(hit.stdout);
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.code ?? 0);
`;
  fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  return {
    log: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    set: (/** @type {typeof responses} */ r) => { fs.writeFileSync(map, JSON.stringify(r)); fs.writeFileSync(counts, "{}"); }
  };
}
/** @typedef {{ code?: number, stdout?: string, stderr?: string }} FakeResponse */
```

  The script uses `require` because it runs as CommonJS with no `.mjs` extension. That is the one
  place CommonJS is used, and it's intentional.

- [ ] **Step 2: Write the failing tests**

```js
// test/engine/prverify.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { writeRecord, newRecord } from "../../plugin/engine/lib/state.mjs";

const G = "g" + "h";
const A = "a".repeat(40), B = "b".repeat(40), MB = "c".repeat(40);
const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
const home = tmpDir();
Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
const { evaluatePrVerify } = await import("../../plugin/engine/lib/prverify.mjs");

const identity = { kind: "branch", baseRepo: "o/r", baseBranch: "main", headRepo: "o/r", headBranch: "feat" };
function reviewed(sha) {
  const rec = newRecord(identity);
  rec.status = "passed";
  rec.reviewedFingerprint = `${sha}:${MB}`;
  writeRecord(rec);
}
const view = (sha, extra = {}) => ({ stdout: JSON.stringify({ headRefOid: sha, baseRefName: "main", headRefName: "feat", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" }, isDraft: false, state: "OPEN", ...extra }) });
const VIEW_ARGS = `pr view 7 --repo o/r --json headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,state`;
const createCall = (preset = "default") => ({
  cwd: home, session: "s1", toolName: "Bash", preset,
  toolInput: { command: `${G} pr create --repo o/r --base main --head feat --title t` },
  toolResponse: { stdout: "https://github.com/o/r/pull/7\n" }
});

test("T-PR-1: head matches the reviewed SHA → allowed, no mutation", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const r = await evaluatePrVerify(createCall());
  assert.deepEqual([r.outcome, r.output], ["allowed", null]);
  assert.ok(!gh.log().some((a) => a.includes("ready") || a.includes("close")));
});

test("T-PR-1 (−): a non-PR Bash command → no evaluation", async () => {
  const gh = makeFakeBin(bin, "gh", {});
  const r = await evaluatePrVerify({ ...createCall(), toolInput: { command: "ls" } });
  assert.equal(r.output, null);
  assert.equal(gh.log().length, 0);
});

test("T-PR-2: mismatch → draft, verify isDraft, continue:false, detail drafted", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B), "pr ready 7 --repo o/r --undo": {}, "pr view 7 --repo o/r --json isDraft --jq .isDraft": { stdout: "true\n" } });
  const r = await evaluatePrVerify(createCall());
  assert.deepEqual([r.code, r.detail, r.outcome], ["pr_created_head_unreviewed", "drafted", "denied"]);
  assert.deepEqual(Object.keys(r.output).sort(), ["continue", "stopReason"]);
  assert.equal(r.output.continue, false);
  assert.ok(gh.log().some((a) => a.join(" ") === "pr view 7 --repo o/r --json isDraft --jq .isDraft"), "draft state verified");
});

test("T-PR-2 (−a/b): draft does not stick → close + verify; close fails → uncontained", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", {
    [VIEW_ARGS]: view(B), "pr ready 7 --repo o/r --undo": {}, "pr view 7 --repo o/r --json isDraft --jq .isDraft": { stdout: "false\n" },
    [`pr close 7 --repo o/r --comment review-loop: head ${B.slice(0, 7)} was not reviewed`]: {}, "pr view 7 --repo o/r --json state --jq .state": { stdout: "CLOSED\n" }
  });
  assert.equal((await evaluatePrVerify(createCall())).detail, "closed");
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B), "*": { code: 1, stderr: "HTTP 500" } });
  const r = await evaluatePrVerify(createCall());
  assert.equal(r.detail, "uncontained");
  assert.match(r.output.stopReason, /open and unreviewed/);
});

test("T-PR-3: official MCP response (ID + URL) → gh lookup; without gh → unavailable", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const mcp = { cwd: home, session: "s1", preset: "default", toolName: "mcp__github__create_pull_request", toolInput: { owner: "o", repo: "r", base: "main", head: "feat" }, toolResponse: { ID: 1, URL: "https://github.com/o/r/pull/7" } };
  assert.equal((await evaluatePrVerify(mcp)).outcome, "allowed");
  assert.equal((await evaluatePrVerify({ ...mcp, toolResponse: { number: 7, head: { sha: A } } })).outcome, "allowed");
  makeFakeBin(bin, "gh", { "*": { code: 127, stderr: "gh: command not found" } });
  const r = await evaluatePrVerify(mcp);
  assert.deepEqual([r.code, r.output.continue], ["pr_verify_unavailable", false]);
  const other = await evaluatePrVerify({ ...mcp, toolResponse: { ID: 1, URL: "https://github.com/evil/x/pull/7" } });
  assert.equal(other.code, "pr_verify_unavailable", "a URL for a different repo is not trusted");
});

test("T-PR-12b: the create response says A but GitHub's head is now B → treated as unreviewed (race)", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B), "*": { stdout: "true\n" } });
  const resp = { stdout: JSON.stringify({ number: 7, head: { sha: A, ref: "feat", repo: { full_name: "o/r" } }, base: { ref: "main" } }) };
  const apiCall = { ...createCall(), toolInput: { command: `${G} api -X POST repos/o/r/pulls -f base=main -f head=feat -f title=t` }, toolResponse: resp };
  const r = await evaluatePrVerify(apiCall);
  assert.equal(r.code, "pr_created_head_unreviewed");
  assert.equal(r.output.continue, false);
  const mcp = await evaluatePrVerify({ cwd: home, session: "s1", preset: "default", toolName: "mcp__github__create_pull_request", toolInput: { owner: "o", repo: "r" }, toolResponse: { number: 7, head: { sha: A } } });
  assert.equal(mcp.code, "pr_created_head_unreviewed", "an MCP response head is not trusted either");
  makeFakeBin(bin, "gh", { "*": { code: 1, stderr: "HTTP 502" } });
  const down = await evaluatePrVerify(apiCall);
  assert.equal(down.code, "pr_verify_unavailable", "no current head → fail closed, even though the response carried A");
});

test("T-PR-4 + T-PR-10: unverifiable fails closed under Default; Advisory only warns", async () => {
  makeFakeBin(bin, "gh", { "*": { code: 1, stderr: "HTTP 500" } });
  const d = await evaluatePrVerify(createCall("default"));
  assert.equal(d.output.continue, false);
  const a = await evaluatePrVerify(createCall("advisory"));
  assert.deepEqual(Object.keys(a.output), ["systemMessage"]);
  assert.equal(a.outcome, "warned");
});

test("T-PR-11: gh api create response JSON is parsed for the PR number; the head is read from GitHub", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const call = { ...createCall(), toolInput: { command: `${G} api -X POST repos/o/r/pulls -f base=main -f head=feat -f title=t` }, toolResponse: { stdout: JSON.stringify({ number: 7, head: { sha: A, ref: "feat", repo: { full_name: "o/r" } }, base: { ref: "main" } }) } };
  assert.equal((await evaluatePrVerify(call)).outcome, "allowed");
  assert.ok(gh.log().some((a) => a.join(" ") === VIEW_ARGS), "PR #7 (from the response) was looked up on GitHub");
  const bad = await evaluatePrVerify({ ...call, toolResponse: { stdout: "{" + "x".repeat(2 * 1024 * 1024) } });
  assert.equal(bad.code, "pr_verify_unavailable");
});
```

- [ ] **Step 3: Add the `gh` helpers to `github.mjs`**

```js
const PR_FIELDS = "headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,state";

/** @param {string} slug @param {number} n @param {string} cwd */
export async function ghPrView(slug, n, cwd) {
  const r = await gh(["pr", "view", String(n), "--repo", slug, "--json", PR_FIELDS], cwd);
  if (r.code !== 0) return null;
  try {
    const v = JSON.parse(r.stdout);
    const head = v?.headRepositoryOwner?.login && v?.headRepository?.name ? `${v.headRepositoryOwner.login}/${v.headRepository.name}`.toLowerCase() : null;
    if (typeof v.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(v.headRefOid) || typeof v.baseRefName !== "string" || typeof v.headRefName !== "string" || !head) return null;
    return { headRefOid: v.headRefOid, baseRefName: v.baseRefName, headRefName: v.headRefName, headRepo: head, isDraft: v.isDraft === true, state: String(v.state) };
  } catch {
    return null;
  }
}

/** Convert to draft, then read it back: a plan without draft support "succeeds" without converting. @param {string} slug @param {number} n @param {string} cwd */
export async function ghPrDraft(slug, n, cwd) {
  await gh(["pr", "ready", String(n), "--repo", slug, "--undo"], cwd);
  const r = await gh(["pr", "view", String(n), "--repo", slug, "--json", "isDraft", "--jq", ".isDraft"], cwd);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** @param {string} slug @param {number} n @param {string} cwd @param {string} comment */
export async function ghPrClose(slug, n, cwd, comment) {
  await gh(["pr", "close", String(n), "--repo", slug, "--comment", comment], cwd);
  const r = await gh(["pr", "view", String(n), "--repo", slug, "--json", "state", "--jq", ".state"], cwd);
  return r.code === 0 && r.stdout.trim() === "CLOSED";
}
```

  Before committing, run `gh pr ready --help` and `gh pr close --help` to confirm `--undo` and
  `--comment`, per `ci-deploy-patterns`. Both were verified on 2026-09-28 (gh 2.101.0).

- [ ] **Step 4: Implement `plugin/engine/lib/prverify.mjs`**

```js
import { parsePrCreate } from "./cmdparse.mjs";
import { ghDefaultRepo, ghPrClose, ghPrDraft, ghPrView } from "./github.mjs";
import { gateOutcome } from "./presets.mjs";
import { identityKey, readRecord } from "./state.mjs";

const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_BODY = 1024 * 1024;

/** @param {unknown} v @returns {Record<string, unknown>} */
const obj = (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {});

/**
 * Which repo the creation targeted, and where to find the PR. Returns null when this call is not a PR creation.
 * @param {{ cwd: string, toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown }} p
 */
async function locate(p) {
  if (p.toolName === "Bash") {
    const command = typeof p.toolInput.command === "string" ? p.toolInput.command : "";
    const api = /\bapi\b[\s\S]*\/pulls\b/.test(command) && /(-X|--method)\s*=?\s*POST/i.test(command);
    let args = null;
    try { args = parsePrCreate(command); } catch { /* The PreToolUse gate already denied an unparseable create. */ }
    if (!args && !api) return null;
    const stdout = typeof obj(p.toolResponse).stdout === "string" ? /** @type {string} */ (obj(p.toolResponse).stdout) : "";
    const repo = (args?.repo ?? args?.ghRepoEnv ?? (/repos\/([^/\s]+\/[^/\s]+)\/pulls/.exec(command)?.[1]) ?? (await ghDefaultRepo(p.cwd)))?.toLowerCase() ?? null;
    if (api) {
      if (stdout.length > MAX_BODY) return { repo, number: null, head: null };
      try {
        const body = obj(JSON.parse(stdout));
        const head = obj(body.head).sha;
        return { repo, number: Number.isInteger(body.number) ? /** @type {number} */ (body.number) : null, head: typeof head === "string" && SHA.test(head) ? head : null };
      } catch {
        return { repo, number: null, head: null };
      }
    }
    const m = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(stdout);
    return { repo, number: m && m[1].toLowerCase() === repo ? Number(m[2]) : null, head: null };
  }
  const i = p.toolInput;
  const repo = typeof i.owner === "string" && typeof i.repo === "string" ? `${i.owner}/${i.repo}`.toLowerCase() : null;
  const res = obj(p.toolResponse);
  if (Number.isInteger(res.number) && typeof obj(res.head).sha === "string") return { repo, number: /** @type {number} */ (res.number), head: /** @type {string} */ (obj(res.head).sha) };
  const url = typeof res.URL === "string" ? res.URL : typeof res.url === "string" ? res.url : "";
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url);
  return { repo, number: m && m[1].toLowerCase() === repo ? Number(m[2]) : null, head: null };
}

/**
 * @param {{ cwd: string, session: string | null, toolName: string, toolInput: Record<string, unknown>, toolResponse: unknown, preset: string }} p
 */
export async function evaluatePrVerify(p) {
  const loc = await locate(p);
  if (!loc) return { output: null, outcome: /** @type {const} */ ("allowed"), code: "not_pr_creation", detail: null };
  const soft = gateOutcome(p.preset, "prverify", true) === "warn";
  const unavailable = (/** @type {string} */ why) => {
    const text = `review-loop: couldn't confirm PR ${loc.number ? `#${loc.number}` : ""}'s head commit (${why}) — check it before continuing`;
    return { output: soft ? { systemMessage: `⚠ ${text}` } : { continue: false, stopReason: text }, outcome: soft ? "warned" : "denied", code: "pr_verify_unavailable", detail: null };
  };
  if (!loc.repo || !SLUG.test(loc.repo) || !loc.number) return unavailable("no PR number");
  // GitHub's CURRENT head is authoritative. The create response's head (`loc.head`) is only a snapshot: the branch can
  // advance between creation and this hook, so it is never compared. No current head → fail closed.
  const pr = await ghPrView(loc.repo, loc.number, p.cwd);
  if (!pr) return unavailable("gh unavailable");
  const head = pr.headRefOid;
  if (!head || !SHA.test(head)) return unavailable("no head SHA");
  const identity = { kind: /** @type {const} */ ("branch"), baseRepo: loc.repo, baseBranch: pr.baseRefName, headRepo: pr.headRepo, headBranch: pr.headRefName };
  const rec = readRecord(identityKey(identity));
  const reviewedHead = rec && (rec.status === "passed" || rec.status === "overridden") ? rec.reviewedFingerprint?.split(":")[0] ?? null : null;
  if (reviewedHead === head) return { output: null, outcome: /** @type {const} */ ("allowed"), code: "reviewed", detail: null };

  const short = (/** @type {string | null} */ s) => (s ? s.slice(0, 7) : "none");
  if (soft) {
    return { output: { systemMessage: `⚠ review-loop (Advisory): PR #${loc.number} head ${short(head)} is not the reviewed ${short(reviewedHead)}` }, outcome: "warned", code: "pr_created_head_unreviewed", detail: null };
  }
  let detail = "uncontained";
  if (pr) {
    if (await ghPrDraft(loc.repo, loc.number, p.cwd)) detail = "drafted";
    else if (await ghPrClose(loc.repo, loc.number, p.cwd, `review-loop: head ${short(head)} was not reviewed`)) detail = "closed";
  }
  const did = detail === "drafted" ? "It was converted to draft." : detail === "closed" ? "It was closed." : `It could not be drafted or closed — PR #${loc.number} is open and unreviewed; convert it to draft now.`;
  return {
    output: { continue: false, stopReason: `review-loop: PR #${loc.number} head ${short(head)} is not the reviewed ${short(reviewedHead)}. ${did} Re-run the review-loop for this PR before marking it ready.` },
    outcome: "denied", code: "pr_created_head_unreviewed", detail
  };
}
```

  Register `not_pr_creation` (category `ok`) in `codes.mjs`.

- [ ] **Step 5: Add the `prverify` branch to `review-gate-hook.mjs`**

  Place it before `if (!session) …`:

```js
  if (MODE === "prverify") {
    const toolName = str(input.tool_name) ?? "";
    if (toolName === "Bash") {
      const { mentionsPrCreate } = await import("./lib/cmdparse.mjs");
      const command = str(toolInput.command) ?? "";
      if (!mentionsPrCreate(command) && !/\bapi\b[\s\S]*\/pulls\b/.test(command)) return;
    }
    const { evaluatePrVerify } = await import("./lib/prverify.mjs");
    const r = await evaluatePrVerify({ cwd, session, toolName, toolInput, toolResponse: input.tool_response, preset });
    if (r.code === "not_pr_creation") return;
    const { emitEvent } = await import("./lib/events.mjs");
    emitEvent({ source: "hook", event: "gate.decision", code: r.code, detail: r.detail, session_id: session, data: { gate: "prverify", outcome: r.outcome, preset, pending_count: r.outcome === "allowed" ? 0 : 1 } });
    if (r.output) emit(r.output);
    return;
  }
```

  In the `main().catch` handler, add `MODE === "prverify"` → `emit({ continue: false, stopReason: "review-loop [hook_error:<code>]: PR verification failed; check the PR's head commit" })`.
  This fails closed, and Advisory gets a `systemMessage` instead: read `preset` defensively, and default
  to Default.

- [ ] **Step 6: Run the tests**

  Run: `(set -o pipefail; node --test test/engine/prverify.test.mjs && npm test 2>&1 | tail -3)`

  Expected: all pass, and `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add -A plugin test
git commit -m "feat(engine): post-create PR-head verification with verified containment"
```

**Gate:** sabotage.
- Make `ghPrDraft` return `true` without the read-back; T-PR-2 (−a) still reports `drafted` → red. Revert.
- Emit `{decision:"block"}` instead of `continue:false`; T-PR-2 → red. Revert.

---

### Task 13: Merge gate (commit- and context-bound) and raw-client denial

**Files:**
- Create: `plugin/engine/lib/merge.mjs`, `plugin/engine/lib/mcp-merge.json`
- Modify: `plugin/engine/lib/cmdparse.mjs` (export `readApiArgs`; add `mentionsMerge` and `parseMerge`), `plugin/engine/review-gate-hook.mjs` (the `pr` branch dispatches to the merge gate), `plugin/engine/lib/prgate.mjs` (export the merge-base helper it already uses, if it isn't exported)
- Test: `test/engine/merge.test.mjs`

**Interfaces:**
- Consumes: `tokenize` and `readApiArgs` (`cmdparse.mjs`), `ghPrView` (Task 12), `mergeBaseValidity`, `fetchExactRef` and `repoRoot` (`git.mjs`), `isClearedAt` (`state.mjs`), `gateOutcome` (Task 8), and the P7 fixture `test/fixtures/mcp-merge-schema.json`.
- Produces:
  - `mentionsMerge(command): boolean`;
  - `parseMerge(command): null | {kind:"pr-merge", number:number|null, repo:string|null, bind:string|null, auto:boolean} | {kind:"api-merge", repo:string, number:number, bind:string|null} | {kind:"graphql-merge"} | {kind:"raw-client"}`;
  - `evaluateMergeGate(p): Promise<{decision:"allow"|"deny"|"warn", code:string, message:string}>`,
    where `p = { cwd, session, command?, mcpInput?, preset }`;
  - `MCP_HEAD_FIELD`, read from the P7 fixture's `headField`, or `null` when absent.

**Invariants (§7.1 (3)):**
- Compound create plus merge anywhere in one Bash call → `pr_create_merge_compound`.
- A merge is allowed only if `isClearedAt(identityOfPR, \`${bind}:${mergeBase(bind, currentBaseTip)}\`)`.
- Anything that can't be resolved → `pr_merge_context_unverifiable`, which fails closed.
- Advisory → `warn`.
- A GET, a view or a checks call is never gated.

- [ ] **Step 1: Write the failing tests**

```js
// test/engine/merge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpDir, makeRepo, commitFile, g } from "./helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { writeRecord, newRecord } from "../../plugin/engine/lib/state.mjs";
import { mentionsMerge, parseMerge } from "../../plugin/engine/lib/cmdparse.mjs";

const G = "g" + "h";
const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
const home = tmpDir();
Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
const { evaluateMergeGate } = await import("../../plugin/engine/lib/merge.mjs");

// A real local repo so merge-base is computed by git: main ← feat.
const repo = makeRepo();
const base = commitFile(repo, "a.txt", "a");
g(repo, "checkout", "-qb", "feat");
const A = commitFile(repo, "b.txt", "b");
g(repo, "checkout", "-q", "main");
const identity = (baseBranch) => ({ kind: "branch", baseRepo: "o/r", baseBranch, headRepo: "o/r", headBranch: "feat" });
function reviewed(baseBranch, head, mergeBase) {
  const rec = newRecord(identity(baseBranch));
  rec.status = "passed";
  rec.reviewedFingerprint = `${head}:${mergeBase}`;
  writeRecord(rec);
}
const VIEW = "pr view 5 --repo o/r --json headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,state";
const pr = (baseRefName) => ({ stdout: JSON.stringify({ headRefOid: A, baseRefName, headRefName: "feat", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" }, isDraft: false, state: "OPEN" }) });
const baseTip = (branch) => ({ [`api repos/o/r/git/ref/heads/${branch} --jq .object.sha`]: { stdout: `${base}\n` } });
const call = (command, preset = "default") => evaluateMergeGate({ cwd: repo, session: "s", command, preset });

test("classifier: merges recognised; reads are not", () => {
  for (const c of [`${G} pr merge 5 --squash`, `${G} api -X PUT repos/o/r/pulls/5/merge`, `${G} api graphql -f query='mutation{mergePullRequest(input:{})}'`, `curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge`]) assert.ok(mentionsMerge(c), c);
  for (const c of [`${G} pr view 5`, `${G} pr checks 5`, `${G} api -X GET repos/o/r/pulls/5`, "git merge main", `curl https://api.github.com/repos/o/r`]) assert.equal(parseMerge(c), null, c);
});

test("T-PR-6: create + merge in one call → compound deny, no gh call", async () => {
  const gh = makeFakeBin(bin, "gh", {});
  for (const sep of [" && ", "; ", "\n", " || "]) {
    const r = await call(`${G} pr create --title t${sep}${G} pr merge --squash`);
    assert.equal(r.code, "pr_create_merge_compound", JSON.stringify(sep));
  }
  assert.equal(gh.log().length, 0);
});

test("T-PR-7: bound to a reviewed SHA for THIS PR's identity → allow; else deny", async () => {
  reviewed("main", A, base);
  makeFakeBin(bin, "gh", { [VIEW]: pr("main"), ...baseTip("main") });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --squash --match-head-commit ${A}`)).decision, "allow");
  assert.equal((await call(`${G} api -X PUT repos/o/r/pulls/5/merge -f sha=${A}`)).decision, "allow");
  const unbound = await call(`${G} pr merge 5 --repo o/r --squash`);
  assert.equal(unbound.code, "pr_merge_unbound");
  assert.match(unbound.message, new RegExp(`--match-head-commit ${A}`));
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${"d".repeat(40)}`)).code, "pr_merge_unbound", "(b) unreviewed SHA");
});

test("T-PR-7 (c) + T-PR-9: same head SHA, different base (retarget) → deny", async () => {
  reviewed("main", A, base);
  makeFakeBin(bin, "gh", { [VIEW]: pr("release"), ...baseTip("release") });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_unbound");
});

test("T-PR-7 (d–i): graphql, repeated -X, no gh, MCP field rules, Advisory", async () => {
  assert.equal((await call(`${G} api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`)).code, "pr_merge_graphql_unsupported");
  assert.equal((await call(`${G} api -X PUT -X GET repos/o/r/pulls/5/merge`)).code, "pr_args_unresolvable");
  makeFakeBin(bin, "gh", { "*": { code: 127, stderr: "not found" } });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_context_unverifiable");
  reviewed("main", A, base);
  makeFakeBin(bin, "gh", { [VIEW]: pr("main"), ...baseTip("main") });
  const { MCP_HEAD_FIELD } = await import("../../plugin/engine/lib/merge.mjs");
  const mcp = (input) => evaluateMergeGate({ cwd: repo, session: "s", mcpInput: { owner: "o", repo: "r", pullNumber: 5, ...input }, preset: "default" });
  if (MCP_HEAD_FIELD) {
    assert.equal((await mcp({ [MCP_HEAD_FIELD]: A })).decision, "allow");
    assert.equal((await mcp({ sha: A })).code, "pr_merge_unbound", "(g) a field not in the schema is not a binding");
  } else {
    assert.equal((await mcp({ sha: A })).code, "pr_merge_mcp_unbindable", "(h)");
  }
  assert.equal((await call(`${G} pr merge 5 --repo o/r --squash`, "advisory")).decision, "warn", "(i)");
});

test("T-PR-8 + T-PR-12: reads untouched; raw REST clients denied best-effort", async () => {
  assert.equal(parseMerge(`${G} pr view 5`), null);
  for (const c of ["curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge", "wget --method=PUT https://api.github.com/repos/o/r/pulls/5/merge", "curl -X POST https://api.github.com/repos/o/r/pulls -d '{}'", "http PUT https://api.github.com/repos/o/r/pulls/5/merge"]) {
    assert.equal((await call(c)).code, "pr_github_api_unsupported_client", c);
  }
  assert.equal(parseMerge("curl https://api.github.com/repos/o/r"), null);
});
```

- [ ] **Step 2: Add the classifier to `cmdparse.mjs`**

  First, change `function readApiArgs` to `export function readApiArgs` (its signature is unchanged).
  Then append:

```js
const MERGE_TEXT = /\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b|\bapi\b[\s\S]*\/merge\b|mergePullRequest|enablePullRequestAutoMerge/;
const RAW_CLIENT = /\b(curl|wget|http|xh|https)\b[\s\S]*api\.github\.com[\s\S]*\/(pulls\b|merge\b)/;

/** Fast path for the PreToolUse hook: cheap text test before any parsing. @param {string} command */
export function mentionsMerge(command) {
  const t = unquoted(command);
  return MERGE_TEXT.test(t) || RAW_CLIENT.test(t);
}

/**
 * @param {string} command
 * @returns {null | { kind: "pr-merge", number: number | null, repo: string | null, bind: string | null, auto: boolean }
 *   | { kind: "api-merge", repo: string, number: number, bind: string | null } | { kind: "graphql-merge" } | { kind: "raw-client" }}
 */
export function parseMerge(command) {
  const t = unquoted(command);
  if (RAW_CLIENT.test(t) && /(-X|--request|--method)\s*=?\s*(PUT|POST)|\b(PUT|POST)\b/i.test(t)) return { kind: "raw-client" };
  if (!MERGE_TEXT.test(t)) return null;
  for (const seg of tokenize(command)) {
    const w = seg.map((x) => x.text);
    const i = w.findIndex((x) => path.basename(x) === "gh");
    if (i === -1) continue;
    if (w[i + 1] === "pr" && w[i + 2] === "merge") {
      const rest = w.slice(i + 3);
      /** @type {{ kind: "pr-merge", number: number | null, repo: string | null, bind: string | null, auto: boolean }} */
      const out = { kind: "pr-merge", number: null, repo: null, bind: null, auto: false };
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        if (a === "--match-head-commit") out.bind = rest[++k] ?? null;
        else if (a.startsWith("--match-head-commit=")) out.bind = a.slice(20);
        else if (a === "-R" || a === "--repo") out.repo = rest[++k] ?? null;
        else if (a.startsWith("--repo=")) out.repo = a.slice(7);
        else if (a === "--auto") out.auto = true;
        else if (/^\d+$/.test(a) && out.number === null) out.number = Number(a);
      }
      return out;
    }
    if (w[i + 1] === "api") {
      const { flags, positionals } = readApiArgs(w.slice(i + 2));
      if (positionals[0] === "graphql") return /mergePullRequest|enablePullRequestAutoMerge/.test(t) ? { kind: "graphql-merge" } : null;
      const methods = flags.filter((f) => f.flag === "-X" || f.flag === "--method").map((f) => String(f.value).toUpperCase());
      if (methods.length > 1) throw new ReviewLoopError("pr_args_unresolvable", "the HTTP method is given more than once");
      const m = /^\/?repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(positionals[0] ?? "");
      if (!m) return null;
      if ((methods[0] ?? "GET") !== "PUT") return null;
      const sha = flags.find((f) => ["-f", "-F", "--field", "--raw-field"].includes(f.flag) && String(f.value).startsWith("sha="));
      return { kind: "api-merge", repo: m[1].toLowerCase(), number: Number(m[2]), bind: sha ? String(sha.value).slice(4) : null };
    }
  }
  return null;
}
```

  Check `readApiArgs`'s returned `flags` element shape (`{flag, value}`) against its definition at
  `cmdparse.mjs:137` before relying on `.flag` and `.value`.

- [ ] **Step 3: Implement `plugin/engine/lib/merge.mjs`**

  First write `plugin/engine/lib/mcp-merge.json` from the P7 result, as `{"headField":"expectedHeadSha"}`,
  or `{"headField":null}` when P7 found no head-binding field. If P7-mcp is `unverified`, use the
  documented name `expectedHeadSha`, and add a `CLAUDE.md` note to re-verify it when a GitHub MCP
  server is connected. The test in Step 1 reads the same file through `MCP_HEAD_FIELD`, so the test
  and production can't disagree.

```js
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { mentionsPrCreate, parseMerge } from "./cmdparse.mjs";
import { errorCode } from "./errors.mjs";
import { ghBranchSha, ghDefaultRepo, ghPrView } from "./github.mjs";
import { commitExists, fetchExactRef, mergeBaseValidity, repoRoot } from "./git.mjs";
import { gateOutcome } from "./presets.mjs";
import { identityKey, isClearedAt, readRecord } from "./state.mjs";

const SHA = /^[0-9a-f]{40}$/;

/**
 * The GitHub MCP merge tool's head-binding field, as Probe P7 recorded it. It ships inside the plugin, never read from
 * test/, because a marketplace install contains only plugin/. `null` means the tool can't bind the head.
 */
export const MCP_HEAD_FIELD = (() => {
  const v = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./mcp-merge.json", import.meta.url)), "utf8"));
  return typeof v.headField === "string" ? v.headField : null;
})();

/** @param {string} code @param {string} message */
const deny = (code, message) => ({ decision: /** @type {const} */ ("deny"), code, message: `review-loop [${code}]: ${message}` });

/**
 * @param {{ cwd: string, session: string | null, command?: string, mcpInput?: Record<string, unknown>, preset: string }} p
 * @returns {Promise<{ decision: "allow" | "deny" | "warn", code: string, message: string }>}
 */
export async function evaluateMergeGate(p) {
  const soften = (/** @type {{ decision: "allow" | "deny" | "warn", code: string, message: string }} */ r) =>
    r.decision === "deny" && gateOutcome(p.preset, "merge", true) === "warn" && !["pr_args_unresolvable"].includes(r.code)
      ? { decision: /** @type {const} */ ("warn"), code: r.code, message: `⚠ review-loop (Advisory): ${r.message}` }
      : r;
  try {
    /** @type {{ repo: string | null, number: number | null, bind: string | null, auto?: boolean }} */
    let target;
    if (p.command !== undefined) {
      if (mentionsPrCreate(p.command)) return soften(deny("pr_create_merge_compound", "create the PR, let review-loop verify it, then merge in a separate command"));
      const m = parseMerge(p.command);
      if (!m) return { decision: "allow", code: "not_merge", message: "" };
      if (m.kind === "raw-client") return soften(deny("pr_github_api_unsupported_client", "use gh (gh pr / gh api) so review-loop can check the call"));
      if (m.kind === "graphql-merge") return soften(deny("pr_merge_graphql_unsupported", "use gh pr merge --match-head-commit <reviewed-sha>"));
      target = m;
    } else {
      const i = p.mcpInput ?? {};
      if (MCP_HEAD_FIELD === null) return soften(deny("pr_merge_mcp_unbindable", "this GitHub MCP server's merge tool can't bind the head commit; use gh pr merge --match-head-commit"));
      const n = Number(i.pullNumber ?? i.pull_number);
      target = {
        repo: typeof i.owner === "string" && typeof i.repo === "string" ? `${i.owner}/${i.repo}`.toLowerCase() : null,
        number: Number.isInteger(n) ? n : null,
        bind: typeof i[MCP_HEAD_FIELD] === "string" ? /** @type {string} */ (i[MCP_HEAD_FIELD]) : null
      };
    }
    const repo = target.repo ?? (await ghDefaultRepo(p.cwd));
    if (!repo || !target.number) return soften(deny("pr_merge_context_unverifiable", "name the PR number and repository (-R owner/repo)"));
    const pr = await ghPrView(repo, target.number, p.cwd);
    if (!pr) return soften(deny("pr_merge_context_unverifiable", "could not read the PR from GitHub; install and sign in to gh, then retry"));
    const identity = { kind: /** @type {const} */ ("branch"), baseRepo: repo, baseBranch: pr.baseRefName, headRepo: pr.headRepo, headBranch: pr.headRefName };
    const rec = readRecord(identityKey(identity));
    const reviewedHead = rec && (rec.status === "passed" || rec.status === "overridden") ? rec.reviewedFingerprint?.split(":")[0] ?? null : null;
    const hint = reviewedHead ? ` — use --match-head-commit ${reviewedHead}` : " — this PR has no passed review; run the review-loop for it first";
    if (!target.bind || !SHA.test(target.bind)) return soften(deny("pr_merge_unbound", `merge must name the reviewed head commit${hint}`));
    const root = await repoRoot(p.cwd);
    if (!root) return soften(deny("pr_merge_context_unverifiable", "run the merge from inside the repository"));
    const baseTip = await ghBranchSha(repo, pr.baseRefName, root, { notFound: "pr_merge_context_unverifiable", failed: "pr_merge_context_unverifiable" });
    if (!(await commitExists(root, baseTip))) await fetchExactRef(root, `https://github.com/${repo}.git`, pr.baseRefName);
    if (!(await commitExists(root, target.bind))) return soften(deny("pr_merge_context_unverifiable", `commit ${target.bind.slice(0, 7)} is not available locally; fetch it, then retry`));
    const v = await mergeBaseValidity(root, target.bind, baseTip);
    if (!v.ok || !isClearedAt(identity, `${target.bind}:${v.mergeBase}`)) return soften(deny("pr_merge_unbound", `commit ${target.bind.slice(0, 7)} has no passed review for ${identity.baseRepo}:${identity.baseBranch}${hint}`));
    return { decision: "allow", code: "reviewed", message: "" };
  } catch (err) {
    return soften(deny(errorCode(err) === "pr_args_unresolvable" ? "pr_args_unresolvable" : "pr_merge_context_unverifiable", /** @type {Error} */ (err).message));
  }
}
```

  **Check `fetchExactRef(root, source, branch, opts)` and `mergeBaseValidity(root, head, base)`** at
  `git.mjs:290` and `git.mjs:257`. If `mergeBaseValidity` returns a different shape than
  `{ok, mergeBase, reason}`, adapt the two lines that use it. The PR-create gate
  (`prgate.mjs:157-158`) uses the same call and is the reference.

  `P7-auto` handling: if `CLAUDE.md` records `P7-auto=unbound`, add the following before the identity
  step: `if (target.auto) return soften(deny("pr_merge_auto_unbound", "merge without --auto after the review passes"));`.
  Register `not_merge` (category `ok`) in `codes.mjs`.

- [ ] **Step 4: Dispatch from the hook's `pr` branch**

  In `review-gate-hook.mjs`, change the fast path to
  `if (!mentionsPrCreate(command) && !mentionsMerge(command)) return;`. Then:
  - if `mentionsMerge(command)` (Bash) or the tool name ends in `merge_pull_request` (MCP), call
    `evaluateMergeGate` and emit;
  - `deny` → today's PreToolUse deny JSON;
  - `warn` → `{systemMessage}`;
  - `allow` with `code === "not_merge"` → fall through to the create gate;
  - emit one `gate.decision` with `gate:"merge"` for every evaluation whose code isn't `not_merge`.

  Extend the MCP tool-name check from `/create_pull_request$/` to
  `/(create|merge)_pull_request$/`.

- [ ] **Step 5: Run the tests**

  Run: `(set -o pipefail; node --test test/engine/merge.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add -A plugin test
git commit -m "feat(engine): commit- and context-bound merge gate; deny raw REST PR clients"
```

**Gate:** sabotage. Replace the `isClearedAt(identity, …)` check with `rec?.status === "passed"`; T-PR-7
(c) passes the retargeted PR → red. Revert.

---

### Task 14: Commit statuses and the policy fingerprint

**Files:**
- Create: `plugin/engine/lib/status.mjs`
- Modify: `plugin/engine/review-round.mjs` (call sites: after a completed round `writeRecord`, after `override`, after a successful `push`)
- Test: `test/engine/status.test.mjs`

**Interfaces:**
- Consumes: `resolveRubricPath` (Task 9), `readConfig` (Task 6), `PACKAGE_VERSION` and `emitEvent` (Task 7).
- Produces:
  - `policyFingerprint(): string`, 12 hex digits of `sha256(rubricText + "\0" + preset + "\0" + "9.2" + "\0" + "review-loop " + major.minor)`;
  - `postVerdict({slug, sha, baseBranch, state:"success"|"failure", description, cwd, session, key}): Promise<boolean>`;
  - `statusContext(baseBranch): string`, which is `review-loop/` plus the percent-encoded base.

**Invariants (§7.1 (2)):**

| Round outcome | Status posted |
|---|---|
| passed | `success` |
| overridden | `success`, with an "overridden" description |
| needs_fixes or awaiting_human | `failure` |
| op_error or busy | nothing |

- Success is re-posted after `push`, because a local commit isn't on GitHub before the push. A post
  against an unknown SHA (HTTP 422) is `status_post_failed`, logged, and never fails the round.
- The description always carries `policy <fp>`.
- **Deviation, recorded:** the spec says "every completed round posts". The success post happens at
  both round completion and `push`, since the first may 422 before the commit is pushed.

- [ ] **Step 1: Write the failing tests**

```js
// test/engine/status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
const home = tmpDir();
Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
const { postVerdict, statusContext, policyFingerprint } = await import("../../plugin/engine/lib/status.mjs");
const A = "a".repeat(40);

test("T-PR-5: context names the base; success then failure on the same SHA", async () => {
  const gh = makeFakeBin(bin, "gh", { "*": { stdout: "{}" } });
  assert.equal(statusContext("main"), "review-loop/main");
  assert.equal(statusContext("feat/x y"), "review-loop/feat%2Fx%20y");
  assert.equal(await postVerdict({ slug: "o/r", sha: A, baseBranch: "main", state: "success", description: "passed", cwd: home, session: null, key: null }), true);
  assert.equal(await postVerdict({ slug: "o/r", sha: A, baseBranch: "main", state: "failure", description: "not passed", cwd: home, session: null, key: null }), true);
  const calls = gh.log().map((a) => a.join(" "));
  assert.match(calls[0], new RegExp(`^api -X POST repos/o/r/statuses/${A} -f state=success -f context=review-loop/main -f description=.*policy [0-9a-f]{12}`));
  assert.match(calls[1], /-f state=failure -f context=review-loop\/main/);
});

test("T-PR-5 (−): gh missing or 422 → false + status_post_failed event, never throws", async () => {
  makeFakeBin(bin, "gh", { "*": { code: 1, stderr: "HTTP 422: No commit found for SHA" } });
  assert.equal(await postVerdict({ slug: "o/r", sha: A, baseBranch: "main", state: "success", description: "passed", cwd: home, session: null, key: null }), false);
  const ev = fs.readFileSync(path.join(home, "state", "events.jsonl"), "utf8");
  assert.match(ev, /"code":"status_post_failed"/);
});

test("T-PR-13: policy fingerprint changes with the rubric; approvals are not revoked", async () => {
  const before = policyFingerprint();
  const mine = path.join(home, "mine.md");
  fs.writeFileSync(mine, fs.readFileSync(new URL("../../plugin/rubric/default.md", import.meta.url)) + "\nextra\n");
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: mine, events: { path: null } }));
  assert.notEqual(policyFingerprint(), before);
  const gh = makeFakeBin(bin, "gh", { "*": { stdout: "{}" } });
  assert.equal(gh.log().length, 0, "changing the rubric posts nothing by itself");
});
```

- [ ] **Step 2: Implement `plugin/engine/lib/status.mjs`**

```js
import crypto from "node:crypto";
import { readConfig } from "./config.mjs";
import { emitEvent, PACKAGE_VERSION } from "./events.mjs";
import { safeReadFile } from "./fsutil.mjs";
import { run } from "./proc.mjs";
import { resolveRubricPath } from "./rubric.mjs";

/** @param {string} baseBranch */
export function statusContext(baseBranch) {
  return `review-loop/${encodeURIComponent(baseBranch)}`;
}

/** Binds an approval to the policy it was given under (spec §7.1: approvals are not revoked retroactively). */
export function policyFingerprint() {
  let rubric = "";
  try {
    rubric = safeReadFile(resolveRubricPath(), 256 * 1024, { symlink: "rubric_symlink_rejected" }).toString("utf8");
  } catch {
    rubric = "<unreadable>";
  }
  const majorMinor = PACKAGE_VERSION.split(".").slice(0, 2).join(".");
  return crypto.createHash("sha256").update([rubric, readConfig().config.preset, "9.2", `review-loop ${majorMinor}`].join("\0")).digest("hex").slice(0, 12);
}

/**
 * Never throws and never fails a round: a failed post is logged and surfaced by doctor.
 * @param {{ slug: string, sha: string, baseBranch: string, state: "success" | "failure", description: string, cwd: string, session: string | null, key: string | null }} p
 */
export async function postVerdict(p) {
  const description = `${p.description} · policy ${policyFingerprint()}`.slice(0, 140);
  try {
    const r = await run("gh", ["api", "-X", "POST", `repos/${p.slug}/statuses/${p.sha}`, "-f", `state=${p.state}`, "-f", `context=${statusContext(p.baseBranch)}`, "-f", `description=${description}`], {
      cwd: p.cwd, timeoutMs: 7_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }
    });
    if (r.code === 0) return true;
  } catch {
    // Treated as a failed post below.
  }
  emitEvent({ source: "round", event: "hook.error", code: "status_post_failed", session_id: p.session, artifact_key: p.key, data: { stage: "status_post_failed" } });
  return false;
}
```

- [ ] **Step 3: Call it from `review-round.mjs`**

  In every case below, `identity.kind === "branch"`:
  1. **After a completed round's `writeRecord(rec)`,** around line 205: if `rec.status === "passed"`,
     post `success` with `review-loop passed vs <base> (mean X.X)`. If `rec.status` is `needs_fixes` or
     `awaiting_human`, post `failure` with `review-loop: not passed (mean X.X)`.
     - The sha is `rec.reviewedFingerprint?.split(":")[0] ?? <the round's head>`.
     - The slug is `identity.baseRepo`.
  2. **After `override`'s `writeRecord`,** around line 325: post `success` with
     `review-loop overridden by user (logged)`.
  3. **After a successful `push`,** around line 350: re-post `success` for the reviewed SHA.
  4. **Never** post on `op_error` or `busy`.

  Add to the round tests in `test/engine/e2e.test.mjs`: using `makeFakeBin` for `gh` with `"*"` →
  `{stdout:"{}"}`, a passing PR round records exactly one `statuses/` call with `state=success`, and a
  needs-fixes round records `state=failure`. Assert on `gh.log()`.

- [ ] **Step 4: Run the tests**

  Run: `(set -o pipefail; npm test 2>&1 | tail -3)`

  Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add -A plugin test
git commit -m "feat(engine): base-scoped commit statuses bound to a policy fingerprint"
```

**Gate:** sabotage. Skip the `failure` post; the e2e needs-fixes assertion goes red. Revert.

---
## Phase 3: the `review-loop` CLI

**Import rule for every CLI file:** `cli/**` imports engine modules as `../plugin/engine/lib/<x>.mjs`
from `cli/`, or `../../plugin/engine/lib/<x>.mjs` from `cli/lib/`. The Homebrew tarball keeps the same
relative layout under `libexec`. Nothing under `plugin/` imports `cli/` (T-SHAPE-3).

### Task 15: CLI skeleton (commands table, exit codes, `cli.exit`, `--json`, lock)

**Files:**
- Create: `cli/review-loop.mjs`, `cli/lib/io.mjs`, `cli/lib/lock.mjs`
- Test: `test/cli/skeleton.test.mjs`

**Interfaces:**
- Consumes: `buildEvent`, `writeEvent`, `CODES`, `exitFor`, `remedyFor` and `PACKAGE_VERSION` (Task 7).
- Produces:
  - `main(argv: string[], io: IO): Promise<number>`, which returns the exit code and never calls
    `process.exit` itself;
  - `IO = { out(s), err(s), ask(question, def): Promise<boolean>, choose(question, options, def): Promise<string>, isTTY: boolean, color: boolean, env: Record<string,string|undefined> }`;
  - `CliError(code, message, detail?)`;
  - `COMMANDS: Record<name, {help: string, run(args, io, ctx): Promise<{code:string, detail?:string|null, json?:unknown}>}>`;
  - `ctx = { json: boolean, yes: boolean, started: number }`;
  - `withCliLock(fn)`.

**Invariants:**
- Exactly one `cli.exit` event per process, on **every** path: normal, CliError, SIGINT (exit 3) and an
  unexpected throw (exit 4).
- With `--json`, stdout holds exactly one JSON line. It is the `cli.exit` event, except for `doctor`,
  whose report embeds the event. All human text goes to stderr.
- Node older than 22 → exit 2 `node_too_old` before anything else runs.
- A mutating command (`setup`, `config set|repair`, `update`, `uninstall`, `migrate`) runs under the
  CLI lock. A concurrent second run → exit 1 `cli_busy` [RF-5].

- [ ] **Step 1: Write the failing tests**

```js
// test/cli/skeleton.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";

const BIN = path.join(process.cwd(), "cli", "review-loop.mjs");
function sandbox() {
  const home = tmpDir();
  return { home, env: { ...process.env, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"), CLAUDECODE: "" } };
}
const events = (home) => fs.readFileSync(path.join(home, "state", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("T-OBS-2: every exit path writes exactly one cli.exit whose exit_code matches", () => {
  const s = sandbox();
  const cases = [
    [["--version"], 0], [["nope"], 2], [["config", "set", "preset", "yolo"], 2],
    [["selftest", "--inject-internal-error"], 4]
  ];
  for (const [args, code] of cases) {
    const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { env: s.env, encoding: "utf8" });
    assert.equal(r.status, code, `${args.join(" ")}: ${r.stderr}`);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "stdout is exactly one JSON line");
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.event, "cli.exit");
    assert.equal(ev.exit_code, code);
    assert.deepEqual(validateLine(ev), []);
  }
  const all = events(s.home).filter((e) => e.event === "cli.exit");
  assert.equal(all.length, cases.length);
});

test("T-OBS-2: SIGINT → exit 3 and a cli.exit with exit_code 3", async () => {
  const s = sandbox();
  const child = spawn(process.execPath, [BIN, "setup"], { env: { ...s.env, REVIEW_LOOP_TEST_WAIT_BEFORE_PROMPT: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  await new Promise((r) => setTimeout(r, 500));
  child.kill("SIGINT");
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  assert.equal(code, 3);
  assert.equal(events(s.home).filter((e) => e.event === "cli.exit").at(-1).exit_code, 3);
});

test("T-DOC-3 (concurrency): --json is the line this run wrote, even when others append around it", () => {
  const s = sandbox();
  const log = path.join(s.home, "state", "events.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const noisy = spawn(process.execPath, ["-e", `const fs=require("fs");const end=Date.now()+3000;(function w(){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({schema:"review-loop.event/1",event:"gate.decision"})+"\\n");if(Date.now()<end)setImmediate(w);})()`], { stdio: "ignore" });
  try {
    for (let i = 0; i < 5; i++) {
      const r = spawnSync(process.execPath, [BIN, "config", "show", "--json"], { env: s.env, encoding: "utf8" });
      const ev = JSON.parse(r.stdout).event ?? JSON.parse(r.stdout);
      assert.equal(ev.event, "cli.exit");
      assert.ok(fs.readFileSync(log, "utf8").split("\n").includes(JSON.stringify(ev)), "stdout is a line in the log, verbatim");
    }
  } finally { noisy.kill(); }
});

test("T-DOC-3 (write failure): --json still prints the full, valid cli.exit event", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.home, "state", "events.jsonl"), { recursive: true });
  const r = spawnSync(process.execPath, [BIN, "version", "--json"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0);
  const ev = JSON.parse(r.stdout);
  assert.deepEqual(validateLine(ev), []);
  assert.match(r.stderr, /event log not writable/);
});

test("T-SET-2: non-TTY without --yes → exit 2 usage_noninteractive, nothing invoked", () => {
  const s = sandbox();
  const r = spawnSync(process.execPath, [BIN, "setup", "--json"], { env: s.env, encoding: "utf8", input: "" });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).code, "usage_noninteractive");
});

test("[RF-5] a second mutating command while one holds the lock → cli_busy", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.home, "state", "locks"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(s.home, "state", "locks", "00000000000000000000c11c.lock"), JSON.stringify({ pid: process.pid, session: "other", token: "t".repeat(32) }), { mode: 0o600 });
  const r = spawnSync(process.execPath, [BIN, "config", "set", "preset", "balanced", "--json"], { env: s.env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, "cli_busy");
});
```

  `--inject-internal-error` and `REVIEW_LOOP_TEST_WAIT_BEFORE_PROMPT` are **test seams**. They are
  honored only when `process.env.REVIEW_LOOP_TEST_SEAMS === "1"`, so the test `sandbox()` must set
  `REVIEW_LOOP_TEST_SEAMS: "1"`. Add it to the `env` object above. Production never sets it.

- [ ] **Step 2: Implement `cli/lib/io.mjs`**

```js
import readline from "node:readline/promises";

/** @typedef {{ out: (s: string) => void, err: (s: string) => void, ask: (q: string, def: boolean) => Promise<boolean>,
 *   choose: (q: string, options: string[], def: string) => Promise<string>, isTTY: boolean, color: boolean,
 *   env: Record<string, string | undefined> }} IO */

/** @returns {IO} */
export function realIO() {
  const isTTY = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const color = isTTY && !process.env.NO_COLOR;
  const rl = () => readline.createInterface({ input: process.stdin, output: process.stderr });
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    isTTY, color, env: process.env,
    async ask(q, def) {
      const r = rl();
      try {
        const a = (await r.question(`${q} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        return a === "" ? def : a === "y" || a === "yes";
      } finally { r.close(); }
    },
    async choose(q, options, def) {
      const r = rl();
      try {
        const a = (await r.question(`${q} (${options.map((o) => (o === def ? `${o}*` : o)).join("/")}) `)).trim().toLowerCase();
        return a === "" ? def : options.includes(a) ? a : def;
      } finally { r.close(); }
    }
  };
}

/** Status words are always printed, so meaning never depends on color (screen readers, NO_COLOR). @param {"pass"|"fail"|"warn"|"skip"} s @param {boolean} color */
export function mark(s, color) {
  const word = { pass: "✓ OK  ", fail: "✗ FAIL", warn: "! WARN", skip: "- SKIP" }[s];
  if (!color) return word;
  const c = { pass: 32, fail: 31, warn: 33, skip: 90 }[s];
  return `\u001b[${c}m${word}\u001b[0m`;
}
```

- [ ] **Step 3: Implement `cli/lib/lock.mjs`**

```js
import { acquireLock } from "../../plugin/engine/lib/state.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";
import { CliError } from "./errors.mjs";

// A reserved key in the engine's lock namespace. assertKey accepts 24 hex chars; artifact keys are sha-derived, so they don't collide with it.
export const CLI_LOCK_KEY = "00000000000000000000c11c";

/**
 * One mutating review-loop command at a time: two setups racing would interleave settings and config writes.
 * Reuses the engine's lock: it publishes a fully written file by link() (no empty-file window) and reclaims a stale
 * lock by compare-and-swap. Only ACQUISITION errors map to cli_busy; an error from `fn` propagates and is never retried.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withCliLock(fn) {
  let lock;
  try {
    lock = acquireLock(CLI_LOCK_KEY, "cli");
  } catch (err) {
    if (err instanceof ReviewLoopError && err.code === "busy") throw new CliError("cli_busy", "another review-loop command is running");
    throw err;
  }
  try { return await fn(); } finally { lock.release(); }
}
```

  Also create `cli/lib/errors.mjs`:

```js
export class CliError extends Error {
  /** @param {string} code @param {string} message @param {string | null} [detail] */
  constructor(code, message, detail = null) { super(message); this.name = "CliError"; this.code = code; this.detail = detail; }
}
```

  **Check the `ReviewLoopError` import path** against the engine before pasting: it is wherever
  `state.mjs` imports it from (`grep -n "import.*ReviewLoopError" plugin/engine/lib/state.mjs`).

  **In the [RF-5] test,** the lock holder is `process.pid` of the **test runner**, written in the
  engine's lock format `{pid, session, token}` with a fresh mtime. It is alive and is a different process
  from the CLI child, so the child sees a live foreign holder and returns `cli_busy`.

  Add these tests to `test/cli/skeleton.test.mjs`:

```js
import { withCliLock, CLI_LOCK_KEY } from "../../cli/lib/lock.mjs";
import { readLock } from "../../plugin/engine/lib/state.mjs";

test("lock: an EEXIST thrown by the command propagates once and is never retried", async () => {
  const s = sandbox();
  process.env.REVIEW_LOOP_STATE_DIR = path.join(s.home, "state");
  let runs = 0;
  const boom = Object.assign(new Error("target exists"), { code: "EEXIST" });
  await assert.rejects(withCliLock(async () => { runs++; throw boom; }), (e) => e === boom);
  assert.equal(runs, 1);
  assert.equal(readLock(CLI_LOCK_KEY), null, "released after the throw");
});

test("lock: the lock is a complete, parseable record for the whole time the command runs", async () => {
  const s = sandbox();
  process.env.REVIEW_LOOP_STATE_DIR = path.join(s.home, "state");
  await withCliLock(async () => {
    const held = readLock(CLI_LOCK_KEY);
    assert.ok(held && held.pid === process.pid && typeof held.token === "string", "never observed empty or partial");
  });
});

test("lock: an empty or garbage lock file (a crashed older writer) is reclaimed, not treated as busy", async () => {
  const s = sandbox();
  process.env.REVIEW_LOOP_STATE_DIR = path.join(s.home, "state");
  fs.mkdirSync(path.join(s.home, "state", "locks"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(s.home, "state", "locks", `${CLI_LOCK_KEY}.lock`), "");
  let ran = false;
  await withCliLock(async () => { ran = true; });
  assert.ok(ran);
});
```

- [ ] **Step 4: Implement `cli/review-loop.mjs`**

```js
#!/usr/bin/env node
import { realIO } from "./lib/io.mjs";
import { CliError } from "./lib/errors.mjs";
import { withCliLock } from "./lib/lock.mjs";
import { buildEvent, writeEvent, PACKAGE_VERSION } from "../plugin/engine/lib/events.mjs";
import { exitFor, remedyFor, CODES, CLI_EXIT } from "../plugin/engine/lib/codes.mjs";

const MIN_NODE = 22;
const SEAMS = process.env.REVIEW_LOOP_TEST_SEAMS === "1";

/** Commands are loaded lazily so `--version` and `doctor` don't pay for setup's imports. */
export const COMMANDS = {
  setup: { help: "Guided install and configuration", mutates: true, load: () => import("./lib/setup.mjs") },
  config: { help: "Show or change settings: config show | config set <preset|model|effort|rubric|events.path> <value> | config repair", mutates: (/** @type {string[]} */ a) => a[0] !== "show", load: () => import("./lib/configcmd.mjs") },
  doctor: { help: "Diagnose the install (read-only). --live also runs a paid Codex check", mutates: false, load: () => import("./lib/doctor.mjs") },
  update: { help: "Update the plugin after `brew upgrade`", mutates: true, load: () => import("./lib/update.mjs") },
  uninstall: { help: "Remove the plugin and our settings entries", mutates: true, load: () => import("./lib/uninstall.mjs") },
  migrate: { help: "Move a legacy ~/.claude/review-loop install onto the plugin (--rollback undoes it)", mutates: true, load: () => import("./lib/migrate.mjs") },
  selftest: { help: "Offline smoke test of the bundled engine", mutates: false, load: () => import("./lib/selftest.mjs") },
  "engine-path": { help: "Print the installed plugin's engine directory", mutates: false, load: () => import("./lib/enginepath.mjs") }
};

/** @param {string[]} argv @param {import("./lib/io.mjs").IO} io @returns {Promise<number>} */
export async function main(argv, io) {
  const started = Date.now();
  const json = argv.includes("--json");
  const yes = argv.includes("--yes");
  const args = argv.filter((a) => a !== "--json" && a !== "--yes");
  const name = args[0] === "--version" || args[0] === "-v" ? "version" : args[0] === "--help" || args[0] === "-h" || args.length === 0 ? "help" : args[0];
  /** @type {{ code: string, detail?: string | null, json?: unknown }} */
  let result;
  let sigint = false;
  const onSigint = () => { sigint = true; finish({ code: "cancelled" }); process.exit(CLI_EXIT.cancelled); };
  process.once("SIGINT", onSigint);

  /** @param {{ code: string, detail?: string | null, json?: unknown }} r */
  function finish(r) {
    const code = Object.hasOwn(CODES, r.code) ? r.code : "unexpected_error";
    const exit = exitFor(code);
    const cmd = name in COMMANDS || name === "version" || name === "help" ? name : "help";
    // Print the very object that was appended, never a re-read of the shared log: a hook or another CLI may append
    // in between, and a failed write must still yield the full event on stdout.
    const ev = buildEvent({ source: "cli", event: "cli.exit", code, detail: r.detail ?? null, exit_code: exit, data: { command: cmd, duration_ms: Date.now() - started } });
    writeEvent(ev);
    if (json) {
      io.out(JSON.stringify(r.json !== undefined ? { ...(/** @type {object} */ (r.json)), event: ev } : ev) + "\n");
    } else if (exit !== 0) {
      io.err(`review-loop: ${code}${r.detail ? ` (${r.detail})` : ""} — ${remedyFor(code)}\n`);
    }
    return exit;
  }

  try {
    if (Number(process.versions.node.split(".")[0]) < MIN_NODE) return finish({ code: "node_too_old" });
    if (name === "version") { if (!json) io.err(`review-loop ${PACKAGE_VERSION}\n`); return finish({ code: "ok" }); }
    if (name === "help") { io.err(helpText()); return finish({ code: "ok" }); }
    if (!(name in COMMANDS)) return finish({ code: "usage_unknown_command" });
    if (SEAMS && argv.includes("--inject-internal-error")) throw new Error("injected");
    const cmd = COMMANDS[/** @type {keyof typeof COMMANDS} */ (name)];
    const mod = await cmd.load();
    const mutates = typeof cmd.mutates === "function" ? cmd.mutates(args.slice(1)) : cmd.mutates;
    const run = () => mod.run(args.slice(1), io, { json, yes, started });
    result = mutates ? /** @type {typeof result} */ (await withCliLock(run)) : await run();
    return finish(result);
  } catch (err) {
    if (sigint) return CLI_EXIT.cancelled;
    if (err instanceof CliError) return finish({ code: err.code, detail: err.detail });
    if (err && typeof err === "object" && "code" in err && typeof err.code === "string" && Object.hasOwn(CODES, err.code)) return finish({ code: err.code });
    io.err(`review-loop: unexpected error — ${remedyFor("unexpected_error")}\n`);
    return finish({ code: "unexpected_error" });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function helpText() {
  return `review-loop ${PACKAGE_VERSION}\n\n${Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(12)} ${c.help}`).join("\n")}\n\nExit codes: 0 ok · 1 needs your action · 2 usage · 3 cancelled · 4 internal\n`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/review-loop")) {
  main(process.argv.slice(2), realIO()).then((code) => process.exit(code));
}
```

  **`--json` prints the object `writeEvent` appended,** so stdout equals the logged line byte for byte
  (T-DOC-3), even with other processes appending concurrently. If the write failed, stdout still
  carries the full event and the stderr warning has been printed. Import `buildEvent` and `writeEvent`
  (not `emitEvent`) from `../plugin/engine/lib/events.mjs` in this file, as the import block above does.

  **The `setup` command honors `REVIEW_LOOP_TEST_WAIT_BEFORE_PROMPT`** only when seams are enabled, by
  sleeping 5 s before its first prompt so the SIGINT test can interrupt it. Task 18 adds that line.
  Until then, create `cli/lib/setup.mjs` with this minimal body so Task 15's tests run:

```js
import { CliError } from "./errors.mjs";
export async function run(/** @type {string[]} */ args, /** @type {import("./io.mjs").IO} */ io, /** @type {{ yes: boolean }} */ ctx) {
  if (!io.isTTY && !ctx.yes) throw new CliError("usage_noninteractive", "setup needs a terminal, or --yes");
  if (process.env.REVIEW_LOOP_TEST_SEAMS === "1" && process.env.REVIEW_LOOP_TEST_WAIT_BEFORE_PROMPT) await new Promise((r) => setTimeout(r, 5000));
  return { code: "ok" };
}
```

  Create `cli/lib/configcmd.mjs` in the same minimal form. It validates `set preset <v>` against
  `PRESET_NAMES` and throws `CliError("usage_bad_flag", …)` for anything else, so the `yolo` case exits
  2. Task 19 replaces it.

  The SIGINT test runs `setup` **without** `--yes`, with stdin a pipe (not a TTY), so it would exit 2
  before the wait. Order the checks in the Task 15 stub so the seam wait comes **first**, then the TTY
  check.

- [ ] **Step 5: Run the tests**

  Run: `(set -o pipefail; chmod 755 cli/review-loop.mjs && node --test test/cli/skeleton.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add -A cli test
git commit -m "feat(cli): command table, exit-code contract, cli.exit events, lock"
```

**Gate:** sabotage. Remove the `finish()` call in the SIGINT handler; the SIGINT test goes red. Revert.

---

### Task 16: `settings.json` writer (§6.2)

**Files:**
- Create: `cli/lib/settings.mjs`
- Test: `test/cli/settings.test.mjs`

**Interfaces:**
- Consumes: `stateSubdir` (`paths.mjs`), `sha256hex` (`fsutil.mjs`), `CliError`, and the P6 command
  from `CLAUDE.md` (default `pgrep -x claude`).
- Produces:
  - `ASK_RULES: readonly string[]`, the five strings;
  - `LEGACY_HOOK_RE = /review-loop\/review-gate-hook\.mjs/`;
  - `settingsPath(): string`, which is `~/.claude/settings.json`, or `CLAUDE_CONFIG_DIR/settings.json`
    when set;
  - `readSettings(): {target, exists, base, obj}`;
  - `updateSettings(mutate: (obj) => boolean, opts): Promise<{changed: boolean, backup: string|null}>`;
  - `writerPreconditions(io, opts): Promise<void>`;
  - `seams` (the test-only hooks object).

**Invariants:** the §6.2 guarantee table verbatim. Most importantly:
- the target is never absent or partial (`rename` only);
- a foreign write before the re-hash or after the rename is merged;
- the backup is a **hard link in `<stateRoot>/settings-backups/`** and is never deleted by the commit;
- pruning keeps our newest 5 and never removes one whose content no longer matches its `sha8`;
- `env` values never reach any output.

- [ ] **Step 1: Write the failing tests**

  Each test runs in a sandbox with `HOME` and `REVIEW_LOOP_STATE_DIR` set, a fake `pgrep` and a fake
  `lsof` on `PATH` (answering "no processes": exit 1 with empty stdout), and `CLAUDECODE` unset.

```js
// test/cli/settings.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.CLAUDECODE;
const quiet = () => { makeFakeBin(bin, "pgrep", { "*": { code: 1 } }); makeFakeBin(bin, "lsof", { "*": { code: 1 } }); };
const { ASK_RULES, updateSettings, settingsPath, seams } = await import("../../cli/lib/settings.mjs");
const addRules = (o) => { o.permissions ??= {}; o.permissions.ask ??= []; let ch = false; for (const r of ASK_RULES) if (!o.permissions.ask.includes(r)) { o.permissions.ask.push(r); ch = true; } return ch; };
const io = { isTTY: false, err: () => {}, out: () => {}, ask: async () => true };

function sandbox(initial) {
  const home = tmpDir();
  process.env.HOME = home;
  process.env.REVIEW_LOOP_STATE_DIR = path.join(home, "state");
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (initial !== undefined) fs.writeFileSync(settingsPath(), initial);
  quiet();
  seams.reset();
  return home;
}
const read = () => JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
const backups = (home) => fs.existsSync(path.join(home, "state", "settings-backups")) ? fs.readdirSync(path.join(home, "state", "settings-backups")) : [];

test("T-SET-9: idempotent — the second run changes no byte, makes no backup", async () => {
  const home = sandbox(JSON.stringify({ theme: "dark" }));
  await updateSettings(addRules, { io, yes: true });
  const bytes = fs.readFileSync(settingsPath());
  const mtime = fs.statSync(settingsPath()).mtimeMs;
  const n = backups(home).length;
  const r = await updateSettings(addRules, { io, yes: true });
  assert.equal(r.changed, false);
  assert.deepEqual(fs.readFileSync(settingsPath()), bytes);
  assert.equal(fs.statSync(settingsPath()).mtimeMs, mtime);
  assert.equal(backups(home).length, n);
});

test("T-SET-10: foreign keys deep-equal, same order", async () => {
  sandbox(JSON.stringify({ z: 1, hooks: { Stop: [] }, env: { A: "1" }, a: [1, 2] }));
  await updateSettings(addRules, { io, yes: true });
  const o = read();
  assert.deepEqual(Object.keys(o), ["z", "hooks", "env", "a", "permissions"]);
  assert.deepEqual([o.z, o.hooks, o.env, o.a], [1, { Stop: [] }, { A: "1" }, [1, 2]]);
});

test("T-SET-11: invalid JSON refused, bytes unchanged, no backup", async () => {
  const home = sandbox('{"a":1,}');
  await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_invalid_json" });
  assert.equal(fs.readFileSync(settingsPath(), "utf8"), '{"a":1,}');
  assert.equal(backups(home).length, 0);
});

test("[RF-1] BOM and CRLF parse; output is LF with no BOM", async () => {
  sandbox("﻿{\r\n  \"theme\": \"dark\"\r\n}\r\n");
  await updateSettings(addRules, { io, yes: true });
  const raw = fs.readFileSync(settingsPath(), "utf8");
  assert.ok(!raw.startsWith("﻿") && !raw.includes("\r"));
  assert.equal(read().theme, "dark");
});

test("T-SET-11b: an oversized settings.json is refused before it is buffered; bytes unchanged, no backup", async () => {
  const home = sandbox("{}");
  const big = `{"x":"${"a".repeat(1024 * 1024)}"}`;
  fs.writeFileSync(settingsPath(), big);
  await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_too_large" });
  assert.equal(fs.readFileSync(settingsPath(), "utf8").length, big.length);
  assert.equal(backups(home).length, 0);
});

test("T-SET-12b: a dangling settings symlink is refused and left exactly as it was", async () => {
  const home = sandbox();
  const missing = path.join(home, "dotfiles", "settings.json");
  fs.symlinkSync(missing, settingsPath());
  await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_target_insecure" });
  assert.ok(fs.lstatSync(settingsPath()).isSymbolicLink());
  assert.equal(fs.readlinkSync(settingsPath()), missing);
  assert.equal(fs.existsSync(missing), false, "no file created through the link");
  assert.equal(backups(home).length, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(settingsPath())).filter((n) => n.endsWith(".tmp")), []);
});

test("T-SET-12: symlinked settings — link survives, target updated, mode preserved; foreign-owned target refused", async () => {
  const home = sandbox();
  const real = path.join(home, "dotfiles", "settings.json");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "{}", { mode: 0o644 });
  fs.chmodSync(real, 0o644);
  fs.symlinkSync(real, settingsPath());
  await updateSettings(addRules, { io, yes: true });
  assert.ok(fs.lstatSync(settingsPath()).isSymbolicLink());
  assert.equal(fs.statSync(real).mode & 0o777, 0o644);
  assert.ok(JSON.parse(fs.readFileSync(real, "utf8")).permissions.ask.length === 5);
  seams.set({ statUid: () => 12345 });
  await assert.rejects(updateSettings((o) => { o.x = 1; return true; }, { io, yes: true }), { code: "settings_target_insecure" });
});

test("T-SET-13: concurrency, crash safety, detached writes, backups", async (t) => {
  await t.test("(2) foreign write before the re-hash → merged", async () => {
    sandbox(JSON.stringify({ a: 1 }));
    let fired = false;
    seams.set({ beforeRehash: () => { if (!fired) { fired = true; fs.writeFileSync(settingsPath(), JSON.stringify({ a: 1, foreign: true })); } } });
    await updateSettings(addRules, { io, yes: true });
    assert.equal(read().foreign, true);
    assert.equal(read().permissions.ask.length, 5);
  });
  await t.test("(3) absent file → created, no backup", async () => {
    const home = sandbox();
    await updateSettings(addRules, { io, yes: true });
    assert.deepEqual(Object.keys(read()), ["permissions"]);
    assert.equal(backups(home).length, 0);
  });
  await t.test("(4b) a writer that starts after the preflight refuses the commit; bytes unchanged, no backup, no temp", async () => {
    const home = sandbox(JSON.stringify({ a: 1 }));
    const before = fs.readFileSync(settingsPath());
    seams.set({ beforeRecheck: () => makeFakeBin(bin, "lsof", { "*": { stdout: "p4242\ncvim\n" } }) });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_open_elsewhere" });
    assert.deepEqual(fs.readFileSync(settingsPath()), before);
    assert.equal(backups(home).length, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(settingsPath())).filter((n) => n.endsWith(".tmp")), []);
  });
  await t.test("(4c) Claude starting after the preflight refuses the commit", async () => {
    sandbox(JSON.stringify({ a: 1 }));
    seams.set({ beforeRecheck: () => makeFakeBin(bin, "pgrep", { "*": { stdout: "999\n" } }) });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "claude_running" });
    assert.deepEqual(read(), { a: 1 });
  });
  await t.test("(4d) an inconclusive writer check fails closed: pgrep error, lsof error, lsof status 1 with output", async () => {
    for (const [tool, resp] of [["pgrep", { code: 3, stderr: "pgrep: bad" }], ["lsof", { code: 2, stderr: "lsof: denied" }], ["lsof", { code: 1, stdout: "p1\ncvim\n" }]]) {
      const home = sandbox(JSON.stringify({ a: 1 }));
      makeFakeBin(bin, tool, { "*": resp });
      await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_writer_check_failed" });
      assert.deepEqual(read(), { a: 1 });
      assert.equal(backups(home).length, 0);
    }
  });
  await t.test("(4e) the commit-boundary re-check also fails closed", async () => {
    sandbox(JSON.stringify({ a: 1 }));
    seams.set({ beforeRecheck: () => makeFakeBin(bin, "lsof", { "*": { code: 2 } }) });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_writer_check_failed" });
    assert.deepEqual(read(), { a: 1 });
  });
  await t.test("(4) Claude running → claude_running (non-TTY)", async () => {
    sandbox("{}");
    makeFakeBin(bin, "pgrep", { "*": { stdout: "123\n" } });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "claude_running" });
  });
  await t.test("(5) parent is Claude Code → claude_parent_process", async () => {
    sandbox("{}");
    process.env.CLAUDECODE = "1";
    try { await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "claude_parent_process" }); } finally { delete process.env.CLAUDECODE; }
  });
  await t.test("(5b) a process holds the file open → settings_open_elsewhere, message names the process only", async () => {
    sandbox("{}");
    makeFakeBin(bin, "lsof", { "*": { stdout: "p999\ncVim\n" } });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), (e) => e.code === "settings_open_elsewhere" && /Vim/.test(e.message) && !e.message.includes("/"));
  });
  await t.test("(5c) foreign write after our rename → redone on top, both present", async () => {
    sandbox("{}");
    let fired = false;
    seams.set({ afterRename: () => { if (!fired) { fired = true; const o = read(); fs.writeFileSync(settingsPath(), JSON.stringify({ late: true })); void o; } } });
    await updateSettings(addRules, { io, yes: true });
    assert.equal(read().late, true);
    assert.equal(read().permissions.ask.length, 5);
  });
  await t.test("(6) crash between temp write and rename → target byte-identical, temp cleaned next run", async () => {
    const home = sandbox('{"keep":1}');
    seams.set({ beforeRename: () => { throw new Error("crash"); } });
    await assert.rejects(updateSettings(addRules, { io, yes: true }));
    assert.equal(fs.readFileSync(settingsPath(), "utf8"), '{"keep":1}');
    seams.reset();
    await updateSettings(addRules, { io, yes: true });
    assert.deepEqual(fs.readdirSync(path.join(home, ".claude")).filter((n) => n.includes(".tmp")), []);
  });
  await t.test("(7) writes injected on every attempt → settings_concurrent_write after 3", async () => {
    sandbox("{}");
    let n = 0;
    seams.set({ beforeRehash: () => fs.writeFileSync(settingsPath(), JSON.stringify({ n: ++n })) });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_concurrent_write" });
    assert.equal(n, 3);
  });
  await t.test("(8a) descriptor opened before, written after rename → detached write kept + reported", async () => {
    const home = sandbox('{"a":1}');
    let fd;
    seams.set({ beforeLink: () => { fd = fs.openSync(settingsPath(), "r+"); }, afterRename: () => { fs.writeSync(fd, '{"a":2}', 0); fs.closeSync(fd); } });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_detached_write" });
    const [b] = backups(home);
    assert.match(fs.readFileSync(path.join(home, "state", "settings-backups", b), "utf8"), /"a":2/);
  });
  await t.test("(8b) modified backup survives pruning", async () => {
    const home = sandbox("{}");
    for (let i = 0; i < 7; i++) await updateSettings((o) => { o[`k${i}`] = i; return true; }, { io, yes: true });
    const dir = path.join(home, "state", "settings-backups");
    const all = fs.readdirSync(dir).sort();
    assert.equal(all.length, 5);
    fs.appendFileSync(path.join(dir, all[0]), " ");
    for (let i = 7; i < 12; i++) await updateSettings((o) => { o[`k${i}`] = i; return true; }, { io, yes: true });
    assert.ok(fs.readdirSync(dir).includes(all[0]), "a modified backup is never pruned");
  });
  await t.test("(9) backup privacy: 0700 dir, target mode unchanged", async () => {
    const home = sandbox(JSON.stringify({ env: { SECRET: "ENVSECRET" } }));
    fs.chmodSync(settingsPath(), 0o644);
    await updateSettings(addRules, { io, yes: true });
    assert.equal(fs.statSync(path.join(home, "state", "settings-backups")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o644);
  });
});

test("T-SET-8: env values never reach any output", async () => {
  sandbox(JSON.stringify({ env: { TOKEN: "ENVSECRET" } }));
  const seen = [];
  const cap = { ...io, err: (s) => seen.push(s), out: (s) => seen.push(s) };
  await updateSettings(addRules, { io: cap, yes: true, preview: true });
  assert.ok(!seen.join("").includes("ENVSECRET"));
});

test("T-SET-14: exactly the five strings; never permissions.allow; a similar string is untouched", async () => {
  sandbox(JSON.stringify({ permissions: { ask: ["Bash(*review-loop.off* )"] } }));
  await updateSettings(addRules, { io, yes: true });
  const o = read();
  assert.equal(o.permissions.ask.length, 6);
  assert.equal(o.permissions.allow, undefined);
});
```

- [ ] **Step 2: Implement `cli/lib/settings.mjs`**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { sha256hex } from "../../plugin/engine/lib/fsutil.mjs";
import { stateSubdir } from "../../plugin/engine/lib/paths.mjs";
import { CliError } from "./errors.mjs";

export const ASK_RULES = Object.freeze([
  "Bash(*review-loop.off*)",
  "Bash(*review-round.mjs decide*)",
  "Bash(*review-round.mjs override*)",
  "Bash(*review-round.mjs repin*)",
  "Edit(**/.claude/review-loop.off)"
]);
export const LEGACY_HOOK_RE = /review-loop\/review-gate-hook\.mjs/;
const MAX_ATTEMPTS = 3;
const KEEP_BACKUPS = 5;

/** Test-only interleaving points. Every seam is a no-op in production. */
const noop = () => {};
const defaults = { beforeRecheck: noop, beforeLink: noop, beforeRehash: noop, beforeRename: noop, afterRename: noop, statUid: (/** @type {fs.Stats} */ st) => st.uid };
let hooks = { ...defaults };
export const seams = { set: (/** @type {Partial<typeof defaults>} */ h) => { hooks = { ...hooks, ...h }; }, reset: () => { hooks = { ...defaults }; } };

const SETTINGS_MAX_BYTES = 1024 * 1024;

export function settingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(dir, "settings.json");
}

/** @returns {{ target: string, exists: boolean, base: string | null, bytes: Buffer | null, obj: Record<string, unknown> }} */
export function readSettings() {
  const link = settingsPath();
  let target = link;
  const lst = fs.lstatSync(link, { throwIfNoEntry: false });
  // Only a genuinely missing path is "absent". A dangling or unresolvable link is refused: renaming over it would
  // destroy the dotfile manager's link.
  if (lst === undefined) return { target, exists: false, base: null, bytes: null, obj: {} };
  if (lst.isSymbolicLink()) {
    try {
      target = fs.realpathSync(link);
    } catch {
      throw new CliError("settings_target_insecure", "settings.json is a symlink to a missing file; fix or remove the link, then re-run");
    }
  }
  // `target` is already the resolved real path, so O_NOFOLLOW only refuses a link swapped in after realpath.
  // The size is checked on the open descriptor BEFORE buffering (untrusted-io: bound before you buffer).
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    throw new CliError("settings_target_insecure", `${target} must be a regular file you own`);
  }
  let bytes;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (typeof process.getuid === "function" && hooks.statUid(st) !== process.getuid())) {
      throw new CliError("settings_target_insecure", `${target} must be a regular file you own`);
    }
    if (st.size > SETTINGS_MAX_BYTES) throw new CliError("settings_too_large", "settings.json is larger than 1 MiB; nothing was changed");
    bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, bytes, off, st.size - off, off); if (n === 0) break; off += n; }
    bytes = bytes.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new CliError("settings_invalid_json", "settings.json is not valid JSON; nothing was changed");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new CliError("settings_invalid_json", "settings.json must be a JSON object; nothing was changed");
  return { target, exists: true, base: sha256hex(bytes), bytes, obj };
}

/** No other settings writer may be active (spec §6.2 precondition). @param {import("./io.mjs").IO} io @param {{ yes: boolean }} opts @param {string} target */
/**
 * Fail closed: only each tool's documented "no match" result counts as "no writer". pgrep: 0 = matches, 1 = none.
 * lsof: 0 = holders listed, 1 with empty stdout = none. A spawn error (missing tool, timeout), any other status, or
 * lsof 1 WITH output is inconclusive → settings_writer_check_failed, and the commit does not happen.
 * @param {string} target @returns {{ running: boolean, names: string[] }} process NAMES only — never paths or content
 */
export function probeWriters(target) {
  const inconclusive = (/** @type {string} */ tool) => new CliError("settings_writer_check_failed", `could not check whether another program is using settings.json (${tool} failed); nothing was changed`);
  const pg = spawnSync("pgrep", ["-x", "claude"], { encoding: "utf8", timeout: 10_000 });
  if (pg.error || (pg.status !== 0 && pg.status !== 1)) throw inconclusive("pgrep");
  const running = pg.status === 0;
  if (!fs.existsSync(target)) return { running, names: [] };
  const ls = spawnSync("lsof", ["-F", "c", "--", target], { encoding: "utf8", timeout: 10_000 });
  if (ls.error || !(ls.status === 0 || (ls.status === 1 && ls.stdout.trim() === ""))) throw inconclusive("lsof");
  return { running, names: [...new Set(ls.stdout.split("\n").filter((l) => l.startsWith("c")).map((l) => l.slice(1)))] };
}

/** @param {{ running: boolean, names: string[] }} w */
function refuseWriters(w) {
  if (w.running) throw new CliError("claude_running", "quit all Claude Code sessions, then re-run");
  throw new CliError("settings_open_elsewhere", `close ${w.names.join(", ")} (it has settings.json open), then re-run`);
}

export async function writerPreconditions(io, opts, target) {
  if (process.env.CLAUDECODE === "1") throw new CliError("claude_parent_process", "run this in a separate terminal, not from inside Claude Code");
  for (;;) {
    const w = probeWriters(target);
    const { running, names } = w;
    if (!running && names.length === 0) return;
    if (!io.isTTY || opts.yes) refuseWriters(w);
    io.err(running
      ? "Quit all Claude Code sessions (they must restart to load the plugin anyway), and close any editor or sync tool with settings.json open.\n"
      : `Close ${names.join(", ")} — it has settings.json open.\n`);
    if (!(await io.ask("Done? Re-check now", true))) throw new CliError("cancelled", "cancelled");
  }
}

/**
 * The spec §6.2 commit. `mutate` edits the parsed object in place and returns whether it changed anything.
 * @param {(obj: Record<string, unknown>) => boolean} mutate
 * @param {{ io: import("./io.mjs").IO, yes: boolean, preview?: boolean, confirm?: () => Promise<void> }} opts
 * @returns {Promise<{ changed: boolean, backup: string | null }>}
 */
export async function updateSettings(mutate, opts) {
  let target = readSettings().target;
  await writerPreconditions(opts.io, opts, target);
  cleanTemps(path.dirname(target));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const cur = readSettings();
    target = cur.target;
    const obj = structuredClone(cur.obj);
    if (!mutate(obj)) return { changed: false, backup: null };
    if (opts.preview) opts.io.err(`review-loop will update: ${changedPaths(cur.obj, obj).join(", ")}\n`);
    // Asked once, only when something would change; a retry after a concurrent edit does not re-ask.
    if (opts.confirm && attempt === 1) await opts.confirm();
    const out = JSON.stringify(obj, null, 2) + "\n";
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.settings.json.review-loop-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
    const mode = cur.exists ? fs.statSync(target).mode & 0o777 : 0o600;
    const fd = fs.openSync(tmp, "wx", mode);
    try { fs.writeSync(fd, out); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, mode);

    /** @type {string | null} */
    let backup = null;
    try {
      // Spec §6.2: both checks again immediately before the backup/commit — a writer that started while we prepared
      // the replacement refuses the commit (the catch removes our temp; settings.json is untouched).
      hooks.beforeRecheck();
      const late = probeWriters(target);
      if (late.running || late.names.length > 0) refuseWriters(late);
      if (cur.exists) {
        hooks.beforeLink();
        const bdir = stateSubdir("settings-backups");
        backup = path.join(bdir, `settings.json.${new Date().toISOString().replace(/[:.]/g, "-")}-${/** @type {string} */ (cur.base).slice(0, 8)}`);
        try {
          fs.linkSync(target, backup);
        } catch (err) {
          if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EXDEV") throw err;
          fs.copyFileSync(target, backup);
          fs.chmodSync(backup, 0o600);
          opts.io.err("review-loop: settings.json is on another volume; its backup is a copy, so a late write through an already-open file would not be captured.\n");
        }
        hooks.beforeRehash();
        if (sha256hex(fs.readFileSync(backup)) !== cur.base) {
          fs.unlinkSync(backup); // Only a name: the inode is still linked at target.
          fs.rmSync(tmp, { force: true });
          continue;
        }
      } else {
        hooks.beforeRehash();
        if (fs.existsSync(target)) { fs.rmSync(tmp, { force: true }); continue; }
      }
      hooks.beforeRename();
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    hooks.afterRename();
    const now = fs.readFileSync(target, "utf8");
    if (backup && sha256hex(fs.readFileSync(backup)).slice(0, 8) !== /** @type {string} */ (cur.base).slice(0, 8)) {
      throw new CliError("settings_detached_write", `a program wrote to settings.json through an already-open file; its change is in ${backup} — compare it with settings.json and copy over anything you need`);
    }
    if (now !== out) continue;
    prune();
    return { changed: true, backup };
  }
  throw new CliError("settings_concurrent_write", "settings.json kept changing while review-loop wrote it; close other programs editing it, then re-run");
}

/** @param {Record<string, unknown>} before @param {Record<string, unknown>} after Paths only, never values: env must not leak. */
function changedPaths(before, after) {
  return Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => `settings.${k}`);
}

/** @param {string} dir */
function cleanTemps(dir) {
  try {
    for (const n of fs.readdirSync(dir)) if (/^\.settings\.json\.review-loop-\d+-[0-9a-f]{8}\.tmp$/.test(n)) fs.rmSync(path.join(dir, n), { force: true });
  } catch {
    // Directory absent: nothing to clean.
  }
}

function prune() {
  const dir = stateSubdir("settings-backups");
  const files = fs.readdirSync(dir).filter((n) => /^settings\.json\..+-[0-9a-f]{8}$/.test(n)).sort();
  const intact = files.filter((n) => sha256hex(fs.readFileSync(path.join(dir, n))).startsWith(n.slice(-8)));
  for (const n of intact.slice(0, Math.max(0, intact.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, n));
}
```

  **Check (5c) against step 4.** The test's `afterRename` writes `{late:true}`. `now !== out`, so the
  loop redoes the read-modify-write on top of `{late:true}` and adds the rules: both are present. The
  **backup** re-hash compares the backup's current hash prefix with `base`. The late write went to the
  *new* inode, not the backup, so no detached-write error fires. That is correct.

- [ ] **Step 3: Run the tests**

  Run: `(set -o pipefail; node --test test/cli/settings.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add cli/lib/settings.mjs test/cli/settings.test.mjs
git commit -m "feat(cli): settings.json writer with hard-link backups and writer preconditions"
```

**Gate:** sabotage, one at a time, each reverted.
- Remove the re-hash; (2) goes red.
- Replace `linkSync` with `copyFileSync`; (8a) goes red.
- Write the target in place; (6) goes red.
- Remove the `pgrep` check; (4) goes red.
- Remove the `lsof` check; (5b) goes red.
- Remove `now !== out`; (5c) goes red.
- Make prune ignore the hash; (8b) goes red.

---

### Task 17: Tool runner and preflight

**Files:**
- Create: `cli/lib/run.mjs`, `cli/lib/preflight.mjs`
- Test: `test/cli/preflight.test.mjs`

**Interfaces:**
- Produces:
  - `runTool(cmd, args, opts?): Promise<ToolResult>`, a thin wrapper over the engine's `run` (`proc.mjs`),
    where `ToolResult = {code:number|null, stdout:string, stderr:string, failure: null | "missing" | "timeout" | "output_too_large" | "spawn_failed"}`.
    `failure` is `null` exactly when the tool ran to completion. Callers never see a failure flattened
    into an empty "not installed";
  - `noteFor(r, ranButFailed): string`, the one place a failure becomes user text: "not installed",
    "timed out", "could not run (<class>)", or `ranButFailed`;
  - `requireRan(r, what)`, which throws `CliError("tool_failed", …, r.failure)` when `r.failure` is set;
  - `lastJsonLine(stdout): unknown | null` [RF-4];
  - `PREFLIGHT: Array<{id, label, required: boolean, check(): Promise<{status:"pass"|"fail"|"warn", note?:string}>, fix: {text:string, cmd?:[string,string[]], interactive?:boolean}}>`;
  - `runPreflight(io, ctx): Promise<boolean>`, where `true` means every required item passes.

- [ ] **Step 1: Write the failing tests**

```js
// test/cli/preflight.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:/usr/bin:/bin`;
const { lastJsonLine } = await import("../../cli/lib/run.mjs");
const { PREFLIGHT, runPreflight } = await import("../../cli/lib/preflight.mjs");

const healthy = () => {
  makeFakeBin(bin, "claude", { "--version": { stdout: "2.1.284 (Claude Code)\n" }, "plugin list --json": { stdout: JSON.stringify([{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }]) } });
  makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in using ChatGPT\n" } });
  makeFakeBin(bin, "gh", { "auth status": { stdout: "Logged in\n" } });
};
const io = (answers = []) => ({ isTTY: true, color: false, out: () => {}, lines: [], err(s) { this.lines.push(s); }, ask: async () => answers.shift() ?? false, choose: async (_q, _o, d) => d, env: process.env });

test("[RF-4] lastJsonLine takes the last parseable object line", () => {
  assert.deepEqual(lastJsonLine('warning: x\n{"a":1}\n{"b":2}\n'), { b: 2 });
  assert.equal(lastJsonLine("no json here\n"), null);
});

test("T-SET-3: five items, all OK when healthy", async () => {
  healthy();
  assert.deepEqual(PREFLIGHT.map((p) => p.id), ["claude", "codex_cli", "codex_auth", "codex_plugin", "gh"]);
  const o = io();
  assert.equal(await runPreflight(o, { yes: false }), true);
  assert.equal(o.lines.join("").match(/OK/g).length, 5);
});

test("T-SET-3 (−): each broken item shows FAIL, offers its exact fix, re-checks after the fix", async () => {
  healthy();
  const codex = makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { code: 1, stdout: "Not logged in\n" }, login: { code: 0 } });
  const o = io([true]);
  let calls = 0;
  const orig = PREFLIGHT.find((p) => p.id === "codex_auth").check;
  PREFLIGHT.find((p) => p.id === "codex_auth").check = async () => (++calls === 1 ? orig() : { status: "pass" });
  try {
    assert.equal(await runPreflight(o, { yes: false }), true);
  } finally { PREFLIGHT.find((p) => p.id === "codex_auth").check = orig; }
  assert.match(o.lines.join(""), /FAIL.*Codex sign-in/);
  assert.match(o.lines.join(""), /codex login/);
  assert.ok(codex.log().some((a) => a[0] === "login"), "the fix ran");
  assert.equal(calls, 2, "re-checked");
});

test("T-SET-4: gh missing → WARN only, preflight still passes", async () => {
  healthy();
  makeFakeBin(bin, "gh", { "*": { code: 127 } });
  const o = io();
  assert.equal(await runPreflight(o, { yes: false }), true);
  assert.match(o.lines.join(""), /WARN.*gh/);
});

test("[RF-4] claude plugin list with warning lines before the JSON still parses", async () => {
  healthy();
  makeFakeBin(bin, "claude", { "--version": { stdout: "2.1.284 (Claude Code)\n" }, "plugin list --json": { stdout: "Warning: marketplace cache stale\n" + JSON.stringify([{ id: "codex@openai-codex", enabled: true, scope: "user" }]) + "\n" } });
  const r = await PREFLIGHT.find((p) => p.id === "codex_plugin").check();
  assert.equal(r.status, "pass");
});

test("runTool keeps the failure class", async () => {
  const { runTool } = await import("../../cli/lib/run.mjs");
  assert.equal((await runTool("rl-definitely-missing-xyz", [])).failure, "missing");
  assert.equal((await runTool(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 200 })).failure, "timeout");
  assert.equal((await runTool(process.execPath, ["-e", "process.stdout.write('x'.repeat(17 * 1024 * 1024))"])).failure, "output_too_large");
  const ran = await runTool(process.execPath, ["-e", "process.exit(3)"]);
  assert.deepEqual([ran.failure, ran.code], [null, 3]);
});

test("noteFor distinguishes a timeout from a missing tool", async () => {
  const { noteFor } = await import("../../cli/lib/run.mjs");
  assert.equal(noteFor({ code: null, stdout: "", stderr: "", failure: "missing" }, "x"), "not installed");
  assert.match(noteFor({ code: null, stdout: "", stderr: "", failure: "timeout" }, "x"), /^timed out/);
  assert.equal(noteFor({ code: null, stdout: "", stderr: "", failure: "output_too_large" }, "x"), "could not run (output_too_large)");
  assert.equal(noteFor({ code: 1, stdout: "", stderr: "", failure: null }, "not signed in"), "not signed in");
});

test("requireRan: a failed claude plugin list is tool_failed, never an empty plugin list", async () => {
  const { requireRan } = await import("../../cli/lib/run.mjs");
  assert.throws(() => requireRan({ code: null, stdout: "", stderr: "", failure: "timeout" }, "claude plugin list"), { code: "tool_failed", detail: "timeout" });
  assert.doesNotThrow(() => requireRan({ code: 0, stdout: "[]", stderr: "", failure: null }, "claude plugin list"));
});
```

- [ ] **Step 2: Implement `cli/lib/run.mjs`**

```js
import { run } from "../../plugin/engine/lib/proc.mjs";
import { CliError } from "./errors.mjs";

/** @param {string} cmd @param {string[]} args @param {{ timeoutMs?: number, stdio?: "inherit" }} [opts] @returns {Promise<ToolResult>} */
export async function runTool(cmd, args, opts = {}) {
  if (opts.stdio === "inherit") {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    const errno = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code;
    return { code: r.status, stdout: "", stderr: "", failure: errno === undefined ? null : errno === "ENOENT" ? "missing" : "spawn_failed" };
  }
  try {
    const r = await run(cmd, args, { timeoutMs: opts.timeoutMs ?? 30_000 });
    return { code: r.timedOut ? null : r.code, stdout: r.stdout, stderr: r.stderr, failure: r.timedOut ? "timeout" : null };
  } catch (err) {
    // proc.run rejects only with ReviewLoopError: spawn_failed (message carries the errno) or output_too_large.
    const code = err && typeof err === "object" && "code" in err ? err.code : null;
    const msg = err instanceof Error ? err.message : "";
    /** @type {ToolFailure} */
    const failure = code === "output_too_large" ? "output_too_large" : code === "spawn_failed" && /ENOENT/.test(msg) ? "missing" : "spawn_failed";
    return { code: null, stdout: "", stderr: "", failure };
  }
}

/** @typedef {"missing" | "timeout" | "output_too_large" | "spawn_failed"} ToolFailure */
/** @typedef {{ code: number | null, stdout: string, stderr: string, failure: ToolFailure | null }} ToolResult */

/** The single mapping from a tool outcome to user-facing text. @param {ToolResult} r @param {string} ranButFailed */
export function noteFor(r, ranButFailed) {
  if (r.failure === "missing" || r.code === 127) return "not installed";
  if (r.failure === "timeout") return "timed out — check your network or VPN, then re-run";
  if (r.failure) return `could not run (${r.failure})`;
  return ranButFailed;
}

/** Callers that parse output must not mistake a failed run for an empty answer. @param {ToolResult} r @param {string} what */
export function requireRan(r, what) {
  if (r.failure) throw new CliError("tool_failed", `${what}: ${r.failure === "missing" ? "not installed" : r.failure}`, r.failure);
}

/** CLIs print warnings before their --json result: take the last line that parses as an object. @param {string} stdout */
export function lastJsonLine(stdout) {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (typeof v === "object" && v !== null) return v;
    } catch {
      // Not the JSON line.
    }
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
```

  Check `proc.mjs`'s `run` result field names (`code`, `stdout`, `stderr`, `timedOut`) at
  `plugin/engine/lib/proc.mjs:70` before relying on them.

- [ ] **Step 3: Implement `cli/lib/preflight.mjs`**

```js
import { mark } from "./io.mjs";
import { lastJsonLine, noteFor, requireRan, runTool } from "./run.mjs";

export const MIN_CLAUDE = "2.1.0"; // Raise to the version P1–P5 ran on (CLAUDE.md Probes) at Task 17 commit time.

/** @param {string} a @param {string} b */
const gte = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); } return true; };

/** @param {string} id */
async function pluginEnabled(id) {
  const r = await runTool("claude", ["plugin", "list", "--json"]);
  requireRan(r, "claude plugin list");
  const v = lastJsonLine(r.stdout);
  const list = Array.isArray(v) ? v : Array.isArray(/** @type {{ plugins?: unknown }} */ (v)?.plugins) ? /** @type {{ plugins: unknown[] }} */ (v).plugins : [];
  return list.some((p) => typeof p === "object" && p !== null && (/** @type {Record<string, unknown>} */ (p).id === id || /** @type {Record<string, unknown>} */ (p).name === id) && /** @type {Record<string, unknown>} */ (p).enabled !== false);
}

export const PREFLIGHT = [
  { id: "claude", label: "Claude Code", required: true,
    async check() { const r = await runTool("claude", ["--version"]); const v = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1]; return !v ? { status: "fail", note: noteFor(r, "unexpected --version output") } : gte(v, MIN_CLAUDE) ? { status: "pass", note: v } : { status: "fail", note: `${v} is older than ${MIN_CLAUDE}` }; },
    fix: { text: "brew install --cask claude-code   (or: claude update)", cmd: ["brew", ["install", "--cask", "claude-code"]] } },
  { id: "codex_cli", label: "Codex CLI", required: true,
    async check() { const r = await runTool("codex", ["--version"]); return r.code === 0 ? { status: "pass", note: r.stdout.trim() } : { status: "fail", note: noteFor(r, "not working") }; },
    fix: { text: "brew install --cask codex", cmd: ["brew", ["install", "--cask", "codex"]] } },
  { id: "codex_auth", label: "Codex sign-in", required: true,
    async check() { const r = await runTool("codex", ["login", "status"]); return r.code === 0 && !/not logged in/i.test(r.stdout) ? { status: "pass" } : { status: "fail", note: noteFor(r, "not signed in") }; },
    fix: { text: "codex login", cmd: ["codex", ["login"]], interactive: true } },
  { id: "codex_plugin", label: "Codex plugin for Claude Code", required: true,
    async check() { return (await pluginEnabled("codex@openai-codex")) ? { status: "pass" } : { status: "fail", note: "not installed" }; },
    fix: { text: "claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex --scope user", cmd: ["sh", ["-c", "claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex --scope user"]] } },
  { id: "gh", label: "GitHub CLI (optional — PR checks and approval marks)", required: false,
    async check() { const r = await runTool("gh", ["auth", "status"]); return r.code === 0 ? { status: "pass" } : { status: "warn", note: noteFor(r, "not signed in") }; },
    fix: { text: "brew install gh && gh auth login" } }
];

/** @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
export async function runPreflight(io, ctx) {
  let ok = true;
  for (const item of PREFLIGHT) {
    let r = await item.check();
    io.err(`${mark(r.status, io.color)}  ${item.label}${r.note ? ` — ${r.note}` : ""}\n`);
    if (r.status === "fail" && item.required) {
      io.err(`      Fix: ${item.fix.text}\n`);
      if (item.fix.cmd && (ctx.yes || (io.isTTY && (await io.ask(`Run that now?`, true))))) {
        await runTool(item.fix.cmd[0], item.fix.cmd[1], item.fix.interactive ? { stdio: "inherit" } : { timeoutMs: 10 * 60_000 });
        r = await item.check();
        io.err(`${mark(r.status, io.color)}  ${item.label} (re-checked)\n`);
      }
      if (r.status === "fail") ok = false;
    } else if (r.status === "warn") {
      io.err(`      Optional: ${item.fix.text}\n`);
    }
  }
  return ok;
}
```

  Verify each fix command with `--help` before committing (`brew install --help`,
  `claude plugin marketplace add --help`, `claude plugin install --help`), per `ci-deploy-patterns`.
  They were verified at spec time on 2026-09-28. Set `MIN_CLAUDE` to the `claude --version` recorded
  in the P1 evidence.

- [ ] **Step 4: Run and commit**

  Run: `(set -o pipefail; node --test test/cli/preflight.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

```bash
git add cli/lib/run.mjs cli/lib/preflight.mjs test/cli/preflight.test.mjs
git commit -m "feat(cli): tool runner and five-item preflight with fix-and-recheck"
```

**Gate:** sabotage. Make the re-check a no-op; the T-SET-3 (−) `calls === 2` assertion goes red. Revert.

---
### Task 18: `setup` (steps 1–8) and the live check

**Files:**
- Create: `cli/lib/plugin.mjs` (plugin install/list/engine path), `cli/lib/livecheck.mjs`, `cli/fixtures/livecheck-doc.md`
- Modify: `cli/lib/setup.mjs` (replace the Task 15 stub)
- Test: `test/cli/setup.test.mjs`, `test/cli/livecheck.test.mjs`

**Interfaces:**
- Consumes: `runPreflight` (Task 17); `updateSettings`, `ASK_RULES` (Task 16); `readConfig`,
  `writeConfig`, `PRESET_NAMES`, `EFFORTS`, `MODEL_RE` (Task 6); `codexDefaults` (Task 10); `writePin`,
  `verifyPin`, `latestInstalledVersion` (`pin.mjs`); `lastJsonLine`, `runTool` (Task 17).
- Produces:
  - from `plugin.mjs`: `MARKETPLACE_SOURCE = "<owner>/review-loop"`, `PLUGIN_ID = "review-loop@review-loop"`,
    `installedPlugin(id): Promise<{version, installPath, enabled} | null>`,
    `installPlugin(): Promise<void>`, `enginePath(): Promise<string | null>`;
  - from `livecheck.mjs`: `liveCheck(io): Promise<{ok:true} | {ok:false, detail: LiveDetail, text: string}>`
    and `classify(text: string): LiveDetail`;
  - `run(args, io, ctx)` for `setup`, with the flags
    `--yes --preset <p> --model <m> --effort <e> --skip-live-check`.

**Invariants (§6.4):**
- Every step checks real state first, acts only if needed, and re-verifies. A re-run converges.
- A cancel (`n`) at a mutating step → `CliError("cancelled")`, exit 3. The summary lists which steps
  are done and which are not.
- The live check uses a **temp** state dir and repo, plus the **real** pin file. Codex output text is
  printed to the terminal only, never to events.
- `--skip-live-check` → `code:"setup_complete_unverified"`, exit 0.

- [ ] **Step 1: Write the fixture `cli/fixtures/livecheck-doc.md`**

```markdown
# Live check

This is a tiny document used by `review-loop setup` to prove Claude Code → review-loop → Codex works.
It deliberately has one obvious issue: it claims to be complete but has no acceptance criteria.
```

- [ ] **Step 2: Write the failing tests**

```js
// test/cli/livecheck.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../../cli/lib/livecheck.mjs";

test("T-SET-6: each failure class maps to its detail; unknown → unknown", () => {
  assert.equal(classify("spawn codex ENOENT"), "codex_missing");
  assert.equal(classify("Error: Not logged in. Run codex login"), "codex_auth");
  assert.equal(classify("401 Unauthorized"), "codex_auth");
  assert.equal(classify("model 'not-a-real-model' does not exist or you do not have access"), "model_invalid");
  assert.equal(classify("unknown variant `turbo`, expected one of minimal, low, medium, high for model_reasoning_effort"), "effort_invalid");
  assert.equal(classify("[plugin_pin_mismatch] companion changed"), "pin_mismatch");
  assert.equal(classify("[codex_timeout] exceeded 15 minutes"), "timeout");
  assert.equal(classify("[codex_output_invalid] could not parse"), "unparseable");
  assert.equal(classify("something new"), "unknown");
});
```

  🖊 Paste any real Codex error lines the author has seen (spec §11.1, T-SET-6) as extra
  `assert.equal(classify(<line>), <detail>)` rows.

```js
// test/cli/setup.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.REVIEW_LOOP_TEST_SEAMS = "1";
delete process.env.CLAUDECODE;
const { main } = await import("../../cli/review-loop.mjs");

function sandbox({ pluginInstalled = false } = {}) {
  const home = tmpDir();
  Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"), CODEX_HOME: path.join(home, "codex") });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "codex"));
  fs.writeFileSync(path.join(home, "codex", "config.toml"), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
  const list = [{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }];
  if (pluginInstalled) list.push({ id: "review-loop@review-loop", enabled: true, scope: "user", version: "0.1.0", installPath: path.join(process.cwd(), "plugin") });
  const claude = makeFakeBin(bin, "claude", {
    "--version": { stdout: "2.1.284 (Claude Code)\n" }, "plugin list --json": { stdout: JSON.stringify(list) },
    "*": { stdout: "{}\n" }
  });
  makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in\n" } });
  makeFakeBin(bin, "gh", { "auth status": { stdout: "ok\n" } });
  makeFakeBin(bin, "pgrep", { "*": { code: 1 } });
  makeFakeBin(bin, "lsof", { "*": { code: 1 } });
  return { home, claude };
}
const io = (answers) => ({ isTTY: true, color: false, lines: [], out() {}, err(s) { this.lines.push(s); }, ask: async () => answers.shift() ?? true, choose: async (_q, _o, d) => d, env: process.env });

test("T-SET-1: every mutating step prints what/why before asking; 'n' at the plugin step → exit 3, no install", async () => {
  const s = sandbox();
  const o = io([true, true, false]);
  const code = await main(["setup", "--skip-live-check"], o);
  assert.equal(code, 3);
  const text = o.lines.join("");
  assert.match(text, /Will: install the review-loop plugin[\s\S]*Why:/);
  assert.ok(!s.claude.log().some((a) => a[0] === "plugin" && a[1] === "install"));
  assert.match(text, /Done: preflight, preset, model\/effort[\s\S]*Not done: plugin/);
});

test("T-SET-5: a re-run after a failure converges without duplicate installs", async () => {
  const s = sandbox({ pluginInstalled: true });
  const code = await main(["setup", "--yes", "--skip-live-check"], io([]));
  assert.equal(code, 0);
  assert.ok(!s.claude.log().some((a) => a[0] === "plugin" && a[1] === "install"), "already installed → not reinstalled");
  const settings = JSON.parse(fs.readFileSync(path.join(s.home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.permissions.ask.length, 5);
});

test("T-SET-7: --skip-live-check → setup_complete_unverified, exit 0, summary says not verified", async () => {
  sandbox({ pluginInstalled: true });
  const o = io([]);
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], o), 0);
  assert.match(o.lines.join(""), /not verified/i);
  const ev = fs.readFileSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.equal(ev.code, "setup_complete_unverified");
});

test("T-CFG-6: setup never writes under CODEX_HOME", async () => {
  const s = sandbox({ pluginInstalled: true });
  const before = fs.readFileSync(path.join(s.home, "codex", "config.toml"));
  await main(["setup", "--yes", "--model", "m1", "--effort", "low", "--skip-live-check"], io([]));
  assert.deepEqual(fs.readFileSync(path.join(s.home, "codex", "config.toml")), before);
  assert.deepEqual(fs.readdirSync(path.join(s.home, "codex")), ["config.toml"]);
});
```

- [ ] **Step 3: Implement `cli/lib/plugin.mjs`**

```js
import { lastJsonLine, requireRan, runTool } from "./run.mjs";
import { CliError } from "./errors.mjs";

export const MARKETPLACE_SOURCE = "<owner>/review-loop";
export const MARKETPLACE_NAME = "review-loop";
export const PLUGIN_ID = "review-loop@review-loop";

/** @param {string} id */
export async function installedPlugin(id) {
  const r = await runTool("claude", ["plugin", "list", "--json"]);
  requireRan(r, "claude plugin list");
  const v = lastJsonLine(r.stdout);
  const list = Array.isArray(v) ? v : Array.isArray(/** @type {{ plugins?: unknown[] }} */ (v)?.plugins) ? /** @type {{ plugins: unknown[] }} */ (v).plugins : null;
  if (list === null) throw new CliError("claude_cli_unparseable", "could not read `claude plugin list --json`");
  for (const p of list) {
    if (typeof p !== "object" || p === null) continue;
    const e = /** @type {Record<string, unknown>} */ (p);
    if (e.id === id || e.name === id) return { version: typeof e.version === "string" ? e.version : null, installPath: typeof e.installPath === "string" ? e.installPath : null, enabled: e.enabled !== false, scope: typeof e.scope === "string" ? e.scope : null };
  }
  return null;
}

export async function installPlugin() {
  const add = await runTool("claude", ["plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
  if (add.code !== 0 && !/already/i.test(add.stderr + add.stdout)) throw new CliError("plugin_install_failed", "could not add the review-loop marketplace");
  const inst = await runTool("claude", ["plugin", "install", PLUGIN_ID, "--scope", "user", "--json"], { timeoutMs: 5 * 60_000 });
  requireRan(inst, "claude plugin install");
  if (inst.code !== 0) throw new CliError("plugin_install_failed", "claude plugin install failed");
}

export async function enginePath() {
  const p = await installedPlugin(PLUGIN_ID);
  return p?.installPath ? `${p.installPath}/engine` : null;
}
```

  `MARKETPLACE_SOURCE` keeps the literal `<owner>` until Task 28 replaces it with D1.

- [ ] **Step 4: Implement `cli/lib/livecheck.mjs`**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pinFile } from "../../plugin/engine/lib/pin.mjs";
import { enginePath } from "./plugin.mjs";

/** @typedef {"codex_missing" | "codex_auth" | "plugin_missing" | "pin_mismatch" | "model_invalid" | "effort_invalid" | "timeout" | "unparseable" | "unknown"} LiveDetail */

const PATTERNS = /** @type {Array<[RegExp, LiveDetail]>} */ ([
  [/ENOENT|codex: command not found/i, "codex_missing"],
  [/not logged in|codex login|401|unauthori[sz]ed/i, "codex_auth"],
  [/plugin_pin_mismatch|companion_(contract|usage)_mismatch/, "pin_mismatch"],
  [/reasoning[_ ]effort|unknown variant .* effort/i, "effort_invalid"],
  [/model .*(does not exist|not found|not supported|unknown)|invalid model/i, "model_invalid"],
  [/codex_timeout|timed out/i, "timeout"],
  [/codex_output_invalid|could not parse/i, "unparseable"]
]);

/** @param {string} text */
export function classify(text) {
  for (const [re, d] of PATTERNS) if (re.test(text)) return d;
  return "unknown";
}

/** A real round on a tiny fixture in a temp repo and temp state (the user's history stays clean), with the real pin. */
export async function liveCheck() {
  const engine = await enginePath();
  if (!engine) return { ok: false, detail: /** @type {LiveDetail} */ ("plugin_missing"), text: "review-loop plugin not installed" };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rl-live-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "rl-live-state-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const doc = path.join(repo, "docs", "specs", "livecheck-design.md");
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../fixtures/livecheck-doc.md", import.meta.url)), doc);
    const r = spawnSync(process.execPath, [path.join(engine, "review-round.mjs"), "run", "--kind", "spec", "--path", doc, "--project-root", repo], {
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: state, REVIEW_LOOP_PIN_FILE: pinFile() }, encoding: "utf8", timeout: 15 * 60_000
    });
    if (r.status === 0 || r.status === 10) return { ok: true };
    const text = `${r.stdout}\n${r.stderr}${r.error ? `\n${r.error.message}` : ""}`;
    return { ok: false, detail: r.status === 40 ? "pin_mismatch" : r.error && /ETIMEDOUT/.test(String(r.error)) ? "timeout" : classify(text), text };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
}
```

  **Exit 10 (needs fixes) counts as a live-check pass.** The check proves the chain works; the fixture
  deliberately has a finding.

- [ ] **Step 5: Implement `cli/lib/setup.mjs`**

```js
import { CliError } from "./errors.mjs";
import { runPreflight } from "./preflight.mjs";
import { installedPlugin, installPlugin, PLUGIN_ID } from "./plugin.mjs";
import { liveCheck } from "./livecheck.mjs";
import { ASK_RULES, updateSettings } from "./settings.mjs";
import { readConfig, writeConfig, PRESET_NAMES, EFFORTS, MODEL_RE } from "../../plugin/engine/lib/config.mjs";
import { codexDefaults } from "../../plugin/engine/lib/codexcfg.mjs";
import { latestInstalledVersion, readPin, writePin, verifyPin } from "../../plugin/engine/lib/pin.mjs";
import { PACKAGE_VERSION } from "../../plugin/engine/lib/events.mjs";

const PRESET_COPY = {
  default: "Claude can't finish, or open a PR, until Codex approves the change. Recommended.",
  balanced: "Claude is reminded to get Codex review, and PRs still require approval.",
  advisory: "Reviews run when Claude chooses to. You get reminders, nothing is blocked — including merges of unreviewed PRs, unless your repo requires the review-loop check."
};

/** @param {string[]} args @param {string} name */
const flag = (args, name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null; };

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
export async function run(args, io, ctx) {
  if (process.env.REVIEW_LOOP_TEST_SEAMS === "1" && process.env.REVIEW_LOOP_TEST_WAIT_BEFORE_PROMPT) await new Promise((r) => setTimeout(r, 5000));
  if (!io.isTTY && !ctx.yes) throw new CliError("usage_noninteractive", "setup needs a terminal, or --yes");
  const done = /** @type {string[]} */ ([]);
  const steps = ["preflight", "preset", "model/effort", "plugin", "approval rules", "pin", "live check"];
  const confirm = async (/** @type {string} */ will, /** @type {string} */ why) => {
    io.err(`\nWill: ${will}\nWhy:  ${why}\n`);
    if (ctx.yes) return;
    if (!(await io.ask("Go ahead?", true))) {
      io.err(`\nDone: ${done.join(", ") || "nothing"}\nNot done: ${steps.filter((s) => !done.includes(s)).join(", ")}\nRe-run \`review-loop setup\` any time; finished steps are kept.\n`);
      throw new CliError("cancelled", "cancelled");
    }
  };

  // 1 preflight
  if (!(await runPreflight(io, ctx))) throw new CliError("preflight_failed", "a required tool is missing or signed out");
  done.push("preflight");

  // 2 preset
  const cfg = readConfig().config;
  const wantPreset = flag(args, "--preset") ?? (ctx.yes ? cfg.preset : await io.choose(`Preset?\n  default:  ${PRESET_COPY.default}\n  balanced: ${PRESET_COPY.balanced}\n  advisory: ${PRESET_COPY.advisory}\n`, [...PRESET_NAMES], cfg.preset));
  if (!PRESET_NAMES.includes(/** @type {typeof PRESET_NAMES[number]} */ (wantPreset))) throw new CliError("usage_bad_flag", `--preset must be one of ${PRESET_NAMES.join(", ")}`);
  done.push("preset");

  // 3 model/effort (inherit = null; Codex's own config is read, never written)
  const d = codexDefaults();
  const model = flag(args, "--model") ?? cfg.codex.model;
  const effort = flag(args, "--effort") ?? cfg.codex.effort;
  if (model !== null && !MODEL_RE.test(model)) throw new CliError("usage_bad_flag", "--model: letters, digits and . _ : / - only (max 64)");
  if (effort !== null && !EFFORTS.includes(effort)) throw new CliError("usage_bad_flag", `--effort must be one of ${EFFORTS.join(", ")}`);
  io.err(`Codex model/effort: ${model ?? `inherit (Codex currently: ${d.model ?? "its default"})`} / ${effort ?? `inherit (${d.effort ?? "its default"})`}\n`);
  const next = { ...cfg, preset: /** @type {typeof cfg.preset} */ (wantPreset), codex: { model, effort } };
  if (JSON.stringify(next) !== JSON.stringify(cfg)) {
    await confirm(`save preset "${wantPreset}" and model/effort to review-loop's config`, "so every review uses these settings");
    writeConfig(next);
  }
  done.push("model/effort");

  // 4 plugin
  const existing = await installedPlugin(PLUGIN_ID);
  if (!existing || !existing.enabled) {
    await confirm("install the review-loop plugin into Claude Code (user scope)", "the plugin carries the hooks that enforce review");
    await installPlugin();
  }
  const installed = await installedPlugin(PLUGIN_ID);
  if (!installed) throw new CliError("plugin_install_failed", "the plugin is not listed after install");
  if (installed.version && installed.version.split(".").slice(0, 2).join(".") !== PACKAGE_VERSION.split(".").slice(0, 2).join(".")) io.err(`Note: plugin ${installed.version} vs CLI ${PACKAGE_VERSION} — run \`review-loop update\`\n`);
  done.push("plugin");

  // 5 approval rules
  await updateSettings((o) => {
    const perms = /** @type {Record<string, unknown>} */ (o.permissions ??= {});
    const ask = /** @type {string[]} */ (Array.isArray(perms.ask) ? perms.ask : (perms.ask = []));
    const missing = ASK_RULES.filter((r) => !ask.includes(r));
    ask.push(...missing);
    return missing.length > 0;
  }, { io, yes: ctx.yes, preview: true, confirm: () => confirm("add 5 approval rules to ~/.claude/settings.json (a backup is kept)", "so overrides and the kill switch always ask you first") });
  done.push("approval rules");

  // 6 pin
  const pin = readPin();
  const version = latestInstalledVersion();
  if (!pin || !verifyPin().ok) {
    await confirm(`pin Codex plugin ${version}`, "so a silent Codex plugin change pages you instead of changing reviews");
    writePin(version);
  }
  done.push("pin");

  // 7 live check
  if (args.includes("--skip-live-check")) {
    io.err("\nSetup complete — NOT verified (live check skipped). Run `review-loop doctor --live` to verify.\nRestart Claude Code to load the plugin.\n");
    return { code: "setup_complete_unverified" };
  }
  await confirm("run one real Codex review (usually 2–8 minutes)", "billed to your OpenAI/ChatGPT account; reviews send changed files and repo context to OpenAI under your account");
  const live = await liveCheck();
  if (!live.ok) {
    io.err(`\nLive check failed (${live.detail}).\n${live.text.slice(-2000)}\n`);
    throw new CliError("live_check_failed", "the live Codex review failed", live.detail);
  }
  done.push("live check");
  io.err("\nSetup complete and verified. Restart Claude Code to load the plugin.\n");
  return { code: "ok" };
}
```

  **Two supporting changes are required:**
  - **`updateSettings`'s optional `confirm` callback** (Task 16) is called after `mutate` returns
    `true` and before the temp write, so nothing is asked when nothing would change. A cancel throws
    `CliError("cancelled")` from inside it, before any byte is written.
  - **Check the `pin.mjs` signatures** at `plugin/engine/lib/pin.mjs:75,80,115,130`
    (`readPin()`, `latestInstalledVersion()`, `writePin(version, expected)`, `verifyPin()` and what
    `verifyPin` returns) before relying on `.ok`. If `verifyPin` throws on a mismatch instead, wrap it:
    `const pinned = (() => { try { verifyPin(); return true; } catch { return false; } })();`.

- [ ] **Step 6: Run and commit**

  Run: `(set -o pipefail; node --test test/cli/ && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

```bash
git add -A cli test
git commit -m "feat(cli): guided setup with idempotent steps and a classified live check"
```

**Gate:** sabotage. Skip the "check first" in step 4 (always install); T-SET-5 sees `plugin install`
in the argv log → red. Revert.

---

### Task 19: `config` command

**Files:**
- Modify: `cli/lib/configcmd.mjs` (replace the stub)
- Test: `test/cli/config.test.mjs`

**Interfaces:**
- Produces `run(args, io, ctx)` for:
  - `show [--json]`, which prints the effective values and their source;
  - `set preset|model|effort|rubric|events.path <value|inherit|default>`;
  - `repair`, which quarantines an invalid config to `config.json.corrupt-<ts>` and writes the default.

**Invariants:**
- `set` validates with `isConfig` before writing.
- `set rubric <path>` checks the file loads via `loadRubricSection(path)`, and prints the §7.1
  policy-change note: "Approvals given earlier stay valid; re-run the loop on an open PR to review it
  under the new rubric."
- `set model|effort` never touches `$CODEX_HOME`.

- [ ] **Step 1: Write the failing tests**

```js
// test/cli/config.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
const { main } = await import("../../cli/review-loop.mjs");
const io = () => ({ isTTY: false, color: false, lines: [], outs: [], out(s) { this.outs.push(s); }, err(s) { this.lines.push(s); }, ask: async () => true, choose: async (_q, _o, d) => d, env: process.env });
function sandbox() { const h = tmpDir(); Object.assign(process.env, { HOME: h, REVIEW_LOOP_STATE_DIR: path.join(h, "state"), REVIEW_LOOP_CONFIG: path.join(h, "cfg", "config.json") }); return h; }

test("T-CFG-5: set validates; show reports source", async () => {
  sandbox();
  assert.equal(await main(["config", "set", "preset", "balanced"], io()), 0);
  assert.equal(await main(["config", "set", "effort", "turbo"], io()), 2);
  assert.equal(await main(["config", "set", "model", "gpt 5"], io()), 2);
  assert.equal(await main(["config", "set", "model", "inherit"], io()), 0);
  const o = io();
  assert.equal(await main(["config", "show", "--json"], o), 0);
  const shown = JSON.parse(o.outs.join(""));
  assert.equal(shown.preset, "balanced");
  assert.equal(shown.codex.model, null);
});

test("T-PR-13: set rubric prints the approvals-stay-valid note", async () => {
  const h = sandbox();
  const r = path.join(h, "r.md");
  fs.copyFileSync(new URL("../../plugin/rubric/default.md", import.meta.url), r);
  const o = io();
  assert.equal(await main(["config", "set", "rubric", r], o), 0);
  assert.match(o.lines.join(""), /Approvals given earlier stay valid/);
});

test("repair quarantines and resets", async () => {
  sandbox();
  fs.mkdirSync(path.dirname(process.env.REVIEW_LOOP_CONFIG), { recursive: true });
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, "{bad");
  assert.equal(await main(["config", "repair"], io()), 0);
  const names = fs.readdirSync(path.dirname(process.env.REVIEW_LOOP_CONFIG));
  assert.ok(names.some((n) => n.startsWith("config.json.corrupt-")));
  assert.equal(JSON.parse(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8")).preset, "default");
});
```

- [ ] **Step 2: Implement `cli/lib/configcmd.mjs`**

```js
import fs from "node:fs";
import { CliError } from "./errors.mjs";
import { configPath, defaultConfig, isConfig, readConfig, writeConfig } from "../../plugin/engine/lib/config.mjs";
import { codexDefaults } from "../../plugin/engine/lib/codexcfg.mjs";
import { loadRubricSection } from "../../plugin/engine/lib/rubric.mjs";

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ json: boolean }} ctx */
export async function run(args, io, ctx) {
  const [sub, key, raw] = args;
  if (sub === "show" || sub === undefined) {
    const r = readConfig();
    const d = codexDefaults();
    const view = { ...r.config, status: r.status, codexInherited: d };
    if (ctx.json) return { code: "ok", json: view };
    io.err(`preset: ${r.config.preset}\nmodel:  ${r.config.codex.model ?? `inherit (${d.model ?? "Codex default"})`}\neffort: ${r.config.codex.effort ?? `inherit (${d.effort ?? "Codex default"})`}\nrubric: ${r.config.rubricPath ?? "built-in"}\nevents: ${r.config.events.path ?? "default"}\nfile:   ${configPath()} (${r.status})\n`);
    return { code: "ok" };
  }
  if (sub === "repair") {
    const r = readConfig();
    if (r.status === "invalid" && fs.existsSync(configPath())) fs.renameSync(configPath(), `${configPath()}.corrupt-${Date.now()}`);
    if (r.status !== "ok") writeConfig(defaultConfig());
    io.err(`config ${r.status === "ok" ? "is valid" : "reset to defaults"}\n`);
    return { code: "ok" };
  }
  if (sub !== "set" || !key || raw === undefined) throw new CliError("usage_bad_flag", "usage: review-loop config set <preset|model|effort|rubric|events.path> <value>");
  const cfg = structuredClone(readConfig().config);
  const v = raw === "inherit" || raw === "default" ? null : raw;
  if (key === "preset") cfg.preset = /** @type {typeof cfg.preset} */ (v ?? "default");
  else if (key === "model") cfg.codex.model = v;
  else if (key === "effort") cfg.codex.effort = v;
  else if (key === "rubric") {
    if (v !== null) loadRubricSection(v);
    cfg.rubricPath = v;
  } else if (key === "events.path") cfg.events.path = v;
  else throw new CliError("usage_bad_flag", `unknown setting ${key}`);
  if (!isConfig(cfg)) throw new CliError("usage_bad_flag", `invalid value for ${key}`);
  writeConfig(cfg);
  if (key === "rubric") io.err("Approvals given earlier stay valid; re-run the loop on an open PR to review it under the new rubric.\n");
  return { code: "ok" };
}
```

  `loadRubricSection` throws a `ReviewLoopError` (`rubric_source_mismatch` or
  `rubric_symlink_rejected`). `main` maps any registered code to its exit, and both are `user_action`,
  so exit 1.

- [ ] **Step 3: Run and commit**

  Run: `(set -o pipefail; node --test test/cli/config.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

```bash
git add cli/lib/configcmd.mjs test/cli/config.test.mjs
git commit -m "feat(cli): config show/set/repair"
```

**Gate:** `review-loop config set effort turbo; echo $?` prints `2`.

---

### Task 20: `doctor` (check registry)

**Files:**
- Create: `cli/lib/doctor.mjs`
- Test: `test/cli/doctor.test.mjs`

**Interfaces:**
- Produces:
  - `DOCTOR_CHECKS: Array<{id: string, run(ctx): Promise<{status:"pass"|"fail"|"warn"|"skip", code: string|null, fix: string|null}>}>`;
  - `run(args, io, ctx)`, which exits 1 on any `fail`, returns `json: {schema:"review-loop.doctor/1", ok, checks}`,
    and never writes anything except the `cli.exit` event.

**The check ids (§6.5, in this order):**
`claude, codex_cli, codex_auth, codex_plugin, gh, plugin_installed, version_skew, legacy_hooks,
ask_rules, config, rubric, pin, pr_binding, state_dir, node_for_hooks, events_writable,
skill_duplicate, settings_backup_modified, settings_tmp_leftover, live`.

- [ ] **Step 1: Write the failing tests, starting with the completeness gate (T-DOC-1)**

```js
// test/cli/doctor.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:/usr/bin:/bin`;
const { DOCTOR_CHECKS } = await import("../../cli/lib/doctor.mjs");
const { main } = await import("../../cli/review-loop.mjs");
const { ASK_RULES } = await import("../../cli/lib/settings.mjs");

/** A fully healthy sandbox: every check passes. */
function healthy() {
  const home = tmpDir();
  Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"), CODEX_HOME: path.join(home, "codex"), REVIEW_LOOP_NODE_CANDIDATES: process.execPath });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "state"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: [...ASK_RULES] } }));
  const list = [{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }, { id: "review-loop@review-loop", enabled: true, scope: "user", version: "0.1.0", installPath: path.join(process.cwd(), "plugin") }];
  makeFakeBin(bin, "claude", { "--version": { stdout: "2.1.284\n" }, "plugin list --json": { stdout: JSON.stringify(list) } });
  makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in\n" } });
  makeFakeBin(bin, "gh", { "auth status": { stdout: "ok\n" } });
  return home;
}

/** One fixture per check id, each driving that check to fail (or warn). A new check without a fixture fails T-DOC-1. */
const FAIL_FIXTURES = {
  claude: () => makeFakeBin(bin, "claude", { "*": { code: 127 } }),
  codex_cli: () => makeFakeBin(bin, "codex", { "*": { code: 127 } }),
  codex_auth: () => makeFakeBin(bin, "codex", { "--version": { stdout: "x\n" }, "login status": { code: 1, stdout: "Not logged in\n" } }),
  codex_plugin: () => makeFakeBin(bin, "claude", { "--version": { stdout: "2.1.284\n" }, "plugin list --json": { stdout: "[]" } }),
  gh: () => makeFakeBin(bin, "gh", { "*": { code: 127 } }),
  plugin_installed: () => makeFakeBin(bin, "claude", { "--version": { stdout: "2.1.284\n" }, "plugin list --json": { stdout: JSON.stringify([{ id: "codex@openai-codex", enabled: true }]) } }),
  version_skew: () => makeFakeBin(bin, "claude", { "--version": { stdout: "2.1.284\n" }, "plugin list --json": { stdout: JSON.stringify([{ id: "codex@openai-codex", enabled: true }, { id: "review-loop@review-loop", enabled: true, version: "9.9.0", installPath: "/x" }]) } }),
  legacy_hooks: (h) => fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: [...ASK_RULES] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "node /Users/x/.claude/review-loop/review-gate-hook.mjs stop" }] }] } })),
  ask_rules: (h) => fs.writeFileSync(path.join(h, ".claude", "settings.json"), "{}"),
  config: () => fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, "{bad"),
  rubric: (h) => { fs.writeFileSync(path.join(h, "r.md"), "# nothing\n"); fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: path.join(h, "r.md"), events: { path: null } })); },
  pin: () => { process.env.REVIEW_LOOP_PIN_FILE = "/nonexistent/pin.json"; },
  pr_binding: () => makeFakeBin(bin, "gh", { "*": { code: 1, stdout: "not logged in" } }),
  state_dir: (h) => fs.chmodSync(path.join(h, "state"), 0o755),
  node_for_hooks: () => { process.env.REVIEW_LOOP_NODE_CANDIDATES = "/nonexistent/node"; },
  events_writable: (h) => { fs.mkdirSync(path.join(h, "state", "events.jsonl"), { recursive: true }); },
  skill_duplicate: (h) => { fs.mkdirSync(path.join(h, ".claude", "skills", "review-loop"), { recursive: true }); fs.writeFileSync(path.join(h, ".claude", "skills", "review-loop", "SKILL.md"), "x"); },
  settings_backup_modified: (h) => { const d = path.join(h, "state", "settings-backups"); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(d, "settings.json.2026-01-01T00-00-00-000Z-deadbeef"), "changed"); },
  settings_tmp_leftover: (h) => fs.writeFileSync(path.join(h, ".claude", ".settings.json.review-loop-1-abcdef12.tmp"), "{}"),
  live: () => {}
};

test("T-DOC-1: every doctor check has a failing fixture", () => {
  assert.deepEqual(DOCTOR_CHECKS.map((c) => c.id).sort(), Object.keys(FAIL_FIXTURES).sort());
});

for (const [id, breakIt] of Object.entries(FAIL_FIXTURES)) {
  if (id === "live") continue;
  test(`T-DOC-1: fixture drives ${id} to fail/warn`, async () => {
    const h = healthy();
    breakIt(h);
    const c = DOCTOR_CHECKS.find((x) => x.id === id);
    const r = await c.run({ live: false });
    assert.ok(r.status === "fail" || r.status === "warn", `${id}: ${r.status}`);
    assert.ok(r.fix && r.fix.length > 0, `${id}: fix text`);
    delete process.env.REVIEW_LOOP_PIN_FILE;
  });
}

/** sha256 of every file under the given roots (path → hash), excluding the event log doctor is allowed to append. */
function treeHash(roots) {
  const out = {};
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const rel of fs.readdirSync(r, { recursive: true })) {
      const f = path.join(r, String(rel));
      if (/events\.jsonl(\.1)?$/.test(f) || /[\\/]locks([\\/]|$)/.test(f) || !fs.lstatSync(f).isFile()) continue;
      out[f] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") + ":" + (fs.statSync(f).mode & 0o777);
    }
  }
  return out;
}
const jsonIO = (outs) => ({ isTTY: false, color: false, out: (s) => outs.push(s), err: () => {}, ask: async () => true, choose: async (_q, _o, d) => d, env: process.env });

test("T-DOC-2: fully healthy (pin written for the fake Codex plugin) → exit 0, ok:true", async () => {
  const h = healthy();
  process.env.REVIEW_LOOP_PLUGIN_BASE = path.resolve("test/fixtures/fake-codex-plugin");
  process.env.REVIEW_LOOP_PIN_FILE = path.join(h, "state", "plugin-pin.json");
  const { writePin } = await import("../../plugin/engine/lib/pin.mjs");
  writePin("1.0.6");
  const outs = [];
  assert.equal(await main(["doctor", "--json"], jsonIO(outs)), 0);
  assert.equal(JSON.parse(outs.join("")).ok, true);
  delete process.env.REVIEW_LOOP_PIN_FILE; delete process.env.REVIEW_LOOP_PLUGIN_BASE;
});

test("T-DOC-3: --json is one JSON value whose event equals the appended cli.exit line", async () => {
  const h = healthy();
  const outs = [];
  const code = await main(["doctor", "--json"], jsonIO(outs));
  const stdout = outs.join("");
  const report = JSON.parse(stdout); // a second line would make this throw
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.equal(report.schema, "review-loop.doctor/1");
  assert.deepEqual(Object.keys(report).sort(), ["checks", "event", "ok", "schema"]);
  const last = fs.readFileSync(path.join(h, "state", "events.jsonl"), "utf8").trim().split("\n").at(-1);
  assert.deepEqual(report.event, JSON.parse(last));
  assert.equal(code, report.ok ? 0 : 1);
});

test("T-DOC-4: read-only — settings, config and state trees are byte- and mode-identical", async () => {
  const h = healthy();
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }), { mode: 0o644 });
  fs.chmodSync(path.join(h, "state"), 0o755); // a "fixable" problem doctor must report, not fix
  const roots = [path.join(h, ".claude"), path.join(h, "state"), path.dirname(process.env.REVIEW_LOOP_CONFIG)];
  const before = treeHash(roots);
  const modeBefore = fs.statSync(path.join(h, "state")).mode & 0o777;
  await main(["doctor", "--json"], jsonIO([]));
  assert.deepEqual(treeHash(roots), before);
  assert.equal(fs.statSync(path.join(h, "state")).mode & 0o777, modeBefore);
});

test("T-DOC-5: no paid call without --live — Codex is asked only for --version and login status", async () => {
  healthy();
  const codex = makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in\n" } });
  await main(["doctor", "--json"], jsonIO([]));
  for (const argv of codex.log()) assert.ok(["--version", "login status"].includes(argv.join(" ")), `unexpected codex call: ${argv.join(" ")}`);
});

test("T-DOC-6: a legacy hook is reported with the migrate fix", async () => {
  const h = healthy();
  FAIL_FIXTURES.legacy_hooks(h);
  const r = await DOCTOR_CHECKS.find((c) => c.id === "legacy_hooks").run({ live: false });
  assert.equal(r.status, "fail");
  assert.equal(r.fix, "review-loop migrate");
});

test("T-DOC-7: skew passes on same major.minor, fails otherwise", async () => {
  healthy();
  const c = DOCTOR_CHECKS.find((x) => x.id === "version_skew");
  assert.equal((await c.run({ live: false })).status, "pass");
});
```

  **Create the fixture tree `test/fixtures/fake-codex-plugin/1.0.6/`,** containing one small file per
  entry in `pin.mjs`'s `FIXED_FILES` (the same relative paths; any content). T-DOC-2 pins it through
  `REVIEW_LOOP_PLUGIN_BASE`, which is Task 9's `pluginBase()` override. Check the `writePin` signature at
  `plugin/engine/lib/pin.mjs` (it may take `(version, expected)`), and pass what it requires.

  **T-DOC-3/4/5 don't need a passing pin.** The healthy sandbox's `pin` check fails, so they assert
  `code === (report.ok ? 0 : 1)`, byte-identity and the Codex argv respectively. Only T-DOC-2 needs the
  full pass.

- [ ] **Step 2: Implement `cli/lib/doctor.mjs`**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mark } from "./io.mjs";
import { PREFLIGHT } from "./preflight.mjs";
import { installedPlugin, PLUGIN_ID } from "./plugin.mjs";
import { ASK_RULES, LEGACY_HOOK_RE, readSettings, settingsPath } from "./settings.mjs";
import { liveCheck } from "./livecheck.mjs";
import { readConfig } from "../../plugin/engine/lib/config.mjs";
import { loadRubricSection } from "../../plugin/engine/lib/rubric.mjs";
import { verifyPin } from "../../plugin/engine/lib/pin.mjs";
import { eventsPath, PACKAGE_VERSION } from "../../plugin/engine/lib/events.mjs";
import { stateRoot } from "../../plugin/engine/lib/paths.mjs";
import { sha256hex } from "../../plugin/engine/lib/fsutil.mjs";

/** @typedef {{ status: "pass" | "fail" | "warn" | "skip", code: string | null, fix: string | null }} Result */
const pass = () => /** @type {Result} */ ({ status: "pass", code: null, fix: null });
const fail = (/** @type {string} */ code, /** @type {string} */ fix, warn = false) => /** @type {Result} */ ({ status: warn ? "warn" : "fail", code, fix });
const fromPreflight = (/** @type {string} */ id) => async () => {
  const item = /** @type {typeof PREFLIGHT[number]} */ (PREFLIGHT.find((p) => p.id === id));
  const r = await item.check();
  return r.status === "pass" ? pass() : fail(id === "gh" ? "status_post_failed" : "preflight_failed", item.fix.text, r.status === "warn");
};
const hookCommands = () => {
  try {
    const hooks = /** @type {Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>} */ (readSettings().obj.hooks ?? {});
    return Object.values(hooks).flat().flatMap((g) => g.hooks ?? []).map((h) => String(h.command ?? ""));
  } catch { return []; }
};

export const DOCTOR_CHECKS = [
  { id: "claude", run: fromPreflight("claude") },
  { id: "codex_cli", run: fromPreflight("codex_cli") },
  { id: "codex_auth", run: fromPreflight("codex_auth") },
  { id: "codex_plugin", run: fromPreflight("codex_plugin") },
  { id: "gh", run: fromPreflight("gh") },
  { id: "plugin_installed", async run() { const p = await installedPlugin(PLUGIN_ID).catch(() => null); return p && p.enabled && (p.scope ?? "user") === "user" ? pass() : fail("plugin_install_failed", "review-loop setup"); } },
  { id: "version_skew", async run() {
      const p = await installedPlugin(PLUGIN_ID).catch(() => null);
      if (!p?.version) return fail("plugin_install_failed", "review-loop setup");
      const mm = (/** @type {string} */ v) => v.split(".").slice(0, 2).join(".");
      return mm(p.version) === mm(PACKAGE_VERSION) ? pass() : fail("plugin_install_failed", "review-loop update   (or: brew upgrade review-loop)");
  } },
  { id: "legacy_hooks", async run() { return hookCommands().some((c) => LEGACY_HOOK_RE.test(c)) ? fail("preflight_failed", "review-loop migrate") : pass(); } },
  { id: "ask_rules", async run() {
      try { const ask = /** @type {{ permissions?: { ask?: unknown[] } }} */ (readSettings().obj).permissions?.ask ?? []; return ASK_RULES.every((r) => ask.includes(r)) ? pass() : fail("preflight_failed", "review-loop setup"); }
      catch { return fail("settings_invalid_json", "open ~/.claude/settings.json and correct the JSON"); }
  } },
  { id: "config", async run() { const r = readConfig(); return r.status === "invalid" ? fail(r.code, "review-loop config repair") : pass(); } },
  { id: "rubric", async run() { try { loadRubricSection(); return pass(); } catch (e) { return fail(/** @type {{ code?: string }} */ (e).code ?? "rubric_source_mismatch", "review-loop config set rubric <path>   (or: config set rubric default)"); } } },
  { id: "pin", async run() { try { const v = verifyPin(); return v && v.ok === false ? fail("plugin_pin_mismatch", "review-loop setup") : pass(); } catch { return fail("plugin_pin_mismatch", "review-loop setup"); } } },
  { id: "pr_binding", async run() { const r = spawnSync("gh", ["auth", "status"], { encoding: "utf8" }); return r.status === 0 ? pass() : fail("status_post_failed", "brew install gh && gh auth login", true); } },
  { id: "state_dir", async run() {
      try { const st = fs.lstatSync(stateRoot()); if (st.isSymbolicLink() || !st.isDirectory()) return fail("state_symlink_rejected", `replace ${stateRoot()} with a real directory`); if (st.uid !== process.getuid?.()) return fail("state_dir_insecure", `sudo chown $USER "${stateRoot()}"`); return st.mode & 0o077 ? fail("state_dir_insecure", `chmod 700 "${stateRoot()}"`) : pass(); }
      catch { return pass(); }
  } },
  { id: "node_for_hooks", async run() {
      const env = process.env.REVIEW_LOOP_NODE_CANDIDATES;
      const cands = env ? env.split(":") : ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
      return cands.some((c) => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch { return false; } }) ? pass() : fail("node_missing", "brew install node");
  } },
  { id: "events_writable", async run() {
      const f = eventsPath();
      try { const st = fs.lstatSync(f); if (!st.isFile()) return fail("events_unwritable", "review-loop config set events.path <file>"); fs.accessSync(f, fs.constants.W_OK); return pass(); }
      catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? pass() : fail("events_unwritable", "review-loop config set events.path <file>"); }
  } },
  { id: "skill_duplicate", async run() { return fs.existsSync(path.join(os.homedir(), ".claude", "skills", "review-loop", "SKILL.md")) ? fail("preflight_failed", "review-loop migrate") : pass(); } },
  { id: "settings_backup_modified", async run() {
      const d = path.join(stateRoot(), "settings-backups");
      if (!fs.existsSync(d)) return pass();
      const bad = fs.readdirSync(d).filter((n) => /-[0-9a-f]{8}$/.test(n) && !sha256hex(fs.readFileSync(path.join(d, n))).startsWith(n.slice(-8)));
      return bad.length ? fail("settings_detached_write", `compare ${path.join(d, bad[0])} with settings.json and copy over any change you need; then delete the backup`, true) : pass();
  } },
  { id: "settings_tmp_leftover", async run() {
      const dir = path.dirname(settingsPath());
      const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\.settings\.json\.review-loop-.*\.tmp$/.test(n)) : [];
      return left.length ? fail("settings_concurrent_write", `delete ${path.join(dir, left[0])}; settings.json itself is intact`, true) : pass();
  } },
  { id: "live", async run(/** @type {{ live: boolean }} */ ctx) {
      if (!ctx.live) return fail("setup_complete_unverified", "review-loop doctor --live", true);
      const r = await liveCheck();
      return r.ok ? pass() : fail("live_check_failed", `see: review-loop doctor --live (${r.detail})`);
  } }
];

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ json: boolean }} ctx */
export async function run(args, io, ctx) {
  const live = args.includes("--live");
  const checks = [];
  for (const c of DOCTOR_CHECKS) {
    let r;
    try { r = await c.run({ live }); } catch { r = fail("unexpected_error", "report a bug"); }
    checks.push({ id: c.id, ...r });
    if (!ctx.json) io.err(`${mark(r.status, io.color)}  ${c.id}${r.fix && r.status !== "pass" ? `\n      Fix: ${r.fix}` : ""}\n`);
  }
  const ok = checks.every((c) => c.status !== "fail");
  return { code: ok ? "ok" : "preflight_failed", json: { schema: "review-loop.doctor/1", ok, checks } };
}
```

  **Register one new code** in `plugin/engine/lib/codes.mjs`'s `CODES`:
  `events_unwritable: { category: "user_action", remedy: "run \`review-loop config set events.path <file>\`" },`.
  Every other code used here is already registered: `plugin_pin_mismatch`, `rubric_source_mismatch`,
  `state_symlink_rejected` and `state_dir_insecure` come from the engine; the rest come from Task 7.
  T-OBS-3 goes red if one is missing. The `live` warn uses `setup_complete_unverified` (category `ok`) as its code, so a warning
  never changes the exit code.

- [ ] **Step 3: Run and commit**

  Run: `(set -o pipefail; node --test test/cli/doctor.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

```bash
git add cli/lib/doctor.mjs test/cli/doctor.test.mjs test/fixtures/fake-codex-plugin
git commit -m "feat(cli): read-only doctor with a completeness-gated check registry"
```

**Gate:** add a dummy check `{ id: "zz", run: async () => pass() }`; T-DOC-1 goes red. Remove it.

---

### Task 21: `update`, `uninstall`, `engine-path`, and the CLI-missing session notice

**Files:**
- Create: `cli/lib/update.mjs`, `cli/lib/uninstall.mjs`, `cli/lib/enginepath.mjs`
- Modify: `plugin/engine/review-gate-hook.mjs` (the `session` branch: T-UN-5)
- Test: `test/cli/uninstall.test.mjs`, and `test/engine/session-notice.test.mjs`

**Interfaces:**
- `update`: `claude plugin marketplace update review-loop`, then `claude plugin update review-loop@review-loop --json`, then `doctor`.
  A plugin update failure → exit 1 with its code, and `doctor` still runs.
- `uninstall`, in order, stopping at the first failure:
  1. plugin uninstall;
  2. marketplace remove;
  3. the §6.2 write removing exactly `ASK_RULES`;
  4. remove the config file, and its directory if it's then empty;
  5. history: keep by default; `--delete-history` or an explicit "y" removes `stateRoot()`;
  6. the final dangling-hook assertion.
- `engine-path`: prints `enginePath()`, or exits 1 with `plugin_install_failed`.

- [ ] **Step 1: Write the failing tests**

```js
// test/cli/uninstall.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:/usr/bin:/bin`;
delete process.env.CLAUDECODE;
const { main } = await import("../../cli/review-loop.mjs");
const { ASK_RULES } = await import("../../cli/lib/settings.mjs");
const io = (answers = []) => ({ isTTY: true, color: false, lines: [], out() {}, err(s) { this.lines.push(s); }, ask: async () => answers.shift() ?? true, choose: async (_q, _o, d) => d, env: process.env });

function sandbox(claudeResponses = {}) {
  const home = tmpDir();
  Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, ".config", "review-loop", "config.json") });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "state"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, "state", "events.jsonl"), "");
  fs.mkdirSync(path.dirname(process.env.REVIEW_LOOP_CONFIG), { recursive: true });
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "x", permissions: { ask: [...ASK_RULES, "Bash(mine)"] } }));
  const installed = JSON.stringify([{ id: "review-loop@review-loop", enabled: true, version: "0.1.0", installPath: "/x" }]);
  // First list call (before uninstalling) sees the plugin; later calls (the final dangling check, a re-run) don't.
  const claude = makeFakeBin(bin, "claude", { "plugin list --json": [{ stdout: installed }, { stdout: "[]" }], "*": { stdout: "{}\n" }, ...claudeResponses });
  makeFakeBin(bin, "pgrep", { "*": { code: 1 } });
  makeFakeBin(bin, "lsof", { "*": { code: 1 } });
  return { home, claude };
}

test("T-UN-1: order is plugin → marketplace → settings → config; history kept by default", async () => {
  const s = sandbox();
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
  const calls = s.claude.log().map((a) => a.slice(0, 3).join(" "));
  assert.deepEqual(calls.filter((c) => c.startsWith("plugin uninstall") || c.startsWith("plugin marketplace")), ["plugin uninstall review-loop@review-loop", "plugin marketplace remove"]);
  const settings = JSON.parse(fs.readFileSync(path.join(s.home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.ask, ["Bash(mine)"]);
  assert.equal(settings.theme, "x");
  assert.equal(fs.existsSync(process.env.REVIEW_LOOP_CONFIG), false);
  assert.equal(fs.existsSync(path.join(s.home, "state")), true, "history kept (T-UN-3)");
});

test("T-UN-1 (−): plugin uninstall fails → nothing else removed, exit 1", async () => {
  const s = sandbox({ "plugin uninstall review-loop@review-loop --scope user --json": { code: 1, stderr: "boom" } });
  assert.equal(await main(["uninstall", "--yes"], io()), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, ".claude", "settings.json"), "utf8")).permissions.ask.length, 6);
  assert.ok(fs.existsSync(process.env.REVIEW_LOOP_CONFIG));
});

test("T-UN-3: --delete-history removes the state dir", async () => {
  const s = sandbox();
  assert.equal(await main(["uninstall", "--yes", "--delete-history"], io()), 0);
  assert.equal(fs.existsSync(path.join(s.home, "state")), false);
});

test("T-UN-4: a re-run after partial failure completes and tolerates already-removed items", async () => {
  sandbox();
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
});

test("T-DOC-8: update runs marketplace update, then plugin update, then doctor; a failed update still runs doctor", async () => {
  const s = sandbox();
  const order = () => s.claude.log().map((a) => a.slice(0, 3).join(" ")).filter((c) => /^plugin (marketplace update|update)|^plugin list/.test(c));
  assert.equal(await main(["update"], io()), 1, "doctor fails in the sandbox → exit 1 is fine; the order is the assertion");
  const o1 = order();
  assert.equal(o1[0], "plugin marketplace update");
  assert.equal(o1[1], "plugin update review-loop@review-loop");
  assert.ok(o1.slice(2).some((c) => c === "plugin list --json"), "doctor ran after the update");
  const t = sandbox({ "plugin update review-loop@review-loop --json": { code: 1, stderr: "nope" } });
  const out = io();
  assert.equal(await main(["update"], out), 1);
  assert.ok(t.claude.log().some((a) => a.join(" ") === "plugin list --json"), "doctor still ran");
});

test("T-CFG-8: uninstall removes the config at a custom XDG path and leaves ~/.config alone", async () => {
  const s = sandbox();
  delete process.env.REVIEW_LOOP_CONFIG;
  process.env.XDG_CONFIG_HOME = path.join(s.home, "xdg");
  const f = path.join(s.home, "xdg", "review-loop", "config.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "{}");
  fs.mkdirSync(path.join(s.home, ".config", "other"), { recursive: true });
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
  assert.equal(fs.existsSync(f), false);
  assert.ok(fs.existsSync(path.join(s.home, ".config", "other")));
  delete process.env.XDG_CONFIG_HOME;
});
```

  T-UN-2 (no dangling hooks) goes in the same file:

```js
test("T-UN-2: a leftover review-loop hook fails the final check", async () => {
  const s = sandbox();
  const f = path.join(s.home, ".claude", "settings.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), hooks: { Stop: [{ hooks: [{ type: "command", command: "node /opt/x/review-loop/engine/review-gate-hook.mjs stop" }] }] } }));
  const o = io();
  assert.equal(await main(["uninstall", "--yes"], o), 1);
  assert.match(o.lines.join(""), /a hook still references review-loop/);
});

test("T-UN-2 (+): the plugin still listed after uninstall fails the final check", async () => {
  const s = sandbox();
  s.claude.set({ "plugin list --json": { stdout: JSON.stringify([{ id: "review-loop@review-loop", enabled: true }]) }, "*": { stdout: "{}\n" } });
  assert.equal(await main(["uninstall", "--yes"], io()), 1);
});
```

  `main` prints a `CliError`'s message on stderr through `io.err`. Task 15's `finish` path does that; if
  it doesn't, assert on the `cli.exit` event's `code` (`preflight_failed`) instead.

- [ ] **Step 2: Implement**

```js
// cli/lib/uninstall.mjs
import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { installedPlugin, MARKETPLACE_NAME, PLUGIN_ID } from "./plugin.mjs";
import { runTool } from "./run.mjs";
import { ASK_RULES, LEGACY_HOOK_RE, readSettings, updateSettings } from "./settings.mjs";
import { configPath } from "../../plugin/engine/lib/config.mjs";
import { stateRoot } from "../../plugin/engine/lib/paths.mjs";

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
export async function run(args, io, ctx) {
  if (!io.isTTY && !ctx.yes) throw new CliError("usage_noninteractive", "uninstall needs a terminal, or --yes");
  io.err(`Will remove: the review-loop plugin and marketplace; 5 approval rules in settings.json; ${configPath()}.\nWill NOT remove: Codex, the Codex plugin, gh, node (other tools may use them).\n`);
  if (!ctx.yes && !(await io.ask("Continue?", false))) throw new CliError("cancelled", "cancelled");

  if (await installedPlugin(PLUGIN_ID).catch(() => null)) {
    const r = await runTool("claude", ["plugin", "uninstall", PLUGIN_ID, "--scope", "user", "--json"]);
    if (r.code !== 0) throw new CliError("plugin_install_failed", "claude plugin uninstall failed; nothing else was removed");
  }
  await runTool("claude", ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
  await updateSettings((o) => {
    const ask = /** @type {{ permissions?: { ask?: string[] } }} */ (o).permissions?.ask;
    if (!Array.isArray(ask)) return false;
    const keep = ask.filter((r) => !ASK_RULES.includes(r));
    if (keep.length === ask.length) return false;
    /** @type {{ permissions: { ask: string[] } }} */ (o).permissions.ask = keep;
    return true;
  }, { io, yes: ctx.yes });
  fs.rmSync(configPath(), { force: true });
  try { fs.rmdirSync(path.dirname(configPath())); } catch { /* Not empty or already gone: left alone. */ }

  const del = args.includes("--delete-history") || (!args.includes("--keep-history") && !ctx.yes && (await io.ask(`Also delete review history in ${stateRoot()}?`, false)));
  if (del) fs.rmSync(stateRoot(), { recursive: true, force: true });

  const hooks = /** @type {Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>} */ (readSettings().obj.hooks ?? {});
  const dangling = Object.values(hooks).flat().flatMap((g) => g.hooks ?? []).some((h) => LEGACY_HOOK_RE.test(String(h.command ?? "")) || /review-loop[\\/](bin[\\/]hook|engine)/.test(String(h.command ?? "")));
  if (dangling || (await installedPlugin(PLUGIN_ID).catch(() => null))) throw new CliError("preflight_failed", "a hook still references review-loop; run `review-loop migrate --rollback` or remove it from settings.json");
  io.err("review-loop removed. To finish, you can run: brew uninstall review-loop\n");
  return { code: "ok" };
}
```

```js
// cli/lib/update.mjs
import { CliError } from "./errors.mjs";
import { MARKETPLACE_NAME, PLUGIN_ID } from "./plugin.mjs";
import { runTool } from "./run.mjs";
import { run as doctor } from "./doctor.mjs";

/** @param {string[]} _args @param {import("./io.mjs").IO} io @param {{ json: boolean }} ctx */
export async function run(_args, io, ctx) {
  await runTool("claude", ["plugin", "marketplace", "update", MARKETPLACE_NAME]);
  const u = await runTool("claude", ["plugin", "update", PLUGIN_ID, "--json"], { timeoutMs: 5 * 60_000 });
  const d = await doctor([], io, { ...ctx, json: false });
  if (u.code !== 0) throw new CliError("plugin_install_failed", "claude plugin update failed");
  io.err("Restart Claude Code to load the updated plugin.\n");
  return { code: d.code };
}
```

```js
// cli/lib/enginepath.mjs
import { CliError } from "./errors.mjs";
import { enginePath } from "./plugin.mjs";

/** @param {string[]} _a @param {import("./io.mjs").IO} io */
export async function run(_a, io) {
  const p = await enginePath();
  if (!p) throw new CliError("plugin_install_failed", "review-loop plugin is not installed");
  io.out(`${p}\n`);
  return { code: "ok" };
}
```

  **`engine-path` prints to stdout even without `--json`,** because the skill's
  `$(review-loop engine-path)` reads it. With `--json`, `main` prints only the event, so add
  `json: { path: p }` to the result for that case.

  **Session notice (T-UN-5).** In `review-gate-hook.mjs`'s `session` branch, after `snapshotSession`,
  check for the CLI on `PATH`, `/opt/homebrew/bin/review-loop` and `/usr/local/bin/review-loop`, using
  `fs.accessSync(…, X_OK)` and `PATH` splitting. If none is found, emit
  `{ systemMessage: "review-loop: the review-loop CLI is missing (was `brew uninstall review-loop` run?). To finish uninstalling: claude plugin uninstall review-loop@review-loop — or reinstall with brew install <owner>/tap/review-loop" }`.
  Emit it once per session, since `session` fires once per session. The test
  `test/engine/session-notice.test.mjs` spawns the hook with a `PATH` lacking `review-loop` (asserting
  the message) and with a fake `review-loop` on `PATH` (asserting nothing is printed).

- [ ] **Step 3: Run and commit**

  Run: `(set -o pipefail; node --test test/cli/ test/engine/session-notice.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

```bash
git add -A cli plugin test
git commit -m "feat(cli): update, uninstall (ordered, stop-on-failure), engine-path; CLI-missing notice"
```

**Gate:** sabotage. Swap the plugin-uninstall and settings steps; T-UN-1 (−) goes red. Revert.

---

### Task 22: `migrate` and `migrate --rollback` (§14)

**Files:**
- Create: `cli/lib/migrate.mjs`, `test/fixtures/legacy-home/` (an author-shaped fixture generator in the test)
- Modify: `plugin/engine/lib/fsutil.mjs` (extract `atomicWriteText` from `atomicWriteJson`; the JSON writer delegates to it)
- Test: `test/cli/migrate.test.mjs`

**Interfaces:**
- Produces:
  - the manifest `<stateRoot>/migration.json`, containing
    `{v:1, status:"in_progress"|"done"|"rolled_back", date, steps: Step[]}`;
  - `Step = {resource: "settings"|"plugin"|"marketplace"|"skill"|"pin"|"config"|"claude_md"|"engine_dir", action: string, before: {sha?: string, backup?: string, absent?: true}, after: {sha?: string}, removedHooks?: object[], addedAsk?: string[]}`.
- Legacy detection:
  - any settings hook command matching `LEGACY_HOOK_RE`;
  - `~/.claude/skills/review-loop/SKILL.md`;
  - `~/.claude/review-loop/plugin-pin.json`.
- The archive is `~/.claude/review-loop-legacy-<YYYY-MM-DD>/`, containing `skill/` and later `engine/`.

**Invariants (§14):**
- Each step appends its manifest entry **before** mutating, via `atomicWriteJson`.
- Plugin install comes before the single settings write that removes the legacy hooks and ensures the
  ask rules. If the install fails, settings are untouched.
- The skill moves **out of** `~/.claude/skills`.
- `CLAUDE.md` is edited only on yes. `rubricPath` is set to `~/.claude/rules/multi-dimension-review.md`
  when that file exists.
- The engine dir moves only after `doctor` exits 0.
- **Rollback** walks the manifest in reverse and is idempotent. Config and `CLAUDE.md` are restored
  only if their current sha equals the recorded after-sha; otherwise `rollback_skipped_modified`
  (exit 1). The legacy hook objects are re-inserted by a read-modify-write, never by restoring the
  whole file.
- **The manifest is untrusted input at rollback time** (`untrusted-io-and-resource-bounds`):
  - it is read with the engine's `safeReadFile`: `lstat`, an `O_NOFOLLOW` open, `fstat` on that same
    descriptor (regular file, ≤ 1 MiB), a bounded read, and refusal if the file grows. So a link or a
    huge file swapped in after the checks is never followed or buffered. It is then validated
    structurally by `isManifest`;
  - an invalid one is renamed to `migration.json.corrupt-<ts>` and rollback exits 1 with
    `migration_manifest_invalid`, changing nothing;
  - **no filesystem path is read from it.** Every path rollback moves is derived from `~/.claude`,
    `stateRoot()` and the validated `date`;
  - restored hooks must match the exact legacy command shape, and restored ask rules must be members of
    `ASK_RULES`.
- **Snapshot before mutate.** Each step's undo data (the config's before-bytes, the `CLAUDE.md` backup
  token) is captured and persisted **before** the write it undoes.

- [ ] **Step 1: Write the failing tests**

```js
// test/cli/migrate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.REVIEW_LOOP_TEST_SEAMS = "1"; // enables --skip-doctor-gate / --force-engine-move; set before migrate.mjs loads
delete process.env.CLAUDECODE;
const { main } = await import("../../cli/review-loop.mjs");
const { ASK_RULES } = await import("../../cli/lib/settings.mjs");
const io = (answers = []) => ({ isTTY: true, color: false, lines: [], out() {}, err(s) { this.lines.push(s); }, ask: async () => answers.shift() ?? true, choose: async (_q, _o, d) => d, env: process.env });

const LEGACY = (home) => ({
  PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/graphify hook-guard search" }] }, { matcher: "Bash", hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs pr`, timeout: 40 }] }, { matcher: "mcp__.*__create_pull_request", hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs pr`, timeout: 40 }] }],
  SessionStart: [{ hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs session`, timeout: 20 }] }],
  PostToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs track`, timeout: 5 }] }],
  Stop: [{ hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs stop`, timeout: 20 }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs prompt`, timeout: 5 }] }]
});

function authorShaped({ installFails = false } = {}) {
  const home = tmpDir();
  Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, ".claude", "state", "review-loop"), REVIEW_LOOP_CONFIG: path.join(home, ".config", "review-loop", "config.json"), REVIEW_LOOP_PIN_FILE: "" });
  delete process.env.REVIEW_LOOP_PIN_FILE;
  const c = path.join(home, ".claude");
  fs.mkdirSync(path.join(c, "review-loop", "lib"), { recursive: true });
  fs.writeFileSync(path.join(c, "review-loop", "review-gate-hook.mjs"), "// legacy");
  fs.writeFileSync(path.join(c, "review-loop", "plugin-pin.json"), JSON.stringify({ version: "1.0.6", files: {} }));
  fs.mkdirSync(path.join(c, "skills", "review-loop"), { recursive: true });
  fs.writeFileSync(path.join(c, "skills", "review-loop", "SKILL.md"), "---\nname: review-loop\n---\n");
  fs.mkdirSync(path.join(c, "rules"), { recursive: true });
  fs.copyFileSync(new URL("../../plugin/rubric/default.md", import.meta.url), path.join(c, "rules", "multi-dimension-review.md"));
  fs.mkdirSync(path.join(c, "state", "review-loop", "records"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(c, "state", "review-loop", "records", "keep.json"), "{}");
  fs.writeFileSync(path.join(c, "CLAUDE.md"), "Engine, invariants and tests: `~/.claude/review-loop/CLAUDE.md`.\n");
  fs.writeFileSync(path.join(c, "settings.json"), JSON.stringify({ theme: "dark", hooks: LEGACY(home), permissions: { ask: [...ASK_RULES] } }));
  const listed = JSON.stringify([{ id: "review-loop@review-loop", enabled: true, version: "0.1.0", installPath: "/x" }]);
  const claude = makeFakeBin(bin, "claude", {
    // migrate's first check sees no plugin; every later check (doctor, rollback) sees it installed.
    "plugin list --json": [{ stdout: "[]" }, { stdout: listed }],
    "plugin install review-loop@review-loop --scope user --json": installFails ? { code: 1, stderr: "nope" } : { stdout: "{}" },
    "*": { stdout: "{}\n" }
  });
  makeFakeBin(bin, "pgrep", { "*": { code: 1 } });
  makeFakeBin(bin, "lsof", { "*": { code: 1 } });
  return { home, c, claude };
}
const settings = (c) => JSON.parse(fs.readFileSync(path.join(c, "settings.json"), "utf8"));
const legacyCount = (s) => JSON.stringify(s.hooks ?? {}).match(/review-gate-hook\.mjs/g)?.length ?? 0;

test("T-MIG-1: one settings write swaps hooks; the graphify hook is untouched", async () => {
  const { c } = authorShaped();
  const code = await main(["migrate", "--yes", "--skip-doctor-gate"], io());
  assert.equal(code, 0);
  const s = settings(c);
  assert.equal(legacyCount(s), 0);
  assert.equal(JSON.stringify(s.hooks).includes("graphify"), true);
  assert.equal(s.theme, "dark");
  const backups = fs.readdirSync(path.join(c, "state", "review-loop", "settings-backups"));
  assert.equal(backups.length, 1, "exactly one settings commit");
});

test("T-MIG-1 (−): plugin install fails → settings bytes unchanged", async () => {
  const { c } = authorShaped({ installFails: true });
  const before = fs.readFileSync(path.join(c, "settings.json"));
  assert.equal(await main(["migrate", "--yes"], io()), 1);
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), before);
});

test("T-MIG-2/3/4: history kept; rubricPath set; skill moved out of skills/", async () => {
  const { c } = authorShaped();
  await main(["migrate", "--yes", "--skip-doctor-gate"], io());
  assert.ok(fs.existsSync(path.join(c, "state", "review-loop", "records", "keep.json")));
  assert.equal(JSON.parse(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8")).rubricPath, path.join(c, "rules", "multi-dimension-review.md"));
  assert.equal(fs.existsSync(path.join(c, "skills", "review-loop")), false);
  const archive = fs.readdirSync(c).find((n) => n.startsWith("review-loop-legacy-"));
  assert.ok(fs.existsSync(path.join(c, archive, "skill", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(c, "state", "review-loop", "plugin-pin.json")), "pin moved into the state dir");
});

test("T-MIG-5: CLAUDE.md edited only on yes", async () => {
  const { c } = authorShaped();
  const before = fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8");
  // With pgrep reporting no running claude, the CLAUDE.md step is migrate's only prompt.
  await main(["migrate", "--skip-doctor-gate"], io([false]));
  assert.equal(fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8"), before, "answered no to the CLAUDE.md step");
});

test("T-MIG-6: engine dir moves only when doctor passes", async () => {
  const { c } = authorShaped();
  assert.equal(await main(["migrate", "--yes"], io()), 1, "doctor fails in the sandbox (no real plugin)");
  assert.ok(fs.existsSync(path.join(c, "review-loop", "review-gate-hook.mjs")), "not moved");
});

test("T-MIG-7 (config): an existing config is restored byte-for-byte on rollback", async () => {
  authorShaped();
  fs.mkdirSync(path.dirname(process.env.REVIEW_LOOP_CONFIG), { recursive: true });
  const original = JSON.stringify({ version: 1, preset: "balanced", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } });
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, original, { mode: 0o600 });
  await main(["migrate", "--yes", "--skip-doctor-gate"], io());
  assert.notEqual(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8"), original, "migrate set rubricPath");
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.equal(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8"), original);
});

test("T-MIG-5b: a symlinked CLAUDE.md is never written through, on migrate or rollback", async () => {
  const { c } = authorShaped();
  const real = path.join(tmpDir(), "dotfiles-CLAUDE.md");
  fs.renameSync(path.join(c, "CLAUDE.md"), real);
  fs.symlinkSync(real, path.join(c, "CLAUDE.md"));
  const before = fs.readFileSync(real, "utf8");
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 0);
  assert.equal(fs.readFileSync(real, "utf8"), before, "target untouched");
  assert.ok(fs.lstatSync(path.join(c, "CLAUDE.md")).isSymbolicLink(), "link intact");
  assert.match(o.lines.join(""), /is a symlink, so review-loop won't edit it/);
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.equal(fs.readFileSync(real, "utf8"), before);
});

test("T-MIG-7 (pin): a pin changed after migration is kept, not moved back; rollback reports it", async () => {
  const { c } = authorShaped();
  await main(["migrate", "--yes", "--skip-doctor-gate"], io());
  const pin = path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json");
  fs.writeFileSync(pin, JSON.stringify({ version: "1.0.7", files: {} }));
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  assert.match(o.lines.join(""), /pin \(changed after migration\)/);
  assert.equal(JSON.parse(fs.readFileSync(pin, "utf8")).version, "1.0.7", "re-written pin kept");
  assert.equal(fs.existsSync(path.join(c, "review-loop", "plugin-pin.json")), false);
});

test("T-MIG-9: an unreadable manifest is a loud failure, never 'nothing to roll back', and is not quarantined", async () => {
  authorShaped();
  await main(["migrate", "--yes", "--skip-doctor-gate"], io());
  const mf = path.join(process.env.REVIEW_LOOP_STATE_DIR, "migration.json");
  fs.chmodSync(mf, 0o000);
  try {
    const o = io();
    assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
    assert.doesNotMatch(o.lines.join(""), /Nothing to roll back/);
    assert.ok(fs.existsSync(mf), "left in place for the user to fix");
  } finally { fs.chmodSync(mf, 0o600); }
  fs.chmodSync(process.env.REVIEW_LOOP_STATE_DIR, 0o000);
  try {
    assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 1, "lstat EACCES is not ENOENT");
  } finally { fs.chmodSync(process.env.REVIEW_LOOP_STATE_DIR, 0o700); }
});

test("T-MIG-8b: a link swapped in between the checks and the read is never followed", async (t) => {
  authorShaped();
  await main(["migrate", "--yes", "--skip-doctor-gate"], io());
  const mf = path.join(process.env.REVIEW_LOOP_STATE_DIR, "migration.json");
  const victim = path.join(tmpDir(), "victim.json");
  fs.writeFileSync(victim, JSON.stringify({ v: 1, status: "done", date: "2026-01-01", steps: [] }));
  const real = fs.lstatSync(mf);
  fs.rmSync(mf);
  fs.symlinkSync(victim, mf);
  // Simulate the race: every lstat of the manifest reports the regular file that was there a moment ago.
  const orig = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (/** @type {fs.PathLike} */ p, /** @type {fs.StatSyncOptions | undefined} */ o) => (String(p) === mf ? real : orig(p, o)));
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  t.mock.restoreAll();
  assert.ok(fs.readdirSync(path.dirname(mf)).some((n) => n.startsWith("migration.json.corrupt-")), "quarantined as invalid");
  assert.doesNotMatch(o.lines.join(""), /Rolled back|Nothing to roll back/, "the victim's content was not acted on");
});

test("T-MIG-3b: a symlinked or oversized legacy pin is never followed or copied; migrate still completes", async () => {
  for (const make of [
    (/** @type {string} */ pin) => { const secret = path.join(tmpDir(), "secret.json"); fs.writeFileSync(secret, JSON.stringify({ version: "SECRET" })); fs.rmSync(pin); fs.symlinkSync(secret, pin); return secret; },
    (/** @type {string} */ pin) => { fs.writeFileSync(pin, JSON.stringify({ version: "1.0.6", pad: "x".repeat(70 * 1024) })); return null; }
  ]) {
    const { c } = authorShaped();
    const pin = path.join(c, "review-loop", "plugin-pin.json");
    const secret = make(pin);
    const o = io();
    assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 0);
    assert.match(o.lines.join(""), /not a regular, valid pin file/);
    assert.equal(fs.existsSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json")), false, "nothing copied into state");
    if (secret) assert.equal(JSON.parse(fs.readFileSync(secret, "utf8")).version, "SECRET", "link target untouched");
  }
});

test("T-MIG-8: a tampered manifest is quarantined; nothing outside the migration roots moves; no hook is injected", async () => {
  const { c } = authorShaped();
  await main(["migrate", "--yes", "--skip-doctor-gate"], io());
  const mf = path.join(process.env.REVIEW_LOOP_STATE_DIR, "migration.json");
  const victim = path.join(tmpDir(), "victim.txt");
  fs.writeFileSync(victim, "keep");
  const good = JSON.parse(fs.readFileSync(mf, "utf8"));
  const settingsBefore = fs.readFileSync(path.join(c, "settings.json"));
  for (const tamper of [
    (m) => { m.steps.push({ resource: "engine_dir", action: "move", before: { path: path.join(tmpDir(), "dest") }, after: { path: victim } }); m.date = "../../x"; },
    (m) => { m.steps.find((s) => s.resource === "settings").removedHooks.push({ event: "Stop", index: 0, group: { hooks: [{ type: "command", command: "node /x/.claude/review-loop/review-gate-hook.mjs stop; curl evil" }] } }); },
    (m) => { m.steps.find((s) => s.resource === "settings").addedAsk.push("Bash(anything)"); },
    (m) => { m.steps.push({ resource: "claude_md", action: "edit", before: { backupTs: "../../etc/hosts" }, after: { sha: "0".repeat(64) } }); }
  ]) {
    const m = structuredClone(good);
    tamper(m);
    fs.writeFileSync(mf, JSON.stringify(m));
    const o = io();
    assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
    assert.ok(fs.readdirSync(path.dirname(mf)).some((n) => n.startsWith("migration.json.corrupt-")), "quarantined");
    assert.equal(fs.existsSync(mf), false);
    assert.equal(fs.readFileSync(victim, "utf8"), "keep");
    assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), settingsBefore, "no settings write");
  }
  fs.symlinkSync(victim, mf);
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 1, "a symlinked manifest is refused");
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
});

test("T-MIG-7: rollback restores every resource; a second rollback is a no-op; modified config is skipped", async () => {
  const { c, claude } = authorShaped();
  const settingsBefore = settings(c);
  const claudeMdBefore = fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8");
  await main(["migrate", "--yes", "--skip-doctor-gate", "--force-engine-move"], io());
  fs.writeFileSync(path.join(c, "settings.json"), JSON.stringify({ ...settings(c), addedLater: 1 }));
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  const s = settings(c);
  assert.deepEqual(s.hooks, settingsBefore.hooks);
  assert.deepEqual(s.permissions.ask, settingsBefore.permissions.ask);
  assert.equal(s.addedLater, 1, "rollback is a read-modify-write, not a byte restore");
  assert.ok(claude.log().some((a) => a.join(" ").startsWith("plugin uninstall review-loop@review-loop")));
  assert.ok(fs.existsSync(path.join(c, "skills", "review-loop", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(c, "review-loop", "plugin-pin.json")));
  assert.ok(fs.existsSync(path.join(c, "review-loop", "review-gate-hook.mjs")));
  assert.equal(fs.existsSync(process.env.REVIEW_LOOP_CONFIG), false);
  assert.equal(fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8"), claudeMdBefore);
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0, "idempotent");

  const second = authorShaped();
  await main(["migrate", "--yes", "--skip-doctor-gate"], io());
  await main(["config", "set", "preset", "advisory"], io());
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 1);
  assert.equal(JSON.parse(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8")).preset, "advisory", "modified config left alone");
  void second;
});
```

  `--skip-doctor-gate` and `--force-engine-move` are **test seams**, honored only with
  `REVIEW_LOOP_TEST_SEAMS=1`, which the test file sets at its top (above). `SEAMS` in `migrate.mjs`
  is read at module load, so it must be set before the dynamic import. In the sandbox the fake `claude`
  can't make `doctor` pass. `--skip-doctor-gate` keeps the engine dir in place without failing;
  `--force-engine-move` moves it anyway, so rollback's step 1 is exercised.

- [ ] **Step 2a: Extract `atomicWriteText` in `plugin/engine/lib/fsutil.mjs`**

  Rollback restores the config's exact before-bytes, which `atomicWriteJson` would re-format. Rename
  the body of `atomicWriteJson` to `atomicWriteText(file, text, within)`, writing `text` verbatim. Then
  make the JSON writer a one-line delegate, so there is still one write-then-rename implementation:

```js
/** Write-then-rename of exact bytes (see atomicWriteText for the link-swap discussion). */
export function atomicWriteJson(file, value, within) {
  atomicWriteText(file, JSON.stringify(value, null, 2) + "\n", within);
}
```

  In the moved body, the only line that changes is the write:
  `fs.writeSync(fd, text);` replaces `fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n");`.

  Run: `(set -o pipefail; npm test 2>&1 | tail -3)`

  Expected: `# fail 0`. The existing engine tests pin `atomicWriteJson`'s behavior unchanged.

- [ ] **Step 2: Implement `cli/lib/migrate.mjs`**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { installPlugin, installedPlugin, MARKETPLACE_NAME, PLUGIN_ID } from "./plugin.mjs";
import { runTool } from "./run.mjs";
import { ASK_RULES, LEGACY_HOOK_RE, readSettings, updateSettings } from "./settings.mjs";
import { run as doctor } from "./doctor.mjs";
import { configPath, isConfig, readConfig, writeConfig } from "../../plugin/engine/lib/config.mjs";
import { atomicWriteJson, atomicWriteText, safeReadFile, sha256hex } from "../../plugin/engine/lib/fsutil.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";
import { stateRoot } from "../../plugin/engine/lib/paths.mjs";

const SEAMS = process.env.REVIEW_LOOP_TEST_SEAMS === "1";
const C = () => path.join(os.homedir(), ".claude");
const manifestPath = () => path.join(stateRoot(), "migration.json");
const shaOf = (/** @type {string} */ f) => (fs.existsSync(f) ? sha256hex(fs.readFileSync(f)) : null);
const OLD_REF = "~/.claude/review-loop/CLAUDE.md";
const claudeMdBackup = (/** @type {string} */ ts) => path.join(C(), `CLAUDE.md.review-loop-backup-${ts}`);
/**
 * Temp-then-rename in the file's own directory, keeping its mode. Rename replaces the directory entry, so a link
 * swapped in meanwhile is replaced, not followed. Not atomicWriteText: that tightens its `within` dir to 0700, and
 * ~/.claude is the user's directory, not review-loop's.
 * @param {string} file @param {string} text @param {number} mode
 */
function replaceInPlace(file, text, mode) {
  const tmp = `${file}.review-loop-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode, flag: "wx" });
  try { fs.renameSync(tmp, file); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}
/** Every path rollback touches, derived from fixed roots and the validated date — never read from the manifest. */
const rollbackPaths = (/** @type {string} */ date) => {
  const archive = path.join(C(), `review-loop-legacy-${date}`);
  return { engine: path.join(C(), "review-loop"), engineArchived: path.join(archive, "engine"), skill: path.join(C(), "skills", "review-loop"), skillArchived: path.join(archive, "skill"), legacyPin: path.join(C(), "review-loop", "plugin-pin.json"), pin: path.join(stateRoot(), "plugin-pin.json") };
};
const NEW_REF = "the `review-loop` plugin (`review-loop doctor`; repo `<owner>/review-loop`)";

/** @typedef {{ resource: string, action: string, before: Record<string, unknown>, after: Record<string, unknown>, removedHooks?: Array<{ event: string, index: number, group: unknown }>, addedAsk?: string[] }} Step */

const MANIFEST_MAX_BYTES = 1024 * 1024;
const RESOURCES = ["settings", "plugin", "marketplace", "skill", "pin", "config", "claude_md", "engine_dir"];
// Exactly the shape the legacy install wrote. A restored hook can only ever be one of these six commands, so an edited manifest can't inject a hook.
const LEGACY_COMMAND_RE = /^node [^\s;&|`$()<>'"\\]+\/\.claude\/review-loop\/review-gate-hook\.mjs (pr|session|track|stop|prompt)$/;
/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** @param {unknown} h */
const isLegacyHook = (h) => isObj(h) && h.type === "command" && typeof h.command === "string" && LEGACY_COMMAND_RE.test(h.command);

/** @param {unknown} r */
function isRemovedHook(r) {
  if (!isObj(r) || typeof r.event !== "string" || !/^[A-Za-z]{1,32}$/.test(r.event)) return false;
  if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0 || r.index >= 256) return false;
  const g = r.group;
  return isObj(g) && Array.isArray(g.hooks) && g.hooks.length > 0 && g.hooks.every(isLegacyHook);
}

/** @param {unknown} s untrusted until this returns true @returns {s is Step} */
function isStep(s) {
  if (!isObj(s) || typeof s.resource !== "string" || !RESOURCES.includes(s.resource) || typeof s.action !== "string") return false;
  const { before, after } = s;
  if (!isObj(before) || !isObj(after)) return false;
  if (s.resource === "settings") {
    const { removedHooks, addedAsk } = s;
    return Array.isArray(removedHooks) && removedHooks.length <= 16 && removedHooks.every(isRemovedHook) &&
      Array.isArray(addedAsk) && addedAsk.every((a) => typeof a === "string" && ASK_RULES.includes(a));
  }
  if (s.resource === "config") {
    if (before.absent === true) return true;
    const bytes = before.bytes;
    if (typeof bytes !== "string" || bytes.length > 65536) return false;
    try { return isConfig(JSON.parse(bytes)); } catch { return false; }
  }
  if (s.resource === "claude_md") return isSha(after.sha) && typeof before.backupTs === "string" && /^\d{10,16}$/.test(before.backupTs);
  if (s.resource === "pin") return isSha(before.sha);
  return true; // plugin, skill, engine_dir: rollback derives their paths and never reads a path from the manifest.
}

/** @typedef {{ v: 1, status: string, date: string, steps: Step[] }} Manifest */

/** @param {unknown} m @returns {m is Manifest} */
function isManifest(m) {
  return isObj(m) && m.v === 1 && typeof m.status === "string" && ["in_progress", "done", "rolled_back"].includes(m.status) &&
    typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date) && Array.isArray(m.steps) && m.steps.length <= 32 && m.steps.every(isStep);
}

/** Absent → null. Anything else that is not a valid manifest is quarantined and refused, never acted on. */
function readManifest() {
  const f = manifestPath();
  const unreadable = () => new CliError("migration_manifest_unreadable", "could not read the migration record; nothing was changed");
  let st;
  try {
    st = fs.lstatSync(f);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw unreadable();
  }
  const refuse = () => {
    fs.renameSync(f, `${f}.corrupt-${Date.now()}`);
    throw new CliError("migration_manifest_invalid", "the migration record is damaged; it was set aside and nothing was changed");
  };
  void st;
  try { fs.accessSync(f, fs.constants.R_OK); } catch { throw unreadable(); }  // permissions are not corruption: never quarantine for them
  // The engine's safeReadFile does the check-then-read safely: lstat, O_NOFOLLOW open, fstat on THAT descriptor
  // (type and size), bounded read, and refusal if the file grows mid-read — a link or a huge file swapped in after
  // the checks above is never followed or buffered.
  let text;
  try {
    text = safeReadFile(f, MANIFEST_MAX_BYTES, { symlink: "migration_manifest_invalid", linkedParent: "migration_manifest_invalid", notFile: "migration_manifest_invalid", tooLarge: "migration_manifest_invalid", missing: "migration_manifest_unreadable" }, { within: stateRoot() }).toString("utf8");
  } catch (err) {
    if (err instanceof ReviewLoopError && err.code === "migration_manifest_invalid") return refuse();
    throw unreadable();  // vanished between the checks, or an I/O error
  }
  /** @type {unknown} */
  let m;
  try { m = JSON.parse(text); } catch { return refuse(); }
  return isManifest(m) ? m : refuse();
}
/** @param {{ v: 1, status: string, date: string, steps: Step[] }} m */
const saveManifest = (m) => atomicWriteJson(manifestPath(), m, stateRoot());

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
export async function run(args, io, ctx) {
  if (!io.isTTY && !ctx.yes) throw new CliError("usage_noninteractive", "migrate needs a terminal, or --yes");
  return args.includes("--rollback") ? rollback(io, ctx) : migrate(args, io, ctx);
}

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
async function migrate(args, io, ctx) {
  const legacySkill = path.join(C(), "skills", "review-loop");
  const legacyEngine = path.join(C(), "review-loop");
  const legacyPin = path.join(legacyEngine, "plugin-pin.json");
  const hasLegacyHooks = (() => { try { return JSON.stringify(readSettings().obj.hooks ?? {}).match(LEGACY_HOOK_RE) !== null; } catch { return false; } })();
  if (!hasLegacyHooks && !fs.existsSync(legacySkill) && !fs.lstatSync(legacyPin, { throwIfNoEntry: false })) { io.err("Nothing to migrate.\n"); return { code: "ok" }; }
  const date = new Date().toISOString().slice(0, 10);
  const archive = path.join(C(), `review-loop-legacy-${date}`);
  /** @type {{ v: 1, status: string, date: string, steps: Step[] }} */
  const m = { v: 1, status: "in_progress", date, steps: [] };
  const record = (/** @type {Step} */ s) => { m.steps.push(s); saveManifest(m); };

  // 3 plugin first: if it fails, the old gate stays in force and settings are untouched.
  const had = await installedPlugin(PLUGIN_ID).catch(() => null);
  if (!had) { record({ resource: "plugin", action: "install", before: { absent: true }, after: {} }); await installPlugin(); }

  // 2+4 one settings write: remove legacy hook objects, ensure ask rules (the backup is made by the commit).
  /** @type {Array<{ event: string, index: number, group: unknown }>} */
  const removed = [];
  /** @type {string[]} */
  const added = [];
  const settingsStep = { resource: "settings", action: "swap_hooks", before: {}, after: {}, removedHooks: removed, addedAsk: added };
  record(settingsStep);
  await updateSettings((o) => {
    removed.length = 0; added.length = 0;
    const hooks = /** @type {Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>} */ (o.hooks ?? {});
    for (const [event, groups] of Object.entries(hooks)) {
      hooks[event] = groups.filter((g, index) => {
        const legacy = (g.hooks ?? []).some((h) => LEGACY_HOOK_RE.test(String(h.command ?? "")));
        if (legacy) removed.push({ event, index, group: g });
        return !legacy;
      });
    }
    const perms = /** @type {Record<string, unknown>} */ (o.permissions ??= {});
    const ask = /** @type {string[]} */ (Array.isArray(perms.ask) ? perms.ask : (perms.ask = []));
    for (const r of ASK_RULES) if (!ask.includes(r)) { ask.push(r); added.push(r); }
    // Persisted before updateSettings commits, so a crash after the rename still leaves rollback what it removed.
    saveManifest(m);
    return removed.length > 0 || added.length > 0;
  }, { io, yes: ctx.yes });

  // 5 pin
  const newPin = path.join(stateRoot(), "plugin-pin.json");
  if (fs.lstatSync(legacyPin, { throwIfNoEntry: false }) && !fs.existsSync(newPin)) {
    // Untrusted legacy file: no-follow, bounded read, structural check, then a private atomic write. A link, an
    // oversized or a malformed pin is left where it is (setup re-pins), never followed or copied.
    /** @type {Buffer | null} */
    let bytes = null;
    try {
      bytes = safeReadFile(legacyPin, 64 * 1024, { symlink: "legacy_pin_invalid", linkedParent: "legacy_pin_invalid", notFile: "legacy_pin_invalid", tooLarge: "legacy_pin_invalid", missing: "legacy_pin_invalid" }, { within: C() });
      /** @type {unknown} */
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (!isObj(parsed) || typeof parsed.version !== "string") bytes = null;
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      io.err("The old Codex-plugin pin is not a regular, valid pin file, so it was left in place and not migrated. `review-loop setup` will pin the Codex plugin again.\n");
    } else {
      record({ resource: "pin", action: "move", before: { sha: sha256hex(bytes) }, after: {} });
      atomicWriteText(newPin, bytes.toString("utf8"), stateRoot());
      if (shaOf(newPin) !== sha256hex(bytes)) throw new CliError("unexpected_error", "pin copy did not verify");
      fs.rmSync(legacyPin);
    }
  }

  // 6 rubric
  const personal = path.join(C(), "rules", "multi-dimension-review.md");
  if (fs.existsSync(personal)) {
    // Snapshot BEFORE writing, and persist the undo step before the mutation; `after.sha` is filled in once the write lands.
    const beforeBytes = fs.existsSync(configPath()) ? fs.readFileSync(configPath(), "utf8") : null;
    /** @type {Step} */
    const step = { resource: "config", action: "set_rubric", before: beforeBytes === null ? { absent: true } : { sha: sha256hex(beforeBytes), bytes: beforeBytes }, after: {} };
    record(step);
    writeConfig({ ...readConfig().config, rubricPath: personal });
    step.after = { sha: shaOf(configPath()) };
    saveManifest(m);
  }

  // 7 skill out of ~/.claude/skills (a renamed folder there would still load)
  if (fs.existsSync(legacySkill)) {
    record({ resource: "skill", action: "move", before: { path: legacySkill }, after: { path: path.join(archive, "skill") } });
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(legacySkill, path.join(archive, "skill"));
  }

  // 8 global CLAUDE.md — only on yes
  const md = path.join(C(), "CLAUDE.md");
  const mdSt = fs.lstatSync(md, { throwIfNoEntry: false });
  if (mdSt?.isSymbolicLink()) {
    // Never write through a link (it may point anywhere); the edit is optional, so show it for the user to apply.
    io.err(`\n~/.claude/CLAUDE.md is a symlink, so review-loop won't edit it. To update it yourself, replace:\n- ${OLD_REF}\n+ ${NEW_REF}\n`);
  } else if (mdSt?.isFile() && mdSt.size <= 1024 * 1024 && fs.readFileSync(md, "utf8").includes(OLD_REF)) {
    io.err(`\nProposed CLAUDE.md change:\n- ${OLD_REF}\n+ ${NEW_REF}\n`);
    if (ctx.yes || (await io.ask("Apply this change to ~/.claude/CLAUDE.md?", false))) {
      const before = fs.readFileSync(md, "utf8");
      const backupTs = String(Date.now());
      const after = before.replaceAll(OLD_REF, NEW_REF);
      record({ resource: "claude_md", action: "edit", before: { sha: sha256hex(before), backupTs }, after: { sha: sha256hex(after) } });
      fs.writeFileSync(claudeMdBackup(backupTs), before, { mode: 0o600, flag: "wx" });
      replaceInPlace(md, after, mdSt.mode & 0o777);
    }
  }

  // 9 doctor gate, then the legacy engine dir
  const skipGate = SEAMS && args.includes("--skip-doctor-gate");
  const force = SEAMS && args.includes("--force-engine-move");
  const d = skipGate || force ? { code: force ? "ok" : "skip" } : await doctor([], io, { json: false });
  if (d.code === "ok" && fs.existsSync(legacyEngine)) {
    record({ resource: "engine_dir", action: "move", before: { path: legacyEngine }, after: { path: path.join(archive, "engine") } });
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(legacyEngine, path.join(archive, "engine"));
  }
  m.status = "done";
  saveManifest(m);
  io.err("\nMigrated. To undo: review-loop migrate --rollback\nVerify with a live round: review-loop doctor --live\n");
  if (d.code !== "ok" && !skipGate) throw new CliError("preflight_failed", "doctor found problems; the legacy engine folder was left in place");
  return { code: "ok" };
}

/** @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
async function rollback(io, ctx) {
  const m = readManifest();
  if (!m || m.status === "rolled_back") { io.err("Nothing to roll back.\n"); return { code: "ok" }; }
  const P = rollbackPaths(m.date);
  /** @type {string[]} */
  const skipped = [];
  for (const s of [...m.steps].reverse()) {
    if (s.resource === "engine_dir" && fs.existsSync(P.engineArchived) && !fs.existsSync(P.engine)) fs.renameSync(P.engineArchived, P.engine);
    if (s.resource === "settings") {
      await updateSettings((o) => {
        let changed = false;
        const hooks = /** @type {Record<string, unknown[]>} */ (o.hooks ??= {});
        // Ascending original index restores each group to its original position among the survivors.
        for (const r of [...(s.removedHooks ?? [])].sort((a, b) => a.index - b.index)) {
          const list = (hooks[r.event] ??= []);
          if (!list.some((g) => JSON.stringify(g) === JSON.stringify(r.group))) { list.splice(Math.min(r.index, list.length), 0, r.group); changed = true; }
        }
        const ask = /** @type {{ permissions?: { ask?: string[] } }} */ (o).permissions?.ask;
        if (Array.isArray(ask)) {
          const keep = ask.filter((x) => !(s.addedAsk ?? []).includes(x));
          if (keep.length !== ask.length) { /** @type {{ permissions: { ask: string[] } }} */ (o).permissions.ask = keep; changed = true; }
        }
        return changed;
      }, { io, yes: ctx.yes });
    }
    if (s.resource === "plugin") {
      if (await installedPlugin(PLUGIN_ID).catch(() => null)) await runTool("claude", ["plugin", "uninstall", PLUGIN_ID, "--scope", "user", "--json"]);
      await runTool("claude", ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
    }
    if (s.resource === "skill" && fs.existsSync(P.skillArchived) && !fs.existsSync(P.skill)) fs.renameSync(P.skillArchived, P.skill);
    if (s.resource === "pin" && fs.existsSync(P.pin) && !fs.existsSync(P.legacyPin)) {
      // Only the pin migrate moved goes back. A pin re-written since (setup, repin) stays where it is.
      if (shaOf(P.pin) !== s.before.sha) { skipped.push("pin (changed after migration)"); continue; }
      fs.mkdirSync(path.dirname(P.legacyPin), { recursive: true });
      fs.renameSync(P.pin, P.legacyPin);
    }
    if (s.resource === "config") {
      if (typeof s.after.sha !== "string" || shaOf(configPath()) !== s.after.sha) { if (fs.existsSync(configPath())) skipped.push("config (rubricPath)"); continue; }
      if (s.before.absent) fs.rmSync(configPath(), { force: true });
      else atomicWriteText(configPath(), String(s.before.bytes), path.dirname(configPath()));
    }
    if (s.resource === "claude_md") {
      const md = path.join(C(), "CLAUDE.md");
      const cur = fs.lstatSync(md, { throwIfNoEntry: false });
      if (!cur?.isFile() || shaOf(md) !== s.after.sha) { skipped.push("CLAUDE.md"); continue; }  // a link or a changed file is left alone
      const backup = claudeMdBackup(String(s.before.backupTs));
      if (!fs.lstatSync(backup, { throwIfNoEntry: false })?.isFile()) { skipped.push("CLAUDE.md (backup missing)"); continue; }
      replaceInPlace(md, fs.readFileSync(backup, "utf8"), cur.mode & 0o777);
    }
  }
  m.status = "rolled_back";
  saveManifest(m);
  if (skipped.length) throw new CliError("rollback_skipped_modified", `changed after migration, left as-is: ${skipped.join(", ")}`);
  io.err("Rolled back.\n");
  return { code: "ok" };
}
```

  **Check the legacy engine's stub before moving it** (T-MIG-6). The sandbox legacy engine is only a
  stub file; the real one is the full engine.

  **In the T-MIG-7 idempotence call,** the manifest `status` is already `rolled_back`, so rollback
  returns "Nothing to roll back" with exit 0.

  **In the second T-MIG-7 scenario,** `config set preset advisory` changes the config's sha, so
  rollback skips `config` → exit 1, and the preset stays `advisory`.

- [ ] **Step 3: Run and commit**

  Run: `(set -o pipefail; node --test test/cli/migrate.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

```bash
git add cli/lib/migrate.mjs test/cli/migrate.test.mjs
git commit -m "feat(cli): migrate with a manifest-driven, guarded, idempotent rollback"
```

**Gate:** sabotage.
- Restore settings by byte copy of the backup; T-MIG-7's `addedLater` assertion goes red. Revert.
- Skip the plugin uninstall in rollback; the argv assertion goes red. Revert.

---

### Task 23: `selftest` (the `brew test` payload)

**Files:**
- Create: `cli/lib/selftest.mjs`
- Test: `test/cli/selftest.test.mjs`

**Interfaces:**
- `run(args, io, ctx)` → `{code:"ok"}` or `CliError("unexpected_error", "<which assertion failed>")`,
  which is exit 4.
- It is offline. It uses a temp `HOME`, state, config and git repo, plus the **bundled** engine
  (`../../plugin/engine/review-gate-hook.mjs`, relative to `cli/lib/`).

- [ ] **Step 1: Write the failing test**

```js
// test/cli/selftest.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.join(process.cwd(), "cli", "review-loop.mjs");

test("T-REL-3: selftest passes offline", () => {
  const r = spawnSync(process.execPath, [BIN, "selftest", "--json"], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin:" + path.dirname(process.execPath) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).code, "ok");
});

test("T-REL-3 (−): a broken Stop block makes selftest fail with exit 4", () => {
  const hook = path.join(process.cwd(), "plugin", "engine", "review-gate-hook.mjs");
  const orig = fs.readFileSync(hook, "utf8");
  fs.writeFileSync(hook, orig.replace('decision: "block"', 'decision: "approve"'));
  try {
    const r = spawnSync(process.execPath, [BIN, "selftest", "--json"], { encoding: "utf8" });
    assert.equal(r.status, 4);
  } finally {
    fs.writeFileSync(hook, orig);
  }
});
```

- [ ] **Step 2: Implement `cli/lib/selftest.mjs`**

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";

const HOOK = fileURLToPath(new URL("../../plugin/engine/review-gate-hook.mjs", import.meta.url));
const G = "g" + "h";

export async function run() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rl-selftest-")));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const git = (/** @type {string} */ cwd, /** @type {string[]} */ a) => spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" });
  const hook = (/** @type {string} */ mode, /** @type {Record<string, unknown>} */ input) => spawnSync(process.execPath, [HOOK, mode], { env, input: JSON.stringify(input), encoding: "utf8" }).stdout;
  const expect = (/** @type {boolean} */ ok, /** @type {string} */ what) => { if (!ok) throw new CliError("unexpected_error", `selftest: ${what}`); };
  try {
    const repo = path.join(home, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-q"]);
    fs.writeFileSync(path.join(repo, "README.md"), "x");
    git(repo, ["add", "README.md"]); git(repo, ["commit", "-qm", "init"]);
    const clean = path.join(home, "clean");
    fs.mkdirSync(clean);
    git(clean, ["init", "-q"]);
    fs.writeFileSync(path.join(clean, "README.md"), "x");
    git(clean, ["add", "README.md"]); git(clean, ["commit", "-qm", "init"]);

    hook("session", { session_id: "st-1", cwd: repo });
    const spec = path.join(repo, "docs", "specs", "x-design.md");
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, "# x\n");
    hook("track", { session_id: "st-1", cwd: repo, tool_input: { file_path: spec } });
    expect(/"decision":"block"/.test(hook("stop", { session_id: "st-1", cwd: repo, stop_hook_active: false })), "Stop did not block an unreviewed spec");
    expect(/"permissionDecision":"deny"/.test(hook("pr", { session_id: "st-1", cwd: repo, tool_name: "Bash", tool_input: { command: `${G} pr create --title t` } })), "the PR gate did not deny");
    hook("session", { session_id: "st-2", cwd: clean });
    expect(!/"decision"/.test(hook("stop", { session_id: "st-2", cwd: clean, stop_hook_active: false })), "Stop blocked a clean repo");
    const lines = fs.readFileSync(path.join(home, "state", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length > 0 && lines.every((l) => validateLine(l).length === 0), "events.jsonl is not schema v1");
    return { code: "ok" };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
```

  **The `pr` case has no GitHub remote,** so the gate denies with `pr_args_unresolvable` or
  `pr_base_repo_ambiguous`. That is still a deny, and a deny is what selftest checks: the PR gate is
  wired and fails closed.

- [ ] **Step 3: Run and commit**

  Run: `(set -o pipefail; node --test test/cli/selftest.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

```bash
git add cli/lib/selftest.mjs test/cli/selftest.test.mjs
git commit -m "feat(cli): offline selftest for brew test"
```

**Gate:** T-REL-3 (−) is itself the sabotage test.

---
## Phase 4: release, dogfood and publish

### Task 24: Content gate, generated README tables, README, and the content-discipline corpus

**Files:**
- Create: `package.files.json`, `scripts/content-gate.mjs`, `scripts/gen-readme-tables.mjs`, `README.md`
- Test: `test/contract/content-gate.test.mjs`, `test/contract/readme.test.mjs`,
  `test/contract/content-discipline.test.mjs`

**Interfaces:**
- Consumes: `CODES`, `CLI_EXIT` and `exitFor` (Task 7); `validateLine` (Task 7); `makeFakeBin` (Task 12).
- Produces:
  - `package.files.json`, which is `{ "files": string[] }`. An entry ending in `/` is a directory prefix;
    any other entry is an exact file.
  - `node scripts/content-gate.mjs` checks the repo's packaged set, which is `git ls-files` ∩ the
    allowlist.
  - `node scripts/content-gate.mjs --dir <d>` checks an extracted tarball.
  - `node scripts/content-gate.mjs --list` prints the packaged set, one path per line; the release
    `git archive` uses it.
  - `node scripts/gen-readme-tables.mjs [--check] [--readme <path>]`.

**Invariants (§10.2, §8.4):**
- A failure prints `content-gate: FAIL <file>:<line> rule=<name>`, **never the matched text**. Exit 1.
- **Package files are untrusted input** (`untrusted-io-and-resource-bounds`). Each is `lstat`ed before
  it is read. A symlink is a finding (`rule=symlink`) and is never followed or descended into; a
  non-regular file is `rule=not_regular`; a file over 2 MiB is `rule=too_large` and is not read. Reads go
  through an `O_NOFOLLOW` descriptor.
- In `--dir` mode, a file outside the allowlist fails with `rule=unlisted`. In both modes, an allowlist
  entry that matches no file fails with `rule=missing`.
- **Recorded exemptions (a deviation from §10.2):**
  - **The LICENSE copyright line** (`^Copyright \(c\) \d{4} `). The copyright holder is public by
    intent.
  - **The repo coordinates** `<owner>/review-loop`, `<owner>/homebrew-tap` and `<owner>/tap`, where
    `<owner>` is read from `package.json` `repository.url` (Task 28 sets it; until then it is the
    literal `<owner>`).
  - Why: if D1 names an account whose slug matches a denylisted word, the product's own install
    command would otherwise fail the gate.
  - Each exemption strips only its exact string before matching. Any other occurrence on the line
    still fails.

- [ ] **Step 1: Write `package.files.json`**

```json
{ "files": ["LICENSE", "README.md", "package.json", ".claude-plugin/marketplace.json", "plugin/", "cli/"] }
```

- [ ] **Step 2: Write the failing gate tests**

```js
// test/contract/content-gate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";

const GATE = path.resolve("scripts/content-gate.mjs");
const run = (...a) => spawnSync(process.execPath, [GATE, ...a], { encoding: "utf8" });

/** A minimal package tree that satisfies the allowlist. */
function pkg() {
  const d = tmpDir();
  for (const f of ["LICENSE", "README.md", "package.json", ".claude-plugin/marketplace.json", "plugin/x.mjs", "cli/y.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), f === "package.json" ? "{}" : f === "LICENSE" ? "MIT License\n\nCopyright (c) 2026 Some Holder\n" : "clean\n");
  }
  return d;
}

test("T-REL-1 (+): the real repo's packaged set passes", () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("T-REL-1 (+): a clean extracted package passes", () => {
  assert.equal(run("--dir", pkg()).status, 0);
});

for (const [rule, text] of [["users_path", "see /Users/x/notes"], /* one entry per private-name rule (the author's handle and private org and project names, kept in a private denylist) */ ["personal_rules", "~/.claude/rules/x.md"], ["email", "mail real.person@gmail.com"]]) {
  test(`T-REL-1 (−): ${rule} fails, naming file and rule but not the content`, () => {
    const d = pkg();
    fs.writeFileSync(path.join(d, "cli/y.mjs"), `ok\n${text}\n`);
    const r = run("--dir", d);
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`FAIL cli/y\\.mjs:2 rule=${rule}`));
    assert.ok(!r.stdout.includes(text) && !r.stderr.includes(text), "matched text is never printed");
  });
}

test("T-REL-1: @example.com fixtures and the LICENSE holder line are allowed", () => {
  const d = pkg();
  fs.writeFileSync(path.join(d, "cli/y.mjs"), "t@example.com\n");
  assert.equal(run("--dir", d).status, 0);
});

test("T-REL-2 (−): a symlink is a finding and its target is never read; an oversized file is refused unread", () => {
  const d = pkg();
  const outside = path.join(tmpDir(), "host-secret.txt");
  fs.writeFileSync(outside, "/Users/someone/.ssh/id_rsa\n");
  fs.symlinkSync(outside, path.join(d, "cli/linked.mjs"));
  const r = run("--dir", d);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL cli\/linked\.mjs rule=symlink/);
  assert.doesNotMatch(r.stdout, /users_path/, "the link target's content was not scanned");
  const e = pkg();
  fs.writeFileSync(path.join(e, "cli/huge.mjs"), "x".repeat(2 * 1024 * 1024 + 1));
  assert.match(run("--dir", e).stdout, /FAIL cli\/huge\.mjs rule=too_large/);
  const g = pkg();
  fs.symlinkSync(path.join(g, "plugin"), path.join(g, "cli/loop"));
  assert.match(run("--dir", g).stdout, /FAIL cli\/loop rule=symlink/, "a directory link is not descended into");
});

test("T-REL-2 (−): an unlisted file fails; a missing allowlisted file fails", () => {
  const d = pkg();
  fs.writeFileSync(path.join(d, "extra.txt"), "x");
  assert.match(run("--dir", d).stdout, /FAIL extra\.txt rule=unlisted/);
  const e = pkg();
  fs.rmSync(path.join(e, "LICENSE"));
  assert.match(run("--dir", e).stdout, /FAIL LICENSE rule=missing/);
});

test("--list prints only allowlisted, tracked files", () => {
  const files = run("--list").stdout.trim().split("\n");
  assert.ok(files.includes("cli/review-loop.mjs"));
  assert.ok(files.every((f) => !f.startsWith("test/") && !f.startsWith("scripts/") && !f.startsWith("docs/")));
});
```

  Run: `node --test test/contract/content-gate.test.mjs`

  Expected: FAIL, "Cannot find module … content-gate.mjs".

- [ ] **Step 3: Implement `scripts/content-gate.mjs`**

```js
#!/usr/bin/env node
// The no-personal-content gate (spec §10.2). It prints file, line and rule — never the matched text.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ALLOW = /** @type {{ files: string[] }} */ (JSON.parse(fs.readFileSync(path.join(ROOT, "package.files.json"), "utf8"))).files;
const RULES = [
  { name: "users_path", re: /\/Users\//i },
  // ...one rule per private name: the author's handle and private org and project names (kept in a private denylist)
  { name: "personal_rules", re: /~\/\.claude\/rules\//i },
  { name: "email", re: /[A-Z0-9._%+-]+@(?!example\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}/i }
];

function owner() {
  try {
    const url = /** @type {{ repository?: { url?: string } }} */ (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))).repository?.url ?? "";
    return /github\.com\/([^/]+)\//.exec(url)?.[1] ?? "<owner>";
  } catch { return "<owner>"; }
}
const OWNER = owner();
const COORDS = [`${OWNER}/review-loop`, `${OWNER}/homebrew-tap`, `${OWNER}/tap`];

const allowed = (/** @type {string} */ f) => ALLOW.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a));
const covers = (/** @type {string} */ a, /** @type {string[]} */ files) => files.some((f) => (a.endsWith("/") ? f.startsWith(a) : f === a));

/** Every entry that is not a real directory, links included (they are rejected below, never followed). @param {string} dir */
function walk(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Untrusted package content: lstat first (a link is a finding, never followed), bound before buffering, and read
 * through an O_NOFOLLOW descriptor so a link swapped in after the lstat fails the open.
 * @param {string} abs @returns {{ ok: true, buf: Buffer } | { ok: false, rule: "symlink" | "not_regular" | "too_large" }}
 */
function readBounded(abs) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return { ok: false, rule: "symlink" };
  if (!st.isFile()) return { ok: false, rule: "not_regular" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, rule: "too_large" };
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return { ok: true, buf: buf.subarray(0, n) };
  } finally {
    fs.closeSync(fd);
  }
}

const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
const base = dirIdx === -1 ? ROOT : path.resolve(args[dirIdx + 1]);
const all = dirIdx === -1 ? execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean) : walk(base);
const files = all.filter(allowed).sort();

if (args.includes("--list")) { process.stdout.write(`${files.join("\n")}\n`); process.exit(0); }

/** @type {string[]} */
const failures = [];
if (dirIdx !== -1) for (const f of all.filter((f) => !allowed(f))) failures.push(`FAIL ${f} rule=unlisted`);
for (const a of ALLOW) if (!covers(a, files)) failures.push(`FAIL ${a} rule=missing`);
for (const f of files) {
  const r = readBounded(path.join(base, f));
  if (!r.ok) { failures.push(`FAIL ${f} rule=${r.rule}`); continue; }
  const buf = r.buf;
  if (buf.includes(0)) continue;
  buf.toString("utf8").split("\n").forEach((raw, i) => {
    if (f === "LICENSE" && /^Copyright \(c\) \d{4} /.test(raw)) return;
    let line = raw;
    for (const c of COORDS) line = line.split(c).join("");
    for (const r of RULES) if (r.re.test(line)) failures.push(`FAIL ${f}:${i + 1} rule=${r.name}`);
  });
}
if (failures.length) { process.stdout.write(`${failures.join("\n")}\ncontent-gate: ${failures.length} finding(s)\n`); process.exit(1); }
process.stdout.write(`content-gate: ok (${files.length} files)\n`);
```

  Binary files are skipped by a NUL-byte check. The package has none today; if one is added, the
  `missing`/`unlisted` checks still apply to it.

  Run: `node --test test/contract/content-gate.test.mjs`

  Expected: PASS. If T-REL-1 (+) on the real repo fails, fix the **named file**; never add a new
  exemption. Likely hits are the engine's `SKILL.md`/`CLAUDE.md` references carried over from the
  author's setup, and they must be made generic.

- [ ] **Step 4: Write the failing README test (T-OBS-8)**

```js
// test/contract/readme.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";

const GEN = path.resolve("scripts/gen-readme-tables.mjs");

test("T-OBS-8 (+): the committed README's generated tables are current", () => {
  const r = spawnSync(process.execPath, [GEN, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("T-OBS-8 (−): a hand-edited remedy fails --check", () => {
  const copy = path.join(tmpDir(), "README.md");
  fs.writeFileSync(copy, fs.readFileSync("README.md", "utf8").replace("brew install node", "brew install nodejs"));
  const r = spawnSync(process.execPath, [GEN, "--check", "--readme", copy], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /README tables are stale/);
});
```

- [ ] **Step 5: Implement `scripts/gen-readme-tables.mjs`**

```js
#!/usr/bin/env node
// README exit-code and troubleshooting tables are generated from plugin/engine/lib/codes.mjs (spec §8.3).
import fs from "node:fs";
import path from "node:path";
import { CODES, CLI_EXIT, exitFor } from "../plugin/engine/lib/codes.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const ri = args.indexOf("--readme");
const readme = ri === -1 ? path.join(ROOT, "README.md") : path.resolve(args[ri + 1]);

const EXIT_TEXT = { ok: "success", user_action: "needs your action (see the troubleshooting table)", usage: "wrong command or flag", cancelled: "you cancelled (Ctrl-C or answered no)", internal: "internal error — please report a bug" };
const esc = (/** @type {string} */ s) => s.replaceAll("|", "\\|");

const exits = ["| Exit | Meaning |", "|---|---|", ...Object.entries(CLI_EXIT).map(([k, v]) => `| ${v} | ${EXIT_TEXT[/** @type {keyof typeof EXIT_TEXT} */ (k)]} |`)].join("\n");
const trouble = ["| Code | Exit | What to do | Details |", "|---|---|---|---|", ...Object.entries(CODES).filter(([, m]) => m.category !== "ok").sort(([a], [b]) => a.localeCompare(b)).map(([c, m]) => `| \`${c}\` | ${exitFor(c)} | ${esc(m.remedy)} | ${(m.details ?? []).map((d) => `\`${d}\``).join(", ")} |`)].join("\n");

/** @param {string} text @param {string} name @param {string} body */
function splice(text, name, body) {
  const re = new RegExp(`(<!-- ${name}:start -->\\n)[\\s\\S]*?(\\n<!-- ${name}:end -->)`);
  if (!re.test(text)) { process.stdout.write(`README is missing the ${name} markers\n`); process.exit(1); }
  return text.replace(re, `$1${body}$2`);
}

const before = fs.readFileSync(readme, "utf8");
const after = splice(splice(before, "exit-codes", exits), "troubleshooting", trouble);
if (args.includes("--check")) {
  if (after !== before) { process.stdout.write("README tables are stale: run `node scripts/gen-readme-tables.mjs`\n"); process.exit(1); }
  process.stdout.write("README tables are current\n");
} else fs.writeFileSync(readme, after);
```

- [ ] **Step 6: Write `README.md`, then generate its tables**

```markdown
# review-loop

Claude Code can't finish a spec, a plan or a code change, or open a pull request, until OpenAI Codex has
reviewed it across 11 dimensions and the score reaches 9.2. You get paged only when a human decision is
needed.

## Install (macOS 14+)

    brew install <owner>/tap/review-loop
    review-loop setup

Run `setup` in a normal terminal (not inside Claude Code), with Claude Code closed. It checks for
Claude Code, the Codex CLI, your Codex sign-in, the Codex plugin and `gh`. For anything missing it shows
the exact command to fix it. It asks before each change, and runs one real review to prove everything
works. Then restart Claude Code.

## Presets

| Preset | Finishing with unreviewed work | Opening a PR | Merging an unreviewed PR |
|---|---|---|---|
| `default` (recommended) | blocked | blocked | blocked |
| `balanced` | reminded | blocked | blocked |
| `advisory` | reminded | reminded | reminded — unless your repo requires the `review-loop` check |

Change it any time: `review-loop config set preset balanced`. The bar (mean ≥ 9.2, every dimension
≥ 9.2) is the same in every preset.

## Cost and privacy

- Every review is a real Codex run, billed to **your** OpenAI or ChatGPT account. A round usually takes
  2–8 minutes. The live check in `setup` runs one.
- Reviews send the changed files and repo context to OpenAI **under your account**.
- review-loop sends nothing anywhere else. Its event log, `~/.claude/state/review-loop/events.jsonl`,
  holds codes and counts only: never file paths, file contents or Codex output.

## Making merges require review (recommended for teams)

review-loop posts a commit status `review-loop/<base branch>` on every PR it reviews. To make GitHub
itself refuse unreviewed merges, add that status as a **required check** in your branch protection or
ruleset for each protected branch. Settings → Rules → Rulesets → Require status checks →
`review-loop/main`.

Residual risks, stated plainly:
- The status is posted with your own token. A collaborator with write access could post a fake success.
  Require it only in repos where you trust your collaborators.
- Without a required check, review-loop can only stop merges that go through Claude Code (`gh`, `gh api`
  and the GitHub MCP tools). A merge from the web UI or another tool is not stopped.
- Approvals given before a policy change (rubric, preset, version) stay valid. To review an open PR under
  the new policy, re-run the loop on it.

## Commands

| Command | What it does |
|---|---|
| `review-loop setup` | guided install; safe to re-run |
| `review-loop doctor [--live] [--json]` | checks everything, changes nothing; `--live` runs one real review |
| `review-loop config show \| set <key> <value> \| repair` | preset, Codex model and effort, rubric, event-log path |
| `review-loop update` | updates the Claude Code plugin, then runs `doctor` |
| `review-loop migrate [--rollback]` | moves a hand-installed review loop to the plugin, or undoes that |
| `review-loop uninstall` | removes the plugin, its approval rules and config; asks about history |
| `review-loop selftest` | offline smoke test (what `brew test` runs) |

Every command accepts `--json`, which prints exactly one JSON line (the `cli.exit` event).

## Exit codes

<!-- exit-codes:start -->
<!-- exit-codes:end -->

## Troubleshooting

Run `review-loop doctor`. Each failing line names a code and the fix.

<!-- troubleshooting:start -->
<!-- troubleshooting:end -->

## Events for your log pipeline

`events.jsonl` has one JSON object per line, schema `review-loop.events/1`, in this field order:
`schema, ts, run_id, source, event, code, detail, exit_code, version, session_id, artifact_key, data`.
Ship it with any file-tailing agent (Vector, Fluent Bit, the Datadog agent). It rotates at 5 MiB to
`events.jsonl.1`. To write it elsewhere: `review-loop config set events.path /abs/path.jsonl`.

## Uninstall, in this order

    review-loop uninstall
    brew uninstall review-loop

If you ran `brew uninstall` first, Claude Code shows the leftover command at its next start.

## License

MIT
```

  Run: `node scripts/gen-readme-tables.mjs && node scripts/gen-readme-tables.mjs --check`

  Expected: `README tables are current`.

  Run: `node --test test/contract/readme.test.mjs`

  Expected: PASS.

- [ ] **Step 7: Write the content-discipline corpus (T-OBS-5, and T-OBS-1 over the full corpus)**

```js
// test/contract/content-discipline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";

const SENTINELS = ["SENTINEL-CONTENT-7f3a", "/Users/", "@example.com", "ENVSECRET"];
const CLI = path.resolve("cli/review-loop.mjs");
const HOOK = path.resolve("plugin/engine/review-gate-hook.mjs");
const G = "g" + "h";

test("T-OBS-5: no sentinel reaches events.jsonl across every CLI command and hook mode", () => {
  const home = tmpDir("rl-SENTINEL-CONTENT-7f3a-");
  const bin = path.join(home, "bin");
  const state = path.join(home, "state");
  const env = {
    PATH: `${bin}:/usr/bin:/bin:${path.dirname(process.execPath)}`, HOME: home, REVIEW_LOOP_STATE_DIR: state,
    REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"), CODEX_HOME: path.join(home, "codex"), X_TOKEN: "ENVSECRET",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "sentinel@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "sentinel@example.com"
  };
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "codex"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ note: "SENTINEL-CONTENT-7f3a /Users/x ENVSECRET a@example.com", hooks: { Stop: [{ hooks: [{ type: "command", command: "/Users/SENTINEL-CONTENT-7f3a/x" }] }] } }));
  const list = JSON.stringify([{ id: "codex@openai-codex", enabled: true, version: "1.0.6" }, { id: "review-loop@review-loop", enabled: true, version: "0.1.0", installPath: path.resolve("plugin") }]);
  makeFakeBin(bin, "claude", { "--version": { stdout: "2.1.284\n" }, "plugin list --json": { stdout: list }, "*": { stdout: "{}\n" } });
  makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in as sentinel@example.com\n" } });
  makeFakeBin(bin, "gh", { "*": { code: 1, stderr: "SENTINEL-CONTENT-7f3a /Users/x\n" } });
  makeFakeBin(bin, "pgrep", { "*": { code: 1 } });
  makeFakeBin(bin, "lsof", { "*": { code: 1 } });

  const repo = path.join(home, "repo SENTINEL-CONTENT-7f3a");
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: repo, env });
  git("init", "-q"); fs.writeFileSync(path.join(repo, "README.md"), "x"); git("add", "."); git("commit", "-qm", "i");
  const spec = path.join(repo, "docs", "specs", "SENTINEL-CONTENT-7f3a-design.md");
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  fs.writeFileSync(spec, "SENTINEL-CONTENT-7f3a a@example.com /Users/x ENVSECRET\n");

  const hook = (mode, input) => spawnSync(process.execPath, [HOOK, mode], { cwd: repo, env, input: JSON.stringify({ session_id: "s1", cwd: repo, ...input }), encoding: "utf8" });
  hook("session", {});
  hook("track", { tool_name: "Write", tool_input: { file_path: spec } });
  hook("stop", { stop_hook_active: false });
  hook("prompt", { prompt: "SENTINEL-CONTENT-7f3a /Users/x" });
  hook("pr", { tool_name: "Bash", tool_input: { command: `${G} pr create --title SENTINEL-CONTENT-7f3a --body /Users/x` } });
  hook("pr", { tool_name: "Bash", tool_input: { command: `${G} pr merge 1 --match-head-commit deadbeef` } });
  hook("pr", { tool_name: "mcp__github__merge_pull_request", tool_input: { owner: "o", repo: "SENTINEL-CONTENT-7f3a", pullNumber: 1 } });
  hook("prverify", { tool_name: "Bash", tool_input: { command: `${G} pr create --title SENTINEL-CONTENT-7f3a` }, tool_response: { stdout: "https://github.com/o/SENTINEL-CONTENT-7f3a/pull/1\n" } });

  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: repo, env, encoding: "utf8", input: "" });
  cli("--version"); cli("--help"); cli("bogus-SENTINEL-CONTENT-7f3a");
  cli("config", "show", "--json"); cli("config", "set", "rubric", "/Users/SENTINEL-CONTENT-7f3a/r.md"); cli("config", "set", "effort", "SENTINEL-CONTENT-7f3a");
  cli("doctor", "--json"); cli("setup", "--yes", "--skip-live-check"); cli("engine-path");
  cli("migrate", "--yes"); cli("uninstall", "--yes", "--keep-history"); cli("selftest");

  const files = ["events.jsonl", "events.jsonl.1"].map((f) => path.join(state, f)).filter((f) => fs.existsSync(f));
  const text = files.map((f) => fs.readFileSync(f, "utf8")).join("");
  const lines = text.trim().split("\n");
  assert.ok(lines.length >= 15, `corpus produced ${lines.length} lines — too few to be meaningful`);
  for (const s of SENTINELS) assert.ok(!text.includes(s), `sentinel ${s} leaked into events.jsonl`);
  for (const l of lines) assert.deepEqual(validateLine(JSON.parse(l)), [], "every line is schema v1 (T-OBS-1)");
});
```

  **The corpus covers every `COMMANDS_ENUM` entry and every hook mode.** Add an assertion so a new
  command or mode can't be skipped silently: parse `lines` for `data.command` values and assert that the
  set equals `COMMANDS_ENUM` minus `selftest`. Selftest's events go to its own temp home, so its entry is
  checked by T-REL-3 instead. Import `COMMANDS_ENUM` from `plugin/engine/lib/codes.mjs`.

  Run: `node --test test/contract/content-discipline.test.mjs`

  Expected: PASS. If a sentinel leaks, the failure names it. Fix the **emitter** (it must pass a code, not
  the value); never loosen the test.

- [ ] **Step 8: Run everything and commit**

  Run: `(set -o pipefail; npm test 2>&1 | tail -3 && npm run content-gate && npm run docs:check)`

  Expected: `# fail 0`, `content-gate: ok (N files)` and `README tables are current`.

```bash
git add package.files.json scripts/content-gate.mjs scripts/gen-readme-tables.mjs README.md test/contract
git commit -m "feat(release): content gate, generated README tables, content-discipline corpus"
```

**Gate:** sabotage, one at a time, each reverted.
- Delete the `users_path` rule; T-REL-1 (−) `users_path` goes red.
- In `events.mjs`, replace `    run_id: RUN_ID,` with `    run_id: process.cwd(),`; T-OBS-5 goes red,
  because the hook's cwd is the sentinel repo.

---

### Task 25: CI and the sabotage runner

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/sabotage.yml`, `scripts/sabotage.mjs`,
  `scripts/sabotage-registry.mjs`
- Test: `test/contract/sabotage-registry.test.mjs`

**Interfaces:**
- `SABOTAGES: Array<{ id: string, file: string, find: string, replace: string, test: string, expect: string }>`.
  `expect` is a substring of the name of the test (or subtest) that must fail.
- `classify(status, output, expect): "red" | "stayed_green" | "wrong_failure"`, a pure function exported
  for its own test.
- `node scripts/sabotage.mjs [--only <id>]`, per row:
  1. runs `node --test <test>` on the **unmodified** code, which must pass (a red baseline proves
     nothing);
  2. applies the break and runs the test again;
  3. counts the row only if the run fails **and** a `not ok … - <name containing expect>` line is
     present, i.e. the named test failed;
  4. restores the original bytes and verifies the restore.
  - Exit 0 when every break went red for the named test.
  - Exit 1 naming each row that stayed green, failed for the wrong reason, or had a red baseline.

**Invariants:**
- **Restore happens in `finally`,** and the restored bytes are compared with the originals. If a restore
  fails, the script exits 1 immediately with the file name.
- **The registry test runs on every push** (it is cheap). It asserts that each `find` occurs **exactly
  once** in its file and that each `test` exists, so a refactor can't silently turn a sabotage into a
  no-op. The real sabotage run is weekly, and on changes to a guarded file (§10.1 arbitration).
- **Every registry `file` and every registry `test` appears in `sabotage.yml`'s `paths`,** also asserted
  by the registry test. So a test weakened while keeping its name (its assertion removed) triggers a
  sabotage run on that push, and the run then shows the break staying green.
- **Registry paths are untrusted.** `checkTarget` requires a regular, non-link, ≤ 1 MiB file inside the
  repo, and records its inode and device. Every read, apply and restore then goes through `readSame` or
  `writeSame`: an `O_NOFOLLOW` descriptor whose `fstat` must match that identity. The runner never
  re-resolves the path for a write, so a link or file swapped in after the check is refused, never
  written.

**Verified facts (2026-09-28):**
- GitHub's hosted macOS runners are `macos-14`/`macos-15`/`macos-26` (arm64) and `macos-15-intel` /
  `macos-26-intel` (x64).
- The Intel leg uses **`macos-15-intel`**. If that label is later removed, switch to `macos-26-intel`.
  With no Intel label at all, the fallback is `arch -x86_64` Node under Rosetta on `macos-14`, stated in
  the README (spec §10.3).

- [ ] **Step 1: Write `scripts/sabotage-registry.mjs`**

```js
// Each row is one named break from the spec's §11 sabotage column (and the plan's task gates). Applying it must make
// the test named by `expect` fail — not merely make the file exit non-zero (a syntax error would do that too).
export const SABOTAGES = Object.freeze([
  { id: "obs-ts-field", file: "plugin/engine/lib/events.mjs", find: "    ts: new Date().toISOString(),", replace: "    at: new Date().toISOString(),", test: "test/contract/events.test.mjs", expect: "T-OBS-1" },
  { id: "obs-content", file: "plugin/engine/lib/events.mjs", find: "    run_id: RUN_ID,", replace: "    run_id: process.cwd(),", test: "test/contract/content-discipline.test.mjs", expect: "T-OBS-5" },
  { id: "codes-registry", file: "plugin/engine/lib/config.mjs", find: "  return { version: 1, preset: \"default\", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } };", replace: "  if (process.env.ZZZ) throw new ReviewLoopError(\"zzz_new\", \"x\");\n  return { version: 1, preset: \"default\", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } };", test: "test/contract/codes.test.mjs", expect: "T-OBS-3" },
  { id: "cfg-model-arg", file: "plugin/engine/lib/codexcfg.mjs", find: "  if (c.model) out.push(\"--model\", c.model);", replace: "", test: "test/engine/model-effort.test.mjs", expect: "T-CFG-4" },
  { id: "shape-merge-matcher", file: "plugin/hooks/hooks.json", find: "\"mcp__.*__merge_pull_request\"", replace: "\"mcp__.*__merge_pull_requestX\"", test: "test/contract/shape.test.mjs", expect: "T-SHAPE-1" },
  { id: "merge-bind", file: "plugin/engine/lib/merge.mjs", find: "!isClearedAt(identity, `${target.bind}:${v.mergeBase}`)", replace: "false", test: "test/engine/merge.test.mjs", expect: "T-PR-7" },
  { id: "cli-sigint-exit-event", file: "cli/review-loop.mjs", find: "sigint = true; finish({ code: \"cancelled\" });", replace: "sigint = true;", test: "test/cli/skeleton.test.mjs", expect: "T-OBS-2" },
  { id: "settings-hardlink-backup", file: "cli/lib/settings.mjs", find: "          fs.linkSync(target, backup);", replace: "          fs.copyFileSync(target, backup);", test: "test/cli/settings.test.mjs", expect: "(8a)" },
  { id: "setup-idempotent-plugin", file: "cli/lib/setup.mjs", find: "if (!existing || !existing.enabled) {", replace: "if (true) {", test: "test/cli/setup.test.mjs", expect: "T-SET-5" },
  { id: "doctor-registry", file: "cli/lib/doctor.mjs", find: "export const DOCTOR_CHECKS = [", replace: "export const DOCTOR_CHECKS = [\n  { id: \"zz\", async run() { return pass(); } },", test: "test/cli/doctor.test.mjs", expect: "T-DOC-1" },
  { id: "rollback-plugin-uninstall", file: "cli/lib/migrate.mjs", find: "if (await installedPlugin(PLUGIN_ID).catch(() => null)) await runTool(\"claude\", [\"plugin\", \"uninstall\", PLUGIN_ID, \"--scope\", \"user\", \"--json\"]);", replace: "", test: "test/cli/migrate.test.mjs", expect: "T-MIG-7" },
  { id: "content-gate-users", file: "scripts/content-gate.mjs", find: "  { name: \"users_path\", re: /\\/Users\\//i },", replace: "", test: "test/contract/content-gate.test.mjs", expect: "users_path" }
]);
```

  **If a `find` string doesn't match the code as implemented** (an earlier task's sample was adapted),
  update the row to the implemented line, **keeping the same semantic break**. The registry test (Step 2)
  fails until every row matches exactly once.

  **Adding a row is the extension point.** A new load-bearing gate adds one row here and its file to
  `sabotage.yml` `paths`. The registry test fails if the second step is skipped.

- [ ] **Step 2: Write the registry test**

```js
// test/contract/sabotage-registry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { SABOTAGES } from "../../scripts/sabotage-registry.mjs";

test("every sabotage applies exactly once and names an existing test", () => {
  const ids = new Set();
  for (const s of SABOTAGES) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`); ids.add(s.id);
    const src = fs.readFileSync(s.file, "utf8");
    assert.equal(src.split(s.find).length - 1, 1, `${s.id}: find must match exactly once in ${s.file}`);
    assert.ok(fs.existsSync(s.test), `${s.id}: ${s.test} exists`);
  }
});

test("every row's expect names a test that exists in its test file", () => {
  for (const s of SABOTAGES) {
    assert.ok(typeof s.expect === "string" && s.expect.length > 0, `${s.id}: expect`);
    assert.ok(fs.readFileSync(s.test, "utf8").includes(s.expect), `${s.id}: "${s.expect}" appears in ${s.test}`);
  }
});

test("checkTarget: links, non-files, oversized and out-of-repo paths are refused before any read", async () => {
  const { checkTarget } = await import("../../scripts/sabotage.mjs");
  const root = fs.realpathSync(tmpDir());
  const outside = path.join(tmpDir(), "secret.txt");
  fs.writeFileSync(outside, "do not touch");
  fs.symlinkSync(outside, path.join(root, "link.mjs"));
  fs.mkdirSync(path.join(root, "dir.mjs"));
  fs.writeFileSync(path.join(root, "big.mjs"), "x".repeat(1024 * 1024 + 1));
  fs.writeFileSync(path.join(root, "ok.mjs"), "ok");
  for (const rel of ["link.mjs", "dir.mjs", "big.mjs", "../escape.mjs", "missing.mjs"]) assert.throws(() => checkTarget(root, rel), /refusing/, rel);
  assert.equal(checkTarget(root, "ok.mjs").abs, path.join(root, "ok.mjs"));
  assert.equal(fs.readFileSync(outside, "utf8"), "do not touch");
});

test("writeSame/readSame: a path swapped after the check is refused and the outside file is untouched", async () => {
  const { checkTarget, readSame, writeSame } = await import("../../scripts/sabotage.mjs");
  const root = fs.realpathSync(tmpDir());
  const outside = path.join(tmpDir(), "outside.mjs");
  fs.writeFileSync(outside, "outside");
  fs.writeFileSync(path.join(root, "g.mjs"), "inside");
  const t = checkTarget(root, "g.mjs");
  assert.equal(readSame(t).toString(), "inside");
  writeSame(t, Buffer.from("changed"));
  assert.equal(fs.readFileSync(path.join(root, "g.mjs"), "utf8"), "changed");
  fs.rmSync(path.join(root, "g.mjs"));
  fs.symlinkSync(outside, path.join(root, "g.mjs"));                      // final component → link
  assert.throws(() => writeSame(t, Buffer.from("pwned")));
  fs.rmSync(path.join(root, "g.mjs"));
  fs.writeFileSync(path.join(root, "g.mjs"), "replacement");              // same name, different inode
  assert.throws(() => writeSame(t, Buffer.from("pwned")), /changed after it was checked/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.equal(fs.readFileSync(path.join(root, "g.mjs"), "utf8"), "replacement");
});

test("classify: only the named test failing counts as red", async () => {
  const { classify } = await import("../../scripts/sabotage.mjs");
  assert.equal(classify(0, "ok 1 - T-OBS-1: a written line", "T-OBS-1"), "stayed_green");
  assert.equal(classify(1, "not ok 1 - T-OBS-1: a written line is schema v1", "T-OBS-1"), "red");
  assert.equal(classify(1, "    not ok 3 - (8a) descriptor opened before", "(8a)"), "red");
  assert.equal(classify(1, "not ok 1 - test/contract/events.test.mjs\n  SyntaxError: Unexpected token", "T-OBS-1"), "wrong_failure");
  assert.equal(classify(1, "not ok 2 - T-OBS-4: validated by value", "T-OBS-1"), "wrong_failure");
});

test("every guarded file AND its gate test trigger the sabotage workflow", () => {
  const wf = fs.readFileSync(".github/workflows/sabotage.yml", "utf8");
  for (const s of SABOTAGES) {
    assert.ok(wf.includes(`- "${s.file}"`), `${s.file} is listed in sabotage.yml paths`);
    assert.ok(wf.includes(`- "${s.test}"`), `${s.test} is listed in sabotage.yml paths (a weakened test must re-prove its gate)`);
  }
});
```

- [ ] **Step 3: Implement `scripts/sabotage.mjs`**

```js
#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SABOTAGES } from "./sabotage-registry.mjs";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const MAX_BYTES = 1024 * 1024;

/** @typedef {{ abs: string, ino: number, dev: number }} Target */

/**
 * Registry paths are untrusted working-tree input: each must be a regular, non-link file, ≤ 1 MiB, whose real path
 * stays inside the repo. The returned identity (inode + device) is what every later read and write must still hit.
 * @param {string} root @param {string} rel @returns {Target}
 */
export function checkTarget(root, rel) {
  const abs = path.resolve(root, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.size > MAX_BYTES || !fs.realpathSync(abs).startsWith(root + path.sep)) {
    throw new Error(`sabotage: refusing ${rel} (must be a regular file ≤ 1 MiB inside the repo, not a link)`);
  }
  return { abs, ino: st.ino, dev: st.dev };
}

/**
 * Open without following a link and prove the descriptor is the validated file before touching it. A path swapped
 * after checkTarget (final component → link: ELOOP; any other replacement: different inode) is refused, never written.
 * @template T @param {Target} t @param {number} flags @param {(fd: number, size: number) => T} use @returns {T}
 */
function withSameFile(t, flags, use) {
  const fd = fs.openSync(t.abs, flags | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.ino !== t.ino || st.dev !== t.dev || st.size > MAX_BYTES) throw new Error(`sabotage: ${t.abs} changed after it was checked; not touched`);
    return use(fd, st.size);
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {Target} t @returns {Buffer} */
export function readSame(t) {
  return withSameFile(t, fs.constants.O_RDONLY, (fd, size) => { const b = Buffer.alloc(size); const n = fs.readSync(fd, b, 0, size, 0); return b.subarray(0, n); });
}

/** Rewrites in place through the verified descriptor (no O_CREAT: a missing file is an error, not a new file). @param {Target} t @param {Buffer} data */
export function writeSame(t, data) {
  withSameFile(t, fs.constants.O_WRONLY, (fd) => { fs.ftruncateSync(fd, 0); fs.writeSync(fd, data, 0, data.length, 0); });
}

const esc = (/** @type {string} */ t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Red only when the run failed AND the named test is among the failures. A syntax error, a missing import or an
 * unrelated assertion fails the file too, but reports a different (or file-level) `not ok` line.
 * @param {number | null} status @param {string} output @param {string} expect
 * @returns {"red" | "stayed_green" | "wrong_failure"}
 */
export function classify(status, output, expect) {
  if (status === 0) return "stayed_green";
  return new RegExp(`^\\s*not ok \\d+ - [^\\n]*${esc(expect)}`, "m").test(output) ? "red" : "wrong_failure";
}

const runTest = (/** @type {string} */ t) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", t], { encoding: "utf8", timeout: 10 * 60_000 });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  /** @type {string[]} */
  const bad = [];
  for (const s of SABOTAGES.filter((x) => !only || x.id === only)) {
    checkTarget(ROOT, s.test);
    const target = checkTarget(ROOT, s.file);
    const orig = readSame(target);
    const text = orig.toString("utf8");
    if (text.split(s.find).length - 1 !== 1) { process.stdout.write(`FAIL ${s.id}: find does not match exactly once in ${s.file}\n`); process.exit(1); }
    if (runTest(s.test).status !== 0) { bad.push(`${s.id} (baseline red)`); process.stdout.write(`BASELINE RED  ${s.id}\n`); continue; }
    try {
      writeSame(target, Buffer.from(text.replace(s.find, s.replace)));
      const r = runTest(s.test);
      const verdict = classify(r.status, `${r.stdout}\n${r.stderr}`, s.expect);
      if (verdict !== "red") bad.push(`${s.id} (${verdict})`);
      process.stdout.write(`${verdict === "red" ? "red (expected)" : verdict.toUpperCase()}  ${s.id}\n`);
    } finally {
      writeSame(target, orig);
      if (!readSame(target).equals(orig)) { process.stdout.write(`FAIL restore ${s.file}\n`); process.exit(1); }
    }
  }
  if (bad.length) { process.stdout.write(`sabotage: ${bad.length} row(s) did not prove their gate: ${bad.join(", ")}\n`); process.exit(1); }
  process.stdout.write("sabotage: every break went red for its named test\n");
}
```

  Run: `npm run sabotage; echo "exit=$?"; git status --porcelain plugin cli scripts`

  Expected: a `red (expected)` line per row, `sabotage: every break went red for its named test`,
  `exit=0`, and **no** `git status` output, proving every file was restored.

- [ ] **Step 4: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-14, macos-15-intel]
        node: [brew, "22"]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4.4.0
      - name: Node from Homebrew (what users get)
        if: matrix.node == 'brew'
        run: |
          brew install node
          echo "$(brew --prefix)/bin" >> "$GITHUB_PATH"
      - name: Node at the minimum supported version
        if: matrix.node != 'brew'
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020  # v4.4.0
        with:
          node-version: "22"
      - run: node --version && git --version
      - run: npm test
      - run: npm run content-gate
      - run: npm run docs:check
  plugin-validate:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4.4.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020  # v4.4.0
        with:
          node-version: "22"
      - run: npm install -g @anthropic-ai/claude-code@2.1.284
      - run: claude plugin validate --strict plugin
      - run: claude plugin validate --strict .
```

  **Precondition for `plugin-validate`: confirm that validation works without signing in.** On the
  author's Mac, run
  `CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin validate --strict plugin; echo "exit=$?"`.

  Expected: `exit=0`, with no login prompt. The `claude` CLI is a **CI-only tool**, pinned to the version
  verified locally; it is not a package dependency. If it asks for auth or fails, **delete the
  `plugin-validate` job**. Validation then stays in Task 11's gate and in `docs/RELEASE.md` step 2 (run
  locally), and you record `plugin-validate: local-only (needs auth)` in `CLAUDE.md`.

- [ ] **Step 5: Write `.github/workflows/sabotage.yml`**

```yaml
name: sabotage
on:
  schedule:
    - cron: "17 6 * * 1"
  workflow_dispatch:
  push:
    paths:
      - "plugin/engine/lib/events.mjs"
      - "plugin/engine/lib/config.mjs"
      - "plugin/engine/lib/codexcfg.mjs"
      - "plugin/hooks/hooks.json"
      - "plugin/engine/lib/merge.mjs"
      - "cli/review-loop.mjs"
      - "cli/lib/settings.mjs"
      - "cli/lib/setup.mjs"
      - "cli/lib/doctor.mjs"
      - "cli/lib/migrate.mjs"
      - "scripts/content-gate.mjs"
      - "scripts/sabotage-registry.mjs"
      - "scripts/sabotage.mjs"
      # The gate tests: a test edited to keep its name but lose its assertion re-runs the sabotage it must catch.
      - "test/contract/events.test.mjs"
      - "test/contract/content-discipline.test.mjs"
      - "test/contract/codes.test.mjs"
      - "test/engine/model-effort.test.mjs"
      - "test/contract/shape.test.mjs"
      - "test/engine/merge.test.mjs"
      - "test/cli/skeleton.test.mjs"
      - "test/cli/settings.test.mjs"
      - "test/cli/setup.test.mjs"
      - "test/cli/doctor.test.mjs"
      - "test/cli/migrate.test.mjs"
      - "test/contract/content-gate.test.mjs"
permissions:
  contents: read
jobs:
  sabotage:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4.4.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020  # v4.4.0
        with:
          node-version: "22"
      - run: npm run sabotage
```

- [ ] **Step 6: Run and commit**

  Run: `(set -o pipefail; node --test test/contract/sabotage-registry.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

```bash
git add .github scripts/sabotage.mjs scripts/sabotage-registry.mjs test/contract/sabotage-registry.test.mjs
git commit -m "ci: macOS arm64+Intel matrix, plugin validation, sabotage runner"
```

**Gate:**
- `npm run sabotage` exits 0 with a clean `git status`. That is the run's own evidence.
- Sabotage the runner itself, twice, removing each row afterwards:
  - a row whose `replace` equals its `find` (a no-op break): `--only <id>` prints `STAYED_GREEN` and
    exits 1;
  - a row whose `replace` injects a syntax error (`"(("`) with `expect: "T-OBS-1"`: it prints
    `WRONG_FAILURE` and exits 1.

---

### Task 26: Homebrew formula, tap CI, release automation and version stamping

**Files:**
- Create in this repo: `scripts/bump-version.mjs`, `scripts/release-check.mjs`,
  `.github/workflows/release.yml`, `docs/RELEASE.md`, `homebrew-tap/` (a staging copy of the tap repo,
  pushed as its own repo in Task 28 and excluded from the package)
- Create in `homebrew-tap/`: `Formula/review-loop.rb`, `.github/workflows/tests.yml`, `.github/dependabot.yml`, `README.md`
- Create in this repo: `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

  Put the identical file in `homebrew-tap/.github/dependabot.yml`.
- Test: `test/contract/release.test.mjs`

**Interfaces:**
- `node scripts/bump-version.mjs X.Y.Z` writes the version to `package.json`, `plugin/.claude-plugin/plugin.json`,
  the `review-loop` entry in `.claude-plugin/marketplace.json`, and the `VERSION="…"` line in
  `plugin/bin/hook`.
- `node scripts/release-check.mjs X.Y.Z` exits 0 only if all four equal `X.Y.Z`; otherwise it exits 1,
  naming each file that differs.

**Invariants:**
- **AC-2:** the formula has no `post_install`, and `caveats` only prints text. T-REL-4 snapshots
  `~/.claude` and `~/.codex` around install, test and uninstall.
- **The tarball is exactly the allowlisted set** (`content-gate --list`), and the content gate re-runs on
  the extracted tarball.
- **Every third-party action is pinned to a full commit SHA** (the `ci-deploy-patterns` rule), with its
  tag in a comment: `actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4.4.0` and
  `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020  # v4.4.0`. Both were read with
  `git ls-remote --tags` on 2026-09-28; they are lightweight tags, so each SHA is the commit. Dependabot
  (`.github/dependabot.yml`, `package-ecosystem: github-actions`, weekly) proposes pin bumps, and each
  bump goes through CI and review like any PR. `test/contract/release.test.mjs` fails on any `uses:`
  that is not `@<40-hex>`.
- **The tap PR token is separate from the repo's `GITHUB_TOKEN`:** `TAP_PR_TOKEN`, a fine-grained token
  limited to `<owner>/homebrew-tap` with contents and pull-requests write. It lives only in the
  `release` environment.

- [ ] **Step 1: Write the failing release test**

```js
// test/contract/release.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";

const FILES = ["package.json", "plugin/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "plugin/bin/hook"];
function copyRepo() {
  const d = tmpDir();
  for (const f of [...FILES, "scripts/bump-version.mjs", "scripts/release-check.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.copyFileSync(f, path.join(d, f));
  }
  return d;
}
const node = (d, ...a) => spawnSync(process.execPath, a, { cwd: d, encoding: "utf8" });

test("bump-version stamps all four places; release-check agrees", () => {
  const d = copyRepo();
  assert.equal(node(d, "scripts/bump-version.mjs", "9.8.7").status, 0);
  assert.equal(node(d, "scripts/release-check.mjs", "9.8.7").status, 0);
  assert.match(fs.readFileSync(path.join(d, "plugin/bin/hook"), "utf8"), /^VERSION="9\.8\.7"$/m);
});

test("release-check names each mismatching file", () => {
  const d = copyRepo();
  node(d, "scripts/bump-version.mjs", "9.8.7");
  const pj = path.join(d, "plugin/.claude-plugin/plugin.json");
  fs.writeFileSync(pj, fs.readFileSync(pj, "utf8").replace("9.8.7", "9.8.6"));
  const r = node(d, "scripts/release-check.mjs", "9.8.7");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /plugin\/\.claude-plugin\/plugin\.json: 9\.8\.6/);
});

test("bump-version refuses a symlinked target and writes nothing", () => {
  const d = copyRepo();
  const outside = path.join(tmpDir(), "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ version: "0.0.1" }));
  fs.rmSync(path.join(d, "package.json"));
  fs.symlinkSync(outside, path.join(d, "package.json"));
  const before = fs.readFileSync(path.join(d, "plugin/.claude-plugin/plugin.json"), "utf8");
  const r = node(d, "scripts/bump-version.mjs", "9.8.7");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing package\.json/);
  assert.equal(JSON.parse(fs.readFileSync(outside, "utf8")).version, "0.0.1", "link target untouched");
  assert.equal(fs.readFileSync(path.join(d, "plugin/.claude-plugin/plugin.json"), "utf8"), before, "nothing written");
});

test("bump-version keeps the shim executable", () => {
  const d = copyRepo();
  fs.chmodSync(path.join(d, "plugin/bin/hook"), 0o755);
  node(d, "scripts/bump-version.mjs", "9.8.7");
  assert.equal(fs.statSync(path.join(d, "plugin/bin/hook")).mode & 0o777, 0o755);
});

test("every workflow action is pinned to a full commit SHA (both repos)", () => {
  const dirs = [".github/workflows", "homebrew-tap/.github/workflows"];
  const bad = [];
  for (const d of dirs) for (const f of fs.readdirSync(d)) {
    fs.readFileSync(path.join(d, f), "utf8").split("\n").forEach((l, i) => {
      const m = /^\s*-?\s*uses:\s*(\S+)/.exec(l);
      if (m && !/@[0-9a-f]{40}$/.test(m[1])) bad.push(`${d}/${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("bump-version rejects a non-semver argument", () => {
  assert.equal(node(copyRepo(), "scripts/bump-version.mjs", "v1").status, 2);
});

test("AC-2: the formula has no post_install and caveats execute nothing", () => {
  const rb = fs.readFileSync("homebrew-tap/Formula/review-loop.rb", "utf8");
  assert.ok(!/post_install/.test(rb));
  const caveats = /def caveats([\s\S]*?)\n  end/.exec(rb)?.[1] ?? "";
  assert.ok(!/system|`|%x|Kernel|IO\.|File\./.test(caveats.replace(/<<~EOS[\s\S]*?EOS/, "")), "caveats only returns text");
  assert.match(rb, /system bin\/"review-loop", "selftest"/);
});
```

- [ ] **Step 2: Implement the two scripts**

```js
// scripts/bump-version.mjs
import fs from "node:fs";
import path from "node:path";

const v = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(v)) { process.stderr.write("usage: bump-version.mjs X.Y.Z\n"); process.exit(2); }
const ROOT = fs.realpathSync(process.cwd());

/** The working tree is untrusted: each target must be a regular, non-link file whose real path stays inside the repo. */
function checked(/** @type {string} */ rel) {
  const abs = path.join(ROOT, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.size > 1024 * 1024 || !fs.realpathSync(abs).startsWith(ROOT + path.sep)) {
    process.stderr.write(`bump-version: refusing ${rel} (must be a regular file inside the repo, not a link)\n`);
    process.exit(1);
  }
  return { abs, mode: st.mode & 0o777 };
}
const FILES = ["package.json", "plugin/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "plugin/bin/hook"].map(checked);  // all checked before any write

/** Temp-then-rename in the same directory, keeping the mode (the shim stays executable). */
function replace(/** @type {{ abs: string, mode: number }} */ f, /** @type {string} */ text) {
  const tmp = `${f.abs}.bump-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: f.mode, flag: "wx" });
  fs.renameSync(tmp, f.abs);
}
const json = (/** @type {{ abs: string, mode: number }} */ f, /** @type {(o: Record<string, unknown>) => void} */ edit) => {
  const o = JSON.parse(fs.readFileSync(f.abs, "utf8"));
  edit(o);
  replace(f, `${JSON.stringify(o, null, 2)}\n`);
};
const [pkg, plugin, market, hookFile] = FILES;
json(pkg, (o) => { o.version = v; });
json(plugin, (o) => { o.version = v; });
json(market, (o) => {
  const e = /** @type {Array<{ name: string, version?: string }>} */ (o.plugins).find((p) => p.name === "review-loop");
  if (!e) throw new Error("marketplace.json has no review-loop entry");
  e.version = v;
});
const hook = fs.readFileSync(hookFile.abs, "utf8");
if (!/^VERSION="[^"]*"$/m.test(hook)) throw new Error("plugin/bin/hook has no VERSION line");
replace(hookFile, hook.replace(/^VERSION="[^"]*"$/m, `VERSION="${v}"`));
process.stdout.write(`version ${v} stamped in 4 files\n`);
```

  The shim keeps its mode because `replace` recreates it with the original mode. The T-SHAPE shim tests
  run it, so a lost `+x` goes red. All four files are checked before any is written, so a refusal
  leaves the tree unchanged.

```js
// scripts/release-check.mjs
import fs from "node:fs";

const want = process.argv[2] ?? "";
const got = {
  "package.json": JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  "plugin/.claude-plugin/plugin.json": JSON.parse(fs.readFileSync("plugin/.claude-plugin/plugin.json", "utf8")).version,
  ".claude-plugin/marketplace.json": JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8")).plugins.find((/** @type {{ name: string }} */ p) => p.name === "review-loop")?.version,
  "plugin/bin/hook": /^VERSION="([^"]*)"$/m.exec(fs.readFileSync("plugin/bin/hook", "utf8"))?.[1]
};
const bad = Object.entries(got).filter(([, v]) => v !== want);
for (const [f, v] of bad) process.stdout.write(`${f}: ${v ?? "missing"} (tag says ${want})\n`);
process.exit(bad.length ? 1 : 0);
```

- [ ] **Step 3: Write the formula `homebrew-tap/Formula/review-loop.rb`**

```ruby
class ReviewLoop < Formula
  desc "Enforced Codex adversarial review inside Claude Code"
  homepage "https://github.com/<owner>/review-loop"
  url "https://github.com/<owner>/review-loop/releases/download/v0.1.0/review-loop-0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on "git"
  depends_on :macos
  depends_on "node"

  def install
    libexec.install "cli", "plugin", "package.json"
    (bin/"review-loop").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/cli/review-loop.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      Next, in a normal terminal with Claude Code closed:
        review-loop setup

      To remove review-loop completely, in this order:
        review-loop uninstall
        brew uninstall review-loop
    EOS
  end

  test do
    system bin/"review-loop", "selftest"
    assert_match version.to_s, shell_output("#{bin}/review-loop --version 2>&1")
  end
end
```

  The zero `sha256` is replaced by the first release's tap PR (Step 5). `brew style` orders `depends_on`
  lines, so run `brew style --fix homebrew-tap/Formula/review-loop.rb` and keep whatever order it
  produces.

- [ ] **Step 4: Write the tap CI `homebrew-tap/.github/workflows/tests.yml` (includes T-REL-4)**

```yaml
name: tests
# Pull requests only: every formula change arrives as a release PR (release.yml), whose url and sha256 already
# resolve. The bootstrap push of main (placeholder sha256, no release yet) therefore triggers no run.
on:
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  formula:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-14, macos-15-intel]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4.4.0
        with:
          path: head
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4.4.0
        with:
          ref: ${{ github.base_ref }}
          path: base
      - name: Tap = the base branch (the currently released formula)
        run: |
          TAP="$(brew --repository)/Library/Taps/<owner>/homebrew-tap"
          echo "TAP=$TAP" >> "$GITHUB_ENV"
          mkdir -p "$(dirname "$TAP")"; rm -rf "$TAP"; cp -R base "$TAP"
      - run: brew style head/Formula/review-loop.rb
      - name: Snapshot ~/.claude and ~/.codex — metadata AND content hashes (T-REL-4)
        run: |
          mkdir -p ~/.claude ~/.codex
          printf x > ~/.claude/.marker; printf x > ~/.codex/.marker
          snap() { { find ~/.claude ~/.codex -exec stat -f '%N %m %z %p' {} +; find ~/.claude ~/.codex -type f -exec shasum -a 256 {} +; } | sort; }
          snap > "$RUNNER_TEMP/before.txt"
          declare -f snap > "$RUNNER_TEMP/snap.sh"
      - name: Install the released version (none before the very first release)
        run: |
          if grep -Eq 'sha256 "0{64}"' base/Formula/review-loop.rb; then echo "FIRST=1" >> "$GITHUB_ENV"; echo "first release: nothing to upgrade from"
          else brew install <owner>/tap/review-loop; fi
      - name: Upgrade to this PR's formula (install on the first release)
        run: |
          cp head/Formula/review-loop.rb "$TAP/Formula/review-loop.rb"
          brew audit --strict --online <owner>/tap/review-loop
          if [ "${FIRST:-}" = 1 ]; then brew install --build-from-source <owner>/tap/review-loop
          else brew upgrade --build-from-source <owner>/tap/review-loop; fi
      - run: brew test <owner>/tap/review-loop
      - run: brew uninstall review-loop
      - name: brew-no-home-writes across install, upgrade, test and uninstall (T-REL-4, AC-2)
        run: |
          . "$RUNNER_TEMP/snap.sh"
          snap > "$RUNNER_TEMP/after.txt"
          diff "$RUNNER_TEMP/before.txt" "$RUNNER_TEMP/after.txt"
```

  **The first tap CI run is the v1.0.0 tap PR** (Task 28 Step 6). By then the release tarball exists
  and the PR carries its real `sha256`. The bootstrap push of `main` (Task 28 Step 3) triggers nothing,
  because the workflow has no `push` trigger. A later manual run (`workflow_dispatch`) on `main` works
  only after the first tap PR has merged.

  **Flag check before relying on it:** run `brew upgrade --help | grep -- --build-from-source`; expect a
  match. The workflow's `run:` steps use bash (the default shell on macOS runners), which `declare -f`
  needs.

  **The first release has nothing to upgrade from.** Its run installs the PR formula directly and says
  so in the log. From v1.0.1 on, every tap PR exercises install(released) → upgrade(PR) → test →
  uninstall, and AC-2's `brew upgrade` clause is covered from then.

  **T-REL-4 sabotage**, run once on a throwaway tap branch against a PR whose base has a real release.
  Delete the branch afterwards.
  - **Content-only write:** add
    `def post_install; f = Pathname.new(Dir.home)/".claude/.marker"; t = f.mtime; f.write("y"); File.utime(t, t, f); end`
    (same size, restored mtime). The diff goes red on the `shasum` line.
  - **Upgrade-time write:** put the same `post_install` only in the PR head formula. The diff goes red,
    because the write happened during `brew upgrade`.

- [ ] **Step 5: Write `.github/workflows/release.yml`**

```yaml
name: release
on:
  push:
    tags: ["v*.*.*"]
permissions:
  contents: write
jobs:
  release:
    runs-on: macos-14
    environment: release
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262  # v4.4.0
        with:
          fetch-depth: 0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020  # v4.4.0
        with:
          node-version: "22"
      - name: Tag, CLI, plugin and marketplace versions are equal
        run: node scripts/release-check.mjs "${GITHUB_REF_NAME#v}"
      - run: npm test
      - run: npm run content-gate
      - run: npm run sabotage
      - name: Build the tarball from the allowlisted set, then re-gate it
        run: |
          V="${GITHUB_REF_NAME#v}"
          git archive --format=tar.gz --prefix="review-loop-$V/" -o "review-loop-$V.tar.gz" HEAD $(node scripts/content-gate.mjs --list)
          mkdir extracted && tar -xzf "review-loop-$V.tar.gz" -C extracted
          node scripts/content-gate.mjs --dir "extracted/review-loop-$V"
          shasum -a 256 "review-loop-$V.tar.gz" | cut -d' ' -f1 > sha256.txt
          echo "V=$V" >> "$GITHUB_ENV"
      - name: GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" "review-loop-$V.tar.gz" --verify-tag --title "review-loop $V" --notes "See CHANGELOG in the release PR."
      - name: Plugin tag (validates plugin.json against the marketplace entry)
        run: |
          npm install -g @anthropic-ai/claude-code@2.1.284
          git config user.name "review-loop release"
          git config user.email "release@example.com"
          claude plugin tag plugin --push
      - name: Open the tap PR
        env:
          GH_TOKEN: ${{ secrets.TAP_PR_TOKEN }}
        run: |
          SHA="$(cat sha256.txt)"
          git clone "https://x-access-token:${GH_TOKEN}@github.com/<owner>/homebrew-tap.git" tap
          cd tap
          git checkout -b "review-loop-$V"
          F=Formula/review-loop.rb
          sed -i '' -E "s#^  url \".*\"#  url \"https://github.com/<owner>/review-loop/releases/download/v$V/review-loop-$V.tar.gz\"#" "$F"
          sed -i '' -E "s#^  sha256 \".*\"#  sha256 \"$SHA\"#" "$F"
          git -c user.name="review-loop release" -c user.email="release@example.com" commit -am "review-loop $V"
          git push origin "review-loop-$V"
          gh pr create --repo <owner>/homebrew-tap --head "review-loop-$V" --title "review-loop $V" --body "Automated bump to v$V (sha256 $SHA)."
```

  **If the `claude plugin tag` step needs auth** (Task 25 Step 4 found `plugin-validate: local-only`),
  delete the step. The release checklist then runs `claude plugin tag plugin --push` locally, after the
  workflow's version check has passed.

- [ ] **Step 6: Write `docs/RELEASE.md`**

```markdown
# Releasing review-loop

Every step is a command with its expected output. Stop at the first mismatch.

1. `node scripts/bump-version.mjs X.Y.Z && node scripts/release-check.mjs X.Y.Z; echo "exit=$?"`
   → `version X.Y.Z stamped in 4 files`, `exit=0`
2. `claude plugin validate --strict plugin && claude plugin validate --strict .` → both exit 0
3. `(set -o pipefail; npm test 2>&1 | tail -3)` → `# fail 0`; `npm run content-gate` → `content-gate: ok (…)`;
   `npm run docs:check` → `README tables are current`; `npm run sabotage` → `sabotage: every break went red`
4. Re-run probes P1 and P5 against the installed Claude Code: `sh scripts/probes/p1-parity.sh` → the
   `P1 … pass` line; `sh scripts/probes/p5-warn.sh` → `P5 … pass`
5. `npm run e2e` (paid; needs Codex sign-in) → `# fail 0`
6. Dogfood (AC-20): the release PR itself passes the review loop at 9.2. Before the author has migrated
   (Task 29), that is the legacy loop running the same engine; afterwards it is the plugin. `$RR status`
   shows the PR marker with `status: passed`.
7. Merge the release PR, then `git tag vX.Y.Z && git push origin vX.Y.Z` → the `release` workflow goes
   green and a PR appears on `<owner>/homebrew-tap`
8. The tap PR's `tests` workflow is green on both runners → merge it
9. On a clean Mac user: `brew install <owner>/tap/review-loop && review-loop --version` → `review-loop X.Y.Z`
```

  Match the probe script names in step 4 to the files Task 2 created (`ls scripts/probes`).

- [ ] **Step 7: Exclude the tap staging copy from the package and the repo's own CI**

  `homebrew-tap/` is not in `package.files.json`, so it never ships. Add a test to
  `test/contract/content-gate.test.mjs` asserting
  `run("--list").stdout.split("\n").every((f) => !f.startsWith("homebrew-tap/"))`.

- [ ] **Step 8: Run and commit**

  Run: `(set -o pipefail; node --test test/contract/release.test.mjs test/contract/content-gate.test.mjs && npm test 2>&1 | tail -3)`

  Expected: pass, and `# fail 0`.

  Run: `brew style homebrew-tap/Formula/review-loop.rb`

  Expected: `1 file inspected, no offenses detected`. If there are offenses, run
  `brew style --fix homebrew-tap/Formula/review-loop.rb` and re-run.

```bash
git add scripts/bump-version.mjs scripts/release-check.mjs .github/workflows/release.yml docs/RELEASE.md homebrew-tap test/contract
git commit -m "release: formula, tap CI with no-home-writes check, release workflow, version stamping"
```

**Gate:**
- Sabotage: hand-edit one version (the release test's second case is the pinned form). `release-check`
  exits 1, naming the file.
- AC-2 static check: add `def post_install; end` to the formula; the AC-2 test goes red. Revert.

---

### Task 27: Pre-release live end-to-end test, in an isolated Claude config

**Files:**
- Create: `test/e2e/live.test.mjs`
- Modify: `CLAUDE.md` (the e2e record)

**Preconditions:**
- Tasks 1–26 are committed, and `npm test` shows `# fail 0`.
- **The author has approved the paid run:** one Codex round plus two short headless Claude sessions,
  each capped at $1. Page the author with
  `review-loop: ready to run the paid live e2e (1 Codex round + 2 capped Claude sessions, isolated config) — approve?`,
  and wait for yes.

**Invariants:**
- **Default `npm test` skips the e2e.** It runs only with `REVIEW_LOOP_E2E=1`, because it's paid and
  needs sign-in.
- **Nothing of the author's is touched.**
  - The plugin is installed from the working tree into the isolated probe `CLAUDE_CONFIG_DIR` (Task 2),
    so the real `~/.claude/settings.json`, plugins and legacy loop stay as they are.
  - The e2e uses a temp repo and a temp state dir.
  - Codex auth (`~/.codex`) is read, never written.
- **Why not migrate now:** spec §14 migrates the author's Mac only after v1.0.0 is tagged (Task 29).

- [ ] **Step 1: Write `test/e2e/live.test.mjs`**

  It drives a **real headless Claude Code session** in the isolated config, so the path under test is
  the production one: `hooks.json` → `plugin/bin/hook` → engine. Evidence comes from two sources: the
  temp state dir's `events.jsonl`, written only by the plugin's hooks and the round, and the session's
  own files. Flags were verified with `claude --help` on 2.1.284: `-p`, `--output-format stream-json`
  (needs `--verbose`), `--allowedTools`, `-r/--resume <session-id>` and `--max-budget-usd`. There is no
  `--max-turns`, so spend is bounded by budget instead.

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { enginePath } from "../../cli/lib/plugin.mjs";

const E2E = process.env.REVIEW_LOOP_E2E === "1";

test("e2e: a real Claude Code session through the installed plugin — Stop blocks an unreviewed spec, then clears", { skip: !E2E && "set REVIEW_LOOP_E2E=1 (paid, needs sign-in)", timeout: 40 * 60_000 }, async () => {
  assert.ok(process.env.CLAUDE_CONFIG_DIR, "run inside the isolated, signed-in config (Task 27 Step 2)");
  const engine = await enginePath();
  assert.ok(engine, "the review-loop plugin is installed in the isolated config");
  const state = tmpDir("rl-e2e-state-");
  const repo = tmpDir("rl-e2e-repo-");
  const env = { ...process.env, REVIEW_LOOP_STATE_DIR: state };  // the plugin's hooks inherit this from claude
  const git = (...a) => spawnSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: repo, env });
  git("init", "-q"); fs.writeFileSync(path.join(repo, "README.md"), "x"); git("add", "."); git("commit", "-qm", "i");

  /** @param {string[]} args */
  const claude = (args) => {
    const r = spawnSync("claude", [...args, "--output-format", "stream-json", "--verbose", "--max-budget-usd", "1"], { cwd: repo, env, encoding: "utf8", timeout: 10 * 60_000 });
    assert.equal(r.status, 0, `claude exited ${r.status}: ${r.stderr.slice(-1500)}`);
    return r.stdout.trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  };
  /** The Stop-gate outcomes the plugin's hooks logged, oldest first. @returns {unknown[]} */
  const stopDecisions = () => {
    const f = path.join(state, "events.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf8").trim().split("\n").flatMap((l) => {
      /** @type {unknown} */
      const e = JSON.parse(l);
      if (typeof e !== "object" || e === null || !("event" in e) || e.event !== "gate.decision" || !("data" in e)) return [];
      const d = e.data;
      return typeof d === "object" && d !== null && "gate" in d && d.gate === "stop" && "outcome" in d ? [d.outcome] : [];
    });
  };

  const fixture = fs.readFileSync(new URL("../../cli/fixtures/livecheck-doc.md", import.meta.url), "utf8");
  const first = claude(["-p", `Use the Write tool to create docs/specs/e2e-design.md with exactly this content, then reply DONE.\n\n${fixture}`, "--allowedTools", "Write"]);
  const sid = first.find((m) => m.type === "system" && m.subtype === "init")?.session_id;
  assert.ok(typeof sid === "string", "stream-json init carries the session id");
  const spec = path.join(repo, "docs", "specs", "e2e-design.md");
  assert.ok(fs.existsSync(spec), "the session wrote the spec through the Write tool");
  assert.ok(stopDecisions().includes("blocked"), "the installed plugin's Stop hook blocked the unreviewed spec");

  const RR = path.join(engine, "review-round.mjs");
  const round = spawnSync(process.execPath, [RR, "run", "--kind", "spec", "--path", spec, "--project-root", repo], { env, encoding: "utf8", timeout: 15 * 60_000 });
  assert.ok(round.status === 0 || round.status === 10, `a real Codex round completed (exit ${round.status}): ${round.stderr.slice(-1500)}`);
  const out = JSON.parse(round.stdout.trim().split("\n").at(-1));
  assert.equal(out.score.dimensions.length, 11, "11 dimensions scored");
  if (round.status === 10) {
    const o = spawnSync(process.execPath, [RR, "override", "--key", out.key, "--reason", "e2e"], { env, encoding: "utf8" });
    assert.equal(o.status, 0, o.stderr);
  }

  const n = stopDecisions().length;
  claude(["-p", "Reply OK and nothing else.", "--resume", sid]);
  const after = stopDecisions().slice(n);
  assert.ok(after.length >= 1, "the resumed session's Stop hook ran");
  assert.equal(after.at(-1), "allowed", "Stop clears once the spec passed or was overridden");
});
```

  **Checked against the engine at plan time:**
  - `out.score.dimensions` is an array of 11 `{name, score, …}` objects. That is the shape the author's
    engine prints; see this session's `plan-rN.json`.
  - The round's JSON carries `key`.
  - `review-round.mjs --help` prints `override (--key <k> | --kind --path) [--reason <text>]`, so the
    test overrides by `--key`.

  **One thing to confirm when implementing:**
  - **Resuming across `-p` sessions.** `--resume <sid>` must work with `-p` against the same session.
    There is **no fallback**: a fresh session starts from a clean snapshot, so it cannot show that the
    blocked session clears. If resuming doesn't work, the e2e fails, Task 27's gate stays closed, and you
    page the author with the stream output. Choosing another way to drive the same session is the
    author's decision.

  The first session ends on its own. The Stop block tells Claude to run the loop, Bash isn't in
  `--allowedTools`, so the next Stop arrives with `stop_hook_active: true` and is allowed. The $1 budget
  caps any runaway.

  Run: `(set -o pipefail; npm test 2>&1 | grep -E "e2e|# (pass|fail|skipped)")`

  Expected: the e2e test is reported **skipped**, and `# fail 0`.

- [ ] **Step 2: Install the plugin from the working tree into an isolated config, then run the e2e**

  The isolated config must be **signed in**, because headless `claude -p` needs auth. Reuse the probe
  home from Task 2 (`PROBE_HOME`, already signed in there), or export `ANTHROPIC_API_KEY` for the run.
  Never copy the author's credentials.

```sh
cd ~/Code/review-loop
export CLAUDE_CONFIG_DIR="$PROBE_HOME/.claude"
claude plugin uninstall rl-probe@rl-probe --scope user >/dev/null 2>&1 || true
claude plugin marketplace add "$PWD"
claude plugin install review-loop@review-loop --scope user --json | tail -1
claude plugin list --json | jq -r '.[] | select(.id=="review-loop@review-loop" or .id=="codex@openai-codex") | "\(.id) \(.enabled)"'
(set -o pipefail; npm run e2e 2>&1 | tail -3)
claude plugin uninstall review-loop@review-loop --scope user >/dev/null; claude plugin marketplace remove review-loop >/dev/null
unset CLAUDE_CONFIG_DIR
```

  Expected:
  - `review-loop@review-loop true` and `codex@openai-codex true`. The Codex plugin arrives through the
    manifest dependency; P4 showed whether that happens automatically. If P4 recorded "manual", add
    `claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex --scope user`
    before the install line.
  - `# fail 0`.

  Record in `CLAUDE.md`: `| e2e | pass | <date>, isolated config, round exit <0|10> |`.

```bash
git add test/e2e/live.test.mjs CLAUDE.md
git commit -m "test(e2e): live round through the installed plugin in an isolated config"
```

**Gate:** `npm run e2e` exits 0 against the isolated install, and the `CLAUDE.md` `e2e` row reads
`pass`.

---

### Task 28: Publish, deferred issues (AC-22) and v1.0.0

**Preconditions:**
- Task 27's gate has passed.
- **D1 is answered:** the GitHub owner for `<owner>/review-loop` and `<owner>/homebrew-tap`. If it
  isn't, page with the question and stop.
- **Each outward-facing step below is confirmed with the author** just before it runs: creating repos,
  pushing, adding the token, creating issues, tagging. One AskUserQuestion covers the list in Step 1.

**Tooling (per `tooling-defaults`):**
- Repos, issues and PRs go through the **GitHub MCP** first.
- `gh` is the fallback, used only if the MCP lacks the operation (for example label creation). Take its
  auth check (`gh auth status`) only when you actually fall back.
- Local `git` does the pushes.

- [ ] **Step 1: Confirm the publish checklist with the author**

  Send AskUserQuestion (header `Publish`) with this list: create public repos
  `<D1>/review-loop` and `<D1>/homebrew-tap` (MIT); push `main` for both; the author creates the
  `release` environment and the `TAP_PR_TOKEN` secret; create 8 labels and 13 `deferred` issues; tag
  `v1.0.0`. The options are "Proceed" and "Stop".

- [ ] **Step 2: Replace the `<owner>` placeholder**

```sh
cd ~/Code/review-loop
OWNER="<D1 answer>"
grep -rl "<owner>" plugin cli scripts .claude-plugin .github README.md docs/RELEASE.md package.json homebrew-tap | xargs sed -i '' "s#<owner>#${OWNER}#g"
node -e 'const f="package.json";const o=JSON.parse(require("fs").readFileSync(f));o.repository={type:"git",url:`https://github.com/${process.argv[1]}/review-loop.git`};require("fs").writeFileSync(f,JSON.stringify(o,null,2)+"\n")' "$OWNER"
grep -rn "<owner>" plugin cli scripts .claude-plugin .github README.md docs/RELEASE.md package.json homebrew-tap; echo "left=$?"
(set -o pipefail; npm test 2>&1 | tail -3); npm run content-gate
```

  Expected:
  - `left=1` (grep found nothing);
  - `# fail 0`;
  - `content-gate: ok (…)`.

  The spec keeps `<owner>` as written; it is a historical document. Commit with
  `chore: set repository owner`.

- [ ] **Step 3: Create both repos and push**

  Use GitHub MCP `create_repository`, called twice, with `name: "review-loop"` and
  `name: "homebrew-tap"`. Both are `private: false`, with no auto-init; under an org, pass
  `organization`. Then:

```sh
cd ~/Code/review-loop && git remote add origin "https://github.com/${OWNER}/review-loop.git" && git push -u origin main
TAPDIR="$(mktemp -d)/homebrew-tap" && cp -R homebrew-tap "$TAPDIR" && cd "$TAPDIR" && git init -q -b main && git add -A && git commit -qm "review-loop formula" && git remote add origin "https://github.com/${OWNER}/homebrew-tap.git" && git push -u origin main
```

  Expected: both pushes print `branch 'main' set up to track 'origin/main'`. The first `ci` run on
  `review-loop` is green on both runners; check with GitHub MCP, listing workflow runs for the head SHA.
  The tap repo shows **no** workflow run yet, because its `tests` workflow is PR-only (Task 26 Step 4).

- [ ] **Step 4: The author adds the release token**

  Ask the author to create a fine-grained token scoped to `${OWNER}/homebrew-tap`, with Contents and Pull
  requests set to Read and write. They store it as the secret `TAP_PR_TOKEN` in a new environment named
  `release` on `${OWNER}/review-loop` (Settings → Environments). **Never ask them to paste the token into
  the session.**

- [ ] **Step 5: Create the labels and the 13 deferred issues (AC-22), idempotently**

  Labels: `deferred`, `platform`, `distribution`, `enhancement`, `observability`, `engine`, `security`,
  `reliability`. If the MCP has no label tool, create each with
  `gh label create <name> --repo "${OWNER}/review-loop" --force`; `--force` makes a re-run safe.

  Issues: one per §15 row, with title `[deferred] <item>` exactly as in the table, labels `deferred`
  plus that row's extra labels, and this body:

```
Deferred from v1.

**Why deferred:** <the row's Reason cell>

Spec: https://github.com/<OWNER>/review-loop/blob/main/docs/superpowers/specs/2026-09-28-review-loop-homebrew-design.md#15-deferred--github-issues-when-the-repo-is-created-published-and-pushed
```

  For **each** row: search open issues for the exact title, using the GitHub MCP issue search or
  `list_issues` with label `deferred`. Create the issue only when none matches.

  The 13 titles, verbatim:
  1. `[deferred] Linux and WSL support`
  2. `[deferred] Native Windows support`
  3. `[deferred] Submission to homebrew-core`
  4. `[deferred] Per-project presets`
  5. `[deferred] Direct HTTP/OTLP event push`
  6. `[deferred] Automatic plugin update on brew upgrade`
  7. `[deferred] A killed round leaks ws temp dirs`
  8. `[deferred] The Stop gate fails closed on harmless text mentions`
  9. `[deferred] Override cannot work on criss-cross merge history`
  10. `[deferred] review-loop protect <repo>: automated branch-protection helper`
  11. `[deferred] Source-restricted required check via a GitHub App`
  12. `[deferred] Atomic-exchange commit for settings.json via a signed native helper`
  13. `[deferred] Revoke earlier approval marks automatically on policy change`

  **Gate (AC-22):** list open issues with label `deferred` and count those whose title is in the list
  above. Expected: `13`.

  Then run the step a **second time**. Expected: 0 issues created and the count is still `13`, proving
  it's idempotent.

  The spec anchor in the body must resolve. Open the issue link once and confirm it lands on §15. If
  GitHub's generated anchor differs, fix the body in all 13 issues with the MCP `update_issue`.

- [ ] **Step 6: Release v1.0.0**

```sh
cd ~/Code/review-loop
git checkout -b release-1.0.0
node scripts/bump-version.mjs 1.0.0 && node scripts/release-check.mjs 1.0.0; echo "exit=$?"
git commit -am "release: v1.0.0"
git push -u origin release-1.0.0
```

  Expected: `exit=0`.

  Open the release PR with the GitHub MCP `create_pull_request`. The PR gate requires the loop first:
  run `$RR run --key <key>` per the plugin skill until exit 0, then `$RR push --key <key>`, then create
  the PR (AC-20: the release PR passes its own loop). Merge it with the reviewed head SHA through the
  GitHub MCP, or with `gh pr merge --match-head-commit <sha>`. Then:

```sh
git checkout main && git pull --ff-only && git tag v1.0.0 && git push origin v1.0.0
```

  Expected: the `release` workflow goes green, a GitHub release `review-loop 1.0.0` has the tarball
  attached, and a PR titled `review-loop 1.0.0` opens on `${OWNER}/homebrew-tap`. Its `tests` workflow
  is green on both runners, T-REL-4 included. Merge the tap PR.

- [ ] **Step 7: The install check from a clean state**

  Run: `brew install ${OWNER}/tap/review-loop && review-loop --version && brew test review-loop`

  Expected: `review-loop 1.0.0` and `brew test` exits 0.

  This checks the Homebrew side. The plugin side was proven in Task 27, and Task 29 proves both
  together on the author's real setup.

  Record in `CLAUDE.md`: `| published | v1.0.0 | <date> | 13 deferred issues |`. Commit and push to
  `main` through a PR, like any change.

**Gate:**
- the AC-22 count is `13`, twice;
- `brew test review-loop` exits 0;
- the tap `tests` run for the v1.0.0 PR is green.

---

### Task 29: Migrate the author's Mac to the published package (spec §14, AC-18, AC-20)

**Preconditions:**
- Task 28's gate has passed, and `brew install <owner>/tap/review-loop` is on the author's Mac, so
  `review-loop --version` prints `review-loop 1.0.0`.
- **The author has approved migrating their machine.** The migration changes
  `~/.claude/settings.json` and moves the hand-installed engine. It is reversible with
  `review-loop migrate --rollback`.

**Invariants:**
- **The migration is run by the author in a separate terminal, with every Claude Code session
  closed.** The settings writer refuses under `CLAUDECODE=1` and while `claude` is running (§6.2).
  That refusal is the designed safety, so don't work around it.
- **Rollback stays available** until the author deletes `~/.claude/review-loop-legacy-<date>/`.

- [ ] **Step 1: Page the author**

  Send PushNotification with
  `review-loop: ready to migrate your Mac to the plugin (reversible with migrate --rollback) — approve?`.
  Then send AskUserQuestion with the options "Yes — I'll run it in a separate terminal" and "Not now".
  Show the exact command from Step 2. On "Not now", stop here: v1.0.0 is already published.

- [ ] **Step 2: The author runs the migration (outside Claude Code, all sessions closed)**

```sh
review-loop migrate; echo "exit=$?"
```

  Expected:
  - a per-step preview with prompts, including the `CLAUDE.md` diff (D6);
  - `Migrated. To undo: review-loop migrate --rollback`;
  - `exit=0`.

  If it exits 1 with `preflight_failed`, doctor found a problem and the legacy folder stayed in place.
  The author pastes the `review-loop doctor` output back into the session.

- [ ] **Step 3: Verify in a fresh Claude Code session**

  Run: `review-loop doctor --json | jq -c '{ok, failing: [.checks[] | select(.status=="fail") | .id]}'`

  Expected: `{"ok":true,"failing":[]}`.

  Run: `jq '.hooks // {} | tostring | test("review-gate-hook")' ~/.claude/settings.json`

  Expected: `false`.

  Run: `review-loop doctor --live; echo "exit=$?"`

  Expected: `exit=0` (one paid round).

- [ ] **Step 4: AC-20 — the package passes its own loop through the plugin**

  Run the loop on the implementation using the **plugin's** skill `review-loop:review-loop`, with
  `node "$(review-loop engine-path)/review-round.mjs" run --kind impl --path ~/Code/review-loop`, until
  it exits 0.

  Record in `CLAUDE.md`: `| dogfood | pass | <date> impl round N score X.X via plugin |`. Commit through
  a PR, which the plugin's PR gate now enforces.

**Gate:** `review-loop doctor --json` reports `ok:true`, and the `CLAUDE.md` `dogfood` row reads `pass`.
