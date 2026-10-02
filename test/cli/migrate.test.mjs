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
const { ASK_RULES, seams } = await import("../../cli/lib/settings.mjs");
const io = (answers = []) => ({ isTTY: true, color: false, lines: [], out() {}, err(s) { this.lines.push(s); }, ask: async () => answers.shift() ?? true, choose: async (_q, _o, d) => d, env: process.env });
const PS = "    1     0 /sbin/launchd\n  200     1 -zsh\n";
const OLD_REF = "~/.claude/review-loop/CLAUDE.md";
// The author's real global CLAUDE.md line, verbatim, between lines migrate must never touch.
const REAL_LINE = "- Engine, invariants and tests: `~/.claude/review-loop/CLAUDE.md`.";
const CLAUDE_MD = `# Global instructions\n\n- **Plan before coding.** Wait for "go".\n${REAL_LINE}\n- Old notes live in ~/.claude/review-loop too.\n`;
const EDITED_LINE = "- Engine, invariants and tests: the `review-loop` plugin (`review-loop doctor`; https://github.com/acme/review-loop).";
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const LEGACY = (home) => ({
  PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/graphify hook-guard search" }] }, { matcher: "Bash", hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs pr`, timeout: 40 }] }, { matcher: "mcp__.*__create_pull_request", hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs pr`, timeout: 40 }] }],
  SessionStart: [{ hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs session`, timeout: 20 }] }],
  PostToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs track`, timeout: 5 }] }],
  Stop: [{ hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs stop`, timeout: 20 }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${home}/.claude/review-loop/review-gate-hook.mjs prompt`, timeout: 5 }] }]
});

/** An author-shaped legacy install, generated inside a fresh sandbox HOME. */
function authorShaped({ installFails = false, hooks = LEGACY, ps = PS } = {}) {
  const home = tmpDir();
  const c = path.join(home, ".claude");
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: c, CODEX_HOME: path.join(home, ".codex"), REVIEW_LOOP_STATE_DIR: path.join(c, "state", "review-loop"), REVIEW_LOOP_CONFIG: path.join(home, ".config", "review-loop", "config.json") });
  delete process.env.REVIEW_LOOP_PIN_FILE;
  // The seam supplies a fixed owner; T-MIG-5c pins the placeholder skip with a placeholder source.
  process.env.REVIEW_LOOP_TEST_MARKETPLACE_SOURCE = "acme/review-loop";
  fs.mkdirSync(path.join(c, "review-loop", "lib"), { recursive: true });
  fs.writeFileSync(path.join(c, "review-loop", "review-gate-hook.mjs"), "// legacy");
  fs.writeFileSync(path.join(c, "review-loop", "plugin-pin.json"), JSON.stringify({ version: "1.0.6", files: {} }));
  fs.mkdirSync(path.join(c, "skills", "review-loop"), { recursive: true });
  fs.writeFileSync(path.join(c, "skills", "review-loop", "SKILL.md"), "---\nname: review-loop\n---\n");
  fs.mkdirSync(path.join(c, "rules"), { recursive: true });
  fs.copyFileSync(new URL("../../plugin/rubric/default.md", import.meta.url), path.join(c, "rules", "multi-dimension-review.md"));
  fs.mkdirSync(path.join(c, "state", "review-loop", "records"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(c, "state", "review-loop", "records", "keep.json"), "{}");
  fs.writeFileSync(path.join(c, "CLAUDE.md"), CLAUDE_MD);
  fs.writeFileSync(path.join(c, "settings.json"), JSON.stringify({ theme: "dark", hooks: hooks(home), permissions: { ask: [...ASK_RULES] } }));
  const listed = JSON.stringify([{ id: "review-loop@review-loop", enabled: true, version: "0.1.0", installPath: "/x" }]);
  const claude = makeFakeBin(bin, "claude", {
    // migrate's first check sees no plugin; every later check (post-install verify, doctor, rollback) sees it installed.
    "plugin list --json": [{ stdout: "[]" }, { stdout: listed }],
    "plugin install review-loop@review-loop --scope user --json": installFails ? { code: 1, stderr: "nope" } : { stdout: "{}" },
    "*": { stdout: "{}\n" }
  });
  makeFakeBin(bin, "ps", { "*": { stdout: ps } });
  makeFakeBin(bin, "lsof", { "*": { code: 1 } });
  return { home, c, claude };
}
const settings = (c) => JSON.parse(fs.readFileSync(path.join(c, "settings.json"), "utf8"));
const legacyCount = (s) => JSON.stringify(s.hooks ?? {}).match(/review-gate-hook\.mjs/g)?.length ?? 0;
const manifestFile = () => path.join(process.env.REVIEW_LOOP_STATE_DIR, "migration.json");
const installCalls = (claude) => claude.log().filter((a) => a[0] === "plugin" && a[1] === "install");

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
  assert.equal(JSON.parse(fs.readFileSync(manifestFile(), "utf8")).status, "done");
});

