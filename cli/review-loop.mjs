#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { realIO } from "./lib/io.mjs";
import { CliError } from "./lib/errors.mjs";
import { withCliLock } from "./lib/lock.mjs";
import { buildEvent, writeEvent, PACKAGE_VERSION } from "../plugin/engine/lib/events.mjs";
import { exitFor, remedyFor, CODES, CLI_EXIT } from "../plugin/engine/lib/codes.mjs";
import { setSignalMode } from "../plugin/engine/lib/proc.mjs";
import { PRESET_NAMES } from "../plugin/engine/lib/presets.mjs";

const MIN_NODE = 22;
const SEAMS = process.env.REVIEW_LOOP_TEST_SEAMS === "1";

/** @typedef {{ code: string, detail?: string | null, json?: unknown, message?: string }} Result */
/** @typedef {{ json: boolean, yes: boolean, started: number }} Ctx */

/** @typedef {{ name: string, value?: string, about: string }} Option */
const JSON_OPT = { name: "--json", about: "print one line of JSON on stdout instead of text" };
const YES_OPT = { name: "--yes", about: "answer every question with its default, for scripts" };
// Test-only flags (REVIEW_LOOP_TEST_SEAMS=1); never accepted otherwise.
const SEAM_FLAGS = ["--inject-internal-error", "--inject-missing-module", "--skip-doctor-gate", "--force-engine-move"];

/**
 * Commands are loaded lazily so `--version` and `doctor` don't pay for setup's imports. `options` is the whole list a
 * command accepts: main() refuses any other flag before loading the command, and prints them for `<command> --help`.
 * `operands` is how many leading plain words the command takes (config's sub-command, key and value).
 */
export const COMMANDS = {
  setup: {
    help: "Guided install and configuration. --yes also runs one billed Codex review without asking; --skip-live-check avoids it",
    usage: ["setup [options]"],
    about: "Checks Claude Code, the Codex CLI, your Codex sign-in, the Codex plugin and gh, and shows the fix for anything missing. It asks before each change, then runs one real Codex review (billed to your account) to prove everything works. Run it in a normal terminal with Claude Code closed. Safe to re-run.",
    options: /** @type {Option[]} */ ([
      { name: "--preset", value: "<name>", about: `how strictly to stop Claude: ${PRESET_NAMES.join(", ")}` },
      { name: "--model", value: "<name>", about: "the Codex model for reviews (default: Codex's own default)" },
      { name: "--effort", value: "<level>", about: "recorded and shown; not sent to Codex" },
      { name: "--skip-live-check", about: "skip the billed review at the end" },
      { name: "--yes", about: "no questions; also runs the billed review unless --skip-live-check is given" },
      JSON_OPT
    ]),
    operands: 0,
    example: "review-loop setup",
    mutates: /** @type {boolean | ((a: string[]) => boolean)} */ (true),
    load: () => import("./lib/setup.mjs")
  },
  config: {
    help: "Show or change settings: config show | config set <preset|model|effort|rubric|events.path> <value> | config repair",
    usage: ["config show", "config set <key> <value>", "config repair"],
    about: "Shows or changes review-loop's settings. Keys: preset, model, effort, rubric, events.path. The value `inherit` or `default` puts a key back to its default. `repair` replaces an unreadable settings file with the defaults and keeps the old one beside it.",
    options: [JSON_OPT],
    operands: 3,
    example: "review-loop config set preset balanced",
    mutates: (/** @type {string[]} */ a) => a[0] !== undefined && a[0] !== "show",
    load: () => import("./lib/configcmd.mjs")
  },
  doctor: {
    help: "Diagnose the install (read-only). --live also runs a paid Codex check",
    usage: ["doctor [options]"],
    about: "Checks the install and changes nothing. Each problem it finds comes with the command that fixes it.",
    options: [{ name: "--live", about: "also run one real Codex review, billed to your account" }, JSON_OPT],
    operands: 0,
    example: "review-loop doctor",
    mutates: false,
    load: () => import("./lib/doctor.mjs")
  },
  update: {
    help: "Update the plugin after `brew upgrade`",
    usage: ["update [options]"],
    about: "Updates the review-loop plugin in Claude Code to the latest version, then runs doctor. Run it after `brew upgrade review-loop`.",
    options: [JSON_OPT],
    operands: 0,
    example: "review-loop update",
    mutates: true,
    load: () => import("./lib/update.mjs")
  },
  uninstall: {
    help: "Remove the plugin and our settings entries",
    usage: ["uninstall [options]"],
    about: "Removes the review-loop plugin from Claude Code, its approval rules and its settings, and asks whether to keep your review history (kept by default). Run it before `brew uninstall review-loop`.",
    options: [
      { name: "--keep-history", about: "keep the review history without asking" },
      { name: "--delete-history", about: "delete the review history without asking" },
      YES_OPT,
      JSON_OPT
    ],
    operands: 0,
    example: "review-loop uninstall",
    mutates: true,
    load: () => import("./lib/uninstall.mjs")
  },
  migrate: {
    help: "Move a legacy ~/.claude/review-loop install onto the plugin (--rollback undoes it)",
    usage: ["migrate [options]"],
    about: "Moves a review loop installed by hand in ~/.claude/review-loop onto the plugin, keeping a backup of everything it changes. --rollback undoes it.",
    options: [{ name: "--rollback", about: "undo the last migration from its backup" }, YES_OPT, JSON_OPT],
    operands: 0,
    example: "review-loop migrate",
    mutates: true,
    load: () => import("./lib/migrate.mjs")
  },
  selftest: {
    help: "Offline smoke test of the bundled engine",
    usage: ["selftest [options]"],
    about: "Runs the installed review engine against a throwaway repo, offline, and never touches your Claude Code or Codex settings. `brew test` runs it.",
    options: [JSON_OPT],
    operands: 0,
    example: "review-loop selftest",
    mutates: false,
    load: () => import("./lib/selftest.mjs")
  },
  "engine-path": {
    help: "Print the installed plugin's engine directory",
    usage: ["engine-path [options]"],
    about: "Prints the folder where the plugin's review engine is installed, for running its tools by hand.",
    options: [JSON_OPT],
    operands: 0,
    example: "node \"$(review-loop engine-path)/review-round.mjs\" status",
    mutates: false,
    load: () => import("./lib/enginepath.mjs")
  }
};

