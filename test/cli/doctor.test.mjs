import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { signalPid } from "../fakes/signal.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:/usr/bin:/bin`;
const FIXTURE_BASE = path.join(process.cwd(), "test", "fixtures", "fake-codex-plugin");
const { DOCTOR_CHECKS, memoRunner } = await import("../../cli/lib/doctor.mjs");
const { main } = await import("../../cli/review-loop.mjs");
const { ASK_RULES } = await import("../../cli/lib/settings.mjs");
const { MIN_CLAUDE } = await import("../../cli/lib/preflight.mjs");
const { ownerSeam } = await import("../../cli/lib/configguard.mjs");
const { PACKAGE_VERSION } = await import("../../plugin/engine/lib/events.mjs");
const { CODES } = await import("../../plugin/engine/lib/codes.mjs");
const { writePin, latestInstalledVersion } = await import("../../plugin/engine/lib/pin.mjs");
const { sha256hex } = await import("../../plugin/engine/lib/fsutil.mjs");

const claudeVersion = { stdout: `${MIN_CLAUDE} (Claude Code)\n` };
const [MAJOR, MINOR] = PACKAGE_VERSION.split(".").map(Number);
const SKEWED = `${MAJOR}.${MINOR + 1}.0`;
const CODEX_PLUGIN = { id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" };
const reviewLoop = (over = {}) => ({ id: "review-loop@review-loop", enabled: true, scope: "user", version: PACKAGE_VERSION, installPath: path.join(process.cwd(), "plugin"), ...over });
const fakeClaude = (list) => makeFakeBin(bin, "claude", { "--version": claudeVersion, "plugin list --json": { stdout: JSON.stringify(list) } });
const quiet = { isTTY: false, color: false, lines: [], out() {}, err(s) { this.lines.push(s); }, ask: async () => true, choose: async (_q, _o, d) => d, env: process.env };
const ctx = (live = false) => ({ live, io: quiet, tool: memoRunner() });
const check = (id) => /** @type {(typeof DOCTOR_CHECKS)[number]} */ (DOCTOR_CHECKS.find((c) => c.id === id));

/** A fully healthy sandbox, pinned to the Task 1 fixture plugin: every check passes (live warns without --live). */
function healthy() {
  const home = tmpDir();
  Object.assign(process.env, {
    HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"),
    CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    REVIEW_LOOP_NODE_CANDIDATES: process.execPath, REVIEW_LOOP_PLUGIN_BASE: FIXTURE_BASE
  });
  delete process.env.REVIEW_LOOP_PIN_FILE;
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "state"), { mode: 0o700 });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: [...ASK_RULES] } }));
  fakeClaude([CODEX_PLUGIN, reviewLoop()]);
  makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in\n" } });
  makeFakeBin(bin, "gh", { "auth status": { stdout: "ok\n" } });
  writePin(latestInstalledVersion());
  return home;
}

const writeConfig = (over = {}) => fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null }, ...over }));

/** Orphan brokers the tests started, reaped at the end whatever the assertions said. @type {number[]} */
const orphans = [];
test.after(() => {
  for (const pid of orphans) signalPid(pid, "SIGKILL", { group: true });
});

const STUBBORN_CHILD = 'spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })';

/**
 * A broker running from a ws/ snapshot that has since been removed (an inherited leak): its args name the snapshot's
 * broker script, it leads its own group, and it has a child in that group. `ignoreTerm`: the broker ignores SIGTERM;
 * `termLeavesChild`: on SIGTERM it exits without closing its child; `termSpawnsChild`: on SIGTERM it first starts a
 * new child (in its group, ignoring SIGTERM), then exits. `appServer`: the child is a `codex app-server` (by its
 * command line) that ignores SIGTERM. `nonLeader`: the broker runs in its (exited) launcher's group, not its own.
 * @param {string} h @param {{ ignoreTerm?: boolean, termLeavesChild?: boolean, termSpawnsChild?: boolean, appServer?: boolean, nonLeader?: boolean }} [o]
 */
