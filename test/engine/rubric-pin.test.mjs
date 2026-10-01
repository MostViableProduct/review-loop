import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { loadRubricSection, resolveRubricPath } from "../../plugin/engine/lib/rubric.mjs";
import { pinFile, pluginBase } from "../../plugin/engine/lib/pin.mjs";

function isolate() {
  const home = tmpDir();
  Object.assign(process.env, { HOME: home, REVIEW_LOOP_STATE_DIR: path.join(home, "state"), REVIEW_LOOP_CONFIG: path.join(home, "cfg.json") });
  delete process.env.REVIEW_LOOP_PIN_FILE;
  delete process.env.REVIEW_LOOP_PLUGIN_BASE;
  delete process.env.CLAUDE_CONFIG_DIR;
  return home;
}

const cacheDefault = (/** @type {string} */ root) => path.join(root, "plugins", "cache", "openai-codex", "codex");

/** @param {string} dir @param {unknown} content */
function writeRegistry(dir, content) {
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  const file = path.join(dir, "plugins", "installed_plugins.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

const registryFor = (/** @type {string} */ installPath) => ({ version: 2, plugins: { "codex@openai-codex": [{ scope: "user", installPath, version: "1.0.9" }] } });

test("default rubric resolves inside the plugin and names all 11 dimensions", () => {
  isolate();
  assert.match(resolveRubricPath(), /plugin[\\/]rubric[\\/]default\.md$/);
  assert.match(loadRubricSection(), /\*\*Usability\*\*/);
});

test("T-MIG-3: config.rubricPath overrides; a symlink is rejected", () => {
  const home = isolate();
  const mine = path.join(home, "mine.md");
  fs.copyFileSync(resolveRubricPath(), mine);
  fs.appendFileSync(mine, "\nPERSONAL-MARKER\n");
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: mine, events: { path: null } }));
  assert.equal(resolveRubricPath(), mine);
  const link = path.join(home, "link.md");
  fs.symlinkSync(mine, link);
  fs.writeFileSync(process.env.REVIEW_LOOP_CONFIG, JSON.stringify({ version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: link, events: { path: null } }));
  assert.throws(() => loadRubricSection(), { code: "rubric_symlink_rejected" });
});

test("pin lives in the state dir; pluginBase follows installed_plugins.json", () => {
  const home = isolate();
  assert.equal(pinFile(), path.join(home, "state", "plugin-pin.json"));
  const install = path.join(home, "custom", "codex", "1.0.9");
  fs.mkdirSync(install, { recursive: true });
  writeRegistry(path.join(home, ".claude"), registryFor(install));
  assert.equal(pluginBase(), path.dirname(install));
});

test("REVIEW_LOOP_PLUGIN_BASE takes precedence over the registry", () => {
  const home = isolate();
  const install = path.join(home, "custom", "codex", "1.0.9");
  fs.mkdirSync(install, { recursive: true });
  writeRegistry(path.join(home, ".claude"), registryFor(install));
  process.env.REVIEW_LOOP_PLUGIN_BASE = "/explicit/base";
  assert.equal(pluginBase(), "/explicit/base");
});

test("R-D8a: pluginBase honors CLAUDE_CONFIG_DIR for the registry and the cache default", () => {
  const home = isolate();
  const cfg = path.join(home, "alt-claude");
  assert.equal(pluginBase(), cacheDefault(path.join(home, ".claude")));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  assert.equal(pluginBase(), cacheDefault(cfg));
  const install = path.join(home, "elsewhere", "codex", "1.0.9");
  fs.mkdirSync(install, { recursive: true });
  writeRegistry(cfg, registryFor(install));
  assert.equal(pluginBase(), path.dirname(install));
  delete process.env.CLAUDE_CONFIG_DIR;
});

test("installed_plugins.json is untrusted: malformed, symlinked, relative and missing-dir entries fall back", () => {
  const home = isolate();
  const claude = path.join(home, ".claude");
  const fallback = cacheDefault(claude);

  writeRegistry(claude, "{not json");
  assert.equal(pluginBase(), fallback, "malformed");

  writeRegistry(claude, { plugins: { "codex@openai-codex": "nope" } });
  assert.equal(pluginBase(), fallback, "wrong shape");

  const install = path.join(home, "custom", "codex", "1.0.9");
  fs.mkdirSync(install, { recursive: true });
  const real = path.join(home, "real-registry.json");
  fs.writeFileSync(real, JSON.stringify(registryFor(install)));
  const file = path.join(claude, "plugins", "installed_plugins.json");
  fs.rmSync(file);
  fs.symlinkSync(real, file);
  assert.equal(pluginBase(), fallback, "symlinked registry");
  fs.rmSync(file);

  writeRegistry(claude, registryFor("custom/codex/1.0.9"));
  assert.equal(pluginBase(), fallback, "relative installPath");

  writeRegistry(claude, registryFor(path.join(home, "does-not-exist", "1.0.9")));
  assert.equal(pluginBase(), fallback, "installPath is not an existing directory");

  const plain = path.join(home, "a-file");
  fs.writeFileSync(plain, "x");
  writeRegistry(claude, registryFor(plain));
  assert.equal(pluginBase(), fallback, "installPath is a file");

  const linkDir = path.join(home, "link-dir");
  fs.symlinkSync(install, linkDir);
  writeRegistry(claude, registryFor(linkDir));
  assert.equal(pluginBase(), fallback, "installPath is a symlink");

  writeRegistry(claude, " ".repeat(2 * 1024 * 1024));
  assert.equal(pluginBase(), fallback, "oversized registry");

  writeRegistry(claude, registryFor(install));
  assert.equal(pluginBase(), path.dirname(install), "sanity: the valid registry is honoured");
});