test("T-MIG-1 (−): plugin install fails → settings bytes unchanged", async () => {
  const { c } = authorShaped({ installFails: true });
  const before = fs.readFileSync(path.join(c, "settings.json"));
  assert.equal(await main(["migrate", "--yes"], io()), 1);
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), before);
});

test("T-MIG-1 (−): a running Claude Code session refuses migrate before the plugin install", async () => {
  const { c, claude } = authorShaped({ ps: `${PS}  300     1 /usr/local/bin/claude\n` });
  const before = fs.readFileSync(path.join(c, "settings.json"));
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 1);
  assert.deepEqual(installCalls(claude), [], "nothing installed");
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), before);
  assert.ok(fs.existsSync(path.join(c, "skills", "review-loop", "SKILL.md")));
});

test("R-D29: a hook group mixing a legacy hook with a foreign one aborts before any change", async () => {
  const mixed = (home) => {
    const h = LEGACY(home);
    h.Stop[0].hooks.push({ type: "command", command: "/usr/local/bin/notify done" });
    return h;
  };
  const { c, claude } = authorShaped({ hooks: mixed });
  const before = fs.readFileSync(path.join(c, "settings.json"));
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 1);
  assert.match(o.lines.join(""), /settings_mixed_hook_group/);
  assert.match(o.lines.join(""), /move the review-loop hook into its own hook group/);
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), before, "no settings write");
  assert.deepEqual(installCalls(claude), [], "aborted before the plugin install");
  assert.equal(fs.existsSync(manifestFile()), false, "no manifest");
});

test("R-D29: a legacy hook in a shape rollback could not restore aborts before any change", async () => {
  const odd = (home) => {
    const h = LEGACY(home);
    h.Stop[0].hooks[0].command = `node "$HOME/.claude/review-loop/review-gate-hook.mjs" stop`;
    return h;
  };
  const { c, claude } = authorShaped({ hooks: odd });
  const before = fs.readFileSync(path.join(c, "settings.json"));
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 1);
  assert.match(o.lines.join(""), /settings_legacy_hook_unrecognized/);
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), before);
  assert.deepEqual(installCalls(claude), []);
});