function orphanBroker(h, o = {}) {
  const root = path.join(h, "state", "ws", "plugin-AbC123");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true, mode: 0o700 });
  // When the broker outlasts or dodges SIGTERM, its child ignores SIGTERM too, so only a per-member SIGKILL ends it.
  let child = o.termLeavesChild || o.ignoreTerm ? STUBBORN_CHILD : 'spawn("/bin/sleep", ["300"], { stdio: "ignore" })';
  if (o.appServer) {
    // `<dir>/codex app-server`: node, run through a link named codex, with the script `app-server` in its cwd.
    const fake = path.join(h, "fake-codex");
    fs.mkdirSync(fake, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(fake, "codex"));
    fs.writeFileSync(path.join(fake, "app-server"), 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
    child = `spawn(${JSON.stringify(path.join(fake, "codex"))}, ["app-server"], { cwd: ${JSON.stringify(fake)}, stdio: "ignore" })`;
  }
  const src = `const { spawn } = await import("node:child_process"); ${child};${o.ignoreTerm ? ' process.on("SIGTERM", () => {});' : ""}${o.termLeavesChild ? " process.on(\"SIGTERM\", () => process.exit(0));" : ""}${o.termSpawnsChild ? ` process.on("SIGTERM", () => { ${STUBBORN_CHILD}; setTimeout(() => process.exit(0), 200); });` : ""} setTimeout(() => {}, 120_000);`;
  fs.writeFileSync(path.join(root, "scripts", "app-server-broker.mjs"), src);
  // Started through a parent that exits at once, so it is reparented to launchd like a real leftover (and reaped by
  // it, not left a zombie of this test process).
  const broker = JSON.stringify(path.join(root, "scripts", "app-server-broker.mjs"));
  let c;
  let group;
  if (o.nonLeader) {
    // A detached launcher (its own group) starts the broker in that group and exits: the broker leads nothing.
    const pidFile = path.join(h, "non-leader.pid");
    const launcher = path.join(h, "launcher.mjs");
    fs.writeFileSync(launcher, `import { spawn } from "node:child_process"; import fs from "node:fs"; const b = spawn(process.execPath, [${broker}, "serve"], { stdio: "ignore" }); b.unref(); fs.writeFileSync(${JSON.stringify(pidFile)}, String(b.pid)); setTimeout(() => process.exit(0), 300);`);
    const launch = `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(launcher)}], { detached: true, stdio: "ignore" }); c.unref(); process.stdout.write(String(c.pid));`;
    group = Number(spawnSync(process.execPath, ["-e", launch], { encoding: "utf8" }).stdout);
    const until = Date.now() + 5000;
    while (Date.now() < until && !(fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"))) spawnSync("/bin/sleep", ["0.05"]);
    c = { pid: Number(fs.readFileSync(pidFile, "utf8")) };
  } else {
    const launch = `const c = require("node:child_process").spawn(process.execPath, [${broker}, "serve"], { detached: true, stdio: "ignore" }); c.unref(); process.stdout.write(String(c.pid));`;
    c = { pid: Number(spawnSync(process.execPath, ["-e", launch], { encoding: "utf8" }).stdout) };
    group = c.pid;
  }
  orphans.push(group);
  // The broker has read its script by the time its child exists; then the snapshot can go.
  const end = Date.now() + 5000;
  while (Date.now() < end && spawnSync("/bin/ps", ["-o", "pid=", "-g", String(group)], { encoding: "utf8" }).stdout.trim().split("\n").length < 2 + (o.nonLeader ? 1 : 0)) spawnSync("/bin/sleep", ["0.05"]);
  fs.rmSync(root, { recursive: true });
  return /** @type {number} */ (c.pid);
}

/** One fixture per check id, each driving that check to fail (or warn). A new check without a fixture fails T-DOC-1. */
const FAIL_FIXTURES = {
  claude: () => makeFakeBin(bin, "claude", { "*": { code: 127 } }),
  codex_cli: () => makeFakeBin(bin, "codex", { "*": { code: 127 } }),
  codex_auth: () => makeFakeBin(bin, "codex", { "--version": { stdout: "x\n" }, "login status": { code: 1, stdout: "Not logged in\n" } }),
  codex_plugin: () => fakeClaude([]),
  gh: () => makeFakeBin(bin, "gh", { "*": { code: 127 } }),
  plugin_installed: () => fakeClaude([CODEX_PLUGIN]),
  version_skew: () => fakeClaude([CODEX_PLUGIN, reviewLoop({ version: SKEWED, installPath: "/x" })]),
  legacy_hooks: (h) => fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: [...ASK_RULES] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "node /Users/x/.claude/review-loop/review-gate-hook.mjs stop" }] }] } })),
  ask_rules: (h) => fs.writeFileSync(path.join(h, ".claude", "settings.json"), "{}"),
  config: () => fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, "{bad"),
  rubric: (h) => { fs.writeFileSync(path.join(h, "r.md"), "# nothing\n"); writeConfig({ rubricPath: path.join(h, "r.md") }); },
  pin: () => { process.env.REVIEW_LOOP_PIN_FILE = "/nonexistent/pin.json"; },
  pr_binding: () => makeFakeBin(bin, "gh", { "*": { code: 1, stdout: "not logged in" } }),
  state_dir: (h) => fs.chmodSync(path.join(h, "state"), 0o755),
  node_for_hooks: () => { process.env.REVIEW_LOOP_NODE_CANDIDATES = "/nonexistent/node"; },
  events_writable: (h) => { fs.mkdirSync(path.join(h, "state", "events.jsonl"), { recursive: true }); },
  skill_duplicate: (h) => { fs.mkdirSync(path.join(h, ".claude", "skills", "review-loop"), { recursive: true }); fs.writeFileSync(path.join(h, ".claude", "skills", "review-loop", "SKILL.md"), "x"); },
  settings_backup_modified: (h) => { const d = path.join(h, "state", "settings-backups"); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(d, "settings.json.2026-01-01T00-00-00-000Z-deadbeef"), "changed"); },
  settings_tmp_leftover: (h) => fs.writeFileSync(path.join(h, ".claude", ".settings.json.review-loop-1-abcdef12.tmp"), "{}"),
  orphaned_brokers: (h) => { orphanBroker(h); },
  live: () => {}
};
const WARN_ONLY = new Set(["gh", "pr_binding", "settings_backup_modified", "settings_tmp_leftover", "orphaned_brokers", "live"]);

test("T-DOC-1: every doctor check has a failing fixture", () => {
  assert.deepEqual(DOCTOR_CHECKS.map((c) => c.id).sort(), Object.keys(FAIL_FIXTURES).sort());
});

test("T-DOC-1: the check ids are the spec §6.5 list, in order", () => {
  assert.deepEqual(DOCTOR_CHECKS.map((c) => c.id), [
    "claude", "codex_cli", "codex_auth", "codex_plugin", "gh", "plugin_installed", "version_skew", "legacy_hooks",
    "ask_rules", "config", "rubric", "pin", "pr_binding", "state_dir", "node_for_hooks", "events_writable",
    "skill_duplicate", "settings_backup_modified", "settings_tmp_leftover", "orphaned_brokers", "live"
  ]);
});

for (const [id, breakIt] of Object.entries(FAIL_FIXTURES)) {
  test(`T-DOC-1: ${id} passes when healthy; its fixture drives it to ${WARN_ONLY.has(id) ? "warn" : "fail"} with a registered code and a fix`, async () => {
    const h = healthy();
    if (id !== "live") assert.equal((await check(id).run(ctx())).status, "pass", `${id} is healthy before the fixture`);
    breakIt(h);
    const r = await check(id).run(ctx());
    assert.equal(r.status, WARN_ONLY.has(id) ? "warn" : "fail", `${id}: ${JSON.stringify(r)}`);
    assert.ok(typeof r.code === "string" && Object.hasOwn(CODES, r.code), `${id}: registered code, got ${r.code}`);
    assert.ok(r.fix && r.fix.length > 0, `${id}: fix text`);
    delete process.env.REVIEW_LOOP_PIN_FILE;
  });
}

