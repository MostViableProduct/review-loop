#!/usr/bin/env node
// The no-personal-content gate (spec §10.2). It prints file, line and rule — never the matched text.
// The author's private names are not in this repo: they come at run time from a private denylist (CONTENT_GATE_DENYLIST,
// else the gitignored .content-gate.private.json). See docs/RELEASE.md.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** @typedef {{ name: string, re: RegExp }} Rule */

/** The rules that hold for every user, so they live in code. */
export const GENERIC_RULES = Object.freeze([
  { name: "users_path", re: /\/Users\//i },
  { name: "personal_rules", re: /~\/\.claude\/rules\//i },
  // `a@example.com.attacker.org` is not an example.com fixture: the domain must end right after `.com`.
  { name: "email", re: /[A-Z0-9._%+-]+@(?!example\.com(?![A-Z0-9-]|\.[A-Z0-9]))[A-Z0-9.-]+\.[A-Z]{2,}/i }
]);

/**
 * A rule list ready for `matchSpans`: every regex carries the `g` flag (matchSpans resets `lastIndex` before use).
 * @param {readonly Rule[]} rules @returns {readonly Rule[]}
 */
export const ruleSet = (rules) => Object.freeze(rules.map((r) => ({ name: r.name, re: new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : `${r.re.flags}g`) })));

const GENERIC = ruleSet(GENERIC_RULES);

export const PRIVATE_ENV = "CONTENT_GATE_DENYLIST";
export const PRIVATE_LIST_FILE = ".content-gate.private.json";
export const PRIVATE_MAX_RULES = 64;
export const PRIVATE_MAX_PATTERN = 200;
const PRIVATE_MAX_BYTES = 64 * 1024;
const PRIVATE_NAME = /^[a-z0-9_]{1,32}$/;
// A private rule named like a generic or operational rule would make findings ambiguous.
const RESERVED_NAMES = new Set([...GENERIC_RULES.map((r) => r.name), "symlink", "not_regular", "too_large", "unreadable", "unlisted", "missing", "private_list_tracked"]);

/**
 * Validates a private denylist: a JSON array of 1–64 `{ name, pattern }`, each name `^[a-z0-9_]{1,32}$` and unique,
 * each pattern a case-insensitive regex source of 1–200 characters that compiles and can't match the empty string
 * (that would fail every line). A reason never contains a pattern or an invalid name: either may be a private word.
 * @param {string} text @returns {{ ok: true, rules: readonly Rule[] } | { ok: false, reason: string }}
 */
export function parsePrivateList(text) {
  const bad = (/** @type {string} */ reason) => /** @type {{ ok: false, reason: string }} */ ({ ok: false, reason });
  if (Buffer.byteLength(text) > PRIVATE_MAX_BYTES) return bad(`over ${PRIVATE_MAX_BYTES} bytes`);
  let v;
  try {
    v = /** @type {unknown} */ (JSON.parse(text));
  } catch {
    return bad("not valid JSON");
  }
  if (!Array.isArray(v)) return bad("not a JSON array");
  if (v.length === 0) return bad("empty (it would check nothing)");
  if (v.length > PRIVATE_MAX_RULES) return bad(`more than ${PRIVATE_MAX_RULES} entries`);
  /** @type {Rule[]} */
  const rules = [];
  for (const [i, e] of v.entries()) {
    const at = `entry ${i + 1}`;
    if (typeof e !== "object" || e === null || Array.isArray(e)) return bad(`${at}: not an object`);
    if (Object.keys(e).sort().join(",") !== "name,pattern") return bad(`${at}: must have exactly the keys name and pattern`);
    const { name, pattern } = /** @type {Record<string, unknown>} */ (e);
    if (typeof name !== "string" || !PRIVATE_NAME.test(name)) return bad(`${at}: name must match ^[a-z0-9_]{1,32}$`);
    if (RESERVED_NAMES.has(name) || rules.some((r) => r.name === name)) return bad(`${at}: name ${name} is already in use`);
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > PRIVATE_MAX_PATTERN) return bad(`${at}: pattern must be a string of 1 to ${PRIVATE_MAX_PATTERN} characters`);
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      return bad(`${at}: pattern is not a valid regular expression`);
    }
    if (re.test("")) return bad(`${at}: pattern matches the empty string`);
    rules.push({ name, re });
  }
  return { ok: true, rules: ruleSet(rules) };
}

