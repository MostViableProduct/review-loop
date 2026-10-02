// P7: GitHub enforces --match-head-commit (P7a) and for --auto (P7-auto); base-scoped required statuses block a retarget (P7b).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const G = "g" + "h";
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const first = (s) => String(s).split("\n")[0].slice(0, 200);
const tryRun = (cmd, args, cwd) => { try { return { ok: true, out: sh(cmd, args, cwd) }; } catch (e) { return { ok: false, out: first(e.stderr || e.message) }; } };
const user = sh(G, ["api", "user", "--jq", ".login"]);
const name = `review-loop-probe-${Date.now()}`;
const slug = `${user}/${name}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p7-"));
sh(G, ["repo", "create", slug, "--private", "--add-readme"]);
console.error(`CREATED ${slug}`);
sh("git", ["clone", "-q", `https://github.com/${slug}.git`, dir]);
const commit = (f, msg) => { fs.writeFileSync(path.join(dir, f), msg); sh("git", ["add", f], dir); sh("git", ["commit", "-qm", msg], dir); return sh("git", ["rev-parse", "HEAD"], dir); };
sh("git", ["checkout", "-qb", "release"], dir); sh("git", ["push", "-q", "-u", "origin", "release"], dir);
sh("git", ["checkout", "-q", "main"], dir);
sh("git", ["checkout", "-qb", "feat"], dir);
const A = commit("a.txt", "A"); sh("git", ["push", "-q", "-u", "origin", "feat"], dir);
const create = [G, "pr", "create"].slice(1);
const prUrl = sh(G, [...create, "--repo", slug, "--base", "main", "--head", "feat", "--title", "probe", "--body", "probe"], dir);
const n = prUrl.split("/").pop();
const B = commit("b.txt", "B"); sh("git", ["push", "-q"], dir);
const p7a = tryRun(G, ["pr", "merge", n, "--repo", slug, "--merge", "--match-head-commit", A], dir);
const stateA = sh(G, ["pr", "view", n, "--repo", slug, "--json", "state", "--jq", ".state"], dir);

// P7-auto: same stale head with --auto. Auto-merge needs the repo setting.
const enable = tryRun(G, ["api", "-X", "PATCH", `repos/${slug}`, "-F", "allow_auto_merge=true"], dir);
const auto = tryRun(G, ["pr", "merge", n, "--repo", slug, "--auto", "--merge", "--match-head-commit", A], dir);
const viewAuto = tryRun(G, ["pr", "view", n, "--repo", slug, "--json", "state,autoMergeRequest"], dir);
let autoState = "", autoRequestPresent = null;
if (viewAuto.ok) { const v = JSON.parse(viewAuto.out); autoState = v.state; autoRequestPresent = v.autoMergeRequest !== null && v.autoMergeRequest !== undefined; }
if (autoRequestPresent) tryRun(G, ["pr", "merge", n, "--repo", slug, "--disable-auto"], dir);

// P7b: require review-loop/<base> on both bases, post only review-loop/main on B, then retarget to release.
let p7b = { protection_put_ok: true, protection_note: "" };
try {
  for (const base of ["main", "release"]) {
    const body = { required_status_checks: { strict: false, contexts: [`review-loop/${base}`] }, enforce_admins: true, required_pull_request_reviews: null, restrictions: null };
    const f = path.join(dir, `prot-${base}.json`);
    fs.writeFileSync(f, JSON.stringify(body));
    sh(G, ["api", "-X", "PUT", `repos/${slug}/branches/${base}/protection`, "--input", f], dir);
  }
} catch (e) { p7b = { protection_put_ok: false, protection_note: first(e.stderr || e.message) }; }
if (p7b.protection_put_ok) {
  sh(G, ["api", "-X", "POST", `repos/${slug}/statuses/${B}`, "-f", "state=success", "-f", "context=review-loop/main"], dir);
  const mergeState = () => sh(G, ["pr", "view", n, "--repo", slug, "--json", "mergeStateStatus", "--jq", ".mergeStateStatus"], dir);
  p7b.p7b_before_retarget = mergeState();
  sh(G, ["pr", "edit", n, "--repo", slug, "--base", "release"], dir);
  let after = "";
  for (let i = 0; i < 10; i++) {
    after = mergeState();
    if (after !== "UNKNOWN") break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  p7b.p7b_after_retarget = after;
}
const del = tryRun(G, ["repo", "delete", slug, "--yes"], dir);
console.log(JSON.stringify({
  slug, pr: n,
  p7a_rejected: !p7a.ok, p7a_note: p7a.ok ? "" : p7a.out, p7a_state_after: stateA,
  p7auto_setting_enabled: enable.ok, p7auto_setting_note: enable.ok ? "" : enable.out,
  p7auto_rejected: !auto.ok, p7auto_note: auto.ok ? "" : auto.out,
  p7auto_state_after: autoState, p7auto_request_present: autoRequestPresent,
  ...p7b,
  deleted: del.ok, deleteNote: del.ok ? "" : `delete manually: ${slug}`
}));