/** Every entry under the roots (path → type:mode:sha256), excluding only the event log doctor is allowed to append. */
function treeHash(roots) {
  const out = {};
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const rel of fs.readdirSync(r, { recursive: true })) {
      const f = path.join(r, String(rel));
      if (/events\.jsonl(\.1)?$/.test(f)) continue;
      const st = fs.lstatSync(f);
      const mode = st.mode & 0o777;
      out[f] = st.isFile() ? `file:${mode}:${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}` : st.isSymbolicLink() ? `link:${fs.readlinkSync(f)}` : `dir:${mode}`;
    }
  }
  return out;
}
const jsonIO = (outs) => ({ isTTY: false, color: false, out: (s) => outs.push(s), err: () => {}, ask: async () => true, choose: async (_q, _o, d) => d, env: process.env });
const events = (h) => fs.readFileSync(path.join(h, "state", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("T-DOC-2: fully healthy (pinned to the fixture plugin) → exit 0, ok:true, every check passes except live (warn)", async () => {
  healthy();
  const outs = [];
  assert.equal(await main(["doctor", "--json"], jsonIO(outs)), 0);
  const report = JSON.parse(outs.join(""));
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.filter((c) => c.status !== "pass").map((c) => [c.id, c.status]), [["live", "warn"]]);
  assert.equal(report.event.code, "ok");
});

test("L13: a failing doctor exits with doctor_failed; a leftover settings temp file is settings_tmp_leftover", async () => {
  const h = healthy();
  FAIL_FIXTURES.settings_tmp_leftover(h);
  assert.equal((await check("settings_tmp_leftover").run(ctx())).code, "settings_tmp_leftover");
  FAIL_FIXTURES.pin();
  const outs = [];
  assert.equal(await main(["doctor", "--json"], jsonIO(outs)), 1);
  assert.equal(JSON.parse(outs.join("")).event.code, "doctor_failed");
  delete process.env.REVIEW_LOOP_PIN_FILE;
});

test("T-DOC-3: --json is one JSON value whose event equals the appended cli.exit line", async () => {
  const h = healthy();
  FAIL_FIXTURES.pin();
  const outs = [];
  const code = await main(["doctor", "--json"], jsonIO(outs));
  const stdout = outs.join("");
  const report = JSON.parse(stdout);
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.equal(report.schema, "review-loop.doctor/1");
  assert.deepEqual(Object.keys(report).sort(), ["checks", "event", "ok", "schema"]);
  for (const c of report.checks) assert.deepEqual(Object.keys(c), ["id", "status", "code", "fix", "note"]);
  assert.deepEqual(report.event, events(h).at(-1));
  assert.equal(report.ok, false);
  assert.equal(code, 1);
  assert.equal(report.event.exit_code, 1);
  delete process.env.REVIEW_LOOP_PIN_FILE;
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

test("T-DOC-4: writes nothing but the cli.exit event — healthy run: the only change under HOME is one appended event line", async () => {
  const h = healthy();
  writeConfig();
  const bdir = path.join(h, "state", "settings-backups");
  fs.mkdirSync(bdir, { mode: 0o700 });
  const intact = "{}\n";
  fs.writeFileSync(path.join(bdir, `settings.json.2026-01-01T00-00-00-000Z-${sha256hex(intact).slice(0, 8)}`), intact, { mode: 0o600 });
  const before = treeHash([h]);
  assert.equal(await main(["doctor", "--json"], jsonIO([])), 0);
  assert.deepEqual(treeHash([h]), before);
  const lines = events(h);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "cli.exit");
  assert.equal(lines[0].data.command, "doctor");
});

test("T-DOC-4: writes nothing — every failure at once (plus a corrupt pin, which is reported, never quarantined)", async () => {
  const h = healthy();
  for (const [id, breakIt] of Object.entries(FAIL_FIXTURES)) if (id !== "pin" && id !== "state_dir") breakIt(h);
  fs.writeFileSync(path.join(h, "state", "plugin-pin.json"), "{not json");
  const before = treeHash([h]);
  assert.equal(await main(["doctor", "--json"], jsonIO([])), 1);
  assert.deepEqual(treeHash([h]), before);
});

test("T-DOC-5: no paid call without --live — each tool is asked only its read-only probes", async () => {
  healthy();
  const codex = makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in\n" } });
  const claude = fakeClaude([CODEX_PLUGIN, reviewLoop()]);
  const gh = makeFakeBin(bin, "gh", { "auth status": { stdout: "ok\n" } });
  await main(["doctor", "--json"], jsonIO([]));
  for (const argv of codex.log()) assert.ok(["--version", "login status"].includes(argv.join(" ")), `unexpected codex call: ${argv.join(" ")}`);
  for (const argv of claude.log()) assert.ok(["--version", "plugin list --json"].includes(argv.join(" ")), `unexpected claude call: ${argv.join(" ")}`);
  for (const argv of gh.log()) assert.equal(argv.join(" "), "auth status");
  assert.ok(codex.log().length > 0 && claude.log().length > 0, "the probes ran");
});

test("T-DOC-6: a legacy hook is reported with the migrate fix", async () => {
  const h = healthy();
  FAIL_FIXTURES.legacy_hooks(h);
  const r = await check("legacy_hooks").run(ctx());
  assert.equal(r.status, "fail");
  assert.equal(r.fix, "review-loop migrate");
});

test("T-DOC-7: skew passes on same major.minor, fails otherwise, skips when the plugin is absent", async () => {
  healthy();
  const c = check("version_skew");
  fakeClaude([CODEX_PLUGIN, reviewLoop({ version: `${MAJOR}.${MINOR}.99` })]);
  assert.equal((await c.run(ctx())).status, "pass");
  fakeClaude([CODEX_PLUGIN, reviewLoop({ version: SKEWED })]);
  const skew = await c.run(ctx());
  assert.equal(skew.status, "fail");
  assert.match(skew.fix ?? "", /^review-loop update/);
  fakeClaude([CODEX_PLUGIN]);
  assert.equal((await c.run(ctx())).status, "skip");
});

test("a tool that could not run is never reported as not installed", async (t) => {
  healthy();
  // Not executable → spawn fails with EACCES (not ENOENT). Removed afterwards so later fakes are created executable.
  t.after(() => { fs.rmSync(path.join(bin, "claude"), { force: true }); fs.rmSync(path.join(bin, "gh"), { force: true }); });
  fs.chmodSync(path.join(bin, "claude"), 0o644);
  const r = await check("claude").run(ctx());
  assert.equal(r.status, "fail");
  assert.equal(r.code, "tool_failed");
  assert.match(r.note ?? "", /could not run/);
  assert.doesNotMatch(`${r.note} ${r.fix}`, /not installed|brew install/);
  const plugin = await check("plugin_installed").run(ctx());
  assert.equal(plugin.code, "tool_failed", "an unreadable plugin list is not 'plugin not installed'");
  assert.equal((await check("version_skew").run(ctx())).status, "skip");
  fs.chmodSync(path.join(bin, "gh"), 0o644);
  const gh = await check("gh").run(ctx());
  assert.deepEqual([gh.status, gh.code], ["warn", "tool_failed"]);
});

test("a missing tool reads as not installed, with the install fix", async () => {
  healthy();
  FAIL_FIXTURES.claude();
  const r = await check("claude").run(ctx());
  assert.equal(r.code, "preflight_failed");
  assert.equal(r.note, "not installed");
  assert.match(r.fix ?? "", /brew install --cask claude-code/);
});

test("config: symlink → config_symlink_rejected, foreign owner → config_insecure, invalid → config_invalid with the repair fix", async () => {
  const h = healthy();
  fs.writeFileSync(path.join(h, "real.json"), "{}");
  fs.symlinkSync(path.join(h, "real.json"), process.env.REVIEW_LOOP_CONFIG);
  const link = await check("config").run(ctx());
  assert.equal(link.code, "config_symlink_rejected");
  fs.rmSync(process.env.REVIEW_LOOP_CONFIG);
  writeConfig();
  ownerSeam.set({ statUid: (st) => st.uid + 1 });
  try {
    assert.equal((await check("config").run(ctx())).code, "config_insecure");
  } finally { ownerSeam.reset(); }
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, "{bad");
  const bad = await check("config").run(ctx());
  assert.deepEqual([bad.code, bad.fix], ["config_invalid", "review-loop config repair"]);
});

test("pin: absent → plugin_pin_missing (setup); drifted → plugin_pin_mismatch (setup without --yes); a corrupt pin is left in place", async () => {
  const h = healthy();
  const pinFile = path.join(h, "state", "plugin-pin.json");
  const pin = JSON.parse(fs.readFileSync(pinFile, "utf8"));
  pin.files["prompts/adversarial-review.md"] = "0".repeat(64);
  fs.writeFileSync(pinFile, JSON.stringify(pin));
  const drift = await check("pin").run(ctx());
  assert.equal(drift.code, "plugin_pin_mismatch");
  assert.match(drift.fix ?? "", /review-loop setup.*without --yes/);
  fs.writeFileSync(pinFile, "{not json");
  const corrupt = await check("pin").run(ctx());
  assert.deepEqual([corrupt.code, corrupt.fix], ["plugin_pin_missing", "review-loop setup"]);
  assert.equal(fs.readFileSync(pinFile, "utf8"), "{not json", "not quarantined");
  assert.deepEqual(fs.readdirSync(path.join(h, "state")).filter((n) => n.includes("corrupt")), []);
});

test("state_dir: a symlink → state_symlink_rejected; a loose dir → chmod fix naming the path", async () => {
  const h = healthy();
  FAIL_FIXTURES.state_dir(h);
  const r = await check("state_dir").run(ctx());
  assert.deepEqual([r.code, r.fix], ["state_dir_insecure", `chmod 700 "${path.join(h, "state")}"`]);
  const real = path.join(h, "real-state");
  fs.mkdirSync(real, { mode: 0o700 });
  process.env.REVIEW_LOOP_STATE_DIR = path.join(h, "linked-state");
  fs.symlinkSync(real, process.env.REVIEW_LOOP_STATE_DIR);
  assert.equal((await check("state_dir").run(ctx())).code, "state_symlink_rejected");
});

test("events_writable: a refused events.path, a loose state dir and a non-file log are each reported with a fitting code", async () => {
  const h = healthy();
  fs.mkdirSync(path.join(h, "logs"));
  fs.symlinkSync(path.join(h, "elsewhere.jsonl"), path.join(h, "logs", "ev.jsonl"));
  writeConfig({ events: { path: path.join(h, "logs", "ev.jsonl") } });
  assert.equal((await check("events_writable").run(ctx())).code, "events_path_rejected");
  writeConfig();
  fs.chmodSync(path.join(h, "state"), 0o755);
  assert.equal((await check("events_writable").run(ctx())).code, "state_dir_insecure");
  fs.chmodSync(path.join(h, "state"), 0o700);
  FAIL_FIXTURES.events_writable(h);
  assert.equal((await check("events_writable").run(ctx())).code, "events_unwritable");
});

test("skill_duplicate looks in CLAUDE_CONFIG_DIR, not ~/.claude", async () => {
  const h = healthy();
  FAIL_FIXTURES.skill_duplicate(h);
  process.env.CLAUDE_CONFIG_DIR = path.join(h, "alt-claude");
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ permissions: { ask: [...ASK_RULES] } }));
  assert.equal((await check("skill_duplicate").run(ctx())).status, "pass");
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, "skills", "review-loop"), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "skills", "review-loop", "SKILL.md"), "x");
  assert.equal((await check("skill_duplicate").run(ctx())).status, "fail");
});

