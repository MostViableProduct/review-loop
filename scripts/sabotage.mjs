#!/usr/bin/env node
// Proves every load-bearing gate can go red: applies each registry break, requires the NAMED test to fail, restores.
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SABOTAGES } from "./sabotage-registry.mjs";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const MAX_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
const TEST_TIMEOUT_MS = 10 * 60_000;
/** The exit code when SIGINT/SIGTERM stopped the run (128 + SIGINT, the shell's convention). */
export const EXIT_INTERRUPTED = 130;

/** @typedef {{ abs: string, ino: number, dev: number }} Target */
/** @typedef {{ find: string, replace: string }} Edit */
/**
 * `also` is a second edit in the same file, for a gate enforced in two places: both are applied and restored as one
 * write, and each `find` must match exactly once.
 * @typedef {{ id: string, file: string, find: string, replace: string, also?: Edit, test: string, expect: string }} Sabotage
 */
/** @typedef {{ status: number | null, signal: string | null, timedOut: boolean, stdout: string, stderr: string }} TestRun */
/** @typedef {"red" | "stayed_green" | "wrong_failure"} Verdict */

/** The file at a checked path is no longer the file that was checked. Nothing was written through it. */
export class IdentityError extends Error {}

/**
 * Registry paths are untrusted working-tree input: each must be a regular, non-link file with no other hard link,
 * ≤ 1 MiB, whose real path stays inside the repo. The returned identity (inode + device) is what every later read and
 * write must still hit.
 * @param {string} root @param {string} rel @returns {Target}
 */
