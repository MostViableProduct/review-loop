import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { SABOTAGES } from "../../scripts/sabotage-registry.mjs";
import { applyEdits, checkTarget, classify, EXIT_INTERRUPTED, nodeTest, readSame, runSabotage, writeSame } from "../../scripts/sabotage.mjs";
import { isRealPid, signalPid } from "../fakes/signal.mjs";

test("every sabotage applies exactly once and names an existing test", () => {
  const ids = new Set();
  for (const s of SABOTAGES) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`); ids.add(s.id);
    const src = fs.readFileSync(s.file, "utf8");
    for (const e of [{ find: s.find, replace: s.replace }, ...(s.also ? [s.also] : [])]) {
      assert.equal(src.split(e.find).length - 1, 1, `${s.id}: find ${JSON.stringify(e.find.slice(0, 40))} must match exactly once in ${s.file}`);
      assert.notEqual(e.find, e.replace, `${s.id}: a replace equal to its find breaks nothing`);
    }
    assert.ok(!("error" in applyEdits(fs.readFileSync(s.file), s)), `${s.id}: its edits apply (no overlap)`);
    assert.ok(fs.existsSync(s.test), `${s.id}: ${s.test} exists`);
  }
});

test("every row's expect names a test that exists in its test file", () => {
  for (const s of SABOTAGES) {
    assert.ok(typeof s.expect === "string" && s.expect.length > 0, `${s.id}: expect`);
    assert.ok(fs.readFileSync(s.test, "utf8").includes(s.expect), `${s.id}: "${s.expect}" appears in ${s.test}`);
  }
});

test("checkTarget: links, hard links, non-files, oversized and out-of-repo paths are refused before any read", () => {
  const root = tmpDir();
  const outside = path.join(tmpDir(), "secret.txt");
  fs.writeFileSync(outside, "do not touch");
  fs.symlinkSync(outside, path.join(root, "link.mjs"));
  fs.linkSync(outside, path.join(root, "hard.mjs"));
  fs.mkdirSync(path.join(root, "dir.mjs"));
  fs.writeFileSync(path.join(root, "big.mjs"), "x".repeat(1024 * 1024 + 1));
  fs.writeFileSync(path.join(root, "ok.mjs"), "ok");
  fs.symlinkSync(path.dirname(outside), path.join(root, "linkdir"));
  fs.writeFileSync(path.join(path.dirname(outside), "in-linked-dir.mjs"), "x");
  for (const rel of ["link.mjs", "hard.mjs", "dir.mjs", "big.mjs", "../escape.mjs", "missing.mjs", "linkdir/in-linked-dir.mjs"]) assert.throws(() => checkTarget(root, rel), /refusing/, rel);
  assert.equal(checkTarget(root, "ok.mjs").abs, path.join(root, "ok.mjs"));
  assert.equal(fs.readFileSync(outside, "utf8"), "do not touch");
});

test("writeSame/readSame: a path swapped after the check is refused and the outside file is untouched", () => {
  const root = tmpDir();
  const outside = path.join(tmpDir(), "outside.mjs");
  fs.writeFileSync(outside, "outside");
  fs.writeFileSync(path.join(root, "g.mjs"), "inside");
  const t = checkTarget(root, "g.mjs");
  assert.equal(readSame(t).toString(), "inside");
  writeSame(t, Buffer.from("changed"));
  assert.equal(fs.readFileSync(path.join(root, "g.mjs"), "utf8"), "changed");
  fs.rmSync(path.join(root, "g.mjs"));
  fs.symlinkSync(outside, path.join(root, "g.mjs"));
  assert.throws(() => writeSame(t, Buffer.from("pwned")));
  fs.rmSync(path.join(root, "g.mjs"));
  fs.writeFileSync(path.join(root, "g.mjs"), "replacement");
  assert.throws(() => writeSame(t, Buffer.from("pwned")), /changed after it was checked/);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.equal(fs.readFileSync(path.join(root, "g.mjs"), "utf8"), "replacement");
});

test("classify: only the named test failing counts as red", () => {
  assert.equal(classify(0, "ok 1 - T-OBS-1: a written line", "T-OBS-1"), "stayed_green");
  assert.equal(classify(1, "not ok 1 - T-OBS-1: a written line is schema v1", "T-OBS-1"), "red");
  assert.equal(classify(1, "    not ok 3 - (8a) descriptor opened before", "(8a)"), "red");
  assert.equal(classify(1, "not ok 1 - test/contract/events.test.mjs\n  SyntaxError: Unexpected token", "T-OBS-1"), "wrong_failure");
  assert.equal(classify(1, "not ok 2 - T-OBS-4: validated by value", "T-OBS-1"), "wrong_failure");
  assert.equal(classify(null, "", "T-OBS-1"), "wrong_failure", "a killed or timed-out run is not red");
});

test("applyEdits: an `also` edit is applied with the first; a missing or overlapping second find is refused", () => {
  const src = Buffer.from("const a = 1; const b = 2;\n");
  const s = { id: "x", file: "f.mjs", find: "a = 1", replace: "a = 0", also: { find: "b = 2", replace: "b = 0" }, test: "t", expect: "e" };
  const r = applyEdits(src, s);
  assert.ok("broken" in r && r.broken.toString() === "const a = 0; const b = 0;\n");
  assert.match(String(Reflect.get(applyEdits(src, { ...s, also: { find: "c = 3", replace: "" } }), "error")), /matches 0 times/);
  assert.match(String(Reflect.get(applyEdits(src, { ...s, also: { find: "= 1; const", replace: "" } }), "error")), /overlap/);
});

/**
 * The `paths:` list items under `on.push` and `on.pull_request`, read structurally from the workflow text, so a
 * commented-out entry or a `paths-ignore` entry never counts. Block-style YAML only (the style these files use); a
 * flow list (`paths: [...]`) yields nothing, which fails the tests below rather than passing them.
 * @param {string} text @returns {{ push: string[], pull_request: string[] }}
 */
function triggerPaths(text) {
  /** @type {{ push: string[], pull_request: string[] }} */
  const found = { push: [], pull_request: [] };
  /** @type {Array<{ indent: number, key: string }>} */
  const stack = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (t === "" || t.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const item = /^-\s+(?:"([^"]*)"|'([^']*)'|([^\s#"']+))\s*(?:#.*)?$/.exec(t);
    if (item) {
      while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) > indent) stack.pop();
      const keys = stack.map((k) => k.key).join(".");
      const value = item[1] ?? item[2] ?? item[3];
      if (keys === "on.push.paths") found.push.push(value);
      if (keys === "on.pull_request.paths") found.pull_request.push(value);
      continue;
    }
    const key = /^([A-Za-z_][\w-]*):(?:\s|$)/.exec(t);
    if (!key) continue;
    while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= indent) stack.pop();
    stack.push({ indent, key: key[1] });
  }
  return found;
}

test("triggerPaths: only real list items under on.push/on.pull_request paths count", () => {
  const wf = [
    "on:",
    "  push:",
    "    branches: [main]",
    "    paths:",
    "      - \"a.mjs\"",
    "      # - \"commented.mjs\"",
    "      - b.mjs  # trailing comment",
    "    paths-ignore:",
    "      - \"ignored.mjs\"",
    "  pull_request:",
    "    paths:",
    "    - 'c.mjs'",
    "jobs:",
    "  x:",
    "    paths:",
    "      - \"not-a-trigger.mjs\"",
    "    steps:",
    "      - run: echo hi"
  ].join("\n");
  assert.deepEqual(triggerPaths(wf), { push: ["a.mjs", "b.mjs"], pull_request: ["c.mjs"] });
});

test("every guarded file AND its gate test trigger the sabotage workflow, on push and on pull_request", () => {
  const found = triggerPaths(fs.readFileSync(".github/workflows/sabotage.yml", "utf8"));
  const need = ["scripts/sabotage.mjs", "scripts/sabotage-registry.mjs", ...SABOTAGES.flatMap((s) => [s.file, s.test])];
  for (const ev of /** @type {const} */ (["push", "pull_request"])) {
    for (const f of need) assert.ok(found[ev].includes(f), `${f} is listed in sabotage.yml on.${ev}.paths (a weakened test must re-prove its gate)`);
  }
});

// The runner's own failure modes, on a throwaway repo with the real `node --test` (never on repo files).
const GATE = "export const LIMIT = 3;\n";
const GATE_TEST = [
  "import test from \"node:test\";",
  "import assert from \"node:assert/strict\";",
  "import { LIMIT } from \"./gate.mjs\";",
  "test(\"G-1: the limit is three\", () => assert.equal(LIMIT, 3));",
  "test(\"G-2: unrelated\", () => assert.ok(true));",
  ""
].join("\n");

function fixture() {
  const root = tmpDir("rl-sab-");
  fs.writeFileSync(path.join(root, "gate.mjs"), GATE);
  fs.writeFileSync(path.join(root, "gate.test.mjs"), GATE_TEST);
  fs.writeFileSync(path.join(root, "red.test.mjs"), "import test from \"node:test\";\ntest(\"R-1: always red\", () => { throw new Error(\"red\"); });\n");
  /** @type {string[]} */
  const lines = [];
  return { root, lines, out: (/** @type {string} */ s) => { lines.push(s); }, text: () => lines.join(""), gate: () => fs.readFileSync(path.join(root, "gate.mjs"), "utf8") };
}

/** @param {Partial<{ id: string, find: string, replace: string, test: string, expect: string }>} over */
const row = (over) => ({ id: "limit", file: "gate.mjs", find: "LIMIT = 3", replace: "LIMIT = 4", test: "gate.test.mjs", expect: "G-1", ...over });
/** A canned test run: exit `status`, the named test failing when it is not 0. @param {number} status */
const ran = (status) => ({ status, signal: null, timedOut: false, stdout: status === 0 ? "ok 1 - G-1" : "not ok 1 - G-1", stderr: "" });

test("runner: a break that makes the named test fail is red; exit 0 and the file is restored byte for byte", async () => {
  const f = fixture();
  assert.equal(await runSabotage({ root: f.root, rows: [row({})], out: f.out }), 0, f.text());
  assert.match(f.text(), /^red \(expected\) {2}limit$/m);
  assert.match(f.text(), /every break went red/);
  assert.equal(f.gate(), GATE);
});

test("runner: an `also` edit lands with the first, so a gate enforced twice goes red; both are restored", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "gate.mjs"), "export const A = 1;\nexport const B = 2;\n");
  fs.writeFileSync(path.join(f.root, "twice.test.mjs"), "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { A, B } from \"./gate.mjs\";\ntest(\"T-2: either check holds\", () => assert.ok(A === 1 || B === 2));\n");
  const one = { id: "one", file: "gate.mjs", find: "A = 1", replace: "A = 0", test: "twice.test.mjs", expect: "T-2" };
  assert.equal(await runSabotage({ root: f.root, rows: [one], out: f.out }), 1, "one edit alone stays green");
  assert.equal(await runSabotage({ root: f.root, rows: [{ ...one, id: "both", also: { find: "B = 2", replace: "B = 0" } }], out: f.out }), 0, f.text());
  assert.match(f.text(), /^red \(expected\) {2}both$/m);
  assert.equal(f.gate(), "export const A = 1;\nexport const B = 2;\n");
});

test("runner (−): a row that stays green exits 1 and names the row", async () => {
  const f = fixture();
  assert.equal(await runSabotage({ root: f.root, rows: [row({ id: "noop", replace: "LIMIT = 3" })], out: f.out }), 1);
  assert.match(f.text(), /^STAYED_GREEN {2}noop$/m);
  assert.match(f.text(), /did not prove their gate: noop \(stayed_green\)/);
  assert.equal(f.gate(), GATE);
});

test("runner (−): a red baseline exits 1 and the break is never applied", async () => {
  const f = fixture();
  /** @type {string[]} */
  const seen = [];
  const runTest = (/** @type {string} */ root, /** @type {string} */ t) => { seen.push(f.gate()); return nodeTest(root, t); };
  assert.equal(await runSabotage({ root: f.root, rows: [row({ id: "base", test: "red.test.mjs", expect: "R-1" })], out: f.out, runTest }), 1);
  assert.match(f.text(), /^BASELINE RED {2}base$/m);
  assert.match(f.text(), /base \(baseline red\)/);
  assert.deepEqual(seen, [GATE], "only the baseline ran; the break was never written");
});

test("runner (−): a break that fails the file for another reason (syntax error) is a wrong failure, exit 1", async () => {
  const f = fixture();
  assert.equal(await runSabotage({ root: f.root, rows: [row({ id: "syntax", replace: "LIMIT = ((" })], out: f.out }), 1);
  assert.match(f.text(), /^WRONG_FAILURE {2}syntax$/m);
  assert.equal(f.gate(), GATE);
});

test("runner (−): a break that fails a different test than the named one is a wrong failure, exit 1", async () => {
  const f = fixture();
  assert.equal(await runSabotage({ root: f.root, rows: [row({ id: "other", expect: "G-2" })], out: f.out }), 1);
  assert.match(f.text(), /^WRONG_FAILURE {2}other$/m);
});

test("runner (−): a link swapped in after the break is applied is refused, never written; exit 1 names the file", async () => {
  const f = fixture();
  const outside = path.join(tmpDir(), "outside.mjs");
  fs.writeFileSync(outside, "outside\n");
  let calls = 0;
  const runTest = () => {
    if (++calls === 2) {
      fs.rmSync(path.join(f.root, "gate.mjs"));
      fs.symlinkSync(outside, path.join(f.root, "gate.mjs"));
    }
    return ran(calls === 1 ? 0 : 1);
  };
  assert.equal(await runSabotage({ root: f.root, rows: [row({})], out: f.out, runTest }), 1);
  assert.match(f.text(), /^FAIL restore gate\.mjs: /m);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside\n", "the restore never wrote through the link");
  assert.ok(fs.lstatSync(path.join(f.root, "gate.mjs")).isSymbolicLink());
});

test("runner (−): a file swapped before the break is applied is reported as identity-changed and never written", async () => {
  for (const swap of ["link", "rename"]) {
    const f = fixture();
    const outside = path.join(tmpDir(), "outside.mjs");
    fs.writeFileSync(outside, "outside\n");
    const runTest = () => {
      fs.rmSync(path.join(f.root, "gate.mjs"));
      if (swap === "link") fs.symlinkSync(outside, path.join(f.root, "gate.mjs"));
      else fs.writeFileSync(path.join(f.root, "gate.mjs"), "export const LIMIT = 3; // replaced\n");
      return ran(0);
    };
    assert.equal(await runSabotage({ root: f.root, rows: [row({})], out: f.out, runTest }), 1, swap);
    assert.match(f.text(), /^FAIL identity-changed gate\.mjs: /m, swap);
    assert.doesNotMatch(f.text(), /FAIL restore/, swap);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside\n", swap);
    if (swap === "rename") assert.equal(f.gate(), "export const LIMIT = 3; // replaced\n", "the replacement file is untouched");
  }
});

test("runner: a hard link gained DURING the test run doesn't block the restore; the original bytes go back, with a WARN", async () => {
  const f = fixture();
  const other = path.join(tmpDir(), "linked.mjs");
  let calls = 0;
  const runTest = () => { if (++calls === 2) fs.linkSync(path.join(f.root, "gate.mjs"), other); return ran(calls === 1 ? 0 : 1); };
  assert.equal(await runSabotage({ root: f.root, rows: [row({})], out: f.out, runTest }), 0, f.text());
  assert.equal(f.gate(), GATE);
  assert.equal(fs.readFileSync(other, "utf8"), GATE, "the other name holds the original bytes again too");
  assert.match(f.text(), /^WARN gate\.mjs gained 1 hard link\(s\) during the run/m);
});

test("runner (−): a hard link gained BEFORE the break is written is identity-changed; the break is never written", async () => {
  const f = fixture();
  const other = path.join(tmpDir(), "linked.mjs");
  const runTest = () => { fs.linkSync(path.join(f.root, "gate.mjs"), other); return ran(0); };
  assert.equal(await runSabotage({ root: f.root, rows: [row({})], out: f.out, runTest, linkWaitMs: 300 }), 1);
  assert.match(f.text(), /^WAIT gate\.mjs had another hard link/m, "it waited (bounded) before refusing");
  assert.match(f.text(), /^FAIL identity-changed gate\.mjs: .*2 hard links/m);
  assert.equal(fs.readFileSync(other, "utf8"), GATE);
});

test("runner: a transient hard link (a sync tool's upload staging) is waited out, bounded, then the row runs", async () => {
  const f = fixture();
  const other = path.join(tmpDir(), "staged.mjs");
  let calls = 0;
  const runTest = () => {
    if (++calls === 1) { fs.linkSync(path.join(f.root, "gate.mjs"), other); setTimeout(() => fs.rmSync(other), 400); }
    return ran(calls === 1 ? 0 : 1);
  };
  assert.equal(await runSabotage({ root: f.root, rows: [row({})], out: f.out, runTest, linkWaitMs: 10_000 }), 0, f.text());
  assert.match(f.text(), /^WAIT gate\.mjs had another hard link/m);
  assert.match(f.text(), /^red \(expected\) {2}limit$/m);
  assert.equal(f.gate(), GATE);
});

test("runner (−): a restore whose bytes don't match the original exits 1 naming the file, and stops the run", async () => {
  const f = fixture();
  let writes = 0;
  const io = { readSame, writeSame: (/** @type {import("../../scripts/sabotage.mjs").Target} */ t, /** @type {Buffer} */ d, /** @type {{ restoring?: boolean }} */ o = {}) => writeSame(t, ++writes === 2 ? Buffer.from("corrupt") : d, o) };
  assert.equal(await runSabotage({ root: f.root, rows: [row({}), row({ id: "second" })], out: f.out, io }), 1);
  assert.match(f.text(), /^FAIL restore gate\.mjs: the bytes differ/m);
  assert.doesNotMatch(f.text(), /second/, "the run stops at the failed restore");
});

test("runner (−): a find that doesn't match exactly once stops the run before anything changes", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, "gate.mjs"), "LIMIT = 3; LIMIT = 3;\n");
  assert.equal(await runSabotage({ root: f.root, rows: [row({})], out: f.out }), 1);
  assert.match(f.text(), /find matches 2 times in gate\.mjs/);
});

test("runner: the break is spliced as bytes, so a `$&` in replace stays literal", async () => {
  const f = fixture();
  /** @type {string[]} */
  const seen = [];
  const runTest = () => { seen.push(f.gate()); return ran(seen.length === 1 ? 0 : 1); };
  assert.equal(await runSabotage({ root: f.root, rows: [row({ replace: "LIMIT = \"$&\"" })], out: f.out, runTest }), 0);
  assert.equal(seen[1], "export const LIMIT = \"$&\";\n");
  assert.equal(f.gate(), GATE);
});

test("runner: a test run ended by a signal is an interrupt, not a verdict; the file is restored and the run stops", async () => {
  const f = fixture();
  let calls = 0;
  const runTest = () => (++calls === 1 ? ran(0) : { ...ran(1), status: null, signal: "SIGINT", stdout: "" });
  assert.equal(await runSabotage({ root: f.root, rows: [row({}), row({ id: "second" })], out: f.out, runTest }), EXIT_INTERRUPTED);
  assert.match(f.text(), /^INTERRUPTED {2}limit \(gate\.mjs restored\)$/m);
  assert.doesNotMatch(f.text(), /WRONG_FAILURE|second/);
  assert.equal(f.gate(), GATE);
});

// A real interrupt: the runner as its own process on a fixture repo whose test is slow enough to be caught mid-row.
const SLOW_TEST = [
  "import test from \"node:test\";",
  "import assert from \"node:assert/strict\";",
  "import { LIMIT } from \"./gate.mjs\";",
  "test(\"S-1: the limit is three\", async () => { await new Promise((r) => setTimeout(r, 1500)); assert.equal(LIMIT, 3); });",
  ""
].join("\n");
const SLOW_REGISTRY = "export const SABOTAGES = Object.freeze([\n" +
  "  { id: \"first\", file: \"gate.mjs\", find: \"LIMIT = 3\", replace: \"LIMIT = 4\", test: \"slow.test.mjs\", expect: \"S-1\" },\n" +
  "  { id: \"second\", file: \"gate.mjs\", find: \"LIMIT = 3\", replace: \"LIMIT = 5\", test: \"slow.test.mjs\", expect: \"S-1\" }\n]);\n";

/**
 * @param {"group-sigint" | "sigterm" | "sighup"} how @param {string} [slowTest] @param {() => boolean} [ready] when to interrupt
 * @param {(root: string) => Promise<void>} [afterExit] runs once the runner exited, before this helper kills its group
 */
async function interruptRealRun(how, slowTest = SLOW_TEST, ready, afterExit) {
  const root = tmpDir("rl-sab-sig-");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.resolve("scripts/sabotage.mjs"), path.join(root, "scripts/sabotage.mjs"));
  fs.writeFileSync(path.join(root, "scripts/sabotage-registry.mjs"), SLOW_REGISTRY);
  fs.writeFileSync(path.join(root, "gate.mjs"), GATE);
  fs.writeFileSync(path.join(root, "slow.test.mjs"), slowTest.replaceAll("<ROOT>", root));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // detached: its own process group, so a group SIGINT (what Ctrl-C sends) reaches only the runner and its tests.
  const child = spawn(process.execPath, [path.join(root, "scripts/sabotage.mjs")], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const pid = child.pid;
  try {
    // A failed spawn has no pid: fail here, never signal it (kill(-0) would hit this test runner's own group).
    assert.ok(isRealPid(pid), "the runner was spawned");
    const until = Date.now() + 60_000;
    while (fs.readFileSync(path.join(root, "gate.mjs"), "utf8") === GATE || (ready && !ready.call(root))) {
      assert.ok(Date.now() < until, `the first break was never applied: ${out}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    if (how === "group-sigint") signalPid(pid, "SIGINT", { group: true });
    else signalPid(pid, how === "sighup" ? "SIGHUP" : "SIGTERM");
    const r = /** @type {{ code: number | null, signal: string | null }} */ (await exited);
    if (afterExit) await afterExit(root);
    return { ...r, root, out, gate: fs.readFileSync(path.join(root, "gate.mjs"), "utf8") };
  } finally {
    signalPid(pid, "SIGKILL", { group: true });
  }
}

