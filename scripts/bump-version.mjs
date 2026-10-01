#!/usr/bin/env node
// Stamps one version into the four places release-check compares (docs/RELEASE.md step 1).
import fs from "node:fs";
import path from "node:path";

/** @typedef {{ rel: string, abs: string, mode: number }} Target */

/** A refusal: printed on stderr, exit 1. Thrown, not process.exit(), so what was already written drains. */
class Refusal extends Error {}

/** @param {string} msg @returns {never} */
function fail(msg) {
  throw new Refusal(msg);
}

/**
 * The working tree is untrusted: each target must be a regular, non-link file whose real path stays inside the repo.
 * @param {string} root @param {string} rel @returns {Target}
 */
function checked(root, rel) {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isFile() || st.size > 1024 * 1024 || !fs.realpathSync(abs).startsWith(root + path.sep)) fail(`refusing ${rel} (must be a regular file inside the repo, not a link)`);
  return { rel, abs, mode: st.mode & 0o777 };
}

/** @param {Target} t @returns {Record<string, unknown>} */
function readJson(t) {
  try {
    const o = /** @type {unknown} */ (JSON.parse(fs.readFileSync(t.abs, "utf8")));
    if (typeof o === "object" && o !== null && !Array.isArray(o)) return /** @type {Record<string, unknown>} */ (o);
  } catch { /* reported below, with the file name and no content */ }
  return fail(`${t.rel} is not a JSON object`);
}

/** @param {Record<string, unknown>} o */
const jsonText = (o) => `${JSON.stringify(o, null, 2)}\n`;

/** @param {string} v */
function stamp(v) {
  const root = fs.realpathSync(process.cwd());
  // Every target is checked, and every new text computed, before the first write: a refusal leaves the tree unchanged.
  const [pkg, plugin, market, hook] = ["package.json", "plugin/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "plugin/bin/hook"].map((rel) => checked(root, rel));

  const pkgObj = readJson(pkg);
  pkgObj.version = v;
  const pluginObj = readJson(plugin);
  pluginObj.version = v;
  const marketObj = readJson(market);
  const entry = Array.isArray(marketObj.plugins)
    ? /** @type {unknown[]} */ (marketObj.plugins).find((p) => typeof p === "object" && p !== null && /** @type {Record<string, unknown>} */ (p).name === "review-loop")
    : undefined;
  if (typeof entry !== "object" || entry === null) fail(".claude-plugin/marketplace.json has no review-loop entry");
  /** @type {Record<string, unknown>} */ (entry).version = v;
  const hookText = fs.readFileSync(hook.abs, "utf8");
  if (!/^VERSION="[^"]*"$/m.test(hookText)) fail("plugin/bin/hook has no VERSION line");

  /** @type {Array<[Target, string]>} */
  const writes = [
    [pkg, jsonText(pkgObj)],
    [plugin, jsonText(pluginObj)],
    [market, jsonText(marketObj)],
    [hook, hookText.replace(/^VERSION="[^"]*"$/m, `VERSION="${v}"`)]
  ];

  // Temp-then-rename in the same directory, recreated with the original mode: the hook shim stays executable.
  for (const [t, text] of writes) {
    const tmp = `${t.abs}.bump-${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: t.mode, flag: "wx" });
    fs.chmodSync(tmp, t.mode);
    fs.renameSync(tmp, t.abs);
  }
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
  const v = argv[0] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(v) || argv.length > 1) {
    process.stderr.write("usage: bump-version.mjs X.Y.Z\n");
    return 2;
  }
  try {
    stamp(v);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    process.stderr.write(`bump-version: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`version ${v} stamped in 4 files\n`);
  return 0;
}

// Not process.exit(): on macOS a stdout pipe is asynchronous, and an immediate exit truncates what was written.
process.exitCode = main(process.argv.slice(2));
