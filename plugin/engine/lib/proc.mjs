import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { ReviewLoopError } from "./errors.mjs";

/** Process groups of children not yet closed; reaped if this process is told to stop. */
const liveGroups = new Set();
/** @type {Set<() => void>} */
const reapHooks = new Set();
let reaperInstalled = false;
/** @type {"reap-and-reraise" | "reap-only"} */
let signalMode = "reap-and-reraise";

/**
 * "reap-and-reraise" (the engine's default): reap, then die of the signal. "reap-only" (the CLI): reap, then leave the
 * exit to the signal's other listener. The CLI's SIGINT handler exits 3 after draining, and a re-raised SIGINT would
 * kill the process first (exit 130). A signal nobody else listens for is still re-raised, so SIGTERM and SIGHUP still
 * stop the CLI.
 * @param {"reap-and-reraise" | "reap-only"} mode
 */
export function setSignalMode(mode) {
  signalMode = mode;
}

let spawnsClosed = false;

/**
 * Kills every live child group now and refuses any later spawn: for a caller that stops waiting on work it raced
 * against a deadline. The abandoned work's next command then fails at once instead of starting a child that would
 * keep this process alive.
 */
export function reapChildren() {
  spawnsClosed = true;
  for (const pid of liveGroups) killPgid(pid);
}

/**
 * Registers `fn` (synchronous) to run when a signal reaps this process, for what lives outside the child groups: a
 * detached Codex broker. Returns the unregister function.
 * @param {() => void} fn
 */
export function onReap(fn) {
  installReaper();
  reapHooks.add(fn);
  return () => {
    reapHooks.delete(fn);
  };
}

function installReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    // Prepended, so the other listeners are still registered when it counts them: a once-listener that ran first
    // would already be removed and read as none.
    process.prependOnceListener(sig, () => {
      for (const pid of liveGroups) killPgid(pid);
      for (const fn of reapHooks) {
        try {
          fn();
        } catch {
          // Best-effort: the process is stopping either way.
        }
      }
      if (signalMode === "reap-only" && process.listenerCount(sig) > 0) return;
      // A listener still registered would catch the re-raised signal and the process would live on.
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

/**
 * Each child leads its own process group, so a kill reaches descendants that inherited its pipes (the companion's
 * own children). A detached group no longer receives the terminal's or a task runner's signals, so this process
 * forwards SIGINT/SIGTERM/SIGHUP to every live group before it dies — otherwise stopping a round orphans Codex.
 * @param {string} cmd @param {string[]} args @param {import("node:child_process").SpawnOptions} options
 */
function spawnGroup(cmd, args, options) {
  if (spawnsClosed) throw new Error("spawns_closed");
  installReaper();
  const child = spawn(cmd, args, { ...options, shell: false, detached: true });
  const pid = child.pid;
  if (pid) {
    liveGroups.add(pid);
    child.once("close", () => liveGroups.delete(pid));
  }
  return child;
}

/** @param {number} pid */
function killPgid(pid) {
  // kill(-0) is this process's own group and kill(-1) every process the user owns.
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
}

/**
 * SIGKILL the child's whole group, then stop waiting on pipes: `close` waits for every holder, and a descendant
 * that left the group can keep them open indefinitely.
 * @param {import("node:child_process").ChildProcess} child
 */
function killGroup(child) {
  if (child.pid) killPgid(child.pid);
  const release = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  if (child.exitCode !== null || child.signalCode !== null) release();
  else child.once("exit", release);
}

/**
 * `onSpawn` runs synchronously once the child exists, before it can have done anything this process waits on: a
 * caller records the pid there (the child itself runs concurrently, so it is no proof the child has not started).
 * @typedef {{ cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, input?: string | Buffer, maxBuffer?: number, onSpawn?: (pid: number) => void }} RunOpts
 * @typedef {{ code: number | null, stdout: string, stderr: string, timedOut: boolean }} RunResult
 */

/**
 * spawn without a shell; output is bounded — exceeding maxBuffer kills the child.
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOpts} [opts]
 * @returns {Promise<RunResult>}
 */
export function run(cmd, args, opts = {}) {
  const { cwd, timeoutMs = 60_000, env = process.env, input, maxBuffer = 16 * 1024 * 1024, onSpawn } = opts;
  return new Promise((resolve, reject) => {
    const child = spawnGroup(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    if (onSpawn && child.pid) {
      try {
        onSpawn(child.pid);
      } catch (err) {
        child.stdin.destroy();
        killGroup(child);
        child.once("close", () => reject(err));
        return;
      }
    }
    /** @type {Buffer[]} */ const out = [];
    /** @type {Buffer[]} */ const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      outBytes += b.length;
      if (outBytes > maxBuffer) {
        overflow = true;
        killGroup(child);
        return;
      }
      out.push(b);
    });
    child.stderr.on("data", (b) => {
      errBytes += b.length;
      if (errBytes <= 1024 * 1024) err.push(b);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ReviewLoopError("spawn_failed", `${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow) {
        reject(new ReviewLoopError("output_too_large", `${cmd} ${args[0] ?? ""}: output exceeded ${maxBuffer} bytes`));
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Stream stdout straight into sha256 + a byte counter; nothing is buffered.
 * Kills the child the moment maxBytes is exceeded.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, maxBytes: number, timeoutMs?: number, tooLargeCode?: string }} opts
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
export function streamHash(cmd, args, opts) {
  const { cwd, maxBytes, timeoutMs = 120_000, tooLargeCode = "diff_too_large" } = opts;
  return new Promise((resolve, reject) => {
    const child = spawnGroup(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    let killedFor = /** @type {string | null} */ (null);
    let stderr = "";
    const timer = setTimeout(() => {
      killedFor = "timeout";
      killGroup(child);
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      if (killedFor) return;
      bytes += b.length;
      if (bytes > maxBytes) {
        killedFor = "size";
        killGroup(child);
        return;
      }
      hash.update(b);
    });
    child.stderr.on("data", (b) => {
      if (stderr.length < 4096) stderr += b.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ReviewLoopError("spawn_failed", `${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedFor === "size") return reject(new ReviewLoopError(tooLargeCode, `${cmd} ${args[0] ?? ""}: output exceeded ${maxBytes} bytes`));
      if (killedFor === "timeout") return reject(new ReviewLoopError("command_timeout", `${cmd} ${args[0] ?? ""}: timed out`));
      if (code !== 0) return reject(new ReviewLoopError("command_failed", `${cmd} ${args[0] ?? ""} exited ${code}: ${stderr.split("\n")[0]}`));
      resolve({ sha256: hash.digest("hex"), bytes });
    });
  });
}

/**
 * Stream stdout line by line to a visitor; the visitor returns true to stop early.
 * Enforces a line-count cap and a time cap — hitting either rejects with limitCode.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, maxLines: number, timeoutMs: number, limitCode: string, onLine: (line: string) => boolean }} opts
 * @returns {Promise<{ stoppedEarly: boolean, lines: number }>}
 */
export function streamLines(cmd, args, opts) {
  const { cwd, maxLines, timeoutMs, limitCode, onLine } = opts;
  return new Promise((resolve, reject) => {
    const child = spawnGroup(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let lines = 0;
    let rest = "";
    let done = /** @type {null | "early" | "limit" | "timeout"} */ (null);
    let stderr = "";
    const timer = setTimeout(() => {
      done = "timeout";
      killGroup(child);
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      if (done) return;
      rest += b.toString("utf8");
      let idx;
      while ((idx = rest.indexOf("\n")) !== -1) {
        const line = rest.slice(0, idx);
        rest = rest.slice(idx + 1);
        lines += 1;
        if (lines > maxLines) {
          done = "limit";
          killGroup(child);
          return;
        }
        if (onLine(line)) {
          done = "early";
          killGroup(child);
          return;
        }
      }
    });
    child.stderr.on("data", (b) => {
      if (stderr.length < 4096) stderr += b.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ReviewLoopError("spawn_failed", `${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (done === "early") return resolve({ stoppedEarly: true, lines });
      if (done === "limit") return reject(new ReviewLoopError(limitCode, `${cmd} ${args[0] ?? ""}: exceeded ${maxLines} lines`));
      if (done === "timeout") return reject(new ReviewLoopError(limitCode, `${cmd} ${args[0] ?? ""}: exceeded ${timeoutMs} ms`));
      if (code !== 0) return reject(new ReviewLoopError("command_failed", `${cmd} ${args[0] ?? ""} exited ${code}: ${stderr.split("\n")[0]}`));
      if (rest.length > 0 && onLine(rest)) return resolve({ stoppedEarly: true, lines: lines + 1 });
      resolve({ stoppedEarly: false, lines: rest.length > 0 ? lines + 1 : lines });
    });
  });
}
