# Real-path lows and an advisory report cap — design

Status: draft for review. Target release: 1.2.0, on top of value triage (1.1.0,
`docs/superpowers/specs/2026-10-10-value-triage-design.md`, "value triage" below). Owner decisions (2026-10-29): a
`low` finding on a real path blocks the gate; a round reports at most 5 advisory findings, plus the first finding for
each accepted risk (`AR-n`) that downgraded a finding, meaning one the engine classified `why: accepted_risk` (D2). The
owner chose that over a hard total cap of 5, so the owner-written text of every accepted risk that downgraded a
finding stays visible. The report is bounded by 5 plus the number of `AR-n`
lines in the context file, not by the number of findings.

## Problem

Value triage (1.1.0) made every `low` finding advisory unless it harms money, data or security (value triage D3,
"A `low` finding no longer blocks on its own"). Two things followed in use:

1. **A defect that normal use hits can pass unfixed.** A `low` finding whose likelihood is `real_path` ("normal use
   hits it") sets no band, so a dimension with only such findings scores 9.5 and the gate passes. Polish and
   defensive gaps on the main path are exactly what the owner wants fixed before a pass.
2. **The advisory list is unbounded.** Every advisory finding is reported with its body, recommendation and VALUE
   line. A round that raises 20 theoretical findings produces a long report the author must read to find the few
   that matter, even though none of them blocks.

## Outcome

- A `low` finding whose effective likelihood is `real_path` blocks, with `why: real_path_low`, in every review round run
  under 1.2.0. An artifact already passed under 1.1.0 stays passed until its bytes or context change (Rollout; owner
  decision 2026-10-29: passes bind the artifact and its context, not the triage policy). Everything else value triage
  decides stays as it is.
- A round reports every blocking finding, one advisory finding for each accepted risk that downgraded a finding, and at most 5 other advisory ones, chosen by a
  fixed order. The counts always cover all findings, so nothing is hidden silently: the report says how many
  advisory findings it left out.

## Non-negotiables

- No blocking finding is ever omitted from the report, whatever the cap. The cap applies to advisory findings only.
- The cap changes presentation, not scoring: `classify` and the record's `lastFindings` see every finding, and
  `scoreFindings` receives only the blocking rows (as in value triage), so advisory findings, shown or omitted, never
  move a score. A finding left out of the report is still advisory and still counted, but it is **not** entered in the
  class summary: that summary (value triage D4) is what makes a later finding of the same class `repeat_class`, and a
  class the author never saw must not downgrade a later finding. The summary keeps value triage's `CLASS_CAP` (the 50
  most recently raised classes, `policy.mjs`); this spec does not change that bound.
- `real_path_low` never overrides an earlier rule. Rules 1–5 of value triage D3 run first, so an accepted risk
  (rule 3) still downgrades a real-path low, and a critical or money/data/security finding keeps its own `why`.

## Supersedes

This spec amends two statements in value triage and changes both in the same release, so no document is left
saying the old thing:

- Outcome (line 32): "Every other finding is still reported, recorded and counted". After this change an advisory
  finding is always **recorded and counted**, and is **reported in full** only while it is within the cap (D2).
- Non-negotiable (line 42): "Advisory findings are never dropped silently. Each one appears in full (title, body,
  value, why) in the round's output". The part that survives is "never silently": an omitted advisory finding is
  counted in `advisory_omitted` in the result and the event, and the skill tells the user how many were left out.
  The "each one appears in full" part is replaced by the cap.

