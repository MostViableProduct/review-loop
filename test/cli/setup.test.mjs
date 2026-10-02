import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir, GIT_ENV } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.REVIEW_LOOP_TEST_SEAMS = "1";
delete process.env.CLAUDECODE;
Object.assign(process.env, { GIT_AUTHOR_NAME: GIT_ENV.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: GIT_ENV.GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME: GIT_ENV.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: GIT_ENV.GIT_COMMITTER_EMAIL });
const FIXTURE_BASE = path.join(process.cwd(), "test", "fixtures", "fake-codex-plugin");
const { main } = await import("../../cli/review-loop.mjs");
const { seams } = await import("../../cli/lib/setup.mjs");
const { MIN_CLAUDE } = await import("../../cli/lib/preflight.mjs");
const { LIVE_REMEDY } = await import("../../cli/lib/livecheck.mjs");

/** A Codex plugin copy whose companion is a stub: it logs its argv and prints STUB_OUT. */
function stubPluginBase() {
  const base = tmpDir("rl-setup-plugin-");
  fs.cpSync(path.join(FIXTURE_BASE, "1.0.6"), path.join(base, "1.0.6"), { recursive: true });
  const script = path.join(base, "1.0.6", "scripts", "codex-companion.mjs");
  const usage = fs.readFileSync(script, "utf8").split("\n").find((l) => l.includes("codex-companion.mjs adversarial-review [")).replace(/^\s*"|",?\s*$/g, "");
  fs.writeFileSync(script, `import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "help") console.log("Usage:\\n  ${usage}");
else {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\\n");
  process.stdout.write(fs.readFileSync(process.env.STUB_OUT, "utf8"));
  process.exitCode = Number(process.env.STUB_EXIT ?? 0);
}
`);
  return base;
}

