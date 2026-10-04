import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { main, COMMANDS } from "../../cli/review-loop.mjs";

const BIN = path.join(process.cwd(), "cli", "review-loop.mjs");
const NAMES = /** @type {Array<keyof typeof COMMANDS>} */ (Object.keys(COMMANDS));

/** @returns {{ outs: string[], errs: string[] } & import("../../cli/lib/io.mjs").IO} */
const io = () => ({ isTTY: true, color: false, outs: [], errs: [], out(s) { this.outs.push(s); }, err(s) { this.errs.push(s); }, ask: async () => true, choose: async (_q, _o, d) => d, env: process.env });

/**
 * Runs main() with every command's loader replaced by one that fails the test: a help or usage error must be decided
 * before a command loads, so it never prompts, locks, writes or calls a tool.
 * @param {string[]} argv
 */
async function withoutLoading(argv) {
  const saved = NAMES.map((n) => COMMANDS[n].load);
  /** @type {string[]} */
  const loaded = [];
  for (const n of NAMES) COMMANDS[n].load = /** @type {never} */ (async () => { loaded.push(n); throw new Error(`${n} loaded`); });
  const state = tmpDir("rl-help-");
  const prev = process.env.REVIEW_LOOP_STATE_DIR;
  process.env.REVIEW_LOOP_STATE_DIR = state;
  try {
    const o = io();
    const code = await main(argv, o);
    const events = fs.readFileSync(path.join(state, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { code, out: o.outs.join(""), err: o.errs.join(""), loaded, event: events.at(-1) };
  } finally {
    NAMES.forEach((n, i) => { COMMANDS[n].load = /** @type {never} */ (saved[i]); });
    if (prev === undefined) delete process.env.REVIEW_LOOP_STATE_DIR; else process.env.REVIEW_LOOP_STATE_DIR = prev;
  }
}

test("every command's --help and -h print its usage and options on stdout, exit 0, and never run it", async () => {
  for (const name of NAMES) for (const flag of ["--help", "-h"]) {
    // --yes and a real option alongside: help still wins, so `setup --yes --help` can't start a billed review.
    const r = await withoutLoading([name, "--yes", ...COMMANDS[name].options.filter((o) => o.name !== "--json" && o.name !== "--yes").slice(0, 1).flatMap((o) => (o.value ? [o.name, "x"] : [o.name])), flag]);
    assert.equal(r.code, 0, `${name} ${flag}: ${r.err}`);
    assert.deepEqual(r.loaded, [], `${name} ${flag} loaded the command`);
    assert.ok(r.out.startsWith(`Usage: review-loop ${name}`), `${name} ${flag}: ${r.out.slice(0, 80)}`);
    for (const o of COMMANDS[name].options) assert.ok(r.out.includes(`  ${o.name}`), `${name} --help lists ${o.name}`);
    assert.ok(r.out.includes(COMMANDS[name].example), `${name} --help shows its example`);
    assert.ok(r.out.split("\n").every((l) => l.length <= 120), `${name} --help fits a terminal`);
    assert.equal(r.event.code, "ok");
    assert.equal(r.event.data.command, name);
  }
});

test("--help with --json: stdout is only the event, the help goes to stderr", async () => {
  const r = await withoutLoading(["doctor", "--help", "--json"]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim().split("\n").length, 1);
  assert.equal(JSON.parse(r.out).code, "ok");
  assert.ok(r.err.startsWith("Usage: review-loop doctor"));
});

test("a flag a command doesn't take is usage_bad_flag (exit 2), names the flag and the command's options, and never runs it", async () => {
  // config's words are its own (a model name may start with "-"): config refuses them itself, tested below.
  for (const name of NAMES.filter((n) => COMMANDS[n].operands === 0)) {
    const r = await withoutLoading([name, "--frobnicate"]);
    assert.equal(r.code, 2, name);
    assert.deepEqual(r.loaded, [], `${name} loaded the command`);
    assert.equal(r.event.code, "usage_bad_flag");
    assert.match(r.err, new RegExp(`${name} doesn't take --frobnicate \\(it takes ${COMMANDS[name].options.map((o) => o.name).join(", ")}\\)`));
  }
});

test("a typo'd flag never runs the command: setup --skip-live-chek --yes is refused before any install or billed review", async () => {
  const r = await withoutLoading(["setup", "--skip-live-chek", "--yes"]);
  assert.equal(r.code, 2);
  assert.deepEqual(r.loaded, []);
  assert.match(r.err, /setup doesn't take --skip-live-chek/);
  const u = await withoutLoading(["uninstall", "--delete-hisotry", "--yes"]);
  assert.equal(u.code, 2);
  assert.deepEqual(u.loaded, []);
});

test("an option missing its value, and a plain word a command doesn't take, are usage_bad_flag", async () => {
  for (const argv of [["setup", "--preset"], ["setup", "--model", "--skip-live-check"], ["doctor", "live"], ["update", "now"], ["config", "set", "preset", "balanced", "extra"]]) {
    const r = await withoutLoading(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(r.event.code, "usage_bad_flag", argv.join(" "));
    assert.deepEqual(r.loaded, [], argv.join(" "));
  }
  const v = await withoutLoading(["setup", "--model"]);
  assert.match(v.err, /--model needs a value: --model <name>/);
});

test("an option's value is not mistaken for a flag: setup --model -x reaches setup", async () => {
  const r = await withoutLoading(["setup", "--model", "-x", "--preset", "balanced", "--skip-live-check"]);
  assert.deepEqual(r.loaded, ["setup"], "valid options pass the check and load setup");
});

test("config show and config repair take no other words", async () => {
  const s = tmpDir("rl-help-cfg-");
  const env = { ...process.env, HOME: s, REVIEW_LOOP_STATE_DIR: path.join(s, "state"), REVIEW_LOOP_CONFIG: path.join(s, "cfg.json"), CLAUDECODE: "" };
  for (const sub of ["show", "repair"]) {
    const r = spawnSync(process.execPath, [BIN, "config", sub, "--frobnicate"], { env, encoding: "utf8" });
    assert.equal(r.status, 2, `config ${sub}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`config ${sub} takes no other words`));
  }
  assert.ok(!fs.existsSync(path.join(s, "cfg.json")), "repair wrote nothing");
});

test("the real binary: no command's --help calls a tool (fake claude, codex, gh and brew on PATH record any call)", () => {
  const s = tmpDir("rl-help-bin-");
  const bin = path.join(s, "bin");
  fs.mkdirSync(bin);
  const log = path.join(s, "calls");
  for (const tool of ["claude", "codex", "gh", "brew"]) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: s, REVIEW_LOOP_STATE_DIR: path.join(s, "state"), REVIEW_LOOP_CONFIG: path.join(s, "cfg.json"), CLAUDECODE: "" };
  for (const name of NAMES) {
    const r = spawnSync(process.execPath, [BIN, name, "--help"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
  assert.ok(!fs.existsSync(log), `--help called a tool: ${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""}`);
});

test("the top-level help points at per-command help", async () => {
  const r = await withoutLoading(["--help"]);
  assert.match(r.out, /Run `review-loop <command> --help` for a command's options\./);
});
