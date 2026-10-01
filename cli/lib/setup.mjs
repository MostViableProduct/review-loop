import { CliError } from "./errors.mjs";
import { runPreflight } from "./preflight.mjs";
import { installedPlugin, installPlugin, PLUGIN_ID, sameMinor } from "./plugin.mjs";
import { liveCheck, LIVE_REMEDY } from "./livecheck.mjs";
import { ASK_RULES, missingAskRules, updateSettings } from "./settings.mjs";
import path from "node:path";
import { assertConfigOwner, ownerSeam } from "./configguard.mjs";
import { quarantine } from "../../plugin/engine/lib/fsutil.mjs";
import { readConfig, configPath, writeConfig, PRESET_NAMES, EFFORTS, MODEL_RE } from "../../plugin/engine/lib/config.mjs";
import { codexDefaults } from "../../plugin/engine/lib/codexcfg.mjs";
import { latestInstalledVersion, readPin, writePin, verifyPin } from "../../plugin/engine/lib/pin.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";
import { PACKAGE_VERSION } from "../../plugin/engine/lib/events.mjs";

const PRESET_COPY = {
  default: "Claude can't finish, or open a PR, until Codex approves the change. Recommended.",
  balanced: "Claude is reminded to get Codex review, and PRs still require approval.",
  advisory: "Reviews run when Claude chooses to. You get reminders, nothing is blocked — including merges of unreviewed PRs, unless your repo requires the review-loop check."
};

export const seams = ownerSeam;

/** A flag given without a value is a usage error, never "not given". @param {string[]} args @param {string} name */
function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new CliError("usage_bad_flag", `${name} needs a value`);
  return v;
}