test("settings_backup_modified: an intact backup passes; the warning names the modified one", async () => {
  const h = healthy();
  const d = path.join(h, "state", "settings-backups");
  fs.mkdirSync(d, { mode: 0o700 });
  fs.writeFileSync(path.join(d, `settings.json.2026-01-01T00-00-00-000Z-${sha256hex("{}\n").slice(0, 8)}`), "{}\n");
  assert.equal((await check("settings_backup_modified").run(ctx())).status, "pass");
  FAIL_FIXTURES.settings_backup_modified(h);
  const r = await check("settings_backup_modified").run(ctx());
  assert.match(r.fix ?? "", /settings\.json\.2026-01-01T00-00-00-000Z-deadbeef/);
});

test("--live: a passing live check passes; a failing one fails with the detail's remedy (stub engine, no Codex call)", async () => {
  const h = healthy();
  const plugin = path.join(h, "stub-plugin");
  fs.mkdirSync(path.join(plugin, "engine"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "engine", "review-round.mjs"), "process.stderr.write(process.env.STUB_TEXT ?? ''); process.exitCode = Number(process.env.STUB_EXIT ?? 0);\n");
  fakeClaude([CODEX_PLUGIN, reviewLoop({ installPath: plugin })]);
  process.env.STUB_EXIT = "0";
  assert.equal((await check("live").run(ctx(true))).status, "pass");
  Object.assign(process.env, { STUB_EXIT: "1", STUB_TEXT: "error: Not logged in\n" });
  const r = await check("live").run(ctx(true));
  assert.deepEqual([r.status, r.code, r.note, r.fix], ["fail", "live_check_failed", "codex_auth", "codex login"]);
  fakeClaude([CODEX_PLUGIN]);
  assert.equal((await check("live").run(ctx(true))).note, "plugin_missing");
  delete process.env.STUB_EXIT; delete process.env.STUB_TEXT;
});

