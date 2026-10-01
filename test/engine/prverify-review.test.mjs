import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir, makeRepo, commitFile, writeFile, g } from "./helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { writeRecord, newRecord, writeBaseline } from "../../plugin/engine/lib/state.mjs";

const G = "g" + "h";
const A = "a".repeat(40), B = "b".repeat(40), MB = "c".repeat(40);
const REAL_PATH = process.env.PATH;
const bin = path.join(tmpDir(), "bin");
const home = tmpDir();
Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
delete process.env.GH_REPO;
const usePath = () => { process.env.PATH = `${bin}:${REAL_PATH}`; };
usePath();
const { evaluatePrVerify } = await import("../../plugin/engine/lib/prverify.mjs");
const HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "plugin", "engine", "review-gate-hook.mjs");

const identity = { kind: "branch", baseRepo: "o/r", baseBranch: "main", headRepo: "o/r", headBranch: "feat" };
function reviewed(sha, status = "passed") {
  const rec = newRecord(identity);
  rec.status = status;
  rec.reviewedFingerprint = `${sha}:${MB}`;
  writeRecord(rec);
}
const FIELDS = "headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,state";
const prJson = (sha, extra = {}) => ({ headRefOid: sha, baseRefName: "main", headRefName: "feat", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" }, isDraft: false, state: "OPEN", ...extra });
const view = (sha, extra = {}) => ({ stdout: JSON.stringify(prJson(sha, extra)) });
const VIEW_ARGS = `pr view 7 --repo o/r --json ${FIELDS}`;
const LIST_ARGS = `pr list --repo o/r --head feat --state open --limit 10 --json number,${FIELDS}`;
const DRAFT_READ = "pr view 7 --repo o/r --json isDraft --jq .isDraft";
const READY = "pr ready 7 --repo o/r --undo";
const createCall = (preset = "default", cwd = home) => ({
  cwd, session: "s1", toolName: "Bash", preset,
  toolInput: { command: `${G} pr create --repo o/r --base main --head feat --title t` },
  toolResponse: { stdout: "https://github.com/o/r/pull/7\n" }
});
const mutated = (gh) => gh.log().filter((a) => a[0] === "pr" && (a[1] === "ready" || a[1] === "close"));
const mcpCall = (toolResponse, preset = "default") => ({ cwd: home, session: "s1", preset, toolName: "mcp__github__create_pull_request", toolInput: { owner: "o", repo: "r", base: "main", head: "feat" }, toolResponse });

function eventsOf(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
function hookRun(preset, input, envExtra = {}) {
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset, codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  const events = path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
  fs.rmSync(events, { force: true });
  const r = spawnSync(process.execPath, [HOOK, "prverify"], { env: { ...process.env, ...envExtra }, encoding: "utf8", input: JSON.stringify({ session_id: "s1", cwd: home, tool_name: "Bash", ...input }) });
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, decisions: eventsOf(events).filter((e) => e.event === "gate.decision") };
}

test("base repo resolves like the PR gate: a single GitHub remote (no --repo, no gh default) verifies", async () => {
  reviewed(A);
  const repo = makeRepo();
  commitFile(repo, "README.md", "x");
  g(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  const gh = makeFakeBin(bin, "gh", { "repo set-default --view": { code: 1, stderr: "no default" }, [VIEW_ARGS]: view(A) });
  const call = { ...createCall("default", repo), toolInput: { command: `${G} pr create --base main --head feat --title t` } };
  const r = await evaluatePrVerify(call);
  assert.deepEqual([r.outcome, r.code], ["allowed", "reviewed"]);
  assert.ok(gh.log().some((a) => a.join(" ") === VIEW_ARGS));
});

test("base repo resolves like the PR gate: process GH_REPO is honored", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  process.env.GH_REPO = "o/r";
  try {
    const call = { ...createCall(), toolInput: { command: `${G} pr create --base main --head feat --title t` } };
    assert.equal((await evaluatePrVerify(call)).code, "reviewed");
  } finally {
    delete process.env.GH_REPO;
  }
});

test("missing gh binary (empty PATH): loud unavailable naming the PR, one decision, no crash", async () => {
  reviewed(A);
  const empty = tmpDir();
  process.env.PATH = empty;
  try {
    const r = await evaluatePrVerify(createCall());
    assert.deepEqual([r.code, r.outcome, r.output.continue], ["pr_verify_unavailable", "denied", false]);
    assert.match(r.output.stopReason, /unreviewed PR #7 is open/);
    assert.match(r.output.stopReason, /gh is not installed/);
    const h = hookRun("default", { tool_input: createCall().toolInput, tool_response: createCall().toolResponse }, { PATH: empty });
    assert.equal(h.decisions.length, 1);
    assert.deepEqual([h.decisions[0].code, h.decisions[0].data.outcome], ["pr_verify_unavailable", "denied"]);
    assert.equal(h.out.continue, false);
    const a = hookRun("advisory", { tool_input: createCall().toolInput, tool_response: createCall().toolResponse }, { PATH: empty });
    assert.equal(a.decisions.length, 1);
    assert.deepEqual(Object.keys(a.out), ["systemMessage"]);
  } finally {
    usePath();
  }
});

test("a failing GitHub request is worded differently from a missing gh", async () => {
  makeFakeBin(bin, "gh", { "*": { code: 1, stderr: "HTTP 500" } });
  const r = await evaluatePrVerify(createCall());
  assert.match(r.output.stopReason, /GitHub request failed/);
  assert.doesNotMatch(r.output.stopReason, /not installed/);
});

test("kill switch: a create with review disabled is skipped: one skipped decision, no gh call, no output", async () => {
  reviewed(B);
  const repo = makeRepo();
  commitFile(repo, "README.md", "x");
  writeFile(repo, ".claude/review-loop.off", "");
  writeBaseline("s1", repo, {}, null, true);
  const gh = makeFakeBin(bin, "gh", { "*": view(B) });
  const r = await evaluatePrVerify(createCall("default", repo));
  assert.deepEqual([r.outcome, r.code, r.output], ["skipped", "kill_switch", null]);
  assert.equal(gh.log().length, 0);
  const h = hookRun("default", { cwd: repo, tool_input: createCall().toolInput, tool_response: createCall().toolResponse });
  assert.equal(h.out, null);
  assert.equal(h.decisions.length, 1);
  assert.deepEqual([h.decisions[0].code, h.decisions[0].data.outcome], ["kill_switch", "skipped"]);
  const all = eventsOf(path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl"));
  assert.equal(all.filter((e) => e.event === "override").length, 0, "the PR gate owns the override event; prverify logs only its decision");
});

test("kill switch created mid-session is ignored: the PR is still verified", async () => {
  reviewed(A);
  const repo = makeRepo();
  commitFile(repo, "README.md", "x");
  writeFile(repo, ".claude/review-loop.off", "");
  writeBaseline("s1", repo, {}, null, false);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  assert.equal((await evaluatePrVerify(createCall("default", repo))).code, "reviewed");
  assert.ok(gh.log().length > 0);
});

test("MCP content-array response: the PR number is read from the JSON text part", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const text = JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7" });
  assert.equal((await evaluatePrVerify(mcpCall([{ type: "text", text }]))).code, "reviewed");
  assert.equal((await evaluatePrVerify(mcpCall({ content: [{ type: "text", text }] }))).code, "reviewed");
  assert.equal((await evaluatePrVerify(mcpCall([{ type: "text", text: JSON.stringify({ html_url: "https://github.com/o/r/pull/7" }) }]))).code, "reviewed");
});

test("MCP response with no number: the PR is found by head branch; exactly one match is required", async () => {
  reviewed(A);
  const one = (sha) => ({ stdout: JSON.stringify([{ number: 7, ...prJson(sha) }]) });
  const noNumber = [{ type: "text", text: "Pull request created" }];
  makeFakeBin(bin, "gh", { [LIST_ARGS]: one(A) });
  assert.equal((await evaluatePrVerify(mcpCall(noNumber))).code, "reviewed");
  const gh = makeFakeBin(bin, "gh", { [LIST_ARGS]: one(B), [READY]: {}, [DRAFT_READ]: { stdout: "true\n" } });
  const bad = await evaluatePrVerify(mcpCall(noNumber));
  assert.deepEqual([bad.code, bad.detail], ["pr_created_head_unreviewed", "drafted"]);
  assert.match(bad.output.stopReason, /PR #7/);
  assert.ok(gh.log().some((a) => a.join(" ") === READY));
  makeFakeBin(bin, "gh", { [LIST_ARGS]: { stdout: JSON.stringify([{ number: 7, ...prJson(A) }, { number: 3, ...prJson(A) }]) } });
  const many = await evaluatePrVerify(mcpCall(noNumber));
  assert.equal(many.code, "pr_verify_unavailable");
  assert.match(many.output.stopReason, /several open PRs match/);
  makeFakeBin(bin, "gh", { [LIST_ARGS]: { stdout: "[]" } });
  assert.match((await evaluatePrVerify(mcpCall(noNumber))).output.stopReason, /no open PR found/);
  assert.match((await evaluatePrVerify(mcpCall(noNumber))).output.stopReason, /could not identify the PR/);
  assert.doesNotMatch((await evaluatePrVerify(mcpCall(noNumber))).output.stopReason, /PR 's/);
});

test("an oversized MCP text part is not parsed", async () => {
  makeFakeBin(bin, "gh", { "*": { code: 1 } });
  const huge = JSON.stringify({ number: 7, pad: "x".repeat(70 * 1024) });
  const r = await evaluatePrVerify(mcpCall([{ type: "text", text: huge }]));
  assert.doesNotMatch(r.output.stopReason, /PR #7/);
});

test("T-PR-2: containment issues the draft call (argv pinned)", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B), [READY]: {}, [DRAFT_READ]: { stdout: "true\n" } });
  await evaluatePrVerify(createCall());
  assert.ok(gh.log().some((a) => a.join(" ") === READY), "gh pr ready 7 --repo o/r --undo was called");
});

test("a record whose head matches but whose status is not passed/overridden does not vouch for the head", async () => {
  reviewed(A, "needs_fixes");
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A), [READY]: {}, [DRAFT_READ]: { stdout: "true\n" } });
  const r = await evaluatePrVerify(createCall());
  assert.deepEqual([r.code, r.outcome], ["pr_created_head_unreviewed", "denied"]);
  reviewed(A, "overridden");
  assert.equal((await evaluatePrVerify(createCall())).code, "reviewed");
});

