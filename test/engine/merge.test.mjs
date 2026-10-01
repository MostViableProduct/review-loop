import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir, makeRepo, commitFile, g } from "./helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { writeRecord, newRecord, writeBaseline } from "../../plugin/engine/lib/state.mjs";
import { mentionsMerge, parseMerge } from "../../plugin/engine/lib/cmdparse.mjs";

const G = "g" + "h";
const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
const home = tmpDir();
Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
delete process.env.GH_REPO;
const { evaluateMergeGate, MCP_HEAD_FIELD } = await import("../../plugin/engine/lib/merge.mjs");
const HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "plugin", "engine", "review-gate-hook.mjs");
const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "mcp-merge-schema.json");

// A real local repo so merge-base is computed by git: main ← feat.
const repo = makeRepo();
const base = commitFile(repo, "a.txt", "a");
g(repo, "checkout", "-qb", "feat");
const A = commitFile(repo, "b.txt", "b");
const B = commitFile(repo, "c.txt", "c");
g(repo, "checkout", "-q", "main");
const identity = (baseBranch) => ({ kind: "branch", baseRepo: "o/r", baseBranch, headRepo: "o/r", headBranch: "feat" });
function reviewed(baseBranch, head, mergeBase, status = "passed") {
  const rec = newRecord(identity(baseBranch));
  rec.status = status;
  rec.reviewedFingerprint = `${head}:${mergeBase}`;
  writeRecord(rec);
}
const VIEW = "pr view 5 --repo o/r --json headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,state";
const pr = (baseRefName, extra = {}) => ({ stdout: JSON.stringify({ headRefOid: A, baseRefName, headRefName: "feat", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" }, isDraft: false, state: "OPEN", ...extra }) });
const baseTip = (branch) => ({ [`api repos/o/r/git/ref/heads/${branch} --jq .object.sha`]: { stdout: `${base}\n` } });
// A generous budget: these tests pin decisions, not the 30 s production budget (a test can still pass its own).
const call = (command, preset = "default") => evaluateMergeGate({ cwd: repo, session: "s", command, preset, deadlineMs: 120_000 });
const mcp = (input, extra = {}) => evaluateMergeGate({ cwd: repo, session: "s", mcpInput: { owner: "o", repo: "r", pullNumber: 5, ...input }, preset: "default", deadlineMs: 120_000, ...extra });
const ok = () => {
  reviewed("main", A, base);
  return makeFakeBin(bin, "gh", { [VIEW]: pr("main"), ...baseTip("main") });
};

test("classifier: merges recognised; reads are not", () => {
  for (const c of [`${G} pr merge 5 --squash`, `${G} api -X PUT repos/o/r/pulls/5/merge`, `${G} api graphql -f query='mutation{mergePullRequest(input:{})}'`, `curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge`]) assert.ok(mentionsMerge(c), c);
  for (const c of [`${G} pr view 5`, `${G} pr checks 5`, `${G} api -X GET repos/o/r/pulls/5`, `${G} api repos/o/r/pulls/5/merge`, "git merge main", `curl https://api.github.com/repos/o/r`, `curl https://api.github.com/repos/o/r/pulls`]) assert.equal(parseMerge(c), null, c);
  assert.deepEqual(parseMerge(`${G} pr merge 5 --auto --subject 7 --match-head-commit ${A}`), { kind: "pr-merge", number: 5, repo: null, ghRepoEnv: null, bind: A, auto: true, admin: false });
  assert.deepEqual(parseMerge(`GH_REPO=x/y ${G} pr merge https://github.com/o/r/pull/9 --admin`), { kind: "pr-merge", number: 9, repo: "o/r", ghRepoEnv: "x/y", bind: null, auto: false, admin: true });
  assert.deepEqual(parseMerge(`${G} -R o/r pr merge 9`), { kind: "pr-merge", number: 9, repo: "o/r", ghRepoEnv: null, bind: null, auto: false, admin: false });
  assert.equal(parseMerge(`${G} pr merge 5 --disable-auto`), null, "cancelling auto-merge is not a merge");
  assert.equal(parseMerge(`${G} pr merge --help`), null);
  assert.deepEqual(parseMerge(`${G} api repos/{owner}/{repo}/pulls/5/merge -X PUT -f sha=${A}`), { kind: "api-merge", repo: null, ghRepoEnv: null, number: 5, bind: A, input: false });
});

test("classifier: a merge the parser cannot isolate fails closed", () => {
  for (const c of [`bash -c "${G} pr merge 5"`, `echo ${G} pr merge 5`, `${G} pr merge 5 && ${G} pr merge 6`, `${G} pr merge $N`, `${G} pr merge 5 --match-head-commit ${A} --match-head-commit ${B}`]) {
    assert.throws(() => parseMerge(c), (e) => e.code === "pr_args_unresolvable", c);
  }
});

test("T-PR-6: create + merge in one call → compound deny, no gh call", async () => {
  const gh = makeFakeBin(bin, "gh", {});
  for (const sep of [" && ", "; ", "\n", " || "]) {
    const r = await call(`${G} pr create --title t${sep}${G} pr merge --squash`);
    assert.equal(r.code, "pr_create_merge_compound", JSON.stringify(sep));
  }
  assert.equal((await call(`(${G} pr create --title t) && (${G} pr merge 5 --match-head-commit ${A})`)).code, "pr_create_merge_compound", "subshell");
  assert.equal((await call(`${G} api -X POST repos/o/r/pulls -f head=feat && ${G} pr merge 5`)).code, "pr_create_merge_compound", "API create counts");
  assert.equal(gh.log().length, 0);
});

test("R-D4: the compound rule is tokenized, never a text heuristic", async () => {
  const gh = makeFakeBin(bin, "gh", {});
  const titled = `${G} pr create --title "merge the fix" --body "then ${G} pr merge"`;
  assert.equal(parseMerge(`${G} pr create --title "merge the fix"`), null);
  assert.equal((await call(`${G} pr create --title "merge the fix"`)).code, "not_merge", "a create whose title says merge is not compound");
  assert.notEqual((await call(titled)).code, "pr_create_merge_compound");
  assert.equal(gh.log().length, 0);
  ok();
  assert.equal((await call(`${G} api -X PUT repos/o/r/pulls/5/merge -f sha=${A}`)).decision, "allow", "an api merge touching pulls/ is not a creation");
});

test("T-PR-7: bound to a reviewed SHA for THIS PR's identity → allow; else deny", async () => {
  ok();
  assert.equal((await call(`${G} pr merge 5 --repo o/r --squash --match-head-commit ${A}`)).decision, "allow");
  assert.equal((await call(`${G} api -X PUT repos/o/r/pulls/5/merge -f sha=${A}`)).decision, "allow");
  assert.equal((await call(`${G} api -X PUT https://api.github.com/repos/o/r/pulls/5/merge -F sha=${A}`)).decision, "allow");
  const unbound = await call(`${G} pr merge 5 --repo o/r --squash`);
  assert.equal(unbound.code, "pr_merge_unbound");
  assert.match(unbound.message, new RegExp(`--match-head-commit ${A}`));
  assert.equal((await call(`${G} api -X PUT repos/o/r/pulls/5/merge`)).code, "pr_merge_unbound", "api without sha");
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${"d".repeat(40)}`)).code, "pr_merge_unbound", "(b) unreviewed SHA");
});

test("T-PR-7: the PR's repo comes from the one base resolution (GH_REPO, -R before the subcommand)", async () => {
  ok();
  assert.equal((await call(`GH_REPO=o/r ${G} pr merge 5 --match-head-commit ${A}`)).decision, "allow");
  assert.equal((await call(`${G} -R o/r pr merge 5 --match-head-commit ${A}`)).decision, "allow");
  assert.equal((await call(`${G} pr merge --repo o/r --match-head-commit ${A}`)).code, "pr_merge_context_unverifiable", "no PR number");
});

test("R-D16 + record states: no record, or a record not passed/overridden → unbound (never unverifiable)", async () => {
  makeFakeBin(bin, "gh", { [VIEW]: pr("main", { headRefName: "other" }), ...baseTip("main") });
  const none = await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`);
  assert.equal(none.code, "pr_merge_unbound");
  assert.match(none.message, /no passed review/);
  reviewed("main", A, base, "needs_fixes");
  makeFakeBin(bin, "gh", { [VIEW]: pr("main"), ...baseTip("main") });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_unbound");
  reviewed("main", A, base, "overridden");
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).decision, "allow", "a logged override clears");
});

test("R-P7a: headRefOid is re-checked immediately before allowing", async () => {
  reviewed("main", A, base);
  const gh = makeFakeBin(bin, "gh", { [VIEW]: [pr("main"), pr("main")], ...baseTip("main") });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).decision, "allow", "match");
  assert.equal(gh.log().filter((a) => a.join(" ") === VIEW).length, 2, "the PR is read twice: gate check, then re-check");
  gh.set({ [VIEW]: [pr("main"), pr("main", { headRefOid: B })], ...baseTip("main") });
  const moved = await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`);
  assert.equal(moved.code, "pr_merge_unbound", "mismatch");
  assert.match(moved.message, new RegExp(`moved to ${B.slice(0, 7)}`));
  gh.set({ [VIEW]: [pr("main"), pr("release")], ...baseTip("main") });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_unbound", "retargeted between check and re-check");
  gh.set({ [VIEW]: [pr("main"), { code: 1, stderr: "HTTP 502" }], ...baseTip("main") });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_context_unverifiable", "re-check unreadable");
});

test("the base tip is re-read immediately before allowing: a base moved after the merge-base check denies with retry", async () => {
  reviewed("main", A, base);
  const REF = `api repos/o/r/git/ref/heads/main --jq .object.sha`;
  const gh = makeFakeBin(bin, "gh", { [VIEW]: [pr("main"), pr("main")], [REF]: [{ stdout: `${base}\n` }, { stdout: `${base}\n` }] });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).decision, "allow", "base unchanged");
  assert.equal(gh.log().filter((a) => a.join(" ") === REF).length, 2, "the base tip is read twice: merge-base check, then re-check");
  gh.set({ [VIEW]: [pr("main"), pr("main")], [REF]: [{ stdout: `${base}\n` }, { stdout: `${B}\n` }] });
  const moved = await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`);
  assert.equal(moved.decision, "deny");
  assert.equal(moved.code, "pr_merge_context_unverifiable");
  assert.match(moved.message, /base main moved during the gate's check; retry the merge/);
  gh.set({ [VIEW]: [pr("main"), pr("main")], [REF]: [{ stdout: `${base}\n` }, { code: 1, stderr: "HTTP 502" }] });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_context_unverifiable", "base re-read unreadable");
});