test("T-MIG-2/3/4: history kept; rubricPath set; skill moved out of skills/", async () => {
  const { c } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  assert.ok(fs.existsSync(path.join(c, "state", "review-loop", "records", "keep.json")));
  assert.equal(JSON.parse(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8")).rubricPath, path.join(c, "rules", "multi-dimension-review.md"));
  assert.equal(fs.existsSync(path.join(c, "skills", "review-loop")), false);
  const archive = fs.readdirSync(c).find((n) => n.startsWith("review-loop-legacy-"));
  assert.ok(fs.existsSync(path.join(c, archive, "skill", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(c, "state", "review-loop", "plugin-pin.json")), "pin moved into the state dir");
  assert.equal(fs.statSync(path.join(c, "state", "review-loop", "plugin-pin.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(c, "review-loop", "plugin-pin.json")), false);
});

test("T-MIG-2 (−): an invalid config is never overwritten; the rubric step is skipped with a note", async () => {
  authorShaped();
  fs.mkdirSync(path.dirname(process.env.REVIEW_LOOP_CONFIG), { recursive: true });
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, "{ not json");
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 0);
  assert.equal(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8"), "{ not json");
  assert.match(o.lines.join(""), /config repair/);
});

test("T-MIG-5: CLAUDE.md edited only on yes", async () => {
  const { c } = authorShaped();
  const before = fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8");
  // With ps reporting no running claude, the CLAUDE.md step is migrate's only prompt.
  assert.equal(await main(["migrate", "--skip-doctor-gate"], io([false])), 0);
  assert.equal(fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8"), before, "answered no to the CLAUDE.md step");
  assert.equal(fs.readdirSync(c).some((n) => n.startsWith("CLAUDE.md.review-loop-backup-")), false);

  const y = authorShaped();
  assert.equal(await main(["migrate", "--skip-doctor-gate"], io([true])), 0);
  assert.equal(fs.readFileSync(path.join(y.c, "CLAUDE.md"), "utf8"), CLAUDE_MD.replace(REAL_LINE, EDITED_LINE), "answered yes: exactly that line, well-formed, every other line byte-identical");
  const backup = fs.readdirSync(y.c).find((n) => n.startsWith("CLAUDE.md.review-loop-backup-"));
  assert.ok(backup, "the original is kept");
  assert.equal(fs.statSync(path.join(y.c, backup)).mode & 0o777, 0o600);
});

test("T-MIG-5c: while the marketplace owner is a placeholder the CLAUDE.md edit is skipped, with a note, and not recorded", async () => {
  const { c } = authorShaped();
  process.env.REVIEW_LOOP_TEST_MARKETPLACE_SOURCE = "<owner>/review-loop";
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 0);
  assert.equal(fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8"), CLAUDE_MD);
  const note = o.lines.join("");
  assert.match(note, /CLAUDE\.md was not edited: this build has no real repository address yet/);
  assert.ok(note.includes("- `~/.claude/review-loop/CLAUDE.md`\n+ the `review-loop` plugin (`review-loop doctor`)\n"), "the exact hand edit is printed");
  assert.doesNotMatch(note, /later `review-loop migrate`/, "no promise a re-run cannot keep");
  assert.equal(JSON.parse(fs.readFileSync(manifestFile(), "utf8")).steps.some((s) => s.resource === "claude_md"), false);
});

test("T-MIG-5d: CLAUDE.md changed after migrate → rollback leaves it untouched and reports it", async () => {
  const { c } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const changed = `${fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8")}- a later edit\n`;
  fs.writeFileSync(path.join(c, "CLAUDE.md"), changed);
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  assert.match(o.lines.join(""), /rollback_skipped_modified/);
  assert.match(o.lines.join(""), /CLAUDE\.md \(changed after migration\)/);
  assert.equal(fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8"), changed);
});

test("T-MIG-5e: a CLAUDE.md over 1 MiB is not edited, and the user is told why", async () => {
  const { c } = authorShaped();
  const big = CLAUDE_MD + "x".repeat(1024 * 1024);
  fs.writeFileSync(path.join(c, "CLAUDE.md"), big);
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 0);
  assert.match(o.lines.join(""), /CLAUDE\.md was not edited: it is over 1 MiB/);
  assert.equal(fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8"), big);
});

test("T-MIG-6: engine dir moves only when doctor passes; the record says the migration is unfinished", async () => {
  const { c } = authorShaped();
  const o = io();
  assert.equal(await main(["migrate", "--yes"], o), 1, "doctor fails in the sandbox (no real plugin)");
  assert.match(o.lines.join(""), /review-loop: doctor_failed/);
  assert.doesNotMatch(o.lines.join(""), /Migrated\./, "no success line before the failure");
  assert.ok(fs.existsSync(path.join(c, "review-loop", "review-gate-hook.mjs")), "not moved");
  const m = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
  assert.equal(m.status, "in_progress", "not done: the engine step is still pending");
  assert.equal(m.steps.some((s) => s.resource === "engine_dir"), false);
});

test("T-MIG-7 (config): an existing config is restored byte-for-byte on rollback", async () => {
  authorShaped();
  fs.mkdirSync(path.dirname(process.env.REVIEW_LOOP_CONFIG), { recursive: true });
  const original = JSON.stringify({ version: 1, preset: "balanced", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } });
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, original, { mode: 0o600 });
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
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
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const pin = path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json");
  fs.writeFileSync(pin, JSON.stringify({ version: "1.0.7", files: {} }));
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  assert.match(o.lines.join(""), /pin \(changed after migration\)/);
  assert.match(o.lines.join(""), /rollback_skipped_modified/);
  assert.equal(JSON.parse(fs.readFileSync(pin, "utf8")).version, "1.0.7", "re-written pin kept");
  assert.equal(fs.existsSync(path.join(c, "review-loop", "plugin-pin.json")), false);
});

test("T-MIG-9: an unreadable manifest is a loud failure, never 'nothing to roll back', and is not quarantined", async () => {
  authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const mf = manifestFile();
  fs.chmodSync(mf, 0o000);
  try {
    const o = io();
    assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
    assert.match(o.lines.join(""), /migration_manifest_unreadable/);
    assert.doesNotMatch(o.lines.join(""), /Nothing to roll back/);
    assert.ok(fs.existsSync(mf), "left in place for the user to fix");
  } finally { fs.chmodSync(mf, 0o600); }
  fs.chmodSync(process.env.REVIEW_LOOP_STATE_DIR, 0o000);
  try {
    const o = io();
    assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1, "lstat EACCES is not ENOENT");
    assert.match(o.lines.join(""), /state_dir_insecure/);
  } finally { fs.chmodSync(process.env.REVIEW_LOOP_STATE_DIR, 0o700); }
});

test("T-MIG-8b: a link swapped in between the checks and the read is never followed", async (t) => {
  authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const mf = manifestFile();
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
    (/** @type {string} */ pin) => { fs.writeFileSync(pin, JSON.stringify({ version: "1.0.6", pad: "x".repeat(70 * 1024) })); return null; },
    (/** @type {string} */ pin) => { fs.writeFileSync(pin, JSON.stringify({ version: "../../etc", files: {} })); return null; }
  ]) {
    const { c } = authorShaped();
    const pin = path.join(c, "review-loop", "plugin-pin.json");
    const secret = make(pin);
    const o = io();
    assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 0);
    assert.match(o.lines.join(""), /not a regular, valid pin file/);
    assert.equal(fs.existsSync(path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json")), false, "nothing copied into state");
    assert.ok(fs.lstatSync(pin), "left in place");
    if (secret) assert.equal(JSON.parse(fs.readFileSync(secret, "utf8")).version, "SECRET", "link target untouched");
  }
});

test("T-MIG-8: a tampered manifest is quarantined; nothing outside the migration roots moves; no hook is injected", async () => {
  const { c, claude } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const mf = manifestFile();
  const victim = path.join(tmpDir(), "victim.txt");
  fs.writeFileSync(victim, "keep");
  const good = JSON.parse(fs.readFileSync(mf, "utf8"));
  const settingsBefore = fs.readFileSync(path.join(c, "settings.json"));
  for (const tamper of [
    (m) => { m.steps.push({ resource: "engine_dir", action: "move", before: { path: path.join(tmpDir(), "dest") }, after: { path: victim } }); m.date = "../../x"; },
    (m) => { m.steps.find((s) => s.resource === "settings").removedHooks.push({ event: "Stop", index: 0, group: { hooks: [{ type: "command", command: "node /x/.claude/review-loop/review-gate-hook.mjs stop; curl evil" }] } }); },
    (m) => { m.steps.find((s) => s.resource === "settings").addedAsk.push("Bash(anything)"); },
    (m) => { m.steps.push({ resource: "claude_md", action: "edit", before: { backupTs: "../../etc/hosts" }, after: { sha: "0".repeat(64) } }); },
    (m) => { m.steps.find((s) => s.resource === "settings").removedHooks.push({ event: "constructor", index: 0, group: good.steps.find((s) => s.resource === "settings").removedHooks[0].group }); },
    (m) => { m.steps.find((s) => s.resource === "config").before = { sha: "0".repeat(64), bytes: JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }) }; },
    (m) => { m.steps.find((s) => s.resource === "settings").removedHooks.push({ event: "SessionStart", index: 0, group: { hooks: [{ type: "command", command: "node /tmp/attacker/.claude/review-loop/review-gate-hook.mjs session" }] } }); },
    // Every hook consistently at one foreign dir that is not a real directory of ours: invalid, never a "mismatch".
    (m) => { for (const r of m.steps.find((s) => s.resource === "settings").removedHooks) for (const h of r.group.hooks) h.command = h.command.replace(c, "/tmp/rl-attacker-nonexistent/.claude"); },
    // Rollback uninstalls on a plugin step, so its action and shape must be exactly what migrate records.
    (m) => { m.steps.push({ resource: "plugin", action: "remove_everything", before: { absent: true }, after: {} }); },
    (m) => { m.steps.push({ resource: "plugin", action: "install", before: { absent: true, extra: 1 }, after: {} }); },
    (m) => { m.steps.push({ resource: "marketplace", action: "noop", before: {}, after: {} }); }
  ]) {
    const m = structuredClone(good);
    tamper(m);
    fs.writeFileSync(mf, JSON.stringify(m));
    const o = io();
    assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
    assert.match(o.lines.join(""), /migration_manifest_invalid/);
    assert.ok(fs.readdirSync(path.dirname(mf)).some((n) => n.startsWith("migration.json.corrupt-")), "quarantined");
    assert.equal(fs.existsSync(mf), false);
    assert.equal(fs.readFileSync(victim, "utf8"), "keep");
    assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), settingsBefore, "no settings write");
    assert.equal(claude.log().some((a) => a.includes("uninstall") || (a.includes("marketplace") && a.includes("remove"))), false, "no plugin or marketplace removal");
  }
  fs.symlinkSync(victim, mf);
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 1, "a symlinked manifest is refused");
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
});

