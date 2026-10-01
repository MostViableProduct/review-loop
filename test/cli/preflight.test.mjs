import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:/usr/bin:/bin`;
const { lastJsonLine, runTool, noteFor, requireRan } = await import("../../cli/lib/run.mjs");
const { PREFLIGHT, runPreflight, MIN_CLAUDE } = await import("../../cli/lib/preflight.mjs");

const claudeVersion = `${MIN_CLAUDE} (Claude Code)\n`;
const pluginList = (extra = "") => extra + JSON.stringify([{ id: "codex@openai-codex", enabled: true, scope: "user", version: "1.0.6" }]) + "\n";
const healthy = () => {
  makeFakeBin(bin, "claude", { "--version": { stdout: claudeVersion }, "plugin list --json": { stdout: pluginList() } });
  makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { stdout: "Logged in using ChatGPT\n" } });
  makeFakeBin(bin, "gh", { "auth status": { stdout: "Logged in\n" } });
};
const io = (answers = [], over = {}) => ({
  isTTY: true, color: false, out: () => {}, lines: [],
  err(s) { this.lines.push(s); },
  asked: [],
  async ask(q) { this.asked.push(q); return answers.shift() ?? false; },
  choose: async (_q, _o, d) => d, env: process.env, ...over
});
const text = (o) => o.lines.join("");
const item = (id) => PREFLIGHT.find((p) => p.id === id);

test("[RF-4] lastJsonLine takes the last parseable object line", () => {
  assert.deepEqual(lastJsonLine('warning: x\n{"a":1}\n{"b":2}\n'), { b: 2 });
  assert.equal(lastJsonLine("no json here\n"), null);
});

test("T-SET-3: five items, all OK when healthy", async () => {
  healthy();
  assert.deepEqual(PREFLIGHT.map((p) => p.id), ["claude", "codex_cli", "codex_auth", "codex_plugin", "gh"]);
  const o = io();
  assert.equal(await runPreflight(o, { yes: false }), true);
  assert.equal(text(o).match(/OK/g).length, 5);
  assert.deepEqual(o.asked, [], "nothing to fix, nothing asked");
});

test("T-SET-3 (−): a broken item shows FAIL, offers its exact fix, runs it on yes, and re-checks", async () => {
  healthy();
  const codex = makeFakeBin(bin, "codex", {
    "--version": { stdout: "codex-cli 0.157.1\n" },
    "login status": [{ code: 1, stdout: "Not logged in\n" }, { code: 0, stdout: "Logged in using ChatGPT\n" }],
    login: { code: 0 }
  });
  const o = io([true]);
  assert.equal(await runPreflight(o, { yes: false }), true);
  assert.match(text(o), /FAIL.*Codex sign-in/);
  assert.match(text(o), /Fix: codex login/);
  assert.match(text(o), /Codex sign-in \(re-checked\)/);
  const calls = codex.log().map((a) => a.join(" "));
  assert.ok(calls.includes("login"), "the fix ran");
  assert.equal(calls.filter((c) => c === "login status").length, 2, "re-checked");
});

test("a fix never runs without a yes: declined at the prompt, or no TTY and no --yes", async () => {
  for (const o of [io([false]), io([], { isTTY: false })]) {
    healthy();
    const codex = makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { code: 1, stdout: "Not logged in\n" }, login: { code: 0 } });
    assert.equal(await runPreflight(o, { yes: false }), false);
    assert.ok(!codex.log().some((a) => a.join(" ") === "login"), "fix must not run");
  }
});

test("--yes runs the fix without asking", async () => {
  healthy();
  const codex = makeFakeBin(bin, "codex", {
    "--version": { stdout: "codex-cli 0.157.1\n" },
    "login status": [{ code: 1 }, { code: 0 }],
    login: { code: 0 }
  });
  const o = io([]);
  assert.equal(await runPreflight(o, { yes: true }), true);
  assert.deepEqual(o.asked, []);
  assert.ok(codex.log().some((a) => a.join(" ") === "login"));
});

test("--yes without a TTY runs a non-interactive fix without asking", async () => {
  healthy();
  const claude = makeFakeBin(bin, "claude", {
    "--version": { stdout: claudeVersion },
    "plugin list --json": [{ stdout: "[]\n" }, { stdout: pluginList() }],
    "*": { code: 0 }
  });
  const o = io([], { isTTY: false });
  assert.equal(await runPreflight(o, { yes: true }), true);
  assert.deepEqual(o.asked, []);
  assert.ok(claude.log().some((a) => a[0] === "plugin" && a[1] === "install"));
});

test("interactive fix (codex login) never runs without a TTY, even with --yes", async () => {
  healthy();
  const codex = makeFakeBin(bin, "codex", { "--version": { stdout: "codex-cli 0.157.1\n" }, "login status": { code: 1, stdout: "Not logged in\n" }, login: { code: 0 } });
  const o = io([], { isTTY: false });
  assert.equal(await runPreflight(o, { yes: true }), false);
  assert.match(text(o), /Fix: codex login/);
  assert.ok(!codex.log().some((a) => a.join(" ") === "login"), "login must not be invoked headlessly");
  assert.deepEqual(o.asked, []);
});

test("a failed fix shows its reason before the re-check", async () => {
  healthy();
  makeFakeBin(bin, "claude", {
    "--version": { stdout: claudeVersion },
    "plugin list --json": { stdout: "[]\n" },
    "plugin marketplace add openai/codex-plugin-cc": { code: 1 }
  });
  const o = io([true]);
  assert.equal(await runPreflight(o, { yes: false }), false);
  assert.match(text(o), /fix failed \(exit 1\)[\s\S]*Codex plugin for Claude Code \(re-checked\)/);
});

test("a fix whose tool cannot run shows the failure class, not a bare re-check", async () => {
  healthy();
  fs.rmSync(path.join(bin, "codex"));
  const o = io([true]);
  assert.equal(await runPreflight(o, { yes: false }), false);
  assert.match(text(o), /Fix: brew install --cask codex\n\s+not installed\n/);
});

test("a throwing check is a FAIL row with its code; later items still report", async () => {
  healthy();
  fs.rmSync(path.join(bin, "claude"));
  const o = io([false]);
  assert.equal(await runPreflight(o, { yes: false }), false);
  const t = text(o);
  assert.match(t, /FAIL\s+Claude Code — not installed/);
  assert.match(t, /FAIL\s+Codex plugin for Claude Code — tool_failed \(missing\)/);
  assert.match(t, /GitHub CLI/);
  assert.match(t, /OK\s+Codex CLI/);
});

test("T-SET-4: gh missing → WARN only, preflight still passes", async () => {
  healthy();
  makeFakeBin(bin, "gh", { "*": { code: 127 } });
  const o = io();
  assert.equal(await runPreflight(o, { yes: false }), true);
  assert.match(text(o), /WARN\s+GitHub CLI/);
  assert.match(text(o), /not installed/);
});

test("claude older than MIN_CLAUDE fails with both versions named", async () => {
  healthy();
  makeFakeBin(bin, "claude", { "--version": { stdout: "1.0.0 (Claude Code)\n" } });
  const r = await item("claude").check();
  assert.equal(r.status, "fail");
  assert.match(r.note, new RegExp(`1\\.0\\.0 is older than ${MIN_CLAUDE.replace(/\./g, "\\.")}`));
});

test("L9: an installed but old Claude Code is fixed with `claude update`, never a second cask install", async () => {
  healthy();
  const claude = makeFakeBin(bin, "claude", { "--version": [{ stdout: "1.0.0 (Claude Code)\n" }, { stdout: claudeVersion }], "plugin list --json": { stdout: pluginList() }, update: { code: 0 } });
  const brew = makeFakeBin(bin, "brew", { "*": { code: 0 } });
  const o = io();
  assert.equal(await runPreflight(o, { yes: true }), true, text(o));
  assert.match(text(o), /Fix: claude update\n/);
  assert.ok(claude.log().some((a) => a.join(" ") === "update"), "claude update ran");
  assert.deepEqual(brew.log(), [], "brew was never run");
  makeFakeBin(bin, "claude", { "--version": { code: 127 } });
  const missing = io();
  await runPreflight(missing, { yes: false });
  assert.match(text(missing), /Fix: brew install --cask claude-code\n/, "not installed keeps the cask install");
});

test("a check that throws an uncoded error is a FAIL row naming unexpected_error (the registered code)", async () => {
  healthy();
  const gh = item("gh");
  const saved = gh.check;
  gh.check = async () => { throw new Error("boom"); };
  try {
    const o = io();
    await runPreflight(o, { yes: false });
    assert.match(text(o), /FAIL\s+GitHub CLI[^\n]* — unexpected_error\n/);
  } finally {
    gh.check = saved;
  }
});

test("[RF-4] claude plugin list with warning lines before the JSON still parses", async () => {
  healthy();
  makeFakeBin(bin, "claude", { "--version": { stdout: claudeVersion }, "plugin list --json": { stdout: pluginList("Warning: marketplace cache stale\n") } });
  assert.equal((await item("codex_plugin").check()).status, "pass");
});

test("[RF-4 negative] non-JSON claude plugin list output → claude_cli_unparseable", async () => {
  healthy();
  makeFakeBin(bin, "claude", { "--version": { stdout: claudeVersion }, "plugin list --json": { stdout: "Error: something went wrong\nnot json\n" } });
  await assert.rejects(item("codex_plugin").check(), { code: "claude_cli_unparseable" });
});

test("a claude plugin list that cannot run is tool_failed, not a missing plugin", async () => {
  healthy();
  fs.rmSync(path.join(bin, "claude"));
  await assert.rejects(item("codex_plugin").check(), { code: "tool_failed", detail: "missing" });
});

test("a Codex binary that exists but cannot execute is not reported as not installed", async () => {
  healthy();
  fs.chmodSync(path.join(bin, "codex"), 0o644);
  const r = await item("codex_cli").check();
  assert.equal(r.status, "fail");
  assert.equal(r.note, "could not run (spawn_failed)");
  const auth = await item("codex_auth").check();
  assert.equal(auth.note, "could not run (spawn_failed)");
});

test("a missing Codex binary is reported as not installed", async () => {
  healthy();
  fs.rmSync(path.join(bin, "codex"));
  assert.equal((await item("codex_cli").check()).note, "not installed");
});

test("runTool keeps the failure class", async () => {
  assert.equal((await runTool("rl-definitely-missing-xyz", [])).failure, "missing");
  assert.equal((await runTool(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 200 })).failure, "timeout");
  assert.equal((await runTool(process.execPath, ["-e", "process.stdout.write('x'.repeat(17 * 1024 * 1024))"])).failure, "output_too_large");
  const ran = await runTool(process.execPath, ["-e", "process.exit(3)"]);
  assert.deepEqual([ran.failure, ran.code], [null, 3]);
});

test("runTool with inherited stdio reports a signal-killed tool as spawn_failed", async () => {
  const killed = await runTool(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { stdio: "inherit" });
  assert.deepEqual([killed.failure, killed.code], ["spawn_failed", null]);
  assert.equal((await runTool(process.execPath, ["-e", "process.exit(0)"], { stdio: "inherit" })).failure, null);
  assert.equal((await runTool("rl-definitely-missing-xyz", [], { stdio: "inherit" })).failure, "missing");
});

test("noteFor distinguishes a timeout from a missing tool", () => {
  assert.equal(noteFor({ code: null, stdout: "", stderr: "", failure: "missing" }, "x"), "not installed");
  assert.match(noteFor({ code: null, stdout: "", stderr: "", failure: "timeout" }, "x"), /^timed out/);
  assert.equal(noteFor({ code: null, stdout: "", stderr: "", failure: "output_too_large" }, "x"), "could not run (output_too_large)");
  assert.equal(noteFor({ code: null, stdout: "", stderr: "", failure: "spawn_failed" }, "x"), "could not run (spawn_failed)");
  assert.equal(noteFor({ code: 1, stdout: "", stderr: "", failure: null }, "not signed in"), "not signed in");
});

test("requireRan: a failed claude plugin list is tool_failed, never an empty plugin list", () => {
  assert.throws(() => requireRan({ code: null, stdout: "", stderr: "", failure: "timeout" }, "claude plugin list"), { code: "tool_failed", detail: "timeout" });
  assert.doesNotThrow(() => requireRan({ code: 0, stdout: "[]", stderr: "", failure: null }, "claude plugin list"));
});
