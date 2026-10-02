import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";
import { COMMANDS_ENUM, GATES } from "../../plugin/engine/lib/codes.mjs";
import { MIN_CLAUDE } from "../../cli/lib/preflight.mjs";

const S = "SENTINEL-CONTENT-7f3a";
const SENTINELS = [S, "/Users/", "@example.com", "ENVSECRET"];
const CLI = path.resolve("cli/review-loop.mjs");
const SHIM = path.resolve("plugin/bin/hook");
const FIXTURE_BASE = path.resolve("test/fixtures/fake-codex-plugin");
// Built, so this file's own text never trips a gate that scans for the literal command.
const G = "g" + "h";

test("T-OBS-5 / T-OBS-1: no sentinel reaches events.jsonl across every CLI command and hook mode; every line is schema v1", { timeout: 180_000 }, () => {
  const home = tmpDir(`rl-${S}-`);
  const bin = path.join(home, "bin");
  const state = path.join(home, "state");
  // Built from scratch, never from process.env: nothing here can reach the real ~/.claude, ~/.codex, config or state.
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    REVIEW_LOOP_STATE_DIR: state, REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"), REVIEW_LOOP_PIN_FILE: path.join(home, "pin.json"),
    REVIEW_LOOP_PLUGIN_BASE: FIXTURE_BASE, REVIEW_LOOP_NODE_CANDIDATES: process.execPath, REVIEW_LOOP_TEST_FALLBACK_DIRS: "",
    CODEX_HOME: path.join(home, "codex"), X_TOKEN: "ENVSECRET", SECRET_NOTE: `${S} /Users/x a@example.com`,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "sentinel@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "sentinel@example.com"
  };
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "codex"));
  fs.writeFileSync(path.join(home, "codex", "config.toml"), `model = "gpt-${S}"\n# /Users/x a@example.com ENVSECRET\n`);
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ note: `${S} /Users/x ENVSECRET a@example.com`, hooks: { Stop: [{ hooks: [{ type: "command", command: `/Users/${S}/x` }] }] } }));
  const list = JSON.stringify([{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }, { id: "review-loop@review-loop", enabled: true, scope: "user", version: "0.1.0", installPath: path.resolve("plugin") }]);
  makeFakeBin(bin, "claude", { "--version": { stdout: `${MIN_CLAUDE} (Claude Code)\n` }, "plugin list --json": { stdout: list }, "*": { stdout: "{}\n", stderr: `${S} /Users/x\n` } });
  makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in as sentinel@example.com\n" }, "*": { code: 1, stderr: `${S}\n` } });
  makeFakeBin(bin, G, { "*": { code: 1, stderr: `${S} /Users/x ENVSECRET\n` } });
  makeFakeBin(bin, "ps", { "*": { stdout: "    1     0 /sbin/launchd\n  200     1 -zsh\n" } });
  makeFakeBin(bin, "lsof", { "*": { code: 1 } });

  const repo = path.join(home, `repo ${S}`);
  fs.mkdirSync(repo);
  const git = (/** @type {string[]} */ ...a) => spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], { cwd: repo, env });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/o/r-${S}.git`);
  fs.writeFileSync(path.join(repo, "README.md"), "x");
  git("add", ".");
  git("commit", "-qm", `i ${S}`);
  const spec = path.join(repo, "docs", "specs", `${S}-design.md`);

  // Through the production shim (plugin/bin/hook), once with node found and once without (the shim's own writer).
  /** @param {string} mode @param {Record<string, unknown>} input @param {string} [nodes] */
  const hook = (mode, input, nodes = process.execPath) => spawnSync(SHIM, [mode], { cwd: repo, env: { ...env, REVIEW_LOOP_NODE_CANDIDATES: nodes }, input: JSON.stringify({ session_id: "s1", cwd: repo, ...input }), encoding: "utf8", timeout: 60_000 });
  const inputs = /** @type {Array<[string, Record<string, unknown>]>} */ ([
    ["session", {}],
    ["track", { tool_name: "Write", tool_input: { file_path: spec } }],
    ["stop", { stop_hook_active: false }],
    ["prompt", { prompt: `${S} /Users/x a@example.com` }],
    ["pr", { tool_name: "Bash", tool_input: { command: `${G} pr create --title ${S} --body /Users/x` } }],
    ["pr", { tool_name: "Bash", tool_input: { command: `${G} pr merge 1 --match-head-commit deadbeef` } }],
    ["pr", { tool_name: "mcp__github__merge_pull_request", tool_input: { owner: "o", repo: S, pullNumber: 1 } }],
    ["prverify", { tool_name: "Bash", tool_input: { command: `${G} pr create --title ${S}` }, tool_response: { stdout: `https://github.com/o/${S}/pull/1\n` } }]
  ]);
  // The spec is written after SessionStart, so it counts as changed this session and Stop takes the blocking path.
  hook("session", {});
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  fs.writeFileSync(spec, `${S} a@example.com /Users/x ENVSECRET\n`);
  for (const [mode, input] of inputs.slice(1)) hook(mode, input);
  for (const [mode, input] of inputs) hook(mode, input, path.join(home, "no-node"));

  const cli = (/** @type {string[]} */ ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: repo, env, encoding: "utf8", input: "", timeout: 90_000 });
  cli("--version"); cli("--version", "--json"); cli("--help"); cli(`bogus-${S}`);
  cli("config", "show", "--json"); cli("config", "set", "rubric", `/Users/${S}/r.md`); cli("config", "set", "effort", S);
  cli("config", "set", "events.path", `/Users/${S}/e.jsonl`); cli("config", "set", "preset", S);
  // Value-carrying SUCCESS paths: valid files whose names carry the sentinel. The events path then moves, so the
  // commands in between write to the sentinel-named log, which is read below too.
  const rubric = path.join(home, `rubric-${S}`, `r-${S}.md`);
  fs.mkdirSync(path.dirname(rubric));
  fs.copyFileSync(path.resolve("plugin/rubric/default.md"), rubric);
  const movedLog = path.join(home, `ev-${S}`, `events-${S}.jsonl`);
  fs.mkdirSync(path.dirname(movedLog), { mode: 0o700 });
  assert.equal(cli("config", "set", "rubric", rubric).status, 0, "config set rubric <valid path> succeeds");
  assert.equal(cli("config", "set", "events.path", movedLog).status, 0, "config set events.path <valid path> succeeds");
  cli("config", "show", "--json"); cli("doctor", "--json");
  assert.equal(cli("config", "set", "events.path", "default").status, 0);
  cli("doctor", "--json"); cli("setup", "--yes", "--skip-live-check"); cli("engine-path");
  cli("update", "--yes"); cli("migrate", "--yes"); cli("migrate", "--rollback", "--yes");
  cli("uninstall", "--yes", "--keep-history"); cli("selftest", "--json");

  const files = [path.join(state, "events.jsonl"), path.join(state, "events.jsonl.1"), movedLog, `${movedLog}.1`].filter((f) => fs.existsSync(f));
  assert.ok(fs.existsSync(movedLog) && fs.statSync(movedLog).size > 0, "the moved log was written");
  const text = files.map((f) => fs.readFileSync(f, "utf8")).join("");
  const lines = text.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 30, `corpus produced ${lines.length} lines — too few to be meaningful`);
  for (const s of SENTINELS) assert.ok(!text.includes(s), `sentinel ${s} leaked into events.jsonl`);
  const events = lines.map((l) => /** @type {Record<string, unknown>} */ (JSON.parse(l)));
  for (const e of events) assert.deepEqual(validateLine(e), [], `every line is schema v1 (T-OBS-1): ${JSON.stringify(e)}`);

  const dataOf = (/** @type {Record<string, unknown>} */ e) => /** @type {Record<string, unknown>} */ (e.data);
  const commands = new Set(events.filter((e) => e.event === "cli.exit").map((e) => dataOf(e).command));
  assert.deepEqual([...commands].sort(), [...COMMANDS_ENUM].sort(), "the corpus runs every CLI command (a new command must be added here)");
  const gates = new Set(events.filter((e) => e.event === "gate.decision").map((e) => dataOf(e).gate));
  assert.deepEqual([...gates].sort(), [...GATES].sort(), "the corpus reaches every gate (a new gate must be added here)");
  assert.ok(events.some((e) => e.code === "node_missing"), "the shim's own no-node writer ran");
  assert.ok(events.some((e) => e.event === "gate.decision" && e.code === "review_pending" && dataOf(e).outcome === "blocked"), "Stop took the blocking path");
});
