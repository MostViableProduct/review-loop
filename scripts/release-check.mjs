#!/usr/bin/env node
// The release workflow's first gate: the tag equals every version bump-version.mjs stamps. Read-only.
import fs from "node:fs";

/** @param {string} f @returns {unknown} */
function json(f) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; }
}
/** @param {unknown} o @param {string} k @returns {unknown} */
const field = (o, k) => (typeof o === "object" && o !== null ? /** @type {Record<string, unknown>} */ (o)[k] : undefined);

/** @returns {unknown} */
function marketplaceVersion() {
  const plugins = field(json(".claude-plugin/marketplace.json"), "plugins");
  return Array.isArray(plugins) ? field(plugins.find((p) => field(p, "name") === "review-loop"), "version") : undefined;
}
/** @returns {unknown} */
function hookVersion() {
  try { return /^VERSION="([^"]*)"$/m.exec(fs.readFileSync("plugin/bin/hook", "utf8"))?.[1]; } catch { return undefined; }
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
  const want = argv[0] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(want) || argv.length > 1) {
    process.stderr.write("usage: release-check.mjs X.Y.Z (the tag without its leading v)\n");
    return 2;
  }
  /** @type {Record<string, unknown>} */
  const got = {
    "package.json": field(json("package.json"), "version"),
    "plugin/.claude-plugin/plugin.json": field(json("plugin/.claude-plugin/plugin.json"), "version"),
    ".claude-plugin/marketplace.json": marketplaceVersion(),
    "plugin/bin/hook": hookVersion()
  };
  const bad = Object.entries(got).filter(([, v]) => v !== want);
  // A value is printed only when it is a version-shaped string: a file is never echoed.
  for (const [f, v] of bad) process.stdout.write(`${f}: ${typeof v === "string" && /^[\w.+-]{1,40}$/.test(v) ? v : "missing"} (tag says ${want})\n`);
  if (!bad.length) process.stdout.write(`release-check: all four versions are ${want}\n`);
  return bad.length ? 1 : 0;
}

// Not process.exit(): on macOS a stdout pipe is asynchronous, and an immediate exit truncates what was written.
process.exitCode = main(process.argv.slice(2));