/** Names and counts only, never file contents. @param {unknown} details */
function driftSummary(details) {
  const d = /** @type {Record<string, unknown>} */ (typeof details === "object" && details !== null ? details : {});
  const part = (/** @type {string} */ k) => {
    const list = Array.isArray(d[k]) ? d[k].filter((x) => typeof x === "string") : [];
    return list.length ? `${k} ${list.length} (${list.slice(0, 10).join(", ")}${list.length > 10 ? ", …" : ""})` : "";
  };
  return [part("changed"), part("removed"), part("added")].filter(Boolean).join("; ");
}

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
export async function run(args, io, ctx) {
  if (process.env.REVIEW_LOOP_TEST_SEAMS === "1" && process.env.REVIEW_LOOP_TEST_WAIT_BEFORE_PROMPT) await new Promise((r) => setTimeout(r, 5000));
  if (!io.isTTY && !ctx.yes) throw new CliError("usage_noninteractive", "setup needs a terminal, or --yes");
  const done = /** @type {string[]} */ ([]);
  const steps = ["preflight", "preset", "model/effort", "plugin", "approval rules", "pin", "live check"];
  const confirm = async (/** @type {string} */ will, /** @type {string} */ why) => {
    io.err(`\nWill: ${will}\nWhy:  ${why}\n`);
    if (ctx.yes) return;
    if (!(await io.ask("Go ahead?", true))) {
      io.err(`\nDone: ${done.join(", ") || "nothing"}\nNot done: ${steps.filter((s) => !done.includes(s)).join(", ")}\nRe-run \`review-loop setup\` any time; finished steps are kept.\n`);
      throw new CliError("cancelled", "cancelled");
    }
  };

  // Validate flags before any tool runs or anything is installed.
  assertConfigOwner("setup");
  const read = readConfig();
  if (read.status === "invalid" && read.code === "config_symlink_rejected") throw new CliError(read.code, "the review-loop config is a symlink; setup never follows it");
  const cfg = read.config;
  const wantPreset = flag(args, "--preset");
  if (wantPreset !== null && !PRESET_NAMES.includes(wantPreset)) throw new CliError("usage_bad_flag", `--preset must be one of ${PRESET_NAMES.join(", ")}`);
  const model = flag(args, "--model") ?? cfg.codex.model;
  const effort = flag(args, "--effort") ?? cfg.codex.effort;
  if (model !== null && !MODEL_RE.test(model)) throw new CliError("usage_bad_flag", "--model: letters, digits and . _ : / - only (max 64)");
  if (effort !== null && !EFFORTS.includes(effort)) throw new CliError("usage_bad_flag", `--effort must be one of ${EFFORTS.join(", ")}`);

  // 1 preflight
  if (!(await runPreflight(io, ctx))) throw new CliError("preflight_failed", "a required tool is missing or signed out");
  done.push("preflight");

  // 2 preset (recorded as done only once the step-3 save succeeds: the preset is saved there)
  const preset = wantPreset ?? (ctx.yes ? cfg.preset : await io.choose(`Preset?\n  default:  ${PRESET_COPY.default}\n  balanced: ${PRESET_COPY.balanced}\n  advisory: ${PRESET_COPY.advisory}\n`, [...PRESET_NAMES], cfg.preset));

  // 3 model/effort (inherit = null; Codex's own config is read, never written). Effort is display-only (R-P2):
  // it is stored for `config show` but never passed to Codex.
  const d = codexDefaults();
  io.err(`Codex model/effort: ${model ?? `inherit (Codex currently: ${d.model ?? "its default"})`} / ${effort ?? `inherit (${d.effort ?? "its default"})`}\n`);
  const next = { ...cfg, preset: /** @type {typeof cfg.preset} */ (preset), codex: { model, effort } };
  if (read.status === "invalid") {
    io.err(`Config problem: ${read.code}\n`);
    await confirm(`replace the unreadable review-loop config with preset "${preset}" and model/effort`, "the current file cannot be read, so reviews would silently use defaults; the old file is kept beside it as config.json.corrupt-<timestamp>");
    const kept = quarantine(configPath(), path.dirname(configPath()));
    if (kept) io.err(`Kept the unreadable config as ${kept}\n`);
    writeConfig(next);
  } else if (JSON.stringify(next) !== JSON.stringify(cfg)) {
    await confirm(`save preset "${preset}" and model/effort to review-loop's config`, "so every review uses these settings");
    writeConfig(next);
  }
  done.push("preset", "model/effort");

  // 4 plugin
  // User scope only: a project- or local-scope install leaves every other project without the hooks.
  const existing = await installedPlugin(PLUGIN_ID, undefined, "user");
  if (!existing || !existing.enabled) {
    await confirm("install the review-loop plugin into Claude Code (user scope)", "the plugin carries the hooks that enforce review");
    await installPlugin();
  }
  const installed = await installedPlugin(PLUGIN_ID, undefined, "user");
  if (!installed || !installed.enabled) throw new CliError("plugin_install_failed", "the plugin is not listed as enabled at user scope after install");
  if (installed.version && !sameMinor(installed.version, PACKAGE_VERSION)) io.err(`Note: plugin ${installed.version} vs CLI ${PACKAGE_VERSION} — run \`review-loop update\`\n`);
  done.push("plugin");

  // 5 approval rules
  await updateSettings((o) => {
    const perms = /** @type {Record<string, unknown>} */ (o.permissions ??= {});
    const ask = /** @type {string[]} */ (Array.isArray(perms.ask) ? perms.ask : (perms.ask = []));
    const missing = missingAskRules(o);
    ask.push(...missing);
    return missing.length > 0;
  }, { io, yes: ctx.yes, preview: true, confirm: () => confirm(`add ${ASK_RULES.length} approval rules to ~/.claude/settings.json (a backup is kept)`, "so overrides and the kill switch always ask you first") });
  done.push("approval rules");

  // 6 pin
  const version = latestInstalledVersion();
  if (readPin() === null) {
    await confirm(`pin Codex plugin ${version}`, "so a silent Codex plugin change pages you instead of changing reviews");
    writePin(version);
  } else {
    try {
      verifyPin();
    } catch (err) {
      // Only a drift is handled here; any other failure propagates and never re-pins.
      if (!(err instanceof ReviewLoopError && err.code === "plugin_pin_mismatch")) throw err;
      const summary = driftSummary(err.details) || err.message;
      if (ctx.yes) throw new CliError("plugin_pin_mismatch", `the Codex plugin differs from the pin (${summary}); run \`review-loop setup\` without --yes to review and re-pin`);
      await confirm(`re-pin Codex plugin ${version}; it differs from the pinned copy: ${summary}`, "the pinned copy is what reviews are allowed to run; only re-pin a change you trust");
      writePin(version);
    }
  }
  done.push("pin");

  // 7 live check
  if (args.includes("--skip-live-check")) {
    io.err("\nSetup complete — NOT verified (live check skipped). Run `review-loop doctor --live` to verify.\nRestart Claude Code to load the plugin.\n");
    return { code: "setup_complete_unverified" };
  }
  await confirm("run one real Codex review (usually 2–8 minutes)", "billed to your OpenAI/ChatGPT account; reviews send changed files and repo context to OpenAI under your account");
  const live = await liveCheck(io);
  if (!live.ok) {
    io.err(`\nLive check failed (${live.detail}). Fix: ${LIVE_REMEDY[live.detail]}\n${live.text.slice(-2000)}\n`);
    throw new CliError("live_check_failed", "the live Codex review failed", live.detail);
  }
  done.push("live check");
  io.err("\nSetup complete and verified. Restart Claude Code to load the plugin.\n");
  return { code: "ok" };
}
