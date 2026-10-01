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
const io = (answers = []) => ({ isTTY: true, color: false, lines: [], outs: [], out(s) { this.outs.push(s); }, err(s) { this.lines.push(s); }, ask: async () => answers.shift() ?? true, choose: async (_q, _o, d) => d, env: process.env });
const PS = "    1     0 /sbin/launchd\n  200     1 -zsh\n";

function sandbox(claudeResponses = {}) {
  const home = tmpDir();
  Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, ".config", "review-loop", "config.json") });
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "state"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, "state", "events.jsonl"), "");
  fs.mkdirSync(path.dirname(process.env.REVIEW_LOOP_CONFIG), { recursive: true });
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "x", permissions: { ask: [...ASK_RULES, "Bash(mine)"] } }));
  const installed = JSON.stringify([{ id: "review-loop@review-loop", enabled: true, version: "0.1.0", installPath: "/x" }]);
  // First list call (before uninstalling) sees the plugin; later calls (the final dangling check, a re-run) don't.
  const claude = makeFakeBin(bin, "claude", { "plugin list --json": [{ stdout: installed }, { stdout: "[]" }], "*": { stdout: "{}\n" }, ...claudeResponses });
  makeFakeBin(bin, "ps", { "*": { stdout: PS } });
  makeFakeBin(bin, "lsof", { "*": { code: 1 } });
  return { home, claude };
}
const settingsOf = (s) => JSON.parse(fs.readFileSync(path.join(s.home, ".claude", "settings.json"), "utf8"));

test("T-UN-1: order is plugin → marketplace → settings → config; history kept by default", async () => {
  const s = sandbox();
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
  const calls = s.claude.log().map((a) => a.slice(0, 3).join(" "));
  assert.deepEqual(calls.filter((c) => c.startsWith("plugin uninstall") || c.startsWith("plugin marketplace")), ["plugin uninstall review-loop@review-loop", "plugin marketplace remove"]);
  const settings = settingsOf(s);
  assert.deepEqual(settings.permissions.ask, ["Bash(mine)"]);
  assert.equal(settings.theme, "x");
  assert.equal(fs.existsSync(process.env.REVIEW_LOOP_CONFIG), false);
  assert.equal(fs.existsSync(path.join(s.home, "state")), true, "history kept (T-UN-3)");
});

test("T-UN-1 (−): plugin uninstall fails → nothing else removed, exit 1", async () => {
  const s = sandbox({ "plugin uninstall review-loop@review-loop --scope user --json": { code: 1, stderr: "boom" } });
  const o = io();
  assert.equal(await main(["uninstall", "--yes"], o), 1);
  assert.match(o.lines.join(""), /review-loop: plugin_uninstall_failed/, "an uninstall failure has its own code (L13)");
  assert.equal(settingsOf(s).permissions.ask.length, 6);
  assert.ok(fs.existsSync(process.env.REVIEW_LOOP_CONFIG));
  assert.ok(!s.claude.log().some((a) => a[1] === "marketplace" && a[2] === "remove"), "marketplace untouched");
});

test("T-UN-1 (−): marketplace remove fails for a real reason → settings and config kept", async () => {
  const s = sandbox({ "plugin marketplace remove review-loop": { code: 1, stderr: "permission denied" } });
  const o = io();
  assert.equal(await main(["uninstall", "--yes"], o), 1);
  assert.match(o.lines.join(""), /review-loop: plugin_uninstall_failed/);
  assert.equal(settingsOf(s).permissions.ask.length, 6);
  assert.ok(fs.existsSync(process.env.REVIEW_LOOP_CONFIG));
});

test("T-UN-3: --delete-history removes the history; only the final cli.exit event may remain (R-D26)", async () => {
  const s = sandbox();
  for (const d of ["records", "markers", "baselines"]) fs.mkdirSync(path.join(s.home, "state", d));
  fs.writeFileSync(path.join(s.home, "state", "migration.json"), "{}");
  const o = io();
  assert.equal(await main(["uninstall", "--yes", "--delete-history"], o), 0);
  assert.deepEqual(fs.existsSync(path.join(s.home, "state")) ? fs.readdirSync(path.join(s.home, "state")) : [], ["events.jsonl"]);
  assert.match(o.lines.join(""), /final uninstall event was logged/);
});

