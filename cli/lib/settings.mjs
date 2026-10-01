// The spec §6.2 settings.json writer: the only code that edits the user's Claude Code settings.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { MiB, sha256hex, safeReadFile, isObject } from "../../plugin/engine/lib/fsutil.mjs";
import { claudeConfigDir, stateRoot, stateSubdir } from "../../plugin/engine/lib/paths.mjs";
import { CliError } from "./errors.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";

export const ASK_RULES = Object.freeze([
  "Bash(*review-loop.off*)",
  "Bash(*review-round.mjs decide*)",
  "Bash(*review-round.mjs override*)",
  "Bash(*review-round.mjs repin*)",
  "Edit(**/.claude/review-loop.off)"
]);
export const LEGACY_HOOK_RE = /review-loop\/review-gate-hook\.mjs/;
const MAX_ATTEMPTS = 3;
const KEEP_BACKUPS = 5;
const SETTINGS_MAX_BYTES = MiB;
const TOOL_TIMEOUT_MS = 10_000;
const TEMP_RE = /^\.settings\.json\.review-loop-\d+-[0-9a-f]{8}\.tmp$/;
const BACKUP_RE = /^settings\.json\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{8}$/;
const BACKUP_SUBDIR = "settings-backups";

/** Test-only interleaving points. In production each is a no-op or the real call. */
const noop = () => {};
const defaults = {
  beforeRecheck: noop, beforeLink: noop, beforeRehash: noop, beforeRename: noop, afterRename: noop,
  statUid: (/** @type {fs.Stats} */ st) => st.uid,
  link: (/** @type {string} */ from, /** @type {string} */ to) => fs.linkSync(from, to)
};
let hooks = { ...defaults };
export const seams = { set: (/** @type {Partial<typeof defaults>} */ h) => { hooks = { ...hooks, ...h }; }, reset: () => { hooks = { ...defaults }; } };

export function settingsPath() {
  return path.join(claudeConfigDir(), "settings.json");
}

/** @param {string} target */
const insecure = (target) => new CliError("settings_target_insecure", `${target} must be a regular file you own`);

/** @returns {{ target: string, exists: boolean, base: string | null, mode: number, obj: Record<string, unknown> }} */
export function readSettings() {
  const link = settingsPath();
  const lst = fs.lstatSync(link, { throwIfNoEntry: false });
  // Only a genuinely missing path is "absent". A dangling link is refused: renaming over it would destroy the
  // dotfile manager's link.
  if (lst === undefined) return { target: link, exists: false, base: null, mode: 0o600, obj: {} };
  let target = link;
  if (lst.isSymbolicLink()) {
    try {
      target = fs.realpathSync(link);
    } catch {
      throw new CliError("settings_target_insecure", "settings.json is a symlink to a missing file; fix or remove the link, then re-run");
    }
  }
  const st = target === link ? lst : fs.lstatSync(target, { throwIfNoEntry: false });
  if (!st || !st.isFile() || (typeof process.getuid === "function" && hooks.statUid(st) !== process.getuid())) throw insecure(target);
  // safeReadFile bounds the size before buffering and opens O_NOFOLLOW, so a link swapped in after realpath is refused.
  const bytes = safeReadFile(target, SETTINGS_MAX_BYTES, {
    symlink: "settings_target_insecure", notFile: "settings_target_insecure", missing: "settings_target_insecure", tooLarge: "settings_too_large"
  });
  /** @type {unknown} */
  let obj;
  try {
    obj = JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new CliError("settings_invalid_json", "settings.json is not valid JSON; nothing was changed");
  }
  if (!isObject(obj)) throw new CliError("settings_invalid_json", "settings.json must be a JSON object; nothing was changed");
  return { target, exists: true, base: sha256hex(bytes), mode: st.mode & 0o777, obj };
}

/** @param {string} tool */
const inconclusive = (tool) => new CliError("settings_writer_check_failed", `could not check whether another program is using settings.json (${tool} failed); nothing was changed`);

const HELPERS = new Set(["daemon", "bg-pty-host", "bg-spare"]);
// ps prints a newline inside an argument as the escape `\012`; it separates arguments as a space would.
const ARG_SPLIT = /\s+|\\012/;
/** @param {string} w */
const chromeLaunchArg = (w) => w === "--chrome-native-host" || w.startsWith("chrome-extension://") || w.startsWith("--parent-window=");