test("T-MIG-8c: a VALID manifest carrying paths never steers rollback; every path is derived", async () => {
  const { c } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate", "--force-engine-move"], io()), 0);
  const mf = manifestFile();
  const victimDir = path.join(tmpDir(), "victim-dir");
  fs.mkdirSync(victimDir);
  fs.writeFileSync(path.join(victimDir, "precious.txt"), "keep");
  const elsewhere = path.join(tmpDir(), "elsewhere");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  for (const s of m.steps) if (s.resource === "engine_dir" || s.resource === "skill") { s.before = { path: elsewhere }; s.after = { path: victimDir }; }
  fs.writeFileSync(mf, JSON.stringify(m));
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.equal(fs.readFileSync(path.join(victimDir, "precious.txt"), "utf8"), "keep", "the manifest's path was not moved");
  assert.equal(fs.existsSync(elsewhere), false, "nothing moved to the manifest's destination");
  assert.ok(fs.existsSync(path.join(c, "review-loop", "review-gate-hook.mjs")), "the derived engine path was restored");
  assert.ok(fs.existsSync(path.join(c, "skills", "review-loop", "SKILL.md")), "the derived skill path was restored");
});

test("T-MIG-7 (dirs): a legacy folder re-created after migration is never overwritten; rollback reports it, and a retry finishes", async () => {
  const { c, claude } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  fs.mkdirSync(path.join(c, "skills", "review-loop"), { recursive: true });
  fs.writeFileSync(path.join(c, "skills", "review-loop", "SKILL.md"), "new");
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  assert.match(o.lines.join(""), /legacy skill \(.* exists again/);
  assert.match(o.lines.join(""), /run review-loop migrate --rollback again to finish/);
  assert.equal(fs.readFileSync(path.join(c, "skills", "review-loop", "SKILL.md"), "utf8"), "new");
  const archive = fs.readdirSync(c).find((n) => n.startsWith("review-loop-legacy-"));
  assert.ok(fs.existsSync(path.join(c, archive, "skill", "SKILL.md")), "the archived copy is kept");
  const m = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
  assert.notEqual(m.status, "rolled_back", "a skipped restore keeps the record open");
  assert.equal(m.steps.find((s) => s.resource === "skill").undone, undefined, "the skipped step stays pending");
  const removals = () => claude.log().filter((a) => a.includes("uninstall") || (a.includes("marketplace") && a.includes("remove"))).length;
  const removedOnce = removals();
  // The user clears the conflict; the retry resumes at the skipped step and replays nothing that already ran.
  fs.rmSync(path.join(c, "skills", "review-loop"), { recursive: true });
  const r = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], r), 0, r.lines.join(""));
  assert.ok(fs.existsSync(path.join(c, "skills", "review-loop", "SKILL.md")), "the archived skill is restored on retry");
  assert.notEqual(fs.readFileSync(path.join(c, "skills", "review-loop", "SKILL.md"), "utf8"), "new");
  assert.equal(removals(), removedOnce, "no step that already ran is replayed");
  assert.equal(JSON.parse(fs.readFileSync(manifestFile(), "utf8")).status, "rolled_back");
  const again = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], again), 0);
  assert.match(again.lines.join(""), /Nothing to roll back/);
});

