// `review-loop migrate` and `migrate --rollback` (spec §14): a legacy ~/.claude/review-loop install onto the plugin,
// with a manifest that makes every step undoable.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CliError } from "./errors.mjs";
import { assertConfigOwner } from "./configguard.mjs";
import { run as doctor } from "./doctor.mjs";
import { installPlugin, installedPlugin, MARKETPLACE_SOURCE, PLUGIN_ID, removeMarketplace, uninstallPlugin } from "./plugin.mjs";
import { ASK_RULES, LEGACY_HOOK_RE, legacyHookCommands, missingAskRules, readSettings, updateSettings, writerPreconditions } from "./settings.mjs";
import { CONFIG_MAX_BYTES, configPath, isConfig, readConfig, writeConfig } from "../../plugin/engine/lib/config.mjs";
import { atomicWriteJson, atomicWriteText, isObject, jsonText, MiB, quarantine, safeReadFile, sha256hex } from "../../plugin/engine/lib/fsutil.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";
import { claudeConfigDir, stateRoot } from "../../plugin/engine/lib/paths.mjs";
import { isPin, pinFile } from "../../plugin/engine/lib/pin.mjs";

const SEAMS = process.env.REVIEW_LOOP_TEST_SEAMS === "1";
const SEAM_FLAGS = ["--skip-doctor-gate", "--force-engine-move"];
const OLD_REF = "~/.claude/review-loop/CLAUDE.md";
// Replaced as a unit, backticks included: swapping only the inner path would nest backticks.
const OLD_TOKEN = `\`${OLD_REF}\``;
const HAND_REF = "the `review-loop` plugin (`review-loop doctor`)";
// Any config dir, exact legacy form: only used to name a mismatched dir in a message, never to accept a hook.
const LEGACY_SHAPE_RE = /^node (\/[^\s;&|`$()<>'"\\]+)\/review-loop\/review-gate-hook\.mjs (?:pr|session|track|stop|prompt)$/;
const SOURCE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MANIFEST_MAX_BYTES = MiB;
const CLAUDE_MD_MAX_BYTES = MiB;
const PIN_MAX_BYTES = 64 * 1024;
const MAX_STEPS = 64;
// plugin, settings, pin, config, skill, claude_md, engine_dir: the most one run records.
const STEPS_PER_RUN = 7;
const MAX_REMOVED_GROUPS = 32;
const COMMAND_MAX = 200;
/** @type {Record<string, string>} each resource's one action, exactly as `record` writes it */
const ACTIONS = { settings: "swap_hooks", plugin: "install", skill: "move", pin: "move", config: "set_rubric", claude_md: "edit", engine_dir: "move" };
const LEGACY_MODES = ["pr", "session", "track", "stop", "prompt"];
const HOOK_KEYS = ["type", "command", "timeout"];
const GROUP_KEYS = ["matcher", "hooks"];
// PascalCase only: `constructor` or `__proto__` would reach Object.prototype through `hooks[event]`.
const EVENT_RE = /^[A-Z][A-Za-z]{1,31}$/;

/**
 * @typedef {{ event: string, index: number, group: unknown }} RemovedHook
 * @typedef {{ resource: string, action: string, before: Record<string, unknown>, after: Record<string, unknown>, removedHooks?: RemovedHook[], addedAsk?: string[], undone?: boolean }} Step
 * @typedef {{ v: 1, status: "in_progress" | "done" | "rolled_back", date: string, steps: Step[] }} Manifest
 */

const manifestPath = () => path.join(stateRoot(), "migration.json");
/**
 * Exactly the commands the legacy installer wrote, at THIS user's Claude config dir. A restored hook can only be one of
 * these five, so an edited manifest can neither inject a command nor point one at another path; migrate removes only
 * groups made of these, so everything it removes is restorable.
 */
const legacyCommands = (/** @type {string} */ dir) => LEGACY_MODES.map((mode) => `node ${path.join(dir, "review-loop", "review-gate-hook.mjs")} ${mode}`);
/** The user's local calendar date: the archive name must match the day they see. */
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Well-formed markdown for the CLAUDE.md pointer, or null while the marketplace owner is still a placeholder. */
function newReference() {
  const source = SEAMS && process.env.REVIEW_LOOP_TEST_MARKETPLACE_SOURCE ? process.env.REVIEW_LOOP_TEST_MARKETPLACE_SOURCE : MARKETPLACE_SOURCE;
  return SOURCE_RE.test(source) ? `the \`review-loop\` plugin (\`review-loop doctor\`; https://github.com/${source})` : null;
}
const present = (/** @type {string} */ p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const claudeMdBackup = (/** @type {string} */ ts) => path.join(claudeConfigDir(), `CLAUDE.md.review-loop-backup-${ts}`);

/** Every path migrate and rollback touch: derived from the Claude config dir, the state root and the validated date — never read from the manifest. @param {string} date */
function paths(date) {
  const c = claudeConfigDir();
  const archive = path.join(c, `review-loop-legacy-${date}`);
  return {
    claude: c, archive,
    engine: path.join(c, "review-loop"), engineArchived: path.join(archive, "engine"),
    skill: path.join(c, "skills", "review-loop"), skillArchived: path.join(archive, "skill"),
    legacyPin: path.join(c, "review-loop", "plugin-pin.json"), pin: pinFile(),
    claudeMd: path.join(c, "CLAUDE.md"), rubric: path.join(c, "rules", "multi-dimension-review.md")
  };
}

/** Bounded and never through a link; null when unreadable. @param {string} file @param {number} max */
function readText(file, max) {
  try { return safeReadFile(file, max).toString("utf8"); } catch { return null; }
}

/** null when absent; "unreadable" (never equal to a sha) for a link, an oversized file or an I/O error. @param {string} file @param {number} max */
function shaOf(file, max) {
  if (!present(file)) return null;
  const text = readText(file, max);
  return text === null ? "unreadable" : sha256hex(text);
}

/**
 * Temp-then-rename in the file's own directory, keeping its mode: a link swapped in meanwhile is replaced, not
 * followed. Not atomicWriteText: that tightens its `within` dir to 0700, and the Claude config dir is not ours.
 * @param {string} file @param {string} text @param {number} mode
 */
function replaceInPlace(file, text, mode) {
  const tmp = `${file}.review-loop-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode, flag: "wx" });
  try { fs.renameSync(tmp, file); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}

/** @param {unknown} v */
const isSha = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
/** @param {Record<string, unknown>} o @param {string[]} keys */
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));

/** @param {unknown} h @param {string} dir the Claude config dir the command must name */
const isLegacyHook = (h, dir) => isObject(h) && onlyKeys(h, HOOK_KEYS) && h.type === "command" && typeof h.command === "string" &&
  legacyCommands(dir).includes(h.command) && (h.timeout === undefined || (Number.isInteger(h.timeout) && Number(h.timeout) > 0 && Number(h.timeout) <= 3600));

/** @param {unknown} g @param {string} dir */
const isLegacyGroup = (g, dir) => isObject(g) && onlyKeys(g, GROUP_KEYS) && (g.matcher === undefined || (typeof g.matcher === "string" && g.matcher.length <= 256)) &&
  Array.isArray(g.hooks) && g.hooks.length > 0 && g.hooks.length <= 8 && g.hooks.every((h) => isLegacyHook(h, dir));

/** One predicate for what migrate may remove and what rollback may restore. @param {unknown} r @param {string} dir @returns {r is RemovedHook} */
function isRemovedHook(r, dir) {
  if (!isObject(r) || typeof r.event !== "string" || !EVENT_RE.test(r.event)) return false;
  if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0 || r.index >= 256) return false;
  return isLegacyGroup(r.group, dir);
}

/**
 * R-D29: the legacy hook groups to remove. A group is removed only when every hook in it is an exact legacy command;
 * any other group that runs the legacy engine refuses the whole migration before anything is written, because
 * rollback could not restore it.
 * @param {Record<string, unknown>} obj parsed settings @returns {RemovedHook[]}
 */
function legacyGroups(obj) {
  /** @type {RemovedHook[]} */
  const out = [];
  if (!isObject(obj.hooks)) return out;
  for (const [event, groups] of Object.entries(obj.hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      const hooks = isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
      const commands = hooks.map((h) => (isObject(h) && typeof h.command === "string" ? h.command : ""));
      const legacy = commands.find((c) => LEGACY_HOOK_RE.test(c));
      if (legacy === undefined) return;
      const r = { event, index, group };
      if (isRemovedHook(r, claudeConfigDir())) { out.push(r); return; }
      if (commands.some((c) => !LEGACY_HOOK_RE.test(c))) {
        throw new CliError("settings_mixed_hook_group", `a ${event.slice(0, 32)} hook group in settings.json runs the old review-loop hook together with other hooks, so it can't be removed on its own; nothing was changed`);
      }
      const shown = legacy.length > COMMAND_MAX ? `${legacy.slice(0, COMMAND_MAX - 1)}…` : legacy;
      throw new CliError("settings_legacy_hook_unrecognized", `a ${event.slice(0, 32)} hook in settings.json is not exactly the legacy installer's \`node ${path.join(claudeConfigDir(), "review-loop", "review-gate-hook.mjs")} <mode>\`, so rollback could not restore it: ${shown}; nothing was changed`);
    });
  }
  if (out.length > MAX_REMOVED_GROUPS) throw new CliError("settings_legacy_hook_unrecognized", `settings.json has ${out.length} review-loop hook groups, more than the ${MAX_REMOVED_GROUPS} a legacy install writes; nothing was changed`);
  return out;
}

