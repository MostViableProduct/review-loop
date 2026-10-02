import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpDir } from "../engine/helpers.mjs";
import { enginePath } from "../../cli/lib/plugin.mjs";
import { childEnv, isolatedConfigProblem, roundBrokers } from "./isolation.mjs";

// Paid and opt-in: REVIEW_LOOP_E2E=1, with CLAUDE_CONFIG_DIR set to the isolated, signed-in probe config (never the
// real ~/.claude; checked before anything is spawned). Children get no CLAUDE*/ANTHROPIC_* variables from this
// process except CLAUDE_CONFIG_DIR; REVIEW_LOOP_E2E_KEEP_API_KEY=1 keeps ANTHROPIC_API_KEY alone (isolation.mjs).
const E2E = process.env.REVIEW_LOOP_E2E === "1";

/**
 * A test-side hook that records only the KEY names of the hook input Claude Code delivers (never values), so the
 * e2e documents the real Stop and PostToolUse(Write) shapes the engine reads.
 * @param {string} dir @param {string} keysFile
 */
function keyRecorderSettings(dir, keysFile) {
  const rec = path.join(dir, "record-keys.mjs");
  fs.writeFileSync(
    rec,
    `import fs from "node:fs";
let s = "";
for await (const c of process.stdin) s += c;
const v = JSON.parse(s);
const keys = (o) => (typeof o === "object" && o !== null && !Array.isArray(o) ? Object.keys(o).sort() : []);
const kind = (o) => (Array.isArray(o) ? "array" : o === null ? "null" : typeof o);
fs.appendFileSync(${JSON.stringify(keysFile)}, JSON.stringify({ hook: process.argv[2], keys: keys(v), tool_input: keys(v.tool_input), tool_response: keys(v.tool_response), tool_response_type: kind(v.tool_response) }) + "\\n");
`
  );
  const cmd = (/** @type {string} */ hook) => ({ type: "command", command: `"${process.execPath}" "${rec}" ${hook}`, timeout: 10 });
  return JSON.stringify({ hooks: { Stop: [{ hooks: [cmd("Stop")] }], PostToolUse: [{ matcher: "Write", hooks: [cmd("PostToolUse")] }] } });
}

