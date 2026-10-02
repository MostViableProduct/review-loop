import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReviewLoopError } from "./errors.mjs";
import { PRESET_NAMES } from "./presets.mjs";
import { assertOwnLinks, atomicWriteJson, isObject, safeReadFile } from "./fsutil.mjs";

export { PRESET_NAMES };
export const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
export const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh"]);
export const CONFIG_MAX_BYTES = 64 * 1024;

/**
 * @typedef {{ version: 1, preset: "default" | "balanced" | "advisory", codex: { model: string | null, effort: string | null },
 *   rubricPath: string | null, events: { path: string | null } }} Config
 */

/** @returns {Config} */
export function defaultConfig() {
  return { version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } };
}

export function configPath() {
  const override = process.env.REVIEW_LOOP_CONFIG;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "review-loop", "config.json");
}

const CONFIG_LINKS = { code: "config_dir_untrusted", what: "the review-loop config folder", consequence: "the config is never read or written through it" };

/**
 * The config's folder is checked for the same reason as the plans folder (author's decision, round 20): safeReadFile's
 * O_NOFOLLOW and atomicWriteJson's `within` guard only below the folder, so a linked folder would carry every read
 * and replace wherever the link points. The folder itself is never a link; a link above it (a dotfiles ~/.config)
 * must be yours or root's through every hop; the folder must be yours or root's. An absent folder still has its
 * path checked: a write creates it through that path.
 * @param {string} [dir]
 * @param {number} [uid] the owner to trust besides root: this process's user
 */
export function assertConfigDir(dir = path.dirname(configPath()), uid = typeof process.getuid === "function" ? process.getuid() : -1) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st !== undefined && (st.isSymbolicLink() || !st.isDirectory())) throw new ReviewLoopError("config_dir_untrusted", `${dir} is a symlink or not a directory; ${CONFIG_LINKS.consequence}`);
  assertOwnLinks(path.dirname(path.resolve(dir)), uid, CONFIG_LINKS);
  if (st !== undefined && st.uid !== uid && st.uid !== 0) throw new ReviewLoopError("config_dir_untrusted", `${dir} belongs to another user; ${CONFIG_LINKS.consequence}`);
}

/** @param {unknown} v @param {(x: unknown) => boolean} ok */
const nullOr = (v, ok) => v === null || ok(v);
/** @param {unknown} p */
const absPath = (p) => typeof p === "string" && path.isAbsolute(p);

/** @param {unknown} v @returns {v is Config} */
export function isConfig(v) {
  if (!isObject(v) || v.version !== 1 || typeof v.preset !== "string" || !PRESET_NAMES.includes(v.preset)) return false;
  if (!isObject(v.codex) || !isObject(v.events)) return false;
  return (
    nullOr(v.codex.model, (m) => typeof m === "string" && MODEL_RE.test(m)) &&
    nullOr(v.codex.effort, (e) => typeof e === "string" && EFFORTS.includes(e)) &&
    nullOr(v.rubricPath, absPath) &&
    nullOr(v.events.path, absPath)
  );
}

/**
 * Read on every hook invocation, so it never mutates the file: quarantine belongs to `config repair` and setup.
 * @returns {{ status: "ok" | "absent", config: Config } | { status: "invalid", config: Config, code: "config_invalid" | "config_symlink_rejected" | "config_dir_untrusted" }}
 */
export function readConfig() {
  let raw;
  try {
    assertConfigDir();
    raw = safeReadFile(configPath(), CONFIG_MAX_BYTES, { missing: "config_missing", symlink: "config_symlink_rejected", tooLarge: "config_invalid", notFile: "config_invalid" });
  } catch (err) {
    const code = err instanceof ReviewLoopError ? err.code : "config_invalid";
    if (code === "config_missing") return { status: "absent", config: defaultConfig() };
    return { status: "invalid", config: defaultConfig(), code: code === "config_symlink_rejected" || code === "config_dir_untrusted" ? code : "config_invalid" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: "invalid", config: defaultConfig(), code: "config_invalid" };
  }
  return isConfig(parsed) ? { status: "ok", config: parsed } : { status: "invalid", config: defaultConfig(), code: "config_invalid" };
}

/** @param {Config} config */
export function writeConfig(config) {
  if (!isConfig(config)) throw new ReviewLoopError("config_invalid", "refusing to write an invalid config");
  const file = configPath();
  assertConfigDir(path.dirname(file));
  // `within` is the review-loop dir itself: ensurePrivateDir chmods every dir from `within` down, and ~/.config is not ours.
  atomicWriteJson(file, config, path.dirname(file));
}