/** @param {unknown} s untrusted until this returns true @param {string} dir @returns {s is Step} */
function isStep(s, dir) {
  if (!isObject(s) || typeof s.resource !== "string" || !Object.hasOwn(ACTIONS, s.resource) || s.action !== ACTIONS[s.resource]) return false;
  if (s.undone !== undefined && typeof s.undone !== "boolean") return false;
  const { before, after } = s;
  if (!isObject(before) || !isObject(after)) return false;
  if (s.resource === "settings") {
    const { removedHooks, addedAsk } = s;
    return Array.isArray(removedHooks) && removedHooks.length <= MAX_REMOVED_GROUPS && removedHooks.every((r) => isRemovedHook(r, dir)) &&
      Array.isArray(addedAsk) && addedAsk.length <= ASK_RULES.length && addedAsk.every((a) => typeof a === "string" && ASK_RULES.includes(a));
  }
  if (s.resource === "config") {
    if (after.sha !== undefined && !isSha(after.sha)) return false;
    if (before.absent === true) return true;
    const bytes = before.bytes;
    if (typeof bytes !== "string" || bytes.length > CONFIG_MAX_BYTES || !isSha(before.sha) || sha256hex(bytes) !== before.sha) return false;
    try { return isConfig(JSON.parse(bytes)); } catch { return false; }
  }
  if (s.resource === "claude_md") return isSha(before.sha) && isSha(after.sha) && typeof before.backupTs === "string" && /^\d{10,16}$/.test(before.backupTs);
  if (s.resource === "pin") return isSha(before.sha);
  // Rollback uninstalls on this step, so it must be exactly what `record` wrote.
  if (s.resource === "plugin") return before.absent === true && Object.keys(before).length === 1 && Object.keys(after).length === 0;
  // skill, engine_dir: rollback derives their paths and reads none from the manifest; a recorded path is informational.
  const pathOnly = (/** @type {Record<string, unknown>} */ o) => Object.keys(o).every((k) => k === "path") && (o.path === undefined || (typeof o.path === "string" && o.path.length <= 4096));
  return pathOnly(before) && pathOnly(after);
}