test("state-aware containment: merged is uncontained and never called open; closed and already-draft need no call", async () => {
  reviewed(A);
  const merged = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B, { state: "MERGED" }) });
  const m = await evaluatePrVerify(createCall());
  assert.equal(m.detail, "uncontained");
  assert.match(m.output.stopReason, /MERGED unreviewed/);
  assert.doesNotMatch(m.output.stopReason, /marking it ready/);
  assert.doesNotMatch(m.output.stopReason, /open/);
  assert.equal(mutated(merged).length, 0);
  const closed = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B, { state: "CLOSED" }) });
  const c = await evaluatePrVerify(createCall());
  assert.deepEqual([c.detail, c.output.continue], ["closed", false]);
  assert.match(c.output.stopReason, /already closed/);
  assert.equal(mutated(closed).length, 0);
  const draft = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B, { isDraft: true }) });
  const d = await evaluatePrVerify(createCall());
  assert.equal(d.detail, "drafted");
  assert.match(d.output.stopReason, /already a draft/);
  assert.equal(mutated(draft).length, 0);
});

test("an overall deadline across gh calls: a slow gh takes the loud unavailable stop naming the PR", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: { ...view(A), delayMs: 1500 } });
  const t0 = Date.now();
  const r = await evaluatePrVerify({ ...createCall(), deadlineMs: 200 });
  assert.ok(Date.now() - t0 < 1200, "did not wait for the slow gh");
  assert.equal(r.code, "pr_verify_unavailable");
  assert.match(r.output.stopReason, /time budget exhausted/);
  assert.match(r.output.stopReason, /PR #7/);
});

