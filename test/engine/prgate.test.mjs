import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tokenize, parsePrCreate, mentionsPrCreate } from "../../plugin/engine/lib/cmdparse.mjs";
import { evaluatePrGate } from "../../plugin/engine/lib/prgate.mjs";
import { snapshotSession } from "../../plugin/engine/lib/detect.mjs";
import { newRecord, writeRecord, listMarkers, identityKey } from "../../plugin/engine/lib/state.mjs";
import { g, makeRepo, commitFile, tmpDir, crissCrossRepo } from "./helpers.mjs";

// ---- gh stub: answers from a JSON map keyed by the joined args; records every call ----
const binDir = tmpDir("rl-bin-");
const ghStub = path.join(binDir, "gh");
fs.writeFileSync(
  ghStub,
  `#!/usr/bin/env node
const fs = require("fs");
const key = process.argv.slice(2).join(" ");
fs.appendFileSync(process.env.STUB_GH_LOG, key + "\\n");
const map = JSON.parse(fs.readFileSync(process.env.STUB_GH_FILE, "utf8"));
const hit = map[key] ?? { code: 1, stderr: "gh: HTTP 404: Not Found" };
if (hit.stdout) process.stdout.write(hit.stdout + "\\n");
if (hit.stderr) process.stderr.write(hit.stderr + "\\n");
process.exitCode = hit.code ?? 0;
`,
  { mode: 0o755 }
);
process.env.PATH = `${binDir}:${process.env.PATH}`;

/** @param {Record<string, { stdout?: string, code?: number, stderr?: string }>} map */
function stubGh(map) {
  const dir = tmpDir("rl-ghmap-");
  process.env.STUB_GH_FILE = path.join(dir, "map.json");
  process.env.STUB_GH_LOG = path.join(dir, "log.txt");
  fs.writeFileSync(process.env.STUB_GH_FILE, JSON.stringify(map));
  fs.writeFileSync(process.env.STUB_GH_LOG, "");
}
const ghCalls = () => fs.readFileSync(process.env.STUB_GH_LOG ?? "", "utf8").split("\n").filter(Boolean);

beforeEach(() => {
  process.env.REVIEW_LOOP_STATE_DIR = tmpDir("rl-state-");
  delete process.env.GH_REPO;
});

/** main ← base; feature (checked out) with one commit; origin = me/proj on GitHub. */
function prRepo() {
  const repo = makeRepo();
  const a = commitFile(repo, "a.txt", "1");
  g(repo, "checkout", "-q", "-b", "feature");
  const head = commitFile(repo, "f.txt", "feat");
  g(repo, "remote", "add", "origin", "https://github.com/me/proj.git");
  g(repo, "config", "branch.feature.remote", "origin");
  return { repo, a, head };
}

const baseMap = (/** @type {string} */ baseSha, /** @type {string} */ headSha) => ({
  "repo set-default --view": { code: 1, stderr: "no default repository has been set" },
  "api repos/me/proj/git/ref/heads/main --jq .object.sha": { stdout: baseSha },
  "api repos/me/proj/git/ref/heads/feature --jq .object.sha": { stdout: headSha }
});

const ID = { kind: "branch", baseRepo: "me/proj", baseBranch: "main", headRepo: "me/proj", headBranch: "feature" };
function markPassed(identity, fingerprint) {
  const r = newRecord(identity);
  r.status = "passed";
  r.reviewedFingerprint = fingerprint;
  writeRecord(r);
}

// ---- tokenizer / parser ----

test("tokenizer: quotes, escapes, operators, expansion flags", () => {
  const segs = tokenize(`cd x && gh pr create --title "a b" --base 'dev' ; echo "$HOME" \`id\``);
  assert.deepEqual(segs.map((s) => s.map((w) => w.text)), [["cd", "x"], ["gh", "pr", "create", "--title", "a b", "--base", "dev"], ["echo", "$HOME", "`id`"]]);
  assert.equal(segs[2][1].unsafe, true);
  assert.equal(segs[1][6].unsafe, false);
});

test("parsePrCreate: flag forms, value-taking flags skipped, GH_REPO inline", () => {
  assert.equal(parsePrCreate("git status"), null);
  assert.deepEqual(parsePrCreate("GH_REPO=up/proj gh pr create -B develop --head=me:feat --title --base"), {
    base: "develop",
    head: "me:feat",
    repo: null,
    ghRepoEnv: "up/proj"
  });
  assert.deepEqual(parsePrCreate("/opt/homebrew/bin/gh pr create -Rup/proj"), { base: null, head: null, repo: "up/proj", ghRepoEnv: null });
});

