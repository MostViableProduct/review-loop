import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir } from "./helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { writeRecord, newRecord } from "../../plugin/engine/lib/state.mjs";

const G = "g" + "h";
const A = "a".repeat(40), B = "b".repeat(40), MB = "c".repeat(40);
const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
const home = tmpDir();
Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
const { evaluatePrVerify } = await import("../../plugin/engine/lib/prverify.mjs");
const HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "plugin", "engine", "review-gate-hook.mjs");

const identity = { kind: "branch", baseRepo: "o/r", baseBranch: "main", headRepo: "o/r", headBranch: "feat" };
function reviewed(sha) {
  const rec = newRecord(identity);
  rec.status = "passed";
  rec.reviewedFingerprint = `${sha}:${MB}`;
  writeRecord(rec);
}
const view = (sha, extra = {}) => ({ stdout: JSON.stringify({ headRefOid: sha, baseRefName: "main", headRefName: "feat", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" }, isDraft: false, state: "OPEN", ...extra }) });
const VIEW_ARGS = `pr view 7 --repo o/r --json headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,state`;
const DRAFT_READ = "pr view 7 --repo o/r --json isDraft --jq .isDraft";
const createCall = (preset = "default") => ({
  cwd: home, session: "s1", toolName: "Bash", preset,
  toolInput: { command: `${G} pr create --repo o/r --base main --head feat --title t` },
  toolResponse: { stdout: "https://github.com/o/r/pull/7\n" }
});

test("T-PR-1: head matches the reviewed SHA -> allowed, no mutation", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const r = await evaluatePrVerify(createCall());
  assert.deepEqual([r.outcome, r.output], ["allowed", null]);
  assert.ok(!gh.log().some((a) => a.includes("ready") || a.includes("close")));
});

test("T-PR-1 (-): a non-PR Bash command -> no evaluation", async () => {
  const gh = makeFakeBin(bin, "gh", {});
  const r = await evaluatePrVerify({ ...createCall(), toolInput: { command: "ls" } });
  assert.equal(r.output, null);
  assert.equal(r.code, "not_pr_creation");
  assert.equal(gh.log().length, 0);
});

test("T-PR-2: mismatch -> draft, verify isDraft, continue:false, detail drafted", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B), "pr ready 7 --repo o/r --undo": {}, [DRAFT_READ]: { stdout: "true\n" } });
  const r = await evaluatePrVerify(createCall());
  assert.deepEqual([r.code, r.detail, r.outcome], ["pr_created_head_unreviewed", "drafted", "denied"]);
  assert.deepEqual(Object.keys(r.output).sort(), ["continue", "stopReason"]);
  assert.equal(r.output.continue, false);
  assert.ok(gh.log().some((a) => a.join(" ") === DRAFT_READ), "draft state verified");
});

test("T-PR-2 (-a/b): draft does not stick -> close + verify; close fails -> uncontained", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", {
    [VIEW_ARGS]: view(B), "pr ready 7 --repo o/r --undo": {}, [DRAFT_READ]: { stdout: "false\n" },
    [`pr close 7 --repo o/r --comment review-loop: head ${B.slice(0, 7)} was not reviewed`]: {}, "pr view 7 --repo o/r --json state --jq .state": { stdout: "CLOSED\n" }
  });
  assert.equal((await evaluatePrVerify(createCall())).detail, "closed");
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B), "*": { code: 1, stderr: "HTTP 500" } });
  const r = await evaluatePrVerify(createCall());
  assert.equal(r.detail, "uncontained");
  assert.match(r.output.stopReason, /open and unreviewed/);
});

test("T-PR-2 (verified): ghPrDraft / ghPrClose return false when the read-back disagrees", async () => {
  const { ghPrDraft, ghPrClose } = await import("../../plugin/engine/lib/github.mjs");
  makeFakeBin(bin, "gh", { "*": { stdout: "false\n" } });
  assert.equal(await ghPrDraft("o/r", 7, home), false);
  makeFakeBin(bin, "gh", { "*": { stdout: "OPEN\n" } });
  assert.equal(await ghPrClose("o/r", 7, home, "c"), false);
  makeFakeBin(bin, "gh", { "*": { stdout: "true\n" } });
  assert.equal(await ghPrDraft("o/r", 7, home), true);
});

test("T-PR-3: official MCP response (ID + URL) -> gh lookup; without gh -> unavailable", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const mcp = { cwd: home, session: "s1", preset: "default", toolName: "mcp__github__create_pull_request", toolInput: { owner: "o", repo: "r", base: "main", head: "feat" }, toolResponse: { ID: 1, URL: "https://github.com/o/r/pull/7" } };
  assert.equal((await evaluatePrVerify(mcp)).outcome, "allowed");
  assert.equal((await evaluatePrVerify({ ...mcp, toolResponse: { number: 7, head: { sha: A } } })).outcome, "allowed");
  makeFakeBin(bin, "gh", { "*": { code: 127, stderr: "gh: command not found" } });
  const r = await evaluatePrVerify(mcp);
  assert.deepEqual([r.code, r.output.continue], ["pr_verify_unavailable", false]);
  const other = await evaluatePrVerify({ ...mcp, toolResponse: { ID: 1, URL: "https://github.com/evil/x/pull/7" } });
  assert.equal(other.code, "pr_verify_unavailable", "a URL for a different repo is not trusted");
});