test("Advisory: an implicit-POST gh api create (no -X) is recognized and warned about", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B) });
  const call = { ...createCall("advisory"), toolInput: { command: `${G} api repos/o/r/pulls -f base=main -f head=feat -f title=t` }, toolResponse: { stdout: JSON.stringify({ number: 7 }) } };
  const r = await evaluatePrVerify(call);
  assert.deepEqual([r.code, r.outcome], ["pr_created_head_unreviewed", "warned"]);
});

test("Advisory: an unparseable create warns instead of returning silently; Default stops", async () => {
  makeFakeBin(bin, "gh", {});
  const call = (preset) => ({ ...createCall(preset), toolInput: { command: G + ' pr create --repo "$R" --title t' } });
  const a = await evaluatePrVerify(call("advisory"));
  assert.deepEqual([a.code, a.outcome, Object.keys(a.output)], ["pr_verify_unavailable", "warned", ["systemMessage"]]);
  assert.match(a.output.systemMessage, /could not identify the PR/);
  assert.equal((await evaluatePrVerify(call("default"))).output.continue, false);
});

test("hook crash path: one decision, gateOutcome-based (Advisory warns, Default stops)", () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const bad = tmpDir();
  const link = path.join(bad, "state");
  fs.mkdirSync(link);
  fs.symlinkSync(tmpDir(), path.join(link, "records"));
  const events = path.join(bad, "events.jsonl");
  const cfg = (preset) => fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset, codex: { model: null, effort: null }, rubricPath: null, events: { path: events } }));
  const run = (preset) => {
    cfg(preset);
    fs.rmSync(events, { force: true });
    const r = spawnSync(process.execPath, [HOOK, "prverify"], {
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: link }, encoding: "utf8",
      input: JSON.stringify({ session_id: "s1", cwd: home, tool_name: "Bash", tool_input: createCall().toolInput, tool_response: createCall().toolResponse })
    });
    return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, decisions: eventsOf(events).filter((e) => e.event === "gate.decision") };
  };
  const d = run("default");
  assert.match(d.out.stopReason, /hook_error/, "the evaluation crashed (a linked state dir is rejected)");
  assert.equal(d.out.continue, false);
  assert.equal(d.decisions.length, 1);
  assert.equal(d.decisions[0].data.outcome, "denied");
  const a = run("advisory");
  assert.deepEqual(Object.keys(a.out), ["systemMessage"]);
  assert.equal(a.decisions.length, 1);
  assert.equal(a.decisions[0].data.outcome, "warned");
});

