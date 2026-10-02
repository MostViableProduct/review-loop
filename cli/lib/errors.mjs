export class CliError extends Error {
  /** @param {string} code @param {string} message @param {string | null} [detail] */
  constructor(code, message, detail = null) { super(message); this.name = "CliError"; this.code = code; this.detail = detail; }
}
