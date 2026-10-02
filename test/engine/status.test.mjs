import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
const home = tmpDir();
Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
const { readConfig } = await import("../../plugin/engine/lib/config.mjs");
const { postVerdict, statusContext, policyFingerprint } = await import("../../plugin/engine/lib/status.mjs");
const A = "a".repeat(40);

test("T-PR-5: context names the base; success then failure on the same SHA", async () => {
  const gh = makeFakeBin(bin, "gh", { "*": { stdout: "{}" } });
  assert.equal(statusContext("main"), "review-loop/main");
  assert.equal(statusContext("feat/x y"), "review-loop/feat%2Fx%20y");
  assert.equal(await postVerdict({ slug: "o/r", sha: A, baseBranch: "main", state: "success", description: "passed", cwd: home, session: null, key: null }), true);
  assert.equal(await postVerdict({ slug: "o/r", sha: A, baseBranch: "main", state: "failure", description: "not passed", cwd: home, session: null, key: null }), true);
  const calls = gh.log().map((a) => a.join(" "));
  assert.match(calls[0], new RegExp(`^api -X POST repos/o/r/statuses/${A} -f state=success -f context=review-loop/main -f description=.*policy [0-9a-f]{12}`));
  assert.match(calls[1], /-f state=failure -f context=review-loop\/main/);
});

test("T-PR-5 (−): gh missing or 422 → false + status_post_failed event, never throws", async () => {
  makeFakeBin(bin, "gh", { "*": { code: 1, stderr: "HTTP 422: No commit found for SHA" } });
  assert.equal(await postVerdict({ slug: "o/r", sha: A, baseBranch: "main", state: "success", description: "passed", cwd: home, session: null, key: null }), false);
  const ev = fs.readFileSync(path.join(home, "state", "events.jsonl"), "utf8");
  assert.match(ev, /"code":"status_post_failed"/);
});

test("T-PR-5 (−): gh binary absent (ENOENT) → false + status_post_failed event, never throws", async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = tmpDir();
  try {
    assert.equal(await postVerdict({ slug: "o/r", sha: A, baseBranch: "main", state: "success", description: "passed", cwd: home, session: null, key: null }), false);
  } finally {
    process.env.PATH = savedPath;
  }
  const events = fs.readFileSync(path.join(home, "state", "events.jsonl"), "utf8").trim().split("\n");
  assert.match(events.at(-1), /"code":"status_post_failed"/);
});

test("the description is capped at 140 chars and the policy suffix always survives", async () => {
  const gh = makeFakeBin(bin, "gh", { "*": { stdout: "{}" } });
  await postVerdict({ slug: "o/r", sha: A, baseBranch: "main", state: "success", description: "x".repeat(200), cwd: home, session: null, key: null });
  const arg = gh.log()[0].find((a) => a.startsWith("description="));
  assert.equal(arg.length - "description=".length, 140);
  assert.match(arg, new RegExp(` · policy ${policyFingerprint()}$`));
});

test("T-PR-13: policy fingerprint changes with the rubric; approvals are not revoked", async () => {
  const gh = makeFakeBin(bin, "gh", { "*": { stdout: "{}" } });
  const callsBefore = gh.log().length;
  const before = policyFingerprint();
  assert.equal(policyFingerprint(), before, "stable with no change");
  const mine = path.join(home, "mine.md");
  fs.writeFileSync(mine, fs.readFileSync(new URL("../../plugin/rubric/default.md", import.meta.url)) + "\nextra\n");
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: mine, events: { path: null } }));
  const after = policyFingerprint();
  assert.notEqual(after, before);
  assert.equal(readConfig().config.rubricPath, mine);
  assert.equal(gh.log().length, callsBefore, "changing the rubric posts nothing by itself");
});

test("L16: the policy fingerprint's input is pinned: rubric, NUL, preset, NUL, bar, NUL, review-loop <major.minor>", async () => {
  const { PACKAGE_VERSION } = await import("../../plugin/engine/lib/events.mjs");
  const crypto = await import("node:crypto");
  const rubric = path.join(home, "golden-rubric.md");
  fs.writeFileSync(rubric, "# Golden rubric\n\n- Correctness\n");
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "balanced", codex: { model: null, effort: null }, rubricPath: rubric, events: { path: null } }));
  const [major, minor] = PACKAGE_VERSION.split(".");
  const input = `# Golden rubric\n\n- Correctness\n\u0000balanced\u00009.2\u0000review-loop ${major}.${minor}`;
  assert.equal(policyFingerprint(), crypto.createHash("sha256").update(input).digest("hex").slice(0, 12));
  if (PACKAGE_VERSION.startsWith("0.1.")) assert.equal(policyFingerprint(), "5b187a7376b4", "the literal for 0.1.x (computed independently with printf | shasum -a 256)");
});