test("e2e: a real Claude Code session through the installed plugin — Stop blocks an unreviewed spec, then clears", { skip: !E2E && "set REVIEW_LOOP_E2E=1 (paid, needs sign-in)", timeout: 40 * 60_000 }, async (t) => {
  const unsafe = isolatedConfigProblem(process.env.CLAUDE_CONFIG_DIR);
  assert.equal(unsafe, null, unsafe ?? "");
  const engine = await enginePath();
  assert.ok(engine, "the review-loop plugin is installed in the isolated config");
  const state = tmpDir("rl-e2e-state-");
  const repo = tmpDir("rl-e2e-repo-");
  const probe = tmpDir("rl-e2e-probe-");
  const keysFile = path.join(probe, "hook-keys.jsonl");
  const env = childEnv(state); // the plugin's hooks inherit this from claude
  t.diagnostic(`state=${state} repo=${repo} probe=${probe}`);
  const git = (/** @type {string[]} */ ...a) => spawnSync("git", ["-c", "commit.gpgsign=false", ...a], { cwd: repo, env });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "README.md"), "x");
  git("add", ".");
  git("commit", "-qm", "i");

  // R-D8b: the round verifies the Codex plugin against a pin in ITS state dir; pin the isolated config's install there.
  const pinLib = pathToFileURL(path.join(engine, "lib", "pin.mjs")).href;
  const pin = spawnSync(process.execPath, ["--input-type=module", "-e", `import { writePin, latestInstalledVersion } from ${JSON.stringify(pinLib)}; process.stdout.write(writePin(latestInstalledVersion()).version);`], { env, encoding: "utf8" });
  assert.equal(pin.status, 0, `writePin failed: ${pin.stderr.slice(-800)}`);
  t.diagnostic(`pinned codex plugin ${pin.stdout}`);

  const settings = keyRecorderSettings(probe, keysFile);
  let session = 0;
  /**
   * sonnet: the model does not touch the path under test, and a cheaper one keeps each session well inside its $1 cap.
   * @param {string[]} args
   * @returns {Array<Record<string, unknown>>}
   */
  const claude = (args) => {
    session += 1;
    const r = spawnSync("claude", [...args, "--model", "sonnet", "--settings", settings, "--output-format", "stream-json", "--verbose", "--max-budget-usd", "1"], { cwd: repo, env, encoding: "utf8", timeout: 10 * 60_000 });
    fs.writeFileSync(path.join(probe, `session-${session}.jsonl`), r.stdout ?? "");
    const msgs = (r.stdout ?? "").trim().split("\n").flatMap((l) => {
      try {
        /** @type {unknown} */
        const m = JSON.parse(l);
        return typeof m === "object" && m !== null ? [/** @type {Record<string, unknown>} */ (m)] : [];
      } catch {
        return [];
      }
    });
    const result = msgs.findLast((m) => m.type === "result");
    t.diagnostic(`session ${session}: exit=${r.status} subtype=${String(result?.subtype)} turns=${String(result?.num_turns)} cost_usd=${String(result?.total_cost_usd)}`);
    assert.equal(r.status, 0, `claude exited ${r.status}: ${(r.stderr ?? "").slice(-1500)}`);
    return msgs;
  };
  /** The Stop-gate outcomes the plugin's hooks logged, oldest first. @returns {Array<{ outcome: unknown, session: unknown, code: unknown }>} */
  const stopDecisions = () => {
    const f = path.join(state, "events.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf8").trim().split("\n").flatMap((l) => {
      /** @type {unknown} */
      const e = JSON.parse(l);
      if (typeof e !== "object" || e === null || !("event" in e) || e.event !== "gate.decision" || !("data" in e)) return [];
      const d = e.data;
      const sid = "session_id" in e ? e.session_id : null;
      const code = "code" in e ? e.code : null;
      return typeof d === "object" && d !== null && "gate" in d && d.gate === "stop" && "outcome" in d ? [{ outcome: d.outcome, session: sid, code }] : [];
    });
  };

  const fixture = fs.readFileSync(new URL("../../cli/fixtures/livecheck-doc.md", import.meta.url), "utf8");
  const first = claude(["-p", `Use the Write tool to create docs/specs/e2e-design.md with exactly this content, then reply DONE.\n\n${fixture}`, "--allowedTools", "Write"]);
  const sid = first.find((m) => m.type === "system" && m.subtype === "init")?.session_id;
  assert.ok(typeof sid === "string", "stream-json init carries the session id");
  const spec = path.join(repo, "docs", "specs", "e2e-design.md");
  assert.ok(fs.existsSync(spec), "the session wrote the spec through the Write tool");
  const blocked = stopDecisions().filter((d) => d.outcome === "blocked");
  assert.ok(blocked.length >= 1, "the installed plugin's Stop hook blocked the unreviewed spec");
  assert.equal(blocked[0].session, sid, "the block belongs to this session");

  const RR = path.join(engine, "review-round.mjs");
  const round = spawnSync(process.execPath, [RR, "run", "--kind", "spec", "--path", spec, "--project-root", repo], { env, encoding: "utf8", timeout: 15 * 60_000 });
  t.diagnostic(`round exit=${round.status}`);
  assert.ok(round.status === 0 || round.status === 10, `a real Codex round completed (exit ${round.status}): ${round.stdout.slice(-1500)} ${round.stderr.slice(-1500)}`);
  // The round prints one pretty-printed JSON object, not JSON lines.
  const out = JSON.parse(round.stdout);
  t.diagnostic(`round status=${out.status} overall=${out.score?.overall} pass=${out.score?.pass} findings=${out.findings?.length}`);
  assert.equal(out.score.dimensions.length, 11, "11 dimensions scored");
  // H1: the round's companion broker is gone once the round returns. The round's JSON does not name its snapshot, but
  // the snapshot is always a fresh `<state>/ws/plugin-*` and `state` is this test's own temp dir, so the match can
  // only be this run's broker. Read-only: ps is observed and nothing is signalled. Bounded wait for a SIGTERMed exit.
  let left = [];
  for (let i = 0; i < 20; i++) {
    const ps = spawnSync("ps", ["-ww", "-Ao", "pid=,args="], { encoding: "utf8", timeout: 10_000 });
    assert.equal(ps.status, 0, `ps failed: ${ps.stderr}`);
    left = roundBrokers(ps.stdout, state, fs.realpathSync(state));
    if (left.length === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.deepEqual(left.map((b) => b.pid), [], `no app-server broker from this round's snapshot survives: ${left.map((b) => b.args).join(" | ")}`);
  if (round.status === 10) {
    const o = spawnSync(process.execPath, [RR, "override", "--key", out.key, "--reason", "e2e"], { env, encoding: "utf8" });
    assert.equal(o.status, 0, o.stderr);
  }

  const n = stopDecisions().length;
  const second = claude(["-p", "Reply OK and nothing else.", "--resume", sid]);
  assert.equal(second.find((m) => m.type === "system" && m.subtype === "init")?.session_id, sid, "--resume continued the same session, not a fresh one");
  const after = stopDecisions().slice(n);
  assert.ok(after.length >= 1, "the resumed session's Stop hook ran");
  assert.equal(after.at(-1)?.session, sid, "the resumed Stop decision is the blocked session's");
  assert.equal(after.at(-1)?.outcome, "allowed", "Stop clears once the spec passed or was overridden");

  if (fs.existsSync(keysFile)) for (const l of fs.readFileSync(keysFile, "utf8").trim().split("\n")) t.diagnostic(`hook keys ${l}`);
});