/**
 * Why `rest` (the words after the command) is not a valid call, or null: a flag the command doesn't take, an option
 * missing its value, or more plain words than it takes. --json and --yes are already removed; main() handles them.
 * @param {string} name @param {(typeof COMMANDS)[keyof typeof COMMANDS]} cmd @param {string[]} rest @returns {string | null}
 */
export function badUsage(name, cmd, rest) {
  // config's operands come first and may start with "-" (a model name can); config checks them itself.
  const words = rest.slice(cmd.operands);
  const takes = cmd.options.map((o) => o.name).join(", ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (SEAMS && SEAM_FLAGS.includes(w)) continue;
    const opt = cmd.options.find((o) => o.name === w);
    if (opt === undefined) return w.startsWith("-") ? `${name} doesn't take ${w.slice(0, 40)} (it takes ${takes})` : `${name} takes no other words (got ${w.slice(0, 40)})`;
    if (opt.value === undefined) continue;
    const v = words[i + 1];
    if (v === undefined || v.startsWith("--")) return `${w} needs a value: ${w} ${opt.value}`;
    i++;
  }
  return null;
}

/** Breaks prose at spaces so no line passes `width`; a longer word stays whole. @param {string} text @param {number} width */
function wrap(text, width) {
  const lines = [""];
  for (const word of text.split(" ")) {
    const last = lines.length - 1;
    if (lines[last] === "") lines[last] = word;
    else if (`${lines[last]} ${word}`.length <= width) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines.join("\n");
}

/** @param {(typeof COMMANDS)[keyof typeof COMMANDS]} cmd */
export function commandHelp(cmd) {
  const width = Math.max(...cmd.options.map((o) => `${o.name}${o.value ? ` ${o.value}` : ""}`.length));
  const opts = cmd.options.map((o) => `  ${`${o.name}${o.value ? ` ${o.value}` : ""}`.padEnd(width)}  ${o.about}`).join("\n");
  return `Usage: ${cmd.usage.map((u) => `review-loop ${u}`).join("\n       ")}\n\n${wrap(cmd.about, 100)}\n\nOptions:\n${opts}\n\nExample:\n  ${cmd.example}\n`;
}

/** @param {string[]} argv @param {import("./lib/io.mjs").IO} io @returns {Promise<number>} */
export async function main(argv, io) {
  const started = Date.now();
  const json = argv.includes("--json");
  const yes = argv.includes("--yes");
  const args = argv.filter((a) => a !== "--json" && a !== "--yes");
  const name = args[0] === "--version" || args[0] === "-v" ? "version" : args[0] === "--help" || args[0] === "-h" || args.length === 0 ? "help" : args[0];
  // The reaper still kills running tools on Ctrl-C, but must not re-raise SIGINT: that would kill this process (130)
  // before onSigint's drained exit 3.
  setSignalMode("reap-only");
  let sigint = false;
  const onSigint = () => {
    sigint = true;
    try { finish({ code: "cancelled" }); } finally { exitAfterDrain(CLI_EXIT.cancelled); }
  };
  process.once("SIGINT", onSigint);
  /** The exit code of the cli.exit already written, if any: one event per run. */
  let written = /** @type {number | null} */ (null);

  /** @param {Result} r */
  function finish(r) {
    // After SIGINT the command may still settle before the drained exit; its cli.exit was already written.
    if (written !== null) return written;
    const code = Object.hasOwn(CODES, r.code) ? r.code : "unexpected_error";
    const exit = exitFor(code);
    const cmd = Object.hasOwn(COMMANDS, name) || name === "version" || name === "help" ? name : "help";
    // Print the very object that was appended, never a re-read of the shared log: a hook or another CLI may append
    // in between, and a failed write must still yield the full event on stdout.
    const ev = buildEvent({ source: "cli", event: "cli.exit", code, detail: r.detail ?? null, exit_code: exit, data: { command: cmd, duration_ms: Date.now() - started } });
    writeEvent(ev);
    written = exit;
    if (json) {
      io.out(JSON.stringify(r.json !== undefined ? { ...(/** @type {object} */ (r.json)), event: ev } : ev) + "\n");
    } else if (exit !== 0) {
      if (r.message) io.err(`review-loop: ${r.message}\n`);
      io.err(`review-loop: ${code}${r.detail ? ` (${r.detail})` : ""} — ${remedyFor(code, r.detail ?? null)}\n`);
    }
    return exit;
  }

  try {
    if (Number(process.versions.node.split(".")[0]) < MIN_NODE) return finish({ code: "node_too_old" });
    // stdout, so `$(review-loop --version)` captures it; under --json stdout is the event alone.
    if (name === "version") { if (!json) io.out(`review-loop ${PACKAGE_VERSION}\n`); return finish({ code: "ok" }); }
    if (name === "help") { if (json) io.err(helpText()); else io.out(helpText()); return finish({ code: "ok" }); }
    if (!Object.hasOwn(COMMANDS, name)) return finish({ code: "usage_unknown_command", message: `unknown command: ${name.slice(0, 40)}` });
    const cmd = COMMANDS[/** @type {keyof typeof COMMANDS} */ (name)];
    // Before anything loads or locks: `<command> --help` must never run the command.
    if (args.includes("--help") || args.includes("-h")) {
      if (json) io.err(commandHelp(cmd)); else io.out(commandHelp(cmd));
      return finish({ code: "ok" });
    }
    const bad = badUsage(name, cmd, args.slice(1));
    if (bad !== null) return finish({ code: "usage_bad_flag", message: bad });
    if (SEAMS && argv.includes("--inject-internal-error")) throw new Error("injected");
    // T-OBS-2 pins the module_not_found path on a module that can never exist, not on a command not yet written.
    const mod = SEAMS && argv.includes("--inject-missing-module") ? await import(new URL("./lib/__seam_missing__.mjs", import.meta.url).href) : await cmd.load();
    const mutates = typeof cmd.mutates === "function" ? cmd.mutates(args.slice(1)) : cmd.mutates;
    /** @type {Ctx} */
    const ctx = { json, yes, started };
    const run = () => mod.run(args.slice(1), io, ctx);
    /** @type {Result} */
    const result = mutates ? await withCliLock(run) : await run();
    return finish(result);
  } catch (err) {
    if (sigint) return CLI_EXIT.cancelled;
    if (err instanceof CliError) return finish({ code: err.code, detail: err.detail, message: err.message });
    if (err instanceof Error && "code" in err && typeof err.code === "string" && Object.hasOwn(CODES, err.code)) return finish({ code: err.code, message: err.message });
    return finish({ code: "unexpected_error", detail: classifyThrown(err), message: "unexpected error" });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/** Bounds the SIGINT exit when a reader stops draining a pipe. */
const EXIT_DRAIN_MS = 2000;

/**
 * Never a bare process.exit(): on macOS a stdout/stderr pipe is asynchronous, and exiting at once truncates what was
 * written (a piped `doctor --json` lost everything after 512 or 1024 bytes). Normal exits set process.exitCode and let
 * Node drain; only SIGINT, which must stop a command mid-flight, exits early, and only after both streams flush.
 * @param {number} code
 */
function exitAfterDrain(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), EXIT_DRAIN_MS);
  let pending = 2;
  const flushed = () => { if (--pending === 0) process.exit(code); };
  process.stdout.write("", flushed);
  process.stderr.write("", flushed);
}

/** Only the error class is logged, never its message, stack or path. @param {unknown} err */
function classifyThrown(err) {
  if (!(err instanceof Error)) return "other";
  if ("code" in err && err.code === "ERR_MODULE_NOT_FOUND") return "module_not_found";
  if ("errno" in err || "syscall" in err) return "SystemError";
  return ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError"].includes(err.name) ? err.name : "other";
}

function helpText() {
  return `review-loop ${PACKAGE_VERSION}\n\n${Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(12)} ${c.help}`).join("\n")}\n\nRun \`review-loop <command> --help\` for a command's options.\nExit codes: 0 ok · 1 needs your action · 2 usage · 3 cancelled · 4 internal\n`;
}

// Compared by realpath so a symlinked dir (macOS /var) or a symlinked bin (`review-loop` -> review-loop.mjs) still runs.
const isMain = (() => { try { return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  main(process.argv.slice(2), realIO()).then((code) => { process.exitCode = code; });
}