const listOf = (...prs) => ({ stdout: JSON.stringify(prs.map(([number, sha, extra]) => ({ number, ...prJson(sha, extra) }))) });
const noNumber = [{ type: "text", text: "Pull request created" }];

test("head lookup is open-only: a reused branch (open new PR + old merged PR) picks the open one", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [LIST_ARGS]: listOf([9, A]) });
  assert.equal((await evaluatePrVerify(mcpCall(noNumber))).code, "reviewed");
  assert.ok(gh.log().some((a) => a.join(" ") === LIST_ARGS && a.includes("open")), "lists open PRs only");
  assert.ok(!gh.log().flat().includes("all"));
});

test("head lookup filters by head owner: several owners share the branch name", async () => {
  reviewed(A);
  const forkPr = (n, owner, sha) => [n, sha, { headRepositoryOwner: { login: owner } }];
  makeFakeBin(bin, "gh", { [LIST_ARGS]: listOf(forkPr(1, "alice", B), forkPr(2, "o", B), forkPr(3, "me", B)) });
  const fork = { ...mcpCall(noNumber), toolInput: { owner: "o", repo: "r", base: "main", head: "me:feat" } };
  assert.match((await evaluatePrVerify(fork)).output.stopReason, /PR #3/, "owner from the owner:branch head");
  const same = await evaluatePrVerify(mcpCall(noNumber));
  assert.equal(same.code, "pr_created_head_unreviewed", "no owner prefix: the base owner's PR (#2, head B)");
  assert.match(same.output.stopReason, /PR #2/);
  makeFakeBin(bin, "gh", { [LIST_ARGS]: listOf(forkPr(1, "o", A), [2, A, { baseRefName: "dev", headRepositoryOwner: { login: "o" } }]) });
  assert.equal((await evaluatePrVerify(mcpCall(noNumber))).code, "reviewed", "the named base filters out the other base's PR");
  const noBase = { ...mcpCall(noNumber), toolInput: { owner: "o", repo: "r", head: "feat" } };
  assert.match((await evaluatePrVerify(noBase)).output.stopReason, /several open PRs/);
});

test("head lookup never falls open: an old closed PR with the reviewed head and the new PR not yet listed is a loud stop", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", {
    ["pr list --repo o/r --head feat --state all --limit 2 --json " + `number,${FIELDS}`]: listOf([4, A, { state: "CLOSED" }]),
    [LIST_ARGS]: { stdout: "[]" }
  });
  const r = await evaluatePrVerify(mcpCall(noNumber));
  assert.deepEqual([r.code, r.output.continue], ["pr_verify_unavailable", false]);
  assert.match(r.output.stopReason, /no open PR found/);
  assert.equal(mutated(gh).length, 0);
});

