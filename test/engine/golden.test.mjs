import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpDir, makeRepo, commitFile, writeFile, g } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORD = process.env.REVIEW_LOOP_GOLDEN === "record";
// Recording points at the verbatim legacy engine (commit 0a4134b); comparing always targets the engine in this tree.
const HOOK = RECORD && process.env.REVIEW_LOOP_GOLDEN_ENGINE ? path.join(process.env.REVIEW_LOOP_GOLDEN_ENGINE, "review-gate-hook.mjs") : path.join(HERE, "..", "..", "plugin", "engine", "review-gate-hook.mjs");
const ENGINE = path.dirname(HOOK);
const DIR = path.join(HERE, "..", "fixtures", "golden");
const GH = "g" + "h";

// The stub mutates PATH at module load, so it is copied here rather than imported from prgate.test.mjs.
const binDir = tmpDir("rl-bin-");
fs.writeFileSync(
  path.join(binDir, "gh"),
  `#!/usr/bin/env node
const fs = require("fs");
const key = process.argv.slice(2).join(" ");
fs.appendFileSync(process.env.STUB_GH_LOG, key + "\\n");
const map = JSON.parse(fs.readFileSync(process.env.STUB_GH_FILE, "utf8"));
const hit = map[key] ?? { code: 1, stderr: "gh: HTTP 404: Not Found" };
if (hit.stdout) process.stdout.write(hit.stdout + "\\n");
if (hit.stderr) process.stderr.write(hit.stderr + "\\n");
process.exitCode = hit.code ?? 0;
`,
  { mode: 0o755 }
);
// The session hook prints a notice when the review-loop CLI is not on PATH; goldens record the engine, not that notice.
fs.writeFileSync(path.join(binDir, "review-loop"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.PATH = `${binDir}:${process.env.PATH}`;

/** @param {Record<string, { stdout?: string, code?: number, stderr?: string }>} map */
function stubGh(map) {
  const dir = tmpDir("rl-ghmap-");
  process.env.STUB_GH_FILE = path.join(dir, "map.json");
  process.env.STUB_GH_LOG = path.join(dir, "log.txt");
  fs.writeFileSync(process.env.STUB_GH_FILE, JSON.stringify(map));
  fs.writeFileSync(process.env.STUB_GH_LOG, "");
}

/** @param {string} home */
function envFor(home) {
  return { ...process.env, HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") };
}

/** @param {string} mode @param {Record<string, unknown>} input @param {NodeJS.ProcessEnv} env */
function hook(mode, input, env) {
  return spawnSync(process.execPath, [HOOK, mode], { env, input: JSON.stringify(input), encoding: "utf8" }).stdout;
}

/** macOS temp dirs appear both as /private/var/... (realpath) and /var/... (unresolved). @param {string} p */
const variants = (p) => [...new Set([p, p.replace(/^\/private(?=\/)/, "")])];

/**
 * Known SHAs get their own labels before the generic rule, so a base/head swap cannot hide behind a shared <SHA>.
 * @param {string} s @param {string[]} dirs @param {Array<[string, string]>} shas
 */
function normalize(s, dirs, shas) {
  let out = s.split(ENGINE).join("<ENGINE>");
  for (const [label, sha] of shas) out = out.replace(new RegExp(`\\b${sha.slice(0, 7)}[0-9a-f]{0,33}\\b`, "g"), label);
  for (const [label, p] of dirs.map((/** @type {string} */ d) => d.split("=", 2)).map(([l, p]) => [l, p])) {
    for (const v of variants(p)) out = out.split(v).join(label);
  }
  return out
    .replaceAll("review-loop:review-loop skill", "review-loop skill")
    .replace(/\b[0-9a-f]{24}\b/g, "<KEY>")
    .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, "<SHA>");
}

function corpus() {
  /** @type {Record<string, string>} */
  const out = {};
  /** @param {string} name @param {string} repoDir @param {Array<[string, Record<string, unknown> | (() => Record<string, unknown>)]>} steps @param {Array<[string, string]>} [shas] */
  const run = (name, repoDir, steps, shas = []) => {
    const home = tmpDir();
    const env = envFor(home);
    let last = "";
    for (const [mode, input] of steps) last = hook(mode, { session_id: `s-${name}`, cwd: repoDir, ...(typeof input === "function" ? input() : input) }, env);
    out[name] = normalize(last, [`<REPO>=${repoDir}`, `<HOME>=${home}`], shas);
  };
  const fresh = () => {
    const r = makeRepo();
    commitFile(r, "README.md", "x");
    return r;
  };
  // The spec is written when the track step runs, i.e. after the session snapshot, or it would count as pre-existing.
  const track = (/** @type {string} */ r) => /** @type {[string, () => Record<string, unknown>]} */ (["track", () => ({ tool_input: { file_path: writeFile(r, "docs/specs/x-design.md", "# x\n") } })]);
  const stopSteps = (/** @type {string} */ r, /** @type {boolean} */ active) => [["session", {}], track(r), ["stop", { stop_hook_active: active }]];
  let r = fresh();
  run("session", r, [["session", {}]]);
  r = fresh();
  run("stop-clean", r, [["session", {}], ["stop", { stop_hook_active: false }]]);
  r = fresh();
  run("stop-pending-spec", r, stopSteps(r, false));
  r = fresh();
  run("stop-active", r, stopSteps(r, true));
  r = fresh();
  run("prompt-pending", r, [...stopSteps(r, false), ["prompt", { prompt: "hi" }]]);
  r = fresh();
  run("pr-nonpr", r, [["pr", { tool_name: "Bash", tool_input: { command: "ls" } }]]);

  const uni = makeRepo(tmpDir("rl sp ü-"));
  commitFile(uni, "README.md", "x");
  run("stop-pending-unicode", uni, [["session", {}], ["track", () => ({ tool_input: { file_path: writeFile(uni, "docs/specs/ünï code-design.md", "# u\n") } })], ["stop", { stop_hook_active: false }]]);

  const pr = makeRepo();
  const base = commitFile(pr, "a.txt", "1");
  g(pr, "checkout", "-q", "-b", "feature");
  const head = commitFile(pr, "f.txt", "feat");
  g(pr, "remote", "add", "origin", "https://github.com/me/proj.git");
  g(pr, "config", "branch.feature.remote", "origin");
  stubGh({
    "repo set-default --view": { code: 1, stderr: "no default repository has been set" },
    "api repos/me/proj/git/ref/heads/main --jq .object.sha": { stdout: base },
    "api repos/me/proj/git/ref/heads/feature --jq .object.sha": { stdout: head }
  });
  run("pr-pending", pr, [["session", {}], ["pr", { tool_name: "Bash", tool_input: { command: `${GH} pr create --base main` } }]], [["<BASE>", base], ["<HEAD>", head]]);
  return out;
}

test("T-CFG-2: Default preset hook output is byte-equal to the recorded pre-preset engine", () => {
  const got = corpus();
  if (RECORD) {
    fs.mkdirSync(DIR, { recursive: true });
    for (const [k, v] of Object.entries(got)) fs.writeFileSync(path.join(DIR, `${k}.json`), JSON.stringify(v));
    return;
  }
  assert.equal(fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).length, Object.keys(got).length, "every fixture has a case and vice versa");
  for (const [k, v] of Object.entries(got)) assert.equal(v, JSON.parse(fs.readFileSync(path.join(DIR, `${k}.json`), "utf8")), k);
});