export function checkTarget(root, rel) {
  const abs = path.resolve(root, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  // nlink: a hard link to a file outside the repo passes every path check, and writing it writes that file too.
  if (!st || !st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES || !fs.realpathSync(abs).startsWith(root + path.sep)) {
    throw new Error(`sabotage: refusing ${rel} (must be a regular file ≤ 1 MiB inside the repo, not a link or a hard link)`);
  }
  return { abs, ino: st.ino, dev: st.dev };
}

/**
 * Open without following a link and prove the descriptor is the validated file before touching it. A path swapped
 * after checkTarget (final component → link: ELOOP; any other replacement: different inode) is refused, never written.
 * `singleLink` also refuses a file that has gained a hard link: writing a break into it would write it into the other
 * name too. A restore passes false: it puts the original bytes back into the very inode that was checked, which is
 * right for every name that inode has (something outside this runner can link a repo file mid-run).
 * @template T @param {Target} t @param {number} flags @param {boolean} singleLink
 * @param {(fd: number, size: number) => T} use @returns {T}
 */
function withSameFile(t, flags, singleLink, use) {
  let fd;
  try {
    fd = fs.openSync(t.abs, flags | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ELOOP") throw new IdentityError(`sabotage: ${t.abs} became a link after it was checked; not touched`);
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    const extraLinks = singleLink && st.nlink !== 1;
    if (!st.isFile() || st.ino !== t.ino || st.dev !== t.dev || extraLinks || st.size > MAX_BYTES) {
      const what = [!st.isFile() && "not a regular file", st.ino !== t.ino && "a different inode", st.dev !== t.dev && "a different device", extraLinks && `${st.nlink} hard links`, st.size > MAX_BYTES && "over 1 MiB"].filter(Boolean).join(", ");
      throw new IdentityError(`sabotage: ${t.abs} changed after it was checked (${what}); not touched`);
    }
    return use(fd, st.size);
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {Target} t @returns {Buffer} */
export function readSame(t) {
  return withSameFile(t, fs.constants.O_RDONLY, false, (fd, size) => { const b = Buffer.alloc(size); const n = fs.readSync(fd, b, 0, size, 0); return b.subarray(0, n); });
}

/**
 * Rewrites in place through the verified descriptor (no O_CREAT: a missing file is an error, not a new file).
 * @param {Target} t @param {Buffer} data @param {{ restoring?: boolean }} [opts] restoring: the original bytes, so a
 * hard link gained since the check doesn't block them
 */
export function writeSame(t, data, opts = {}) {
  withSameFile(t, fs.constants.O_WRONLY, opts.restoring !== true, (fd) => { fs.ftruncateSync(fd, 0); fs.writeSync(fd, data, 0, data.length, 0); });
}

const esc = (/** @type {string} */ t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Red only when the run failed AND the named test is among the failures. A syntax error, a missing import or an
 * unrelated assertion fails the file too, but reports a different (or file-level) `not ok` line.
 * @param {number | null} status @param {string} output @param {string} expect @returns {Verdict}
 */
export function classify(status, output, expect) {
  if (status === 0) return "stayed_green";
  return new RegExp(`^\\s*not ok \\d+ - [^\\n]*${esc(expect)}`, "m").test(output) ? "red" : "wrong_failure";
}

/** A run that a signal ended, other than this runner's own timeout, was interrupted: its verdict means nothing. @param {TestRun} r */
const endedBySignal = (r) => typeof r.signal === "string" && !r.timedOut;

/**
 * Asynchronous on purpose: with spawnSync the SIGINT/SIGTERM handlers could not run until every row had finished.
 * NODE_TEST_CONTEXT is dropped: when this runs under a test runner, an inherited one turns the child `node --test`
 * into a reporter for the parent, which prints no TAP and exits 0 even when its tests fail.
 * @param {string} root @param {string} test @param {AbortSignal} [abort] kills the run's process group (SIGKILL) when it fires
 * @returns {Promise<TestRun>}
 */
export function nodeTest(root, test, abort) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // Its own process group, killed whole: a test file's spawnSync child spinning in a loop outlives a kill of
    // node --test alone (orphans ran for hours).
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", test], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = () => {
      try {
        // Never a missing, 0 or 1 pid: kill(-0) would hit this runner's own group, kill(-1) every user process.
        if (Number.isInteger(child.pid) && Number(child.pid) > 1) process.kill(-Number(child.pid), "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, TEST_TIMEOUT_MS);
    const onAbort = () => killGroup();
    if (abort?.aborted) onAbort();
    else abort?.addEventListener("abort", onAbort, { once: true });
    /** @param {TestRun} r */
    const settle = (r) => { if (settled) return; settled = true; clearTimeout(timer); abort?.removeEventListener("abort", onAbort); resolve(r); };
    child.stdout.setEncoding("utf8").on("data", (/** @type {string} */ c) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += c; });
    child.stderr.setEncoding("utf8").on("data", (/** @type {string} */ c) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += c; });
    // Only a spawn that never started settles here.
    child.on("error", (err) => { if (child.pid === undefined) settle({ status: null, signal: null, timedOut, stdout, stderr: `${stderr}${err.message}\n` }); });
    child.on("close", (status, signal) => settle({ status, signal, timedOut, stdout, stderr }));
  });
}

const message = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

/** @param {Buffer} buf @param {Buffer} needle @returns {number[]} */
function offsets(buf, needle) {
  /** @type {number[]} */
  const at = [];
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/**
 * The row's break as bytes, or why it can't be applied. Spliced as bytes: String.replace would expand `$&`-style
 * patterns in `replace`, and a decode/encode round trip could alter bytes outside the break.
 * @param {Buffer} orig @param {Sabotage} s @returns {{ broken: Buffer } | { error: string }}
 */
export function applyEdits(orig, s) {
  const edits = [{ find: s.find, replace: s.replace }, ...(s.also ? [s.also] : [])];
  /** @type {Array<{ at: number, len: number, with: Buffer }>} */
  const spans = [];
  for (const e of edits) {
    const find = Buffer.from(e.find, "utf8");
    const at = offsets(orig, find);
    if (at.length !== 1) return { error: `find matches ${at.length} times in ${s.file}, not exactly once` };
    spans.push({ at: at[0], len: find.length, with: Buffer.from(e.replace, "utf8") });
  }
  spans.sort((a, b) => a.at - b.at);
  if (spans.length === 2 && spans[0].at + spans[0].len > spans[1].at) return { error: `the two finds overlap in ${s.file}` };
  /** @type {Buffer[]} */
  const parts = [];
  let from = 0;
  for (const sp of spans) { parts.push(orig.subarray(from, sp.at), sp.with); from = sp.at + sp.len; }
  parts.push(orig.subarray(from));
  return { broken: Buffer.concat(parts) };
}

/**
 * Never throws: the caller must learn about a failed restore, and a throw from `finally` would mask it.
 * @param {{ readSame: typeof readSame, writeSame: typeof writeSame }} io @param {Target} t @param {Buffer} orig
 * @returns {string | null} what went wrong, or null when the file holds the original bytes again
 */
function restore(io, t, orig) {
  try {
    io.writeSame(t, orig, { restoring: true });
    return io.readSame(t).equals(orig) ? null : "the bytes differ from the original after the restore";
  } catch (err) {
    return message(err);
  }
}

/**
 * Waits, bounded, for a file to have a single link again. Sync tools hard-link a file they see change into a staging
 * directory while they upload it (Google Drive for desktop does, under `.tmp.driveupload`), so the previous row's
 * restore can leave the next row's file linked for a while. The checks after this still refuse a file that stays linked.
 * @param {string} abs @param {number} maxMs @param {AbortSignal} abort @returns {Promise<number>} ms waited (0: no link)
 */
async function waitSingleLink(abs, maxMs, abort) {
  const t0 = Date.now();
  const linked = () => (fs.lstatSync(abs, { throwIfNoEntry: false })?.nlink ?? 1) > 1;
  if (!linked()) return 0;
  while (linked() && Date.now() - t0 < maxMs && !abort.aborted) await new Promise((r) => setTimeout(r, 250));
  return Math.max(1, Date.now() - t0);
}

/**
 * Runs every row (or the one named by `only`). Resolves 0 when every break went red for its named test,
 * EXIT_INTERRUPTED when `abort` fired or a test run was ended by a signal (after restoring the row's file), else 1.
 * A find that doesn't match exactly once, a refused path, a file whose identity changed, or a failed restore stops the
 * run at once.
 * @param {{ root?: string, rows?: readonly Sabotage[], only?: string | null, out?: (s: string) => void,
 *   runTest?: (root: string, test: string, abort?: AbortSignal) => TestRun | Promise<TestRun>,
 *   io?: { readSame: typeof readSame, writeSame: typeof writeSame }, abort?: AbortSignal, linkWaitMs?: number }} [opts]
 * @returns {Promise<number>}
 */
export async function runSabotage(opts = {}) {
  const { root = ROOT, rows = SABOTAGES, only = null, out = (s) => { process.stdout.write(s); }, runTest = nodeTest, io = { readSame, writeSame }, abort = new AbortController().signal, linkWaitMs = 120_000 } = opts;
  const waitLinks = async (/** @type {string} */ rel) => {
    const ms = await waitSingleLink(path.resolve(root, rel), linkWaitMs, abort);
    if (ms > 0) out(`WAIT ${rel} had another hard link (a sync tool?); waited ${(ms / 1000).toFixed(1)} s\n`);
  };
  /** @type {string[]} */
  const bad = [];
  for (const s of rows.filter((x) => only === null || x.id === only)) {
    if (abort.aborted) { out(`sabotage: interrupted before ${s.id}\n`); return EXIT_INTERRUPTED; }
    /** @type {Target} */
    let target;
    /** @type {Buffer} */
    let orig;
    await waitLinks(s.file);
    try {
      checkTarget(root, s.test);
      target = checkTarget(root, s.file);
      orig = io.readSame(target);
    } catch (err) {
      out(err instanceof IdentityError ? `FAIL identity-changed ${s.file}: ${message(err)}\n` : `FAIL ${s.id}: ${message(err)}\n`);
      return 1;
    }
    const edit = applyEdits(orig, s);
    if ("error" in edit) { out(`FAIL ${s.id}: ${edit.error}\n`); return 1; }
    const baseline = await runTest(root, s.test, abort);
    if (abort.aborted || endedBySignal(baseline)) { out(`INTERRUPTED  ${s.id} (before its break was applied)\nsabotage: interrupted\n`); return EXIT_INTERRUPTED; }
    if (baseline.status !== 0) { bad.push(`${s.id} (baseline red)`); out(`BASELINE RED  ${s.id}\n`); continue; }
    await waitLinks(s.file);
    if (abort.aborted) { out(`INTERRUPTED  ${s.id} (before its break was applied)\nsabotage: interrupted\n`); return EXIT_INTERRUPTED; }
    /** @type {string | null} */
    let restoreProblem = null;
    /** @type {string | null} */
    let identityChanged = null;
    /** @type {unknown} */
    let failure = null;
    let interrupted = false;
    /** @type {Verdict} */
    let verdict = "wrong_failure";
    try {
      try {
        io.writeSame(target, edit.broken);
      } catch (err) {
        if (err instanceof IdentityError) identityChanged = message(err);
        throw err;
      }
      const r = await runTest(root, s.test, abort);
      interrupted = abort.aborted || endedBySignal(r);
      verdict = classify(r.status, `${r.stdout}\n${r.stderr}`, s.expect);
    } catch (err) {
      failure = err;
    } finally {
      // An identity refusal happens before any byte is written, and a restore would be refused the same way.
      restoreProblem = identityChanged === null ? restore(io, target, orig) : null;
    }
    if (identityChanged !== null) { out(`FAIL identity-changed ${s.file}: ${identityChanged}\n`); return 1; }
    if (restoreProblem !== null) { out(`FAIL restore ${s.file}: ${restoreProblem}\n`); return 1; }
    const links = fs.lstatSync(target.abs, { throwIfNoEntry: false })?.nlink ?? 1;
    if (links > 1) out(`WARN ${s.file} gained ${links - 1} hard link(s) during the run (another process linked it); restored in place\n`);
    if (failure !== null) { out(`FAIL ${s.id}: ${message(failure)} (${s.file} restored)\n`); return 1; }
    if (interrupted) { out(`INTERRUPTED  ${s.id} (${s.file} restored)\nsabotage: interrupted\n`); return EXIT_INTERRUPTED; }
    if (verdict !== "red") bad.push(`${s.id} (${verdict})`);
    out(`${verdict === "red" ? "red (expected)" : verdict.toUpperCase()}  ${s.id}\n`);
  }
  if (bad.length) { out(`sabotage: ${bad.length} row(s) did not prove their gate: ${bad.join(", ")}\n`); return 1; }
  out("sabotage: every break went red for its named test\n");
  return 0;
}

const USAGE = "usage: sabotage.mjs [--only <id>]";

/** @param {string[]} argv @returns {{ only: string | null } | { error: string }} */
function parseArgs(argv) {
  if (argv.length === 0) return { only: null };
  if (argv.length === 2 && argv[0] === "--only" && SABOTAGES.some((s) => s.id === argv[1])) return { only: argv[1] };
  return { error: argv[0] === "--only" && argv.length === 2 ? `no sabotage row has id ${JSON.stringify(argv[1].slice(0, 60))}` : "unknown or incomplete arguments" };
}

const isMain = (() => { try { return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    process.stderr.write(`sabotage: ${args.error}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    // Without these, Ctrl-C or a CI cancel would kill this process mid-row and leave a guarded file broken. The abort
    // kills the running test's process group (detached, so a terminal's Ctrl-C reaches only this process); the row is
    // restored, the run stops, and the exit is EXIT_INTERRUPTED.
    const stop = new AbortController();
    process.on("SIGINT", () => stop.abort());
    process.on("SIGTERM", () => stop.abort());
    // A closed terminal: without this the runner dies mid-row and leaves the break in the source file.
    process.on("SIGHUP", () => stop.abort());
    // Not process.exit(): on macOS a stdout pipe is asynchronous, and an immediate exit truncates the verdict lines.
    process.exitCode = await runSabotage({ only: args.only, abort: stop.signal });
  }
}