The amendment is made in place: value triage gets a one-line "Amended by 1.2.0" note under each statement, pointing here
(a change to a shipped spec's wording, with no change to its other contents). Verification item 9 pins that the two specs,
`SKILL.md`, `README.md` and `docs/TROUBLESHOOTING.md` state the same retention policy.

## Design

### D1. Rule `real_path_low` in `classify`

`RULES` in `value.mjs` gains one row, placed after `realistic`:

| # | Condition | Result | `why` |
|---|---|---|---|
| 1–6 | unchanged from value triage D3 | | |
| 7 | severity `low`, and effective likelihood `real_path` | blocking | `real_path_low` |
| 8 | anything else | advisory | `low_value` (was rule 7) |

`classify` adds the matching line before `return done("low_value")`:

```js
if (finding.severity === "low" && likelihood === "real_path") return done("real_path_low");
```

`WHYS` and `BLOCKING` derive from `RULES`, so `triageCounts` gets a `real_path_low` entry and the `round.result`
event gains `why_real_path_low` with no other change to the counting code.

Consequences, stated so review can challenge them:

- **Scoring needs no change.** A blocking `low` puts its dimension in the low band (8.5–9.1, `BANDS.low`), below the
  9.2 gate, so one `real_path_low` finding holds the gate until it is fixed, disputed or accepted. `scoreFindings`
  already scores whatever `cmdRun` passes it.
- **`repeat_class` (rule 5) never applies to it**, because rule 5 requires likelihood ≠ `real_path`. A real-path low
  therefore keeps blocking in every round it is still present.
- **Impact `none` and `operator_visible` count.** The owner's rule is by likelihood, not impact. A real-path low
  that harms no one blocks. If this proves noisy in use, narrowing it to impacts other than `none` is a one-line
  change to rule 7 (see "Next change this absorbs").
- **The VALUE line is the only input.** A `low` finding with no valid VALUE line is already blocking (`unvalued`),
  so rule 7 adds nothing for it.
- **Codex can still choose `plausible` for a defect that is really real-path.** The same trust value triage already
  places in the likelihood label; the `real_path` definition in the prompt ("normal use hits it") is unchanged.

### D2. The advisory cap

**One constant.** `value.mjs` exports `ADVISORY_REPORT_CAP = 5`, read by the report code and the docs check
(verification item 9). The reviewer's prompt does not mention it (see Deferred).

**What is capped.** `cmdRun` builds the `findings` array of the round result from `rows`. After this change it
keeps every blocking row; the first advisory row (in `rows` order) for each distinct accepted-risk id cited (the
**representatives**); and only the first `ADVISORY_REPORT_CAP` of the remaining advisory rows in the order
`selectReported` defines. The others are left out of `findings` only.

**One representative per accepted risk.** An accepted-risk finding is the record of the owner's own decision (the cited
`AR-n` line), so an author asking why a finding did not block needs that text. Each distinct `AR-n` that downgraded a
finding this round is therefore always represented by its first finding, whatever the cap. A second finding citing the
same `AR-n` repeats the same text, adds nothing the first does not show, and competes under the cap like any other
advisory row. The exemption is bounded by the number of `AR-n` lines the owner wrote, not by the number of findings
(any number can cite one id), and `readContext` already limits that file to 8 KiB. `R` below is the number of
representatives; the pre-cap counts are unaffected (`advisory` still includes every finding).

**Order.** `selectReported(rows)` in `value.mjs` is pure and returns the non-representative advisory rows sorted by,
in order:

1. severity: `critical`, `high`, `medium`, `low` (a critical is never advisory, but the sort stays total);
2. impact: `money_or_data`, `security`, `user_visible`, `operator_visible`, `none`;
3. likelihood: `real_path`, `plausible`, `requires_misconfig`, `requires_out_of_model_actor`, `theoretical`, then
   unvalued (`null`);
4. the finding's original index in `rows` (Codex's own order), so the sort is stable and total.

**Likelihood only orders.** Apart from the representatives, an advisory finding with a `real_path` or
`plausible` likelihood (for example a `plausible` low, or a `repeat_class` finding) is treated like any other: it can
fall outside the first 5. It is never silent (it is counted), and it never holds the gate, so omitting its text
costs the author nothing the gate needs.

**Indices stay the original ones.** Each reported finding keeps its `i` from `rows`. `cmdDispute` indexes
`rec.lastFindings` by that same `i`, and `lastFindings` still holds every finding. So a dispute against an
omitted advisory index gets `dispute_advisory`, exactly as for a shown one, and a shown finding's `i` never shifts
when the cap drops others.

