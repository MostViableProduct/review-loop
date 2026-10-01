// The one way tests signal a process they started. A pid that is not a real child pid (undefined after a failed spawn,
// 0, 1, NaN, a negative number) is never signalled: kill(0) or kill(-0) hits this test runner's whole process group
// (npm test dies silently), and kill(-1) hits every process the user owns.

/** @param {unknown} pid @returns {pid is number} */
export const isRealPid = (pid) => Number.isInteger(pid) && /** @type {number} */ (pid) > 1;

/**
 * Sends `sig` to `pid` (or, with `group`, to its process group). Never throws.
 * @param {unknown} pid @param {NodeJS.Signals | 0} sig @param {{ group?: boolean }} [opts]
 * @returns {boolean} true when the signal was delivered
 */
export function signalPid(pid, sig, opts = {}) {
  if (!isRealPid(pid)) return false;
  try {
    process.kill(opts.group ? -pid : pid, sig);
    return true;
  } catch {
    return false;
  }
}