test("T-MIG-7 (half-done pin): a copy whose original is still in place is removed only when both hash to the record, and rollback says so", async () => {
  const { c } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const pin = path.join(process.env.REVIEW_LOOP_STATE_DIR, "plugin-pin.json");
  const legacy = path.join(c, "review-loop", "plugin-pin.json");
  fs.copyFileSync(pin, legacy);
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 0);
  assert.match(o.lines.join(""), /Removed the copied pin/);
  assert.equal(fs.existsSync(pin), false);
  assert.equal(JSON.parse(fs.readFileSync(legacy, "utf8")).version, "1.0.6");
});

test("T-MIG-10b: a crash between the config write and the next step still restores the config (after-sha recorded first)", async (t) => {
  authorShaped();
  const cfg = process.env.REVIEW_LOOP_CONFIG;
  const orig = fs.renameSync;
  t.mock.method(fs, "renameSync", (/** @type {fs.PathLike} */ a, /** @type {fs.PathLike} */ b) => { orig(a, b); if (String(b) === cfg) throw new Error("simulated crash after the config rename"); });
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 4);
  t.mock.restoreAll();
  assert.ok(fs.existsSync(cfg), "the config write landed before the crash");
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.equal(fs.existsSync(cfg), false, "restored to absent");
});

test("T-MIG-13: a second legacy install after a finished migration is refused before any change (archive occupied)", async () => {
  const { home, c, claude } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate", "--force-engine-move"], io()), 0);
  fs.mkdirSync(path.join(c, "review-loop"), { recursive: true });
  fs.writeFileSync(path.join(c, "review-loop", "review-gate-hook.mjs"), "// legacy again");
  fs.mkdirSync(path.join(c, "skills", "review-loop"), { recursive: true });
  fs.writeFileSync(path.join(c, "skills", "review-loop", "SKILL.md"), "again");
  fs.writeFileSync(path.join(c, "settings.json"), JSON.stringify({ ...settings(c), hooks: LEGACY(home) }));
  const settingsBefore = fs.readFileSync(path.join(c, "settings.json"));
  const manifestBefore = fs.readFileSync(manifestFile());
  const installsBefore = installCalls(claude).length;
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate", "--force-engine-move"], o), 1);
  assert.match(o.lines.join(""), /migration_archive_occupied/);
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), settingsBefore, "no settings write");
  assert.deepEqual(fs.readFileSync(manifestFile()), manifestBefore, "manifest unchanged");
  assert.equal(installCalls(claude).length, installsBefore);
  assert.ok(fs.existsSync(path.join(c, "skills", "review-loop", "SKILL.md")));
});