test("T-PR-7 (c) + T-PR-9: same head SHA, different base (retarget) → deny", async () => {
  reviewed("main", A, base);
  const gh = makeFakeBin(bin, "gh", { [VIEW]: pr("main"), ...baseTip("main") });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).decision, "allow");
  gh.set({ [VIEW]: pr("release"), ...baseTip("release") });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_unbound");
});

test("context binding: the same identity and head, reviewed against a different merge-base → deny", async () => {
  reviewed("main", A, "e".repeat(40));
  makeFakeBin(bin, "gh", { [VIEW]: pr("main"), ...baseTip("main") });
  const r = await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`);
  assert.equal(r.code, "pr_merge_unbound");
  assert.match(r.message, /different base/);
});

test("a base tip missing locally is fetched (bounded) before the merge-base is computed; a failed fetch fails closed", async () => {
  const local = makeRepo();
  const b0 = commitFile(local, "a.txt", "a");
  g(local, "checkout", "-qb", "feat");
  const head = commitFile(local, "b.txt", "b");
  const bare = path.join(tmpDir(), "r.git");
  g(local, "clone", "-q", "--bare", local, bare);
  const work = tmpDir();
  g(work, "clone", "-q", bare, ".");
  g(work, "checkout", "-q", "main");
  const tip = commitFile(work, "m.txt", "m");
  g(work, "push", "-q", "origin", "main");
  reviewed("main", head, b0);
  makeFakeBin(bin, "gh", { [VIEW]: pr("main", { headRefOid: head }), "api repos/o/r/git/ref/heads/main --jq .object.sha": { stdout: `${tip}\n` } });
  const run = () => evaluateMergeGate({ cwd: local, session: "s", command: `${G} pr merge 5 --repo o/r --match-head-commit ${head}`, preset: "default" });
  // Both routes stay local: the test never reaches github.com.
  const missing = path.join(tmpDir(), "missing.git");
  g(local, "config", `url.${missing}.insteadOf`, "https://github.com/o/r.git");
  assert.equal((await run()).code, "pr_merge_context_unverifiable", "the fetch fails: fails closed");
  g(local, "config", "--remove-section", `url.${missing}`);
  g(local, "config", `url.${bare}.insteadOf`, "https://github.com/o/r.git");
  assert.equal((await run()).decision, "allow");
  assert.equal(g(local, "cat-file", "-t", tip), "commit", "the base tip was fetched");
  reviewed("main", A, base);
});

test("merge-state edge cases are loud: merged, closed, draft; --auto bound; --admin noted", async () => {
  reviewed("main", A, base);
  for (const [extra, what] of [[{ state: "MERGED" }, /already merged/], [{ state: "CLOSED" }, /closed/], [{ isDraft: true }, /draft/]]) {
    makeFakeBin(bin, "gh", { [VIEW]: pr("main", extra), ...baseTip("main") });
    const r = await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`);
    assert.deepEqual([r.decision, r.code], ["deny", "pr_merge_not_open"], JSON.stringify(extra));
    assert.match(r.message, what);
  }
  ok();
  assert.equal((await call(`${G} pr merge 5 --repo o/r --auto --match-head-commit ${A}`)).decision, "allow", "P7-auto=bound");
  assert.equal((await call(`${G} pr merge 5 --repo o/r --auto`)).code, "pr_merge_unbound");
  const admin = await call(`${G} pr merge 5 --repo o/r --admin --match-head-commit ${A}`);
  assert.equal(admin.decision, "allow");
  assert.match(admin.message, /--admin bypasses branch protection/);
  const head = await call(`${G} pr merge 5 --repo o/r --match-head-commit ${B}`);
  assert.equal(head.code, "pr_merge_unbound", "a binding that is not the PR's current head");
});