test("text mode prints a status word per check and a Fix line under each problem; an unknown flag is a usage error", async () => {
  healthy();
  FAIL_FIXTURES.pin();
  const lines = [];
  const io = { ...jsonIO([]), err: (s) => lines.push(s) };
  assert.equal(await main(["doctor"], io), 1);
  const text = lines.join("");
  assert.match(text, /FAIL\s+pin/);
  assert.match(text, /WARN\s+live[\s\S]*Fix: review-loop doctor --live/);
  assert.equal(text.match(/OK/g)?.length, 19);
  assert.equal(await main(["doctor", "--bogus"], io), 2);
  delete process.env.REVIEW_LOOP_PIN_FILE;
});

test("node_for_hooks: the fixed Homebrew paths pass; a node only on this shell's PATH warns; none fails", async () => {
  healthy();
  const { nodeForHooks } = await import("../../cli/lib/doctor.mjs");
  delete process.env.REVIEW_LOOP_NODE_CANDIDATES;
  assert.equal(nodeForHooks([process.execPath]).status, "pass");
  const pathDir = tmpDir();
  fs.symlinkSync(process.execPath, path.join(pathDir, "node"));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;
    assert.deepEqual([nodeForHooks([]).status, nodeForHooks([]).code], ["warn", "node_missing"]);
    process.env.PATH = "/usr/bin:/bin";
    assert.deepEqual([nodeForHooks([]).status, nodeForHooks([]).fix], ["fail", "brew install node"]);
  } finally { process.env.PATH = savedPath; }
});

test("[fix-1] events_writable: an absent state dir (before setup) passes — doctor exits 0 when that is the only difference from healthy", async () => {
  const h = healthy();
  process.env.REVIEW_LOOP_PIN_FILE = path.join(h, "pin", "plugin-pin.json");
  writePin(latestInstalledVersion());
  fs.rmSync(path.join(h, "state"), { recursive: true });
  const r = await check("events_writable").run(ctx());
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal((await check("state_dir").run(ctx())).status, "pass");
  const outs = [];
  assert.equal(await main(["doctor", "--json"], jsonIO(outs)), 0, outs.join(""));
  assert.equal(JSON.parse(outs.join("")).ok, true);
  delete process.env.REVIEW_LOOP_PIN_FILE;
});

test("[fix-1] each tool probe runs once per doctor run (plugin list, gh auth status), and again on the next run", async () => {
  healthy();
  const claude = fakeClaude([CODEX_PLUGIN, reviewLoop()]);
  const gh = makeFakeBin(bin, "gh", { "auth status": { stdout: "ok\n" } });
  const count = (fake, argv) => fake.log().filter((a) => a.join(" ") === argv).length;
  await main(["doctor", "--json"], jsonIO([]));
  assert.equal(count(claude, "plugin list --json"), 1);
  assert.equal(count(claude, "--version"), 1);
  assert.equal(count(gh, "auth status"), 1);
  await main(["doctor", "--json"], jsonIO([]));
  assert.equal(count(claude, "plugin list --json"), 2, "the memo does not outlive a run");
});

test("[fix-1] claude missing: plugin_installed and codex_plugin skip (the claude row carries the install fix), never tool_failed", async () => {
  healthy();
  fs.rmSync(path.join(bin, "claude"));
  try {
    for (const id of ["plugin_installed", "codex_plugin", "version_skew"]) {
      const r = await check(id).run(ctx());
      assert.equal(r.status, "skip", `${id}: ${JSON.stringify(r)}`);
    }
    const c = await check("claude").run(ctx());
    assert.deepEqual([c.status, c.note], ["fail", "not installed"]);
  } finally { fakeClaude([CODEX_PLUGIN, reviewLoop()]); }
});

