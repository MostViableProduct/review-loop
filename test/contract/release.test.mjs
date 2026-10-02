import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpDir } from "../engine/helpers.mjs";
import { MIN_CLAUDE } from "../../cli/lib/preflight.mjs";

const FILES = ["package.json", "plugin/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "plugin/bin/hook"];
/** A temp COPY of the four version files and both scripts: the real repo files are never stamped. */
function copyRepo() {
  const d = tmpDir();
  for (const f of [...FILES, "scripts/bump-version.mjs", "scripts/release-check.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.copyFileSync(f, path.join(d, f));
  }
  return d;
}
const node = (/** @type {string} */ d, /** @type {string[]} */ ...a) => spawnSync(process.execPath, a, { cwd: d, encoding: "utf8" });
/** @param {string} d @returns {string[]} */
const snapshot = (d) => FILES.map((f) => fs.readFileSync(path.join(d, f), "utf8"));

const WORKFLOW_DIRS = [".github/workflows", "homebrew-tap/.github/workflows"];
const RELEASE_YML = fs.readFileSync(".github/workflows/release.yml", "utf8");
const FORMULA = fs.readFileSync("homebrew-tap/Formula/review-loop.rb", "utf8");

/**
 * The jobs of a workflow: each two-space key under the top-level `jobs:`, with its body.
 * @param {string} yml @returns {Array<{ name: string, text: string }>}
 */
function jobs(yml) {
  const lines = yml.split("\n");
  /** @type {Array<{ name: string, lines: string[] }>} */
  const out = [];
  for (let i = lines.indexOf("jobs:") + 1; i > 0 && i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) out.push({ name: m[1], lines: [] });
    else if (/^\S/.test(lines[i])) break;
    else out.at(-1)?.lines.push(lines[i]);
  }
  return out.map((j) => ({ name: j.name, text: j.lines.join("\n") }));
}

/** The runner labels a job can run on, resolving a `matrix.os` list. @param {string} jobText @returns {string[]} */
function runnerLabels(jobText) {
  const on = /^ {4}runs-on: (.+)$/m.exec(jobText)?.[1].trim() ?? "";
  if (on === "${{ matrix.os }}") return (/^\s*os: \[([^\]]*)\]/m.exec(jobText)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [on];
}

/** The steps of a job, each as its own text block. @param {string} jobText @returns {string[]} */
const steps = (jobText) => jobText.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));