test("an installed but disabled plugin is refused before any change: migrate never enables what rollback could not disable", async () => {
  const { c, claude } = authorShaped();
  claude.set({ "plugin list --json": { stdout: JSON.stringify([{ id: "review-loop@review-loop", enabled: false, version: "0.1.0", installPath: "/x" }]) } });
  const settingsBefore = fs.readFileSync(path.join(c, "settings.json"));
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 1);
  assert.match(o.lines.join(""), /plugin_disabled/);
  assert.match(o.lines.join(""), /claude plugin enable review-loop@review-loop/);
  assert.deepEqual(installCalls(claude), [], "no install or enable call");
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), settingsBefore, "settings untouched");
  assert.equal(fs.existsSync(manifestFile()), false, "no migration record written");
});

test("rollback with a project-scope install still listed is refused before anything moves; the record is kept", async () => {
  const { c, claude } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  claude.set({ "plugin list --json": { stdout: JSON.stringify([
    { id: "review-loop@review-loop", enabled: true, scope: "user", version: "0.1.0", installPath: "/x" },
    { id: "review-loop@review-loop", enabled: true, scope: "project", version: "0.1.0", installPath: "/y" }
  ]) }, "*": { stdout: "{}\n" } });
  const settingsBefore = fs.readFileSync(path.join(c, "settings.json"));
  const manifestBefore = fs.readFileSync(manifestFile());
  const callsBefore = claude.log().length;
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  assert.match(o.lines.join(""), /plugin_other_scope/);
  assert.ok(!claude.log().slice(callsBefore).some((a) => a[1] === "uninstall" || a[1] === "marketplace"), "no plugin or marketplace removal ran");
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), settingsBefore, "settings untouched");
  assert.deepEqual(fs.readFileSync(manifestFile()), manifestBefore, "migration record kept for a retry");
});

test("rollback with the config folder swapped for a link is refused before anything moves; the file it reaches is untouched", async () => {
  const { c, claude } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const dir = path.dirname(process.env.REVIEW_LOOP_CONFIG);
  const elsewhere = path.join(path.dirname(dir), "elsewhere");
  fs.renameSync(dir, elsewhere);
  fs.symlinkSync(elsewhere, dir);
  const configBefore = fs.readFileSync(path.join(elsewhere, path.basename(process.env.REVIEW_LOOP_CONFIG)));
  const settingsBefore = fs.readFileSync(path.join(c, "settings.json"));
  const manifestBefore = fs.readFileSync(manifestFile());
  const callsBefore = claude.log().length;
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  assert.match(o.lines.join(""), /config_dir_untrusted/);
  assert.ok(!claude.log().slice(callsBefore).some((a) => a[1] === "uninstall" || a[1] === "marketplace"), "no plugin or marketplace removal ran");
  assert.deepEqual(fs.readFileSync(path.join(elsewhere, path.basename(process.env.REVIEW_LOOP_CONFIG))), configBefore, "the linked config is untouched");
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), settingsBefore, "settings untouched");
  assert.deepEqual(fs.readFileSync(manifestFile()), manifestBefore, "migration record kept for a retry");
});

test("a run stopped after archiving the engine but before marking its record done is finished by the next migrate", async () => {
  const { c } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate", "--force-engine-move"], io()), 0);
  assert.equal(fs.existsSync(path.join(c, "review-loop")), false, "engine archived");
  // The crash window: every move done, the record still in_progress.
  const done = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
  fs.writeFileSync(manifestFile(), JSON.stringify({ ...done, status: "in_progress" }));
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 0);
  assert.match(o.lines.join(""), /Finished an interrupted migration/);
  assert.doesNotMatch(o.lines.join(""), /Nothing to migrate/);
  const after = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
  assert.equal(after.status, "done");
  assert.deepEqual(after.steps, done.steps, "the undo data is kept as recorded");
  const again = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], again), 0);
  assert.match(again.lines.join(""), /Nothing to migrate/, "a finished record is not finished twice");
});