/** @param {unknown} m @param {string} [dir] the Claude config dir restored hooks must name: the CURRENT one at rollback @returns {m is Manifest} */
function isManifest(m, dir = claudeConfigDir()) {
  return isObject(m) && m.v === 1 && typeof m.status === "string" && ["in_progress", "done", "rolled_back"].includes(m.status) &&
    typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date) && Array.isArray(m.steps) && m.steps.length <= MAX_STEPS && m.steps.every((s) => isStep(s, dir));
}

/** Absent → null. Anything else that is not a valid manifest is quarantined and refused, never acted on. @returns {Manifest | null} */
function readManifest() {
  const f = manifestPath();
  const unreadable = () => new CliError("migration_manifest_unreadable", "could not read the migration record; nothing was changed");
  const refuse = () => {
    quarantine(f, stateRoot());
    return new CliError("migration_manifest_invalid", "the migration record is damaged; it was set aside and nothing was changed");
  };
  let st;
  try {
    st = fs.lstatSync(f);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw unreadable();
  }
  if (st.isSymbolicLink()) throw refuse();
  // Permissions are not corruption: an unreadable record is left in place for the user to fix, never quarantined.
  try { fs.accessSync(f, fs.constants.R_OK); } catch { throw unreadable(); }
  // safeReadFile re-checks on the descriptor it reads (O_NOFOLLOW open, fstat type and size, bounded read, refusal if
  // it grows), so a link or a huge file swapped in after the checks above is never followed or buffered.
  let text;
  try {
    text = safeReadFile(f, MANIFEST_MAX_BYTES, { symlink: "migration_manifest_invalid", linkedParent: "migration_manifest_invalid", notFile: "migration_manifest_invalid", tooLarge: "migration_manifest_invalid", missing: "migration_manifest_unreadable" }, { within: stateRoot() }).toString("utf8");
  } catch (err) {
    if (err instanceof ReviewLoopError && err.code === "migration_manifest_invalid") throw refuse();
    throw unreadable();
  }
  /** @type {unknown} */
  let m;
  try { m = JSON.parse(text); } catch { throw refuse(); }
  if (!isManifest(m)) {
    const dir = recordedConfigDir(m);
    if (dir !== null) throw new CliError("migration_config_dir_mismatch", `this record was made with the Claude config dir ${dir}; re-run with CLAUDE_CONFIG_DIR=${dir}. The record was left in place and nothing was changed`);
    throw refuse();
  }
  return m;
}