test("L3: a history dir that cannot be removed is a named, registered failure (exit 1), not unexpected_error", { skip: process.getuid?.() === 0 }, async () => {
  const s = sandbox();
  const locked = path.join(s.home, "state", "records");
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "r.json"), "{}");
  fs.chmodSync(locked, 0o500);
  try {
    const o = io();
    assert.equal(await main(["uninstall", "--yes", "--delete-history"], o), 1);
    const text = o.lines.join("");
    assert.match(text, /could not be fully deleted \((ENOTEMPTY|EACCES)\)/);
    assert.match(text, /review-loop: state_dir_insecure/);
    assert.doesNotMatch(text, /unexpected_error/);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("T-UN-3 (−): --yes alone keeps history; an interactive n keeps it; an interactive y deletes it", async () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.home, "state", "records"));
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
  assert.ok(fs.existsSync(path.join(s.home, "state", "records")));
  const t = sandbox();
  fs.mkdirSync(path.join(t.home, "state", "records"));
  assert.equal(await main(["uninstall"], io([true, false])), 0);
  assert.ok(fs.existsSync(path.join(t.home, "state", "records")));
  const u = sandbox();
  fs.mkdirSync(path.join(u.home, "state", "records"));
  assert.equal(await main(["uninstall"], io([true, true])), 0);
  assert.equal(fs.existsSync(path.join(u.home, "state", "records")), false);
});

test("T-UN-3 (−): a symlinked state root is refused and its target is untouched", async () => {
  const s = sandbox();
  const target = path.join(s.home, "elsewhere");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "x");
  fs.rmSync(path.join(s.home, "state"), { recursive: true });
  fs.symlinkSync(target, path.join(s.home, "state"));
  const o = io();
  const code = await main(["uninstall", "--yes", "--delete-history"], o);
  assert.equal(code, 1);
  assert.ok(fs.existsSync(path.join(target, "keep.txt")), "link target untouched");
  assert.ok(fs.lstatSync(path.join(s.home, "state")).isSymbolicLink());
  const text = o.lines.join("");
  assert.match(text, /state_symlink_rejected/);
  assert.match(text, /is a symbolic link; it was not deleted/);
  assert.doesNotMatch(text, /unexpected_error/);
});

test("T-UN-3 (−): step 5 itself refuses a symlinked or foreign state root (past the CLI lock)", async () => {
  const { run } = await import("../../cli/lib/uninstall.mjs");
  const s = sandbox();
  fs.writeFileSync(path.join(s.home, ".claude", "settings.json"), JSON.stringify({ theme: "x" }));
  const target = path.join(s.home, "elsewhere");
  fs.mkdirSync(path.join(target, "records"), { recursive: true });
  fs.rmSync(path.join(s.home, "state"), { recursive: true });
  fs.symlinkSync(target, path.join(s.home, "state"));
  await assert.rejects(run(["--delete-history"], io(), { yes: true }), (e) => e.code === "state_symlink_rejected" && /symbolic link/.test(e.message));
  assert.ok(fs.existsSync(path.join(target, "records")), "link target untouched");
  assert.ok(fs.lstatSync(path.join(s.home, "state")).isSymbolicLink());
});

test("T-UN-4: a re-run after partial failure completes and tolerates already-removed items", async () => {
  const s = sandbox();
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
  s.claude.set({ "plugin list --json": { stdout: "[]" }, "plugin marketplace remove review-loop": { code: 1, stderr: "✘ Failed to remove marketplace: Marketplace 'review-loop' not found" }, "*": { stdout: "{}\n" } });
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
  assert.match(out.lines.join(""), /plugin_install_failed/);
  assert.ok(t.claude.log().some((a) => a.join(" ") === "plugin list --json"), "doctor still ran");
});

