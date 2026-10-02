// Review round 1 of the merge gate: every bypass the reviewer's probe found, as a table, plus the fixes' own gates.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpDir, makeRepo, commitFile, g } from "./helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";
import { writeRecord, newRecord, writeBaseline } from "../../plugin/engine/lib/state.mjs";
import { mentionsMerge, mentionsPrCreate, parseMerge, parsePrCreate } from "../../plugin/engine/lib/cmdparse.mjs";
import { advisoryText } from "../../plugin/engine/lib/presets.mjs";

const G = "g" + "h";
const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
const home = tmpDir();
Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
delete process.env.GH_REPO;
const { evaluateMergeGate } = await import("../../plugin/engine/lib/merge.mjs");
const HOOK = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "plugin", "engine", "review-gate-hook.mjs");

const repo = makeRepo();
const base = commitFile(repo, "a.txt", "a");
g(repo, "checkout", "-qb", "feat");
const A = commitFile(repo, "b.txt", "b");
const B = commitFile(repo, "c.txt", "c");
g(repo, "checkout", "-q", "main");
const rec = newRecord({ kind: "branch", baseRepo: "o/r", baseBranch: "main", headRepo: "o/r", headBranch: "feat" });
rec.status = "passed";
rec.reviewedFingerprint = `${A}:${base}`;
writeRecord(rec);

const F = "headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isDraft,state";
const view = (head, baseRefName, owner = "o", name = "r") => ({ stdout: JSON.stringify({ headRefOid: head, baseRefName, headRefName: "feat", headRepository: { name }, headRepositoryOwner: { login: owner }, isDraft: false, state: "OPEN" }) });
const GH_MAP = {
  "--version": { stdout: "gh version 2.0.0\n" },
  "repo set-default --view": { stdout: "o/r\n" },
  [`pr view 5 --repo o/r --json ${F}`]: view(A, "main"),
  [`pr view 7 --repo o/r --json ${F}`]: view(B, "main"),
  [`pr view 8 --repo o/r --json ${F}`]: view(A, "release"),
  [`pr view 5 --repo x/y --json ${F}`]: view(A, "main", "x", "y"),
  "api repos/o/r/git/ref/heads/main --jq .object.sha": { stdout: `${base}\n` },
  "api repos/x/y/git/ref/heads/main --jq .object.sha": { stdout: `${base}\n` }
};
const gh = makeFakeBin(bin, "gh", GH_MAP);
// A generous budget: these tests pin decisions, not the 30 s production budget (the deadline tests pass their own).
const call = (command, preset = "default") => evaluateMergeGate({ cwd: repo, session: "s", command, preset, deadlineMs: 120_000 });
const mcp = (input, preset = "default") => evaluateMergeGate({ cwd: repo, session: "s", mcpInput: input, preset, deadlineMs: 120_000 });

const ALLOW = "allow:reviewed";
const UNBOUND = "deny:pr_merge_unbound";
const UNRESOLVABLE = "deny:pr_args_unresolvable";
const UNVERIFIABLE = "deny:pr_merge_context_unverifiable";
const GRAPHQL = "deny:pr_merge_graphql_unsupported";
const RAW = "deny:pr_github_api_unsupported_client";
const NOT_MERGE = "allow:not_merge";
const MERGE_GH = `mutation{mergePullRequest(input:{pullRequestId:"${G} x"}){clientMutationId}}`;
const CREATE_GH = `mutation{createPullRequest(input:{repositoryId:"x",baseRefName:"main",headRefName:"feat",title:"${G} x"}){pullRequest{number}}}`;