/**
 * The private denylist: `CONTENT_GATE_DENYLIST` when set and non-blank (an absent secret reaches a workflow as ""),
 * else `.content-gate.private.json` at the repo root, read with the same no-follow, bounded reader as package files.
 * @param {string} root the real repo root @param {Record<string, string | undefined>} env
 * @returns {{ source: "env" | "file", rules: readonly Rule[] } | { source: "none" } | { source: "invalid", reason: string }}
 */
export function loadPrivateList(root, env) {
  const raw = env[PRIVATE_ENV];
  if (typeof raw === "string" && raw.trim() !== "") {
    const p = parsePrivateList(raw);
    return p.ok ? { source: "env", rules: p.rules } : { source: "invalid", reason: `${PRIVATE_ENV}: ${p.reason}` };
  }
  if (fs.lstatSync(path.join(root, PRIVATE_LIST_FILE), { throwIfNoEntry: false }) === undefined) return { source: "none" };
  const r = readBounded(root, PRIVATE_LIST_FILE);
  if (!r.ok) return { source: "invalid", reason: `${PRIVATE_LIST_FILE}: ${r.rule}` };
  const p = parsePrivateList(r.buf.toString("utf8"));
  return p.ok ? { source: "file", rules: p.rules } : { source: "invalid", reason: `${PRIVATE_LIST_FILE}: ${p.reason}` };
}

// Recorded exemption (Task 24 brief): a bare holder line only, so an email or path added to it still fails.
const LICENSE_HOLDER = /^Copyright \(c\) \d{4}(?:-\d{4})? [\p{L}\p{N} .,'-]+$/u;

/**
 * The GitHub owner of this repo, from `package.json` `repository.url`; the literal `<owner>` until Task 28 sets it.
 * A malformed or empty owner never yields an exemption broader than the three exact coordinates.
 * @param {string} pkgText @returns {string}
 */
export function ownerFrom(pkgText) {
  try {
    const v = /** @type {unknown} */ (JSON.parse(pkgText));
    const repo = typeof v === "object" && v !== null ? /** @type {Record<string, unknown>} */ (v).repository : undefined;
    const url = typeof repo === "object" && repo !== null ? /** @type {Record<string, unknown>} */ (repo).url : undefined;
    const m = typeof url === "string" ? /github\.com[/:]([A-Za-z0-9][A-Za-z0-9-]{0,38})\/review-loop(?:\.git)?\/?$/.exec(url) : null;
    return m ? m[1] : "<owner>";
  } catch {
    return "<owner>";
  }
}

/** @param {string} owner @returns {string[]} */
export const coordsFor = (owner) => [`${owner}/review-loop`, `${owner}/homebrew-tap`, `${owner}/tap`];

/**
 * Every rule match in `s` as `{ name, start, end }`. A match is exempt only when it lies wholly inside an exact
 * coordinate occurrence; text is never stripped, so `<owner>/tap@gmail.com` still fails (its email match leaves the
 * span) and nothing can be joined into or out of a match. After an exempt match the search resumes one character
 * later, so an exempt match can't swallow an overlapping non-exempt one.
 * @param {string} s @param {readonly string[]} coords @param {readonly Rule[]} [rules] from `ruleSet`
 * @returns {Array<{ name: string, start: number, end: number }>}
 */
export function matchSpans(s, coords, rules = GENERIC) {
  /** @type {Array<[number, number]>} */
  const exempt = [];
  for (const c of coords) for (let i = s.indexOf(c); i !== -1; i = s.indexOf(c, i + 1)) exempt.push([i, i + c.length]);
  /** @type {Array<{ name: string, start: number, end: number }>} */
  const out = [];
  for (const r of rules) {
    r.re.lastIndex = 0;
    for (let m = r.re.exec(s); m !== null; m = r.re.exec(s)) {
      const start = m.index;
      const end = start + m[0].length;
      if (exempt.some(([a, b]) => start >= a && end <= b)) {
        r.re.lastIndex = start + 1;
        continue;
      }
      out.push({ name: r.name, start, end });
      if (m[0].length === 0) r.re.lastIndex++;
    }
  }
  return out;
}

/** @param {Array<{ name: string }>} spans @param {readonly Rule[]} rules @returns {string[]} one name per rule, in rule order */
const ruleNames = (spans, rules) => rules.map((r) => r.name).filter((n) => spans.some((s) => s.name === n));

/**
 * Findings for one file's text; `shown` is the path as printed (see `displayPath`).
 * @param {string} shown @param {string} text @param {readonly string[]} coords @param {boolean} [isLicense]
 * @param {readonly Rule[]} [rules] from `ruleSet`
 * @returns {string[]}
 */
export function scanText(shown, text, coords, isLicense = shown === "LICENSE", rules = GENERIC) {
  /** @type {string[]} */
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const bare = raw.replace(/\r$/, "");
    if (isLicense && LICENSE_HOLDER.test(bare)) return;
    for (const name of ruleNames(matchSpans(bare, coords, rules), rules)) out.push(`FAIL ${shown}:${i + 1} rule=${name}`);
  });
  return out;
}

