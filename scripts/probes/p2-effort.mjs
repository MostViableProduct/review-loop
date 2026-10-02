// P2: does a per-review effort reach Codex without touching $CODEX_HOME/config.toml?
// Usage: node scripts/probes/p2-effort.mjs <mechanism> <effort>   mechanism: flag | env | task | none
// flag/env/none drive adversarial-review; task drives `task --effort` (the only companion path that forwards effort).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [mechanism, effort = "low"] = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const cfg = path.join(codexHome, "config.toml");
const hash = () => crypto.createHash("sha256").update(fs.readFileSync(cfg)).digest("hex");
const before = hash();
const base = path.join(os.homedir(), ".claude/plugins/cache/openai-codex/codex");
const version = fs.readdirSync(base).sort().at(-1);
const companion = path.join(base, version, "scripts", "codex-companion.mjs");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p2-"));
spawnSync("git", ["init", "-q"], { cwd: repo });
fs.writeFileSync(path.join(repo, "a.md"), "# probe\n");
const env = { ...process.env };
const args = [companion];
if (mechanism === "task") {
  args.push("task", "--effort", effort, "Reply with the single word OK. Do not read files.");
} else {
  args.push("adversarial-review", "--wait", "--json", "--scope", "working-tree");
  if (mechanism === "flag") args.push("--effort", effort);
  if (mechanism === "env") env.CODEX_REASONING_EFFORT = effort;
  args.push("Review a.md briefly.");
}
const started = Date.now();
const r = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout: 15 * 60_000 });
const sessions = path.join(codexHome, "sessions");
// BSD /usr/bin/find rejects `-newermt @epoch` (only a bfs shell function accepts it), so walk the tree and compare mtimes in Node.
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const findNewest = () => {
  if (!fs.existsSync(sessions)) return "";
  let best = null;
  for (const f of fs.readdirSync(sessions, { recursive: true }).map(String)) {
    if (!f.endsWith(".jsonl")) continue;
    const full = path.join(sessions, f);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_LOG_BYTES || st.mtimeMs < started) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs };
  }
  return best ? best.full : "";
};
// The shared app-server daemon may flush the rollout after the companion exits, so poll briefly.
let newest = findNewest();
for (let i = 0; i < 10 && !newest; i += 1) {
  spawnSync("sleep", ["1"]);
  newest = findNewest();
}
const log = newest ? fs.readFileSync(newest, "utf8") : "";
console.log(JSON.stringify({
  mechanism, effort, exit: r.status,
  configUnchanged: hash() === before,
  effortInLog: new RegExp(`"(effort|reasoning_effort|model_reasoning_effort)"\\s*:\\s*"${effort}"`).test(log),
  sessionLog: newest ? path.basename(newest) : null
}));
