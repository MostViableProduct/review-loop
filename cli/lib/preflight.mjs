import { CliError } from "./errors.mjs";
import { mark } from "./io.mjs";
import { lastJsonLine, noteFor, requireRan, runTool } from "./run.mjs";

// The oldest version setup's `claude plugin install … --scope user` was run on (CLAUDE.md Probes); CI pins the same
// version. Raise all three together: test/contract/release.test.mjs fails when they drift.
export const MIN_CLAUDE = "2.1.285";

/** @param {string} a @param {string} b */
const gte = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
};

/** @param {unknown} p @returns {Record<string, unknown> | null} */
const asRecord = (p) => (typeof p === "object" && p !== null ? /** @type {Record<string, unknown>} */ (p) : null);

/** @param {string} id @param {import("./run.mjs").Runner} run */
async function pluginEnabled(id, run) {
  const r = await run("claude", ["plugin", "list", "--json"]);
  requireRan(r, "claude plugin list");
  const v = lastJsonLine(r.stdout);
  const list = Array.isArray(v) ? v : Array.isArray(asRecord(v)?.plugins) ? /** @type {unknown[]} */ (asRecord(v)?.plugins) : null;
  if (list === null) throw new CliError("claude_cli_unparseable", "could not read `claude plugin list --json`");
  return list.some((p) => {
    const e = asRecord(p);
    return e !== null && (e.id === id || e.name === id) && e.enabled !== false;
  });
}

/** @typedef {{ text: string, cmd?: [string, string[]], interactive?: boolean }} Fix */
/** `failure` is set when the tool itself could not run, so a caller never reads a timeout as "not installed". `fix`
 * replaces the item's fix when this failure needs a different one (an old Claude Code is updated, not reinstalled).
 * @typedef {{ status: "pass" | "fail" | "warn", note?: string, failure?: import("./run.mjs").ToolFailure | null, fix?: Fix }} CheckResult */
/** @typedef {{ id: string, label: string, required: boolean, check: (run?: import("./run.mjs").Runner) => Promise<CheckResult>,
 *   fix: Fix }} PreflightItem */

/** An installed Claude Code that is too old: a cask install could add a second copy beside a native install. @type {Fix} */
const CLAUDE_UPDATE = { text: "claude update", cmd: ["claude", ["update"]] };

/** @type {PreflightItem[]} */
export const PREFLIGHT = [
  { id: "claude", label: "Claude Code", required: true,
    async check(run = runTool) {
      const r = await run("claude", ["--version"]);
      const v = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
      if (!v) return { status: "fail", note: noteFor(r, "unexpected --version output"), failure: r.failure };
      return gte(v, MIN_CLAUDE) ? { status: "pass", note: v } : { status: "fail", note: `${v} is older than ${MIN_CLAUDE}`, fix: CLAUDE_UPDATE };
    },
    fix: { text: "brew install --cask claude-code", cmd: ["brew", ["install", "--cask", "claude-code"]] } },
  { id: "codex_cli", label: "Codex CLI", required: true,
    async check(run = runTool) {
      const r = await run("codex", ["--version"]);
      return r.code === 0 && r.failure === null ? { status: "pass", note: /(\d+\.\d+\.\d+[\w.-]*)/.exec(r.stdout)?.[1] ?? "version unknown" } : { status: "fail", note: noteFor(r, "not working"), failure: r.failure };
    },
    fix: { text: "brew install --cask codex", cmd: ["brew", ["install", "--cask", "codex"]] } },
  { id: "codex_auth", label: "Codex sign-in", required: true,
    async check(run = runTool) {
      const r = await run("codex", ["login", "status"]);
      return r.code === 0 && r.failure === null && !/not logged in/i.test(r.stdout) ? { status: "pass" } : { status: "fail", note: noteFor(r, "not signed in"), failure: r.failure };
    },
    fix: { text: "codex login", cmd: ["codex", ["login"]], interactive: true } },
  { id: "codex_plugin", label: "Codex plugin for Claude Code", required: true,
    async check(run = runTool) { return (await pluginEnabled("codex@openai-codex", run)) ? { status: "pass" } : { status: "fail", note: "not installed" }; },
    fix: { text: "claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex --scope user",
      cmd: ["sh", ["-c", "claude plugin marketplace add openai/codex-plugin-cc && claude plugin install codex@openai-codex --scope user"]] } },
  { id: "gh", label: "GitHub CLI (optional — PR checks and approval marks)", required: false,
    async check(run = runTool) {
      const r = await run("gh", ["auth", "status"]);
      return r.code === 0 && r.failure === null ? { status: "pass" } : { status: "warn", note: noteFor(r, "not signed in"), failure: r.failure };
    },
    fix: { text: "brew install gh && gh auth login" } }
];

/** A thrown check is a FAIL row carrying only the error's code, so one broken probe cannot hide the other items. @param {PreflightItem} item @returns {Promise<CheckResult>} */
async function safeCheck(item) {
  try {
    return await item.check();
  } catch (err) {
    const e = /** @type {{ code?: unknown, detail?: unknown } | null} */ (typeof err === "object" ? err : null);
    const code = typeof e?.code === "string" ? e.code : "unexpected_error";
    return { status: "fail", note: typeof e?.detail === "string" ? `${code} (${e.detail})` : code };
  }
}

/**
 * A fix command runs only with --yes or an explicit "yes" at a TTY prompt. An interactive fix (a login)
 * never runs without a TTY, even with --yes: it cannot complete headlessly and would hang CI.
 * @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx
 */
export async function runPreflight(io, ctx) {
  let ok = true;
  for (const item of PREFLIGHT) {
    let r = await safeCheck(item);
    io.err(`${mark(r.status, io.color)}  ${item.label}${r.note ? ` — ${r.note}` : ""}\n`);
    if (r.status === "fail" && item.required) {
      const fix = r.fix ?? item.fix;
      io.err(`      Fix: ${fix.text}\n`);
      const runnable = fix.cmd && (io.isTTY || !fix.interactive);
      if (fix.cmd && runnable && (ctx.yes || (io.isTTY && (await io.ask("Run that now?", true))))) {
        const res = await runTool(fix.cmd[0], fix.cmd[1], fix.interactive ? { stdio: "inherit" } : { timeoutMs: 10 * 60_000 });
        if (res.failure !== null || res.code !== 0) io.err(`      ${noteFor(res, `fix failed (exit ${res.code})`)}\n`);
        r = await safeCheck(item);
        io.err(`${mark(r.status, io.color)}  ${item.label} (re-checked)\n`);
      }
      if (r.status === "fail") ok = false;
    } else if (r.status === "warn") {
      io.err(`      Optional: ${item.fix.text}\n`);
    }
  }
  return ok;
}