/**
 * A path is content too: its matches are findings, printed as `FAIL <shown> rule=<name> (path)`. The path is matched
 * as `/<rel>` so a top-level `Users/` component counts, with the same coordinate exemption as file text.
 * @param {string} rel @param {readonly string[]} coords @param {readonly Rule[]} [rules] from `ruleSet`
 * @returns {{ shown: string, findings: string[] }}
 */
export function checkPath(rel, coords, rules = GENERIC) {
  const s = `/${rel}`;
  const spans = matchSpans(s, coords, rules);
  const shown = displayPath(rel, spans);
  return { shown, findings: ruleNames(spans, rules).map((n) => `FAIL ${shown} rule=${n} (path)`) };
}

/**
 * The path as printed everywhere: every component that overlaps a match is replaced by `<redacted>`, so a finding
 * never prints the matched text even when the matched text is a file or directory name. Components are offsets into
 * `/<rel>`, each starting after its leading slash.
 * @param {string} rel @param {Array<{ start: number, end: number }>} spans @returns {string}
 */
function displayPath(rel, spans) {
  if (spans.length === 0) return rel;
  let at = 1;
  return rel.split("/").map((c) => {
    const from = at;
    const to = at + c.length;
    at = to + 1;
    return spans.some((s) => s.start < to && s.end > from) ? "<redacted>" : c;
  }).join("/");
}

/** @typedef {{ ok: true, buf: Buffer } | { ok: false, rule: "symlink" | "not_regular" | "too_large" | "unreadable" }} ReadResult */

/**
 * Safe on its own, so the lstat in `readBounded` is a fast path, not the control: a link swapped in after the lstat
 * fails the open (ELOOP), a FIFO can't block it (O_NONBLOCK), and the cap is enforced on the bytes actually read.
 * O_NOFOLLOW guards only the last component, so when `realParent` is given the parent directory is re-resolved after
 * the open and must still be exactly that path: a directory link swapped in after the ancestor walk fails here.
 * @param {string} abs @param {string} [realParent] @returns {ReadResult}
 */
export function readNoFollow(abs, realParent) {
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    return { ok: false, rule: err instanceof Error && "code" in err && err.code === "ELOOP" ? "symlink" : "unreadable" };
  }
  try {
    if (realParent !== undefined && fs.realpathSync(path.dirname(abs)) !== realParent) return { ok: false, rule: "symlink" };
    if (!fs.fstatSync(fd).isFile()) return { ok: false, rule: "not_regular" };
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = fs.readSync(fd, buf, n, buf.length - n, n);
    return n > MAX_FILE_BYTES ? { ok: false, rule: "too_large" } : { ok: true, buf: buf.subarray(0, n) };
  } catch {
    return { ok: false, rule: "unreadable" };
  } finally {
    try { fs.closeSync(fd); } catch { /* the result stands; a failed close changes nothing that was read */ }
  }
}

/**
 * Package files are untrusted. Every component from `root` down, the file included, is lstat'ed before anything is
 * opened: a link anywhere on the path is a finding and is never followed (`git ls-files` names `cli/sub/a.mjs` even
 * when `cli/sub` has become a link). The file must be regular and within the cap before it reaches the reader.
 * @param {string} root a real directory (no links in it) @param {string} rel
 * @param {(abs: string, realParent: string) => ReadResult} [read] the reader; tests pass a spy to prove a refused file is never opened
 * @returns {ReadResult}
 */
export function readBounded(root, rel, read = readNoFollow) {
  // ANY error on the per-file path (EACCES on a listable but unsearchable parent, a vanished file) is a finding on the
  // caller's redacted path: an error message would print the unredacted path.
  try {
    const parts = rel.split("/");
    let st;
    for (let i = 1; i <= parts.length; i++) {
      st = fs.lstatSync(path.join(root, ...parts.slice(0, i)), { throwIfNoEntry: false });
      if (st === undefined) return { ok: false, rule: "unreadable" };
      if (st.isSymbolicLink()) return { ok: false, rule: "symlink" };
      if (i < parts.length && !st.isDirectory()) return { ok: false, rule: "not_regular" };
    }
    if (st === undefined || !st.isFile()) return { ok: false, rule: "not_regular" };
    if (st.size > MAX_FILE_BYTES) return { ok: false, rule: "too_large" };
    return read(path.join(root, rel), path.join(root, ...parts.slice(0, -1)));
  } catch {
    return { ok: false, rule: "unreadable" };
  }
}

