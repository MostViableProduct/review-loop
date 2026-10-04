import path from "node:path";
import { CliError } from "./errors.mjs";
import { assertConfigOwner } from "./configguard.mjs";
import { configPath, defaultConfig, EFFORTS, isConfig, PRESET_NAMES, readConfig, writeConfig } from "../../plugin/engine/lib/config.mjs";
import { codexDefaults } from "../../plugin/engine/lib/codexcfg.mjs";
import { quarantine } from "../../plugin/engine/lib/fsutil.mjs";
import { eventsPathProblem } from "../../plugin/engine/lib/events.mjs";
import { loadRubricSection } from "../../plugin/engine/lib/rubric.mjs";

const KEYS = "preset|model|effort|rubric|events.path";

/** @param {unknown} v @param {string} unset */
const source = (v, unset) => (v === null ? unset : "config");

/** A symlinked config is never read through or replaced; an invalid one is repaired, not silently overwritten. */
function requireUsableConfig() {
  assertConfigOwner("config");
  const read = readConfig();
  if (read.status !== "invalid") return read;
  if (read.code === "config_symlink_rejected") throw new CliError(read.code, "the review-loop config is a symlink; it is never followed. Replace the symlink with a regular file, or remove it (defaults apply) and run `review-loop config repair` or `review-loop setup`; nothing was changed");
  throw new CliError("config_invalid", "the review-loop config is unreadable or invalid. Run `review-loop config repair`; nothing was changed");
}

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ json: boolean }} ctx */
export async function run(args, io, ctx) {
  const [sub, key, raw] = args;
  if ((sub === "show" || sub === "repair") && args.length > 1) throw new CliError("usage_bad_flag", `config ${sub} takes no other words (got ${String(args[1]).slice(0, 40)})`);
  if (sub === "show" || sub === undefined) {
    const r = readConfig();
    const d = codexDefaults();
    const c = r.config;
    const sources = { preset: c.preset === "default" ? "default" : "config", model: source(c.codex.model, "inherit"), effort: source(c.codex.effort, "inherit"), rubric: source(c.rubricPath, "built-in"), "events.path": source(c.events.path, "default") };
    if (ctx.json) return { code: "ok", json: { ...c, status: r.status, sources, codexInherited: { model: d.model, effort: d.effort } } };
    const problem = r.status === "invalid" ? `\nThe config file is unusable (${r.code}); the values above are defaults. Run \`review-loop config repair\`.\n` : "\n";
    // A default value already says where it came from; only a value from the file is marked.
    const set = (/** @type {string} */ src) => (src === "config" ? " (set in config)" : "");
    io.err(
      `preset: ${c.preset}${set(sources.preset)}\n` +
      `model:  ${c.codex.model ?? `inherit (${d.model ?? "Codex default"})`}${set(sources.model)}\n` +
      `effort: ${c.codex.effort ?? `inherit (${d.effort ?? "Codex default"})`} (${sources.effort === "config" ? "set in config; " : ""}display only; not sent to Codex)\n` +
      `rubric: ${c.rubricPath ?? "built-in"}${set(sources.rubric)}\n` +
      `events: ${c.events.path ?? "default"}${set(sources["events.path"])}\n` +
      `file:   ${configPath()} (${r.status})${problem}`
    );
    return { code: "ok" };
  }
  if (sub === "repair") {
    assertConfigOwner("config repair");
    const r = readConfig();
    if (r.status === "invalid" && r.code === "config_symlink_rejected") throw new CliError(r.code, "the review-loop config is a symlink; it is never followed or replaced");
    if (r.status === "ok") {
      io.err("config is valid; nothing to repair\n");
      return { code: "ok" };
    }
    if (r.status === "invalid") {
      const kept = quarantine(configPath(), path.dirname(configPath()));
      if (kept) io.err(`Kept the unreadable config as ${kept}\n`);
    }
    writeConfig(defaultConfig());
    io.err("config reset to defaults\n");
    return { code: "ok" };
  }
  if (sub !== "set" || !key || raw === undefined) throw new CliError("usage_bad_flag", `usage: review-loop config set <${KEYS}> <value|inherit|default>`);
  if (!KEYS.split("|").includes(key)) throw new CliError("usage_bad_flag", `unknown setting ${key.slice(0, 40)} (${KEYS})`);
  const cfg = structuredClone(requireUsableConfig().config);
  const v = raw === "inherit" || raw === "default" ? null : raw;
  if (key === "preset") {
    if (v !== null && !PRESET_NAMES.includes(v)) throw new CliError("usage_bad_flag", `unknown preset (${PRESET_NAMES.join(", ")})`);
    cfg.preset = /** @type {typeof cfg.preset} */ (v ?? "default");
  } else if (key === "model") cfg.codex.model = v;
  else if (key === "effort") cfg.codex.effort = v;
  else if (key === "rubric") {
    cfg.rubricPath = v === null ? null : path.resolve(v);
    if (cfg.rubricPath !== null) loadRubricSection(cfg.rubricPath);
  } else {
    cfg.events.path = v === null ? null : path.resolve(v);
    const why = cfg.events.path === null ? null : eventsPathProblem(cfg.events.path);
    if (why !== null) throw new CliError("events_path_rejected", `events.path refused: ${why.replaceAll("_", " ")}; nothing was changed`);
  }
  if (!isConfig(cfg)) {
    const allowed = key === "effort" ? `one of ${EFFORTS.join(", ")}, or inherit` : key === "model" ? "1–64 letters, digits or . _ : / - (no spaces), or inherit" : "see `review-loop config --help`";
    throw new CliError("usage_bad_flag", `invalid value for ${key}: ${allowed}`);
  }
  writeConfig(cfg);
  if (key === "rubric" || key === "events.path") io.err(`${key === "rubric" ? "rubric" : "events"}: ${key === "rubric" ? cfg.rubricPath : cfg.events.path ?? "default"}\n`);
  if (key === "rubric") io.err("Approvals given earlier stay valid; re-run the loop on an open PR to review it under the new rubric.\n");
  return { code: "ok" };
}