**Likelihood only orders.** An advisory finding is advisory for a stated reason (`accepted_risk`, `repeat_class`,
`low_value`), and several of those can carry a `real_path` or `plausible` likelihood (an accepted risk, or a
`plausible` low). Apart from the accepted-risk rule above, the cap treats them like any other advisory finding: they
sort by the order above and can fall outside the first 5. They are never silent (they are counted), and they never
hold the gate, so omitting their text costs the author nothing the gate needs.

**Counts stay complete.** `score.advisory` is still the total advisory count (value triage: `blocking + advisory =
total`). `score` gains:

- `advisory_shown`: the number of advisory findings in `findings`, always `R + min(advisory − R, ADVISORY_REPORT_CAP)`;
- `advisory_omitted`: `advisory − advisory_shown`.

The `round.result` event gains `advisory_omitted` (a count, in keeping with the "counts only" rule of the event log).
`docs/EVENTS.md` lists it, and the existing events contract test fails until it does.

**What an omitted finding leaves behind.** The finding's whole entry is absent from `findings`: title, file, lines,
severity, confidence, body, recommendation, `value` and `why`. What remains of it is exactly this, and no more:

- its `lastFindings` entry in the record (title, file, severity, class, `blocking: false`), so a dispute against it
  gets `dispute_advisory`. Its class is **not** entered in the class summary (`rec.classes`), so it can never make a
  later finding `repeat_class`: if the same class comes back as a plausible high or medium finding in a later round,
  it is judged as new and blocks. Only the reported findings' classes are recorded, so a class the author has seen
  is the only kind that dampens a later one;
- its share of the `round.result` event's counts: `advisory`, `advisory_omitted`, `why_*`, and the `likelihoods`,
  `impacts`, `severities`, `dimensions` and `advisory_dimensions` histograms, which cover every finding;
- its share of the history entry's `blocking`, `advisory`, `unvalued` and `why` counts. The history's `likelihoods`
  list holds blocking findings only (value triage D4), so an advisory finding, shown or omitted, has no entry there:
  the event's `likelihoods` histogram is the only place an advisory finding's likelihood is recorded.

The cap bounds the `findings` array, not Codex's free-text `summary`, which the engine forwards unchanged (value triage
behavior; this release does not bound it). The skill reports the dimension table, the counts and the reported findings, so
the summary is context, not part of the capped report.

What the author doesn't get is the finding itself. That is the point of the cap, and it is why the count is always
reported.

### D3. The persisted history shape does not change

Adding `real_path_low` to `WHYS` would change what `state.mjs` `isTriage` validates (it requires a history entry's
`why` map to hold exactly the `WHYS` keys), so 1.1.0 records would be quarantined after an upgrade and 1.2.0 records
after a downgrade. This release avoids any persisted-state change instead of migrating one:

- `value.mjs` exports `HISTORY_WHY_FOLD = Object.freeze({ real_path_low: "realistic" })` and `HISTORY_WHYS`
  (`WHYS` without the folded keys). `triageCounts(...).history.why` is built over `HISTORY_WHYS`: a `real_path_low`
  finding is counted under `realistic`, which is what it is (a finding that blocks on a realistic path).
- `state.mjs` `isTriage` validates `why` against `HISTORY_WHYS`, which equals 1.1.0's `WHYS`. Its other checks are
  unchanged, including that the counts sum to `blocking + advisory`.
- The event log keeps the distinction: `round.result` carries `why_real_path_low` (D4), because the event is built from
  `triageCounts(...).event`, which is over the full `WHYS`.

So a 1.1.0 record reads unchanged under 1.2.0, and a record 1.2.0 writes reads unchanged under 1.1.0: there is no
migration and no downgrade hazard. The cost is that a record's history cannot tell a `real_path_low` from a
`realistic` finding; the event log can.