test("parsePrCreate: shell-joined words and the `new` alias are PR creations; --help is not", () => {
  const none = { base: null, head: null, repo: null, ghRepoEnv: null };
  for (const cmd of ["gh pr c''reate", 'gh pr "create"', "gh pr cr\\eate", "g''h p\"\"r create", "gh pr new", "gh pr n'ew'", "gh pr cr\\\neate", "g\\\nh pr create"]) {
    assert.ok(mentionsPrCreate(cmd), cmd);
    assert.deepEqual(parsePrCreate(cmd), none, cmd);
  }
  assert.equal(parsePrCreate("gh pr create --help"), null);
  assert.equal(parsePrCreate("gh pr new -h"), null);
  assert.deepEqual(parsePrCreate("gh pr create --title -h"), none, "-h consumed as the --title value is not a help request");
});

test("parsePrCreate: gh reads flags before the subcommand — -R/--repo there is parsed, anything else is refused", () => {
  const repo = (/** @type {string} */ r) => ({ base: null, head: null, repo: r, ghRepoEnv: null });
  for (const cmd of ["gh --repo o/r pr create", "gh -R o/r pr new", "gh -Ro/r pr create", "gh --repo=o/r pr create"]) {
    assert.deepEqual(parsePrCreate(cmd), repo("o/r"), cmd);
  }
  assert.deepEqual(parsePrCreate("gh -R o/r pr create --base main"), { ...repo("o/r"), base: "main" });
  assert.throws(() => parsePrCreate("gh -R o/r pr create -R x/y"), { code: "pr_args_unresolvable" }, "a repo given twice");
  for (const cmd of [
    "gh --title x pr create",
    "gh -B main pr create",
    "gh --hostname h api -X POST repos/o/r/pulls",
    "bash -c 'gh --repo o/r pr create'",
    "gh api repos/o/r/issues && bash -c 'gh --hostname h api -X POST repos/o/r/pulls'"
  ]) {
    assert.throws(() => parsePrCreate(cmd), { code: "pr_args_unresolvable" }, cmd);
  }
  assert.throws(() => parsePrCreate("gh -R o/r api -X POST repos/o/r/pulls"), { code: "pr_via_api_unsupported" }, "the api check still sees past -R");
  assert.throws(() => parsePrCreate("gh pr create>out.txt ; bash -c 'true'"), { code: "pr_args_unresolvable" }, "a redirect glued to create is still a hit");
  assert.throws(() => parsePrCreate("gh -R o/r`gh pr create`"), { code: "pr_args_unresolvable" }, "a scan resumes at the gh it stopped on");
});

test("parsePrCreate stays linear on long flag runs (it runs on every Bash command)", () => {
  const cmd = "gh -a ".repeat(20000) + "x ; echo api pulls ; bash -c 'gh pr create'";
  const t = performance.now();
  assert.throws(() => parsePrCreate(cmd), { code: "pr_args_unresolvable" });
  assert.ok(performance.now() - t < 2000, `took ${Math.round(performance.now() - t)} ms`);
  assert.throws(() => parsePrCreate("gh pr create -B a ; gh pr new -B b"), { code: "pr_args_unresolvable" }, "two creations in one command");
  assert.throws(() => parsePrCreate("gh pr create --help; bash -c 'gh pr new'"), { code: "pr_args_unresolvable" }, "help does not excuse an unisolated creation");
});