for (const how of /** @type {const} */ (["group-sigint", "sigterm", "sighup"])) {
  test(`runner: a real ${how === "group-sigint" ? "Ctrl-C (SIGINT to the process group)" : how === "sighup" ? "SIGHUP (terminal closed) to the runner" : "SIGTERM to the runner"} mid-row restores the file, stops, and exits ${EXIT_INTERRUPTED}`, { timeout: 120_000 }, async () => {
    const r = await interruptRealRun(how);
    assert.equal(r.code, EXIT_INTERRUPTED, r.out);
    assert.equal(r.gate, GATE, "restored byte for byte");
    assert.match(r.out, /^INTERRUPTED {2}first \(gate\.mjs restored\)$/m, r.out);
    assert.match(r.out, /sabotage: interrupted/);
    assert.doesNotMatch(r.out, /second|WRONG_FAILURE/, "the second row never ran and no verdict was claimed");
  });
}

// A broken test file whose spawnSync child spins (merge-bypass's latency child, gone super-linear): the test file
// dies with node --test, but its child is orphaned unless the whole process group is killed.
const SPIN_TEST = [
  "import { spawnSync } from \"node:child_process\";",
  "import test from \"node:test\";",
  "import { LIMIT } from \"./gate.mjs\";",
  "test(\"S-1: the limit is three\", () => { if (LIMIT !== 3) spawnSync(process.execPath, [\"-e\", \"require('fs').writeFileSync('<ROOT>/spin.pid', String(process.pid)); for (;;) {}\"]); });",
  ""
].join("\n");