test("[fix-1] plugin_installed at a non-user scope gives the exact reinstall command, not setup (which skips an enabled plugin)", async () => {
  healthy();
  fakeClaude([CODEX_PLUGIN, reviewLoop({ scope: "project" })]);
  const r = await check("plugin_installed").run(ctx());
  assert.deepEqual([r.status, r.fix], ["fail", "claude plugin install review-loop@review-loop --scope user"]);
  fakeClaude([CODEX_PLUGIN]);
  assert.equal((await check("plugin_installed").run(ctx())).fix, "review-loop setup");
  // A project install listed before the user one: the user-scope entry is the one checked.
  fakeClaude([CODEX_PLUGIN, reviewLoop({ scope: "project", enabled: false }), reviewLoop({ scope: "user" })]);
  assert.equal((await check("plugin_installed").run(ctx())).status, "pass");
  fakeClaude([CODEX_PLUGIN, reviewLoop()]);
});

test("[fix-1] a linked settings-backups dir warns (state_symlink_rejected) and is never read through", async () => {
  const h = healthy();
  const outside = path.join(h, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "settings.json.2026-01-01T00-00-00-000Z-deadbeef"), "changed");
  fs.symlinkSync(outside, path.join(h, "state", "settings-backups"));
  const r = await check("settings_backup_modified").run(ctx());
  assert.deepEqual([r.status, r.code], ["warn", "state_symlink_rejected"]);
  assert.doesNotMatch(r.fix ?? "", /deadbeef/, "the linked directory's contents were not listed");
});

test("[fix-1] notes are bounded and the codex_cli note is the version, not raw stdout", async () => {
  const h = healthy();
  makeFakeBin(bin, "codex", { "--version": { stdout: "WARNING: something noisy\ncodex-cli 0.157.1\n" }, "login status": { stdout: "Logged in\n" } });
  assert.equal((await check("codex_cli").run(ctx())).note, "0.157.1");
  process.env.REVIEW_LOOP_CONFIG = path.join(h, `${"c".repeat(240)}.json`);
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, "{bad");
  const r = await check("config").run(ctx());
  assert.equal(r.code, "config_invalid");
  assert.ok((r.note ?? "").length <= 200, `note length ${r.note?.length}`);
  assert.ok(r.note?.endsWith("…"));
});

test("a note capped at 200 characters never splits a surrogate pair", async () => {
  const { capNote } = await import("../../cli/lib/doctor.mjs");
  const capped = capNote("a".repeat(198) + "😀".repeat(5)) ?? "";
  assert.ok(capped.isWellFormed(), "no lone surrogate");
  assert.equal(Array.from(capped).length, 200);
  assert.ok(capped.endsWith("😀…"));
  assert.equal(capNote("short"), "short");
});

test("orphaned_brokers: never signals; the stop-orphan command it prints stops the tree, and refuses a changed process", { timeout: 30_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h, { ignoreTerm: true });
  const r = await check("orphaned_brokers").run(ctx());
  assert.equal(r.status, "warn");
  assert.ok(process.kill(pid, 0), "doctor signalled nothing");
  const cmd = /stop-orphan --snapshot (\S+) --pid (\d+) --started (\d+) --args-sha ([0-9a-f]{64})/.exec(r.fix ?? "");
  assert.ok(cmd, r.fix ?? "");
  const engine = path.join(process.cwd(), "plugin", "engine", "review-round.mjs");
  const run = (/** @type {string} */ started) => spawnSync(process.execPath, [engine, "stop-orphan", "--snapshot", cmd[1], "--pid", cmd[2], "--started", started, "--args-sha", cmd[4]], { env: process.env, encoding: "utf8", timeout: 20_000 });
  const off = run(String(Number(cmd[3]) + 1));
  assert.equal(off.status, 60, off.stdout);
  assert.equal(JSON.parse(off.stdout).status, "mismatch");
  assert.ok(process.kill(pid, 0), "a start time that does not match signals nothing");
  const bad = spawnSync(process.execPath, [engine, "stop-orphan", "--snapshot", "../x", "--pid", cmd[2], "--started", cmd[3], "--args-sha", cmd[4]], { env: process.env, encoding: "utf8" });
  assert.equal(bad.status, 30, bad.stdout);
  assert.equal(JSON.parse(bad.stdout).error.code, "bad_args");
  const ok = run(cmd[3]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).status, "stopped");
  assert.equal(spawnSync("/bin/ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" }).stdout.trim(), "", "the broker and the child that ignored SIGTERM are gone");
  assert.equal((await check("orphaned_brokers").run(ctx())).status, "pass");
});

test("orphaned_brokers: a process table that cannot be read is a warning, never a pass", async () => {
  healthy();
  makeFakeBin(bin, "ps", { "*": { code: 2 } });
  // Through the engine's seam: it runs /bin/ps, never the PATH one.
  process.env.REVIEW_LOOP_TEST_SEAMS = "1";
  process.env.REVIEW_LOOP_TEST_PS_PATH = path.join(bin, "ps");
  try {
    const r = await check("orphaned_brokers").run(ctx());
    assert.equal(r.status, "warn");
    assert.match(r.note ?? "", /unverified/);
  } finally {
    delete process.env.REVIEW_LOOP_TEST_SEAMS;
    delete process.env.REVIEW_LOOP_TEST_PS_PATH;
    fs.rmSync(path.join(bin, "ps"), { force: true });
  }
});

