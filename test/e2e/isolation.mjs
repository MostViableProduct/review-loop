// The live e2e's guards against touching the author's real Claude Code config or credentials, and its read-only
// broker-leak check. Kept out of live.test.mjs so isolation.test.mjs can check them for free on every `npm test`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Why `dir` is not a safe isolated `CLAUDE_CONFIG_DIR`, or null. The real `~/.claude` is compared by realpath and by
 * inode, so another spelling, a link to it, or a `~/.claude` that is itself a link to `dir` are all refused.
 * @param {string | undefined} dir @param {string} [home]
 * @returns {string | null}
 */
export function isolatedConfigProblem(dir, home = os.homedir()) {
  if (!dir) return "CLAUDE_CONFIG_DIR is not set: run inside the isolated, signed-in probe config (Task 27 Step 2)";
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return `CLAUDE_CONFIG_DIR ${dir} does not exist`;
  }
  const st = fs.statSync(real);
  if (!st.isDirectory()) return `CLAUDE_CONFIG_DIR ${dir} is not a directory`;
  const homeClaude = path.join(home, ".claude");
  /** @type {fs.Stats | null} */
  let hst = null;
  let realHome = path.resolve(homeClaude);
  try {
    realHome = fs.realpathSync(homeClaude);
    hst = fs.statSync(realHome);
  } catch {
    // No ~/.claude: nothing to collide with.
  }
  if (real === realHome || (hst !== null && hst.dev === st.dev && hst.ino === st.ino)) {
    return `CLAUDE_CONFIG_DIR ${dir} is the real ~/.claude (${realHome}); the e2e must never run against the author's config`;
  }
  return null;
}

/**
 * The environment for every process the e2e starts. Run from inside Claude Code, the parent session's variables (its
 * plugin data dir, companion session, messaging socket, a Bedrock/Vertex switch) would route the nested session and
 * the Codex companion into the parent's state, and inherited ANTHROPIC_* variables (a base URL, an auth token, a key)
 * would bypass the probe config's own sign-in. All are dropped. `REVIEW_LOOP_E2E_KEEP_API_KEY=1` keeps
 * `ANTHROPIC_API_KEY` alone, for a run that signs in with a key instead of the probe login.
 * @param {string} state @param {NodeJS.ProcessEnv} [source]
 */
export function childEnv(state, source = process.env) {
  const keepKey = source.REVIEW_LOOP_E2E_KEEP_API_KEY === "1";
  const keep = Object.entries(source).filter(([k]) => {
    if (k === "CLAUDE_CONFIG_DIR") return true;
    if (k === "ANTHROPIC_API_KEY") return keepKey;
    return !/^(CLAUDE|ANTHROPIC_|CODEX_COMPANION_|REVIEW_LOOP_)/.test(k);
  });
  return { ...Object.fromEntries(keep), REVIEW_LOOP_STATE_DIR: state };
}

/** @param {string} s */
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The `ps -ww -Ao pid=,args=` rows that are a Codex broker started by a round run against `stateDir`: args naming
 * `<stateDir>/ws/plugin-<id>/scripts/app-server-broker.mjs serve`. The round's snapshot is a fresh `ws/plugin-*`
 * under its own state dir, and the e2e's state dir is its own temp dir, so the author's other brokers (another state
 * dir, or this path only in a `--cwd` argument) never match. `stateDir` is matched as given and as `realStateDir`:
 * Node runs the companion from its realpath (macOS /var → /private/var). Pure: it only reads the text.
 * @param {string} psOutput @param {string} stateDir @param {string} [realStateDir]
 * @returns {Array<{ pid: number, args: string }>}
 */
export function roundBrokers(psOutput, stateDir, realStateDir = stateDir) {
  const roots = [...new Set([stateDir, realStateDir].map((d) => d.replace(/\/+$/, "")))];
  const res = roots.map((r) => new RegExp(`(^|\\s)${reEscape(`${r}/ws/plugin-`)}[^/\\s]+${reEscape("/scripts/app-server-broker.mjs serve")}(\\s|$)`));
  return psOutput
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), args: m[2] }))
    .filter((row) => res.some((re) => re.test(row.args)));
}