test("parsePrCreate: gh api — POST to …/pulls or createPullRequest is denied; reads pass", () => {
  for (const cmd of [
    "gh api repos/o/r/pulls -f title=t -f head=x -f base=main",
    "gh api -X POST repos/o/r/pulls",
    "gh api --method=post /repos/o/r/pulls",
    "gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'"
  ]) {
    assert.throws(() => parsePrCreate(cmd), { code: "pr_via_api_unsupported" }, cmd);
  }
  assert.equal(parsePrCreate("gh api repos/o/r/pulls"), null, "GET list is a read");
  assert.equal(parsePrCreate("gh api -X GET repos/o/r/pulls -f state=open"), null, "explicit GET with fields is a read");
  assert.equal(parsePrCreate("gh api repos/o/r/pulls/3/comments -f body=x"), null, "not the create endpoint");
  assert.throws(() => parsePrCreate("bash -c 'gh api -X POST repos/o/r/pulls'"), { code: "pr_args_unresolvable" }, "an api hit we cannot isolate");
  for (const cmd of ["gh api repos/o/r/pulls -X GET -X POST", "gh api repos/o/r/pulls --method GET --method=POST", "gh api -XGET repos/o/r/pulls -X POST"]) {
    assert.throws(() => parsePrCreate(cmd), { code: "pr_args_unresolvable" }, `${cmd}: gh keeps the last method`);
  }
  assert.equal(parsePrCreate("gh api repos/o/r/pulls -X GET"), null, "control: one GET passes");
  for (const cmd of [
    "gh api -XPOST repos/o/r/pulls -f title=x",
    "gh api -X=POST repos/o/r/pulls",
    "gh api -iX POST repos/o/r/pulls",
    "gh api -iXPOST repos/o/r/pulls",
    "gh api --hostname github.com repos/o/r/pulls -f title=x",
    "gh api --made-up repos/o/r/pulls -f title=x",
    "gh api -Fq=@body.graphql graphql"
  ]) {
    assert.throws(() => parsePrCreate(cmd), { code: "pr_via_api_unsupported" }, `${cmd}: read as gh's flag parser reads it`);
  }
  assert.equal(parsePrCreate("gh api --paginate -i repos/o/r/pulls"), null, "control: boolean flags take no value");
  assert.equal(
    parsePrCreate("gh api --hostname ghe.example/pulls repos/o/r/issues -f body=x"),
    null,
    "precision: a value flag's value is not an endpoint, even when it looks like one"
  );
  assert.equal(parsePrCreate("gh api repos/o/r/issues -X GET -X GET ; echo pulls"), null, "control: repeats on other endpoints are not the gate's business");
  assert.throws(
    () => parsePrCreate("gh api repos/o/r/issues && bash -c 'gh api -X POST repos/o/r/pulls'"),
    { code: "pr_args_unresolvable" },
    "an isolated harmless api call does not vouch for a wrapped one"
  );
  assert.equal(parsePrCreate("gh api repos/o/r/issues && gh api repos/o/r/pulls"), null, "control: two isolated GETs pass");
});

test("parsePrCreate: gh api graphql with a body the gate cannot read is denied; inline read-only queries pass", () => {
  for (const cmd of [
    "gh api graphql --input mutation.json",
    "gh api graphql --input=mutation.json",
    "cat m.json | gh api graphql --input -",
    "gh api graphql -F query=@mutation.graphql",
    "gh api graphql --field query=@m.graphql",
    "gh api graphql -Fquery=@m.graphql",
    'gh api graphql -f query="$(cat m.graphql)"',
    "gh api /graphql --input m.json"
  ]) {
    assert.ok(mentionsPrCreate(cmd), `pre-filter routes: ${cmd}`);
    assert.throws(() => parsePrCreate(cmd), { code: "pr_via_api_unsupported" }, cmd);
  }
  assert.equal(parsePrCreate("gh api graphql -f query='query { viewer { login } }'"), null, "inline read-only query");
  assert.equal(parsePrCreate("gh api graphql -f query='query { viewer { login } }' -f owner=@me"), null, "-f is raw: @ is literal, not a file");
  assert.throws(() => parsePrCreate("bash -c 'gh api graphql --input m.json'"), (e) => e.code === "pr_args_unresolvable" && /pulls\/graphql/.test(e.message), "the message names the api hit");
});

test("parsePrCreate: expansions, duplicates, unterminated quotes, wrapped invocations are unresolvable", () => {
  for (const cmd of [
    `gh pr create --base "$BASE"`,
    "gh pr create --base $(git rev-parse --abbrev-ref HEAD)",
    "gh pr create --base a --base b",
    `gh pr create --title "oops`,
    `bash -c "gh pr create --base main"`
  ]) {
    assert.throws(() => parsePrCreate(cmd), { code: "pr_args_unresolvable" }, cmd);
  }
});

// ---- gate ----

test("non-PR commands pass through untouched", async () => {
  const { repo } = prRepo();
  stubGh({});
  assert.equal(await evaluatePrGate({ cwd: repo, session: "s", command: "git status && ls" }), null);
});