function sandbox({ pluginInstalled = false, stubCodex = false } = {}) {
  const home = tmpDir();
  Object.assign(process.env, {
    HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json"),
    CODEX_HOME: path.join(home, "codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    REVIEW_LOOP_PLUGIN_BASE: stubCodex ? stubPluginBase() : FIXTURE_BASE
  });
  delete process.env.REVIEW_LOOP_PIN_FILE;
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, "codex"));
  fs.writeFileSync(path.join(home, "codex", "config.toml"), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
  const list = [{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }];
  if (pluginInstalled) list.push({ id: "review-loop@review-loop", enabled: true, scope: "user", version: "0.1.0", installPath: path.join(process.cwd(), "plugin") });
  const claude = makeFakeBin(bin, "claude", {
    "--version": { stdout: `${MIN_CLAUDE} (Claude Code)\n` }, "plugin list --json": { stdout: JSON.stringify(list) },
    "*": { stdout: "{}\n" }
  });
  makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in\n" } });
  makeFakeBin(bin, "gh", { "auth status": { stdout: "ok\n" } });
  makeFakeBin(bin, "ps", { "*": { stdout: "    1     0 /sbin/launchd\n  200     1 -zsh\n" } });
  makeFakeBin(bin, "lsof", { "*": { code: 1 } });
  const stubDir = tmpDir("rl-stub-");
  Object.assign(process.env, { STUB_LOG: path.join(stubDir, "log.jsonl"), STUB_OUT: path.join(stubDir, "out.json") });
  delete process.env.STUB_EXIT;
  fs.writeFileSync(process.env.STUB_LOG, "");
  return { home, claude };
}
const respond = (findings) => fs.writeFileSync(process.env.STUB_OUT, JSON.stringify({ result: { verdict: findings.length ? "needs-attention" : "approve", summary: "s", findings, next_steps: [] }, parseError: null }));
const stubCalls = () => fs.readFileSync(process.env.STUB_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lastEvent = () => fs.readFileSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
const io = (answers) => ({ isTTY: true, color: false, lines: [], out() {}, err(s) { this.lines.push(s); }, ask: async () => answers.shift() ?? true, choose: async (_q, _o, d) => d, env: process.env });
const installs = (s) => s.claude.log().filter((a) => a[0] === "plugin" && a[1] === "install");

test("T-SET-1: every mutating step prints what/why before asking; 'n' at the plugin step → exit 3, no install", async () => {
  const s = sandbox();
  const o = io([false]);
  const code = await main(["setup", "--skip-live-check"], o);
  assert.equal(code, 3);
  const text = o.lines.join("");
  assert.match(text, /Will: install the review-loop plugin[\s\S]*Why:/);
  assert.equal(installs(s).length, 0);
  assert.match(text, /Done: preflight, preset, model\/effort\nNot done: plugin/);
  assert.equal(lastEvent().code, "cancelled");
});

test("T-SET-2: a cancel at the approval-rule step writes nothing to settings.json", async () => {
  const s = sandbox({ pluginInstalled: true });
  const o = io([false]);
  assert.equal(await main(["setup", "--skip-live-check"], o), 3);
  assert.match(o.lines.join(""), /Will: add 5 approval rules[\s\S]*Not done: approval rules/);
  assert.ok(!fs.existsSync(path.join(s.home, ".claude", "settings.json")));
});

test("T-SET-5: a re-run after a failure converges without duplicate installs", async () => {
  const s = sandbox({ pluginInstalled: true });
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 0);
  assert.equal(installs(s).length, 0, "already installed → not reinstalled");
  const settings = JSON.parse(fs.readFileSync(path.join(s.home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.permissions.ask.length, 5);
  const before = fs.readFileSync(path.join(s.home, ".claude", "settings.json"));
  const pin = fs.readFileSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json"));
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 0);
  assert.deepEqual(fs.readFileSync(path.join(s.home, ".claude", "settings.json")), before, "second run changes nothing");
  assert.deepEqual(fs.readFileSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json")), pin);
});

test("T-SET-5b: a missing plugin is installed once; the fake lists it only after install", async () => {
  const s = sandbox();
  const listed = { id: "review-loop@review-loop", enabled: true, scope: "user", version: "0.1.0", installPath: path.join(process.cwd(), "plugin") };
  const base = [{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }];
  s.claude.set({
    "--version": { stdout: `${MIN_CLAUDE} (Claude Code)\n` },
    "plugin list --json": [{ stdout: JSON.stringify(base) }, { stdout: JSON.stringify(base) }, { stdout: JSON.stringify([...base, listed]) }],
    "*": { stdout: "{}\n" }
  });
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 0);
  assert.equal(installs(s).length, 1);
  assert.deepEqual(installs(s)[0].slice(0, 4), ["plugin", "install", "review-loop@review-loop", "--scope"]);
});

test("T-SET-5c: an enabled plugin at project scope only is not enough: setup installs it at user scope", async () => {
  const s = sandbox();
  const plugin = { id: "review-loop@review-loop", enabled: true, version: "0.1.0", installPath: path.join(process.cwd(), "plugin") };
  const base = [{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }, { ...plugin, scope: "project" }];
  s.claude.set({
    "--version": { stdout: `${MIN_CLAUDE} (Claude Code)\n` },
    "plugin list --json": [{ stdout: JSON.stringify(base) }, { stdout: JSON.stringify(base) }, { stdout: JSON.stringify([...base, { ...plugin, scope: "user" }]) }],
    "*": { stdout: "{}\n" }
  });
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 0);
  assert.equal(installs(s).length, 1, "the project-scope install did not count");
  assert.deepEqual(installs(s)[0].slice(0, 5), ["plugin", "install", "review-loop@review-loop", "--scope", "user"]);
});

test("T-SET-5d: setup fails loudly when the user-scope install never appears", async () => {
  const s = sandbox();
  const base = [{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }, { id: "review-loop@review-loop", enabled: true, scope: "project", version: "0.1.0" }];
  s.claude.set({ "--version": { stdout: `${MIN_CLAUDE} (Claude Code)\n` }, "plugin list --json": { stdout: JSON.stringify(base) }, "*": { stdout: "{}\n" } });
  const o = io([]);
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], o), 1);
  assert.match(o.lines.join(""), /plugin_install_failed/);
});

