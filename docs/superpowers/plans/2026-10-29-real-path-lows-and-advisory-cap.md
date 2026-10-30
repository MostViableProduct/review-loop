# Real-path lows and an advisory report cap — implementation plan (1.2.0)

Spec: `docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md` (read it first; it states every
invariant this plan pins). Repo: the review-loop checkout; every command below runs from its root, written `$REVIEW_LOOP_ROOT` (export it once). Stack: Node ≥ 22 ESM (`.mjs`), no dependencies,
tests with the built-in `node:test`. Run a test file with `node --test <file>`; the suite with `npm test`.

## Rules for the executor

- **No new dependencies.** Do not add a package.
- **Every piped gate runs under `pipefail`**, as the repo's `CLAUDE.md` requires: `(set -o pipefail; cmd | tail)`. Without it
  a failing `node --test` piped into `grep` or `tail` exits 0 and the gate passes. Where a step shows only `# fail 0`,
  the command's own exit status must also be 0.
- **No `any` type.** The repo's `test/contract/no-any.test.mjs` fails the suite on one; use `unknown` + narrowing or a
  real JSDoc type.
- **Comment only the non-obvious** (a gotcha, a why). The snippets below carry the comments to keep; add none else.
- **Edit existing files with targeted edits.** Create a file only where a task says "Create".
- **Tests first.** Each task writes its failing test, runs it and sees the stated failure, then implements.
- **After every task run the task's gate and paste its output.** A task is not done without it.
- **Commit once per task**, on the branch from Task 0, with the message given. End every commit message with the
  attribution lines your session instructs.
- `★` Nothing here edits `plugin/engine/lib/scoring.mjs`: scoring already receives blocking rows only
  (`scoreFindings(blocking)` in `review-round.mjs`), and a blocking `low` already lands in the 8.5–9.1 band.

## Decisions fixed by the spec (do not re-derive)

