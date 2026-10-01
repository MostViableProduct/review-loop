import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig } from "./config.mjs";
import { safeReadFile } from "./fsutil.mjs";
import { emitEvent } from "./events.mjs";

/**
 * P2 (mechanism=none, docs/probes/P2-2026-09-28.md): the companion's adversarial-review has no effort flag and turns an
 * unknown `--effort` into review focus text. Effort is display-only in v1 — resolved and recorded, never sent.
 * @param {string} _effort
 * @returns {string[]}
 */
const EFFORT_ARGS = (_effort) => [];

/**
 * Read-only view of Codex's own defaults. This product never writes under $CODEX_HOME (spec §5.3).
 * `refused` is true only when config.toml exists but could not be read (symlink, oversized, not a regular file);
 * an absent file is normal and silent.
 * @returns {{ model: string | null, effort: string | null, refused: boolean }}
 */
function readCodexDefaults() {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  /** @type {{ model: string | null, effort: string | null, refused: boolean }} */
  const out = { model: null, effort: null, refused: false };
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return out;
  let text;
  try {
    text = safeReadFile(file, 256 * 1024, { symlink: "codex_config_unreadable", missing: "codex_config_unreadable", tooLarge: "codex_config_unreadable", notFile: "codex_config_unreadable" }).toString("utf8");
  } catch {
    out.refused = true;
    return out;
  }
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break; // Only top-level keys: a [profile] table's `model` is not the default.
    const m = /^\s*(model|model_reasoning_effort)\s*=\s*"([^"]{1,64})"\s*(#.*)?$/.exec(line);
    if (m) out[m[1] === "model" ? "model" : "effort"] = m[2];
  }
  return out;
}

export function codexDefaults() {
  const { model, effort } = readCodexDefaults();
  return { model, effort };
}

/**
 * Resolve the model/effort for one round. Call ONCE per round and pass the result to both the companion call and the
 * round record. `model`/`effort` are what is RECORDED (may be inherited from Codex's config.toml); `passModel` is the only
 * model ever sent: review-loop's own `codex.model`, or null. An inherited model is never pinned explicitly.
 * @param {{ report?: boolean }} [opts] report: emit `config.invalid` with code codex_config_unreadable when config.toml exists but was refused (round path only)
 */
export function effectiveCodex(opts = {}) {
  const c = readConfig().config.codex;
  const d = readCodexDefaults();
  if (d.refused && opts.report === true) emitEvent({ source: "round", event: "config.invalid", code: "codex_config_unreadable" });
  if (c.model !== null || c.effort !== null) {
    return { model: c.model ?? d.model, effort: c.effort ?? d.effort, source: /** @type {const} */ ("config"), passModel: c.model };
  }
  return { model: d.model, effort: d.effort, source: /** @type {const} */ ("codex-inherited"), passModel: null };
}

/**
 * @param {string[]} base companion args up to (not including) target args and focus
 * @param {{ model: string | null, effort: string | null, source: "config" | "codex-inherited", passModel: string | null }} eff
 */
export function companionArgs(base, eff) {
  if (eff.source === "codex-inherited") return base;
  const out = [...base];
  if (eff.passModel) out.push("--model", eff.passModel);
  if (eff.effort) out.push(...EFFORT_ARGS(eff.effort));
  return out;
}