/**
 * `--tracked` reads: as `readBounded`, except that a tracked symlink (git's own link blob, e.g. `AGENTS.md`) is scanned
 * as what git commits for it, its target text, read with `readlink` and never followed. A link anywhere above it is
 * still a finding, and the parent is re-resolved after the readlink as `readNoFollow` does.
 * @param {string} root a real directory (no links in it) @param {string} rel @returns {ReadResult}
 */
export function readTracked(root, rel) {
  const r = readBounded(root, rel);
  if (r.ok || r.rule !== "symlink") return r;
  try {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) if (!fs.lstatSync(path.join(root, ...parts.slice(0, i))).isDirectory()) return r;
    const abs = path.join(root, rel);
    if (!fs.lstatSync(abs).isSymbolicLink()) return r;
    const target = fs.readlinkSync(abs, { encoding: "buffer" });
    if (fs.realpathSync(path.dirname(abs)) !== path.join(root, ...parts.slice(0, -1))) return { ok: false, rule: "symlink" };
    return target.length > MAX_FILE_BYTES ? { ok: false, rule: "too_large" } : { ok: true, buf: target };
  } catch {
    return { ok: false, rule: "unreadable" };
  }
}

/**
 * Every entry that is not a real directory, links included (they are rejected later, never followed). A directory
 * that can't be listed is returned in `unreadable` rather than crashing the gate.
 * @param {string} dir @param {string} base @param {{ files: string[], unreadable: string[] }} [acc]
 */
function walk(dir, base, acc = { files: [], unreadable: [] }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    acc.unreadable.push(path.relative(base, dir));
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.files.push(path.relative(base, p));
  }
  return acc;
}

const USAGE = "usage: content-gate.mjs [--dir <extracted-package> | --tracked | --list] [--require-private]";

/** Thrown after the usage text is written, so the exit (2) still drains stderr. */
class UsageError extends Error {}

/** @param {string} msg @returns {never} */
function usage(msg) {
  process.stderr.write(`content-gate: ${msg}\n${USAGE}\n`);
  throw new UsageError();
}

/** @param {string[]} argv @returns {{ dir: string | null, list: boolean, tracked: boolean, requirePrivate: boolean }} */
function parseArgs(argv) {
  /** @type {string | null} */
  let dir = null;
  let list = false;
  let tracked = false;
  let requirePrivate = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list" && !list) list = true;
    else if (a === "--tracked" && !tracked) tracked = true;
    else if (a === "--require-private" && !requirePrivate) requirePrivate = true;
    else if (a === "--dir" && dir === null) {
      const d = argv[++i];
      if (d === undefined || d.startsWith("--")) usage("--dir needs a directory");
      dir = d;
    } else usage(`unknown or repeated argument ${JSON.stringify(a.slice(0, 40))}`);
  }
  if ([dir !== null, list, tracked].filter(Boolean).length > 1) usage("--dir, --tracked and --list are separate modes");
  if (list && requirePrivate) usage("--list checks nothing, so --require-private does not apply");
  return { dir, list, tracked, requirePrivate };
}

const NO_LIST = `no private denylist (set ${PRIVATE_ENV} or create ${PRIVATE_LIST_FILE})`;