test("T-SET-7: --skip-live-check → setup_complete_unverified, exit 0, summary says not verified", async () => {
  sandbox({ pluginInstalled: true });
  const o = io([]);
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], o), 0);
  assert.match(o.lines.join(""), /not verified/i);
  assert.equal(lastEvent().code, "setup_complete_unverified");
});

test("T-CFG-6: setup never writes under CODEX_HOME", async () => {
  const s = sandbox({ pluginInstalled: true });
  const before = fs.readFileSync(path.join(s.home, "codex", "config.toml"));
  await main(["setup", "--yes", "--model", "m1", "--effort", "low", "--skip-live-check"], io([]));
  assert.deepEqual(fs.readFileSync(path.join(s.home, "codex", "config.toml")), before);
  assert.deepEqual(fs.readdirSync(path.join(s.home, "codex")), ["config.toml"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8")).codex, { model: "m1", effort: "low" });
});

test("bad --preset / --effort / --model exit 2 before anything is installed", async () => {
  const s = sandbox();
  for (const flags of [["--preset", "nope"], ["--effort", "turbo"], ["--model", "bad model!"]]) {
    assert.equal(await main(["setup", "--yes", "--skip-live-check", ...flags], io([])), 2, flags.join(" "));
  }
  assert.equal(installs(s).length, 0);
});

test("T-SET-8: the live check runs one real round; a needs-fixes verdict is a pass; effort is never sent to Codex (R-P2)", async () => {
  sandbox({ pluginInstalled: true, stubCodex: true });
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 0);
  const pinPath = path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json");
  const pinBefore = fs.readFileSync(pinPath);
  respond([{ severity: "medium", title: "[Correctness] no acceptance criteria", body: "b", file: "docs/specs/livecheck-design.md", line_start: 1, line_end: 2, confidence: 0.9, recommendation: "r" }]);
  const o = io([]);
  assert.equal(await main(["setup", "--yes", "--effort", "low"], o), 0, o.lines.join(""));
  assert.match(o.lines.join(""), /verified/);
  assert.equal(lastEvent().code, "ok");
  const calls = stubCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(fs.readFileSync(pinPath), pinBefore, "the live check leaves the real pin untouched");
  assert.ok(!calls[0].includes("--effort") && !calls[0].includes("low"), `no effort argument: ${JSON.stringify(calls[0].slice(0, 5))}`);
  assert.deepEqual(calls[0].slice(0, 5), ["adversarial-review", "--wait", "--json", "--scope", "working-tree"]);
});

test("T-SET-9: a failing Codex call → live_check_failed (exit 1), Codex text on the terminal only", async () => {
  sandbox({ pluginInstalled: true, stubCodex: true });
  const marker = "CODEX-OUTPUT-MARKER-7f3a";
  fs.writeFileSync(process.env.STUB_OUT, marker);
  process.env.STUB_EXIT = "1";
  const o = io([]);
  assert.equal(await main(["setup", "--yes"], o), 1);
  const ev = lastEvent();
  assert.equal(ev.code, "live_check_failed");
  assert.ok(typeof ev.detail === "string" && ev.detail.length > 0);
  assert.match(o.lines.join(""), /Live check failed/);
  assert.ok(!JSON.stringify(ev).includes(marker), "Codex text never reaches an event");
});

test("T-SET-9b: Codex signed out (companion 1.0.6: exit 1, empty stderr, the 401 only in stdout) → setup and doctor --live say codex_auth / `codex login`; the 401 text stays off events", async () => {
  sandbox({ pluginInstalled: true, stubCodex: true });
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 0);
  fs.copyFileSync(path.join(process.cwd(), "test", "fixtures", "companion-1.0.6-signed-out.json"), process.env.STUB_OUT);
  process.env.STUB_EXIT = "1";
  const o = io([]);
  assert.equal(await main(["setup", "--yes"], o), 1);
  assert.equal(lastEvent().detail, "codex_auth", o.lines.join(""));
  assert.equal(LIVE_REMEDY.codex_auth, "codex login");
  assert.match(o.lines.join(""), /Live check failed \(codex_auth\)[\s\S]*Missing bearer/, "Codex's error is on the terminal");
  assert.match(o.lines.join(""), /Live check failed \(codex_auth\)\. Fix: codex login\n/, "setup prints the detail's fix");
  assert.match(o.lines.join(""), /review-loop: live_check_failed \(codex_auth\) — codex login\n/, "the failure line names the fix, not \"see the detail's remedy\"");

  const d = { ...io([]), outs: /** @type {string[]} */ ([]), out(/** @type {string} */ s) { this.outs.push(s); } };
  assert.equal(await main(["doctor", "--live", "--json"], d), 1);
  const live = JSON.parse(d.outs.join("")).checks.find((/** @type {{ id: string }} */ c) => c.id === "live");
  assert.deepEqual([live.status, live.code, live.note, live.fix], ["fail", "live_check_failed", "codex_auth", "codex login"]);
  const events = fs.readFileSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl"), "utf8");
  assert.ok(!/Missing bearer|Unauthorized/.test(events), "no event carries Codex's error text");
});

