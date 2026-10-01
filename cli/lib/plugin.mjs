import { lastJsonLine, noteFor, requireRan, runTool } from "./run.mjs";
import { CliError } from "./errors.mjs";

// D1 (the GitHub owner) is undecided; Task 28 replaces the placeholder.
export const MARKETPLACE_SOURCE = "MostViableProduct/review-loop";
export const MARKETPLACE_NAME = "review-loop";
export const PLUGIN_ID = "review-loop@review-loop";
const MARKETPLACE_GONE = /Marketplace '[^']*' not found/i;

/** The plugin and the CLI are compatible when their major.minor match. @param {string} a @param {string} b */
export const sameMinor = (a, b) => a.split(".").slice(0, 2).join(".") === b.split(".").slice(0, 2).join(".");

/** @typedef {{ version: string | null, installPath: string | null, enabled: boolean, scope: string | null }} PluginEntry */

/**
 * Every listed install of `id`: one plugin can be installed at user, project and local scope at once.
 * @param {string} id @param {import("./run.mjs").Runner} [run]
 * @returns {Promise<PluginEntry[]>}
 */
export async function pluginEntries(id, run = runTool) {
  const r = await run("claude", ["plugin", "list", "--json"]);
  requireRan(r, "claude plugin list");
  const v = lastJsonLine(r.stdout);
  const wrapped = /** @type {{ plugins?: unknown } | null} */ (v)?.plugins;
  const list = Array.isArray(v) ? v : Array.isArray(wrapped) ? wrapped : null;
  if (list === null) throw new CliError("claude_cli_unparseable", "could not read `claude plugin list --json`");
  /** @type {PluginEntry[]} */
  const out = [];
  for (const p of list) {
    if (typeof p !== "object" || p === null) continue;
    const e = /** @type {Record<string, unknown>} */ (p);
    if (e.id === id || e.name === id) {
      out.push({
        version: typeof e.version === "string" ? e.version : null,
        installPath: typeof e.installPath === "string" ? e.installPath : null,
        enabled: e.enabled !== false,
        scope: typeof e.scope === "string" ? e.scope : null
      });
    }
  }
  return out;
}

/**
 * The install of `id` at `scope` (an entry reporting no scope counts: older Claude Code lists none), or with no scope
 * asked, the user-scope one first, else the first listed.
 * @param {string} id @param {import("./run.mjs").Runner} [run] @param {string | null} [scope]
 * @returns {Promise<PluginEntry | null>}
 */
export async function installedPlugin(id, run = runTool, scope = null) {
  return pickEntry(await pluginEntries(id, run), scope);
}

/** @param {PluginEntry[]} entries @param {string | null} [scope] @returns {PluginEntry | null} */
export function pickEntry(entries, scope = null) {
  const at = entries.find((e) => e.scope === (scope ?? "user")) ?? entries.find((e) => e.scope === null);
  return at ?? (scope === null ? entries[0] ?? null : null);
}

export async function installPlugin() {
  const add = await runTool("claude", ["plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
  if (add.code !== 0 && !/already/i.test(add.stderr + add.stdout)) throw new CliError("plugin_install_failed", "could not add the review-loop marketplace");
  // --scope is accepted by Claude Code 2.1.285 but missing from `claude plugin install --help`.
  const inst = await runTool("claude", ["plugin", "install", PLUGIN_ID, "--scope", "user", "--json"], { timeoutMs: 5 * 60_000 });
  requireRan(inst, "claude plugin install");
  if (inst.code !== 0) throw new CliError("plugin_install_failed", "claude plugin install failed");
}

/**
 * A project or local install lives in that project's settings, out of reach of a user-scope removal; removing the
 * marketplace under it would leave a half-removed plugin. Callers check this before anything moves.
 * @param {string} what the command to re-run, for the message
 * @param {PluginEntry[]} [entries] an already-read listing, so the caller lists once
 */
export async function assertNoOtherScope(what, entries) {
  const elsewhere = [...new Set((entries ?? (await pluginEntries(PLUGIN_ID))).map((e) => e.scope).filter((s) => s !== null && s !== "user"))];
  if (!elsewhere.length) return;
  const cmds = elsewhere.map((s) => `\`claude plugin uninstall ${PLUGIN_ID} --scope ${s}\``).join(" and ");
  throw new CliError("plugin_other_scope", `review-loop is also installed at ${elsewhere.join(" and ")} scope; in that project run ${cmds}, then run ${what} again; nothing was changed`);
}

/**
 * Uninstalls the user-scope plugin if it is listed. Already gone (listed, then `not_installed`) counts as done.
 * @param {PluginEntry[]} [entries] an already-read listing, so the caller lists once
 * @returns {Promise<Awaited<ReturnType<typeof installedPlugin>>>} what was listed before, or null
 */
export async function uninstallPlugin(entries) {
  const plugin = entries ? pickEntry(entries, "user") : await installedPlugin(PLUGIN_ID, undefined, "user");
  if (plugin) {
    const r = await runTool("claude", ["plugin", "uninstall", PLUGIN_ID, "--scope", "user", "--json"]);
    const gone = /** @type {{ failureCode?: unknown } | null} */ (lastJsonLine(r.stdout))?.failureCode === "not_installed";
    if ((r.failure !== null || r.code !== 0) && !(r.failure === null && gone)) throw new CliError("plugin_uninstall_failed", `claude plugin uninstall ${noteFor(r, "failed")}`);
  }
  return plugin;
}

/** Removes the marketplace; one that is already gone counts as done. */
export async function removeMarketplace() {
  const m = await runTool("claude", ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
  if ((m.failure !== null || m.code !== 0) && !(m.failure === null && MARKETPLACE_GONE.test(m.stderr + m.stdout))) {
    throw new CliError("plugin_uninstall_failed", `claude plugin marketplace remove ${noteFor(m, "failed")}`);
  }
}

/** @returns {Promise<string | null>} */
export async function enginePath() {
  const p = await installedPlugin(PLUGIN_ID);
  return p?.installPath ? `${p.installPath}/engine` : null;
}