test("L4: a failed plugin update keeps its code when doctor then crashes", async () => {
  sandbox({ "plugin update review-loop@review-loop --json": { code: 1, stderr: "nope" } });
  const o = io();
  // Doctor's first check line throws, as a closed stderr pipe would.
  const crashing = { ...o, err(/** @type {string} */ t) { if (/^. (OK|FAIL|WARN|SKIP)/.test(t)) throw Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" }); o.lines.push(t); } };
  assert.equal(await main(["update"], crashing), 1);
  assert.match(o.lines.join(""), /review-loop: plugin_install_failed/);
  assert.doesNotMatch(o.lines.join(""), /unexpected_error/);
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

const withHook = (s, command) => {
  const f = path.join(s.home, ".claude", "settings.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }));
};

for (const command of ["node /Users/x/.claude/review-loop/review-gate-hook.mjs stop", "node /Users/x/.claude/plugins/cache/review-loop/review-loop/0.1.0/engine/review-gate-hook.mjs stop"]) {
  test(`T-UN-2: a leftover review-loop hook fails the final check and is named (${command.slice(0, 40)})`, async () => {
    const s = sandbox();
    withHook(s, command);
    const o = io();
    assert.equal(await main(["uninstall", "--yes"], o), 1);
    const text = o.lines.join("");
    assert.match(text, /a hook still references review-loop: node /);
    assert.match(text, /settings_hook_present/);
    assert.match(text, /Removed so far: .*\nNot yet removed: /);
  });
}

test("T-UN-2 (−): an unrelated hook in a dev checkout named review-loop does not fail uninstall", async () => {
  const s = sandbox();
  withHook(s, "node /Users/x/dev/review-loop/engine/foo.mjs");
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
});

test("T-UN-6: a plugin uninstall reporting failureCode not_installed is already gone; other failures stop", async () => {
  sandbox({ "plugin uninstall review-loop@review-loop --scope user --json": { code: 1, stdout: JSON.stringify({ command: "uninstall", outcome: "failed", plugin: "review-loop@review-loop", scope: "user", message: "Plugin \"review-loop@review-loop\" not found in installed plugins", failureCode: "not_installed" }) + "\n" } });
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
});

test("T-UN-7: preconditions are checked before anything is removed", async () => {
  const s = sandbox();
  process.env.CLAUDECODE = "1";
  try {
    const o = io();
    assert.equal(await main(["uninstall", "--yes"], o), 1);
    assert.match(o.lines.join(""), /claude_parent_process/);
  } finally { delete process.env.CLAUDECODE; }
  assert.ok(!s.claude.log().some((a) => a[1] === "uninstall" || (a[1] === "marketplace" && a[2] === "remove")), "nothing was removed");
  assert.equal(settingsOf(s).permissions.ask.length, 6);
  assert.ok(fs.existsSync(process.env.REVIEW_LOOP_CONFIG));
});

test("a custom REVIEW_LOOP_CONFIG keeps its parent directory; a directory at the config path is refused", async () => {
  const s = sandbox();
  const custom = path.join(s.home, "mine", "cfg.json");
  fs.mkdirSync(path.dirname(custom));
  fs.writeFileSync(custom, "{}");
  process.env.REVIEW_LOOP_CONFIG = custom;
  assert.equal(await main(["uninstall", "--yes"], io()), 0);
  assert.equal(fs.existsSync(custom), false);
  assert.ok(fs.existsSync(path.dirname(custom)), "parent of a custom path is left alone");
  const t = sandbox();
  fs.rmSync(process.env.REVIEW_LOOP_CONFIG);
  fs.mkdirSync(process.env.REVIEW_LOOP_CONFIG);
  const o = io();
  assert.equal(await main(["uninstall", "--yes"], o), 1);
  assert.match(o.lines.join(""), /config_invalid/);
  assert.ok(fs.existsSync(process.env.REVIEW_LOOP_CONFIG));
});

test("T-UN-2 (+): the plugin still listed after uninstall fails the final check", async () => {
  const s = sandbox();
  s.claude.set({ "plugin list --json": { stdout: JSON.stringify([{ id: "review-loop@review-loop", enabled: true }]) }, "*": { stdout: "{}\n" } });
  const o = io();
  assert.equal(await main(["uninstall", "--yes"], o), 1);
  assert.match(o.lines.join(""), /review-loop: plugin_uninstall_failed/, "not preflight_failed (L13)");
});

test("uninstall without a terminal or --yes is a usage error and changes nothing", async () => {
  const s = sandbox();
  assert.equal(await main(["uninstall"], { ...io(), isTTY: false }), 2);
  assert.equal(settingsOf(s).permissions.ask.length, 6);
});

test("engine-path prints the engine directory; --json prints one event carrying path (R-D47); not installed → exit 1", async () => {
  const s = sandbox({ "plugin list --json": { stdout: JSON.stringify([{ id: "review-loop@review-loop", installPath: "/x/y" }]) } });
  const o = io();
  assert.equal(await main(["engine-path"], o), 0);
  assert.deepEqual(o.outs, ["/x/y/engine\n"]);
  const j = io();
  assert.equal(await main(["engine-path", "--json"], j), 0);
  assert.equal(j.outs.length, 1);
  const v = JSON.parse(j.outs[0]);
  assert.equal(v.path, "/x/y/engine");
  assert.equal(v.event.event, "cli.exit");
  s.claude.set({ "plugin list --json": { stdout: "[]" } });
  const n = io();
  assert.equal(await main(["engine-path"], n), 1);
  assert.deepEqual(n.outs, []);
  assert.match(n.lines.join(""), /plugin_install_failed/);
});