/** @returns {string[]} */
function loadAllowlist() {
  const v = /** @type {unknown} */ (JSON.parse(fs.readFileSync(path.join(ROOT, "package.files.json"), "utf8")));
  const files = typeof v === "object" && v !== null ? /** @type {Record<string, unknown>} */ (v).files : undefined;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string" && f !== "" && !f.startsWith("/") && !f.split("/").includes(".."))) {
    usage("package.files.json must be { \"files\": [relative paths] }");
  }
  return /** @type {string[]} */ (files);
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
  const allow = loadAllowlist();
  const allowed = (/** @type {string} */ f) => allow.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a));
  const args = parseArgs(argv);
  let base = ROOT;
  if (args.dir !== null) {
    base = path.resolve(args.dir);
    if (!fs.lstatSync(base, { throwIfNoEntry: false })?.isDirectory()) usage("--dir must name a real directory, not a link");
  }
  // Links above the package root are the caller's choice (macOS /tmp); links at or below it are findings.
  base = fs.realpathSync(base);
  /** @type {string[]} */
  let all;
  /** @type {string[]} */
  let unreadableDirs = [];
  if (args.dir === null) {
    try {
      all = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
    } catch {
      process.stderr.write("content-gate: `git ls-files` failed; run it from a git checkout, or pass --dir <extracted-package>\n");
      return 2;
    }
  } else {
    const w = walk(base, base);
    all = w.files;
    unreadableDirs = w.unreadable;
  }
  const files = all.filter(allowed).sort();

  if (args.list) {
    process.stdout.write(`${files.join("\n")}\n`);
    return 0;
  }

  const priv = loadPrivateList(fs.realpathSync(ROOT), process.env);
  if (priv.source === "invalid") {
    process.stderr.write(`content-gate: invalid private denylist: ${priv.reason}\n`);
    return 2;
  }
  if (priv.source === "none") {
    if (args.requirePrivate) {
      process.stderr.write(`content-gate: --require-private: ${NO_LIST}\n`);
      return 2;
    }
    // Fork PRs get no secrets: the generic rules still run; the release job always has the list.
    process.stderr.write(`content-gate: notice: ${NO_LIST}; ${args.tracked ? "--tracked checked nothing" : "generic rules only"}\n`);
    if (args.tracked) return 0;
  }
  const privateRules = priv.source === "none" ? [] : priv.rules;

  const coords = coordsFor(ownerFrom(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")));
  /** @type {string[]} */
  const failures = [];
  // Gitignored on purpose: committed, the list would publish the very names it keeps out.
  if (args.dir === null && all.includes(PRIVATE_LIST_FILE)) failures.push(`FAIL ${PRIVATE_LIST_FILE} rule=private_list_tracked`);

  // Every tracked file, private rules only: tests and docs legitimately hold generic hits such as `/Users/x`.
  if (args.tracked) {
    for (const f of [...all].sort()) {
      const p = checkPath(f, coords, privateRules);
      failures.push(...p.findings);
      const r = readTracked(base, f);
      if (!r.ok) failures.push(`FAIL ${p.shown} rule=${r.rule}`);
      else failures.push(...scanText(p.shown, r.buf.toString("utf8"), coords, f === "LICENSE", privateRules));
    }
    return report(failures, `content-gate: ok (${all.length} tracked files, private rules)`);
  }

  const rules = Object.freeze([...GENERIC, ...privateRules]);
  for (const d of unreadableDirs.sort()) {
    const p = checkPath(d, coords, rules);
    failures.push(...p.findings, `FAIL ${p.shown} rule=unreadable`);
  }
  // Only an extracted package can hold unlisted files; in a checkout they are simply not shipped.
  if (args.dir !== null) {
    for (const f of all.filter((f) => !allowed(f)).sort()) {
      const p = checkPath(f, coords, rules);
      failures.push(...p.findings, `FAIL ${p.shown} rule=unlisted`);
    }
  }
  for (const a of allow) if (!files.some((f) => (a.endsWith("/") ? f.startsWith(a) : f === a))) failures.push(`FAIL ${checkPath(a, coords, rules).shown} rule=missing`);
  for (const f of files) {
    const p = checkPath(f, coords, rules);
    failures.push(...p.findings);
    const r = readBounded(base, f);
    if (!r.ok) failures.push(`FAIL ${p.shown} rule=${r.rule}`);
    // Binary content is scanned too: a NUL byte doesn't stop an embedded path or email from shipping.
    else failures.push(...scanText(p.shown, r.buf.toString("utf8"), coords, f === "LICENSE", rules));
  }
  return report(failures, `content-gate: ok (${files.length} files)`);
}

/** @param {string[]} failures @param {string} okLine @returns {number} */
function report(failures, okLine) {
  if (failures.length) {
    process.stdout.write(`${failures.join("\n")}\ncontent-gate: ${failures.length} finding(s)\n`);
    return 1;
  }
  process.stdout.write(`${okLine}\n`);
  return 0;
}

const isMain = (() => { try { return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
/**
 * The last resort: only an error code or class is printed, never a message or stack (either can carry a path or the
 * matched text).
 * @param {unknown} err
 */
function internalTag(err) {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) return code;
  const cls = err instanceof Error ? err.constructor.name : "";
  return /^[A-Za-z]{1,40}$/.test(cls) ? cls : "unknown";
}

if (isMain) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) process.stderr.write(`content-gate: ERROR internal (${internalTag(err)})\n`);
    code = 2;
  }
  // Not process.exit(): on macOS a pipe to stdout is asynchronous, and exiting at once truncates the output. The
  // release workflow reads `--list` through `$(…)`, so a truncated list would silently drop files from the tarball.
  process.exitCode = code;
}