test("orphaned_brokers: stop-orphan also stops the child a broker leaves behind when it exits on SIGTERM", { timeout: 30_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h, { termLeavesChild: true });
  const r = await check("orphaned_brokers").run(ctx());
  const cmd = /stop-orphan --snapshot (\S+) --pid (\d+) --started (\d+) --args-sha ([0-9a-f]{64})/.exec(r.fix ?? "");
  assert.ok(cmd, r.fix ?? "");
  const engine = path.join(process.cwd(), "plugin", "engine", "review-round.mjs");
  const ok = spawnSync(process.execPath, [engine, "stop-orphan", "--snapshot", cmd[1], "--pid", cmd[2], "--started", cmd[3], "--args-sha", cmd[4]], { env: process.env, encoding: "utf8", timeout: 20_000 });
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).status, "stopped");
  assert.equal(spawnSync("/bin/ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" }).stdout.trim(), "", "the child it left is gone too");
});

test("orphaned_brokers: stop-orphan stops the child a broker leaves even when the broker's pid is then held by another process", { timeout: 30_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h, { termLeavesChild: true });
  const r = await check("orphaned_brokers").run(ctx());
  const cmd = /stop-orphan --snapshot (\S+) --pid (\d+) --started (\d+) --args-sha ([0-9a-f]{64})/.exec(r.fix ?? "");
  assert.ok(cmd, r.fix ?? "");
  // A ps whose table reads show, for a group whose leader is gone, a row holding the leader's pid in another group.
  const fake = path.join(h, "reused-ps");
  fs.mkdirSync(fake, { recursive: true });
  const awk = `{ print; pid[$2] = 1; if ($4 == ${pid} && $2 != ${pid}) u = $1 } END { if (u != "" && !(${pid} in pid)) printf "%5d %5d     1     1 Thu Jan  1 00:00:00 2026 /usr/bin/true reused\\n", u, ${pid} }`;
  fs.writeFileSync(path.join(fake, "ps"), `#!/bin/sh\ncase " $* " in *" -A "*) /bin/ps "$@" | /usr/bin/awk '${awk}'; exit 0;; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  const engine = path.join(process.cwd(), "plugin", "engine", "review-round.mjs");
  const { spawn } = await import("node:child_process");
  // Not spawnSync: this process must stay free to reap the broker, so its pid really leaves the table.
  const child = spawn(process.execPath, [engine, "stop-orphan", "--snapshot", cmd[1], "--pid", cmd[2], "--started", cmd[3], "--args-sha", cmd[4]], { env: { ...process.env, REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_PS_PATH: path.join(fake, "ps") }, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const code = await new Promise((res) => child.once("exit", res));
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(out).status, "stopped");
  assert.equal(spawnSync("/bin/ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" }).stdout.trim(), "", "the child it left is gone too");
});

test("orphaned_brokers: stop-orphan sends no SIGKILL once the snapshot is back", { timeout: 30_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h, { ignoreTerm: true });
  const r = await check("orphaned_brokers").run(ctx());
  const cmd = /stop-orphan --snapshot (\S+) --pid (\d+) --started (\d+) --args-sha ([0-9a-f]{64})/.exec(r.fix ?? "");
  assert.ok(cmd, r.fix ?? "");
  const engine = path.join(process.cwd(), "plugin", "engine", "review-round.mjs");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [engine, "stop-orphan", "--snapshot", cmd[1], "--pid", cmd[2], "--started", cmd[3], "--args-sha", cmd[4]], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const code = new Promise((res) => child.once("close", res));
  // While it waits out the broker's ignored SIGTERM, the snapshot comes back.
  await new Promise((res) => setTimeout(res, 1500));
  fs.mkdirSync(path.join(h, "state", "ws", cmd[1]), { recursive: true });
  assert.equal(await code, 60, out);
  assert.equal(JSON.parse(out).status, "mismatch");
  assert.ok(process.kill(pid, 0), "the broker was not SIGKILLed");
  assert.equal(spawnSync("/bin/ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" }).stdout.trim().split("\n").length, 2, "nor its child");
});

test("orphaned_brokers: stop-orphan also stops a child spawned on SIGTERM, after any one read of the group", { timeout: 40_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h, { termSpawnsChild: true });
  const r = await check("orphaned_brokers").run(ctx());
  const cmd = /stop-orphan --snapshot (\S+) --pid (\d+) --started (\d+) --args-sha ([0-9a-f]{64})/.exec(r.fix ?? "");
  assert.ok(cmd, r.fix ?? "");
  const engine = path.join(process.cwd(), "plugin", "engine", "review-round.mjs");
  const ok = spawnSync(process.execPath, [engine, "stop-orphan", "--snapshot", cmd[1], "--pid", cmd[2], "--started", cmd[3], "--args-sha", cmd[4]], { env: process.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).status, "stopped");
  assert.equal(spawnSync("/bin/ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" }).stdout.trim(), "", "the late child is gone too");
});

test("orphaned_brokers: a linked ws/ is never followed; the check is unverified", async () => {
  const h = healthy();
  const elsewhere = path.join(h, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.rmSync(path.join(h, "state", "ws"), { recursive: true, force: true });
  fs.symlinkSync(elsewhere, path.join(h, "state", "ws"));
  const r = await check("orphaned_brokers").run(ctx());
  assert.equal(r.status, "warn");
  assert.match(r.note ?? "", /unverified/);
});

test("orphaned_brokers: a live broker whose snapshot name now holds a link or a file is unverified, never taken as a snapshot", { timeout: 30_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h);
  const entry = path.join(h, "state", "ws", "plugin-AbC123");
  const elsewhere = path.join(h, "elsewhere-snapshot");
  fs.mkdirSync(elsewhere);
  try {
    for (const make of [() => fs.symlinkSync(elsewhere, entry), () => fs.writeFileSync(entry, "")]) {
      make();
      const r = await check("orphaned_brokers").run(ctx());
      assert.equal(r.status, "warn");
      assert.match(r.note ?? "", /unverified/);
      assert.match(r.fix ?? "", /ls -la/);
      assert.doesNotMatch(r.fix ?? "", /stop-orphan/, "no command acts on a broker whose snapshot cannot be told apart");
      fs.rmSync(entry, { force: true });
    }
  } finally {
    signalPid(pid, "SIGKILL", { group: true });
  }
});

test("orphaned_brokers: stop-orphan re-reads the leader right at its SIGTERM; a changed leader is never signalled", { timeout: 30_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h);
  const r = await check("orphaned_brokers").run(ctx());
  const cmd = /stop-orphan --snapshot (\S+) --pid (\d+) --started (\d+) --args-sha ([0-9a-f]{64})/.exec(r.fix ?? "");
  assert.ok(cmd, r.fix ?? "");
  const engine = path.join(process.cwd(), "plugin", "engine", "review-round.mjs");
  // The seam makes the leader read at the signal differ from the one checked before it.
  const out = spawnSync(process.execPath, [engine, "stop-orphan", "--snapshot", cmd[1], "--pid", cmd[2], "--started", cmd[3], "--args-sha", cmd[4]], { env: { ...process.env, REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_LEADER_RECHECK: "changed" }, encoding: "utf8", timeout: 20_000 });
  try {
    assert.equal(out.status, 60, out.stdout);
    assert.equal(JSON.parse(out.stdout).status, "mismatch");
    assert.ok(process.kill(pid, 0), "the group was not signalled");
  } finally {
    signalPid(pid, "SIGKILL", { group: true });
  }
});

test("orphaned_brokers: a ws/plugin-* entry that is a link or a file, with no broker, is unverified, never a pass", async () => {
  const h = healthy();
  const entry = path.join(h, "state", "ws", "plugin-Odd001");
  fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
  const elsewhere = path.join(h, "elsewhere-entry");
  fs.mkdirSync(elsewhere);
  for (const make of [() => fs.symlinkSync(elsewhere, entry), () => fs.writeFileSync(entry, "")]) {
    make();
    const r = await check("orphaned_brokers").run(ctx());
    assert.equal(r.status, "warn");
    assert.match(r.note ?? "", /unverified/);
    assert.match(r.fix ?? "", /ls -la/);
    fs.rmSync(entry, { force: true });
  }
  assert.equal((await check("orphaned_brokers").run(ctx())).status, "pass", "and with it gone, a pass");
});

test("orphaned_brokers: a leftover broker that does not lead its group is listed to inspect, with no stop-orphan command", { timeout: 30_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h, { nonLeader: true });
  const pgid = Number(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
  assert.notEqual(pgid, pid, "the fixture's broker leads no group");
  const r = await check("orphaned_brokers").run(ctx());
  assert.equal(r.status, "warn");
  assert.match(r.fix ?? "", new RegExp(`broker ${pid} \\(snapshot plugin-AbC123 removed\\) does not lead its process group[^\\n]*-g ${pgid}`));
  assert.doesNotMatch(r.fix ?? "", /stop-orphan --snapshot/, "stop-orphan refuses a non-leader, so no command is offered");
  assert.ok(process.kill(pid, 0), "and nothing was signalled");
});

test("orphaned_brokers: a snapshot restored between a member's check and its SIGKILL stops stop-orphan before the signal", { timeout: 30_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h, { ignoreTerm: true });
  const r = await check("orphaned_brokers").run(ctx());
  const cmd = /stop-orphan --snapshot (\S+) --pid (\d+) --started (\d+) --args-sha ([0-9a-f]{64})/.exec(r.fix ?? "");
  assert.ok(cmd, r.fix ?? "");
  const engine = path.join(process.cwd(), "plugin", "engine", "review-round.mjs");
  const out = spawnSync(process.execPath, [engine, "stop-orphan", "--snapshot", cmd[1], "--pid", cmd[2], "--started", cmd[3], "--args-sha", cmd[4]], { env: { ...process.env, REVIEW_LOOP_TEST_SEAMS: "1", REVIEW_LOOP_TEST_RESTORE_SNAPSHOT: "1" }, encoding: "utf8", timeout: 20_000 });
  assert.equal(out.status, 60, out.stdout);
  assert.equal(JSON.parse(out.stdout).status, "mismatch");
  assert.ok(process.kill(pid, 0), "the broker was not SIGKILLed");
});

test("orphaned_brokers: a broker that exits after doctor listed it: stop-orphan names its group (leader_gone) and signals nothing", { timeout: 40_000 }, async () => {
  const h = healthy();
  const pid = orphanBroker(h, { termLeavesChild: true, appServer: true });
  const r = await check("orphaned_brokers").run(ctx());
  const cmd = /stop-orphan --snapshot (\S+) --pid (\d+) --started (\d+) --args-sha ([0-9a-f]{64})/.exec(r.fix ?? "");
  assert.ok(cmd, r.fix ?? "");
  const member = Number(spawnSync("/bin/ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" }).stdout.trim().split(/\s+/).find((p) => Number(p) !== pid));
  signalPid(pid, "SIGTERM");
  const end = Date.now() + 5000;
  while (Date.now() < end && spawnSync("/bin/ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim() !== "") spawnSync("/bin/sleep", ["0.05"]);
  const engine = path.join(process.cwd(), "plugin", "engine", "review-round.mjs");
  const out = spawnSync(process.execPath, [engine, "stop-orphan", "--snapshot", cmd[1], "--pid", cmd[2], "--started", cmd[3], "--args-sha", cmd[4]], { env: process.env, encoding: "utf8", timeout: 20_000 });
  assert.equal(out.status, 60, out.stdout);
  assert.deepEqual(JSON.parse(out.stdout), { exit: 60, status: "leader_gone", pgid: pid });
  assert.ok(process.kill(member, 0), "the app-server was not signalled");
  assert.deepEqual(events(h).filter((e) => e.event === "round.stop_orphan").map((e) => [e.code, e.data.status]), [["orphaned_brokers", "leader_gone"]]);
  // Nothing ties a leaderless app-server to review-loop rather than another Codex client: doctor does not count it.
  assert.equal((await check("orphaned_brokers").run(ctx())).status, "pass");
  signalPid(member, "SIGKILL");
});