### D4. The `round.result` event carries `advisory_omitted`

The event writer builds `data` from `EVENT_CATALOG` only, and `roundResultProblems` requires every field of
`ROUND_COUNT_FIELDS`, so a field added in `cmdRun` and `docs/EVENTS.md` alone would be dropped from the log. The
change in `plugin/engine/lib/codes.mjs`:

- `ROUND_COUNTS` gains `"advisory_shown"`, `"advisory_omitted"` and `"accepted_risk_distinct"` (= `R`; so all are in `ROUND_COUNT_FIELDS`, in
  `EVENT_CATALOG["round.result"].data` with the same `tally` check as the other counts, and required on every scored
  event);
- `why_real_path_low` needs no edit: `ROUND_COUNTS` already maps `WHYS` to `why_*`;
- `roundResultProblems` gains two exact checks, importing `ADVISORY_REPORT_CAP` from `value.mjs`:
  `advisory_shown === R + min(advisory − R, ADVISORY_REPORT_CAP)` with `R = accepted_risk_distinct`, and
  `advisory_omitted === advisory − advisory_shown`, plus `why_accepted_risk ≤ advisory`, `R ≤ why_accepted_risk` and
  `R > 0` if and only if `why_accepted_risk > 0`. (`R ≤ advisory` follows from the last three.) `R` is
  produced only by `selectReported` (`distinct`: the number of distinct `accepted_risk` ids among the rows whose `why` is
  `accepted_risk`), and `cmdRun` passes that one value to the result's `score` and to the event, so the report and the
  event cannot disagree. The partition is fully determined by counts the event already
  carries, so an undercount, an overcount or a stale cap each fail validation. That check is **arithmetic consistency
  only**: the event carries counts, not ids, so it cannot tell two distinct risks from two findings citing one. That
  `accepted_risk_distinct` counts distinct ids is pinned where it is computed, by the production-path test of eight
  findings citing `AR-1` (distinct `1`, one representative) and the unit test of `selectReported`, not by the validator;
- `docs/EVENTS.md` lists the new fields (the events contract test compares the doc to the catalog) and states the
  compatibility rule they follow: fields are added to an event's `data` within schema `review-loop.event/1`, consumers
  ignore keys they don't know, and `validateLine` checks a line when it is written (and in `selftest`, against a fresh
  log), never over a log that already exists. Value triage (1.1.0) added about fifteen `round.result` fields the same
  way. So an older engine neither rejects nor rewrites a log that holds newer lines, and a downgrade needs no event
  migration.

### D5. The skill and the docs

- `plugin/skills/review-loop/SKILL.md`: **both** the exit-0 row and the exit-10 step list each *reported* advisory finding (the
  ones in `findings`; this replaces the current "list each" wording, which would promise findings the cap omits) and,
  when `score.advisory_omitted > 0`, add one line: "N more advisory findings were left out of this
  report (cap 5, plus one per accepted risk); their counts are in `score`". An advisory-only round passes with exit 0, so the pass path carries the
  same notice as the fix path. The report line shows `advisory_shown` of `advisory`.
- `README.md` line 46 ("Findings that don't block … are listed for you, not fixed") becomes: "… are listed for you, up
  to 5 per round, plus one for each accepted risk that downgraded a finding, with a count of the rest, and not fixed".
- `docs/TROUBLESHOOTING.md`'s triage block is generated from `RULES`; `node scripts/gen-readme-tables.mjs` writes it
  and `--check` fails when stale. The page also states the cap and the downgrade note from D3.