| Decision | Value |
|---|---|
| New blocking rule | `real_path_low`: severity `low` and effective likelihood `real_path`; placed after `realistic`, before `low_value` |
| Cap | `ADVISORY_REPORT_CAP = 5` advisory rows, plus one representative per distinct accepted risk (`why: accepted_risk`, first row in `rows` order per `AR-n`) |
| Order of capped rows | severity, then impact, then likelihood (each in its enum's order, unvalued/null last), then original index |
| What is capped | the `findings` array of the round result, and the class memory (`rec.classes`) records only reported findings' classes; `lastFindings`, scoring and counts see every row |
| Persisted history | unchanged from 1.1.0: `real_path_low` is counted under `realistic` in `history[].triage.why` |
| Event | `round.result` gains `advisory_shown`, `advisory_omitted`, `accepted_risk_distinct` (`R`) and `why_real_path_low` |
| Event rule | `advisory_shown === R + min(advisory − R, 5)`; `advisory_omitted === advisory − advisory_shown`; `why_accepted_risk ≤ advisory`; `R ≤ why_accepted_risk`; `R > 0` iff `why_accepted_risk > 0` |

## File map

| File | Change | Task |
|---|---|---|
| `plugin/engine/lib/value.mjs` | rule + `HISTORY_WHY_FOLD`/`HISTORY_WHYS` + fold in `triageCounts`; `ADVISORY_REPORT_CAP` + `selectReported` | 1, 2 |
| `plugin/engine/lib/state.mjs` | `isTriage` validates `why` against `HISTORY_WHYS` | 1 |
| `plugin/engine/review-round.mjs` | report built from `selectReported`; new `score` and event fields | 3 |
| `plugin/engine/lib/codes.mjs` | `ROUND_COUNTS` + `roundResultProblems` | 3 |
| `docs/EVENTS.md`, `docs/TROUBLESHOOTING.md` (generated block + paragraph), `README.md`, `CLAUDE.md`, `plugin/skills/review-loop/SKILL.md`, `docs/superpowers/specs/2026-10-10-value-triage-design.md` (two notes) | wording | 3, 4 |
| `test/fixtures/record-1.1.0.json` (generated in Task 0), `test/engine/value.test.mjs`, `scoring.test.mjs`, `state-compat.test.mjs` (new), `advisory-cap.test.mjs` (new), `e2e.test.mjs` | tests | 0–3 |
| `test/contract/events.test.mjs`, `skill.test.mjs`, `retention.test.mjs` (new), `sabotage-registry.test.mjs` | tests | 3–5 |
| `scripts/sabotage-registry.mjs`, `.github/workflows/sabotage.yml` | 21 new rows; path lists | 1–5 |
| `package.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin/bin/hook` | version 1.2.0 via `scripts/bump-version.mjs` | 6 |

---

## Task 0: Branch, baseline, commit the documents

**Files:** none changed.

- [ ] **Step 1: branch.** The spec and this plan are untracked on `main`; they carry over.

```sh
cd "$REVIEW_LOOP_ROOT"
git fetch origin
git switch -c feat/real-path-lows-cap origin/main
git status -sb
```

Expected: `## feat/real-path-lows-cap...origin/main` and exactly two untracked paths, the spec and this plan. If anything
else is listed, stop and report it.

- [ ] **Step 2: baseline.**

```sh
(set -o pipefail; npm test 2>&1 | tail -12)
```

Expected: `# fail 0` (and `# cancelled 0`). Record the `# pass N` number as **BASELINE**; later tasks say "BASELINE + new
tests".

- [ ] **Step 3: generate the 1.1.0 record fixture, before any code changes.** Task 1's compatibility tests need a record
that the unmodified 1.1.0 engine wrote, with history, a dispute, a waiver and classes. Generate it now, from this
branch's unchanged code:

```sh
export REVIEW_LOOP_STATE_DIR="$(mktemp -d)"
node --input-type=module <<'GEN'
import fs from "node:fs";
import path from "node:path";
import { newRecord, writeRecord, identityKey, stateRoot } from "./plugin/engine/lib/state.mjs";
import { applyRoundResult, updateClasses } from "./plugin/engine/lib/policy.mjs";
import { scoreFindings } from "./plugin/engine/lib/scoring.mjs";
import { classify, triageCounts } from "./plugin/engine/lib/value.mjs";

const rec = newRecord({ kind: "spec", path: "/r/docs/specs/legacy.md" }, { projectRoot: "/r" });
rec.reviewedContext = "default";
const ctx = { trustedActors: new Set(), acceptedRisks: new Map(), priorClasses: new Set() };
const v = (likelihood, impact, cls) => ({ likelihood, impact, fix_cost: "small", class: cls, actor: "none", accepted_risk: "none", trigger: "t" });
// Each round's triage is derived from the exact findings of that round by the 1.1.0 classifier, as cmdRun does.
const row = (severity, dimension, title, value) => ({ finding: { severity, title: `[${dimension}] ${title}`, file: "a.md" }, severity, dimension, value, triage: classify({ severity, title: `[${dimension}] ${title}`, value }, ctx) });
const rounds = [
  [row("high", "Safety", "token handling", v("real_path", "security", "token handling")), row("low", "Usability", "copy", v("plausible", "none", "copy"))],
  [row("medium", "Correctness", "order state", v("plausible", "user_visible", "order state"))],
  [row("medium", "Reliability", "retry bound", v("plausible", "user_visible", "retry bound")), row("low", "Usability", "tone", v("plausible", "none", "tone"))]
];
rounds.forEach((rows, n) => {
  const blocking = rows.filter((r) => r.triage.blocking).map((r) => r.finding);
  const { history } = triageCounts(rows);
  if (history.blocking !== blocking.length || history.blocking + history.advisory !== rows.length) throw new Error(`round ${n}: triage counts do not match the findings`);
  applyRoundResult(rec, scoreFindings(blocking), blocking, `fp${n}`, { context: "default", triage: history });
});
updateClasses(rec, [{ dimension: "Safety", label: "token handling" }]);
rec.disputes.push({ title: "[Reliability] retry bound", file: "a.md", reason: "bounded at 3 in retry.mjs", raisedAgain: 0, class: null });
// class: null is the shape readRecord hydrates (state.mjs), so the stored fixture equals what the reader returns.
rec.waivers.push({ title: "[Usability] copy", file: "b.md", at: "2026-10-12T00:00:00.000Z", class: null });
writeRecord(rec);
fs.copyFileSync(path.join(stateRoot(), "records", `${identityKey(rec.identity)}.json`), "test/fixtures/record-1.1.0.json");
GEN
unset REVIEW_LOOP_STATE_DIR
node -e 'const r=require("./test/fixtures/record-1.1.0.json");console.log(r.history.length,r.disputes.length,r.waivers.length,r.classes.length,Object.keys(r.history[2].triage.why).length)'
```

Expected: the last command prints `3 1 1 1 7` (3 history entries; 1 dispute, 1 waiver, at least 1 class, each `why`
with 7 keys). If the script throws (a record-shape error), read the message, fix the fixture script (not the engine),
and re-run. Do not hand-edit the JSON: it must be what the engine wrote. The script throws if a round's counts do not
match its findings, so the fixture is internally consistent by construction.

- [ ] **Step 4: commit the documents and the fixture.**

```sh
git add docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md docs/superpowers/plans/2026-10-29-real-path-lows-and-advisory-cap.md test/fixtures/record-1.1.0.json
git commit -m "Spec, plan and a 1.1.0 record fixture: real-path lows and an advisory report cap (1.2.0)"
```

**Gate:** `git log --oneline -1` shows the commit, `git status -sb` shows a clean tree, and `git show --stat HEAD | grep record-1.1.0` lists the fixture.

---

## Task 1: Rule `real_path_low`, and the history fold that keeps records unchanged

**Files:** modify `plugin/engine/lib/value.mjs`, `plugin/engine/lib/state.mjs`, `test/engine/value.test.mjs`,
`test/engine/scoring.test.mjs`, `scripts/sabotage-registry.mjs`, `.github/workflows/ci.yml`, `.github/workflows/sabotage.yml`;
create `test/engine/state-compat.test.mjs`.

Invariants this task pins: (a) a real-path `low` blocks with `why: real_path_low`, after rules 1–5 and 6; (b) a record's
`history[].triage.why` keeps exactly the seven keys 1.1.0 wrote, so 1.1.0 and 1.2.0 read each other's records; (c) the
`round.result` event keeps the distinction (`why_real_path_low`).

- [ ] **Step 1: write the failing tests.**

In `test/engine/value.test.mjs`, change exactly these three rows of `TABLE` (columns: severity, likelihood, impact,
actor listed, base, with an accepted risk, with a prior class). Only the 5th and 7th columns change:

```js
  ["low", "real_path", "user_visible", null, "real_path_low", "accepted_risk", "real_path_low"],
  ["low", "real_path", "operator_visible", null, "real_path_low", "accepted_risk", "real_path_low"],
  ["low", "real_path", "none", null, "real_path_low", "accepted_risk", "real_path_low"],
```

Add `HISTORY_WHYS` to the import from `value.mjs` at the top of the file, then append these two tests after the
"expected-result table" test:

```js
test("classify: a real-path low blocks; earlier rules and other likelihoods keep their own why", () => {
  const KEY = classKey("Usability", "error copy");
  const AR = /** @type {[string, { dimension: string, classKey: string, text: string }]} */ (["AR-1", { dimension: "Usability", classKey: KEY, text: "- AR-1 (2026-10-29) [Usability] class=error copy: accepted" }]);
  const run = (/** @type {Record<string, string>} */ over, /** @type {ReturnType<typeof ctx>} */ c = ctx()) => classify(f("low", "[Usability] vague copy", val({ class: "error copy", ...over })), c);
  assert.deepEqual([run({ likelihood: "real_path" }).blocking, run({ likelihood: "real_path" }).why], [true, "real_path_low"]);
  assert.equal(run({ likelihood: "plausible" }).why, "low_value");
  assert.equal(run({ likelihood: "real_path", accepted_risk: "AR-1" }, ctx({ accepted: [AR] })).why, "accepted_risk");
  assert.equal(run({ likelihood: "real_path", impact: "security" }).why, "money_data_security");
  assert.equal(run({ likelihood: "real_path" }, ctx({ prior: [KEY] })).why, "real_path_low", "repeat_class never applies to a real_path finding");
  assert.equal(classify(f("low", "[Usability] vague copy", null), ctx()).why, "unvalued");
});

test("triageCounts: history.why has exactly 1.1.0's seven keys, counts a real-path low under realistic, and the event keeps real_path_low", () => {
  const KEYS_1_1_0 = ["critical", "unvalued", "accepted_risk", "money_data_security", "repeat_class", "realistic", "low_value"];
  const value = val({ likelihood: "real_path" });
  const row = { severity: "low", dimension: "Usability", value, triage: classify(f("low", "[Usability] vague copy", value), ctx()) };
  const { history, event } = triageCounts([row]);
  assert.deepEqual(Object.keys(history.why).sort(), [...KEYS_1_1_0].sort());
  assert.deepEqual([...HISTORY_WHYS].sort(), [...KEYS_1_1_0].sort());
  assert.equal(history.why.realistic, 1);
  assert.equal(Object.values(history.why).reduce((a, b) => a + b, 0), history.blocking + history.advisory);
  assert.deepEqual([event.why_real_path_low, event.why_realistic], [1, 0]);
});
```

Append to `test/engine/scoring.test.mjs` (it already imports `scoreFindings`):

```js
test("a blocking real-path low holds the gate: its dimension scores 9.1 or less", () => {
  const r = scoreFindings([{ severity: "low", title: "[Usability] vague copy" }]);
  assert.equal(r.pass, false);
  assert.ok((r.dimensions.find((d) => d.name === "Usability")?.score ?? 10) <= 9.1);
});
```

Create `test/engine/state-compat.test.mjs`. It uses the committed fixture from Task 0 (a record the unmodified 1.1.0
engine wrote) and an independent, literal copy of 1.1.0's check, so a change to `WHYS` or to the reader cannot move it:

```js
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { newRecord, writeRecord, readRecord, identityKey, stateRoot } from "../../plugin/engine/lib/state.mjs";
import { applyRoundResult } from "../../plugin/engine/lib/policy.mjs";
import { scoreFindings } from "../../plugin/engine/lib/scoring.mjs";
import { classify, triageCounts } from "../../plugin/engine/lib/value.mjs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpDir } from "./helpers.mjs";

const FIXTURE_PATH = "test/fixtures/record-1.1.0.json";
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const WHY_1_1_0 = ["critical", "unvalued", "accepted_risk", "money_data_security", "repeat_class", "realistic", "low_value"];
// 1.1.0's rule for a history entry's triage.why, written out here and not imported: exactly these keys, counts that
// add up to blocking + advisory.
const legacyHistoryOk = (/** @type {Array<{ triage?: { why: Record<string, number>, blocking: number, advisory: number } }>} */ history) =>
  history.every((e) => e.triage === undefined || (
    Object.keys(e.triage.why).length === WHY_1_1_0.length &&
    WHY_1_1_0.every((k) => Object.hasOwn(e.triage?.why ?? {}, k)) &&
    Object.values(e.triage.why).reduce((a, b) => a + b, 0) === e.triage.blocking + e.triage.advisory));

beforeEach(() => {
  process.env.REVIEW_LOOP_STATE_DIR = tmpDir("rl-state-");
});

/** Put the committed record on disk as 1.1.0 left it: writeRecord makes the directory, then the raw bytes replace the file. */
function installFixture() {
  const key = identityKey(FIXTURE.identity);
  writeRecord(newRecord(FIXTURE.identity));
  const file = path.join(stateRoot(), "records", `${key}.json`);
  fs.writeFileSync(file, fs.readFileSync(FIXTURE_PATH));
  return { key, file };
}

test("the committed 1.1.0 record satisfies the literal 1.1.0 check, and covers history, a dispute, a waiver and classes", () => {
  assert.equal(FIXTURE.history.length, 3);
  assert.ok(FIXTURE.disputes.length >= 1 && FIXTURE.waivers.length >= 1 && FIXTURE.classes.length >= 1);
  assert.ok(legacyHistoryOk(FIXTURE.history), "control: the check accepts what 1.1.0 wrote");
});

test("a committed 1.1.0 record reads unchanged under 1.2.0: history, dispute, waiver and classes", () => {
  const { key } = installFixture();
  const back = readRecord(key);
  assert.ok(back, "not quarantined");
  assert.deepEqual(back.history, FIXTURE.history);
  assert.deepEqual(back.disputes, FIXTURE.disputes);
  assert.deepEqual(back.waivers, FIXTURE.waivers);
  assert.deepEqual(back.classes, FIXTURE.classes);
});

/** Run one 1.2.0 round with a real-path low on the committed record and write it, as the engine would. */
function roundWithRealPathLow() {
  const { key, file } = installFixture();
  const rec = readRecord(key);
  assert.ok(rec);
  const value = { likelihood: "real_path", impact: "user_visible", fix_cost: "small", class: "error copy", actor: "none", accepted_risk: "none", trigger: "t" };
  const finding = { severity: "low", title: "[Usability] vague copy", file: "a.md" };
  const triage = classify({ severity: "low", title: finding.title, value }, { trustedActors: new Set(), acceptedRisks: new Map(), priorClasses: new Set() });
  const counts = triageCounts([{ severity: "low", dimension: "Usability", value, triage }]);
  applyRoundResult(rec, scoreFindings([finding]), [finding], "fp-new", { context: "default", triage: counts.history });
  writeRecord(rec);
  return { key, file };
}

test("after a 1.2.0 round with a real-path low on the committed record, the file satisfies 1.1.0's check and keeps what 1.1.0 wrote", () => {
  const { file } = roundWithRealPathLow();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.history.length, 4);
  assert.ok(legacyHistoryOk(raw.history), "a 1.1.0 validator accepts every history entry, including the new one");
  assert.deepEqual(raw.history.slice(0, 3), FIXTURE.history, "what 1.1.0 wrote is untouched");
  assert.equal(raw.history[3].triage.why.realistic, 1, "the real-path low is counted under realistic");
  assert.deepEqual(raw.waivers, FIXTURE.waivers);
  assert.ok(FIXTURE.classes.every((/** @type {{ key: string }} */ c) => raw.classes.some((/** @type {{ key: string }} */ x) => x.key === c.key)), "its classes are kept");
});

test("the real v1.1.0 reader (extracted from the tag) accepts that record: the downgrade case, run against the old code", () => {
  const { key } = roundWithRealPathLow();
  const old = tmpDir("rl-v110-");
  const archive = spawnSync("git", ["archive", "v1.1.0", "plugin/engine"], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(archive.status, 0, "the v1.1.0 tag must be present: run `git fetch --tags` (CI checks out with fetch-depth: 0)");
  assert.equal(spawnSync("tar", ["-x", "-C", old], { input: archive.stdout }).status, 0);
  const url = pathToFileURL(path.join(old, "plugin/engine/lib/state.mjs")).href;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import { readRecord } from ${JSON.stringify(url)}; const r = readRecord(process.argv[1]); console.log(JSON.stringify(r === null ? null : { status: r.status, history: r.history, disputes: r.disputes, waivers: r.waivers, classes: r.classes, lastFindings: r.lastFindings }));`, key], { encoding: "utf8", env: process.env });
  assert.equal(run.status, 0, `v1.1.0 readRecord: ${run.stderr}`);
  const seenByOld = JSON.parse(run.stdout);
  assert.ok(seenByOld, "the v1.1.0 reader did not quarantine the record");
  assert.equal(seenByOld.history.length, 4);
  const seenByNew = readRecord(key);
  assert.ok(seenByNew);
  // Every compatibility-sensitive field must read the same through both versions; dropping or rewriting one makes this red.
  for (const field of ["status", "history", "disputes", "waivers", "classes", "lastFindings"]) {
    assert.deepEqual(seenByOld[field], JSON.parse(JSON.stringify(seenByNew[field])), `the v1.1.0 reader sees a different ${field}`);
  }
  assert.deepEqual(seenByOld.history.slice(0, 3), FIXTURE.history, "the old reader still sees what 1.1.0 wrote");
});

test("a history why with an eighth key real_path_low is quarantined: the persisted shape does not change", () => {
  const { key, file } = installFixture();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.history[2].triage.why = { ...raw.history[2].triage.why, real_path_low: 1, realistic: raw.history[2].triage.why.realistic - 1 };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(readRecord(key), null);
});
```

Under the unmodified 1.1.0 code the first two and the last test pass (they describe 1.1.0) and only the downgrade test
fails; that is the expected state before Step 3. (A dispute Codex does not re-raise is dropped by `applyRoundResult` by
design, so the downgrade test does not assert the dispute survives the new round; the read test asserts it survives a
read.)

- [ ] **Step 2: run and see them fail.**

```sh
(set -o pipefail; node --test test/engine/value.test.mjs test/engine/state-compat.test.mjs test/engine/scoring.test.mjs 2>&1 | grep -E "^# (pass|fail)|✖" | head)
```

Expected: FAIL. `value.test.mjs` fails to import `HISTORY_WHYS` (a SyntaxError for the missing export), so the whole file
reports as failed; in `state-compat.test.mjs` the test named `after a 1.2.0 round with a real-path low…` fails, at its `realistic` assertion
(before Task 1's code the finding is still classified `low_value`, so `realistic` is 0); the test `the real v1.1.0 reader…`
passes before and after, as a control that the old reader accepts what 1.2.0 writes.

- [ ] **Step 3: implement in `plugin/engine/lib/value.mjs`.**

3a. In `RULES`, insert this row immediately after the `realistic` row and before `low_value`:

```js
  { why: "real_path_low", blocking: true, when: "severity is low and likelihood is real_path" },
