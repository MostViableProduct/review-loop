import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pinFile } from "../../plugin/engine/lib/pin.mjs";
import { enginePath } from "./plugin.mjs";
import { CODES } from "../../plugin/engine/lib/codes.mjs";

/** @typedef {"codex_missing" | "codex_auth" | "plugin_missing" | "git_failed" | "pin_mismatch" | "model_invalid" | "effort_invalid" | "timeout" | "unparseable" | "unknown"} LiveDetail */

const PATTERNS = /** @type {Array<[RegExp, LiveDetail]>} */ ([
  [/ENOENT|codex: command not found/i, "codex_missing"],
  // 401 only as an HTTP status: the round output also carries a hex key and temp paths (/tmp/rl-e2e-401-x).
  [/not logged in|codex login|\b(?:HTTP|status|code)[\s:/]*401\b|\b401\s+unauthori[sz]ed|unauthori[sz]ed/i, "codex_auth"],
  [/plugin_pin_mismatch|companion_(contract|usage)_mismatch/, "pin_mismatch"],
  [/reasoning[_ ]effort|unknown variant .* effort/i, "effort_invalid"],
  [/model .*(does not exist|not found|not supported|unknown)|invalid model/i, "model_invalid"],
  [/codex_timeout|timed out/i, "timeout"],
  [/codex_output_invalid|could not parse/i, "unparseable"]
]);

/** One remedy per live-check detail (spec §6.4), from the code registry. @type {Readonly<Record<LiveDetail, string>>} */
export const LIVE_REMEDY = /** @type {Readonly<Record<LiveDetail, string>>} */ (CODES.live_check_failed.detailRemedies);

/** @param {string} text @returns {LiveDetail} */
export function classify(text) {
  for (const [re, d] of PATTERNS) if (re.test(text)) return d;
  return "unknown";
}

/**
 * A real round on a tiny fixture in a temp repo and temp state (the user's history stays clean), with the real pin.
 * Exit 10 (needs fixes) is a pass: the fixture deliberately has a finding, and the check proves the chain works.
 * Codex's output is returned as `text` for the terminal; it is never written to an event.
 * @param {import("./io.mjs").IO} io
 * @returns {Promise<{ ok: true } | { ok: false, detail: LiveDetail, text: string }>}
 */
export async function liveCheck(io) {
  const engine = await enginePath();
  if (!engine) return { ok: false, detail: "plugin_missing", text: "review-loop plugin not installed" };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rl-live-"));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "rl-live-state-"));
  try {
    const init = spawnSync("git", ["init", "-q"], { cwd: repo });
    if (init.error || init.status !== 0) return { ok: false, detail: "git_failed", text: "could not create the temporary git repository" };
    const doc = path.join(repo, "docs", "specs", "livecheck-design.md");
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL("../fixtures/livecheck-doc.md", import.meta.url)), doc);
    io.err("Running the live review…\n");
    const r = spawnSync(process.execPath, [path.join(engine, "review-round.mjs"), "run", "--kind", "spec", "--path", doc, "--project-root", repo], {
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: state, REVIEW_LOOP_PIN_FILE: pinFile() }, encoding: "utf8", timeout: 15 * 60_000
    });
    if (r.status === 0 || r.status === 10) return { ok: true };
    const text = `${r.stdout}\n${r.stderr}${r.error ? `\n${r.error.message}` : ""}`;
    /** @type {LiveDetail} */
    const detail = r.status === 40 ? "pin_mismatch" : r.error && /ETIMEDOUT/.test(String(r.error)) ? "timeout" : classify(text);
    return { ok: false, detail, text };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
}