/**
 * A record that would be valid in every respect if the Claude config dir were one other dir: that dir, else null.
 * It only turns "damaged, quarantined" into "wrong env, kept"; rollback itself still restores only hooks naming the
 * CURRENT config dir. The dir must be the one dir every recorded hook names, and a real directory this user owns, so
 * an edited record can't point the user at an arbitrary path.
 * @param {unknown} m
 */
function recordedConfigDir(m) {
  if (!isObject(m) || !Array.isArray(m.steps)) return null;
  const dirs = new Set();
  for (const s of m.steps) {
    for (const r of isObject(s) && Array.isArray(s.removedHooks) ? s.removedHooks : []) {
      for (const h of isObject(r) && isObject(r.group) && Array.isArray(r.group.hooks) ? r.group.hooks : []) {
        const hit = isObject(h) && typeof h.command === "string" ? LEGACY_SHAPE_RE.exec(h.command) : null;
        dirs.add(hit ? hit[1] : null);
      }
    }
  }
  if (dirs.size !== 1) return null;
  const [dir] = dirs;
  if (typeof dir !== "string" || /[\u0000-\u001f\u007f]/.test(dir) || path.resolve(dir) !== dir || dir === path.resolve(claudeConfigDir())) return null;
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) return null;
  return isManifest(m, dir) ? dir : null;
}

/** @param {Manifest} m */
const saveManifest = (m) => atomicWriteJson(manifestPath(), m, stateRoot());

/** The legacy pin is untrusted: no link, bounded, structurally a pin, and byte-exact as text. @param {string} file @param {string} within */
function readLegacyPin(file, within) {
  const codes = { symlink: "legacy_pin_invalid", linkedParent: "legacy_pin_invalid", notFile: "legacy_pin_invalid", tooLarge: "legacy_pin_invalid", missing: "legacy_pin_invalid" };
  try {
    const bytes = safeReadFile(file, PIN_MAX_BYTES, codes, { within });
    const text = bytes.toString("utf8");
    return isPin(JSON.parse(text)) && Buffer.from(text, "utf8").equals(bytes) ? text : null;
  } catch {
    return null;
  }
}

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
export async function run(args, io, ctx) {
  const allowed = ["--rollback", ...(SEAMS ? SEAM_FLAGS : [])];
  const bad = args.find((a) => !allowed.includes(a));
  if (bad !== undefined) throw new CliError("usage_bad_flag", `migrate takes only --rollback and --yes (got ${bad.slice(0, 40)})`);
  if (!io.isTTY && !ctx.yes) throw new CliError("usage_noninteractive", "migrate needs a terminal, or --yes");
  return args.includes("--rollback") ? rollback(io, ctx) : migrate(args, io, ctx);
}

