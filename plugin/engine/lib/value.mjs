// Value triage (spec D2, D3, D6): the value enums with their one-line definitions, the VALUE trailer parser, the
// blocking classifier and a round's counts. Pure: no I/O, so every rule is unit-testable without Codex.
import { DIMENSIONS, SEVERITIES, parseDimensionTag } from "./scoring.mjs";

export const LIKELIHOODS = Object.freeze(["real_path", "plausible", "requires_misconfig", "requires_out_of_model_actor", "theoretical"]);
export const IMPACTS = Object.freeze(["money_or_data", "security", "user_visible", "operator_visible", "none"]);
export const FIX_COSTS = Object.freeze(["trivial", "small", "design"]);
// An allowlist: no entry names an end user, a member or the public, so no wording can take them out of the threat
// model. Adding an entry is a reviewed code change (spec D1).
export const TRUSTED_ACTORS = Object.freeze(["maintainers", "admins", "operators", "ci_runner", "deploy_pipeline", "hosting_provider", "same_user_processes"]);

/** @type {Readonly<Record<string, string>>} */
export const SEVERITY_TEXT = Object.freeze({
  critical: "exploitable security, data loss, irreversible harm, or a core deliverable non-functional",
  high: "a stated requirement unmet, or a wrong result on a real path",
  medium: "a real defect, bounded or edge-triggered",
  low: "defensive, polish, or rare and bounded, with no user-visible harm"
});
/** @type {Readonly<Record<string, string>>} */
export const LIKELIHOOD_TEXT = Object.freeze({
  real_path: "normal use hits it",
  plausible: "an ordinary mistake or race that a real user or operator could cause",
  requires_misconfig: "only with a configuration the docs don't support",
  requires_out_of_model_actor: "needs an actor the operating context lists as trusted; never an unauthenticated user or another member",
  theoretical: "no concrete trigger"
});
/** @type {Readonly<Record<string, string>>} */
export const IMPACT_TEXT = Object.freeze({
  money_or_data: "money is lost or charged wrongly, or data is lost, corrupted or exposed",
  security: "an access, secret or integrity boundary is crossed",
  user_visible: "an end user sees a wrong result or a failure",
  operator_visible: "only an operator or maintainer sees it (logs, tooling, CI)",
  none: "no one is affected"
});
/** @type {Readonly<Record<string, string>>} */
export const FIX_COST_TEXT = Object.freeze({
  trivial: "a line or two",
  small: "a contained change in one place",
  design: "a design change across modules"
});
/** @type {Readonly<Record<string, string>>} */
export const TRUSTED_ACTOR_TEXT = Object.freeze({
  maintainers: "the project's own developers",
  admins: "the application's administrators",
  operators: "the people who run the deployment",
  ci_runner: "the CI system running the project's own workflows",
  deploy_pipeline: "the project's own deploy tooling",
  hosting_provider: "the platform the project runs on",
  same_user_processes: "other processes running as the same OS user"
});

/** Spec D3, in order: the first rule that matches decides. The docs' triage table is generated from this. */
export const RULES = Object.freeze([
  { why: "critical", blocking: true, when: "severity is critical" },
  { why: "unvalued", blocking: true, when: "the finding has no valid VALUE line" },
  { why: "accepted_risk", blocking: false, when: "it cites an accepted risk whose dimension and class both equal its own" },
  { why: "money_data_security", blocking: true, when: "impact is money_or_data or security, and likelihood is real_path, plausible or requires_misconfig" },
  { why: "repeat_class", blocking: false, when: "its dimension and class were raised in an earlier round, and likelihood is not real_path" },
  { why: "realistic", blocking: true, when: "severity is high or medium, and likelihood is real_path or plausible" },
  { why: "low_value", blocking: false, when: "anything else" }
]);
export const WHYS = Object.freeze(RULES.map((r) => r.why));
const BLOCKING = Object.freeze(Object.fromEntries(RULES.map((r) => [r.why, r.blocking])));
const HARMS = new Set(["money_or_data", "security"]);