```

3b. In `classify`, insert this line immediately after the `return done("realistic");` line and before
`return done("low_value");`:

```js
  if (finding.severity === "low" && likelihood === "real_path") return done("real_path_low");
```

3c. Immediately after the `export const WHYS = ...` line add:

```js
// Persisted history keeps 1.1.0's shape: a real-path low is a finding that blocks on a realistic path, so the record
// counts it under `realistic`. A new `why` key in a record would make 1.1.0 quarantine 1.2.0's records after a
// downgrade (state.mjs isTriage requires exactly these keys). Only the event log carries the distinction.
/** @type {Readonly<Record<string, string>>} */
export const HISTORY_WHY_FOLD = Object.freeze({ real_path_low: "realistic" });
export const HISTORY_WHYS = Object.freeze(WHYS.filter((w) => !Object.hasOwn(HISTORY_WHY_FOLD, w)));
```

3d. In `triageCounts`: directly after `const why = zeros(WHYS);` add `const histWhy = zeros(HISTORY_WHYS);`; directly
after the line `why[r.triage.why] += 1;` add the first line below; and in the returned object change `why,` inside
`history:` to `why: histWhy,`:

```js
    histWhy[HISTORY_WHY_FOLD[r.triage.why] ?? r.triage.why] += 1;
```

So the returned history reads `history: { blocking, advisory, unvalued, why: histWhy, likelihoods: blockingLikelihoods },`.

- [ ] **Step 4: implement in `plugin/engine/lib/state.mjs`.** Change the import on line 10 and the check on line 88:

```js
import { LIKELIHOODS, HISTORY_WHYS, classKey } from "./value.mjs";
```
```js
  if (!isObject(t.why) || !hasExactly(t.why, HISTORY_WHYS) || !Object.values(t.why).every(isCount)) return false;
```

- [ ] **Step 5: regenerate the generated docs.** The triage table in `docs/TROUBLESHOOTING.md` derives from `RULES`.

```sh
node scripts/gen-readme-tables.mjs && node scripts/gen-readme-tables.mjs --check && echo "exit=0"
```

Expected: the second command prints `troubleshooting tables are current` and `exit=0` (the `exit=` line reports the check's status).

- [ ] **Step 5b: let CI see the `v1.1.0` tag.** The downgrade test extracts the real 1.1.0 reader with `git archive v1.1.0`, so
every job that runs it needs the tag. In `.github/workflows/ci.yml` (two `actions/checkout` steps) and
`.github/workflows/sabotage.yml` (one), give each checkout step a `with:` block (the `uses:` line stays as it is):

```yaml
        with:
          fetch-depth: 0
```

Gate: `grep -c "fetch-depth: 0" .github/workflows/ci.yml .github/workflows/sabotage.yml` prints `ci.yml:2` and `sabotage.yml:1`.

- [ ] **Step 6: add the three sabotage rows.** Append inside the `SABOTAGES` array of `scripts/sabotage-registry.mjs`,
just before its closing `];`:

```js
  { id: "classify-real-path-low", file: "plugin/engine/lib/value.mjs", find: "  if (finding.severity === \"low\" && likelihood === \"real_path\") return done(\"real_path_low\");\n", replace: "", test: "test/engine/value.test.mjs", expect: "classify: the expected-result table covers every severity" },
  { id: "history-why-fold", file: "plugin/engine/lib/value.mjs", find: "  const histWhy = zeros(HISTORY_WHYS);", replace: "  const histWhy = zeros(WHYS);", test: "test/engine/value.test.mjs", expect: "triageCounts: history.why has exactly 1.1.0's seven keys" },
  { id: "history-fold-old-reader", file: "plugin/engine/lib/value.mjs", find: "  const histWhy = zeros(HISTORY_WHYS);", replace: "  const histWhy = zeros(WHYS);", test: "test/engine/state-compat.test.mjs", expect: "the real v1.1.0 reader (extracted from the tag) accepts that record" },
```

The last row is the same break as `history-why-fold`, named against the compatibility test: it proves the old-reader gate
can fail, and it puts `test/engine/state-compat.test.mjs` into the workflow coverage that Task 5 checks.

- [ ] **Step 7: gate.**

```sh
set -e
(set -o pipefail; node --test test/engine/value.test.mjs test/engine/state-compat.test.mjs test/engine/scoring.test.mjs test/engine/state-policy.test.mjs 2>&1 | grep -E "^# (pass|fail)")
node scripts/sabotage.mjs --only classify-real-path-low
node scripts/sabotage.mjs --only history-why-fold
node scripts/sabotage.mjs --only history-fold-old-reader
```

Expected: `# fail 0`; then each sabotage prints `red (expected)  <id>` and
`sabotage: every break went red for its named test`. The sabotage script restores the file; confirm with `git diff --stat`
that `value.mjs` shows only your Step 3 changes.

Then run `(set -o pipefail; npm test 2>&1 | tail -8)`. It may fail in tests that hard-code the old `why_*` event fields or the old `low_value`
expectation for a real-path low (for example in `test/engine/e2e.test.mjs`); update each such assertion to the new
behavior (a real-path low is `real_path_low` and blocks) and re-run. A test that fails for any other reason is a bug in
this task; fix the code, never the test's intent. Expected: `# fail 0`.

- [ ] **Step 8: commit.** `git add -A && git commit -m "Real-path lows block; the record's history keeps 1.1.0's shape"`

**Gate:** the command block in Step 7, all green.

---

## Task 2: `selectReported` and the cap, as a pure function

**Files:** modify `plugin/engine/lib/value.mjs`, `scripts/sabotage-registry.mjs`; create
`test/engine/advisory-cap.test.mjs`.

Invariants: blocking rows are never omitted; each distinct accepted risk is represented by its first finding; the other
advisory rows are capped at 5 in the documented order; every reported row keeps its original index.

- [ ] **Step 1: write the failing test.** Create `test/engine/advisory-cap.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADVISORY_REPORT_CAP, selectReported } from "../../plugin/engine/lib/value.mjs";

const FLAGS = { actorNotTrusted: false, theoretical_floored: false, unknownAcceptedRisk: false, acceptedRiskOutOfScope: false };
/** @param {{ severity?: string, impact?: string, likelihood?: string, why?: string, blocking?: boolean, ar?: string }} [o] */
const row = (o = {}) => ({
  severity: o.severity ?? "low",
  dimension: "Usability",
  value: { likelihood: o.likelihood ?? "plausible", impact: o.impact ?? "user_visible", fix_cost: "small", class: "c", actor: "none", accepted_risk: o.ar ?? "none", trigger: "t" },
  triage: { blocking: o.blocking ?? false, why: o.why ?? "low_value", likelihood: o.likelihood ?? "plausible", flags: FLAGS }
});
const idx = (/** @type {{ reported: Array<{ i: number }> }} */ s) => s.reported.map((x) => x.i);

test("selectReported: the representative of an accepted risk is its first row, not its best-ranked one", () => {
  const rows = [
    row({ why: "accepted_risk", ar: "AR-1", impact: "none" }),
    row({ why: "accepted_risk", ar: "AR-1", impact: "user_visible" }),
    ...Array.from({ length: 5 }, () => row({ impact: "operator_visible" }))
  ];
  const s = selectReported(rows);
  assert.deepEqual(idx(s).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], "row 0 represents AR-1; row 1 competes with the others and wins a cap slot; row 6 is omitted");
  assert.deepEqual([s.shown, s.omitted, s.distinct], [6, 1, 1]);
  // Row 0 ranks last on impact ("none"), so it can only be reported as the AR-1 representative, never as a capped row.
  assert.ok(idx(s).includes(0), "row 0 is reported: it is the AR-1 representative");
});

test("selectReported: the representative's text is the first row's, even when a later duplicate ranks higher", () => {
  const rows = [
    row({ why: "accepted_risk", ar: "AR-1", impact: "none" }),
    row({ why: "accepted_risk", ar: "AR-1", impact: "security" }),
    ...Array.from({ length: 5 }, () => row({ impact: "operator_visible" }))
  ];
  const s = selectReported(rows);
  // Row 1 (security) outranks every other row; if it were taken as the representative, row 0 (impact "none") would lose its cap slot.
  assert.ok(idx(s).includes(0), "row 0, the first AR-1 row, is reported as the representative");
  assert.deepEqual(idx(s), [0, 1, 2, 3, 4, 5], "row 1 is an ordinary capped row; row 6 is omitted by the cap");
});

test("selectReported: the cap is 5", () => {
  assert.equal(ADVISORY_REPORT_CAP, 5);
});

test("selectReported: eight advisory rows report five, in severity, impact, likelihood, index order", () => {
  const rows = [
    row({ impact: "none" }), // 0
    row({ impact: "operator_visible" }), // 1
    row({ impact: "user_visible" }), // 2
    row({ impact: "security" }), // 3
    row({ impact: "money_or_data" }), // 4
    row({ severity: "medium", impact: "none" }), // 5
    row({ severity: "high", impact: "none" }), // 6
    row({ impact: "user_visible", likelihood: "theoretical" }) // 7
  ];
  const s = selectReported(rows);
  // Ranked: 6 (high), 5 (medium), then low by impact: 4, 3, 2, 7 (theoretical after plausible), 1, 0. The first five.
  assert.deepEqual(idx(s), [2, 3, 4, 5, 6], "reported in original index order");
  assert.deepEqual([s.shown, s.omitted, s.distinct], [5, 3, 0]);
});

test("selectReported: fewer advisory rows than the cap are all reported", () => {
  const s = selectReported([row(), row(), row()]);
  assert.deepEqual([idx(s), s.shown, s.omitted], [[0, 1, 2], 3, 0]);
});

test("selectReported: blocking findings are never omitted", () => {
  const rows = [
    ...Array.from({ length: 12 }, () => row({ blocking: true, why: "realistic", severity: "high" })),
    ...Array.from({ length: 8 }, () => row())
  ];
  const s = selectReported(rows);
  assert.equal(s.reported.length, 12 + 5);
  assert.deepEqual([s.shown, s.omitted], [5, 3]);
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((i) => idx(s).includes(i)));
});

test("selectReported: a plausible advisory ranked last is omitted and counted (likelihood only orders)", () => {
  const rows = [...Array.from({ length: 5 }, () => row({ likelihood: "real_path" })), row({ likelihood: "plausible" })];
  const s = selectReported(rows);
  assert.deepEqual([idx(s), s.omitted], [[0, 1, 2, 3, 4], 1]);
});

test("selectReported: six distinct accepted risks are all reported, with five others", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, n) => row({ why: "accepted_risk", ar: `AR-${n + 1}`, impact: "operator_visible" })), // 0-5
    ...Array.from({ length: 6 }, () => row()) // 6-11
  ];
  const s = selectReported(rows);
  assert.deepEqual(idx(s), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([s.shown, s.omitted, s.distinct], [11, 1, 6]);
});

test("selectReported: eight findings citing one accepted risk are bounded: one representative, five others", () => {
  const rows = [
    ...Array.from({ length: 8 }, () => row({ why: "accepted_risk", ar: "AR-1", impact: "operator_visible" })), // 0-7
    ...Array.from({ length: 7 }, () => row()) // 8-14
  ];
  const s = selectReported(rows);
  assert.deepEqual(idx(s), [0, 8, 9, 10, 11, 12], "the first AR-1 row and the five best others");
  assert.deepEqual([s.shown, s.omitted, s.distinct], [6, 9, 1]);
});

test("selectReported: a row that cites an accepted risk but is not why accepted_risk is not a representative", () => {
  const s = selectReported([row({ ar: "AR-1", why: "low_value", impact: "none" }), ...Array.from({ length: 6 }, () => row())]);
  assert.deepEqual([s.distinct, s.omitted], [0, 2]);
  assert.ok(!idx(s).includes(0));
});
```

