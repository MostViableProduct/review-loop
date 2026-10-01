// The state root lives here so events.mjs can use it without importing state.mjs.
import os from "node:os";
import path from "node:path";
import { ensurePrivateDir } from "./fsutil.mjs";

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function stateRoot() {
  return process.env.REVIEW_LOOP_STATE_DIR || path.join(os.homedir(), ".claude", "state", "review-loop");
}

/**
 * A state subdirectory (created 0700 when missing), verified to be a real directory: a link there would carry a
 * listing, a recursive prune or a scratch workspace outside the state tree.
 * @param {string} name
 */
export function stateSubdir(name) {
  const dir = path.join(stateRoot(), name);
  ensurePrivateDir(dir, stateRoot());
  return dir;
}