test("T-PR-7 (d–i): graphql, repeated -X, no gh, MCP field rules, Advisory", async () => {
  assert.equal((await call(`${G} api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`)).code, "pr_merge_graphql_unsupported");
  assert.equal((await call(`${G} api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:"x"}){clientMutationId}}'`)).code, "pr_merge_graphql_unsupported");
  assert.equal((await call(`${G} api -X PUT -X GET repos/o/r/pulls/5/merge`)).code, "pr_args_unresolvable");
  makeFakeBin(bin, "gh", { "*": { code: 127, stderr: "not found" } });
  assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_context_unverifiable");
  const noGh = path.join(tmpDir(), "nogh");
  fs.mkdirSync(noGh);
  const saved = process.env.PATH;
  process.env.PATH = `${noGh}:/usr/bin:/bin`;
  try {
    assert.equal((await call(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`)).code, "pr_merge_context_unverifiable", "gh not installed");
  } finally {
    process.env.PATH = saved;
  }
  ok();
  assert.equal(MCP_HEAD_FIELD, "expectedHeadSha");
  assert.equal((await mcp({ [MCP_HEAD_FIELD]: A })).decision, "allow");
  assert.equal((await mcp({ [MCP_HEAD_FIELD]: A, pullNumber: "5" })).decision, "allow");
  assert.equal((await mcp({ sha: A })).code, "pr_merge_unbound", "(g) a field not in the schema is not a binding");
  assert.equal((await mcp({ [MCP_HEAD_FIELD]: A }, { mcpHeadField: null })).code, "pr_merge_mcp_unbindable", "(h)");
  assert.equal((await mcp({ [MCP_HEAD_FIELD]: A, owner: undefined })).code, "pr_merge_context_unverifiable");
  const adv = await call(`${G} pr merge 5 --repo o/r --squash`, "advisory");
  assert.equal(adv.decision, "warn", "(i)");
  assert.match(adv.message, /Advisory/);
});

test("the shipped MCP head field is the P7 fixture's", () => {
  assert.equal(MCP_HEAD_FIELD, JSON.parse(fs.readFileSync(FIXTURE, "utf8")).headField);
});

test("T-PR-10 (merge half): Advisory never denies, whatever the failure", async () => {
  makeFakeBin(bin, "gh", {});
  for (const c of [`${G} pr create --title t && ${G} pr merge 5`, `${G} api -X PUT -X GET repos/o/r/pulls/5/merge`, `${G} api graphql -f query='mutation{mergePullRequest(input:{})}'`, "curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge", `${G} pr merge 5 --repo o/r`, `bash -c "${G} pr merge 5"`]) {
    const r = await call(c, "advisory");
    assert.equal(r.decision, "warn", c);
  }
  assert.equal((await call(`${G} pr merge 5 --repo o/r`, "balanced")).decision, "deny", "Balanced enforces");
});

test("kill switch present at session start: allow, code kill_switch, no gh call", async () => {
  const other = makeRepo();
  commitFile(other, "a.txt", "a");
  fs.mkdirSync(path.join(other, ".claude"));
  fs.writeFileSync(path.join(other, ".claude", "review-loop.off"), "");
  writeBaseline("ks", other, {}, null, true);
  const gh = makeFakeBin(bin, "gh", {});
  const r = await evaluateMergeGate({ cwd: other, session: "ks", command: `${G} pr merge 5 --repo o/r`, preset: "default" });
  assert.deepEqual([r.decision, r.code], ["allow", "kill_switch"]);
  assert.equal(gh.log().length, 0);
  const late = await evaluateMergeGate({ cwd: other, session: "not-at-start", command: `${G} pr merge 5 --repo o/r`, preset: "default" });
  assert.equal(late.decision, "deny", "a switch not recorded at session start is ignored");
});

test("T-PR-8 + T-PR-12: reads untouched; raw REST clients denied best-effort", async () => {
  assert.equal(parseMerge(`${G} pr view 5`), null);
  for (const c of [
    "curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge", "curl -XPUT https://api.github.com/repos/o/r/pulls/5/merge",
    "wget --method=PUT https://api.github.com/repos/o/r/pulls/5/merge", "curl -X POST https://api.github.com/repos/o/r/pulls -d '{}'",
    "curl -d '{}' https://api.github.com/repos/o/r/pulls", "http PUT https://api.github.com/repos/o/r/pulls/5/merge",
    "xh https://api.github.com/repos/o/r/pulls title=t head=feat", "curl -X PATCH https://api.github.com/repos/o/r/pulls/5 -d '{}'"
  ]) {
    assert.equal((await call(c)).code, "pr_github_api_unsupported_client", c);
  }
  assert.equal(parseMerge("curl https://api.github.com/repos/o/r"), null);
  assert.equal(parseMerge("curl -s https://api.github.com/repos/o/r/pulls?state=open"), null, "a GET of pulls is a read");
});

// ---- the hook: dispatch, one gate.decision per evaluation, preset-shaped output ----

const cfg = path.join(home, "cfg.json");
const eventsFile = path.join(home, "state", "events.jsonl");
function hook(input, preset = "default") {
  fs.writeFileSync(cfg, JSON.stringify({ version: 1, preset, codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  const before = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").length : 0;
  const r = spawnSync(process.execPath, [HOOK, "pr"], { env: process.env, encoding: "utf8", input: JSON.stringify({ session_id: "s1", cwd: repo, ...input }) });
  const lines = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").slice(before).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, events: lines, decisions: lines.filter((e) => e.event === "gate.decision") };
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

test("hook: a merge logs exactly one gate.decision with gate merge; output follows the preset", () => {
  ok();
  const d = hook(bash(`${G} pr merge 5 --repo o/r`));
  assert.equal(d.decisions.length, 1);
  assert.deepEqual([d.decisions[0].data.gate, d.decisions[0].data.outcome, d.decisions[0].code, d.decisions[0].data.pending_count], ["merge", "denied", "pr_merge_unbound", 1]);
  assert.equal(d.out.hookSpecificOutput.permissionDecision, "deny");
  const a = hook(bash(`${G} pr merge 5 --repo o/r`), "advisory");
  assert.equal(a.decisions.length, 1);
  assert.equal(a.decisions[0].data.outcome, "warned");
  assert.deepEqual(Object.keys(a.out), ["systemMessage"]);
  const y = hook(bash(`${G} pr merge 5 --repo o/r --match-head-commit ${A}`));
  assert.deepEqual([y.decisions.length, y.decisions[0].data.gate, y.decisions[0].data.outcome, y.out], [1, "merge", "allowed", null]);
  const m = hook({ tool_name: "mcp__github__merge_pull_request", tool_input: { owner: "o", repo: "r", pullNumber: 5, expectedHeadSha: A } });
  assert.deepEqual([m.decisions.length, m.decisions[0].data.gate, m.decisions[0].data.outcome], [1, "merge", "allowed"]);
  const c = hook(bash(`${G} pr create --title t && ${G} pr merge 5`));
  assert.deepEqual([c.decisions.length, c.decisions[0].data.gate, c.decisions[0].code], [1, "merge", "pr_create_merge_compound"]);
  for (const x of [d, a, y, m, c]) assert.ok(!JSON.stringify(x.events).includes(A), "events carry no SHAs");
});

test("hook: non-merge commands are untouched; a create titled 'merge' goes to the PR gate only", () => {
  const gh = makeFakeBin(bin, "gh", {});
  for (const c of ["ls", `${G} pr view 5`, `${G} pr checks 5`, `${G} api -X GET repos/o/r/pulls/5`]) {
    const r = hook(bash(c));
    assert.deepEqual([r.out, r.decisions.length], [null, 0], c);
  }
  assert.equal(gh.log().length, 0);
  const t = hook(bash(`${G} pr create --title "merge the fix"`));
  assert.equal(t.decisions.length, 1);
  assert.equal(t.decisions[0].data.gate, "pr");
});

test("hook: kill switch → one skipped decision, code kill_switch, no override event", () => {
  const other = makeRepo();
  commitFile(other, "a.txt", "a");
  fs.mkdirSync(path.join(other, ".claude"));
  fs.writeFileSync(path.join(other, ".claude", "review-loop.off"), "");
  writeBaseline("s1", other, {}, null, true);
  makeFakeBin(bin, "gh", {});
  fs.writeFileSync(cfg, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  const before = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").length : 0;
  const r = spawnSync(process.execPath, [HOOK, "pr"], { env: process.env, encoding: "utf8", input: JSON.stringify({ session_id: "s1", cwd: other, ...bash(`${G} pr merge 5 --repo o/r`) }) });
  const lines = fs.readFileSync(eventsFile, "utf8").slice(before).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.event, l.code, l.data.gate, l.data.outcome]), [["gate.decision", "kill_switch", "merge", "skipped"]]);
  assert.match(JSON.parse(r.stdout).systemMessage, /kill switch/);
});