- [ ] **Step 2: run and see it fail.**

```sh
(set -o pipefail; node --test test/engine/advisory-cap.test.mjs 2>&1 | grep -E "^# (pass|fail)|SyntaxError|does not provide" | head -4)
```

Expected: FAIL: the import of `ADVISORY_REPORT_CAP`/`selectReported` is a SyntaxError (export not found).

- [ ] **Step 3: implement.** Append to the end of `plugin/engine/lib/value.mjs`. `SEVERITIES`, `IMPACTS` and
`LIKELIHOODS` are already in scope there, and the `TriageRow` typedef already exists above.

```js
/** Advisory findings a round reports, besides one per accepted risk (spec D2). The owner chose 5. */
export const ADVISORY_REPORT_CAP = 5;

/** Position in an enum's order; a null, missing or unknown value ranks after every member. @param {readonly string[]} order @param {string | null | undefined} k */
const rankIn = (order, k) => {
  const n = k === null || k === undefined ? -1 : order.indexOf(k);
  return n === -1 ? order.length : n;
};

/**
 * Which rows the round's report shows (spec D2): every blocking row; the first advisory row for each accepted risk that
 * downgraded a finding (the representatives); and the first ADVISORY_REPORT_CAP of the other advisory rows, ranked by
 * severity, impact, likelihood, then Codex's own order. `i` is the row's index in `rows`: a dispute indexes
 * `lastFindings` by it, so it must not shift when the cap drops other rows. Presentation only: classification,
 * scoring and the record see every row.
 * @template {TriageRow} R
 * @param {R[]} rows
 * @returns {{ reported: Array<{ row: R, i: number }>, shown: number, omitted: number, distinct: number }}
 */
export function selectReported(rows) {
  const indexed = rows.map((row, i) => ({ row, i }));
  const advisory = indexed.filter((x) => !x.row.triage.blocking);
  const seen = new Set();
  const reps = [];
  const rest = [];
  for (const x of advisory) {
    const id = x.row.triage.why === "accepted_risk" ? x.row.value?.accepted_risk : undefined;
    if (id !== undefined && !seen.has(id)) { seen.add(id); reps.push(x); } else rest.push(x);
  }
  rest.sort((a, b) =>
    rankIn(SEVERITIES, a.row.severity) - rankIn(SEVERITIES, b.row.severity) ||
    rankIn(IMPACTS, a.row.value?.impact) - rankIn(IMPACTS, b.row.value?.impact) ||
    rankIn(LIKELIHOODS, a.row.triage.likelihood) - rankIn(LIKELIHOODS, b.row.triage.likelihood) ||
    a.i - b.i);
  const kept = rest.slice(0, ADVISORY_REPORT_CAP);
  const chosen = new Set([...reps, ...kept].map((x) => x.i));
  const reported = indexed.filter((x) => x.row.triage.blocking || chosen.has(x.i));
  return { reported, shown: reps.length + kept.length, omitted: advisory.length - reps.length - kept.length, distinct: reps.length };
}
```

- [ ] **Step 4: add the six sabotage rows** to `scripts/sabotage-registry.mjs` (before the closing `];`; `grep -c '"advisory-cap-' scripts/sabotage-registry.mjs` must then print `6`):

```js
  { id: "advisory-cap-slice", file: "plugin/engine/lib/value.mjs", find: "  const kept = rest.slice(0, ADVISORY_REPORT_CAP);\n", replace: "  const kept = rest;\n", test: "test/engine/advisory-cap.test.mjs", expect: "selectReported: eight advisory rows report five" },
  { id: "advisory-cap-blocking", file: "plugin/engine/lib/value.mjs", find: "  const reported = indexed.filter((x) => x.row.triage.blocking || chosen.has(x.i));\n", replace: "  const reported = indexed.filter((x) => chosen.has(x.i));\n", test: "test/engine/advisory-cap.test.mjs", expect: "selectReported: blocking findings are never omitted" },
  { id: "advisory-cap-order", file: "plugin/engine/lib/value.mjs", find: "    rankIn(IMPACTS, a.row.value?.impact) - rankIn(IMPACTS, b.row.value?.impact) ||\n", replace: "    rankIn(IMPACTS, b.row.value?.impact) - rankIn(IMPACTS, a.row.value?.impact) ||\n", test: "test/engine/advisory-cap.test.mjs", expect: "selectReported: eight advisory rows report five" },
  { id: "advisory-cap-accepted-risk-exempt", file: "plugin/engine/lib/value.mjs", find: "    if (id !== undefined && !seen.has(id)) { seen.add(id); reps.push(x); } else rest.push(x);\n", replace: "    if (id !== undefined) { seen.add(id); reps.push(x); } else rest.push(x);\n", test: "test/engine/advisory-cap.test.mjs", expect: "selectReported: eight findings citing one accepted risk are bounded" },
  { id: "advisory-cap-first-row", file: "plugin/engine/lib/value.mjs", find: "  for (const x of advisory) {\n", replace: "  for (const x of [...advisory].sort((a, b) => rankIn(IMPACTS, a.row.value?.impact) - rankIn(IMPACTS, b.row.value?.impact))) {\n", test: "test/engine/advisory-cap.test.mjs", expect: "selectReported: the representative of an accepted risk is its first row" },
  { id: "advisory-cap-representative", file: "plugin/engine/lib/value.mjs", find: "    const id = x.row.triage.why === \"accepted_risk\" ? x.row.value?.accepted_risk : undefined;\n", replace: "    const id = undefined;\n", test: "test/engine/advisory-cap.test.mjs", expect: "selectReported: six distinct accepted risks are all reported" },
```

- [ ] **Step 5: gate.**

```sh
set -e
(set -o pipefail; node --test test/engine/advisory-cap.test.mjs 2>&1 | grep -E "^# (pass|fail)")
grep -c '^test(' test/engine/advisory-cap.test.mjs
for id in advisory-cap-slice advisory-cap-blocking advisory-cap-order advisory-cap-accepted-risk-exempt advisory-cap-representative advisory-cap-first-row; do node scripts/sabotage.mjs --only $id; done
(set -o pipefail; node --test test/contract/sabotage-registry.test.mjs 2>&1 | grep -E "^# (pass|fail)")
```

Expected: `# fail 0` and `# pass N`, where N is the number the `grep -c '^test('` line prints (10 as written; the two must
agree, so a test that did not run is caught); six `red (expected)  <id>` lines each followed by
`sabotage: every break went red for its named test`; the registry test `# fail 0`.

- [ ] **Step 6: commit.** `git add -A && git commit -m "selectReported: the advisory report cap as a pure function"`

---

## Task 3: Wire the cap into the round, and the event schema

**Files:** modify `plugin/engine/review-round.mjs`, `plugin/engine/lib/codes.mjs`, `docs/EVENTS.md`,
`test/contract/events.test.mjs`, `test/engine/e2e.test.mjs`, `scripts/sabotage-registry.mjs`.

Gotchas: `review-round.mjs` runs on workerd-free Node, but the same rule applies as everywhere in this repo: the report
and the event are built from the **same** `rows`, so they cannot disagree. Do not compute `accepted_risk_distinct`
anywhere except `selectReported`.

- [ ] **Step 1: write the failing event-contract tests.** In `test/contract/events.test.mjs`, add `classify` is already
imported there; first change `scoredData()` so it carries the three new fields (they come from `cmdRun`, not from
`triageCounts`):

```js
const scoredData = () => ({
  kind: "spec", round: 1, pass: false, preset: "default", duration_ms: 5, mean: 8.4, dims: Object.fromEntries(DIMENSIONS.map((d) => [d, 8.4])),
  model: null, effort: null, effort_source: "codex-inherited", scored: true, context: "file", context_digest: "0123456789ab",
  ...triageCounts([{ severity: "medium", dimension: "Safety", value: null, triage: classify({ severity: "medium", title: "[Safety] x", value: null }, NO_CTX) }]).event,
  advisory_shown: 0, advisory_omitted: 0, accepted_risk_distinct: 0
});
```

Append these two tests:

