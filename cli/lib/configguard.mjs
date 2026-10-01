import fs from "node:fs";
import { CliError } from "./errors.mjs";
import { configPath } from "../../plugin/engine/lib/config.mjs";

const defaults = { statUid: (/** @type {fs.Stats} */ st) => st.uid };
let hooks = { ...defaults };
/** Test-only owner check: a test cannot chown without root. */
export const ownerSeam = { set: (/** @type {Partial<typeof defaults>} */ h) => { hooks = { ...hooks, ...h }; }, reset: () => { hooks = { ...defaults }; } };

/** Refuses to read or replace a config another user owns. */
export function assertConfigOwner(who = "this command") {
  const st = fs.lstatSync(configPath(), { throwIfNoEntry: false });
  if (st && typeof process.getuid === "function" && hooks.statUid(st) !== process.getuid()) {
    throw new CliError("config_insecure", `${configPath()} is owned by another user; ${who} will not read or replace it`);
  }
}
