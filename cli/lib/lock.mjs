import { acquireLock } from "../../plugin/engine/lib/state.mjs";
import { ReviewLoopError } from "../../plugin/engine/lib/errors.mjs";
import { CliError } from "./errors.mjs";

// A reserved key in the engine's lock namespace. assertKey accepts 24 hex chars; artifact keys are sha-derived, so they don't collide with it.
export const CLI_LOCK_KEY = "00000000000000000000c11c";

const INSECURE = new Set(["state_dir_insecure", "state_symlink_rejected"]);

/**
 * One mutating review-loop command at a time: two setups racing would interleave settings and config writes.
 * Reuses the engine's lock: it publishes a fully written file by link() (no empty-file window) and reclaims a stale
 * lock by compare-and-swap. Only ACQUISITION errors are mapped (busy → cli_busy, permission/symlink → state_dir_insecure);
 * an error from `fn` propagates and is never retried.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function withCliLock(fn) {
  let lock;
  try {
    lock = acquireLock(CLI_LOCK_KEY, "cli");
  } catch (err) {
    if (err instanceof ReviewLoopError && err.code === "busy") throw new CliError("cli_busy", "another review-loop command is running");
    const errno = typeof err === "object" && err !== null && "code" in err ? err.code : null;
    if (errno === "EACCES" || errno === "EPERM" || (err instanceof ReviewLoopError && INSECURE.has(err.code))) {
      throw new CliError("state_dir_insecure", "the review-loop state directory is not usable by you");
    }
    throw err;
  }
  try { return await fn(); } finally { lock.release(); }
}