// [name, Bash command or MCP input, expected "decision:code", gh pr view the gate must consult (optional)]
/** @type {Array<[string, string | Record<string, unknown>, string, string?]>} */
const PROBE = [
  ["baseline bound+cleared", `${G} pr merge 5 --merge --match-head-commit ${A}`, ALLOW],
  ["head differs (PR7 head=B), bind A", `${G} pr merge 7 --merge --match-head-commit ${A}`, UNBOUND],
  ["no number (current branch)", `${G} pr merge --merge --match-head-commit ${A}`, UNVERIFIABLE],
  ["URL form, cleared", `${G} pr merge https://github.com/o/r/pull/5 --match-head-commit ${A}`, ALLOW],
  ["URL form, PR7", `${G} pr merge https://github.com/o/r/pull/7 --match-head-commit ${A}`, UNBOUND],
  ["-R other repo", `${G} pr merge 5 -R x/y --match-head-commit ${A}`, UNBOUND, "x/y"],
  ["--auto unbound", `${G} pr merge 5 --auto`, UNBOUND],
  ["--auto bound", `${G} pr merge 5 --auto --match-head-commit ${A}`, ALLOW],
  ["--admin unbound", `${G} pr merge 5 --admin`, UNBOUND],
  ["--squash unbound", `${G} pr merge 5 --squash`, UNBOUND],
  ["--rebase unbound", `${G} pr merge 5 --rebase`, UNBOUND],
  ["quote split", `g''h pr m''erge 5`, UNBOUND],
  ["quoted words", `"${G}" "pr" "merge" 5`, UNBOUND],
  ["backslash in word", `${G} pr mer\\ge 5`, UNBOUND],
  ["GH_REPO env prefix", `GH_REPO=x/y ${G} pr merge 5 --match-head-commit ${A}`, UNBOUND, "x/y"],
  ["command gh", `command ${G} pr merge 5`, UNBOUND],
  ["\\gh", `\\${G} pr merge 5`, UNBOUND],
  ["abs path gh", `/opt/homebrew/bin/${G} pr merge 5`, UNBOUND],
  ["bash -c", `bash -c "${G} pr merge 5"`, UNRESOLVABLE],
  ["sh -c", `sh -c '${G} pr merge 5'`, UNRESOLVABLE],
  ["xargs", `echo 5 | xargs ${G} pr merge`, UNRESOLVABLE],
  ["env -i", `env -i ${G} pr merge 5`, UNRESOLVABLE],
  ["$(…) subst", `x=$(${G} pr merge 5)`, UNBOUND],
  ["grouped -st: subject 5, current-branch PR", `${G} pr merge -st 5 --match-head-commit ${A}`, UNVERIFIABLE],
  ["grouped -sR: repo x/y", `${G} pr merge -sRx/y 5 --match-head-commit ${A}`, UNBOUND, "x/y"],
  ["grouped -sd booleans", `${G} pr merge -sd 5 --match-head-commit ${A}`, ALLOW],
  ["grouped unknown letter", `${G} pr merge -sz 5 --match-head-commit ${A}`, UNRESOLVABLE],
  ["unknown long flag", `${G} pr merge 5 --yolo --match-head-commit ${A}`, UNRESOLVABLE],
  ["api PUT no sha", `${G} api -X PUT repos/o/r/pulls/5/merge`, UNBOUND],
  ["api PUT -f sha", `${G} api -X PUT repos/o/r/pulls/5/merge -f sha=${A}`, ALLOW],
  ["api --method PUT -F sha", `${G} api --method PUT repos/o/r/pulls/5/merge -F sha=${A}`, ALLOW],
  ["api --method=PUT -f sha", `${G} api --method=PUT repos/o/r/pulls/5/merge -f sha=${A}`, ALLOW],
  ["api implicit POST, no sha", `${G} api repos/o/r/pulls/5/merge -f merge_method=squash`, UNBOUND],
  ["api PUT merge#frag no sha", `${G} api -X PUT repos/o/r/pulls/5/merge#x`, UNBOUND],
  ["api PUT merge#frag with sha", `${G} api -X PUT repos/o/r/pulls/5/merge#x -f sha=${A}`, ALLOW],
  ["api PUT repositories/<id>", `${G} api -X PUT repositories/123/pulls/5/merge -f sha=${A}`, UNRESOLVABLE],
  ["api PUT uppercase host no sha", `${G} api -X PUT https://API.GITHUB.COM/repos/o/r/pulls/5/merge`, UNBOUND],
  ["api PUT uppercase host with sha", `${G} api -X PUT https://API.GITHUB.COM/repos/o/r/pulls/5/merge -f sha=${A}`, ALLOW],
  ["api PUT host:443 no sha", `${G} api -X PUT https://api.github.com:443/repos/o/r/pulls/5/merge`, UNBOUND],
  ["api PUT trailing-dot host no sha", `${G} api -X PUT https://api.github.com./repos/o/r/pulls/5/merge`, UNBOUND],
  ["api PUT encoded path", `${G} api -X PUT repos/o/r/pulls/5/%6Derge -f sha=${A}`, UNRESOLVABLE],
  ["api PUT --hostname GHE", `${G} api --hostname ghe.example.com -X PUT repos/o/r/pulls/5/merge -f sha=${A}`, UNRESOLVABLE],
  ["api PUT -f sha + --input body", `${G} api -X PUT repos/o/r/pulls/5/merge -f sha=${A} --input body.json`, UNBOUND],
  ["api PUT --input only", `${G} api -X PUT repos/o/r/pulls/5/merge --input body.json`, UNBOUND],
  ["GH_REPO + {owner}/{repo} placeholders", `GH_REPO=x/y ${G} api -X PUT repos/{owner}/{repo}/pulls/5/merge -f sha=${A}`, UNBOUND, "x/y"],
  ["api GET repositories/<id>/…/merge is a read", `${G} api repositories/123/pulls/5/merge`, NOT_MERGE],
  ["graphql mergePullRequest", `${G} api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`, GRAPHQL],
  ["graphql mergePullRequest+expectedHeadOid", `${G} api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x",expectedHeadOid:"${A}"}){clientMutationId}}'`, GRAPHQL],
  // Round 3: an unreadable GraphQL body (--input, -F @file) may hold a merge, so the merge gate denies it itself.
  ["graphql --input file", `${G} api graphql --input body.json`, GRAPHQL],
  ["graphql -F query=@file", `${G} api graphql -F query=@q.graphql`, GRAPHQL],
  ["graphql enqueuePullRequest", `${G} api graphql -f query='mutation{enqueuePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`, GRAPHQL],
  ["graphql unknown PullRequest merge mutation", `${G} api graphql -f query='mutation{queuePullRequestForMerge(input:{id:"x"}){clientMutationId}}'`, GRAPHQL],
  ["graphql disablePullRequestAutoMerge is not a merge", `${G} api graphql -f query='mutation{disablePullRequestAutoMerge(input:{pullRequestId:"x"}){clientMutationId}}'`, NOT_MERGE],
  ["graphql read of mergeable", `${G} api graphql -f query='query{repository(owner:"o",name:"r"){pullRequest(number:5){mergeable}}}'`, NOT_MERGE],
  ["MCP bound", { owner: "o", repo: "r", pullNumber: 5, expectedHeadSha: A }, ALLOW],
  ["MCP no head field", { owner: "o", repo: "r", pullNumber: 5 }, UNBOUND],
  ["MCP bound, PR7 head B", { owner: "o", repo: "r", pullNumber: 7, expectedHeadSha: A }, UNBOUND],
  ["MCP pullNumber vs pull_number disagree", { owner: "o", repo: "r", pullNumber: 5, pull_number: 8, expectedHeadSha: A }, UNRESOLVABLE],
  ["MCP pullNumber and pull_number agree", { owner: "o", repo: "r", pullNumber: 5, pull_number: "5", expectedHeadSha: A }, ALLOW],
  ["curl -X PUT", "curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge", RAW],
  ["curl -sX PUT", "curl -sX PUT https://api.github.com/repos/o/r/pulls/5/merge", RAW],
  ["curl uppercase host", "curl -X PUT https://API.GITHUB.COM/repos/o/r/pulls/5/merge", RAW],
  ["curl trailing-dot host", "curl -X PUT https://api.github.com./repos/o/r/pulls/5/merge", RAW],
  ["curl host:443", "curl -X PUT https://api.github.com:443/repos/o/r/pulls/5/merge", RAW],
  ["wget --method=PUT", "wget --method=PUT https://api.github.com/repos/o/r/pulls/5/merge", RAW],
  ["http PUT", "http PUT https://api.github.com/repos/o/r/pulls/5/merge", RAW],
  ["http put (lowercase)", "http put https://api.github.com/repos/o/r/pulls/5/merge Authorization:token", RAW],
  ["xh put (lowercase)", "xh put api.github.com/repos/o/r/pulls/5/merge", RAW],
  ["xh PUT", "xh PUT api.github.com/repos/o/r/pulls/5/merge", RAW],
  ["curl GET of pulls is a read", "curl -s https://api.github.com/repos/o/r/pulls", NOT_MERGE],
  ["compound create && merge", `${G} pr create --title t && ${G} pr merge 5 --match-head-commit ${A}`, "deny:pr_create_merge_compound"],
  ["create titled merge", `${G} pr create --title "merge the fix"`, NOT_MERGE],
  ["unrelated: gh pr view && git merge", `${G} pr view 5 && git merge main`, NOT_MERGE],
  ["unrelated: gh api GET …/merge", `${G} api repos/o/r/pulls/5/merge`, NOT_MERGE],
  ["unrelated: ls", "ls", NOT_MERGE],
  // Accepted (review #9): the create gate's text rule, applied to merges.
  ["text FP: commit msg", `git commit -m "docs: explain ${G} pr merge usage"`, UNRESOLVABLE],
  ["text FP: grep", `grep -rn "${G} pr merge" docs`, UNRESOLVABLE],
  // Re-review (round 2) probe13b rows.
  ["pflag --match-head-commit=A", `${G} pr merge 5 --match-head-commit=${A}`, ALLOW],
  ["pflag -- then PR", `${G} pr merge --match-head-commit ${A} -- 5`, ALLOW],
  ["pflag -t 7 5 (numeric value)", `${G} pr merge -t 7 5 --match-head-commit ${A}`, ALLOW],
  ["pflag repeated --match-head-commit", `${G} pr merge 5 --match-head-commit ${A} --match-head-commit ${A}`, UNRESOLVABLE],
  ["GH_REPO=o/r + -R x/y (must check x/y)", `GH_REPO=o/r ${G} pr merge 5 -R x/y --match-head-commit ${A}`, UNBOUND, "x/y"],
  ["GH_REPO=x/y + -R o/r (checks o/r)", `GH_REPO=x/y ${G} pr merge 5 -R o/r --match-head-commit ${A}`, ALLOW],
  ["api --method put (lower) no sha", `${G} api --method put repos/o/r/pulls/5/merge`, UNBOUND],
  ["api -XPUT no sha", `${G} api -XPUT repos/o/r/pulls/5/merge`, UNBOUND],
  ["api -X=PUT no sha", `${G} api -X=PUT repos/o/r/pulls/5/merge`, UNBOUND],
  ["api -iXPUT no sha", `${G} api -iXPUT repos/o/r/pulls/5/merge`, UNBOUND],
  ["api %2Fmerge", `${G} api -X PUT repos/o/r/pulls/5%2Fmerge`, UNRESOLVABLE],
  ["api repos//o/r", `${G} api -X PUT repos//o/r/pulls/5/merge`, UNRESOLVABLE],
  ["api .. segment", `${G} api -X PUT repos/o/r/pulls/5/../5/merge`, UNRESOLVABLE],
  ["api trailing / no sha", `${G} api -X PUT repos/o/r/pulls/5/merge/`, UNBOUND],
  ["api trailing / + sha", `${G} api -X PUT repos/o/r/pulls/5/merge/ -f sha=${A}`, ALLOW],
  ["api ?x=1 no sha", `${G} api -X PUT 'repos/o/r/pulls/5/merge?x=1'`, UNRESOLVABLE],
  ["api ?sha=B + -f sha=A", `${G} api -X PUT 'repos/o/r/pulls/5/merge?sha=${B}' -f sha=${A}`, UNRESOLVABLE],
  ["api {branch} placeholder (branch named merge)", `${G} api -X PUT repos/o/r/pulls/5/{branch}`, UNRESOLVABLE],
  ["api :branch placeholder", `${G} api -X PUT repos/o/r/pulls/5/:branch`, UNRESOLVABLE],
  ["api GET with {branch} is a read", `${G} api repos/o/r/pulls/{branch}`, NOT_MERGE],
  ["api :owner/:repo placeholders + sha", `${G} api -X PUT repos/:owner/:repo/pulls/5/merge -f sha=${A}`, ALLOW],
  ["api mixed {owner}/r placeholder", `${G} api -X PUT repos/{owner}/r/pulls/5/merge -f sha=${A}`, UNRESOLVABLE],
  ["graphql alias m: mergePullRequest", `${G} api graphql -f query='mutation{m: mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`, GRAPHQL],
  ["graphql comment inside", `${G} api graphql -f query='mutation{ # c\n mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`, GRAPHQL],
  ["graphql op name mergePullRequest (accepted FP)", `${G} api graphql -f query='mutation mergePullRequest { addComment(input:{}){clientMutationId} }'`, GRAPHQL],
  ["(1a) the GraphQL endpoint is gated on its path, whatever the method", `${G} api -X GET /graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`, GRAPHQL],
  ["(1b) merge mutation in the body of any non-GET endpoint", `${G} api -X POST repos/o/r/issues -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`, GRAPHQL],
  // Re-review (round 2) probe13c rows: API merges the parser cannot isolate.
  ["bash -c gh api PUT merge", `bash -c "${G} api -X PUT repos/o/r/pulls/5/merge"`, UNRESOLVABLE],
  ["timeout 30 gh api PUT merge", `timeout 30 ${G} api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["gh -X PUT api …/merge (flag before subcommand)", `${G} -X PUT api repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["timeout 30 gh api PUT %70ulls/5/merge", `timeout 30 ${G} api -X PUT repos/o/r/%70ulls/5/merge`, UNRESOLVABLE],
  ["bash -c gh api PUT %70ulls/5/merge", `bash -c "${G} api -X PUT repos/o/r/%70ulls/5/merge"`, UNRESOLVABLE],
  ["gh api PUT %70ulls/5/merge (isolated)", `${G} api -X PUT repos/o/r/%70ulls/5/merge`, UNRESOLVABLE],
  ["gh -f query=<merge mutation> api graphql", `${G} -f 'query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}' api graphql`, UNRESOLVABLE],
  ["timeout 30 gh api graphql merge", `timeout 30 ${G} api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`, UNRESOLVABLE],
  ["an isolated harmless gh api does not vouch for a hidden one", `${G} api user && timeout 30 ${G} api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["raw-client creation (gate pr)", `curl -X POST https://api.github.com/repos/o/r/pulls -d '{}'`, RAW],
  // Round 3 (I1): a percent-encoded GraphQL route is still the GraphQL endpoint; a malformed escape is unreadable.
  ["%67raphql --input merge.json", `${G} api %67raphql --input merge.json`, GRAPHQL],
  ["graphq%6C --input merge.json", `${G} api graphq%6C --input merge.json`, GRAPHQL],
  ["%67raphql -F query=@f", `${G} api %67raphql -F query=@f`, GRAPHQL],
  ["graphq%6C -F query=@f", `${G} api graphq%6C -F query=@f`, GRAPHQL],
  ["%67raphql inline merge mutation", `${G} api %67raphql -f query='mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`, GRAPHQL],
  ["malformed %-escape on a write", `${G} api -X PUT repos/o/r/pulls/5/%6merge`, UNRESOLVABLE],
  ["%67raphql inline read query", `${G} api %67raphql -f query='query{viewer{login}}'`, NOT_MERGE],
  // Round 3 (I2): any gh placeholder other than owner/repo on a non-GET call is refused, pulls or not.
  ["-X PUT repos/o/r/{branch}", `${G} api -X PUT repos/o/r/{branch}`, UNRESOLVABLE],
  ["-X PUT repos/{owner}/{repo}/{branch}", `${G} api -X PUT repos/{owner}/{repo}/{branch}`, UNRESOLVABLE],
  ["-X PUT repos/o/r/pull:branch", `${G} api -X PUT repos/o/r/pull:branch`, UNRESOLVABLE],
  ["GET repos/o/r/{branch} is a read", `${G} api repos/o/r/{branch}`, NOT_MERGE],
  // Round 3 (I3): gh command words that reach `api` are counted, even flag-first after an isolated harmless call.
  ["gh api user && gh -f <merge mutation> api graphql", `${G} api user && ${G} -f 'query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}' api graphql`, UNRESOLVABLE],
  ["cat docs/gh-api.md plugin/merge.mjs", "cat docs/gh-api.md plugin/merge.mjs", NOT_MERGE],
  // Round 4: the r3 re-review rows. A gh word inside a pre-subcommand flag value no longer hides the call.
  ["R1 gh -f 'x=gh y' api PUT merge", `${G} -f 'x=gh y' api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["R2 gh -f 'body=see gh docs' api PUT merge", `${G} -f 'body=see gh docs' api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["R3 gh -f query=<merge, gh x> api graphql", `${G} -f 'query=${MERGE_GH}' api graphql`, UNRESOLVABLE],
  ["R4 gh api user && R3", `${G} api user && ${G} -f 'query=${MERGE_GH}' api graphql`, UNRESOLVABLE],
  ["R5 gh -H 'X-Note: gh y' api PUT merge", `${G} -H 'X-Note: gh y' api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["R6 {gh,api} -X PUT merge", `{${G},api} -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["R7 gh {api,-X} PUT merge", `${G} {api,-X} PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["R8 gh -X PUT {api,…/merge}", `${G} -X PUT {api,repos/o/r/pulls/5/merge}`, UNRESOLVABLE],
  ["R9 gh -f x=1 -f 'y=gh z' api PUT merge", `${G} -f x=1 -f 'y=gh z' api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  // Round 4 siblings of the same class: a pre-subcommand value the splitter cuts up, a redirection or an expansion
  // between gh and its subcommand, a brace list inside bash -c, and GH (macOS resolves it to gh).
  ["gh -t 'a b' pr merge", `${G} -t 'a b' pr merge 5 --squash`, UNRESOLVABLE],
  ["gh pr 2>/dev/null merge", `${G} pr 2>/dev/null merge 5 --squash`, UNRESOLVABLE],
  ["gh 2>&1 api PUT merge", `${G} 2>&1 api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["gh >/dev/null api PUT merge", `${G} >/dev/null api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["gh $EMPTY api PUT merge", `${G} $EMPTY api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["bash -c {gh,pr} merge", `bash -c "{${G},pr} merge 5 --squash"`, UNRESOLVABLE],
  ["gh pr {merge,5}", `${G} pr {merge,5} --squash`, UNRESOLVABLE],
  // Only the brace rule stops this one: read literally it is a GET, but the shell turns `{-X,} PUT` into `-X PUT`.
  ["an isolated call whose brace list builds -X PUT", `${G} api repos/o/r/pulls/5/merge {-X,} PUT`, UNRESOLVABLE],
  ["GH pr merge", "GH pr merge 5 --squash", UNBOUND],
  ["GH api PUT merge", "GH api -X PUT repos/o/r/pulls/5/merge", UNBOUND],
  ["gh placeholders are not brace lists", `${G} api -X PUT repos/{owner}/{repo}/pulls/5/merge -f sha=${A}`, ALLOW],
  ["a brace list in a command without gh is not refused", "curl -s https://api.github.com/repos/o/r/pulls/{1,2}", NOT_MERGE],
  // Round 5 (r4 B rows): a brace expansion that spells the command word, subcommand or endpoint reaches the parsers.
  ["B1 gh pr {m..m}erge", `${G} pr {m..m}erge 5 --squash`, UNRESOLVABLE],
  ["B2 gh {p..p}r merge", `${G} {p..p}r merge 5 --squash`, UNRESOLVABLE],
  ["B3 gh pr me{r..r}ge", `${G} pr me{r..r}ge 5 --squash`, UNRESOLVABLE],
  ["B8 {g..g}h api PUT merge", `{g..g}h api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["B9 g{h..h} api PUT merge", `g{h..h} api -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["every word brace-spelled", `{g..g}h {p..p}r {m..m}erge 5`, UNRESOLVABLE],
  ["a brace sequence inside bash -c", `bash -c "${G} pr {m..m}erge 5"`, UNRESOLVABLE],
  ["B4 gh pr {c..c}reate (the merge fast path takes it)", `${G} pr {c..c}reate --base main`, UNRESOLVABLE],
  ["a brace-spelled raw client is still a raw client", "{c..c}url -X PUT https://api.github.com/repos/o/r/pulls/5/merge", RAW],
  // Round 5: ANSI-C escapes and gh aliases.
  ["ANSI-C gh pr $'\\155erge'", `${G} pr $'\\155erge' 5 --squash`, UNRESOLVABLE],
  ["ANSI-C gh api user && gh $'\\x61pi' PUT merge", `${G} api user && ${G} $'\\x61pi' -X PUT repos/o/r/pulls/5/merge`, UNRESOLVABLE],
  ["plain $'merge' is read as merge", `${G} pr $'merge' 5 --squash`, UNBOUND],
  ["gh alias set, then the alias", `${G} alias set zz 'pr merge' && ${G} zz 5 --squash`, UNRESOLVABLE],
  ["gh alias import", `${G} alias import aliases.yml`, UNRESOLVABLE],
  ["gh alias list is a read", `${G} alias list && ${G} pr view 5`, NOT_MERGE],
  // Accepted false positive (r4 ruling): a brace expansion anywhere in a command that names gh is refused.
  ["FP: for i in {1,2}; do gh pr view", `for i in {1,2}; do ${G} pr view $i; done`, UNRESOLVABLE],
  ["a quoted jq object list is not a brace expansion", `${G} pr list --json number,title --jq '.[] | {number,title}'`, NOT_MERGE],
  ["the documented bound merge", `${G} pr merge 5 --repo o/r --squash --match-head-commit ${A}`, ALLOW]
];
// Finding 1: every GraphQL merge mutation through every spelling of the GraphQL endpoint.
for (const endpoint of ["/graphql", "graphql/", "https://api.github.com/graphql", "https://API.GITHUB.COM./graphql", "/graphql?x=1"]) {
  for (const mutation of ["mergePullRequest", "enablePullRequestAutoMerge", "enqueuePullRequest"]) {
    PROBE.push([`graphql ${endpoint} ${mutation}`, `${G} api '${endpoint}' -f query='mutation{${mutation}(input:{pullRequestId:"x"}){clientMutationId}}'`, GRAPHQL]);
  }
}

for (const preset of ["default", "balanced"]) {
  test(`probe table (${preset}): no gated interface merges without a cleared binding`, async () => {
    const wrong = [];
    for (const [name, input, want, viewRepo] of PROBE) {
      gh.set(GH_MAP);
      const n0 = gh.log().length;
      const r = typeof input === "string" ? await call(input, preset) : await mcp(input, preset);
      const calls = gh.log().slice(n0).map((a) => a.join(" "));
      if (`${r.decision}:${r.code}` !== want) wrong.push(`${name}: got ${r.decision}:${r.code}, want ${want}`);
      if (viewRepo && !calls.includes(`pr view 5 --repo ${viewRepo} --json ${F}`)) wrong.push(`${name}: never read PR 5 of ${viewRepo}`);
      if (viewRepo && calls.includes(`pr view 5 --repo o/r --json ${F}`)) wrong.push(`${name}: read the wrong repo o/r`);
    }
    assert.deepEqual(wrong, []);
  });
}

test("Advisory warns on every probe case Default denies, with the one shared wording", async () => {
  const wrong = [];
  for (const [name, input, want] of PROBE) {
    if (!want.startsWith("deny:")) continue;
    gh.set(GH_MAP);
    const r = typeof input === "string" ? await call(input, "advisory") : await mcp(input, "advisory");
    if (r.decision !== "warn" || `deny:${r.code}` !== want) wrong.push(`${name}: ${r.decision}:${r.code}`);
    if (!r.message.startsWith("⚠ review-loop (Advisory): review-loop [") || !r.message.endsWith(" — allowed under Advisory")) wrong.push(`${name}: wording`);
  }
  assert.deepEqual(wrong, []);
  gh.set(GH_MAP);
  const deny = await call(`${G} pr merge 5 --squash`);
  const warn = await call(`${G} pr merge 5 --squash`, "advisory");
  assert.equal(warn.message, advisoryText(deny.message));
});

test("parse: grouped shorthands follow pflag; --input and GH_REPO reach the API merge", () => {
  assert.deepEqual(parseMerge(`${G} pr merge -st 5 --match-head-commit ${A}`), { kind: "pr-merge", number: null, repo: null, ghRepoEnv: null, bind: A, auto: false, admin: false });
  assert.deepEqual(parseMerge(`${G} pr merge -sRx/y 5`), { kind: "pr-merge", number: 5, repo: "x/y", ghRepoEnv: null, bind: null, auto: false, admin: false });
  assert.equal(parseMerge(`${G} pr merge -sR x/y 5`)?.repo, "x/y", "a value letter last in the group takes the next word");
  assert.equal(parseMerge(`${G} pr merge 5 --auto=false`)?.auto, false);
  assert.throws(() => parseMerge(`${G} pr merge 5 -- 6`), (e) => e.code === "pr_args_unresolvable", "after --, a second PR is still a second PR");
  assert.throws(() => parseMerge(`${G} pr merge -sz 5`), (e) => e.code === "pr_args_unresolvable");
  assert.deepEqual(parseMerge(`GH_REPO=x/y ${G} api -X PUT repos/{owner}/{repo}/pulls/5/merge -f sha=${A} --input b.json`), { kind: "api-merge", repo: null, ghRepoEnv: "x/y", number: 5, bind: null, input: true });
  assert.deepEqual(parseMerge("curl -X POST https://api.github.com/repos/o/r/pulls -d x"), { kind: "raw-client", merge: false });
});

// A super-linear regex blocks the event loop, so no in-process timeout can stop it: the scans run in a child that is
// killed at 15 s. A regression to the old regexes (minutes on these inputs) is then a prompt red, not a hung suite.
const LATENCY_CHILD = `
import { mentionsMerge, mentionsPrCreate, parseMerge, parsePrCreate } from ${JSON.stringify(new URL("../../plugin/engine/lib/cmdparse.mjs", import.meta.url).href)};
const G = "g" + "h";
const big = [
  "x".repeat(100_000),
  G + " pr ".repeat(1) + (G + " pr ").repeat(17_000),
  (G + " pr ").repeat(17_000) + "merge",
  (G + " pr ").repeat(17_000) + "create",
  (G + " api ").repeat(12_500) + "/merge",
  "curl ".repeat(20_000) + "https://api.github.com/",
  "curl api.github.com/".repeat(5_000),
  "mutation " + "aPullRequestB ".repeat(7_000),
  G + " api -X PUT %41" + "/".repeat(120_000) + "x; " + G + " api -X PUT repos/o/r/pulls/5/merge",
  G + " api -X PUT a" + "/".repeat(120_000) + "x/merge",
  // Round 4: the gh-call counter over many flag-first gh words with one subcommand at the end, and brace scanning.
  (G + " -f ").repeat(20_000) + "api -X PUT repos/o/r/pulls/5/merge",
  (G + " -f ").repeat(20_000) + "pr create",
  (G + " pr -t ").repeat(15_000) + "merge",
  G + " api " + "{".repeat(120_000) + ",x",
  G + " pr merge " + "{a,".repeat(40_000),
  // Round 5: the brace-rewrite arm, the sequence collapse and the ANSI-C check.
  (G + " {a,b}").repeat(15_000),
  "{a..".repeat(30_000) + G,
  "{g..g}h ".repeat(15_000) + "pr merge",
  "$'\\\\x".repeat(30_000) + " " + G,
  (G + " $'a").repeat(24_000)
];
const out = [];
for (const cmd of big) {
  const t0 = performance.now();
  mentionsMerge(cmd);
  mentionsPrCreate(cmd);
  try { parseMerge(cmd); } catch {}
  try { parsePrCreate(cmd); } catch {}
  out.push(Math.round(performance.now() - t0));
}
console.log(JSON.stringify(out));
`;

test("the fast paths are linear: 100 KB commands finish well inside the hook budget", () => {
  // SIGKILL on timeout (a sync loop can't run a SIGTERM handler anyway), and a 30 s CPU cap so the child dies even
  // when this test process is killed first and spawnSync's timeout never fires.
  const r = spawnSync("/bin/sh", ["-c", 'ulimit -t 30; exec "$0" --input-type=module -e "$1"', process.execPath, LATENCY_CHILD], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
  assert.equal(r.signal, null, "the scans did not finish within 15 s (super-linear)");
  assert.equal(r.status, 0, r.stderr);
  const ms = JSON.parse(r.stdout);
  assert.equal(ms.length, 20);
  for (const [i, t] of ms.entries()) assert.ok(t < 500, `input ${i} took ${t} ms`);
});

// The regexes the linear scans replaced: identical answers on every command the suites use, and on random ones.
const OLD = {
  prSub: (t) => /\bgh\b[\s\S]*\bpr\b[\s\S]*\b(create|new)\b/.test(t),
  apiPulls: (t) => /\bgh\b[\s\S]*\bapi\b/.test(t) && /pulls|createPullRequest|graphql/i.test(t),
  mergeText: (t) => /\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b|\bapi\b[\s\S]*\/merge\b|mergePullRequest|enablePullRequestAutoMerge/.test(t)
};
const unq = (c) => c.replace(/\\\n/g, "").replace(/['"\\]/g, "");

test("the linear scans answer exactly as the old regexes did", () => {
  const corpus = [...PROBE.map(([, c]) => c).filter((c) => typeof c === "string"), "ghpr create", "gh prcreate", "agh pr new", "gh-pr create", "gh\npr\ncreate", "pr gh create", "gh pr create gh pr", "api /merge", "api/merge", "gh api x/pulls", "gh  api GRAPHQL", "x gh y api z createPullRequest", `${G} pr view 5`, `${G} api -X GET repos/o/r/pulls/5`, "git merge main"];
  const words = ["gh", "pr", "create", "new", "api", "merge", "/merge", "pulls", "graphql", "x", "ghpr", "-", ";", "a/b", "_gh", "gh_"];
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  for (let i = 0; i < 3000; i++) corpus.push(Array.from({ length: 1 + rnd(7) }, () => words[rnd(words.length)]).join([" ", "", "\n", "/"][rnd(4)]));
  const wrong = [];
  for (const c of corpus) {
    const t = unq(c);
    const oldCreate = OLD.prSub(t) || OLD.apiPulls(t);
    // Round 4: both fast paths also read the command word `GH` (macOS resolves it to gh). Round 5: they also take
    // any brace expansion or escaped $'…' next to gh/pr/api, and the merge path takes `gh alias set|import`.
    const byDesign = (!/\bgh\b/.test(t) && /\bgh\b/i.test(t)) || /[{]|alias/.test(t) || c.includes("$'");
    // Round 3: the create fast path widens only by design, to a percent-escape in `gh api` (a hidden route).
    if (oldCreate && !mentionsPrCreate(c)) wrong.push(`create lost: ${JSON.stringify(c)}`);
    if (!oldCreate && mentionsPrCreate(c) && !/%/.test(t) && !byDesign) wrong.push(`create gained: ${JSON.stringify(c)}`);
    // mentionsMerge widens the old merge text only by design: case-insensitive /MERGE, a percent-escape in `gh api`,
    // new mutation names and raw clients.
    if (OLD.mergeText(t) && !mentionsMerge(c)) wrong.push(`merge lost: ${JSON.stringify(c)}`);
    if (!OLD.mergeText(t) && mentionsMerge(c) && !byDesign && !/\/merge|%|[{}]|:(?:owner|repo|branch)|--input|=@|mutation|enqueuePullRequest|curl|wget|http|xh/i.test(t)) wrong.push(`merge gained: ${JSON.stringify(c)}`);
  }
  assert.deepEqual(wrong, []);
});

test("kill switch: structural denials still deny; only a readable merge is skipped", async () => {
  const other = makeRepo();
  commitFile(other, "a.txt", "a");
  fs.mkdirSync(path.join(other, ".claude"));
  fs.writeFileSync(path.join(other, ".claude", "review-loop.off"), "");
  writeBaseline("ks", other, {}, null, true);
  const run = (command) => evaluateMergeGate({ cwd: other, session: "ks", command, preset: "default" });
  assert.equal((await run(`${G} pr create --title t && ${G} pr merge 5`)).code, "pr_create_merge_compound");
  assert.equal((await run("curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge")).code, "pr_github_api_unsupported_client");
  assert.equal((await run(`${G} api graphql -f query='mutation{mergePullRequest(input:{})}'`)).code, "pr_merge_graphql_unsupported");
  assert.equal((await run(`bash -c "${G} pr merge 5"`)).code, "pr_args_unresolvable");
  assert.equal((await run(`${G} pr merge 5 --repo o/r`)).code, "kill_switch");
});

test("deadline: one budget covers every gh and git call; running out denies (fails closed)", async () => {
  gh.set({ ...GH_MAP, "api repos/o/r/git/ref/heads/main --jq .object.sha": { stdout: `${base}\n`, delayMs: 6_000 } });
  const t0 = Date.now();
  const r = await evaluateMergeGate({ cwd: repo, session: "s", command: `${G} pr merge 5 --repo o/r --match-head-commit ${A}`, preset: "default", deadlineMs: 1_500 });
  assert.equal(r.code, "pr_merge_context_unverifiable");
  assert.ok(Date.now() - t0 < 4_000, `took ${Date.now() - t0} ms`);
  gh.set(GH_MAP);
  const n0 = gh.log().length;
  const none = await evaluateMergeGate({ cwd: repo, session: "s", command: `${G} pr merge 5 --repo o/r --match-head-commit ${A}`, preset: "default", deadlineMs: 0 });
  assert.equal(none.code, "pr_merge_context_unverifiable");
  assert.match(none.message, /time budget ran out/, "a spent budget is named, not blamed on the cwd");
  assert.equal(gh.log().length, n0, "no call starts once the budget is spent");
});

test("deadline: objectFormat never falls back to sha1 on a spent budget", async () => {
  const { objectFormat } = await import("../../plugin/engine/lib/git.mjs");
  assert.equal(await objectFormat(repo), "sha1");
  await assert.rejects(objectFormat(repo, Date.now() - 1), (e) => e.code === "command_timeout");
});

test("the create gate reads every spelling of the GraphQL endpoint", () => {
  for (const endpoint of ["graphql", "/graphql", "graphql/", "https://api.github.com/graphql", "https://API.GITHUB.COM:443/graphql"]) {
    assert.throws(() => parsePrCreate(`${G} api ${endpoint} -F query=@q.graphql`), (e) => e.code === "pr_via_api_unsupported", endpoint);
    assert.throws(() => parsePrCreate(`${G} api ${endpoint} --input q.json`), (e) => e.code === "pr_via_api_unsupported", endpoint);
  }
});

test("round 3: the create gate decodes the GraphQL route and counts flag-first gh api calls", () => {
  for (const endpoint of ["%67raphql", "graphq%6C", "https://api.github.com/%67raphql"]) {
    assert.throws(() => parsePrCreate(`${G} api ${endpoint} --input merge.json`), (e) => e.code === "pr_via_api_unsupported", endpoint);
    assert.throws(() => parsePrCreate(`${G} api ${endpoint} -F query=@f`), (e) => e.code === "pr_via_api_unsupported", endpoint);
  }
  assert.throws(() => parsePrCreate(`${G} api -X POST repos/o/r/%6pulls -f title=t`), (e) => e.code === "pr_via_api_unsupported", "a malformed escape on a write is unreadable");
  for (const endpoint of ["repos/o/r/%70ulls", "repos/o/r/pull%73", "repos/o/r/pulls%2F", "https://api.github.com/repos/o/r/%70ulls"]) {
    assert.throws(() => parsePrCreate(`${G} api -X POST ${endpoint} -f head=x -f base=main -f title=t`), (e) => e.code === "pr_via_api_unsupported", endpoint);
  }
  assert.equal(parsePrCreate(`${G} api repos/o/r/%70ulls`), null, "a GET of the encoded list is a read");
  const mutation = `'query=mutation{createPullRequest(input:{repositoryId:"x"}){clientMutationId}}'`;
  for (const cmd of [`${G} -f ${mutation} api graphql`, `${G} api user && ${G} -f ${mutation} api graphql`]) {
    assert.throws(() => parsePrCreate(cmd), (e) => e.code === "pr_via_api_unsupported" || e.code === "pr_args_unresolvable", cmd);
  }
  assert.equal(parsePrCreate("cat docs/gh-api.md plugin/merge.mjs"), null);
  assert.doesNotThrow(() => parsePrCreate(`${G} pr create --title "Add api for pulls" --body "graphql notes"`), "a title that mentions api is not a gh api call");
  assert.equal(parseMerge("cat docs/gh-api.md plugin/merge.mjs"), null);
});

test("round 3: repoRoot on a spent budget is command_timeout, not an absent repo", async () => {
  const { repoRoot } = await import("../../plugin/engine/lib/git.mjs");
  const bin = tmpDir();
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase "$*" in *--show-toplevel*) exec sleep 5;; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    const t0 = Date.now();
    await assert.rejects(repoRoot(repo, Date.now() + 800), (e) => e.code === "command_timeout");
    assert.ok(Date.now() - t0 < 3_000, `took ${Date.now() - t0} ms`);
    const r = await evaluateMergeGate({ cwd: repo, session: "s", command: `${G} pr merge 5 --repo o/r --match-head-commit ${A}`, preset: "default", deadlineMs: 800 });
    assert.equal(r.decision, "deny");
    assert.match(r.message, /time budget/);
  } finally {
    process.env.PATH = saved;
  }
});

test("hook: a raw-client PR creation is logged under gate pr; an unreadable graphql body is the merge gate's", () => {
  const cfg = path.join(home, "cfg.json");
  const events = path.join(home, "state", "events.jsonl");
  fs.writeFileSync(cfg, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  const run = (command) => {
    const before = fs.existsSync(events) ? fs.readFileSync(events, "utf8").length : 0;
    const r = spawnSync(process.execPath, [HOOK, "pr"], { env: process.env, encoding: "utf8", input: JSON.stringify({ session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command } }) });
    const d = fs.readFileSync(events, "utf8").slice(before).trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "gate.decision");
    return { out: JSON.parse(r.stdout), d };
  };
  const create = run("curl -X POST https://api.github.com/repos/o/r/pulls -d x");
  assert.deepEqual(create.d.map((e) => [e.data.gate, e.code]), [["pr", "pr_github_api_unsupported_client"]]);
  assert.equal(create.out.hookSpecificOutput.permissionDecision, "deny");
  const merge = run("curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge");
  assert.deepEqual(merge.d.map((e) => [e.data.gate, e.code]), [["merge", "pr_github_api_unsupported_client"]]);
  const body = run(`${G} api graphql --input body.json`);
  assert.deepEqual(body.d.map((e) => [e.data.gate, e.code]), [["merge", "pr_merge_graphql_unsupported"]], "round 3: the merge gate reads unreadable GraphQL bodies as possible merges");
  const created = run(`${G} -f 'query=mutation{createPullRequest(input:{repositoryId:"x"}){clientMutationId}}' api graphql`);
  assert.deepEqual(created.d.map((e) => [e.data.gate, e.code]), [["pr", "pr_args_unresolvable"]], "a flag-first createPullRequest is the create gate's");
  const encoded = run(`${G} api -X POST repos/o/r/%70ulls -f head=x -f base=main -f title=t`);
  assert.deepEqual(encoded.d.map((e) => [e.data.gate, e.code]), [["pr", "pr_via_api_unsupported"]], "an encoded pulls route reaches the create gate");
  const hidden = run(`timeout 30 ${G} api -X PUT repos/o/r/%70ulls/5/merge`);
  assert.deepEqual(hidden.d.map((e) => [e.data.gate, e.code]), [["merge", "pr_args_unresolvable"]], "an unisolatable API merge is the merge gate's");
  const gql = run(`${G} api https://api.github.com/graphql -f query='mutation{enqueuePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'`);
  assert.deepEqual(gql.d.map((e) => [e.data.gate, e.code]), [["merge", "pr_merge_graphql_unsupported"]]);
});

// ---- Round 4: the class gate ----

const UNRES = "pr_args_unresolvable";
const VIA_API = "pr_via_api_unsupported";
// [name, command, what parsePrCreate must do: throw that code, or "creation" (return the parsed creation)]
/** @type {Array<[string, string, string]>} */
const CREATE = [
  ["gh pr create", `${G} pr create --base main --title t`, "creation"],
  ["gh -R o/r pr create", `${G} -R o/r pr create --base main`, "creation"],
  ["gh pr new", `${G} pr new --base main`, "creation"],
  ["GH pr create", "GH pr create --base main", "creation"],
  ["api POST pulls", `${G} api -X POST repos/o/r/pulls -f head=feat -f base=main -f title=t`, VIA_API],
  ["api implicit POST pulls", `${G} api repos/o/r/pulls -f head=feat -f base=main -f title=t`, VIA_API],
  ["graphql createPullRequest", `${G} api graphql -f query='${CREATE_GH}'`, VIA_API],
  ["graphql --input", `${G} api graphql --input body.json`, VIA_API],
  ["%67raphql -F query=@f", `${G} api %67raphql -F query=@f`, VIA_API],
  ["%70ulls POST", `${G} api -X POST repos/o/r/%70ulls -f head=x -f base=main -f title=t`, VIA_API],
  ["bash -c gh pr create", `bash -c "${G} pr create --base main"`, UNRES],
  ["bash -c gh api POST pulls", `bash -c '${G} api -X POST repos/o/r/pulls'`, UNRES],
  // The r3 re-review's create-gate rows.
  ["C1 gh -f query=<createPullRequest, gh x> api graphql", `${G} -f 'query=${CREATE_GH}' api graphql`, UNRES],
  ["C2 gh api user && C1", `${G} api user && ${G} -f 'query=${CREATE_GH}' api graphql`, UNRES],
  ["C3 gh -f 'title=gh x' api POST pulls", `${G} -f 'title=${G} x' api -X POST repos/o/r/pulls -f head=feat -f base=main`, UNRES],
  ["C4 {gh,api} POST pulls", `{${G},api} -X POST repos/o/r/pulls -f head=f -f base=main -f title=t`, UNRES],
  // Siblings found in round 4.
  ["gh -t 'a b' pr create", `${G} -t 'a b' pr create --base main`, UNRES],
  ["gh --title 'my title' pr create", `${G} --title 'my title' pr create --base main`, UNRES],
  ["gh pr 2>/dev/null create", `${G} pr 2>/dev/null create --base main`, UNRES],
  ["gh 2>&1 api POST pulls", `${G} 2>&1 api -X POST repos/o/r/pulls -f head=f -f base=main`, UNRES],
  ["gh {pr,create}", `${G} {pr,create} --base main`, UNRES],
  ["bash -c {gh,pr} create", `bash -c "{${G},pr} create --base main"`, UNRES],
  // Only the brace rule stops these: read literally they name no base, but the shell passes `-B dev`.
  ["an isolated creation whose brace list builds -B", `${G} pr create {-B,} dev`, UNRES],
  ["an isolated creation whose brace sequence builds -B", `${G} pr create -{B..B} dev`, UNRES],
  // Round 5 (r4 B rows and ANSI-C).
  ["B4 gh pr {c..c}reate", `${G} pr {c..c}reate --base main`, UNRES],
  ["B5 gh {p..p}r create", `${G} {p..p}r create --base main`, UNRES],
  ["B6 gh api POST {p..p}ulls", `${G} api -X POST repos/o/r/{p..p}ulls -f head=f -f base=main -f title=t`, UNRES],
  ["{g..g}h pr create", `{g..g}h pr create --base main`, UNRES],
  ["ANSI-C gh pr $'\\x63reate'", `${G} pr $'\\x63reate' --base main`, UNRES],
  ["plain $'create' is read as create", `${G} pr $'create' --base main`, "creation"]
];

test("round 4: the create gate's rows, the r3 re-review's included", () => {
  const wrong = [];
  for (const [name, cmd, want] of CREATE) {
    try {
      const v = parsePrCreate(cmd);
      if (want !== "creation" || v === null) wrong.push(`${name}: got ${v === null ? "null" : "creation"}, want ${want}`);
    } catch (e) {
      if (e.code !== want) wrong.push(`${name}: threw ${e.code}, want ${want}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.doesNotThrow(() => parsePrCreate(`${G} api graphql -f query='query{repository(owner:"o",name:"r"){id}}'`), "a quoted GraphQL body is not a brace list");
  // Round 5 (r4 ruling): any brace expansion in a command that names gh is refused, so this read is an accepted
  // fail-closed false positive, like the quoted-title rows below.
  assert.throws(() => parsePrCreate(`for i in {1,2}; do ${G} pr view $i; done`), (e) => e.code === UNRES);
  // The accepted false positives CLAUDE.md describes: a title's api word reachable from a gh word, with pulls text.
  assert.throws(() => parsePrCreate(`${G} pr create --title "${G} api pulls"`), (e) => e.code === UNRES);
  assert.throws(() => parsePrCreate(`${G} -R o/r pr create --title "Add api for pulls"`), (e) => e.code === UNRES);
  assert.equal(parsePrCreate(`${G} -R o/r pr create --title "Add api"`)?.repo, "o/r");
  assert.throws(() => parseMerge(`${G} -R o/r pr view 5 && ${G} pr merge 5 --match-head-commit ${A}`), (e) => e.code === UNRES);
});

/**
 * Where a gh command word ends: every whitespace-separated run whose unquoted text ends in gh (inside a `bash -c "…"`
 * string too), with the quote open at that point. A row with none uses its first word (curl, wget …).
 * @param {string} cmd
 */
function commandWordEnds(cmd) {
  /** @type {Array<{ at: number, quote: string }>} */
  const ends = [];
  let quote = "";
  let start = -1;
  let first = -1;
  for (let i = 0; i <= cmd.length; i++) {
    const c = cmd[i] ?? " ";
    if (/\s/.test(c)) {
      if (start !== -1 && first === -1) first = i;
      if (start !== -1 && /(^|\W)gh$/i.test(cmd.slice(start, i).replace(/['"\\]/g, ""))) ends.push({ at: i, quote });
      start = -1;
      continue;
    }
    if (start === -1) start = i;
    if (c === "\\" && quote !== "'") i += 1;
    else if ((c === "'" || c === '"') && (quote === "" || quote === c)) quote = quote === "" ? c : "";
  }
  return ends.length > 0 ? ends : [{ at: first, quote: "" }];
}

const PLAIN = "([^\\s'\"\\\\{},]+)";
const BEFORE_GH = "(?<=^|[\\s\"'(;&|=/`])";
const WRAP_GH = new RegExp(`${BEFORE_GH}${G} ${PLAIN}(?=\\s|$)`, "g");
const WRAP_SUB = new RegExp(`${BEFORE_GH}${G} ${PLAIN} ${PLAIN}(?=\\s|$)`, "g");

/**
 * The class mutations: (a) a pre-subcommand flag whose value holds a gh word, right after each command word;
 * (b) the command word brace-wrapped with the word after it (`{gh,api} …`), or that word with the next (`gh {api,-X} …`).
 * @param {string} cmd
 */
function mutants(cmd) {
  const out = [];
  for (const { at, quote } of commandWordEnds(cmd)) {
    const q = quote === "'" ? '"' : "'";
    for (const flag of [`-f ${q}x=${G} y${q}`, `-H ${q}X-Note: ${G} y${q}`]) out.push(`${cmd.slice(0, at)} ${flag}${cmd.slice(at)}`);
  }
  for (const m of cmd.matchAll(WRAP_GH)) out.push(`${cmd.slice(0, m.index)}{${G},${m[1]}}${cmd.slice(m.index + m[0].length)}`);
  for (const m of cmd.matchAll(WRAP_SUB)) out.push(`${cmd.slice(0, m.index)}${G} {${m[1]},${m[2]}}${cmd.slice(m.index + m[0].length)}`);
  return out;
}

// Round 5: the words a gate keys on: the command word (gh, or a raw client), the subcommands and the endpoint segments.
const KEYWORD = new RegExp(`(?<![A-Za-z0-9])(?:${G}|pr|api|merge|create|new|pulls|graphql|curl|wget|https?|xh)(?![A-Za-z0-9])`, "gi");

/**
 * (c) Each keyword word, wherever it appears (quoted, inside `bash -c "…"`, in a URL), with its first or its last letter
 * spelled as a one-letter brace sequence: `{m..m}erge`, `merg{e..e}`, `{g..g}h`, `g{h..h}`.
 * @param {string} cmd
 */
function keywordMutants(cmd) {
  const out = [];
  for (const m of cmd.matchAll(KEYWORD)) {
    const w = m[0];
    const at = m.index;
    const rest = cmd.slice(at + w.length);
    out.push(`${cmd.slice(0, at)}{${w[0]}..${w[0]}}${w.slice(1)}${rest}`);
    out.push(`${cmd.slice(0, at)}${w.slice(0, -1)}{${w.at(-1)}..${w.at(-1)}}${rest}`);
  }
  return out;
}

test("round 5, class gate: every denied row still denies with any one keyword brace-spelled", async () => {
  assert.deepEqual(keywordMutants(`${G} pr merge 5`), [
    `{g..g}h pr merge 5`, `g{h..h} pr merge 5`, `${G} {p..p}r merge 5`, `${G} p{r..r} merge 5`, `${G} pr {m..m}erge 5`, `${G} pr merg{e..e} 5`
  ]);
  const wrong = [];
  let merges = 0;
  for (const [name, input, want] of PROBE) {
    if (typeof input !== "string" || !want.startsWith("deny:")) continue;
    for (const m of keywordMutants(input)) {
      merges += 1;
      gh.set(GH_MAP);
      const r = await call(m);
      if (r.decision !== "deny") wrong.push(`merge row ${name}: ${JSON.stringify(m)} → ${r.decision}:${r.code}`);
    }
  }
  let creates = 0;
  for (const [name, cmd] of CREATE) {
    for (const m of keywordMutants(cmd)) {
      creates += 1;
      try {
        const v = parsePrCreate(m);
        wrong.push(`create row ${name}: ${JSON.stringify(m)} → ${v === null ? "no decision" : "read as a plain creation"}`);
      } catch (e) {
        if (e.code !== UNRES && e.code !== VIA_API) wrong.push(`create row ${name}: ${JSON.stringify(m)} → ${e.code}`);
      }
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(merges >= 600 && creates >= 150, `too few mutants to mean anything: ${merges} merge, ${creates} create`);
});

test("round 4, class gate: every denied row still denies with a gh-bearing pre-subcommand flag or a brace-wrapped command word", async () => {
  assert.deepEqual(mutants(`${G} api -X PUT r`), [
    `${G} -f 'x=${G} y' api -X PUT r`,
    `${G} -H 'X-Note: ${G} y' api -X PUT r`,
    `{${G},api} -X PUT r`,
    `${G} {api,-X} PUT r`
  ]);
  assert.deepEqual(mutants(`sh -c '${G} pr merge 5'`).slice(0, 1), [`sh -c '${G} -f "x=${G} y" pr merge 5'`], "inside single quotes the value is double-quoted");
  const wrong = [];
  let merges = 0;
  for (const [name, input, want] of PROBE) {
    if (typeof input !== "string" || !want.startsWith("deny:")) continue;
    for (const m of mutants(input)) {
      merges += 1;
      gh.set(GH_MAP);
      const r = await call(m);
      if (r.decision !== "deny") wrong.push(`merge row ${name}: ${JSON.stringify(m)} → ${r.decision}:${r.code}`);
    }
  }
  let creates = 0;
  for (const [name, cmd] of CREATE) {
    for (const m of mutants(cmd)) {
      creates += 1;
      try {
        const v = parsePrCreate(m);
        wrong.push(`create row ${name}: ${JSON.stringify(m)} → ${v === null ? "no decision" : "read as a plain creation"}`);
      } catch (e) {
        if (e.code !== UNRES && e.code !== VIA_API) wrong.push(`create row ${name}: ${JSON.stringify(m)} → ${e.code}`);
      }
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(merges >= 300 && creates >= 60, `too few mutants to mean anything: ${merges} merge, ${creates} create`);
});

// The r3 re-review's rows, as it listed them, at the hook: one deny (Default) or warning (Advisory) and one
// gate.decision each. [command, gate that logs it]
/** @type {Array<[string, "merge" | "pr"]>} */
const R3_HOOK = [
  [`${G} -f 'x=${G} y' api -X PUT repos/o/r/pulls/5/merge`, "merge"],
  [`${G} -f 'body=see ${G} docs' api -X PUT repos/o/r/pulls/5/merge`, "merge"],
  [`${G} -H 'X-Note: ${G} y' api -X PUT repos/o/r/pulls/5/merge`, "merge"],
  [`${G} -f 'query=${MERGE_GH}' api graphql`, "merge"],
  [`${G} api user && ${G} -f 'query=${MERGE_GH}' api graphql`, "merge"],
  [`{${G},api} -X PUT repos/o/r/pulls/5/merge`, "merge"],
  [`${G} {api,-X} PUT repos/o/r/pulls/5/merge`, "merge"],
  [`${G} -X PUT {api,repos/o/r/pulls/5/merge}`, "merge"],
  [`${G} -f x=1 -f 'y=${G} z' api -X PUT repos/o/r/pulls/5/merge`, "merge"],
  // `pullRequest{number}` reads as a gh placeholder, so the merge gate's fast path takes this creation (still a deny).
  [`${G} -f 'query=${CREATE_GH}' api graphql`, "merge"],
  [`${G} api user && ${G} -f 'query=${CREATE_GH}' api graphql`, "merge"],
  [`${G} -f 'title=${G} x' api -X POST repos/o/r/pulls -f head=feat -f base=main`, "pr"],
  // Round 5: a brace expansion routes to the merge gate first, which owns every rewrite refusal (still one deny).
  [`{${G},api} -X POST repos/o/r/pulls -f head=f -f base=main -f title=t`, "merge"]
];

test("round 4: every r3 re-review row denies at the hook under Default and warns under Advisory", () => {
  assert.deepEqual(hookSweep(R3_HOOK), []);
});

// The r4 re-review's rows (B1–B9, ANSI-C, gh alias), the same way.
/** @type {Array<[string, "merge" | "pr"]>} */
const R4_HOOK = [
  [`${G} pr {m..m}erge 5 --squash`, "merge"],
  [`${G} {p..p}r merge 5 --squash`, "merge"],
  [`${G} pr me{r..r}ge 5 --squash`, "merge"],
  [`${G} pr {c..c}reate --base main`, "merge"],
  [`${G} {p..p}r create --base main`, "merge"],
  [`${G} api -X POST repos/o/r/{p..p}ulls -f head=f -f base=main -f title=t`, "merge"],
  [`{g..g}h api -X PUT repos/o/r/pulls/5/merge`, "merge"],
  [`g{h..h} api -X PUT repos/o/r/pulls/5/merge`, "merge"],
  [`${G} pr $'\\155erge' 5 --squash`, "merge"],
  [`${G} api user && ${G} $'\\x61pi' -X PUT repos/o/r/pulls/5/merge`, "merge"],
  [`${G} alias set zz 'pr merge' && ${G} zz 5 --squash`, "merge"],
  [`${G} pr $'\\x63reate' --base main`, "merge"]
];

test("round 5: every r4 re-review row denies at the hook under Default and warns under Advisory", () => {
  assert.deepEqual(hookSweep(R4_HOOK), []);
});

/**
 * Each row through `review-gate-hook.mjs pr` under Default then Advisory: a deny or an Advisory warning, and exactly one
 * gate.decision `[gate, denied|warned, pr_args_unresolvable]`. Returns the rows that did otherwise.
 * @param {Array<[string, "merge" | "pr"]>} rows
 */
function hookSweep(rows) {
  const cfg = path.join(home, "cfg.json");
  const events = path.join(home, "state", "events.jsonl");
  const wrong = [];
  try {
    for (const preset of ["default", "advisory"]) {
      fs.writeFileSync(cfg, JSON.stringify({ version: 1, preset, codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
      for (const [command, gate] of rows) {
        const before = fs.existsSync(events) ? fs.readFileSync(events, "utf8").length : 0;
        const r = spawnSync(process.execPath, [HOOK, "pr"], { env: process.env, encoding: "utf8", input: JSON.stringify({ session_id: "s1", cwd: repo, tool_name: "Bash", tool_input: { command } }) });
        const out = r.stdout.trim() ? JSON.parse(r.stdout) : {};
        const d = (fs.existsSync(events) ? fs.readFileSync(events, "utf8").slice(before) : "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === "gate.decision");
        const verdict = preset === "default" ? out.hookSpecificOutput?.permissionDecision === "deny" : typeof out.systemMessage === "string" && out.systemMessage.startsWith("⚠ review-loop (Advisory)");
        const logged = JSON.stringify(d.map((e) => [e.data.gate, e.data.outcome, e.code]));
        if (!verdict || logged !== JSON.stringify([[gate, preset === "default" ? "denied" : "warned", UNRES]])) wrong.push(`${preset} ${command}: ${JSON.stringify(out)} ${logged}`);
      }
    }
  } finally {
    fs.writeFileSync(cfg, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } }));
  }
  return wrong;
}