/**
 * @typedef {{ likelihood: string, impact: string, fix_cost: string, class: string, actor: string, accepted_risk: string, trigger: string }} Value
 * @typedef {{ ok: true, value: Value } | { ok: false, reason: "missing" | "bad_likelihood" | "bad_impact" | "bad_fix_cost" | "bad_class" | "bad_actor" | "bad_trigger" | "bad_accepted_risk" }} ParsedValue
 * @typedef {{ dimension: string, classKey: string, text: string }} AcceptedRisk
 * @typedef {{ trustedActors: ReadonlySet<string>, acceptedRisks: ReadonlyMap<string, AcceptedRisk>, priorClasses: ReadonlySet<string> }} TriageContext
 * @typedef {{ actorNotTrusted: boolean, theoreticalFloored: boolean, unknownAcceptedRisk: boolean, acceptedRiskOutOfScope: boolean }} TriageFlags
 * @typedef {{ blocking: boolean, why: string, likelihood: string | null, flags: TriageFlags }} Triage
 * @typedef {{ severity: string, dimension: string, value: Value | null, triage: Triage }} TriageRow
 * @typedef {{ blocking: number, advisory: number, unvalued: number, why: Record<string, number>, likelihoods: Array<string | null> }} HistoryTriage
 */

/** @param {string} s */
export function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A class is scoped to its dimension: the same words under two dimensions are two classes (spec D4). */
export function classKey(/** @type {string} */ dimension, /** @type {string} */ label) {
  return `${dimension}:${normalizeLabel(label)}`;
}

const TRAILER = /^VALUE likelihood=([^;]*); impact=([^;]*); fix_cost=([^;]*); class=([^;]*); actor=([^;]*); accepted_risk=([^;]*); trigger=(.*)$/;

/**
 * Only the body's last non-empty line is read: a VALUE line Codex quotes mid-body is not the finding's own.
 * @param {string | undefined} body
 * @returns {ParsedValue}
 */