```js
const ADV_VALUE = { likelihood: "plausible", impact: "user_visible", fix_cost: "small", class: "c", actor: "none", accepted_risk: "none", trigger: "t" };
/** n advisory rows' counts, with the report fields set as the engine sets them for n findings and no accepted risk. @param {number} n @param {Record<string, unknown>} [o] */
const advisoryData = (n, o = {}) => ({
  ...scoredData(),
  ...triageCounts(Array.from({ length: n }, () => ({ severity: "low", dimension: "Usability", value: ADV_VALUE, triage: classify({ severity: "low", title: "[Usability] x", value: ADV_VALUE }, NO_CTX) }))).event,
  advisory_shown: Math.min(n, 5), advisory_omitted: Math.max(0, n - 5), accepted_risk_distinct: 0,
  ...o
});

test("round.result: the new report fields are written and survive buildEvent and validateLine", () => {
  const line = buildEvent({ source: "round", event: "round.result", code: "needs_fixes", data: advisoryData(8) });
  assert.deepEqual(validateLine(line), []);
  assert.deepEqual([line.data.advisory_shown, line.data.advisory_omitted, line.data.accepted_risk_distinct, line.data.why_real_path_low], [5, 3, 0, 0]);
  for (const f of ["advisory_shown", "advisory_omitted", "accepted_risk_distinct"]) {
    assert.ok(roundResultProblems({ ...scoredData(), [f]: undefined }).includes(f), `a scored round must carry ${f}`);
  }
});

test("round.result: the advisory partition is exact; an undercount, an ignored cap and an impossible accepted-risk count are refused", () => {
  const p = (/** @type {number} */ n, /** @type {Record<string, unknown>} */ o = {}) => roundResultProblems(advisoryData(n, o));
  assert.deepEqual(p(8), [], "control: five shown, three omitted");
  assert.ok(p(8, { advisory_omitted: 2 }).includes("advisory_omitted"), "an undercount");
  assert.ok(p(8, { advisory_shown: 8, advisory_omitted: 0 }).includes("advisory_shown"), "the cap ignored");
  assert.ok(p(3, { advisory_omitted: 1 }).includes("advisory_omitted"), "omitting below the cap");
  assert.ok(p(8, { accepted_risk_distinct: 1 }).includes("accepted_risk_distinct"), "a representative with no accepted-risk finding");
  assert.ok(p(8, { why_accepted_risk: 1 }).includes("accepted_risk_distinct"), "an accepted-risk finding with no representative");
  assert.ok(p(0, { why_accepted_risk: 1, accepted_risk_distinct: 1 }).includes("accepted_risk_distinct"), "accepted-risk findings with no advisory finding");
  assert.ok(p(8, { why_accepted_risk: 2, accepted_risk_distinct: 2 }).includes("advisory_shown"), "representatives not counted in the shown total");
  const ok = p(8, { why_accepted_risk: 2, accepted_risk_distinct: 2, advisory_shown: 7, advisory_omitted: 1 });
  for (const f of ["advisory_shown", "advisory_omitted", "accepted_risk_distinct"]) assert.ok(!ok.includes(f), `control: two representatives, ${f} consistent`);
});
```

- [ ] **Step 2: run and see them fail.**

```sh
(set -o pipefail; node --test test/contract/events.test.mjs 2>&1 | grep -E "^# (pass|fail)|✖" | head -6)
```

Expected: FAIL. `advisoryData`-based tests fail because `roundResultProblems` does not yet know the fields
(`advisory_omitted: 2` is not flagged).

- [ ] **Step 3: implement `plugin/engine/lib/codes.mjs`.**

3a. Change the import on line 4:

```js
import { LIKELIHOODS, IMPACTS, WHYS, ADVISORY_REPORT_CAP } from "./value.mjs";
```

3b. Replace the `ROUND_COUNTS` line so it ends with the three new names:

```js
const ROUND_COUNTS = Object.freeze(["blocking", "advisory", "unvalued", ...WHYS.map((w) => `why_${w}`), "actor_not_trusted", "theoretical_floored", "unknown_accepted_risk", "accepted_risk_out_of_scope", "advisory_shown", "advisory_omitted", "accepted_risk_distinct"]);
```

3c. In `roundResultProblems`, after the line
`if (sum(d.advisory_dimensions) !== n.advisory) problems.push("advisory_dimensions");` add (and before `return problems;`):

```js
  // The report cap applies to every advisory row except one representative per accepted risk (spec D2), so the shown
  // and omitted counts are fully determined by counts the event already carries.
  const shown = n.accepted_risk_distinct + Math.min(n.advisory - n.accepted_risk_distinct, ADVISORY_REPORT_CAP);
  if (n.why_accepted_risk > n.advisory || n.accepted_risk_distinct > n.why_accepted_risk || (n.accepted_risk_distinct > 0) !== (n.why_accepted_risk > 0)) problems.push("accepted_risk_distinct");
  if (n.advisory_shown !== shown) problems.push("advisory_shown");
  if (n.advisory_omitted !== n.advisory - n.advisory_shown) problems.push("advisory_omitted");
```

- [ ] **Step 4: implement `plugin/engine/review-round.mjs`.**

4a. Add `selectReported` to the import on line 28:

```js
import { parseValue, classify, triageCounts, classKey, selectReported } from "./lib/value.mjs";
```

4b. Directly after `const counts = triageCounts(rows);` add:

```js
    const report = selectReported(rows);
```

4c. In the `score:` object of the result, directly after `unvalued: counts.history.unvalued,` add (the same `report.distinct` the event gets in 4e):

```js
          advisory_shown: report.shown,
          advisory_omitted: report.omitted,
          accepted_risk_distinct: report.distinct,
```

4d. Change the first line of the `findings:` mapping (keep the body that follows unchanged; each reported finding keeps
its original index `i`):

```js
        findings: report.reported.map(({ row: r, i }) => ({
```

(it was `findings: rows.map((r, i) => ({`).

4d2. The class memory records only what the author saw (spec D2). Replace the `updateClasses(rec, rows.flatMap(...))` line
with:

```js
    updateClasses(rec, report.reported.flatMap(({ row: r }) => (r.value ? [{ dimension: r.dimension, label: r.value.class }] : [])));
```

This line sits after `rec.lastFindings = …`, which still maps every row.

4e. In the `round.result` `emitEvent` call, replace the line `...counts.event` with:

```js
        ...counts.event,
        advisory_shown: report.shown,
        advisory_omitted: report.omitted,
        accepted_risk_distinct: report.distinct
```

Check each edit applied exactly once: `grep -c "report\." plugin/engine/review-round.mjs` prints `8` (three score fields, the findings mapping, the class-memory line, three event fields).

- [ ] **Step 5: document the event.** In `docs/EVENTS.md` add `` `advisory_shown`, `advisory_omitted`, `accepted_risk_distinct`, `why_real_path_low` `` to the `round.result` row's field list (the list on the line that starts
``| `round.result` | round |``; put `why_real_path_low` after `why_realistic`, the others after `accepted_risk_out_of_scope`),
and add this paragraph after the paragraph that ends "…`events.path /abs/path.jsonl`.":

```md
Fields are added to an event's `data` within schema `review-loop.event/1`: consumers must ignore keys they don't know.
review-loop checks a line when it writes it (and `selftest` checks a fresh log), never over a log that already exists, so
an older release neither rejects nor rewrites lines a newer one wrote.
```

- [ ] **Step 6: write the production-path tests** in `test/engine/e2e.test.mjs`. Append (they use the file's existing
`valued`, `respond`, `cli`, `specRepo`, `writeFile`, `roundResults`, `recordOf`):

```js
const CTX_AR = (/** @type {number} */ n) => Array.from({ length: n }, (_, k) => `- AR-${k + 1} (2026-10-29) [Usability] class=ar class ${k + 1}: accepted`).join("\n") + "\n";
const adv = (/** @type {string} */ title, /** @type {string} */ c, /** @type {string} */ impact = "user_visible", /** @type {string} */ ar = "none") => valued(title, "low", { l: "plausible", i: impact, c, ar });
const runSpec = (/** @type {string | null} */ ctx = null) => {
  const repo = specRepo();
  const spec = writeFile(repo, "docs/specs/feature.md", "x");
  if (ctx !== null) writeFile(repo, ".claude/review-context.md", ctx);
  return () => cli(["run", "--kind", "spec", "--path", spec, "--project-root", repo]);
};

test("advisory cap: eight advisory findings report five, and the rest are counted, recorded and absent from history likelihoods", () => {
  const run = runSpec();
  respond(Array.from({ length: 8 }, (_, n) => adv(`[Usability] copy ${n}`, `copy ${n}`)));
  const r = run();
  assert.deepEqual([r.code, r.json.status, r.json.findings.length], [0, "passed", 5], r.stdout);
  assert.deepEqual(r.json.findings.map((/** @type {{ i: number }} */ x) => x.i), [0, 1, 2, 3, 4]);
  assert.deepEqual([r.json.score.advisory, r.json.score.advisory_shown, r.json.score.advisory_omitted], [8, 5, 3]);
  const ev = roundResults().at(-1).data;
  assert.deepEqual([ev.advisory, ev.advisory_shown, ev.advisory_omitted, ev.accepted_risk_distinct, ev.likelihoods.plausible], [8, 5, 3, 0, 8]);
  const rec = recordOf(r.json.key);
  assert.equal(rec.lastFindings.length, 8, "the record keeps every finding");
  assert.equal(rec.classes.length, 5, "but only the shown findings' classes enter the class memory");
  assert.ok(rec.lastFindings.every((/** @type {{ title: string, file: string, severity: string, class: string | null, blocking: boolean }} */ x) => x.title && x.file && x.severity && x.class && x.blocking === false));
  assert.deepEqual(rec.history.at(-1).triage.likelihoods, [], "history likelihoods hold blocking findings only");
});

test("advisory cap: blocking findings are never omitted", () => {
  const run = runSpec();
  respond([
    ...Array.from({ length: 8 }, (_, n) => adv(`[Usability] copy ${n}`, `copy ${n}`)),
    valued("[Safety] a real bug", "high", { l: "real_path", i: "user_visible", c: "bug one" }),
    valued("[Safety] another real bug", "high", { l: "real_path", i: "user_visible", c: "bug two" })
  ]);
  const r = run();
  assert.deepEqual([r.code, r.json.findings.length, r.json.score.blocking, r.json.score.advisory_omitted], [10, 7, 2, 3], r.stdout);
});

test("advisory cap: a real-path low blocks through the production path, and the event keeps the distinction", () => {
  const run = runSpec();
  respond([valued("[Usability] vague copy", "low", { l: "real_path", i: "user_visible", c: "copy" })]);
  const r = run();
  assert.deepEqual([r.code, r.json.status, r.json.findings[0].why, r.json.findings[0].blocking], [10, "needs_fixes", "real_path_low", true], r.stdout);
  assert.ok(r.json.score.dimensions.find((/** @type {{ name: string }} */ d) => d.name === "Usability").score <= 9.1);
  const rec = recordOf(r.json.key);
  assert.equal(rec.history.at(-1).triage.why.realistic, 1, "folded into realistic in the record");
  assert.ok(!("real_path_low" in rec.history.at(-1).triage.why));
  assert.equal(roundResults().at(-1).data.why_real_path_low, 1);
});

test("advisory cap: a real-path low downgraded by an in-scope accepted risk is advisory (rule 3 before the real-path rule) and is shown", () => {
  const run = runSpec(CTX_AR(1));
  respond([valued("[Usability] ar real path", "low", { l: "real_path", i: "operator_visible", c: "ar class 1", ar: "AR-1" })]);
  const r = run();
  assert.deepEqual([r.code, r.json.status, r.json.findings[0].why, r.json.findings[0].blocking], [0, "passed", "accepted_risk", false], r.stdout);
  assert.match(r.json.findings[0].accepted_risk_text, /AR-1 \(2026-10-29\) \[Usability\] class=ar class 1: accepted/);
  assert.deepEqual([r.json.score.advisory_shown, r.json.score.accepted_risk_distinct], [1, 1]);
  const ev = roundResults().at(-1).data;
  assert.deepEqual([ev.why_accepted_risk, ev.why_real_path_low, ev.accepted_risk_distinct], [1, 0, 1]);
});

test("advisory cap: six accepted risks are all reported, with five other advisory findings", () => {
  const run = runSpec(CTX_AR(6));
  respond([
    ...Array.from({ length: 6 }, (_, n) => adv(`[Usability] ar finding ${n + 1}`, `ar class ${n + 1}`, "operator_visible", `AR-${n + 1}`)),
    ...Array.from({ length: 6 }, (_, n) => adv(`[Usability] other ${n}`, `other class ${n}`))
  ]);
  const r = run();
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.findings.map((/** @type {{ i: number }} */ x) => x.i), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(r.json.findings.slice(0, 6).map((/** @type {{ why: string }} */ x) => x.why), Array(6).fill("accepted_risk"));
  assert.match(r.json.findings[0].accepted_risk_text, /AR-1 \(2026-10-29\) \[Usability\] class=ar class 1: accepted/);
  assert.equal(r.json.score.accepted_risk_distinct, 6, "the CLI score carries the same distinct count as the event");
  const ev = roundResults().at(-1).data;
  assert.deepEqual([ev.advisory_shown, ev.advisory_omitted, ev.accepted_risk_distinct, ev.why_accepted_risk], [11, 1, 6, 6]);
});

test("advisory cap: eight findings citing one accepted risk report one representative and five others", () => {
  const run = runSpec(CTX_AR(1));
  respond([
    ...Array.from({ length: 8 }, (_, n) => adv(`[Usability] ar finding ${n}`, "ar class 1", "operator_visible", "AR-1")),
    ...Array.from({ length: 7 }, (_, n) => adv(`[Usability] other ${n}`, `other class ${n}`))
  ]);
  const r = run();
  assert.deepEqual(r.json.findings.map((/** @type {{ i: number }} */ x) => x.i), [0, 8, 9, 10, 11, 12], r.stdout);
  const ev = roundResults().at(-1).data;
  assert.deepEqual([ev.advisory_shown, ev.advisory_omitted, ev.accepted_risk_distinct], [6, 9, 1]);
});

test("advisory cap: a finding citing an accepted risk of another dimension is not a representative", () => {
  const run = runSpec("- AR-1 (2026-10-29) [Usability] class=copy: accepted\n");
  respond([
    valued("[Reliability] copy", "low", { l: "plausible", i: "none", c: "copy", ar: "AR-1" }),
    ...Array.from({ length: 6 }, (_, n) => adv(`[Usability] other ${n}`, `other class ${n}`))
  ]);
  const r = run();
  assert.deepEqual(r.json.findings.map((/** @type {{ i: number }} */ x) => x.i), [1, 2, 3, 4, 5]);
  const ev = roundResults().at(-1).data;
  assert.deepEqual([ev.accepted_risk_distinct, ev.advisory_omitted, ev.accepted_risk_out_of_scope], [0, 2, 1]);
});
```

