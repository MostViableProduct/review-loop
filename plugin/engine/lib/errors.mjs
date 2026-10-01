// Every failure carries a stable, greppable code; messages name paths and reasons, never file contents.
export class ReviewLoopError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReviewLoopError";
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} err */
export function errorCode(err) {
  return err instanceof ReviewLoopError ? err.code : "unexpected_error";
}

/**
 * The registered code a catch site logs. A raw I/O failure is mapped by errno to the registered code that names its
 * remedy; the errno itself is unbounded and never logged.
 * @param {unknown} err
 */
export function diagnosticCode(err) {
  if (err instanceof ReviewLoopError) return err.code;
  const errno = typeof err === "object" && err !== null && "code" in err ? err.code : null;
  if (errno === "EACCES" || errno === "EPERM") return "state_dir_insecure";
  if (errno === "ELOOP") return "state_symlink_rejected";
  return "unexpected_error";
}
