import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "./helpers.mjs";
import { configPath, readConfig, writeConfig, defaultConfig, isConfig, EFFORTS } from "../../plugin/engine/lib/config.mjs";

/** @template T @param {Record<string, string | undefined>} vars @param {() => T} fn @returns {T} */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("configPath: REVIEW_LOOP_CONFIG > absolute XDG_CONFIG_HOME > ~/.config (T-CFG-8)", () => {
  const home = tmpDir();
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    assert.equal(configPath(), path.join(home, ".config", "review-loop", "config.json"));
  });
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: path.join(home, "xdg") }, () => {
    assert.equal(configPath(), path.join(home, "xdg", "review-loop", "config.json"));
  });
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: "relative/xdg" }, () => {
    assert.equal(configPath(), path.join(home, ".config", "review-loop", "config.json"), "a relative XDG is ignored");
  });
  withEnv({ REVIEW_LOOP_CONFIG: "/tmp/x.json" }, () => assert.equal(configPath(), "/tmp/x.json"));
});

test("readConfig: absent → default, no file created", () => {
  const home = tmpDir();
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    const r = readConfig();
    assert.equal(r.status, "absent");
    assert.deepEqual(r.config, defaultConfig());
    assert.equal(fs.existsSync(path.join(home, ".config")), false);
  });
});

test("readConfig: corrupt, symlinked, oversized → invalid + Default, file untouched (T-CFG-3)", () => {
  const home = tmpDir();
  const file = path.join(home, "cfg", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withEnv({ REVIEW_LOOP_CONFIG: file }, () => {
    fs.writeFileSync(file, "{not json");
    let r = readConfig();
    assert.deepEqual([r.status, r.status === "invalid" && r.code, r.config.preset], ["invalid", "config_invalid", "default"]);
    assert.equal(fs.readFileSync(file, "utf8"), "{not json", "never quarantined by a reader");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"], "no rename or sibling created");
    fs.writeFileSync(file, JSON.stringify({ ...defaultConfig(), preset: "yolo" }));
    r = readConfig();
    assert.equal(r.status === "invalid" && r.code, "config_invalid");
    fs.writeFileSync(file, "x".repeat(70 * 1024));
    r = readConfig();
    assert.equal(r.status === "invalid" && r.code, "config_invalid");
    fs.rmSync(file);
    const real = path.join(home, "real.json");
    fs.writeFileSync(real, JSON.stringify(defaultConfig()));
    fs.symlinkSync(real, file);
    r = readConfig();
    assert.equal(r.status === "invalid" && r.code, "config_symlink_rejected");
  });
});

test("writeConfig: 0600 file, 0700 dir, never chmods the parent (~/.config)", () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, ".config"), { mode: 0o755 });
  fs.chmodSync(path.join(home, ".config"), 0o755);
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    writeConfig({ ...defaultConfig(), preset: "balanced" });
    const f = configPath();
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(home, ".config")).mode & 0o777, 0o755);
    assert.equal(readConfig().config.preset, "balanced");
  });
});

test("writeConfig: refuses an invalid config and writes nothing", () => {
  const home = tmpDir();
  withEnv({ HOME: home, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    assert.throws(() => writeConfig({ ...defaultConfig(), preset: "yolo" }), { code: "config_invalid" });
    assert.equal(fs.existsSync(path.join(home, ".config")), false);
  });
});

test("isConfig: validates by value (T-CFG-5)", () => {
  const ok = defaultConfig();
  assert.equal(isConfig(ok), true);
  assert.equal(isConfig({ ...ok, codex: { model: "gpt 5", effort: null } }), false);
  assert.equal(isConfig({ ...ok, codex: { model: null, effort: "turbo" } }), false);
  assert.equal(isConfig({ ...ok, rubricPath: "rel/path.md" }), false);
  assert.equal(isConfig({ ...ok, events: { path: "rel.jsonl" } }), false);
  assert.equal(isConfig({ ...ok, codex: { model: "gpt-6-luna", effort: "high" } }), true);
});

test("EFFORTS matches probe P2; none accepted, unknown rejected", () => {
  assert.deepEqual([...EFFORTS], ["none", "minimal", "low", "medium", "high", "xhigh"]);
  const ok = defaultConfig();
  assert.equal(isConfig({ ...ok, codex: { model: null, effort: "none" } }), true);
  assert.equal(isConfig({ ...ok, codex: { model: null, effort: "max" } }), false);
});

test("[RF-3] HOME reached through a symlink still works", () => {
  const real = tmpDir();
  const link = path.join(tmpDir(), "home-link");
  fs.symlinkSync(real, link);
  withEnv({ HOME: link, REVIEW_LOOP_CONFIG: undefined, XDG_CONFIG_HOME: undefined }, () => {
    writeConfig({ ...defaultConfig(), preset: "advisory" });
    assert.equal(readConfig().config.preset, "advisory");
  });
});
