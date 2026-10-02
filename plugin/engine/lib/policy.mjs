// Pure round/checkpoint/dispute logic. No I/O, so every paging path is unit-testable without Codex.
import { ReviewLoopError } from "./errors.mjs";
import { parseDimensionTag } from "./scoring.mjs";

export const EXIT = Object.freeze({
  PASS: 0,
  NEEDS_FIXES: 10,
  CHECKPOINT: 20,
  STALL: 21,
  HUMAN: 22,
  OP_ERROR: 30,
  PIN: 40,
  BUSY: 50
});

/** The one option set offered at every checkpoint / stall (plan v4+). */
const CHECKPOINT_OPTIONS = ["continue", "more", "accept", "stop"];

export const OPTIONS = Object.freeze({
  checkpoint: CHECKPOINT_OPTIONS,
  stall: CHECKPOINT_OPTIONS,
  dispute_deadlock: ["accept-finding", "waive", "stop"],
  plugin_pin: ["repin", "override", "stop"],
  criss_cross: ["merge", "override", "stop"],
  push_rejected: ["pull", "stop"],
  head_diverged: ["pull", "stop"]
});

export const OPTION_LABELS = Object.freeze({
  continue: "Continue until 9.2",
  more: "10 more rounds",
  accept: "Accept current score (logged override)",
  stop: "Stop — I'll take over",
  "accept-finding": "Accept the finding (Claude fixes it)",
  waive: "Waive it (logged override for this finding)",
  repin: "Show plugin diff and re-pin",
  override: "Override this artifact (logged)",
  merge: "Merge base into head (Claude does it, then the loop re-runs)",
  pull: "Pull remote changes and re-review (no force)"
});

/** @param {string} reason */
export function exitForAwaiting(reason) {
  if (reason === "checkpoint") return EXIT.CHECKPOINT;
  if (reason === "stall") return EXIT.STALL;
  if (reason === "plugin_pin") return EXIT.PIN;
  return EXIT.HUMAN;
}

