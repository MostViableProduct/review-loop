import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { assertConfigDirTrusted } from "./configguard.mjs";
import { stateDirCode } from "./doctor.mjs";
import { assertNoOtherScope, installedPlugin, pluginEntries, PLUGIN_ID, removeMarketplace, uninstallPlugin } from "./plugin.mjs";
import { ASK_RULES, hookCommands, LEGACY_HOOK_RE, readSettings, updateSettings, writerPreconditions } from "./settings.mjs";
import { configPath } from "../../plugin/engine/lib/config.mjs";
import { stateDirProblem } from "../../plugin/engine/lib/events.mjs";
import { diagnosticCode } from "../../plugin/engine/lib/errors.mjs";
import { stateRoot } from "../../plugin/engine/lib/paths.mjs";

// Where Claude Code puts an installed plugin; a hook command under it is ours. A checkout named review-loop elsewhere is not.
const PLUGIN_HOOK_RE = /[\\/]plugins[\\/](cache|marketplaces)[\\/]review-loop[\\/]/;
const COMMAND_MAX = 200;
const STEPS = ["plugin uninstall", "marketplace remove", "settings approval rules", "config file", "review history", "final check"];

/** Only a real directory we own is removed: never through a link, never a foreign-owned root. */
function deleteStateRoot() {
  const dir = stateRoot();
  const problem = stateDirProblem(dir);
  if (problem === "absent") return false;
  if (problem === "symlink" || problem === "not_directory" || problem === "not_owned") {
    const why = problem === "not_owned" ? "is owned by another user" : problem === "symlink" ? "is a symbolic link" : "is not a directory";
    throw new CliError(stateDirCode(problem), `${dir} ${why}; it was not deleted (move it aside or fix its owner, then re-run)`, problem);
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // rmSync reports a permission-locked subdirectory as ENOTEMPTY (force swallows the inner EACCES), which
    // diagnosticCode would call unexpected_error: every other failure here is the state dir's permissions.
    const code = diagnosticCode(err) === "state_symlink_rejected" ? "state_symlink_rejected" : "state_dir_insecure";
    const errno = err instanceof Error && "code" in err ? String(err.code) : "error";
    throw new CliError(code, `${dir} could not be fully deleted (${errno}); make it and everything in it yours and writable, then re-run`);
  }
  return true;
}

/** Never through a directory: rmSync would fail with an unregistered error. */
function removeConfig() {
  const file = configPath();
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (st?.isDirectory()) throw new CliError("config_invalid", `${file} is a directory, not a config file; it was not removed`);
  fs.rmSync(file, { force: true });
  if (process.env.REVIEW_LOOP_CONFIG) return;
  try { fs.rmdirSync(path.dirname(file)); } catch { /* Not empty or already gone: left alone. */ }
}

/** @param {Record<string, unknown>} obj parsed settings @param {string | null} installPath @returns {string | null} the first hook command that is ours */
function danglingHook(obj, installPath) {
  return hookCommands(obj).find((c) => LEGACY_HOOK_RE.test(c) || PLUGIN_HOOK_RE.test(c) || (installPath !== null && c.split(/[\s"']+/).some((t) => t === installPath || t.startsWith(`${installPath}/`)))) ?? null;
}

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
export async function run(args, io, ctx) {
  if (!io.isTTY && !ctx.yes) throw new CliError("usage_noninteractive", "uninstall needs a terminal, or --yes");
  io.err(`Will remove: the review-loop plugin and marketplace; ${ASK_RULES.length} approval rules in settings.json; ${configPath()}.\nWill NOT remove: Codex, the Codex plugin, gh, node (other tools may use them).\n`);
  if (!ctx.yes && !(await io.ask("Continue?", false))) throw new CliError("cancelled", "cancelled");
  // The settings write's own preconditions, checked before anything is removed: a refusal there must change nothing.
  await writerPreconditions(io, { yes: ctx.yes }, readSettings().target);
  assertConfigDirTrusted("review-loop uninstall");
  const entries = await pluginEntries(PLUGIN_ID);
  await assertNoOtherScope("review-loop uninstall", entries);

  let done = 0;
  try {
    const plugin = await uninstallPlugin(entries);
    done = 1;
    await removeMarketplace();
    done = 2;
    await updateSettings((o) => {
      const perms = /** @type {{ ask?: unknown } | undefined} */ (o.permissions);
      if (!perms || !Array.isArray(perms.ask)) return false;
      const keep = perms.ask.filter((r) => !ASK_RULES.includes(r));
      if (keep.length === perms.ask.length) return false;
      perms.ask = keep;
      return true;
    }, { io, yes: ctx.yes });
    done = 3;
    removeConfig();
    done = 4;

    // --yes skips prompts but never consents to deleting history.
    const del = args.includes("--delete-history") || (!args.includes("--keep-history") && !ctx.yes && (await io.ask(`Also delete review history in ${stateRoot()}?`, false)));
    if (del && deleteStateRoot()) io.err("Review history deleted. The final uninstall event was logged to a fresh events.jsonl.\n");
    else if (!del) io.err(`Review history kept in ${stateRoot()}. Re-run with --delete-history to remove it.\n`);
    done = 5;

    const hook = danglingHook(readSettings().obj, plugin?.installPath ?? null);
    if (hook !== null) {
      const shown = hook.length > COMMAND_MAX ? `${hook.slice(0, COMMAND_MAX - 1)}…` : hook;
      throw new CliError("settings_hook_present", `a hook still references review-loop: ${shown}`);
    }
    if (await installedPlugin(PLUGIN_ID)) throw new CliError("plugin_uninstall_failed", "the review-loop plugin is still installed; run `claude plugin uninstall review-loop@review-loop`");
  } catch (err) {
    io.err(`Removed so far: ${done === 0 ? "nothing" : STEPS.slice(0, done).join(", ")}.\nNot yet removed: ${STEPS.slice(done).join(", ")}.\n`);
    throw err;
  }
  io.err("review-loop removed. To finish, you can run: brew uninstall review-loop\n");
  return { code: "ok" };
}
