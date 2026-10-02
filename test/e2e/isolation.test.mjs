import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { childEnv, isolatedConfigProblem, roundBrokers } from "./isolation.mjs";

test("e2e isolation: CLAUDE_CONFIG_DIR must be an existing directory that is not the real ~/.claude", () => {
  const home = tmpDir("rl-iso-home-");
  const probe = tmpDir("rl-iso-probe-");
  assert.equal(isolatedConfigProblem(probe, home), null, "a separate directory is isolated (no ~/.claude at all)");
  fs.mkdirSync(path.join(home, ".claude"));
  assert.equal(isolatedConfigProblem(probe, home), null, "a separate directory is isolated");
  assert.match(isolatedConfigProblem(undefined, home) ?? "", /not set/);
  assert.match(isolatedConfigProblem("", home) ?? "", /not set/);
  assert.match(isolatedConfigProblem(path.join(probe, "missing"), home) ?? "", /does not exist/);
  fs.writeFileSync(path.join(probe, "file"), "");
  assert.match(isolatedConfigProblem(path.join(probe, "file"), home) ?? "", /not a directory/);
  assert.match(isolatedConfigProblem(path.join(home, ".claude"), home) ?? "", /real ~\/\.claude/);
  assert.match(isolatedConfigProblem(`${home}/./.claude/`, home) ?? "", /real ~\/\.claude/, "another spelling of the same path");
  const link = path.join(probe, "link");
  fs.symlinkSync(path.join(home, ".claude"), link);
  assert.match(isolatedConfigProblem(link, home) ?? "", /real ~\/\.claude/, "a link to ~/.claude");
  const home2 = tmpDir("rl-iso-home2-");
  fs.symlinkSync(probe, path.join(home2, ".claude"));
  assert.match(isolatedConfigProblem(probe, home2) ?? "", /real ~\/\.claude/, "~/.claude is itself a link to the probe dir");
});

test("e2e isolation: childEnv drops the parent session's and Anthropic variables, keeps CLAUDE_CONFIG_DIR", () => {
  const source = {
    PATH: "/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/probe/.claude", CLAUDECODE: "1", CLAUDE_PLUGIN_DATA: "/real", CLAUDE_CODE_USE_BEDROCK: "1",
    CODEX_COMPANION_SESSION_ID: "s", REVIEW_LOOP_PIN_FILE: "/p", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "u", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_MODEL: "m"
  };
  assert.deepEqual(childEnv("/state", source), { PATH: "/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/probe/.claude", REVIEW_LOOP_STATE_DIR: "/state" });
  assert.deepEqual(
    childEnv("/state", { ...source, REVIEW_LOOP_E2E_KEEP_API_KEY: "1" }),
    { PATH: "/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/probe/.claude", ANTHROPIC_API_KEY: "k", REVIEW_LOOP_STATE_DIR: "/state" },
    "the opt-in keeps ANTHROPIC_API_KEY only"
  );
  assert.equal(childEnv("/state", { ...source, REVIEW_LOOP_E2E_KEEP_API_KEY: "yes" }).ANTHROPIC_API_KEY, undefined, "only the exact value 1 opts in");
});

test("e2e broker check: roundBrokers matches only a broker from this run's own ws/plugin-* snapshot", () => {
  const state = "/var/folders/ab/T/rl-e2e-state-Xy12";
  const real = "/private/var/folders/ab/T/rl-e2e-state-Xy12";
  const node = "/opt/homebrew/Cellar/node/26.10.0_1/bin/node";
  const tail = "--endpoint unix:/var/folders/ab/T/cxc-K5eYZc/broker.sock --cwd /x/ws/r-oicm5J --pid-file /var/folders/ab/T/cxc-K5eYZc/broker.pid";
  const ours = `  4242 ${node} ${real}/ws/plugin-2iUJKd/scripts/app-server-broker.mjs serve ${tail}`;
  const oursAsGiven = `4243 ${node} ${state}/ws/plugin-lY6kdz/scripts/app-server-broker.mjs serve ${tail}`;
  const lines = [
    ours,
    oursAsGiven,
    // The author's legacy brokers (real state dir), including one whose --cwd happens to name this run's state dir.
    `  101 ${node} /Users/u/.claude/state/review-loop/ws/plugin-AbC123/scripts/app-server-broker.mjs serve ${tail}`,
    `  102 ${node} /Users/u/.claude/state/review-loop/ws/plugin-Zz9/scripts/app-server-broker.mjs serve --endpoint unix:/tmp/s --cwd ${state}/ws/r-1`,
    // A broker from the installed Codex plugin itself, one from another temp state dir sharing this one's prefix,
    // one from an earlier probe's scratch state dir.
    `  103 ${node} /Users/u/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs serve ${tail}`,
    `  104 ${node} ${state}-other/ws/plugin-q1/scripts/app-server-broker.mjs serve ${tail}`,
    `  105 ${node} /private/tmp/claude-501/scratchpad/state4.r7FR/ws/plugin-2iUJKd/scripts/app-server-broker.mjs serve ${tail}`,
    // This run's snapshot, but not a broker: the companion itself, and a broker script without `serve`.
    `  106 ${node} ${real}/ws/plugin-2iUJKd/scripts/codex-companion.mjs adversarial-review --wait --json`,
    `  107 ${node} ${real}/ws/plugin-2iUJKd/scripts/app-server-broker.mjs status`,
    // A nested path under the snapshot is not the snapshot's own scripts dir.
    `  108 ${node} ${real}/ws/plugin-2iUJKd/extra/scripts/app-server-broker.mjs serve ${tail}`,
    "  109 /usr/bin/codex app-server",
    ""
  ].join("\n");
  assert.deepEqual(roundBrokers(lines, state, real).map((r) => r.pid), [4242, 4243]);
  assert.deepEqual(roundBrokers(lines, state).map((r) => r.pid), [4243], "without the realpath only the as-given spelling matches");
  assert.equal(roundBrokers(lines, `${state}/`, `${real}/`).length, 2, "a trailing slash on the state dir is tolerated");
  assert.equal(roundBrokers(ours, state, real)[0].args.startsWith(node), true);
  assert.deepEqual(roundBrokers("", state, real), []);
  assert.deepEqual(roundBrokers(lines, "/private/var/folders/ab/T/rl-e2e-state-Xy1", "/var/folders/ab/T/rl-e2e-state-Xy1"), [], "a state dir that is a prefix of this one matches nothing");
});
