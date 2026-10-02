// Enforcement per preset (spec §5.2, §7.1). The review bar is the same in every preset; only enforcement differs.
export const PRESETS = Object.freeze({
  default: Object.freeze({ stop: "block", pr: "deny", prompt: "inject", prverify: "stop", merge: "deny" }),
  balanced: Object.freeze({ stop: "warn", pr: "deny", prompt: "inject", prverify: "stop", merge: "deny" }),
  advisory: Object.freeze({ stop: "warn", pr: "warn", prompt: "inject", prverify: "warn", merge: "warn" })
});

/** The one list of preset names; config validation and the event schema derive from it. */
export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/**
 * The one Advisory rewording of a deny: Advisory allows the call, so it must not read like enforcement. It drops the
 * "retry", "fails closed" and kill-switch wording. Shared by the PR gate (hook) and the merge gate.
 * @param {string} msg
 */
export function advisoryText(msg) {
  return `⚠ review-loop (Advisory): ${msg.replace(/(?:[,;] then retry(?: the PR| the merge)?|; it fails closed|; fix the error or use the kill switch)$/, "")} — allowed under Advisory`;
}

/**
 * @param {string} preset
 * @param {"stop" | "pr" | "prompt" | "prverify" | "merge"} gate
 * @param {boolean} pending
 * @returns {"block" | "deny" | "stop" | "warn" | "inject" | "allow"}
 */
export function gateOutcome(preset, gate, pending) {
  if (!pending) return "allow";
  const table = Object.hasOwn(PRESETS, preset) ? PRESETS[/** @type {keyof typeof PRESETS} */ (preset)] : PRESETS.default;
  return table[gate];
}
