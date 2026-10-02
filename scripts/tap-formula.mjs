#!/usr/bin/env node
// The release workflow's tap formula: homebrew-tap/Formula/review-loop.rb with this release's archive url and sha256
// filled in, printed to stdout. The tap holds no formula before the first release, and the template's all-zero
// sha256 can never install, so a formula leaves here only naming a real archive. Read-only.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const TEMPLATE = "homebrew-tap/Formula/review-loop.rb";
const URL_LINE = /^ {2}url ".*"$/m;
const SHA_LINE = /^ {2}sha256 ".*"$/m;

/**
 * @param {string} template @param {string} version X.Y.Z @param {string} sha256 the archive's, 64 lowercase hex
 * @returns {{ ok: true, formula: string } | { ok: false, reason: string }}
 */
export function tapFormula(template, version, sha256) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { ok: false, reason: "the version is not X.Y.Z" };
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { ok: false, reason: "the sha256 is not 64 lowercase hex digits" };
  if (/^0{64}$/.test(sha256)) return { ok: false, reason: "the sha256 is the all-zero placeholder" };
  const count = (/** @type {RegExp} */ re) => template.match(new RegExp(re.source, "gm"))?.length ?? 0;
  if (count(URL_LINE) !== 1 || count(SHA_LINE) !== 1) return { ok: false, reason: "the template needs exactly one url line and one sha256 line" };
  const url = `https://github.com/MostViableProduct/review-loop/releases/download/v${version}/review-loop-${version}.tar.gz`;
  return { ok: true, formula: template.replace(URL_LINE, `  url "${url}"`).replace(SHA_LINE, `  sha256 "${sha256}"`) };
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
  if (argv.length !== 2) {
    process.stderr.write("usage: tap-formula.mjs X.Y.Z <sha256>\n");
    return 2;
  }
  let template;
  try {
    template = fs.readFileSync(TEMPLATE, "utf8");
  } catch {
    process.stderr.write(`tap-formula: cannot read ${TEMPLATE}\n`);
    return 1;
  }
  const r = tapFormula(template, argv[0], argv[1]);
  if (!r.ok) {
    process.stderr.write(`tap-formula: refusing: ${r.reason}\n`);
    return 1;
  }
  process.stdout.write(r.formula);
  return 0;
}

// Imported by its test; run as a script by the release workflow.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Not process.exit(): on macOS a stdout pipe is asynchronous, and an immediate exit truncates what was written.
  process.exitCode = main(process.argv.slice(2));
}