Also append this test: the report's `i` is the index `cmdDispute` consumes (`rec.lastFindings`), so a capped round must
not renumber it. The blocking finding sits after an omitted advisory one, so a renumbering would aim the dispute at the
omitted advisory finding:

```js
test("advisory cap: a dispute uses the original index the report shows, past an omitted advisory finding", () => {
  const repo = specRepo();
  const spec = writeFile(repo, "docs/specs/feature.md", "x");
  const args = ["--kind", "spec", "--path", spec, "--project-root", repo];
  respond([
    ...Array.from({ length: 6 }, (_, n) => adv(`[Usability] copy ${n}`, `copy ${n}`)),
    valued("[Safety] real bug", "high", { l: "real_path", i: "user_visible", c: "bug one" })
  ]);
  const r = cli(["run", ...args]);
  assert.equal(r.code, 10, r.stdout);
  const bug = r.json.findings.find((/** @type {{ blocking: boolean }} */ x) => x.blocking);
  assert.equal(bug.i, 6, "the blocking finding keeps its original index; advisory #5 was omitted");
  const omitted = cli(["dispute", ...args, "--finding", "5", "--reason", "not evidence"]);
  assert.deepEqual([omitted.code, omitted.json?.error?.code], [30, "dispute_advisory"], omitted.stdout);
  assert.deepEqual(recordOf(r.json.key).disputes, [], "disputing the omitted advisory index changes nothing");
  assert.equal(cli(["dispute", ...args, "--finding", String(bug.i), "--reason", "fixed at src/a.ts:1"]).code, 0);
  assert.equal(recordOf(r.json.key).disputes[0].title, "[Safety] real bug");
});
```

Also append this test: a class whose only finding was omitted from the report must not downgrade a later finding of that
class (spec D2), while a class the author saw still does:

```js
test("advisory cap: an omitted advisory class is not remembered; a shown one still downgrades its repeat", () => {
  const repo = specRepo();
  const spec = writeFile(repo, "docs/specs/feature.md", "x");
  const args = ["--kind", "spec", "--path", spec, "--project-root", repo];
  respond(Array.from({ length: 6 }, (_, n) => adv(`[Usability] copy ${n}`, `copy ${n}`)));
  assert.equal(cli(["run", ...args]).code, 0);
  fs.appendFileSync(spec, "!");
  respond([
    valued("[Usability] copy 5 again", "high", { l: "plausible", i: "user_visible", c: "copy 5" }),
    valued("[Usability] copy 0 again", "high", { l: "plausible", i: "user_visible", c: "copy 0" })
  ]);
  const r2 = cli(["run", ...args]);
  assert.deepEqual(r2.json.findings.map((/** @type {{ why: string }} */ f) => f.why), ["realistic", "repeat_class"], r2.stdout);
  assert.equal(r2.code, 10, "the omitted class's repeat blocks");
});
```

Also append this test: a pass recorded before the upgrade stays cleared (spec Rollout; owner decision 2026-10-29). It puts
the committed 1.1.0 history on a passed record and runs the production path again with the artifact and context unchanged:

```js
test("a passed record carrying 1.1.0's history stays passed after the upgrade: exit 0, no Codex call", () => {
  const repo = specRepo();
  const spec = writeFile(repo, "docs/specs/feature.md", "x");
  const args = ["--kind", "spec", "--path", spec, "--project-root", repo];
  respond([]);
  const first = cli(["run", ...args]);
  assert.equal(first.code, 0);
  const file = path.join(env.REVIEW_LOOP_STATE_DIR, "records", `${first.json.key}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  rec.history = JSON.parse(fs.readFileSync("test/fixtures/record-1.1.0.json", "utf8")).history;
  fs.writeFileSync(file, JSON.stringify(rec));
  const calls = stubCalls().length;
  const again = cli(["run", ...args]);
  assert.deepEqual([again.code, again.json.status, stubCalls().length], [0, "passed", calls]);
});
```

- [ ] **Step 7: add the seven sabotage rows** to `scripts/sabotage-registry.mjs`:

```js
  { id: "event-advisory-omitted", file: "plugin/engine/lib/codes.mjs", find: ", \"advisory_omitted\", \"accepted_risk_distinct\"]);", replace: ", \"accepted_risk_distinct\"]);", test: "test/contract/events.test.mjs", expect: "round.result: the new report fields are written" },
  { id: "event-partition", file: "plugin/engine/lib/codes.mjs", find: "  if (n.advisory_omitted !== n.advisory - n.advisory_shown) problems.push(\"advisory_omitted\");\n", replace: "  if (n.advisory_omitted > n.advisory) problems.push(\"advisory_omitted\");\n", test: "test/contract/events.test.mjs", expect: "round.result: the advisory partition is exact" },
  { id: "event-distinct-source", file: "plugin/engine/review-round.mjs", find: "        accepted_risk_distinct: report.distinct\n", replace: "        accepted_risk_distinct: 0\n", test: "test/engine/e2e.test.mjs", expect: "advisory cap: six accepted risks are all reported" },
  { id: "real-path-low-before-accepted-risk", file: "plugin/engine/lib/value.mjs", find: "  const key = classKey(dimension, v.class);\n", replace: "  const key = classKey(dimension, v.class);\n  if (finding.severity === \"low\" && likelihood === \"real_path\") return done(\"real_path_low\");\n", test: "test/engine/e2e.test.mjs", expect: "advisory cap: a real-path low downgraded by an in-scope accepted risk" },
  { id: "report-index-preserved", file: "plugin/engine/review-round.mjs", find: "        findings: report.reported.map(({ row: r, i }) => ({", replace: "        findings: report.reported.map(({ row: r }, i) => ({", test: "test/engine/e2e.test.mjs", expect: "advisory cap: a dispute uses the original index" },
  { id: "advisory-cap-class-memory", file: "plugin/engine/review-round.mjs", find: "    updateClasses(rec, report.reported.flatMap(({ row: r }) => (r.value ?", replace: "    updateClasses(rec, rows.flatMap((r) => (r.value ?", test: "test/engine/e2e.test.mjs", expect: "advisory cap: an omitted advisory class is not remembered" },
  { id: "pass-survives-upgrade", file: "plugin/engine/review-round.mjs", find: "rec.reviewedFingerprint === prep.fingerprint && rec.reviewedContext === contextTag) {", replace: "rec.reviewedFingerprint === prep.fingerprint && rec.reviewedContext === contextTag && rec.history.length === 0) {", test: "test/engine/e2e.test.mjs", expect: "a passed record carrying 1.1.0's history stays passed" },
```

- [ ] **Step 8: gate.**

```sh
set -e
(set -o pipefail; node --test test/contract/events.test.mjs test/engine/e2e.test.mjs test/engine/advisory-cap.test.mjs 2>&1 | grep -E "^# (pass|fail)|✖")
node -e 'const s=require("fs").readFileSync("plugin/engine/review-round.mjs","utf8");const n=s.split("        accepted_risk_distinct: report.distinct\n").length-1;console.log("event-distinct-source find count",n);process.exit(n===1?0:1)'
for id in event-advisory-omitted event-partition event-distinct-source real-path-low-before-accepted-risk report-index-preserved advisory-cap-class-memory pass-survives-upgrade; do node scripts/sabotage.mjs --only $id; done
```

Expected: `# fail 0`; `event-distinct-source find count 1` (the row's `find` ends in a newline so it matches the event line, not the
comma-terminated score line); seven `red (expected)  <id>` lines. Then `(set -o pipefail; npm test 2>&1 | tail -8)` → exit 0 and `# fail 0`; if `T-OBS-6`
("every catalog entry's largest line is ≤ 4 KiB") fails, report the byte count: the three new fields are small, so a
failure means a wrong edit, not a limit to raise.