test("no branch pass → deny review_pending with a pending marker naming the skill", async () => {
  const { repo, a, head } = prRepo();
  stubGh(baseMap(a, head));
  const r = await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main --title t" });
  assert.equal(r?.decision, "deny");
  assert.equal(r?.code, "review_pending");
  assert.match(r?.message ?? "", /invoke the review-loop:review-loop skill \(node ".*\/review-round\.mjs" run --key /);
  const [m] = listMarkers();
  assert.deepEqual(m.identity, ID);
  assert.equal(m.extra.baseSha, a);
});

test("passed at the fingerprint → allow; one new commit → deny", async () => {
  const { repo, a, head } = prRepo();
  markPassed(ID, `${head}:${a}`);
  stubGh(baseMap(a, head));
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.decision, "allow");
  const head2 = commitFile(repo, "f.txt", "feat2");
  stubGh(baseMap(a, head2));
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.code, "review_pending");
});

test("stale local base: GitHub's base SHA (not local refs) decides; unknown base commit → pending with the fresh SHA", async () => {
  const { repo, a, head } = prRepo();
  markPassed(ID, `${head}:${a}`);
  const fresh = "b".repeat(40);
  stubGh(baseMap(fresh, head));
  const r = await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" });
  assert.equal(r?.code, "review_pending");
  assert.equal(listMarkers()[0].extra.baseSha, fresh);
});

test("stale local base ref with the fresh SHA known locally: the merge-base moved → the old pass does not apply", async () => {
  const { repo, a } = prRepo();
  const f1 = g(repo, "rev-parse", "HEAD");
  const head = commitFile(repo, "f2.txt", "feat2");
  // GitHub's main has merged f1 (so merge-base(head, main) is now f1), but local `main` is still at a.
  g(repo, "checkout", "-q", "--detach", a);
  g(repo, "merge", "-q", "--no-ff", "--no-edit", f1);
  const fresh = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "feature");
  assert.equal(g(repo, "rev-parse", "main"), a, "local main is stale");
  markPassed(ID, `${head}:${a}`);
  stubGh(baseMap(fresh, head));
  const r = await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" });
  assert.equal(r?.code, "review_pending", "a pass against the stale merge-base must not satisfy the gate");
});

test("base advanced but merge-base unchanged → still allowed (no needless re-review)", async () => {
  const { repo, a, head } = prRepo();
  g(repo, "checkout", "-q", "main");
  const b = commitFile(repo, "m.txt", "newer");
  g(repo, "checkout", "-q", "feature");
  markPassed(ID, `${head}:${a}`);
  stubGh(baseMap(b, head));
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.decision, "allow");
});

test("head not pushed: GitHub head differs from local HEAD", async () => {
  const { repo, a } = prRepo();
  stubGh(baseMap(a, "c".repeat(40)));
  const r = await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" });
  assert.equal(r?.code, "pr_head_not_pushed");
  assert.match(r?.message ?? "", /is at cccccc.* reviewed HEAD is/);
});

test("head API failure → pr_head_unverifiable; base API failure → pr_base_unverifiable", async () => {
  const { repo, a } = prRepo();
  stubGh({ ...baseMap(a, "x"), "api repos/me/proj/git/ref/heads/feature --jq .object.sha": { code: 1, stderr: "connection reset" } });
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.code, "pr_head_unverifiable");
  stubGh({ "repo set-default --view": { code: 1 }, "api repos/me/proj/git/ref/heads/main --jq .object.sha": { code: 1, stderr: "timeout" } });
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.code, "pr_base_unverifiable");
});

test("missing --base uses GitHub's default branch", async () => {
  const { repo, a, head } = prRepo();
  markPassed(ID, `${head}:${a}`);
  stubGh({ ...baseMap(a, head), "api repos/me/proj --jq .default_branch": { stdout: "main" } });
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create" }))?.decision, "allow");
});

test("base repo: two GitHub remotes and no default → ambiguous; gh default repo resolves it", async () => {
  const { repo, a, head } = prRepo();
  g(repo, "remote", "add", "upstream", "git@github.com:up/proj.git");
  stubGh(baseMap(a, head));
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.code, "pr_base_repo_ambiguous");
  stubGh({
    "repo set-default --view": { stdout: "up/proj" },
    "api repos/up/proj/git/ref/heads/main --jq .object.sha": { stdout: a },
    "api repos/me/proj/git/ref/heads/feature --jq .object.sha": { stdout: head }
  });
  await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" });
  assert.equal(listMarkers()[0].identity.baseRepo, "up/proj");
  assert.ok(ghCalls().includes("api repos/up/proj/git/ref/heads/main --jq .object.sha"), "base SHA asked from the PR's base repo");
});