/** @param {string[]} args @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
async function migrate(args, io, ctx) {
  const today = localDate();
  const cur = readSettings();
  const found = paths(today);
  if (legacyHookCommands(cur.obj).length === 0 && !present(found.skill) && !present(found.legacyPin) && !present(found.engine)) {
    io.err("Nothing to migrate.\n");
    return { code: "ok" };
  }
  // Every refusal that can be known up front happens before anything changes.
  legacyGroups(cur.obj);
  await writerPreconditions(io, { yes: ctx.yes }, cur.target);
  assertConfigOwner("migrate");
  // A record left by an interrupted or doctor-gated run is continued, never overwritten: its steps are undo data.
  const prior = readManifest();
  /** @type {Manifest} */
  const m = prior && prior.status !== "rolled_back" ? { ...prior, status: "in_progress" } : { v: 1, status: "in_progress", date: today, steps: [] };
  const P = paths(m.date);
  const full = () => new CliError("migration_record_full", `the migration record already has ${m.steps.length} steps, and this run could add ${STEPS_PER_RUN} more past the ${MAX_STEPS}-step limit; nothing was changed`);
  if (m.steps.length + STEPS_PER_RUN > MAX_STEPS) throw full();
  // A folder already sitting where this run would archive another is refused now, not as a failed rename mid-run.
  for (const [from, to] of [[P.skill, P.skillArchived], [P.engine, P.engineArchived]]) {
    if (present(from) && present(to)) throw new CliError("migration_archive_occupied", `${to} already holds a folder from an earlier migration, so ${from} can't be archived there; nothing was changed`);
  }
  /** Each step's entry is persisted BEFORE its mutation. @param {Step} s */
  const record = (s) => {
    if (m.steps.length >= MAX_STEPS) throw full();
    m.steps.push(s);
    saveManifest(m);
  };

  // Plugin first: if it fails, the old gate stays in force and settings are untouched.
  const had = await installedPlugin(PLUGIN_ID);
  if (!had || !had.enabled) {
    if (!had) record({ resource: "plugin", action: "install", before: { absent: true }, after: {} });
    await installPlugin();
    const now = await installedPlugin(PLUGIN_ID);
    if (!now || !now.enabled) throw new CliError("plugin_install_failed", "the review-loop plugin is not listed as enabled after install; the old hooks were left in place");
  }

  // One settings write: remove the legacy hook groups and ensure the approval rules. `claude plugin install` may have
  // written settings.json, so this reads it afresh.
  const now = readSettings().obj;
  if (legacyGroups(now).length > 0 || missingAskRules(now).length > 0) {
    /** @type {Step} */
    const step = { resource: "settings", action: "swap_hooks", before: {}, after: {}, removedHooks: [], addedAsk: [] };
    record(step);
    await updateSettings((o) => {
      const removed = legacyGroups(o);
      const missing = missingAskRules(o);
      step.removedHooks = removed;
      step.addedAsk = [...missing];
      if (removed.length > 0) {
        const hooks = /** @type {Record<string, unknown[]>} */ (o.hooks);
        const drop = new Set(removed.map((r) => `${r.event}\u0000${r.index}`));
        for (const event of new Set(removed.map((r) => r.event))) hooks[event] = hooks[event].filter((_, i) => !drop.has(`${event}\u0000${i}`));
      }
      if (missing.length > 0) {
        const perms = /** @type {Record<string, unknown>} */ (o.permissions ??= {});
        const ask = /** @type {string[]} */ (Array.isArray(perms.ask) ? perms.ask : (perms.ask = []));
        ask.push(...missing);
      }
      // Persisted before updateSettings commits, so a crash after its rename still leaves rollback what was removed.
      saveManifest(m);
      return removed.length > 0 || missing.length > 0;
    }, { io, yes: ctx.yes, preview: true });
  }

  // The Codex-plugin pin moves into the state dir. A link, an oversized or a malformed pin is left where it is (setup
  // re-pins), never followed or copied.
  if (present(P.legacyPin) && !present(P.pin)) {
    const text = readLegacyPin(P.legacyPin, P.claude);
    if (text === null) {
      io.err(`The old Codex-plugin pin (${P.legacyPin}) is not a regular, valid pin file, so it was left in place and not migrated. \`review-loop setup\` will pin the Codex plugin again.\n`);
    } else {
      const sha = sha256hex(text);
      record({ resource: "pin", action: "move", before: { sha }, after: {} });
      atomicWriteText(P.pin, text, path.dirname(P.pin));
      if (shaOf(P.pin, PIN_MAX_BYTES) !== sha) throw new CliError("legacy_pin_invalid", "the copied Codex-plugin pin did not verify; the old pin was left in place");
      fs.rmSync(P.legacyPin);
    }
  }

  // The author's rubric. The config's before-bytes are the undo data, persisted before the write.
  if (fs.lstatSync(P.rubric, { throwIfNoEntry: false })?.isFile()) {
    const read = readConfig();
    const beforeText = read.status === "ok" ? readText(configPath(), CONFIG_MAX_BYTES) : null;
    if (read.status === "invalid" && read.code === "config_symlink_rejected") {
      io.err(`The review-loop config (${configPath()}) is a symlink, which review-loop never follows, so rubricPath was not set. Replace it with a regular file, then run \`review-loop config set rubric ${P.rubric}\`.\n`);
    } else if (read.status === "invalid" || (read.status === "ok" && beforeText === null)) {
      io.err(`The review-loop config (${configPath()}) is invalid, so rubricPath was not set. Run \`review-loop config repair\`, then \`review-loop config set rubric ${P.rubric}\`.\n`);
    } else if (read.config.rubricPath !== P.rubric) {
      const next = { ...read.config, rubricPath: P.rubric };
      // The after-sha is known before the write, so a crash right after it still leaves rollback able to restore.
      record({ resource: "config", action: "set_rubric", before: beforeText === null ? { absent: true } : { sha: sha256hex(beforeText), bytes: beforeText }, after: { sha: sha256hex(jsonText(next)) } });
      writeConfig(next);
    }
  }

  // The skill leaves ~/.claude/skills entirely: a renamed folder there would still load.
  if (present(P.skill)) {
    record({ resource: "skill", action: "move", before: { path: P.skill }, after: { path: P.skillArchived } });
    fs.mkdirSync(P.archive, { recursive: true, mode: 0o700 });
    fs.renameSync(P.skill, P.skillArchived);
  }

  // The user's global CLAUDE.md: only on yes (`--yes` counts), never through a link.
  const mdSt = fs.lstatSync(P.claudeMd, { throwIfNoEntry: false });
  const newRef = newReference();
  const notEdited = (/** @type {string} */ why) => io.err(`\n${P.claudeMd} was not edited: ${why}\n`);
  if (mdSt?.isSymbolicLink()) {
    io.err(`\n${P.claudeMd} is a symlink, so review-loop won't edit it. To update it yourself, replace:\n- ${OLD_TOKEN}\n+ ${newRef ?? HAND_REF}\n`);
  } else if (mdSt?.isFile() && mdSt.size > CLAUDE_MD_MAX_BYTES) {
    notEdited(`it is over 1 MiB, larger than review-loop will read. If it mentions ${OLD_TOKEN}, point that at the review-loop plugin yourself.`);
  } else if (mdSt?.isFile()) {
    const before = readText(P.claudeMd, CLAUDE_MD_MAX_BYTES);
    if (before === null) notEdited("review-loop could not read it (it changed while being read, or is not readable).");
    else if (before.includes(OLD_TOKEN) && newRef === null) {
      notEdited(`this build has no real repository address yet (the marketplace owner is still a placeholder). To update it yourself, replace:\n- ${OLD_TOKEN}\n+ ${HAND_REF}`);
    } else if (before.includes(OLD_TOKEN) && newRef !== null) {
      io.err(`\nProposed change to ${P.claudeMd} (the original is kept beside it):\n- ${OLD_TOKEN}\n+ ${newRef}\n`);
      if (ctx.yes || (await io.ask("Apply this change?", false))) {
        const after = before.replaceAll(OLD_TOKEN, newRef);
        const backupTs = String(Date.now());
        record({ resource: "claude_md", action: "edit", before: { sha: sha256hex(before), backupTs }, after: { sha: sha256hex(after) } });
        fs.writeFileSync(claudeMdBackup(backupTs), before, { mode: 0o600, flag: "wx" });
        replaceInPlace(P.claudeMd, after, mdSt.mode & 0o777);
      }
    }
  }

  // The legacy engine is the fallback while anything is wrong, so it moves only once doctor passes.
  const gate = args.includes("--force-engine-move") ? "ok" : args.includes("--skip-doctor-gate") ? "skipped" : (await doctor([], io, { json: false })).code;
  if (gate !== "ok" && gate !== "skipped") {
    // The record stays in_progress: the engine step is pending, and the next `migrate` continues this record.
    saveManifest(m);
    throw new CliError("doctor_failed", `doctor found problems (above), so the migration is not finished: the legacy engine folder ${P.engine} was left in place. Fix them, then re-run \`review-loop migrate\` to finish (or \`review-loop migrate --rollback\` to undo)`);
  }
  if (gate === "ok" && present(P.engine)) {
    record({ resource: "engine_dir", action: "move", before: { path: P.engine }, after: { path: P.engineArchived } });
    fs.mkdirSync(P.archive, { recursive: true, mode: 0o700 });
    fs.renameSync(P.engine, P.engineArchived);
  }
  m.status = "done";
  saveManifest(m);
  io.err("\nMigrated. Restart Claude Code sessions to load the plugin.\nTo undo: review-loop migrate --rollback\nVerify with a live round: review-loop doctor --live\n");
  return { code: "ok" };
}