test("a run interrupted after the settings update, with no engine, skill or pin, still applies the rubric and CLAUDE.md steps on resume", async () => {
  const { c } = authorShaped();
  for (const p of [path.join(c, "review-loop"), path.join(c, "skills", "review-loop")]) fs.rmSync(p, { recursive: true });
  const rubric = path.join(c, "rules", "multi-dimension-review.md");
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const full = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
  assert.deepEqual(full.steps.map((s) => s.resource), ["plugin", "settings", "config", "claude_md"]);
  // The crash window: the settings write committed, nothing after it ran, the record still in_progress.
  fs.writeFileSync(manifestFile(), JSON.stringify({ ...full, status: "in_progress", steps: full.steps.slice(0, 2) }));
  fs.rmSync(process.env.REVIEW_LOOP_CONFIG);
  fs.writeFileSync(path.join(c, "CLAUDE.md"), CLAUDE_MD);
  const o = io();
  assert.equal(await main(["migrate", "--yes"], o), 0, "no engine left to move, so no doctor gate");
  assert.match(o.lines.join(""), /Finished an interrupted migration/);
  assert.equal(JSON.parse(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8")).rubricPath, rubric, "the rubric step ran");
  assert.notEqual(fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8"), CLAUDE_MD, "the CLAUDE.md step ran");
  const after = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
  assert.equal(after.status, "done");
  assert.deepEqual(after.steps.map((s) => s.resource), ["plugin", "settings", "config", "claude_md"], "earlier steps kept as recorded, later ones recorded once");
  assert.deepEqual(after.steps.slice(0, 2), full.steps.slice(0, 2));
  // The resumed steps are real undo data: rollback restores what they changed.
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.equal(fs.existsSync(process.env.REVIEW_LOOP_CONFIG), false, "the config the resume created is removed");
  assert.equal(fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8"), CLAUDE_MD);
});

test("rollback with an archived folder deleted never claims success; putting the folder back lets a retry finish", async () => {
  const { c } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate", "--force-engine-move"], io()), 0);
  const archived = path.join(c, `review-loop-legacy-${JSON.parse(fs.readFileSync(manifestFile(), "utf8")).date}`, "engine");
  assert.ok(fs.existsSync(archived));
  fs.rmSync(archived, { recursive: true });
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  assert.match(o.lines.join(""), /rollback_skipped_modified/);
  assert.match(o.lines.join(""), /legacy engine folder \(its archived copy .* is gone/);
  assert.doesNotMatch(o.lines.join(""), /Rolled back/);
  const m = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
  assert.notEqual(m.status, "rolled_back");
  assert.notEqual(m.steps.find((s) => s.resource === "engine_dir").undone, true, "the engine step stays pending");
  // Undoing the pin re-created the engine folder holding only the pin: that is not the engine coming back.
  assert.ok(fs.existsSync(path.join(c, "review-loop", "plugin-pin.json")));
  const retry = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], retry), 1, "a folder holding only the pin does not finish the step");
  assert.match(retry.lines.join(""), /legacy engine folder \(its archived copy .* is gone/);
  fs.writeFileSync(path.join(c, "review-loop", "review-gate-hook.mjs"), "// restored from a backup");
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.equal(JSON.parse(fs.readFileSync(manifestFile(), "utf8")).status, "rolled_back");
});

test("T-MIG-14: a record that could overflow MAX_STEPS is refused before any change", async () => {
  const { c, claude } = authorShaped();
  const m = { v: 1, status: "in_progress", date: localDate(), steps: Array.from({ length: 60 }, () => ({ resource: "engine_dir", action: "move", before: {}, after: {} })) };
  fs.writeFileSync(manifestFile(), JSON.stringify(m));
  const settingsBefore = fs.readFileSync(path.join(c, "settings.json"));
  const manifestBefore = fs.readFileSync(manifestFile());
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 1);
  assert.match(o.lines.join(""), /migration_record_full/);
  assert.deepEqual(fs.readFileSync(path.join(c, "settings.json")), settingsBefore);
  assert.deepEqual(fs.readFileSync(manifestFile()), manifestBefore);
  assert.deepEqual(installCalls(claude), []);
});

test("T-MIG-15: the archive is named for the local date the user sees", async () => {
  const { c } = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  assert.ok(fs.existsSync(path.join(c, `review-loop-legacy-${localDate()}`, "skill")));
  assert.equal(JSON.parse(fs.readFileSync(manifestFile(), "utf8")).date, localDate());
});

test("T-MIG-2 (−): a symlinked config gets its own message, never 'config repair'", async () => {
  authorShaped();
  const real = path.join(tmpDir(), "real-config.json");
  fs.writeFileSync(real, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  fs.mkdirSync(path.dirname(process.env.REVIEW_LOOP_CONFIG), { recursive: true });
  fs.symlinkSync(real, process.env.REVIEW_LOOP_CONFIG);
  const o = io();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], o), 0);
  assert.match(o.lines.join(""), /config .* is a symlink, which review-loop never follows, so rubricPath was not set/);
  assert.doesNotMatch(o.lines.join(""), /config repair/);
  assert.ok(fs.lstatSync(process.env.REVIEW_LOOP_CONFIG).isSymbolicLink());
});