test("fork head: owner:branch resolves the head repo from the matching remote; two forks are two identities", async () => {
  const { repo, a, head } = prRepo();
  g(repo, "remote", "add", "fork", "https://github.com/forkowner/proj.git");
  stubGh({
    "repo set-default --view": { code: 1 },
    "api repos/me/proj/git/ref/heads/main --jq .object.sha": { stdout: a },
    "api repos/forkowner/proj/git/ref/heads/feature --jq .object.sha": { stdout: head }
  });
  await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create -R me/proj --base main --head forkowner:feature" });
  const m = listMarkers()[0];
  assert.equal(m.identity.headRepo, "forkowner/proj");
  assert.notEqual(identityKey(m.identity), identityKey(ID));
});

test("head repo ambiguity, missing upstream, wrong branch, detached HEAD", async () => {
  const { repo, a, head } = prRepo();
  stubGh(baseMap(a, head));
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main --head nobody:feature" }))?.code, "pr_head_repo_ambiguous");
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main --head other" }))?.code, "pr_head_mismatch");
  g(repo, "config", "--unset", "branch.feature.remote");
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.code, "pr_head_not_pushed");
  g(repo, "checkout", "-q", "--detach");
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.code, "pr_head_mismatch");
});

test("unresolvable arguments deny before any GitHub call", async () => {
  const { repo } = prRepo();
  stubGh({});
  const r = await evaluatePrGate({ cwd: repo, session: "s", command: 'gh pr create --base "$B"' });
  assert.equal(r?.code, "pr_args_unresolvable");
  const pre = await evaluatePrGate({ cwd: repo, session: "s", command: "gh --title x pr create --base main" });
  assert.equal(pre?.code, "pr_args_unresolvable", "a flag before the subcommand is denied, never allowed through");
  assert.deepEqual(ghCalls(), []);
});

test("MCP create-PR input binds to the same identity as the gh command", async () => {
  const { repo, a, head } = prRepo();
  markPassed(ID, `${head}:${a}`);
  stubGh(baseMap(a, head));
  const r = await evaluatePrGate({ cwd: repo, session: "s", mcpInput: { owner: "me", repo: "proj", base: "main", head: "feature", title: "t" } });
  assert.equal(r?.decision, "allow");
});

test("criss-cross merge-base → merge_base_ambiguous", async () => {
  const { repo, x, y } = crissCrossRepo();
  g(repo, "checkout", "-q", "-b", "feature", x);
  g(repo, "remote", "add", "origin", "https://github.com/me/proj.git");
  g(repo, "config", "branch.feature.remote", "origin");
  stubGh(baseMap(y, x));
  assert.equal((await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create --base main" }))?.code, "merge_base_ambiguous");
});

test("kill switch present at session start allows with a loud, logged override; one created mid-session does not", async () => {
  const { repo } = prRepo();
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude", "review-loop.off"), "");
  await snapshotSession("s", repo);
  stubGh({});
  const r = await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create" });
  assert.equal(r?.decision, "allow");
  assert.match(r?.systemMessage ?? "", /WITHOUT review/);

  const other = prRepo().repo;
  await snapshotSession("s2", other);
  fs.mkdirSync(path.join(other, ".claude"));
  fs.writeFileSync(path.join(other, ".claude", "review-loop.off"), "");
  const late = await evaluatePrGate({ cwd: other, session: "s2", command: "gh pr create" });
  assert.equal(late?.decision, "deny", "an agent cannot switch its own gate off mid-session");
  const none = await evaluatePrGate({ cwd: other, session: null, command: "gh pr create" });
  assert.equal(none?.decision, "deny", "no session → no record of the switch at start → not honored");
});

test("a kill switch committed to the repo is ignored: the gate still denies", async () => {
  const { repo } = prRepo();
  commitFile(repo, ".claude/review-loop.off", "");
  stubGh({});
  const r = await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create" });
  assert.equal(r?.decision, "deny", JSON.stringify(r));
  g(repo, "rm", "-q", "--cached", ".claude/review-loop.off");
  const staged = await evaluatePrGate({ cwd: repo, session: "s", command: "gh pr create" });
  assert.equal(staged?.decision, "deny", "still in HEAD: a staged removal does not make it local");
});

test("L8: the brace and ANSI-C refusals name a workable way to send a multi-line PR body", () => {
  for (const cmd of ["gh pr create --title t --body $'l1\\nl2'", "gh pr create --title t {-B,} dev"]) {
    assert.throws(() => parsePrCreate(cmd), (e) => e instanceof Error && "code" in e && e.code === "pr_args_unresolvable" && /use `--body-file <file>` or a quoted heredoc/.test(e.message), cmd);
  }
});
