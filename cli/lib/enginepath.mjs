import { CliError } from "./errors.mjs";
import { enginePath } from "./plugin.mjs";

/** @param {string[]} _a @param {import("./io.mjs").IO} io @param {{ json: boolean }} ctx */
export async function run(_a, io, ctx) {
  const p = await enginePath();
  if (!p) throw new CliError("plugin_install_failed", "review-loop plugin is not installed");
  // The skill reads `$(review-loop engine-path)`; with --json main prints the single event carrying `path` instead.
  if (!ctx.json) io.out(`${p}\n`);
  return { code: "ok", json: { path: p } };
}