test("T-SET-10: the live check keeps the user's state dir clean (temp state, temp repo)", async () => {
  sandbox({ pluginInstalled: true, stubCodex: true });
  respond([]);
  assert.equal(await main(["setup", "--yes"], io([])), 0);
  const entries = fs.readdirSync(process.env.REVIEW_LOOP_STATE_DIR).sort();
  assert.ok(!entries.includes("rounds") && !entries.includes("loops"), `unexpected round state: ${entries}`);
});

const CFG = () => process.env.REVIEW_LOOP_CONFIG;
const PIN = () => path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json");
const ioChoose = (answers, pick) => ({ ...io(answers), choose: async () => pick });
async function pinned() {
  const s = sandbox({ pluginInstalled: true });
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 0);
  return s;
}
function drift() {
  const pin = JSON.parse(fs.readFileSync(PIN(), "utf8"));
  const k = Object.keys(pin.files)[0];
  pin.files[k] = "0".repeat(64);
  fs.writeFileSync(PIN(), JSON.stringify(pin));
  return { file: k, bytes: fs.readFileSync(PIN()) };
}

test("I1: declining the config save leaves preset and model/effort under Not done and writes no config", async () => {
  sandbox({ pluginInstalled: true });
  const o = ioChoose([false], "balanced");
  assert.equal(await main(["setup", "--skip-live-check"], o), 3);
  assert.match(o.lines.join(""), /Done: preflight\nNot done: preset, model\/effort, plugin/);
  assert.ok(!fs.existsSync(CFG()));
});

test("I2: an absent pin + --yes pins (first install)", async () => {
  sandbox({ pluginInstalled: true });
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 0);
  assert.ok(fs.existsSync(PIN()));
});

test("I2: a drifted pin + --yes exits plugin_pin_mismatch and leaves the pin bytes unchanged", async () => {
  await pinned();
  const d = drift();
  const o = io([]);
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], o), 1);
  assert.equal(lastEvent().code, "plugin_pin_mismatch");
  assert.match(o.lines.join(""), /without --yes/);
  assert.deepEqual(fs.readFileSync(PIN()), d.bytes);
});