/**
 * R-P6b: the Chrome native-messaging host. ps shows no argv boundaries, so a prompt may contain these words: only the
 * flag in first place, or arguments that are ALL Chrome launch arguments, identify the host. @param {string[]} rest
 */
const chromeHost = (rest) => rest[0] === "--chrome-native-host" || (rest.length > 0 && rest.every(chromeLaunchArg));

/**
 * Probe P6 (docs/probes/P6-2026-09-28.md), ruling R-P6: fail-safe, so overcounting only makes the refusal more
 * cautious. Only pure helpers are dropped; headless `-p`, stream-json children and `mcp serve` can write settings.
 * @param {string} args the full argv as ps prints it (an executable path may contain spaces)
 */
function isClaudeCode(args) {
  const exe = /(^|\/)claude( |$)/.exec(args);
  const m = exe ?? /\/claude-code\/cli\.js( |$)/.exec(args);
  if (!m) return args.includes("/claude-code/cli.js");
  const rest = args.slice(m.index + m[0].length).split(ARG_SPLIT).filter(Boolean);
  if (exe && HELPERS.has(rest[0] ?? "")) return false;
  return !chromeHost(rest);
}

/**
 * Claude Code processes, split into this CLI's own ancestry (`parent`: run from inside a session) and the others.
 * `pgrep -x claude` is not used: P6 showed it misses sessions whose process name is the version string.
 * Fail closed: a ps that cannot run, times out, fails, or prints no parseable table is inconclusive.
 * @returns {{ pids: number[], parent: boolean }}
 */
export function listClaudeProcesses() {
  const r = spawnSync("ps", ["-ww", "-Ao", "pid=,ppid=,args="], { encoding: "utf8", timeout: TOOL_TIMEOUT_MS, maxBuffer: 32 * MiB });
  if (r.error || r.status !== 0) throw inconclusive("ps");
  /** @type {Map<number, { ppid: number, args: string }>} */
  const procs = new Map();
  for (const line of r.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (!m) throw inconclusive("ps");
    procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] ?? "" });
  }
  if (procs.size === 0) throw inconclusive("ps");
  const ancestry = new Set();
  for (let pid = process.pid; pid > 1 && !ancestry.has(pid); pid = procs.get(pid)?.ppid ?? 0) ancestry.add(pid);
  /** @type {number[]} */
  const pids = [];
  let parent = false;
  for (const [pid, p] of procs) {
    if (!isClaudeCode(p.args)) continue;
    if (ancestry.has(pid)) parent = true;
    else pids.push(pid);
  }
  return { pids, parent };
}

/** @typedef {{ parent: boolean, running: boolean, names: string[] }} Writers */

/**
 * Fail closed: lsof 0 = holders listed, 1 with empty stdout = none. A spawn error (missing tool, timeout), any other
 * status, or lsof 1 WITH output is inconclusive → settings_writer_check_failed, and the commit does not happen.
 * @param {string} target @returns {Writers} process NAMES only — never paths or content
 */