test("T-MIG-16: rollback under a different CLAUDE_CONFIG_DIR names the recorded dir, keeps the record, and succeeds with the right one", async () => {
  const { c } = authorShaped();
  const hooksBefore = settings(c).hooks;
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  const manifestBefore = fs.readFileSync(manifestFile());
  const other = path.join(tmpDir(), "other-claude");
  fs.mkdirSync(other);
  process.env.CLAUDE_CONFIG_DIR = other;
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 1);
  assert.match(o.lines.join(""), /migration_config_dir_mismatch/);
  assert.ok(o.lines.join("").includes(`re-run with CLAUDE_CONFIG_DIR=${c}`));
  assert.deepEqual(fs.readFileSync(manifestFile()), manifestBefore, "record left as it was");
  assert.equal(fs.readdirSync(path.dirname(manifestFile())).some((n) => n.startsWith("migration.json.corrupt-")), false, "not quarantined");
  process.env.CLAUDE_CONFIG_DIR = c;
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.deepEqual(settings(c).hooks, hooksBefore);
});

test("T-MIG-10: a crash right after the settings commit leaves rollback what it removed (entry before mutate)", async () => {
  const { c } = authorShaped();
  const hooksBefore = settings(c).hooks;
  seams.set({ afterRename: () => { throw new Error("simulated crash after the settings rename"); } });
  try {
    assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 4);
  } finally { seams.reset(); }
  assert.equal(legacyCount(settings(c)), 0, "the settings write landed before the crash");
  assert.equal(JSON.parse(fs.readFileSync(manifestFile(), "utf8")).status, "in_progress");
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.deepEqual(settings(c).hooks, hooksBefore, "every removed hook group is back where it was");
});

test("T-MIG-11: re-running migrate after a crash resumes the same record, so the first run's undo data survives", async () => {
  const { c } = authorShaped();
  const hooksBefore = settings(c).hooks;
  seams.set({ afterRename: () => { throw new Error("simulated crash after the settings rename"); } });
  try {
    assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 4);
  } finally { seams.reset(); }
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0, "the re-run finishes the migration");
  assert.equal(fs.existsSync(path.join(c, "skills", "review-loop")), false);
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 0);
  assert.deepEqual(settings(c).hooks, hooksBefore, "hooks removed by the crashed run are restored");
  assert.ok(fs.existsSync(path.join(c, "skills", "review-loop", "SKILL.md")));
});

test("T-MIG-12: nothing legacy → nothing to migrate, nothing written; an unknown flag is a usage error", async () => {
  const home = tmpDir();
  Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "config.json") });
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: [...ASK_RULES] } }));
  const o = io();
  assert.equal(await main(["migrate", "--yes"], o), 0);
  assert.match(o.lines.join(""), /Nothing to migrate/);
  assert.equal(fs.existsSync(path.join(home, "state", "migration.json")), false);
  assert.equal(await main(["migrate", "--yes", "--bogus"], io()), 2);
});

test("T-MIG-7: rollback restores every resource; a second rollback is a no-op; modified config is skipped", async () => {
  const { c, claude } = authorShaped();
  const settingsBefore = settings(c);
  const claudeMdBefore = fs.readFileSync(path.join(c, "CLAUDE.md"), "utf8");
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate", "--force-engine-move"], io()), 0);
  assert.equal(fs.existsSync(path.join(c, "review-loop")), false, "engine dir archived");
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
  const o = io();
  assert.equal(await main(["migrate", "--rollback", "--yes"], o), 0, "idempotent");
  assert.match(o.lines.join(""), /Nothing to roll back/);

  const second = authorShaped();
  assert.equal(await main(["migrate", "--yes", "--skip-doctor-gate"], io()), 0);
  assert.equal(await main(["config", "set", "preset", "advisory"], io()), 0);
  assert.equal(await main(["migrate", "--rollback", "--yes"], io()), 1);
  assert.equal(JSON.parse(fs.readFileSync(process.env.REVIEW_LOOP_CONFIG, "utf8")).preset, "advisory", "modified config left alone");
  void second;
});