- `CLAUDE.md` (the repo's) records the new rule and the cap in its invariants.

## Failure modes

| Case | Result |
|---|---|
| more than 5 advisory findings | the first 5 by `selectReported`'s order are reported; `advisory_omitted` counts the rest |
| fewer than 5 | all reported; `advisory_omitted` is 0 |
| 0 findings | `advisory_shown` and `advisory_omitted` are 0 |
| only blocking findings | none capped, whatever their number |
| a dispute names an omitted index | `dispute_advisory`, nothing written (same as a shown advisory) |
| a dispute names an index past `lastFindings` | unchanged from value triage |
| a real-path low carries an accepted risk matching its dimension and class | advisory, `why: accepted_risk` (rule 3 first), reported if it is the first finding citing that `AR-n`, otherwise under the normal cap |
| 8 findings citing one `AR-1` and 7 others | 1 representative of `AR-1` and 5 others reported; 9 omitted |
| findings citing `AR-1` and `AR-2` once each | both reported (R = 2) |
| a real-path low whose impact is money or data, with no in-scope accepted risk | blocking, `why: money_data_security` (rule 4 first) |
| the same finding with a valid in-scope accepted risk | advisory, `why: accepted_risk` (rule 3 first) |

## State changes

None. The record's history keeps the 1.1.0 shape (D3): `real_path_low` is folded into `realistic` there. No new
field, file, lock or fingerprint input. `advisory_omitted` and `advisory_shown` describe one round's report and are
not stored in the record.

## Verification

Every item is a `node --test` case. "(sabotage)" means it also gets a registry row in
`scripts/sabotage-registry.mjs` that must go red when its break is applied and green when restored.

1. `classify`, in `test/engine/value.test.mjs`:
   - the literal expected-result table changes in exactly three rows, `low × real_path × {user_visible,
     operator_visible, none}`: `low_value` becomes `real_path_low` (blocking). The existing completeness assertion
     (a row for every enum combination) still passes with no new rows;
   - a `low` + `real_path` finding with a valid, in-scope accepted risk is advisory (`accepted_risk`, rule 3 runs first),
     including when its impact is `security`; the same finding with impact `security` and no accepted risk is
     `money_data_security`; with a prior class it is still `real_path_low`;
   - a `low` + `plausible` finding is still `low_value`;
   - (sabotage `classify-real-path-low`: drop the rule, so a real-path low turns advisory).
2. Scoring: a round whose only finding is a blocking real-path low does not pass, and its dimension scores 9.1 or
   less (positive and negative cases against `scoreFindings`); a round of eight advisory findings and no blocking one
   still passes with exit 0 (value triage's advisory-only pass test is kept; sabotage `score-blocking-only` already
   covers scoring every row).
3. `selectReported` and the cap, in a new `test/engine/advisory-cap.test.mjs`:
   - (+) 8 advisory rows give 5 shown and `advisory_omitted: 3`; the shown 5 are the first 5 in the documented
     order, written out as literals;
   - (+) 3 advisory rows give 3 shown and `advisory_omitted: 0`;
   - (+) 12 blocking rows and 8 advisory rows report all 12 blocking and 5 advisory;
   - (+) each shown finding's `i` equals its index in `rows`; a dispute against an omitted `i` is
     `dispute_advisory`;
   - (+) six advisory rows where the last-ranked one has likelihood `plausible` (a `plausible` low): five are
     shown, the `plausible` one is omitted and counted in `advisory_omitted`. This pins D2's statement that
     likelihood only orders;
   - (+) six advisories citing six distinct accepted risks, plus six other advisories: all six accepted-risk ones are
     shown, five others are shown, one is omitted; `advisory_shown` is 11, `accepted_risk_distinct` 6,
     `advisory_omitted` 1;
   - (+) eight advisories all citing one `AR-1`, plus seven others: one `AR-1` representative (the first in `rows`
     order) and five others are shown; `advisory_shown` is 6, `accepted_risk_distinct` 1, `advisory_omitted` 9. The
     report is bounded however many findings cite one risk;
   - (sabotage `advisory-cap-accepted-risk-exempt`: exempt every accepted-risk row instead of one per id; the
     duplicate-citation case reports eight accepted-risk rows and goes red; sabotage `advisory-cap-representative`:
     apply the cap to accepted-risk rows too; the six-distinct-risks case omits the sixth and goes red);
   - (+) two rows citing one `AR-n` with different impacts: the earlier row is the representative even when the later one ranks
     better, and the later one competes under the cap (sabotage `advisory-cap-first-row`: choose the representative after ranking);
   - (−) `score.advisory` is the total (8), not the shown count;
   - (+) after the 8-advisory round, `rec.classes` holds the classes of the 5 shown findings only, and
     `rec.lastFindings` holds all 8 entries with title, file, severity, class and `blocking: false`, while `findings`
     holds only the shown ones: the omitted entries are absent from it in full (no title, body or `why`);
   - (+) omitted classes do not carry over (production path): after a round of six advisories whose sixth, class C, is
     omitted, a round with a plausible high finding of class C blocks (`why: realistic`, not `repeat_class`) and the gate
     does not pass; a shown class still downgrades its later plausible repeat (sabotage `advisory-cap-class-memory`:
     record every row's class in `cmdRun`; the omitted-class test goes red);
   - (+) a passed record carrying 1.1.0's history stays passed with the artifact and context unchanged: exit 0 and no Codex call
     (sabotage `pass-survives-upgrade`: add a history condition to the already-passed early return in `cmdRun`);
   - (+) a dispute goes through the CLI at the index the report shows: with six advisories then a blocking finding, the
     blocking finding is reported as index 6, disputing the omitted advisory index 5 exits with `dispute_advisory` and
     changes nothing, and disputing 6 records the dispute against the blocking finding (sabotage `report-index-preserved`:
     renumber the reported findings from 0; the dispute test goes red);
   - (+) after that round, an omitted advisory finding is absent from `history[].triage.likelihoods` (blocking findings
     only) but counted in the event's `likelihoods` histogram, so the two agree with D2's statement of what remains;
   - (+) an advisory finding that cites an `AR-n` whose dimension or class does not match its own is classified by
     the later rules (`low_value`), is flagged `accepted_risk_out_of_scope`, is not a representative, and is omitted
     beyond the cap like any other advisory finding (value triage D3, rule 3);
   - (sabotage `advisory-cap-slice`: remove the slice, so all 8 are reported);
   - (sabotage `advisory-cap-blocking`: apply the cap to every row, so blocking findings are omitted);
   - (sabotage `advisory-cap-order`: sort ascending by impact, so the shown 5 change).
4. Round output, through the production path (`review-round.mjs run` against the fake Codex, not a direct call to
   `selectReported`): a canned reply with 8 advisory and 2 blocking findings yields 7 reported, `advisory_omitted:
   3`, exit 10; a canned reply of 8 advisory findings only yields exit 0 with 5 reported; a canned reply of six
   advisory findings, one an accepted-risk `real_path` low (context file with its `AR-n` line), reports it with its
   original `i`, `why: accepted_risk` and the `accepted_risk_text` as the owner wrote it; and the skill-facing report
   for the 8-advisory approve case carries `advisory_shown: 5`, `advisory_omitted: 3`.
5. Records (`test/engine/state-compat.test.mjs`), against a committed fixture that is a real 1.1.0 record (three
   rounds, a dispute, a waiver and a class) and a literal copy of 1.1.0's seven `why` keys:
   - (+) the fixture reads unquarantined under the 1.2.0 `readRecord`, with its history, dispute, waiver and class
     unchanged;
   - (+) after a round with a `real_path_low` finding, the written record's `history[].triage.why` has exactly the
     seven 1.1.0 keys, counts the finding under `realistic`, and still sums to `blocking + advisory`, so a validator
     built from the literal 1.1.0 keys accepts it (the downgrade case);
   - (−) a `why` with an eighth key `real_path_low` is quarantined (the persisted shape does not change);
   - (sabotage `history-why-fold`: build the history `why` over the full `WHYS`; both the downgrade case and the
     eighth-key case go red).
6. Events (`test/contract/events.test.mjs`, and the production-path cases in `test/engine/e2e.test.mjs`):
   - (+) `buildEvent` for a scored `round.result` keeps `advisory_shown`, `advisory_omitted`, `accepted_risk_distinct` and `why_real_path_low`,
     and `validateLine` accepts the line; `docs/EVENTS.md` lists all four;
   - (−) `validateLine` rejects a scored line missing either field; one with `advisory: 8, advisory_shown: 5,
     advisory_omitted: 2` (undercount); one with `advisory: 8, advisory_shown: 8, advisory_omitted: 0` (cap ignored);
     one with `advisory: 3, advisory_shown: 3, advisory_omitted: 1`; with `accepted_risk_distinct: 2`, one with
     `advisory: 8, advisory_shown: 5, advisory_omitted: 3` (the representatives not counted); one with
     `accepted_risk_distinct: 2, why_accepted_risk: 1`; one with `accepted_risk_distinct: 1,
     why_accepted_risk: 0`; one with `advisory: 8, why_accepted_risk: 1, accepted_risk_distinct: 0, advisory_shown: 5, advisory_omitted: 3`
     (a representative missing from the count); and one with `advisory: 0, why_accepted_risk: 1, accepted_risk_distinct: 1,
     advisory_shown: 0, advisory_omitted: 0` (an accepted-risk finding with no advisory finding);
   - (sabotage `event-advisory-omitted`: remove either field from `ROUND_COUNTS`; the keeps-the-field test goes red;
     sabotage `event-distinct-source`: set `accepted_risk_distinct` to 0 where `cmdRun` writes the event; the production-path event for two
     findings citing `AR-1` and `AR-2` fails `validateLine`; sabotage `event-partition`: relax the exact checks to `advisory_omitted ≤ advisory`; the undercount case goes red).
7. Skill (`test/contract/skill.test.mjs`): the omission sentence is present in **both** the exit-0 row and the
   exit-10 step of `SKILL.md`, both say "reported" advisory findings, the old unqualified "list each to the user"
   wording is gone, and the report line shows `advisory_shown` of `advisory`
   (sabotage `skill-omission-pass-path`: remove it from the exit-0 row).
8. Generated docs: `node scripts/gen-readme-tables.mjs --check` exits 0 after `gen-readme-tables.mjs` is run and
   non-zero before.
9. Supersession, in `test/contract/skill.test.mjs` and a new `test/contract/retention.test.mjs`:
   - (+) the value-triage spec carries the "Amended by 1.2.0" note under its Outcome sentence and under its
     non-negotiable, each naming this spec's file;
   - (+) `docs/TROUBLESHOOTING.md` states that omitted findings do not enter the class history;
   - (+) `SKILL.md`, `README.md` and `docs/TROUBLESHOOTING.md` each state that advisory findings beyond the cap are counted but not
     shown, and that the cap is 5, read from `ADVISORY_REPORT_CAP` so a changed constant fails the test;
   - (−) none of `SKILL.md`, `README.md` and `docs/TROUBLESHOOTING.md` still says advisory findings "appear in full" without the cap
     qualifier in the same sentence (the two specs quote the old sentence to amend it, and are checked by the amendment tests above);
   - (sabotage `retention-doc-stale`: restore the old sentence in `SKILL.md`).
10. Whole suite: `npm test` passes, the sabotage registry test (`test/contract/sabotage-registry.test.mjs`) passes with the
   new rows, and `npm run sabotage` prints `sabotage: every break went red for its named test` (it breaks the code once per
   row and checks the named test goes red; CI runs it, `.github/workflows/sabotage.yml`, when the files the rows touch change).

**Required sabotage rows.** `test/contract/sabotage-registry.test.mjs` gains a `V1_2_IDS` list beside
`VALUE_TRIAGE_IDS`, asserted the same way (no duplicates, every id a registry row): `classify-real-path-low`,
`advisory-cap-slice`, `advisory-cap-blocking`, `advisory-cap-order`, `advisory-cap-accepted-risk-exempt`,
`advisory-cap-representative`, `advisory-cap-first-row`, `history-why-fold`, `event-advisory-omitted`, `event-partition`,
`skill-omission-pass-path`, `retention-doc-stale`, `event-distinct-source`, `report-index-preserved`,
`advisory-cap-class-memory`, `pass-survives-upgrade`. A row missing from the registry therefore fails the suite. The files
the new rows and gate tests touch (`plugin/engine/lib/value.mjs`, `plugin/engine/lib/state.mjs`,
`plugin/engine/lib/codes.mjs`, `test/engine/advisory-cap.test.mjs`, `test/engine/state-compat.test.mjs`,
`test/contract/retention.test.mjs` and the others the rows name) are added to both `paths` lists in
`.github/workflows/sabotage.yml`; the registry test already fails when a registry file or gate test is missing from
either list.

**Sabotage evidence** is recorded in the PR description: for each new row, the break, the red test name and the
restored green run. The registry's own test fails if a row's `find` doesn't match exactly once, so a row can't pass
by matching nothing.

## Rollout

- Released as 1.2.0 through `docs/RELEASE.md`. The four version files (`package.json`,
  `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and `plugin/bin/hook`) are set with
  `node scripts/bump-version.mjs 1.2.0`, and `node scripts/release-check.mjs 1.2.0` must print `all four versions are
  1.2.0`. The release test pins that set of four.
- Going back to 1.1.0 after a 1.2.0 round has run is safe: the record shape is unchanged (D3, verification item 5).
- A pass binds the artifact and its context, not the triage policy. A change of policy (this release's, or a downgrade
  and a later upgrade) never invalidates a pass at an unchanged fingerprint: the artifact stays passed until it
  changes. This is how every release behaves, and it is stated so no one expects a retroactive re-review. Owner decision 2026-10-29: passes stay valid across the upgrade, chosen over tying a pass to a triage-policy version, which would re-review every passed artifact once (a billed Codex round each) and needs a new persisted field, undoing D3.
- The owner's loops already run the plugin (migrated 2026-10-29), so 1.2.0 reaches them with `brew upgrade
  review-loop` followed by `claude plugin update review-loop@review-loop`; `review-loop doctor` reports a version
  skew until both are done.
- Precondition for the first live check: confirm `review-loop doctor` shows plugin and CLI at 1.2.0.

## Next change this absorbs

The likely next changes are a different cap, or narrowing which lows block.

- **A different cap:** one edit, `ADVISORY_REPORT_CAP` in `value.mjs`. The report code reads it, and the docs
  check (verification item 9) reads it too, so a stale "5" in `SKILL.md` or `TROUBLESHOOTING.md` fails.
- **Narrowing `real_path_low`** (for example, excluding impact `none`): the condition in `classify`, the `when` text
  of its `RULES` row, and the three expected-result rows. The test table fails for a changed rule with unchanged
  rows, and `gen-readme-tables --check` fails for unchanged docs.

## Deferred

- **Storing `real_path_low` separately in a record's history.** Needs a migration and a downgrade protocol for a
  distinction the event log already carries; revisit when something reads it from the record.
- **Asking Codex to limit its own advisory output.** Rejected for this release: the reviewer labels likelihood
  itself and does not know which findings the engine will treat as advisory, so a prompt-side limit would either
  contradict the engine's cap or drop findings the engine never counts. If reviewer output size becomes the cost,
  the answer is a cap the engine applies and counts, not an instruction.
- **Capping blocking findings.** Rejected: a cap on what must be fixed would hide required work.
- **Ranking advisory findings by Codex's `confidence`.** The order uses fields the engine already validates;
  `confidence` is an unvalidated float from the reviewer.
- **Persisting omitted findings' bodies.** The record keeps titles, classes and flags only (value triage, Deferred);
  storing bodies would put reviewer prose, which can quote source, in the state dir for good.
- **A per-project cap in `.claude/review-context.md`.** There is one owner and one number so far; a context key
  would be a second place to define it with no second user.