test("L2: an interrupted row kills the test run's whole process group: a test's spinning child is not orphaned", { timeout: 120_000 }, async () => {
  let spinner = 0;
  let gone = false;
  try {
    // Checked before interruptRealRun's own cleanup kills the group, which would hide an orphan.
    const r = await interruptRealRun("sigterm", SPIN_TEST, function () {
      const f = path.join(String(this), "spin.pid");
      return fs.existsSync(f) && fs.readFileSync(f, "utf8") !== "";
    }, async (root) => {
      spinner = Number(fs.readFileSync(path.join(root, "spin.pid"), "utf8"));
      for (let i = 0; i < 100 && !gone; i++) {
        if (signalPid(spinner, 0)) await new Promise((res) => setTimeout(res, 50));
        else gone = true;
      }
    });
    assert.equal(r.code, EXIT_INTERRUPTED, r.out);
    assert.equal(r.gate, GATE, "restored byte for byte");
    assert.ok(gone, "the spinning grandchild died with its group");
  } finally {
    // Only a spinner not yet seen gone: once it is gone its pid may belong to someone else.
    if (!gone) signalPid(spinner, "SIGKILL");
  }
});

test("sabotage.mjs: an unknown --only id or argument is a usage error (exit 2) and runs nothing", () => {
  for (const args of [["--only", "no-such-row"], ["--only"], ["--bogus"]]) {
    const r = spawnSync(process.execPath, [path.resolve("scripts/sabotage.mjs"), ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: sabotage\.mjs/);
    assert.equal(r.stdout, "");
  }
});
