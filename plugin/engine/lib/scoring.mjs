// Implements rules/multi-dimension-review.md "Scoring: severity sets the band".
// All arithmetic is in integer tenths so "≥ 9.2" can never flip on float drift.

export const DIMENSIONS = Object.freeze([
  "Correctness",
  "Safety",
  "Reliability",
  "Observability",
  "Verifiability",
  "Efficiency",
  "Performance",
  "Simplicity",
  "Maintainability",
  "Coherence",
  "Usability"
]);

export const SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);

/** Band limits and per-extra-finding step, in tenths. */
export const BANDS = Object.freeze({
  critical: { min: 10, top: 49, step: 5 },
  high: { min: 50, top: 69, step: 4 },
  medium: { min: 70, top: 84, step: 3 },
  low: { min: 85, top: 91, step: 2 }
});

export const CLEAN_TENTHS = 95;
export const PASS_TENTHS = 92;

const RANK = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * @typedef {{ severity: "critical"|"high"|"medium"|"low", title: string, body?: string, file?: string,
 *   line_start?: number, line_end?: number, confidence?: number, recommendation?: string }} Finding
 * @typedef {{ name: string, tenths: number, score: number, worst: string | null, count: number }} DimensionScore
 */

/**
 * Untagged or unknown tags are never dropped: they count under Correctness.
 * @param {string} title
 */
export function parseDimensionTag(title) {
  const m = /^\s*\[\s*([A-Za-z]+)\s*\]\s*/.exec(title ?? "");
  const match = m ? DIMENSIONS.find((d) => d.toLowerCase() === m[1].toLowerCase()) : undefined;
  return match ? { dimension: match, tagged: true } : { dimension: "Correctness", tagged: false };
}

/**
 * @param {Finding[]} findings
 */
export function scoreFindings(findings) {
  /** @type {Map<string, Finding[]>} */
  const byDim = new Map(DIMENSIONS.map((d) => [d, []]));
  let untagged = 0;
  for (const f of findings) {
    const { dimension, tagged } = parseDimensionTag(f.title);
    if (!tagged) untagged += 1;
    byDim.get(dimension)?.push(f);
  }

  /** @type {DimensionScore[]} */
  const dimensions = DIMENSIONS.map((name) => {
    const list = byDim.get(name) ?? [];
    if (list.length === 0) return { name, tenths: CLEAN_TENTHS, score: CLEAN_TENTHS / 10, worst: null, count: 0 };
    const worst = list.reduce((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), /** @type {Finding["severity"]} */ ("low"));
    const band = BANDS[worst];
    const tenths = Math.min(band.top, Math.max(band.min, band.top - band.step * (list.length - 1)));
    return { name, tenths, score: tenths / 10, worst, count: list.length };
  });

  const sumTenths = dimensions.reduce((s, d) => s + d.tenths, 0);
  // Pass: mean ≥ 9.2 AND every dimension ≥ 9.2 — the weakest dimension binds the gate.
  const pass = dimensions.every((d) => d.tenths >= PASS_TENTHS) && sumTenths >= PASS_TENTHS * DIMENSIONS.length;
  const overall = Math.round(sumTenths / DIMENSIONS.length) / 10;
  return {
    dimensions,
    sum: sumTenths / 10,
    overall,
    meanExact: sumTenths / DIMENSIONS.length / 10,
    pass,
    untagged,
    arithmetic: `${(sumTenths / 10).toFixed(1)} / ${DIMENSIONS.length} = ${(sumTenths / DIMENSIONS.length / 10).toFixed(2)} → ${overall.toFixed(1)}`
  };
}