test("bump-version stamps all four places; release-check agrees", () => {
  const d = copyRepo();
  const b = node(d, "scripts/bump-version.mjs", "9.8.7");
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, "version 9.8.7 stamped in 4 files\n");
  const c = node(d, "scripts/release-check.mjs", "9.8.7");
  assert.equal(c.status, 0, c.stdout);
  assert.equal(c.stdout, "release-check: all four versions are 9.8.7\n");
  assert.match(fs.readFileSync(path.join(d, "plugin/bin/hook"), "utf8"), /^VERSION="9\.8\.7"$/m);
  const market = JSON.parse(fs.readFileSync(path.join(d, ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(market.plugins.find((/** @type {{ name: string }} */ p) => p.name === "review-loop").version, "9.8.7");
  assert.deepEqual(fs.readdirSync(path.join(d, "plugin/bin")), ["hook"], "no temp file left behind");
});

test("release-check names each mismatching file", () => {
  const d = copyRepo();
  node(d, "scripts/bump-version.mjs", "9.8.7");
  const pj = path.join(d, "plugin/.claude-plugin/plugin.json");
  fs.writeFileSync(pj, fs.readFileSync(pj, "utf8").replace("9.8.7", "9.8.6"));
  const hook = path.join(d, "plugin/bin/hook");
  fs.writeFileSync(hook, fs.readFileSync(hook, "utf8").replace(/^VERSION=.*$/m, ""));
  const r = node(d, "scripts/release-check.mjs", "9.8.7");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /plugin\/\.claude-plugin\/plugin\.json: 9\.8\.6/);
  assert.match(r.stdout, /plugin\/bin\/hook: missing/);
  assert.doesNotMatch(r.stdout, /^package\.json:/m, "a matching file is not named");
});

test("release-check refuses a tag that is not X.Y.Z (exit 2), so the workflow never uses one", () => {
  const d = copyRepo();
  for (const tag of ["", "v1.2.3", "1.2", "1.2.3-rc1", "1.2.3/../x", "1.2.3\"; x"]) assert.equal(node(d, "scripts/release-check.mjs", tag).status, 2, JSON.stringify(tag));
});

test("bump-version refuses a symlinked target and writes nothing", () => {
  const d = copyRepo();
  const outside = path.join(tmpDir(), "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ version: "0.0.1" }));
  fs.rmSync(path.join(d, "package.json"));
  fs.symlinkSync(outside, path.join(d, "package.json"));
  const before = fs.readFileSync(path.join(d, "plugin/.claude-plugin/plugin.json"), "utf8");
  const r = node(d, "scripts/bump-version.mjs", "9.8.7");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing package\.json/);
  assert.equal(JSON.parse(fs.readFileSync(outside, "utf8")).version, "0.0.1", "link target untouched");
  assert.equal(fs.readFileSync(path.join(d, "plugin/.claude-plugin/plugin.json"), "utf8"), before, "nothing written");
});

test("bump-version is all-or-nothing: a missing marketplace entry or hook VERSION line writes no file", () => {
  for (const [file, edit, message] of /** @type {const} */ ([
    [".claude-plugin/marketplace.json", (/** @type {string} */ s) => s.replace("\"name\": \"review-loop\", \"source\"", "\"name\": \"other\", \"source\""), /no review-loop entry/],
    ["plugin/bin/hook", (/** @type {string} */ s) => s.replace(/^VERSION=.*$/m, "V=1"), /no VERSION line/]
  ])) {
    const d = copyRepo();
    const p = path.join(d, file);
    fs.writeFileSync(p, edit(fs.readFileSync(p, "utf8")));
    const before = snapshot(d);
    const r = node(d, "scripts/bump-version.mjs", "9.8.7");
    assert.equal(r.status, 1, file);
    assert.match(r.stderr, message);
    assert.deepEqual(snapshot(d), before, `${file}: no file was written`);
  }
});

test("bump-version keeps the shim executable", () => {
  const d = copyRepo();
  fs.chmodSync(path.join(d, "plugin/bin/hook"), 0o755);
  node(d, "scripts/bump-version.mjs", "9.8.7");
  assert.equal(fs.statSync(path.join(d, "plugin/bin/hook")).mode & 0o777, 0o755);
});

test("bump-version rejects a non-semver argument", () => {
  const d = copyRepo();
  const before = snapshot(d);
  for (const a of [["v1"], ["1.2"], [], ["1.2.3", "extra"]]) assert.equal(node(d, "scripts/bump-version.mjs", ...a).status, 2, a.join(" "));
  assert.deepEqual(snapshot(d), before);
});

test("every workflow action is pinned to a full commit SHA (both repos)", () => {
  const bad = [];
  let seen = 0;
  for (const d of WORKFLOW_DIRS) for (const f of fs.readdirSync(d)) {
    fs.readFileSync(path.join(d, f), "utf8").split("\n").forEach((l, i) => {
      const m = /^\s*-?\s*uses:\s*(\S+)/.exec(l);
      if (m) seen++;
      if (m && !/@[0-9a-f]{40}$/.test(m[1])) bad.push(`${d}/${f}:${i + 1}`);
    });
  }
  assert.ok(seen > 0, "the check saw at least one action");
  assert.deepEqual(bad, []);
});

test("Dependabot proposes action pin bumps weekly, with the same file in both repos", () => {
  const want = "version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: weekly\n";
  assert.equal(fs.readFileSync(".github/dependabot.yml", "utf8"), want);
  assert.equal(fs.readFileSync("homebrew-tap/.github/dependabot.yml", "utf8"), want);
});

test("release.yml: the tarball's file list is captured, then guarded non-empty, before git archive; the tarball is re-gated", () => {
  const release = jobs(RELEASE_YML).find((j) => j.name === "release");
  assert.ok(release, "release.yml has a release job");
  const step = steps(release.text).find((s) => s.includes("git archive"));
  assert.ok(step, "a step runs git archive");
  assert.match(step, /^ {8}shell: bash$/m, "the step names its shell");
  const body = step.split("\n");
  const at = (/** @type {RegExp} */ re) => body.findIndex((l) => re.test(l));
  const strict = at(/^\s+set -euo pipefail$/);
  const capture = at(/^\s+FILES="\$\(node scripts\/content-gate\.mjs --list\)"$/);
  const guard = at(/^\s+if \[ -z "\$FILES" \]; then .*exit 1; fi$/);
  const archive = at(/^\s+git archive /);
  const regate = at(/^\s+node scripts\/content-gate\.mjs --dir "extracted\/review-loop-\$V" --require-private$/);
  assert.ok(strict !== -1 && capture !== -1 && guard !== -1 && archive !== -1 && regate !== -1, "all five lines are present");
  assert.ok(strict < capture && capture < guard && guard < archive && archive < regate, "set -euo pipefail, capture, guard, archive, re-gate: in that order");
  assert.ok(!body[archive].includes("$("), "no command substitution inside git archive's arguments");
  assert.match(body[archive], / HEAD \$FILES$/, "git archive packs exactly the captured list");
  assert.ok(body.slice(archive + 1).some((l) => /^\s+diff <\(printf '%s\\n' "\$FILES"/.test(l)), "the extracted file set is compared with the list");
});

const CI_YML = fs.readFileSync(".github/workflows/ci.yml", "utf8");
const DENYLIST_ENV = /^ {8}env:\n(?: {10}.*\n)*? {10}CONTENT_GATE_DENYLIST: \$\{\{ secrets\.CONTENT_GATE_DENYLIST \}\}$/m;

/**
 * Every content-gate run in a job, as `{ step, args }`: one per line that invokes the gate script (the `--list` capture
 * included) or `npm run content-gate`.
 * @param {string} jobText @returns {Array<{ step: string, args: string }>}
 */
function gateRuns(jobText) {
  return steps(jobText).flatMap((step) => step.split("\n").flatMap((l) => {
    if (/npm run content-gate/.test(l)) return [{ step, args: "<npm run>" }];
    const m = /node scripts\/content-gate\.mjs((?: [^\s)]+)*)/.exec(l);
    return m ? [{ step, args: m[1].trim() }] : [];
  }));
}

test("release.yml: every content-gate run gets the private denylist and requires it, so the job fails closed without it", () => {
  const release = jobs(RELEASE_YML).find((j) => j.name === "release");
  assert.ok(release, "release job");
  const runs = gateRuns(release.text).filter((r) => r.args !== "--list");
  assert.deepEqual(runs.map((r) => r.args), ["--require-private", "--tracked --require-private", "--dir \"extracted/review-loop-$V\" --require-private"],
    "the packaged set, every tracked file and the built tarball, each with --require-private");
  for (const r of runs) assert.match(r.step, DENYLIST_ENV, `the step running ${r.args} passes the secret`);
  const scan = steps(release.text).findIndex((s) => s.includes("--tracked --require-private"));
  assert.ok(scan !== -1 && scan < steps(release.text).findIndex((s) => /run: npm test$/m.test(s)), "the gate fails a missing secret before the long steps run");
});

test("the private denylist secret reaches only steps that run the gate, never npm (both workflows)", () => {
  for (const [f, yml] of [["release.yml", RELEASE_YML], ["ci.yml", CI_YML]]) {
    for (const j of jobs(yml)) for (const s of steps(j.text)) {
      if (!s.includes("secrets.CONTENT_GATE_DENYLIST")) continue;
      assert.match(s, /content-gate\.mjs/, `${f} job ${j.name}: a step holding the secret runs the gate`);
      assert.ok(!/\bnpm\b|\bnpx\b/.test(s), `${f} job ${j.name}: a step holding the secret runs npm`);
    }
  }
  assert.equal(jobs(RELEASE_YML).filter((j) => j.text.includes("secrets.CONTENT_GATE_DENYLIST")).map((j) => j.name).join(), "release");
});

const CI_DENYLIST_ENV = /^ {8}env:\n(?: {10}.*\n)*? {10}CONTENT_GATE_DENYLIST: \$\{\{ github\.event_name == 'push' && secrets\.CONTENT_GATE_DENYLIST \|\| '' \}\}$/m;

test("ci.yml: the private denylist reaches only a push to main, never a pull_request's code; CI degrades without it", () => {
  const ci = jobs(CI_YML).find((j) => j.name === "test");
  assert.ok(ci, "ci.yml has a test job");
  const runs = gateRuns(ci.text);
  assert.deepEqual(runs.map((r) => r.args), ["", "--tracked"], "the packaged set and every tracked file");
  for (const r of runs) assert.match(r.step, CI_DENYLIST_ENV, `the step running "${r.args}" gets the secret on push only`);
  // A pull_request runs the PR branch's own scripts, and a same-repo PR receives secrets: it must never see the list.
  assert.equal((CI_YML.match(/secrets\.CONTENT_GATE_DENYLIST/g) ?? []).length, (CI_YML.match(/github\.event_name == 'push' && secrets\.CONTENT_GATE_DENYLIST/g) ?? []).length, "every use is push-gated");
  assert.match(CI_YML, /^ {2}push:\n {4}branches: \[main\]$/m, "push means a push to main: merged, reviewed code");
  assert.ok(!/pull_request_target/.test(CI_YML), "pull_request_target would hand secrets to PR code");
  assert.ok(!CI_YML.includes("--require-private"), "PRs get no list, so CI must not require it");
});

test("BSD `sed -i ''` appears only in jobs that run on macOS (both repos)", () => {
  let checked = 0;
  for (const d of WORKFLOW_DIRS) for (const f of fs.readdirSync(d)) {
    for (const j of jobs(fs.readFileSync(path.join(d, f), "utf8"))) {
      checked++;
      const labels = runnerLabels(j.text);
      assert.ok(labels.length > 0, `${d}/${f} job ${j.name} has a runs-on`);
      if (/\bsed -i ''/.test(j.text)) assert.ok(labels.every((l) => /^macos-/.test(l)), `${d}/${f} job ${j.name} uses BSD sed on ${labels.join(", ")}`);
    }
  }
  assert.ok(checked >= 5, `found ${checked} jobs`);
});

test("the tap gets a formula only from tap-formula, naming the release archive; before the first release it has none", () => {
  const release = jobs(RELEASE_YML).find((j) => j.name === "release")?.text ?? "";
  const tap = jobs(RELEASE_YML).find((j) => j.name === "tap-bump")?.text ?? "";
  assert.match(release, /node scripts\/tap-formula\.mjs "\$V" "\$SHA" > "\$RUNNER_TEMP\/review-loop\.rb"/);
  assert.match(release, /formula: \$\{\{ steps\.tarball\.outputs\.formula \}\}/);
  assert.match(tap, /FORMULA: \$\{\{ needs\.release\.outputs\.formula \}\}/);
  assert.match(tap, /printf '%s' "\$FORMULA" \| base64 -d > "\$F"/);
  assert.match(tap, /grep -qx " {2}sha256 \\"\$SHA\\"" "\$F" \|\|/, "the written formula is checked against the archive's sha256");
  assert.ok(!/\bsed -i/.test(tap), "the formula is never edited in place in the tap");
  const tests = fs.readFileSync("homebrew-tap/.github/workflows/tests.yml", "utf8");
  assert.match(tests, /if \[ ! -f base\/Formula\/review-loop\.rb \]; then echo "FIRST=1"/, "first release = no formula in the tap yet");
  assert.ok(!/0\{64\}/.test(tests), "a placeholder checksum is never a state the tap can be in");
});

test("TAP_PR_TOKEN is read only by the tap-bump job, which runs in the `release` environment with no repo scopes", () => {
  const all = jobs(RELEASE_YML);
  const readers = all.filter((j) => j.text.includes("secrets.TAP_PR_TOKEN")).map((j) => j.name);
  assert.deepEqual(readers, ["tap-bump"]);
  const tap = all.find((j) => j.name === "tap-bump");
  assert.match(tap?.text ?? "", /^ {4}environment: release$/m);
  assert.match(tap?.text ?? "", /^ {4}permissions: \{\}$/m);
  assert.match(RELEASE_YML, /^permissions:\n {2}contents: read$/m, "the workflow default is read-only");
});

test("AC-2: the formula has no post_install and caveats execute nothing", () => {
  assert.ok(!/post_install/.test(FORMULA));
  const caveats = /def caveats([\s\S]*?)\n  end/.exec(FORMULA)?.[1] ?? "";
  assert.ok(caveats.includes("<<~EOS"), "caveats found");
  assert.ok(!/system|`|%x|Kernel|IO\.|File\./.test(caveats.replace(/<<~EOS[\s\S]*?EOS/, "")), "caveats only returns text");
  assert.ok(!/Dir\.home|ENV\[|~\/\.claude|~\/\.codex|\.claude|\.codex/.test(FORMULA), "the formula never names the home directory or the Claude/Codex dirs");
  assert.match(FORMULA, /system bin\/"review-loop", "selftest"/);
  assert.match(FORMULA, /assert_match "review-loop #\{version\}", shell_output\("#\{bin\}\/review-loop --version"\)/, "the version check reads stdout, where the CLI prints it (L6)");
  assert.match(FORMULA, /exec "#\{formula_opt_bin\("node"\)\}\/node" "#\{libexec\}\/cli\/review-loop\.mjs" "\$@"/);
});

// Task 28 replaced the placeholder everywhere in OWNER_SUBSTITUTED (its sed scope was TASK28_SCOPE) with the real org.
// In the files of OWNER_LITERALS the same text is literal and survives; each is pinned to its exact lines, so any
// other occurrence, in any file of the scope, fails.
const OWNER = "<owner>";
const REAL_OWNER = "MostViableProduct";
const TASK28_SCOPE = ["plugin", "cli", "scripts", ".claude-plugin", ".github", "README.md", "docs/RELEASE.md", "package.json", "homebrew-tap"];
const OWNER_SUBSTITUTED = [
  ".claude-plugin/marketplace.json",
  ".github/workflows/release.yml",
  "README.md",
  "cli/lib/plugin.mjs",
  "docs/RELEASE.md",
  "homebrew-tap/.github/workflows/tests.yml",
  "homebrew-tap/Formula/review-loop.rb",
  "homebrew-tap/README.md",
  "plugin/engine/review-gate-hook.mjs"
];
/** @type {Record<string, string[]>} each file's lines holding the literal, trimmed, in file order */
const OWNER_LITERALS = {
  // An API path template in an error message.
  "plugin/engine/lib/cmdparse.mjs": [
    "throw unresolvable(\"`gh api` merge call is not a plain repos/<owner>/<repo>/pulls/<n>/merge endpoint; call that endpoint directly\");"
  ],
  // ownerFrom's fallback and its docs; test/contract/content-gate.test.mjs pins the literal.
  "scripts/content-gate.mjs": [
    "* The GitHub owner of this repo, from `package.json` `repository.url`; the literal `<owner>` until Task 28 sets it.",
    "return m ? m[1] : \"<owner>\";",
    "return \"<owner>\";",
    "* coordinate occurrence; text is never stripped, so `<owner>/tap@gmail.com` still fails (its email match leaves the"
  ]
};

/**
 * Every way `files` (path → text) departs from the checklist: a substituted file still holding the placeholder or
 * lacking the real owner, a file holding the placeholder that is in neither list, a literal file whose placeholder
 * lines differ from its pinned lines, and a literal file that no longer holds it.
 * @param {Record<string, string>} files @returns {string[]}
 */
function ownerProblems(files) {
  /** @type {string[]} */
  const problems = [];
  const holders = new Set();
  for (const [f, text] of Object.entries(files)) {
    const lines = text.split("\n").filter((l) => l.includes(OWNER)).map((l) => l.trim());
    if (OWNER_SUBSTITUTED.includes(f)) {
      if (lines.length > 0) problems.push(`${f}: still holds the placeholder`);
      if (!text.includes(REAL_OWNER)) problems.push(`${f}: does not name ${REAL_OWNER}`);
      continue;
    }
    if (lines.length === 0) continue;
    holders.add(f);
    const pinned = OWNER_LITERALS[f];
    if (pinned === undefined) problems.push(`${f}: holds the placeholder but is in neither list`);
    else if (JSON.stringify(lines) !== JSON.stringify(pinned)) problems.push(`${f}: its placeholder lines differ from the pinned literal lines`);
  }
  for (const f of OWNER_SUBSTITUTED) if (!(f in files)) problems.push(`${f}: listed but missing from the scope`);
  for (const f of Object.keys(OWNER_LITERALS)) if (!holders.has(f)) problems.push(`${f}: listed but no longer holds the placeholder`);
  return problems;
}

/** @returns {Record<string, string>} every file in Task 28's scope, tracked or new */
function scopeFiles() {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...TASK28_SCOPE], { encoding: "utf8" }).split("\0").filter(Boolean);
  return Object.fromEntries([...new Set(files)].filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f, "utf8")]));
}

test("the owner placeholder checklist for Task 28 is complete", () => {
  assert.deepEqual(ownerProblems(scopeFiles()), []);
});

test("the owner checklist (−): a new occurrence anywhere, including in a literal file, must be classified", () => {
  const real = scopeFiles();
  const variant = (/** @type {string} */ f, /** @type {(s: string) => string} */ edit) => ownerProblems({ ...real, [f]: edit(real[f] ?? "") });
  assert.deepEqual(variant("scripts/content-gate.mjs", (s) => `${s}// see ${OWNER}/review-loop\n`), ["scripts/content-gate.mjs: its placeholder lines differ from the pinned literal lines"]);
  assert.deepEqual(variant("plugin/engine/lib/cmdparse.mjs", (s) => s.replace("repos/<owner>/<repo>", "repos/<owner>/<name>")), ["plugin/engine/lib/cmdparse.mjs: its placeholder lines differ from the pinned literal lines"]);
  assert.deepEqual(variant("cli/lib/io.mjs", (s) => `${s}// ${OWNER}\n`), ["cli/lib/io.mjs: holds the placeholder but is in neither list"]);
  assert.deepEqual(variant("cli/lib/plugin.mjs", (s) => `${s}// ${OWNER}\n`), ["cli/lib/plugin.mjs: still holds the placeholder"]);
  assert.deepEqual(variant("cli/lib/plugin.mjs", (s) => s.split(REAL_OWNER).join("someone")), ["cli/lib/plugin.mjs: does not name MostViableProduct"]);
  assert.deepEqual(variant("plugin/engine/lib/cmdparse.mjs", (s) => s.split(OWNER).join("someone")), ["plugin/engine/lib/cmdparse.mjs: listed but no longer holds the placeholder"]);
});

test("tap CI: Homebrew never auto-updates mid-run (an update could reset the tap and test the base formula)", () => {
  const formula = jobs(fs.readFileSync("homebrew-tap/.github/workflows/tests.yml", "utf8")).find((j) => j.name === "formula");
  assert.match(formula?.text ?? "", /^ {4}env:\n(?: {6}#.*\n)* {6}HOMEBREW_NO_AUTO_UPDATE: 1$/m);
});

test("release.yml: no token in a URL, argv or .git/config; the write token reaches only the steps that write", () => {
  for (const d of WORKFLOW_DIRS) for (const f of fs.readdirSync(d)) {
    const yml = fs.readFileSync(path.join(d, f), "utf8");
    assert.ok(!/https:\/\/[^\s"']*x-access-token:\$\{/.test(yml) && !/x-access-token:\$\{/.test(yml), `${d}/${f}: no token in a URL`);
    assert.ok(!/git -c http\.[^\s]*extraheader/.test(yml), `${d}/${f}: no auth header in git's argv`);
  }
  const release = jobs(RELEASE_YML).find((j) => j.name === "release");
  assert.ok(release, "release job");
  const checkout = steps(release.text).find((s) => s.includes("uses: actions/checkout@"));
  assert.match(checkout ?? "", /^ {10}persist-credentials: false$/m, "checkout leaves no token in .git/config");
  const writers = steps(release.text).filter((s) => s.includes("github.token")).map((s) => /name: (.*)/.exec(s)?.[1]);
  assert.deepEqual(writers, ["GitHub release", "Plugin tag (validates plugin.json against the marketplace entry)"]);
  // Package install scripts run arbitrary code: no step that holds a token may install or run a package.
  for (const d of WORKFLOW_DIRS) for (const f of fs.readdirSync(d)) {
    for (const j of jobs(fs.readFileSync(path.join(d, f), "utf8"))) for (const s of steps(j.text)) {
      if (!/github\.token|secrets\.TAP_PR_TOKEN/.test(s)) continue;
      assert.ok(!/\bnpm (install|i|ci|exec)\b|\bnpx\b/.test(s), `${d}/${f} job ${j.name}: a step holding a token runs npm install or npx`);
    }
  }
  for (const s of [...steps(release.text), ...steps(jobs(RELEASE_YML).find((j) => j.name === "tap-bump")?.text ?? "")]) {
    if (!/git (clone|push)|--push/.test(s)) continue;
    assert.match(s, /GIT_CONFIG_KEY_0="http\.https:\/\/github\.com\/\.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$AUTH"/, "a step that clones or pushes authenticates through env config");
    assert.match(s, /echo "::add-mask::\$AUTH"/, "the derived header value is masked in logs");
  }
});

test("MIN_CLAUDE is the version setup's user-scope install was verified on, and every CI pin installs exactly it", () => {
  const record = "`claude plugin install … --scope user` was accepted on Claude Code ";
  const claudeMd = fs.readFileSync("CLAUDE.md", "utf8");
  assert.ok(claudeMd.includes(`${record}${MIN_CLAUDE} `), `CLAUDE.md records the --scope user install on ${MIN_CLAUDE}; preflight must not accept an older, unverified version`);
  for (const [file, text] of [["ci.yml", CI_YML], ["release.yml", RELEASE_YML]]) {
    const pins = [...text.matchAll(/@anthropic-ai\/claude-code@(\S+)/g)].map((m) => m[1]);
    assert.ok(pins.length > 0, `${file} installs a pinned Claude Code`);
    assert.deepEqual([...new Set(pins)], [MIN_CLAUDE], `${file} pins the preflight minimum`);
  }
});