test("I2: a drifted pin + interactive yes re-pins, and the prompt names the drift", async () => {
  await pinned();
  const d = drift();
  const o = io([true]);
  assert.equal(await main(["setup", "--skip-live-check"], o), 0);
  assert.match(o.lines.join(""), new RegExp(`Will: re-pin[^\\n]*changed 1 \\(${d.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  assert.notDeepEqual(fs.readFileSync(PIN()), d.bytes);
});

test("I2: a drifted pin + interactive no exits 3 with the pin unchanged", async () => {
  await pinned();
  const d = drift();
  assert.equal(await main(["setup", "--skip-live-check"], io([false])), 3);
  assert.deepEqual(fs.readFileSync(PIN()), d.bytes);
});

test("M1: a corrupt config is surfaced; --yes rewrites it, a decline leaves it", async () => {
  sandbox({ pluginInstalled: true });
  fs.writeFileSync(CFG(), "{ not json");
  const o = io([false]);
  assert.equal(await main(["setup", "--skip-live-check"], o), 3);
  assert.match(o.lines.join(""), /Config problem: config_invalid/);
  assert.equal(fs.readFileSync(CFG(), "utf8"), "{ not json");
  const o2 = io([]);
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], o2), 0);
  assert.equal(JSON.parse(fs.readFileSync(CFG(), "utf8")).version, 1);
  const kept = fs.readdirSync(path.dirname(CFG())).filter((n) => n.startsWith("cfg.json.corrupt-"));
  assert.equal(kept.length, 1);
  const keptPath = path.join(path.dirname(CFG()), kept[0]);
  assert.equal(fs.readFileSync(keptPath, "utf8"), "{ not json", "the original bytes survive");
  assert.equal(fs.statSync(keptPath).mode & 0o777, 0o600);
  assert.ok(o2.lines.join("").includes(keptPath), "the output names the kept file");
});

test("M1: a config owned by another user is refused with a registered code, unread and unreplaced", { skip: process.getuid?.() === 0 }, async () => {
  sandbox({ pluginInstalled: true });
  fs.writeFileSync(CFG(), "{ not json");
  seams.set({ statUid: () => 4242 });
  try {
    const o = io([]);
    assert.equal(await main(["setup", "--yes", "--skip-live-check"], o), 1);
    assert.equal(lastEvent().code, "config_insecure");
    assert.equal(fs.readFileSync(CFG(), "utf8"), "{ not json");
    assert.deepEqual(fs.readdirSync(path.dirname(CFG())).filter((n) => n.includes("corrupt")), []);
  } finally { seams.reset(); }
});

test("M1: a symlinked config is refused with its code and never followed", async () => {
  const s = sandbox({ pluginInstalled: true });
  const target = path.join(s.home, "elsewhere.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, CFG());
  assert.equal(await main(["setup", "--yes", "--skip-live-check"], io([])), 1);
  assert.equal(lastEvent().code, "config_symlink_rejected");
  assert.equal(fs.readFileSync(target, "utf8"), "{}");
});

test("M2: a flag with no value is usage_bad_flag (exit 2)", async () => {
  const s = sandbox();
  for (const flags of [["--preset"], ["--effort"], ["--model", "--yes"]]) {
    assert.equal(await main(["setup", "--skip-live-check", ...flags], io([])), 2, flags.join(" "));
    assert.equal(lastEvent().code, "usage_bad_flag");
  }
  assert.equal(installs(s).length, 0);
});

test("M3: a failed temp `git init` is live_check_failed (git_failed)", async () => {
  sandbox({ pluginInstalled: true, stubCodex: true });
  makeFakeBin(bin, "git", { "*": { code: 1 } });
  try {
    assert.equal(await main(["setup", "--yes"], io([])), 1);
    assert.equal(lastEvent().code, "live_check_failed");
    assert.equal(lastEvent().detail, "git_failed");
  } finally {
    for (const f of fs.readdirSync(bin).filter((n) => n.startsWith("git."))) fs.rmSync(path.join(bin, f));
    fs.rmSync(path.join(bin, "git"));
  }
});

test("M3: setup --help text warns that --yes runs one billed review", async () => {
  const o = { ...io([]), outs: /** @type {string[]} */ ([]), out(/** @type {string} */ t) { this.outs.push(t); } };
  assert.equal(await main(["--help"], o), 0);
  assert.match(o.outs.join(""), /--yes also runs one billed Codex review without asking; --skip-live-check avoids it/, "help is on stdout (L6)");
});