export function parseValue(body) {
  const lines = String(body ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines.length ? lines[lines.length - 1] : "";
  const m = TRAILER.exec(last);
  if (!m) return { ok: false, reason: "missing" };
  const [likelihood, impact, fixCost, cls, actor, acceptedRisk, trigger] = m.slice(1).map((s) => s.trim());
  if (!LIKELIHOODS.includes(likelihood)) return { ok: false, reason: "bad_likelihood" };
  if (!IMPACTS.includes(impact)) return { ok: false, reason: "bad_impact" };
  if (!FIX_COSTS.includes(fixCost)) return { ok: false, reason: "bad_fix_cost" };
  if (cls.length < 3 || cls.length > 80) return { ok: false, reason: "bad_class" };
  if (actor !== "none" && (actor.length < 2 || actor.length > 60)) return { ok: false, reason: "bad_actor" };
  if (acceptedRisk !== "none" && !/^AR-\d{1,3}$/.test(acceptedRisk)) return { ok: false, reason: "bad_accepted_risk" };
  if (trigger.length < 1 || trigger.length > 240) return { ok: false, reason: "bad_trigger" };
  return { ok: true, value: { likelihood, impact, fix_cost: fixCost, class: cls, actor, accepted_risk: acceptedRisk, trigger } };
}

/**
 * Blocking or advisory (spec D3). Codex's labels pass through two engine-side floors first, so the owner's inputs,
 * not Codex's word, decide who is out of scope and when a security, money or data finding may stop blocking.
 * @param {{ severity: string, title: string, value: Value | null }} finding
 * @param {TriageContext} ctx
 * @returns {Triage}
 */
export function classify(finding, ctx) {
  const v = finding.value;
  // parseValue admits no other value, so one here is a bug in the caller: fail loudly rather than fall through.
  if (!SEVERITIES.includes(finding.severity)) throw new TypeError(`classify: unknown severity ${JSON.stringify(finding.severity)}`);
  if (v !== null && (!LIKELIHOODS.includes(v.likelihood) || !IMPACTS.includes(v.impact) || !FIX_COSTS.includes(v.fix_cost))) throw new TypeError("classify: a value outside the enums");
  const dimension = parseDimensionTag(finding.title).dimension;
  /** @type {TriageFlags} */
  const flags = { actorNotTrusted: false, theoreticalFloored: false, unknownAcceptedRisk: false, acceptedRiskOutOfScope: false };
  let likelihood = v ? v.likelihood : null;
  if (v && likelihood === "requires_out_of_model_actor" && !ctx.trustedActors.has(normalizeLabel(v.actor))) {
    likelihood = "plausible";
    flags.actorNotTrusted = true;
  }
  if (v && likelihood === "theoretical" && HARMS.has(v.impact)) {
    likelihood = "plausible";
    flags.theoreticalFloored = true;
  }
  const done = (/** @type {string} */ why) => ({ blocking: BLOCKING[why], why, likelihood, flags });
  if (finding.severity === "critical") return done("critical");
  if (!v) return done("unvalued");
  const key = classKey(dimension, v.class);
  if (v.accepted_risk !== "none") {
    const ar = ctx.acceptedRisks.get(v.accepted_risk);
    if (!ar) flags.unknownAcceptedRisk = true;
    else if (ar.dimension === dimension && ar.classKey === key) return done("accepted_risk");
    else flags.acceptedRiskOutOfScope = true;
  }
  if (HARMS.has(v.impact) && (likelihood === "real_path" || likelihood === "plausible" || likelihood === "requires_misconfig")) return done("money_data_security");
  if (ctx.priorClasses.has(key) && likelihood !== "real_path") return done("repeat_class");
  if ((finding.severity === "high" || finding.severity === "medium") && (likelihood === "real_path" || likelihood === "plausible")) return done("realistic");
  return done("low_value");
}

/** @param {readonly string[]} keys */
const zeros = (keys) => /** @type {Record<string, number>} */ (Object.fromEntries(keys.map((k) => [k, 0])));

/**
 * One round's counts: the history entry's `triage` (spec "State changes") and the `round.result` fields (spec D7).
 * `unvalued` counts every finding with no valid VALUE line, whichever rule decided it.
 * @param {TriageRow[]} rows
 */
export function triageCounts(rows) {
  const why = zeros(WHYS);
  const likelihoods = zeros([...LIKELIHOODS, "none"]);
  const impacts = zeros([...IMPACTS, "none"]);
  const severities = zeros(SEVERITIES);
  const dimensions = zeros(DIMENSIONS);
  const advisoryDimensions = zeros(DIMENSIONS);
  const flags = { actor_not_trusted: 0, theoretical_floored: 0, unknown_accepted_risk: 0, accepted_risk_out_of_scope: 0 };
  /** @type {Array<string | null>} */
  const blockingLikelihoods = [];
  let blocking = 0;
  let unvalued = 0;
  for (const r of rows) {
    why[r.triage.why] += 1;
    likelihoods[r.triage.likelihood ?? "none"] += 1;
    impacts[r.value?.impact ?? "none"] += 1;
    severities[r.severity] += 1;
    dimensions[r.dimension] += 1;
    if (r.value === null) unvalued += 1;
    if (r.triage.blocking) {
      blocking += 1;
      blockingLikelihoods.push(r.triage.likelihood);
    } else advisoryDimensions[r.dimension] += 1;
    if (r.triage.flags.actorNotTrusted) flags.actor_not_trusted += 1;
    if (r.triage.flags.theoreticalFloored) flags.theoretical_floored += 1;
    if (r.triage.flags.unknownAcceptedRisk) flags.unknown_accepted_risk += 1;
    if (r.triage.flags.acceptedRiskOutOfScope) flags.accepted_risk_out_of_scope += 1;
  }
  const advisory = rows.length - blocking;
  return {
    /** @type {HistoryTriage} */
    history: { blocking, advisory, unvalued, why, likelihoods: blockingLikelihoods },
    event: {
      blocking, advisory, unvalued,
      ...Object.fromEntries(WHYS.map((w) => [`why_${w}`, why[w]])),
      ...flags,
      likelihoods, impacts, severities, dimensions, advisory_dimensions: advisoryDimensions
    }
  };
}