/** @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx */
async function rollback(io, ctx) {
  const m = readManifest();
  if (!m || m.status === "rolled_back") { io.err("Nothing to roll back.\n"); return { code: "ok" }; }
  // The settings write's preconditions, checked before anything moves: a refusal there must change nothing.
  await writerPreconditions(io, { yes: ctx.yes }, readSettings().target);
  const P = paths(m.date);
  /** @type {string[]} */
  const skipped = [];
  for (const s of [...m.steps].reverse()) {
    if (s.undone === true) continue;
    const before = skipped.length;
    if (s.resource === "engine_dir") moveBack(P.engineArchived, P.engine, "legacy engine folder", skipped);
    if (s.resource === "claude_md") undoClaudeMd(s, P.claudeMd, skipped);
    if (s.resource === "skill") moveBack(P.skillArchived, P.skill, "legacy skill", skipped);
    if (s.resource === "config") undoConfig(s, skipped);
    if (s.resource === "pin") undoPin(s, P.pin, P.legacyPin, io, skipped);
    if (s.resource === "settings") await undoSettings(s, io, ctx);
    if (s.resource === "plugin" && s.before.absent === true) {
      await uninstallPlugin();
      await removeMarketplace();
    }
    // Each step is marked as it completes; a skipped one stays pending, so a retry resumes there and never replays
    // a step that already ran (a second uninstall, a re-added hook).
    if (skipped.length === before) {
      s.undone = true;
      saveManifest(m);
    }
  }
  if (skipped.length) throw new CliError("rollback_skipped_modified", `changed after migration, left as-is: ${skipped.join(", ")}; clear them and run review-loop migrate --rollback again to finish`);
  m.status = "rolled_back";
  saveManifest(m);
  io.err("Rolled back. Restart Claude Code sessions to load the old hooks.\n");
  return { code: "ok" };
}