/** @param {string} title */
function normTitle(title) {
  return (title ?? "")
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Same finding across rounds: same file (or both absent) and near-identical title.
 * @param {{ title: string, file?: string | null }} a
 * @param {{ title: string, file?: string | null }} b
 */
export function sameFinding(a, b) {
  if ((a.file ?? null) !== (b.file ?? null)) return false;
  const ta = normTitle(a.title);
  const tb = normTitle(b.title);
  if (ta === tb) return true;
  const wa = new Set(ta.split(" ").filter(Boolean));
  const wb = new Set(tb.split(" ").filter(Boolean));
  const inter = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && inter / union >= 0.6;
}

/**
 * A new loop starts when the artifact changed after a terminal outcome.
 * @param {ReturnType<typeof import("./state.mjs").newRecord>} rec
 * @param {string} fingerprint
 */
export function resetIfNewLoop(rec, fingerprint) {
  const terminal = rec.status === "passed" || rec.status === "overridden" || rec.status === "stopped";
  if (terminal && rec.reviewedFingerprint !== fingerprint) {
    Object.assign(rec, {
      status: "pending",
      round: 0,
      mode: "capped",
      nextCheckpoint: 10,
      uncappedStart: null,
      bestSumTenths: null,
      sinceImprovement: 0,
      history: [],
      disputes: [],
      waivers: [],
      awaiting: null,
      lastError: null,
      errorAttempts: 0
    });
    return true;
  }
  return false;
}

/**
 * @template {{ title: string, file?: string | null }} F
 * @param {F[]} findings
 * @param {Array<{ title: string, file?: string | null }>} waivers
 */
export function withoutWaived(findings, waivers) {
  return findings.filter((f) => !waivers.some((w) => sameFinding(f, w)));
}

/**
 * Fold one completed Codex round into the record and decide the next step.
 * @param {ReturnType<typeof import("./state.mjs").newRecord>} rec
 * @param {{ pass: boolean, dimensions: Array<{ name: string, tenths: number }>, sum: number }} scored
 * @param {Array<{ title: string, file?: string | null, severity: string }>} findings  already waiver-filtered
 * @param {string} fingerprint
 * @returns {number} exit code
 */
export function applyRoundResult(rec, scored, findings, fingerprint) {
  rec.round += 1;
  rec.fingerprint = fingerprint;
  rec.lastError = null;
  rec.errorAttempts = 0;
  const sumTenths = scored.dimensions.reduce((s, d) => s + d.tenths, 0);
  rec.history.push({
    round: rec.round,
    sumTenths,
    dims: Object.fromEntries(scored.dimensions.map((d) => [d.name, d.tenths])),
    findings: findings.length,
    at: new Date().toISOString()
  });

  // A dispute Codex drops is resolved; one it re-raises twice needs a human.
  rec.disputes = rec.disputes
    .map((d) => (findings.some((f) => sameFinding(f, d)) ? { ...d, raisedAgain: d.raisedAgain + 1 } : null))
    .filter((d) => d !== null);

  if (scored.pass) {
    rec.status = "passed";
    rec.reviewedFingerprint = fingerprint;
    rec.awaiting = null;
    return EXIT.PASS;
  }

  const deadlock = rec.disputes.find((d) => d.raisedAgain >= 2);
  if (deadlock) return awaitHuman(rec, "dispute_deadlock", { title: deadlock.title, file: deadlock.file ?? null });

  if (rec.mode === "capped") {
    if (rec.round >= rec.nextCheckpoint) return awaitHuman(rec, "checkpoint", { round: rec.round });
  } else {
    if (rec.bestSumTenths === null || sumTenths > rec.bestSumTenths) {
      rec.bestSumTenths = sumTenths;
      rec.sinceImprovement = 0;
    } else {
      rec.sinceImprovement += 1;
    }
    if (rec.sinceImprovement >= 3) return awaitHuman(rec, "stall", { round: rec.round });
    if (rec.uncappedStart !== null && rec.round >= rec.uncappedStart + 20) return awaitHuman(rec, "checkpoint", { round: rec.round });
  }
  rec.status = "needs_fixes";
  rec.awaiting = null;
  return EXIT.NEEDS_FIXES;
}

/**
 * @param {ReturnType<typeof import("./state.mjs").newRecord>} rec
 * @param {string} reason
 * @param {Record<string, unknown>} [detail]
 */
export function awaitHuman(rec, reason, detail = {}, fingerprint = rec.fingerprint ?? null) {
  const options = OPTIONS[/** @type {keyof typeof OPTIONS} */ (reason)];
  if (!options) throw new ReviewLoopError("unknown_page_reason", `no page options defined for "${reason}"`);
  rec.status = "awaiting_human";
  // The page is a decision about THIS fingerprint; accept/override later require the artifact to still be at it.
  rec.awaiting = { reason, detail, options: [...options], fingerprint };
  return exitForAwaiting(reason);
}

/**
 * Apply the human's page answer.
 * @param {ReturnType<typeof import("./state.mjs").newRecord>} rec
 * @param {string} option
 * @param {string | null} currentFingerprint
 */
export function applyDecision(rec, option, currentFingerprint) {
  if (rec.status !== "awaiting_human" || !rec.awaiting) {
    throw new ReviewLoopError("invalid_decision", "this artifact is not awaiting a decision");
  }
  const reason = rec.awaiting.reason;
  const allowed = OPTIONS[/** @type {keyof typeof OPTIONS} */ (reason)] ?? [];
  if (!allowed.includes(option)) {
    throw new ReviewLoopError("invalid_decision", `"${option}" is not an option for ${reason}; allowed: ${allowed.join(", ")}`);
  }
  if ((option === "accept" || option === "override") && (!currentFingerprint || rec.awaiting.fingerprint !== currentFingerprint)) {
    throw new ReviewLoopError("decision_stale", "the artifact changed since this page was shown (or its state is unknown); re-run the round for a current page");
  }
  const detail = /** @type {{ title?: string, file?: string | null }} */ (rec.awaiting.detail ?? {});
  rec.awaiting = null;
  switch (option) {
    case "continue": {
      rec.mode = "uncapped";
      rec.uncappedStart = rec.round;
      const last = rec.history[rec.history.length - 1];
      rec.bestSumTenths = last ? last.sumTenths : null;
      rec.sinceImprovement = 0;
      rec.status = "needs_fixes";
      break;
    }
    case "more":
      rec.mode = "capped";
      rec.nextCheckpoint = rec.round + 10;
      rec.status = "needs_fixes";
      break;
    case "accept":
    case "override":
      if (!currentFingerprint) throw new ReviewLoopError("invalid_decision", "cannot override: current fingerprint unknown");
      rec.status = "overridden";
      rec.reviewedFingerprint = currentFingerprint;
      break;
    case "stop":
      rec.status = "stopped";
      break;
    case "accept-finding":
      rec.disputes = rec.disputes.filter((d) => !sameFinding(d, { title: detail.title ?? "", file: detail.file ?? null }));
      rec.status = "needs_fixes";
      break;
    case "waive":
      rec.disputes = rec.disputes.filter((d) => !sameFinding(d, { title: detail.title ?? "", file: detail.file ?? null }));
      rec.waivers.push({ title: detail.title ?? "", file: detail.file ?? null, at: new Date().toISOString() });
      rec.status = "needs_fixes";
      break;
    case "repin":
    case "merge":
    case "pull":
      rec.status = "pending";
      break;
    default:
      throw new ReviewLoopError("invalid_decision", `unknown option ${option}`);
  }
  return reason;
}

/** @param {string} title */
export function dimensionOf(title) {
  return parseDimensionTag(title).dimension;
}