test("T-PR-12b: the create response says A but GitHub's head is now B -> treated as unreviewed (race)", async () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B), "*": { stdout: "true\n" } });
  const resp = { stdout: JSON.stringify({ number: 7, head: { sha: A, ref: "feat", repo: { full_name: "o/r" } }, base: { ref: "main" } }) };
  const apiCall = { ...createCall(), toolInput: { command: `${G} api -X POST repos/o/r/pulls -f base=main -f head=feat -f title=t` }, toolResponse: resp };
  const r = await evaluatePrVerify(apiCall);
  assert.equal(r.code, "pr_created_head_unreviewed");
  assert.equal(r.output.continue, false);
  const mcp = await evaluatePrVerify({ cwd: home, session: "s1", preset: "default", toolName: "mcp__github__create_pull_request", toolInput: { owner: "o", repo: "r" }, toolResponse: { number: 7, head: { sha: A } } });
  assert.equal(mcp.code, "pr_created_head_unreviewed", "an MCP response head is not trusted either");
  makeFakeBin(bin, "gh", { "*": { code: 1, stderr: "HTTP 502" } });
  const down = await evaluatePrVerify(apiCall);
  assert.equal(down.code, "pr_verify_unavailable", "no current head -> fail closed, even though the response carried A");
});

test("T-PR-4 + T-PR-10: unverifiable fails closed under Default; Advisory only warns", async () => {
  makeFakeBin(bin, "gh", { "*": { code: 1, stderr: "HTTP 500" } });
  const d = await evaluatePrVerify(createCall("default"));
  assert.equal(d.output.continue, false);
  const a = await evaluatePrVerify(createCall("advisory"));
  assert.deepEqual(Object.keys(a.output), ["systemMessage"]);
  assert.equal(a.outcome, "warned");
});

test("Advisory mismatch warns only: no draft, no close, no blocking keys", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B) });
  const r = await evaluatePrVerify(createCall("advisory"));
  assert.deepEqual([r.code, r.outcome, Object.keys(r.output)], ["pr_created_head_unreviewed", "warned", ["systemMessage"]]);
  assert.ok(!gh.log().some((a) => a.includes("ready") || a.includes("close")), "advisory does not mutate the PR");
});

test("T-PR-11: gh api create response JSON is parsed for the PR number; the head is read from GitHub", async () => {
  reviewed(A);
  const gh = makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const call = { ...createCall(), toolInput: { command: `${G} api -X POST repos/o/r/pulls -f base=main -f head=feat -f title=t` }, toolResponse: { stdout: JSON.stringify({ number: 7, head: { sha: A, ref: "feat", repo: { full_name: "o/r" } }, base: { ref: "main" } }) } };
  assert.equal((await evaluatePrVerify(call)).outcome, "allowed");
  assert.ok(gh.log().some((a) => a.join(" ") === VIEW_ARGS), "PR #7 (from the response) was looked up on GitHub");
  const bad = await evaluatePrVerify({ ...call, toolResponse: { stdout: "{" + "x".repeat(2 * 1024 * 1024) } });
  assert.equal(bad.code, "pr_verify_unavailable");
});

function hookRun(preset, response) {
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset, codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  const events = path.join(process.env.REVIEW_LOOP_STATE_DIR, "events.jsonl");
  fs.rmSync(events, { force: true });
  const r = spawnSync(process.execPath, [HOOK, "prverify"], {
    env: process.env, encoding: "utf8",
    input: JSON.stringify({ session_id: "s1", cwd: home, tool_name: "Bash", tool_input: createCall().toolInput, tool_response: response })
  });
  const decisions = fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "gate.decision") : [];
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, decisions };
}

test("hook prverify: exactly one gate.decision per evaluation, and the outputs follow the preset", () => {
  reviewed(A);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(B), "pr ready 7 --repo o/r --undo": {}, [DRAFT_READ]: { stdout: "true\n" } });
  const resp = { stdout: "https://github.com/o/r/pull/7\n" };
  const d = hookRun("default", resp);
  assert.equal(d.decisions.length, 1);
  assert.deepEqual([d.decisions[0].code, d.decisions[0].detail, d.decisions[0].data.gate, d.decisions[0].data.outcome], ["pr_created_head_unreviewed", "drafted", "prverify", "denied"]);
  assert.equal(d.out.continue, false);
  const a = hookRun("advisory", resp);
  assert.equal(a.decisions.length, 1);
  assert.equal(a.decisions[0].data.outcome, "warned");
  assert.deepEqual(Object.keys(a.out), ["systemMessage"]);
  makeFakeBin(bin, "gh", { [VIEW_ARGS]: view(A) });
  const ok = hookRun("default", resp);
  assert.equal(ok.decisions.length, 1);
  assert.equal(ok.decisions[0].data.outcome, "allowed");
  assert.equal(ok.out, null);
});

test("hook prverify: a non-PR Bash command logs nothing", () => {
  const r = spawnSync(process.execPath, [HOOK, "prverify"], { env: process.env, encoding: "utf8", input: JSON.stringify({ session_id: "s1", cwd: home, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} }) });
  assert.equal(r.stdout, "");
});

test("makeFakeBin.set replaces the responses, resets counts, and keeps logging", async () => {
  const fake = makeFakeBin(bin, "gh", { "*": [{ stdout: "one\n" }, { stdout: "two\n" }] });
  const { run } = await import("../../plugin/engine/lib/proc.mjs");
  assert.equal((await run("gh", ["x"], { cwd: home, timeoutMs: 5000 })).stdout, "one\n");
  fake.set({ "*": [{ stdout: "new\n" }] });
  assert.equal((await run("gh", ["y"], { cwd: home, timeoutMs: 5000 })).stdout, "new\n");
  assert.deepEqual(fake.log(), [["x"], ["y"]]);
});