/**
 * Only the pin migrate moved goes back; a pin re-written since (setup, repin) stays where it is. A half-done move (copied,
 * original not yet removed) drops the copy only when both files hash to the recorded pin.
 * @param {Step} s @param {string} pin @param {string} legacyPin @param {import("./io.mjs").IO} io @param {string[]} skipped
 */
function undoPin(s, pin, legacyPin, io, skipped) {
  if (!present(pin)) return;
  const copied = shaOf(pin, PIN_MAX_BYTES) === s.before.sha;
  if (!copied) { skipped.push("pin (changed after migration)"); return; }
  if (present(legacyPin)) {
    if (shaOf(legacyPin, PIN_MAX_BYTES) !== s.before.sha) { skipped.push(`pin (${legacyPin} differs from the one migrated)`); return; }
    fs.rmSync(pin);
    io.err(`Removed the copied pin ${pin}; the original is still at ${legacyPin}.\n`);
    return;
  }
  fs.mkdirSync(path.dirname(legacyPin), { recursive: true });
  fs.renameSync(pin, legacyPin);
}

/** Idempotent: nothing archived is nothing to do; something already back in place is never overwritten. @param {string} from @param {string} to @param {string} what @param {string[]} skipped */
function moveBack(from, to, what, skipped) {
  if (!present(from)) return;
  if (present(to)) { skipped.push(`${what} (${to} exists again; the archived copy stays in ${from})`); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

/** Restored only from a backup that hashes to the recorded original, and only over the exact text migrate wrote. @param {Step} s @param {string} md @param {string[]} skipped */
function undoClaudeMd(s, md, skipped) {
  const cur = fs.lstatSync(md, { throwIfNoEntry: false });
  const sha = cur?.isFile() ? shaOf(md, CLAUDE_MD_MAX_BYTES) : "unreadable";
  if (sha === s.before.sha) return;
  if (sha !== s.after.sha || !cur) { skipped.push("CLAUDE.md (changed after migration)"); return; }
  const original = readText(claudeMdBackup(String(s.before.backupTs)), CLAUDE_MD_MAX_BYTES);
  if (original === null || sha256hex(original) !== s.before.sha) { skipped.push("CLAUDE.md (its backup is missing or changed)"); return; }
  replaceInPlace(md, original, cur.mode & 0o777);
}

/** @param {Step} s @param {string[]} skipped */
function undoConfig(s, skipped) {
  const sha = shaOf(configPath(), CONFIG_MAX_BYTES);
  if (s.before.absent === true ? sha === null : sha === s.before.sha) return;
  if (!isSha(s.after.sha) || sha !== s.after.sha) { skipped.push("config (rubricPath)"); return; }
  if (s.before.absent === true) fs.rmSync(configPath(), { force: true });
  else atomicWriteText(configPath(), String(s.before.bytes), path.dirname(configPath()));
}

/**
 * Re-inserts the removed legacy groups by read-modify-write, never by restoring the whole file, so changes made since
 * migrating survive. Ascending original index puts each group back at its original position among the survivors.
 * @param {Step} s @param {import("./io.mjs").IO} io @param {{ yes: boolean }} ctx
 */
async function undoSettings(s, io, ctx) {
  const removed = [...(s.removedHooks ?? [])].sort((a, b) => a.index - b.index);
  const added = s.addedAsk ?? [];
  await updateSettings((o) => {
    let changed = false;
    if (removed.length > 0) {
      const hooks = /** @type {Record<string, unknown>} */ (o.hooks ??= {});
      if (!isObject(hooks)) throw new CliError("settings_invalid_json", "settings.json `hooks` is not an object; nothing was changed");
      for (const r of removed) {
        if (!Object.hasOwn(hooks, r.event)) hooks[r.event] = [];
        const list = hooks[r.event];
        if (!Array.isArray(list)) throw new CliError("settings_invalid_json", `settings.json \`hooks.${r.event}\` is not a list; nothing was changed`);
        const g = JSON.stringify(r.group);
        if (!list.some((x) => JSON.stringify(x) === g)) { list.splice(Math.min(r.index, list.length), 0, r.group); changed = true; }
      }
    }
    const perms = o.permissions;
    if (added.length > 0 && isObject(perms) && Array.isArray(perms.ask)) {
      const keep = perms.ask.filter((x) => !added.includes(x));
      if (keep.length !== perms.ask.length) { perms.ask = keep; changed = true; }
    }
    return changed;
  }, { io, yes: ctx.yes, preview: true });
}