export function probeWriters(target) {
  const { pids, parent } = listClaudeProcesses();
  const running = pids.length > 0;
  if (fs.lstatSync(target, { throwIfNoEntry: false }) === undefined) return { parent, running, names: [] };
  const ls = spawnSync("lsof", ["-F", "c", "--", target], { encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
  if (ls.error || !(ls.status === 0 || (ls.status === 1 && ls.stdout.trim() === ""))) throw inconclusive("lsof");
  return { parent, running, names: [...new Set(ls.stdout.split("\n").filter((l) => l.startsWith("c")).map((l) => l.slice(1)))] };
}

/** @param {Writers} w */
const active = (w) => w.parent || w.running || w.names.length > 0;
const parentProcess = () => new CliError("claude_parent_process", "run this in a separate terminal, not from inside Claude Code");

/** @param {Writers} w @returns {never} */
function refuseWriters(w) {
  if (w.parent) throw parentProcess();
  if (w.running) throw new CliError("claude_running", "quit all Claude Code sessions, then re-run");
  throw new CliError("settings_open_elsewhere", `close ${w.names.join(", ")} (it has settings.json open), then re-run`);
}

/**
 * No other settings writer may be active (spec §6.2 precondition).
 * @param {import("./io.mjs").IO} io @param {{ yes: boolean }} opts @param {string} target
 */
export async function writerPreconditions(io, opts, target) {
  if (process.env.CLAUDECODE === "1") throw parentProcess();
  for (;;) {
    const w = probeWriters(target);
    if (!active(w)) return;
    if (w.parent || !io.isTTY || opts.yes) refuseWriters(w);
    io.err(w.running
      ? "Quit all Claude Code sessions (they must restart to load the plugin anyway), and close any editor or sync tool with settings.json open.\n"
      : `Close ${w.names.join(", ")} — it has settings.json open.\n`);
    if (!(await io.ask("Done? Re-check now", true))) throw new CliError("cancelled", "cancelled");
  }
}

/** The full sha256 of a backup, or null when it can no longer be read bounded and unfollowed. @param {string} file */
function hashOf(file) {
  try {
    return sha256hex(safeReadFile(file, SETTINGS_MAX_BYTES));
  } catch {
    return null;
  }
}

/**
 * The spec §6.2 commit. `mutate` edits the parsed object in place and returns whether it changed anything.
 * @param {(obj: Record<string, unknown>) => boolean} mutate
 * @param {{ io: import("./io.mjs").IO, yes: boolean, preview?: boolean, confirm?: () => Promise<void> }} opts
 * @returns {Promise<{ changed: boolean, backup: string | null }>}
 */
export async function updateSettings(mutate, opts) {
  let target = readSettings().target;
  await writerPreconditions(opts.io, opts, target);
  cleanTemps(path.dirname(target));
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const cur = readSettings();
    target = cur.target;
    const obj = structuredClone(cur.obj);
    if (!mutate(obj)) return { changed: false, backup: null };
    if (opts.preview) opts.io.err(`review-loop will update: ${changedPaths(cur.obj, obj).join(", ")}\n`);
    // Asked once, only when something would change; a retry after a concurrent edit does not re-ask.
    if (opts.confirm && attempt === 1) await opts.confirm();
    const out = Buffer.from(JSON.stringify(obj, null, 2) + "\n");
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.settings.json.review-loop-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
    const fd = fs.openSync(tmp, "wx", cur.mode);
    try { fs.writeSync(fd, out); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, cur.mode);

    /** @type {string | null} */
    let backup = null;
    /** @type {string | null} */
    let bdir = null;
    try {
      // Both checks again immediately before the backup/commit: a writer that started while we prepared the
      // replacement refuses the commit (the catch removes our temp; settings.json is untouched).
      hooks.beforeRecheck();
      const late = probeWriters(target);
      if (active(late)) refuseWriters(late);
      if (cur.exists) {
        const base = /** @type {string} */ (cur.base);
        hooks.beforeLink();
        bdir = stateSubdir(BACKUP_SUBDIR);
        backup = path.join(bdir, `settings.json.${new Date().toISOString().replace(/[:.]/g, "-")}-${base.slice(0, 8)}`);
        let copied = false;
        try {
          hooks.link(target, backup);
        } catch (err) {
          if (!(err instanceof Error && "code" in err && err.code === "EXDEV")) throw err;
          fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(backup, 0o600);
          copied = true;
          opts.io.err("review-loop: settings.json is on another volume; its backup is a copy, so a late write through an already-open file would not be captured.\n");
        }
        hooks.beforeRehash();
        // The link sees an in-place write through the shared inode, but a replace-style write (temp + rename) swaps
        // the inode at target, so the link must also still BE the target. A copy sees neither: hash the target itself.
        const unchanged = copied ? hashOf(target) === base : hashOf(backup) === base && sameInode(target, backup);
        if (!unchanged) {
          // Only a name: the pre-image inode is still linked at target, or a foreign write has superseded it.
          fs.unlinkSync(backup);
          fs.rmSync(tmp, { force: true });
          continue;
        }
      } else {
        hooks.beforeRehash();
        if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) { fs.rmSync(tmp, { force: true }); continue; }
      }
      hooks.beforeRename();
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    hooks.afterRename();
    // The backup is the old inode: a writer holding a descriptor from before the rename writes there.
    if (backup && hashOf(backup) !== cur.base) {
      throw new CliError("settings_detached_write", `a program wrote to settings.json through an already-open file; its change is in ${backup} — compare it with settings.json and copy over anything you need`);
    }
    // A whole-file compare: a foreign write after our rename stands, and we redo ours on top of it.
    if (!out.equals(readBack(target))) continue;
    if (bdir) prune(bdir);
    return { changed: true, backup };
  }
  throw new CliError("settings_concurrent_write", "settings.json kept changing while review-loop wrote it; close other programs editing it, then re-run");
}

/** @param {string} a @param {string} b */
function sameInode(a, b) {
  const x = fs.lstatSync(a, { throwIfNoEntry: false });
  const y = fs.lstatSync(b, { throwIfNoEntry: false });
  return x !== undefined && y !== undefined && x.ino === y.ino && x.dev === y.dev;
}

/** @param {string} target @returns {Buffer} empty when unreadable, which never equals what we wrote */
function readBack(target) {
  try {
    return safeReadFile(target, SETTINGS_MAX_BYTES);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Top-level paths only, never values: env must not leak. @param {Record<string, unknown>} before @param {Record<string, unknown>} after */
function changedPaths(before, after) {
  return Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => `settings.${k}`);
}

/** Temps left by an interrupted run, as full paths. @param {string} dir */
function tempsIn(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => TEMP_RE.test(n)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** @param {string} dir */
function cleanTemps(dir) {
  for (const f of tempsIn(dir)) fs.rmSync(f, { force: true });
}

/** A backup whose content no longer hashes to the sha8 in its name holds a late write. @param {string} bdir @param {string} name */
const intact = (bdir, name) => hashOf(path.join(bdir, name))?.startsWith(name.slice(-8)) === true;

/** Keep our newest KEEP_BACKUPS; a modified backup is kept. @param {string} bdir */
function prune(bdir) {
  const names = fs.readdirSync(bdir).filter((n) => BACKUP_RE.test(n)).sort();
  const kept = names.filter((n) => intact(bdir, n));
  for (const n of kept.slice(0, Math.max(0, kept.length - KEEP_BACKUPS))) fs.rmSync(path.join(bdir, n));
}

/** Read-only (doctor): settings temps left beside the real settings file by an interrupted commit. */
export function leftoverTemps() {
  let target = settingsPath();
  try {
    target = readSettings().target;
  } catch {
    // Unreadable settings: the temps, if any, sit beside the path itself.
  }
  return tempsIn(path.dirname(target));
}

/**
 * Read-only (doctor): backups a late write landed in, as full paths. A linked (or non-directory) backup path is never
 * read through: it throws state_symlink_rejected, as `stateSubdir` would at the next write.
 */
export function modifiedBackups() {
  const bdir = path.join(stateRoot(), BACKUP_SUBDIR);
  const st = fs.lstatSync(bdir, { throwIfNoEntry: false });
  if (st === undefined) return [];
  if (!st.isDirectory()) throw new ReviewLoopError("state_symlink_rejected", `${bdir}: not a real directory; never read through`);
  return fs.readdirSync(bdir).filter((n) => BACKUP_RE.test(n) && !intact(bdir, n)).sort().map((n) => path.join(bdir, n));
}

/** The approval rules not yet in `permissions.ask`. @param {Record<string, unknown>} obj parsed settings */
export function missingAskRules(obj) {
  const perms = isObject(obj.permissions) ? obj.permissions : {};
  const ask = Array.isArray(perms.ask) ? perms.ask : [];
  return ASK_RULES.filter((r) => !ask.includes(r));
}

/** Every hook command in `settings.hooks`, "" for a hook without a string command; any shape is tolerated. @param {Record<string, unknown>} obj parsed settings */
export function hookCommands(obj) {
  const groups = isObject(obj.hooks) ? Object.values(obj.hooks).flatMap((g) => (Array.isArray(g) ? g : [])) : [];
  return groups
    .flatMap((g) => (isObject(g) && Array.isArray(g.hooks) ? g.hooks : []))
    .map((h) => (isObject(h) && typeof h.command === "string" ? h.command : ""));
}

/** Hook commands that run the legacy (pre-plugin) engine: with the plugin installed, a double gate. @param {Record<string, unknown>} obj parsed settings */
export function legacyHookCommands(obj) {
  return hookCommands(obj).filter((c) => LEGACY_HOOK_RE.test(c));
}