- [ ] **Step 9: commit.** `git add -A && git commit -m "The round reports through selectReported; round.result carries the partition"`

---

## Task 4: Skill, docs, and the supersession of value triage's retention wording

**Files:** modify `plugin/skills/review-loop/SKILL.md`, `README.md`, `docs/TROUBLESHOOTING.md`, `CLAUDE.md`,
`docs/superpowers/specs/2026-10-10-value-triage-design.md`, `test/contract/skill.test.mjs`,
`scripts/sabotage-registry.mjs`; create `test/contract/retention.test.mjs`.

- [ ] **Step 1: write the failing contract tests.**

In `test/contract/skill.test.mjs`, replace the second string of the first test (the old `**Advisory** findings …` bullet)
and add a test, so the file reads:

```js
test("SKILL.md: only blocking findings are fixed or disputed; advisory ones are listed, not changed, never disputed", () => {
  for (const s of [
    "Only **blocking** findings (`findings[].blocking: true`) hold the gate; fix or dispute those alone.",
    "**Advisory** findings (`blocking: false`): list each reported advisory finding to the user in one line with its `why` and `value.likelihood` (`findings` holds only the reported ones)."
  ]) assert.ok(SKILL.includes(s), s);
  assert.ok(SKILL.includes("Don't change code for one unless the user asks, and never dispute one (the engine refuses it with `dispute_advisory`)."));
});

test("SKILL.md: advisory findings are listed as reported, and omitted ones are count-only, on the pass path and the fix path", () => {
  const OMITTED = "N more advisory findings were left out of this report (cap 5, plus one per accepted risk); their counts are in `score`";
  assert.equal(SKILL.split(OMITTED).length - 1, 2, "the omission line is in the exit-0 row and in the exit-10 step");
  assert.ok(!SKILL.includes("list each to the user in one line"), "the unqualified wording is gone");
  assert.ok(SKILL.includes("list each reported advisory finding as in step 3"));
  assert.ok(SKILL.includes("`advisory_shown` of `advisory`"));
});
```

Create `test/contract/retention.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ADVISORY_REPORT_CAP } from "../../plugin/engine/lib/value.mjs";

const flat = (/** @type {string} */ p) => fs.readFileSync(p, "utf8").replace(/\s+/g, " ");
const THIS_SPEC = "docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md";
const PRIOR_SPEC = "docs/superpowers/specs/2026-10-10-value-triage-design.md";
const DOCS = [THIS_SPEC, PRIOR_SPEC, "plugin/skills/review-loop/SKILL.md", "README.md", "docs/TROUBLESHOOTING.md"];

test("retention: the value-triage spec carries an 'Amended by 1.2.0' note under its Outcome sentence, its non-negotiable, its rule table and its D3 advisory-reporting paragraph", () => {
  const prior = flat(PRIOR_SPEC);
  const prefix = `Amended by 1.2.0 (${THIS_SPEC})`;
  assert.equal(prior.split(prefix).length - 1, 5);
  // Each note sits immediately after the passage it amends (each anchor occurs once), so a misplaced or missing one is red.
  const after = (/** @type {string} */ anchor) => {
    assert.equal(prior.split(anchor).length - 1, 1, `anchor must occur exactly once: ${anchor}`);
    return prior.slice(prior.indexOf(anchor) + anchor.length).trimStart();
  };
  for (const anchor of ["instead of continuing.", "That is the same retention blocking findings have today.", "(they don't block).", "The `docs/EVENTS.md` table is regenerated (`node scripts/gen-readme-tables.mjs`)."]) {
    assert.ok(after(anchor).startsWith(`*${prefix}`), `no 1.2.0 note directly after: ${anchor}`);
  }
  assert.ok(after("(they don't block).").slice(0, 500).includes("advisory_omitted"), "the D3 note must point at the omitted count");
  const d7 = after("The `docs/EVENTS.md` table is regenerated (`node scripts/gen-readme-tables.mjs`).").slice(0, 600);
  for (const needle of ["why_real_path_low", "advisory_shown", "advisory_omitted", "accepted_risk_distinct"]) assert.ok(d7.includes(needle), `the D7 note must name: ${needle}`);
  const afterTable = prior.slice(prior.indexOf("| 7 | anything else | advisory | `low_value` |"));
  const note = afterTable.slice(afterTable.indexOf(prefix), afterTable.indexOf(prefix) + 700);
  for (const needle of ["rule 7 is split", "real_path_low", "why_real_path_low", "advisory_omitted"]) assert.ok(note.includes(needle), `the rule-table note must say: ${needle}`);
});

test("retention: SKILL.md, README.md and TROUBLESHOOTING.md state the cap, read from ADVISORY_REPORT_CAP", () => {
  for (const [p, needle] of [
    ["plugin/skills/review-loop/SKILL.md", `left out of this report (cap ${ADVISORY_REPORT_CAP}, plus one per accepted risk); their counts are in \`score\`". Don't change code`],
    ["README.md", `up to ${ADVISORY_REPORT_CAP} per round`],
    ["docs/TROUBLESHOOTING.md", `at most ${ADVISORY_REPORT_CAP} other advisory findings`]
  ]) assert.ok(flat(p).includes(needle), `${p} must say: ${needle}`);
});

test("retention: TROUBLESHOOTING.md says omitted findings do not enter the class history", () => {
  assert.ok(flat("docs/TROUBLESHOOTING.md").includes("they do not enter the class history"));
  assert.ok(!flat("docs/TROUBLESHOOTING.md").includes("still count toward the class history"));
});

test("retention: no document makes an unqualified 'appears in full' claim about advisory findings", () => {
  // Both specs quote the old unqualified sentence on purpose (to amend it); the amendments are asserted by the first test.
  for (const p of DOCS.filter((d) => d !== PRIOR_SPEC && d !== THIS_SPEC)) {
    for (const sentence of flat(p).split(/(?<=[.!?]) /).filter((x) => x.includes("appears in full"))) {
      assert.ok(/\bcap\b|up to \d/.test(sentence), `${p}: a retention claim with no cap qualifier in the same sentence`);
    }
  }
});
```

- [ ] **Step 2: run and see them fail.**

```sh
(set -o pipefail; node --test test/contract/skill.test.mjs test/contract/retention.test.mjs 2>&1 | grep -E "^# (pass|fail)|✖" | head)
```

Expected: FAIL (`# fail` > 0) in the tests that assert the new wording: the two `SKILL.md` tests, the amendment-notes test and
the cap-wording test. The `TROUBLESHOOTING.md` class-history test and the "appears in full" test may also fail or pass
before the edits; record which. After the edits in this task all must pass: `# fail 0`, and `# pass` equal to the count of `test(` calls
in the two files (`grep -c '^test(' test/contract/skill.test.mjs test/contract/retention.test.mjs`).

- [ ] **Step 3: edit `plugin/skills/review-loop/SKILL.md`.**

3a. In the exit-0 table row, replace the text `list any advisory findings as in step 3. Done.` with:

```text
list each reported advisory finding as in step 3, add the omission line when `score.advisory_omitted > 0` ("N more advisory findings were left out of this report (cap 5, plus one per accepted risk); their counts are in `score`"), and show `advisory_shown` of `advisory`. Done.
```

3b. Replace the whole `**Advisory** findings` bullet in step 3 (it is the three lines starting
`   - **Advisory** findings (`blocking: false`): list each to the user…` and ending `with `dispute_advisory`).`) with:

```text
   - **Advisory** findings (`blocking: false`): list each reported advisory finding to the user in one line with its `why` and
     `value.likelihood` (`findings` holds only the reported ones). When `score.advisory_omitted > 0`, add one line: "N more advisory findings were left out of this
     report (cap 5, plus one per accepted risk); their counts are in `score`". Don't change code for one unless the user asks, and never dispute one (the engine refuses it
     with `dispute_advisory`).
```

- [ ] **Step 4: edit `README.md`.** Replace line 46 (the one reading
`   Findings that don't block (unlikely, already accepted, or low value) are listed for you, not fixed.`) with:

```text
   Findings that don't block (unlikely, already accepted, or low value) are listed for you, up to 5 per round (plus
   one for each accepted risk that downgraded a finding) with a count of the rest, and are not fixed.
```

- [ ] **Step 5: edit `docs/TROUBLESHOOTING.md`.** Immediately after the line `<!-- triage:end -->` add:

```md

Rule 7, a `low` finding whose likelihood is `real_path`, blocks: normal use hits it, so it is fixed before a pass.

A round reports every blocking finding and at most 5 other advisory findings, ranked by severity, then impact, then
likelihood, then the order Codex gave them. It also reports the first finding for each accepted risk that downgraded a
finding, so the text you wrote for it is always shown. The result's `score.advisory_omitted` counts the rest. They are
still counted and recorded, but they do not enter the class history (only reported findings' classes do, so an omitted class never turns a later finding into a `repeat_class`); only their text is left out of the report.
```

(The line "at most 5 other advisory findings" must stay on one line.) Then run
`node scripts/gen-readme-tables.mjs --check && echo "exit=0"` → `exit=0`.

- [ ] **Step 6: add the five notes to the value-triage spec** (`docs/superpowers/specs/2026-10-10-value-triage-design.md`).
Directly after the Outcome paragraph (the one ending `continuing.`) add a new paragraph:

```md
*Amended by 1.2.0 (docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md): a finding is still
recorded and counted, but is reported in full only within the report cap; a `low` finding on a `real_path` blocks.*
```

and directly after the "Advisory findings are never dropped silently…" bullet (it ends `…blocking findings have today.`) add a sub-line:

```md
  *Amended by 1.2.0 (docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md): "never dropped
  silently" stands: an advisory finding is always counted; its full text appears only within the report cap.*
```

and directly after the D3 rule table (the line `| 7 | anything else | advisory | \`low_value\` |` and the blank line after it) add a paragraph that
amends the passages the table and its consequences define:

```md
*Amended by 1.2.0 (docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md): rule 7 is split. A `low`
finding whose effective likelihood is `real_path` is blocking with `why: real_path_low` (placed after rule 6); every other
rule-7 finding stays `low_value`. "A `low` finding no longer blocks on its own" below holds for non-real-path lows only.
The persisted history keeps these seven `why` keys (`real_path_low` is counted under `realistic` there); only the
`round.result` event gains `why_real_path_low`, `advisory_shown`, `advisory_omitted` and `accepted_risk_distinct`.*
```

