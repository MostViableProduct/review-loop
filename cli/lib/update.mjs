import { CliError } from "./errors.mjs";
import { MARKETPLACE_NAME, PLUGIN_ID } from "./plugin.mjs";
import { noteFor, runTool } from "./run.mjs";
import { run as doctor } from "./doctor.mjs";

/** @param {string[]} _args @param {import("./io.mjs").IO} io @param {{ json: boolean, yes: boolean, started: number }} ctx */
export async function run(_args, io, ctx) {
  const m = await runTool("claude", ["plugin", "marketplace", "update", MARKETPLACE_NAME], { timeoutMs: 2 * 60_000 });
  if (m.failure !== null || m.code !== 0) io.err(`review-loop: marketplace update: ${noteFor(m, "failed")}; trying the plugin update anyway\n`);
  const u = await runTool("claude", ["plugin", "update", PLUGIN_ID, "--json"], { timeoutMs: 5 * 60_000 });
  // Doctor runs after a failed update too: it says what state the install is in. Its report is always human text here.
  const updateErr = u.failure !== null || u.code !== 0 ? new CliError("plugin_install_failed", `claude plugin update ${noteFor(u, "failed")}`) : null;
  let d;
  try {
    d = await doctor([], io, { ...ctx, json: false });
  } catch (err) {
    // The failed update is the cause; a doctor crash after it must not replace its code.
    throw updateErr ?? err;
  }
  if (updateErr) throw updateErr;
  if (d.code === "ok") io.err("Restart Claude Code to load the updated plugin.\n");
  return { code: d.code };
}
