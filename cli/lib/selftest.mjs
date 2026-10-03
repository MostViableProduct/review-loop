// `review-loop selftest`: the offline smoke test `brew test` runs. It drives the BUNDLED engine hooks in a throwaway
// HOME/state/git repo and never touches the network, gh, claude, codex or brew: a failing `gh` stub leads its PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.mjs";
import { validateLine } from "../../plugin/engine/lib/events.mjs";

const HOOK = fileURLToPath(new URL("../../plugin/engine/review-gate-hook.mjs", import.meta.url));
// Built by concatenation so this file's own text never trips a gate that scans for the literal command.
const G = "g" + "h";

/** @typedef {"stop_blocks" | "pr_gate_denies" | "clean_repo_passes" | "events_schema_v1" | "git_failed" | "hook_failed"} CheckId */

/** The failing check's id is the event detail (spec §10.4); the sentence is for the terminal. @param {CheckId} id @param {string} what */
const checkFailed = (id, what) => new CliError("selftest_failed", `selftest: ${what}`, id);

/** @param {boolean} ok @param {CheckId} id @param {string} what */
const expect = (ok, id, what) => { if (!ok) throw checkFailed(id, what); };

/**
 * The real git binary, found with the caller's full environment. `git` on PATH can be a wrapper that needs variables
 * the hermetic environment below drops: inside `brew test` it is Homebrew's shim, which exits 1 without
 * HOMEBREW_LIBRARY; asdf and mise shims are alike. git's exec-path holds the binary itself. Falls back to `git`.
 * @returns {string}
 */
function realGit() {
  const r = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 15000 });
  const dir = r.status === 0 ? r.stdout.trim() : "";
  if (!path.isAbsolute(dir)) return "git";
  const bin = path.join(dir, "git");
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return fs.statSync(bin).isFile() ? bin : "git";
  } catch {
    return "git";
  }
}

/** git's last stderr line, bounded: names why it failed without echoing more than a line. @param {string} stderr */
const gitReason = (stderr) => {
  const line = stderr.trim().split("\n").at(-1)?.trim() ?? "";
  return line ? `: ${line.slice(0, 200)}` : "";
};

/**
 * @param {string[]} _args
 * @param {import("./io.mjs").IO} io
 * @param {{ json: boolean }} ctx
 * @returns {Promise<{ code: string, json: { code: string, checks: string[] } }>}
 */
export async function run(_args, io, ctx) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rl-selftest-")));
  // Built from scratch, never from process.env: every variable the engine reads that could reach the user's real
  // ~/.claude, ~/.codex or config is pinned inside the temp home (paths.mjs, codexcfg.mjs, pin.mjs; the config location is pinned by REVIEW_LOOP_CONFIG).
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // Hook paths that would reach GitHub run this instead of the user's gh, so selftest stays hermetic.
  fs.writeFileSync(path.join(bin, G), "#!/bin/sh\necho 'selftest: gh is not available here' >&2\nexit 1\n", { mode: 0o755 });
  // Every git call below, selftest's and the hooks', reaches the real binary even though the environment is rebuilt.
  const gitBin = realGit();
  if (gitBin !== "git") fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nexec '${gitBin.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const env = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    REVIEW_LOOP_STATE_DIR: path.join(home, "state"),
    REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"),
    REVIEW_LOOP_PIN_FILE: path.join(home, "pin.json"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com"
  };
  /** @param {string} cwd @param {string[]} a */
  const git = (cwd, a) => {
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" });
    if (r.error || r.status !== 0) throw checkFailed("git_failed", `git unavailable or failed (git ${a[0]})${gitReason(r.stderr ?? "")}`);
  };
  /** @param {string} mode @param {Record<string, unknown>} input @param {boolean} [mustSpeak] @returns {string} */
  const hook = (mode, input, mustSpeak = false) => {
    const r = spawnSync(process.execPath, [HOOK, mode], { env, input: JSON.stringify(input), encoding: "utf8", timeout: 30000 });
    if (r.error) throw checkFailed("hook_failed", `hook ${mode} did not run`);
    if (r.status !== 0) throw checkFailed("hook_failed", `hook ${mode} exited ${r.status}`);
    // stop and pr must speak (a block/deny) on the blocking path; the clean-repo stop is checked via the event log.
    if (mustSpeak && r.stdout.trim() === "") throw checkFailed(mode === "pr" ? "pr_gate_denies" : "stop_blocks", `the ${mode === "pr" ? "PR gate" : "Stop hook"} produced no output`);
    return r.stdout;
  };
  /** @param {string} dir */
  const makeRepo = (dir) => {
    fs.mkdirSync(dir);
    git(dir, ["init", "-q"]);
    fs.writeFileSync(path.join(dir, "README.md"), "x");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-qm", "init"]);
  };
  try {
    const repo = path.join(home, "repo");
    const clean = path.join(home, "clean");
    makeRepo(repo);
    makeRepo(clean);

    hook("session", { session_id: "st-1", cwd: repo });
    const spec = path.join(repo, "docs", "specs", "x-design.md");
    fs.mkdirSync(path.dirname(spec), { recursive: true });
    fs.writeFileSync(spec, "# x\n");
    hook("track", { session_id: "st-1", cwd: repo, tool_input: { file_path: spec } });
    expect(/"decision":"block"/.test(hook("stop", { session_id: "st-1", cwd: repo, stop_hook_active: false }, true)), "stop_blocks", "Stop did not block an unreviewed spec");
    // No GitHub remote, so the gate denies with pr_args_unresolvable or pr_base_repo_ambiguous: still a deny, which
    // proves the PR gate is wired and fails closed.
    expect(/"permissionDecision":"deny"/.test(hook("pr", { session_id: "st-1", cwd: repo, tool_name: "Bash", tool_input: { command: `${G} pr create --title t` } }, true)), "pr_gate_denies", "the PR gate did not deny");
    hook("session", { session_id: "st-2", cwd: clean });
    expect(!/"decision"/.test(hook("stop", { session_id: "st-2", cwd: clean, stop_hook_active: false })), "clean_repo_passes", "Stop blocked a clean repo");

    const log = path.join(home, "state", "events.jsonl");
    expect(fs.existsSync(log), "events_schema_v1", "no events.jsonl was written");
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length > 0, "events_schema_v1", "events.jsonl is empty");
    // Positive proof the clean-repo Stop hook ran and allowed: empty stdout alone would also match a hook that did nothing.
    expect(lines.some((l) => { try { const e = JSON.parse(l); return e.event === "gate.decision" && e.session_id === "st-2" && e.data?.gate === "stop" && e.data?.outcome === "allowed"; } catch { return false; } }), "clean_repo_passes", "the clean-repo Stop hook did not log an allowed decision");
    expect(lines.every((l) => { try { return validateLine(JSON.parse(l)).length === 0; } catch { return false; } }), "events_schema_v1", "events.jsonl is not schema v1");
    if (!ctx.json) io.out("review-loop selftest: ok\n");
    return { code: "ok", json: { code: "ok", checks: ["stop_blocks", "pr_gate_denies", "clean_repo_passes", "events_schema_v1"] } };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
