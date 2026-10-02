import { spawnSync } from "node:child_process";
import { run } from "../../plugin/engine/lib/proc.mjs";
import { CliError } from "./errors.mjs";

/** @typedef {"missing" | "timeout" | "output_too_large" | "spawn_failed"} ToolFailure */
/** @typedef {{ code: number | null, stdout: string, stderr: string, failure: ToolFailure | null }} ToolResult */

/** A runTool-compatible runner; doctor passes a per-run memo so each probe runs once. @typedef {typeof runTool} Runner */

/** @param {string} cmd @param {string[]} args @param {{ timeoutMs?: number, stdio?: "inherit" }} [opts] @returns {Promise<ToolResult>} */
export async function runTool(cmd, args, opts = {}) {
  if (opts.stdio === "inherit") {
    const r = spawnSync(cmd, args, { stdio: "inherit" });
    const errno = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code;
    /** @type {ToolFailure | null} */
    const failure = errno === "ENOENT" ? "missing" : errno !== undefined || r.status === null || r.signal ? "spawn_failed" : null;
    return { code: r.status, stdout: "", stderr: "", failure };
  }
  try {
    const r = await run(cmd, args, { timeoutMs: opts.timeoutMs ?? 30_000 });
    return { code: r.timedOut ? null : r.code, stdout: r.stdout, stderr: r.stderr, failure: r.timedOut ? "timeout" : null };
  } catch (err) {
    // proc.run rejects only with ReviewLoopError: spawn_failed (message carries the errno) or output_too_large.
    const code = err && typeof err === "object" && "code" in err ? err.code : null;
    const msg = err instanceof Error ? err.message : "";
    /** @type {ToolFailure} */
    const failure = code === "output_too_large" ? "output_too_large" : code === "spawn_failed" && /ENOENT/.test(msg) ? "missing" : "spawn_failed";
    return { code: null, stdout: "", stderr: "", failure };
  }
}

/** The single mapping from a tool outcome to user-facing text. @param {ToolResult} r @param {string} ranButFailed */
export function noteFor(r, ranButFailed) {
  if (r.failure === "missing" || (r.failure === null && r.code === 127)) return "not installed";
  if (r.failure === "timeout") return "timed out — check your network or VPN, then re-run";
  if (r.failure) return `could not run (${r.failure})`;
  return ranButFailed;
}

/** Callers that parse output must not mistake a failed run for an empty answer. @param {ToolResult} r @param {string} what */
export function requireRan(r, what) {
  if (r.failure) throw new CliError("tool_failed", `${what}: ${r.failure === "missing" ? "not installed" : r.failure}`, r.failure);
}

/** CLIs print warnings before their --json result: take the last line that parses as an object. @param {string} stdout @returns {unknown} */
export function lastJsonLine(stdout) {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (typeof v === "object" && v !== null) return v;
    } catch {
      // Not the JSON line.
    }
  }
  try {
    const v = JSON.parse(stdout);
    return typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