and directly after the D3 paragraph that ends `never disputed (they don't block).` (the one saying advisory findings are
reported to the user in one line each; the next line is the `### D4.` heading) add a paragraph:

```md
*Amended by 1.2.0 (docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md): advisory findings are
reported one line each only within the report cap (5, plus one per accepted risk); the rest are counted in
`score.advisory_omitted`. They are still counted, recorded and never disputed.*
```

and directly after the D7 line `The \`docs/EVENTS.md\` table is regenerated (\`node scripts/gen-readme-tables.mjs\`).` add a paragraph:

```md
  *Amended by 1.2.0 (docs/superpowers/specs/2026-10-29-real-path-lows-and-advisory-cap-design.md): `round.result` also
  carries `why_real_path_low`, `advisory_shown`, `advisory_omitted` and `accepted_risk_distinct`. The persisted history
  keeps the seven `why` keys listed here; the event is where `real_path_low` is counted separately.*
```

- [ ] **Step 7: edit the repo `CLAUDE.md`.** At the end of the `## Invariants` list (the last bullet before
`## Deviations from the spec`) add:

```md
- A `low` finding whose effective likelihood is `real_path` blocks (`why: real_path_low`, after rules 1–6). A record's
  `history[].triage.why` keeps 1.1.0's seven keys: `real_path_low` is counted under `realistic` there
  (`HISTORY_WHY_FOLD`), and only `round.result` carries `why_real_path_low`, so 1.1.0 and 1.2.0 read each other's records.
- The round result's `findings` is capped by `selectReported` (`value.mjs`): every blocking row, the first row per
  accepted risk that downgraded a finding, and `ADVISORY_REPORT_CAP` (5) other advisory rows. Each reported row keeps its
  index in `lastFindings`. Classification, scoring, `lastFindings` and the counts see every row; the class summary records only the
  reported findings' classes, so an omitted class never makes a later finding `repeat_class`.
  `round.result` carries `advisory_shown`, `advisory_omitted` and `accepted_risk_distinct`, and `roundResultProblems`
  checks the partition exactly.
```

- [ ] **Step 8: add the sabotage rows and update the existing one.** In `scripts/sabotage-registry.mjs` replace the
existing `skill-advisory` row with:

```js
  { id: "skill-advisory", file: "plugin/skills/review-loop/SKILL.md", find: "   - **Advisory** findings (`blocking: false`): list each reported advisory finding to the user in one line with its `why` and\n     `value.likelihood` (`findings` holds only the reported ones). When `score.advisory_omitted > 0`, add one line: \"N more advisory findings were left out of this\n     report (cap 5, plus one per accepted risk); their counts are in `score`\". Don't change code for one unless the user asks, and never dispute one (the engine refuses it\n     with `dispute_advisory`).\n", replace: "", test: "test/contract/skill.test.mjs", expect: "SKILL.md: only blocking findings are fixed or disputed" },
```

and append:

```js
  { id: "skill-omission-pass-path", file: "plugin/skills/review-loop/SKILL.md", find: "add the omission line when `score.advisory_omitted > 0` (\"N more advisory findings were left out of this report (cap 5, plus one per accepted risk); their counts are in `score`\"), and show `advisory_shown` of `advisory`. Done.", replace: "Done.", test: "test/contract/skill.test.mjs", expect: "SKILL.md: advisory findings are listed as reported" },
  { id: "retention-readme-stale", file: "README.md", find: "are listed for you, up to 5 per round (plus\n   one for each accepted risk that downgraded a finding) with a count of the rest, and are not fixed.", replace: "are listed for you, not fixed.", test: "test/contract/retention.test.mjs", expect: "retention: SKILL.md, README.md and TROUBLESHOOTING.md state the cap" },
  { id: "retention-doc-stale", file: "plugin/skills/review-loop/SKILL.md", find: "report (cap 5, plus one per accepted risk); their counts are in `score`\". Don't change code", replace: "report; their counts are in `score`\". Don't change code", test: "test/contract/retention.test.mjs", expect: "retention: SKILL.md, README.md and TROUBLESHOOTING.md state the cap" },
  { id: "retention-outcome-note-moved", file: "docs/superpowers/specs/2026-10-10-value-triage-design.md", find: "instead of\ncontinuing.\n", replace: "instead of\ncontinuing.\n\nStray paragraph.\n", test: "test/contract/retention.test.mjs", expect: "retention: the value-triage spec carries an 'Amended by 1.2.0' note" },
  { id: "retention-nonneg-note-moved", file: "docs/superpowers/specs/2026-10-10-value-triage-design.md", find: "That is the same retention blocking findings have today.\n", replace: "That is the same retention blocking findings have today.\n\n  Stray paragraph.\n", test: "test/contract/retention.test.mjs", expect: "retention: the value-triage spec carries an 'Amended by 1.2.0' note" },
```

- [ ] **Step 9: gate.**

```sh
set -e
(set -o pipefail; node --test test/contract/skill.test.mjs test/contract/retention.test.mjs test/contract/readme.test.mjs 2>&1 | grep -E "^# (pass|fail)")
for id in skill-advisory skill-omission-pass-path retention-doc-stale retention-readme-stale retention-outcome-note-moved retention-nonneg-note-moved; do node scripts/sabotage.mjs --only $id; done
npm run docs:check && echo "docs=0"
```

Expected: `# fail 0`; six `red (expected)  <id>` lines; `docs=0`. Each gate exits nonzero when any command in it fails (`set -e`, `&&`). If `readme.test.mjs` fails on the README line,
read its message: it pins README wording from the generated tables; keep the README sentence as written above and adjust
only what the message names.

- [ ] **Step 10: commit.** `git add -A && git commit -m "Skill and docs state the report cap; value triage's retention wording is amended"`

---

## Task 5: The registry requires the new rows; CI watches the new files

**Files:** modify `test/contract/sabotage-registry.test.mjs`, `.github/workflows/sabotage.yml`.

- [ ] **Step 1: write the failing test.** In `test/contract/sabotage-registry.test.mjs`, directly after the
`every value-triage sabotage the spec requires is a registry row` test add:

```js
// Spec "Required sabotage rows" (1.2.0): each is a gate whose test must be proven able to fail.
const V1_2_IDS = [
  "classify-real-path-low", "history-why-fold", "history-fold-old-reader", "advisory-cap-slice", "advisory-cap-blocking", "advisory-cap-order",
  "advisory-cap-accepted-risk-exempt", "advisory-cap-representative", "advisory-cap-first-row", "event-advisory-omitted", "event-partition",
  "event-distinct-source", "real-path-low-before-accepted-risk", "report-index-preserved", "advisory-cap-class-memory", "pass-survives-upgrade", "skill-omission-pass-path", "retention-doc-stale",
  "retention-readme-stale", "retention-outcome-note-moved", "retention-nonneg-note-moved"
];

test("every 1.2.0 sabotage the spec requires is a registry row", () => {
  assert.equal(new Set(V1_2_IDS).size, 21);
  const ids = new Set(SABOTAGES.map((s) => s.id));
  assert.deepEqual(V1_2_IDS.filter((id) => !ids.has(id)), []);
});
```

- [ ] **Step 2: run.**

```sh
(set -o pipefail; node --test test/contract/sabotage-registry.test.mjs 2>&1 | grep -E "^# (pass|fail)|✖|missing|workflow" | head)
```

Expected: the new test passes (the rows exist from Tasks 1–4). The workflow-coverage test (the one the file's header
comment names) FAILS, listing the registry files and gate tests missing from `.github/workflows/sabotage.yml`
(`test/engine/advisory-cap.test.mjs`, `test/engine/state-compat.test.mjs`, `test/contract/retention.test.mjs`, and any other
path it prints).

- [ ] **Step 3: add every path it names** to **both** `paths:` lists in `.github/workflows/sabotage.yml` (the `push` list
and the `pull_request` list), in the file's own style (`      - "path"`), then re-run Step 2's command.

Sabotage evidence for the PR description: for each of the 21 rows, run
`node scripts/sabotage.mjs --only <id>` and keep the `red (expected)  <id>` line.

- [ ] **Step 4: gate.**

```sh
set -e
(set -o pipefail; node --test test/contract/sabotage-registry.test.mjs 2>&1 | grep -E "^# (pass|fail)")
(set -o pipefail; node scripts/sabotage.mjs 2>&1 | tail -3)
```

Expected: `# fail 0`; then every row red and the final line `sabotage: every break went red for its named test`
(the full run takes several minutes).

- [ ] **Step 5: commit.** `git add -A && git commit -m "The registry requires the 1.2.0 sabotage rows; CI watches their files"`

---

## Task 6: Version 1.2.0 and the final gates

**Files:** `package.json`, `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin/bin/hook`
(all four via the script).

- [ ] **Step 1: bump.**

```sh
node scripts/bump-version.mjs 1.2.0 && node scripts/release-check.mjs 1.2.0 && echo "exit=0"
```

Expected: `release-check: all four versions are 1.2.0` and `exit=0`.

- [ ] **Step 2: every gate.**

```sh
set -e
(set -o pipefail; npm test 2>&1 | tail -8)
npm run docs:check && echo "docs=0"
npm run content-gate && echo "content=0"
```

Expected: `# fail 0` with `# pass` = BASELINE + the new tests (about 30); `docs=0`; `content=0`.

- [ ] **Step 3: commit.** `git add -A && git commit -m "1.2.0"`

**Gate:** all three commands in Step 2 green. Do not tag or release: signing and tagging are the owner's step
(`docs/RELEASE.md`).

---

## Task 7: Pull request

- [ ] **Step 1:** run the implementation and PR reviews through the `review-loop` skill from inside the repo
(`cwd = $REVIEW_LOOP_ROOT`; the PR gate reads the repo from the shell's working directory). The PR gate denies
creation until the exact PR diff has passed.
- [ ] **Step 2:** push only with `review-round.mjs push --key <key>` (never `git push` by hand, never to `main`).
- [ ] **Step 3:** open the PR (GitHub MCP/app). The description lists: the spec path, the 21 `red (expected)` lines from
Task 5, the `npm test` summary, and "release is the owner's step (`docs/RELEASE.md`)".

---

## Self-check against the spec (the executor does not need this; the reviewer does)

| Spec item | Task |
|---|---|
| D1 rule `real_path_low` | 1 |
| D2 cap, representatives, order, indices, counts | 2, 3 |
| D3 persisted shape unchanged | 1 |
| D4 event fields and exact checks, `docs/EVENTS.md` compatibility note | 3 |
| D5 skill, README, TROUBLESHOOTING, `CLAUDE.md` | 4 |
| Supersedes (value-triage notes, retention test) | 4 |
| Verification 1–10, required sabotage rows, CI paths | 1–5 |
| Rollout: four version files | 6 |
