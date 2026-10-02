import fs from "node:fs";
import { CliError } from "./errors.mjs";
import { assertConfigDir, configPath } from "../../plugin/engine/lib/config.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";

const defaults = { statUid: (/** @type {fs.Stats} */ st) => st.uid };
let hooks = { ...defaults };
/** Test-only owner check: a test cannot chown without root. */
export const ownerSeam = { set: (/** @type {Partial<typeof defaults>} */ h) => { hooks = { ...hooks, ...h }; }, reset: () => { hooks = { ...defaults }; } };

/** Refuses to read, replace or remove the config through a folder link another user owns, before anything changes. */
export function assertConfigDirTrusted(who = "this command") {
  try {
    assertConfigDir();
  } catch (err) {
    if (err instanceof ReviewLoopError) throw new CliError(err.code, `${err.message}; ${who} changed nothing`);
    throw err;
  }
}

/** Refuses to read or replace a config another user owns, or one reached through a link another user owns. */
export function assertConfigOwner(who = "this command") {
  assertConfigDirTrusted(who);
  const st = fs.lstatSync(configPath(), { throwIfNoEntry: false });
  if (st && typeof process.getuid === "function" && hooks.statUid(st) !== process.getuid()) {
    throw new CliError("config_insecure", `${configPath()} is owned by another user; ${who} will not read or replace it`);
  }
}