test("a full page of open PRs is not trusted", async () => {
  makeFakeBin(bin, "gh", { [LIST_ARGS]: listOf(...Array.from({ length: 10 }, (_, i) => [i + 1, A, { headRepositoryOwner: { login: i === 0 ? "o" : "x" + i } }])) });
  assert.match((await evaluatePrVerify(mcpCall(noNumber))).output.stopReason, /too many open PRs/);
});

test("a PR URL naming a different repository is its own reason", async () => {
  makeFakeBin(bin, "gh", { [LIST_ARGS]: listOf([9, A]) });
  const r = await evaluatePrVerify(mcpCall({ url: "https://github.com/evil/x/pull/7" }));
  assert.equal(r.code, "pr_verify_unavailable");
  assert.match(r.output.stopReason, /names a different repository/);
});

test("the deadline also bounds the gh --version probe", async () => {
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: { code: 1 }, "--version": { code: 0, stdout: "gh version x\n", delayMs: 2500 } });
  const t0 = Date.now();
  const r = await evaluatePrVerify({ ...createCall(), deadlineMs: 400 });
  assert.ok(Date.now() - t0 < 1500, `evaluation stayed inside its budget (took ${Date.now() - t0} ms)`);
  assert.equal(r.code, "pr_verify_unavailable");
});

test("PR gate: two remotes and no gh at all says gh is not installed, not 'run gh repo set-default'", async () => {
  const { evaluatePrGate } = await import("../../plugin/engine/lib/prgate.mjs");
  const repo = makeRepo();
  commitFile(repo, "README.md", "x");
  g(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  g(repo, "remote", "add", "upstream", "https://github.com/up/r.git");
  const empty = tmpDir();
  const gitDir = path.dirname(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());
  process.env.PATH = `${empty}:${gitDir}`;
  try {
    const r = await evaluatePrGate({ cwd: repo, session: "s1", command: G + " pr create --title t" });
    assert.equal(r?.decision, "deny");
    assert.equal(r?.code, "gh_not_installed");
    assert.match(r?.message ?? "", /not installed/);
    assert.doesNotMatch(r?.message ?? "", /set-default/);
  } finally {
    usePath();
  }
  makeFakeBin(bin, "gh", { "*": { code: 1 } });
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s1", command: G + " pr create --title t" }))?.code, "pr_base_repo_ambiguous");
});
