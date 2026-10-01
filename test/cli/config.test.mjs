import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
const { main } = await import("../../cli/review-loop.mjs");
const { ownerSeam } = await import("../../cli/lib/configguard.mjs");
const io = () => ({ isTTY: false, color: false, lines: [], outs: [], out(s) { this.outs.push(s); }, err(s) { this.lines.push(s); }, ask: async () => true, choose: async (_q, _o, d) => d, env: process.env });
function sandbox() {
  const h = tmpDir();
  Object.assign(process.env, { HOME: h, REVIEW_LOOP_STATE_DIR: path.join(h, "state"), REVIEW_LOOP_CONFIG: path.join(h, "cfg", "config.json"), CODEX_HOME: path.join(h, "codex") });
  return h;
}
const cfgFile = () => process.env.REVIEW_LOOP_CONFIG;
const stored = () => JSON.parse(fs.readFileSync(cfgFile(), "utf8"));
const seed = (text) => { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), text); };

test("T-CFG-5: set validates; show reports source", async () => {
  sandbox();
  assert.equal(await main(["config", "set", "preset", "balanced"], io()), 0);
  const badEffort = io();
  assert.equal(await main(["config", "set", "effort", "turbo"], badEffort), 2);
  assert.match(badEffort.lines.join(""), /invalid value for effort: one of none, minimal, low, medium, high, xhigh, or inherit/, "exit 2 with the allowed list (L7)");
  const badModel = io();
  assert.equal(await main(["config", "set", "model", "gpt 5"], badModel), 2);
  assert.match(badModel.lines.join(""), /invalid value for model: 1–64 letters, digits or \. _ : \/ - \(no spaces\), or inherit/);
  assert.equal(await main(["config", "set", "model", "inherit"], io()), 0);
  const o = io();
  assert.equal(await main(["config", "show", "--json"], o), 0);
  const shown = JSON.parse(o.outs.join(""));
  assert.equal(shown.preset, "balanced");
  assert.equal(shown.codex.model, null);
  assert.equal(shown.event.event, "cli.exit");
  assert.equal(o.outs.length, 1);
});

test("set writes each key and inherit/default resets it", async () => {
  const h = sandbox();
  const rubric = path.join(h, "r.md");
  fs.copyFileSync(new URL("../../plugin/rubric/default.md", import.meta.url), rubric);
  const events = path.join(h, "ev.jsonl");
  for (const a of [["model", "gpt-5.5"], ["effort", "high"], ["rubric", rubric], ["events.path", events], ["preset", "advisory"]]) {
    assert.equal(await main(["config", "set", ...a], io()), 0, a.join(" "));
  }
  assert.deepEqual(stored(), { version: 1, preset: "advisory", codex: { model: "gpt-5.5", effort: "high" }, rubricPath: rubric, events: { path: events } });
  for (const k of ["model", "effort", "rubric", "events.path", "preset"]) assert.equal(await main(["config", "set", k, "default"], io()), 0, k);
  assert.deepEqual(stored(), { version: 1, preset: "default", codex: { model: null, effort: null }, rubricPath: null, events: { path: null } });
});

test("set rejects bad input without writing", async () => {
  sandbox();
  assert.equal(await main(["config", "set", "preset", "yolo"], io()), 2);
  assert.equal(await main(["config", "set", "nope", "x"], io()), 2);
  assert.equal(await main(["config", "set", "model"], io()), 2);
  assert.equal(await main(["config", "frob"], io()), 2);
  assert.equal(fs.existsSync(cfgFile()), false);
});

test("set refuses an invalid config rather than silently replacing it", async () => {
  sandbox();
  seed("{bad");
  assert.equal(await main(["config", "set", "preset", "balanced"], io()), 1);
  assert.equal(fs.readFileSync(cfgFile(), "utf8"), "{bad");
});

test("T-PR-13: set rubric prints the approvals-stay-valid note", async () => {
  const h = sandbox();
  const r = path.join(h, "r.md");
  fs.copyFileSync(new URL("../../plugin/rubric/default.md", import.meta.url), r);
  const o = io();
  assert.equal(await main(["config", "set", "rubric", r], o), 0);
  assert.match(o.lines.join(""), /Approvals given earlier stay valid/);
});

test("set rubric refuses a file that is not a rubric, and does not store it", async () => {
  const h = sandbox();
  const r = path.join(h, "bad.md");
  fs.writeFileSync(r, "# nothing here\n");
  assert.equal(await main(["config", "set", "rubric", r], io()), 1);
  assert.equal(fs.existsSync(cfgFile()), false);
});

test("set model/effort never touches CODEX_HOME", async () => {
  sandbox();
  assert.equal(await main(["config", "set", "model", "gpt-5.5"], io()), 0);
  assert.equal(await main(["config", "set", "effort", "low"], io()), 0);
  assert.equal(fs.existsSync(process.env.CODEX_HOME), false);
});

test("show prints values, sources, and that effort is display-only", async () => {
  sandbox();
  await main(["config", "set", "effort", "high"], io());
  const o = io();
  assert.equal(await main(["config", "show"], o), 0);
  const text = o.lines.join("");
  assert.match(text, /preset:\s+default/);
  assert.match(text, /effort:\s+high.*display only; not sent to Codex/);
  assert.match(text, /model:\s+inherit/);
  const j = io();
  await main(["config", "show", "--json"], j);
  const shown = JSON.parse(j.outs.join(""));
  assert.equal(shown.status, "ok");
  assert.equal(shown.sources.effort, "config");
  assert.equal(shown.sources.model, "inherit");
});

test("show on a corrupt config reports it and points at repair", async () => {
  sandbox();
  seed("{bad");
  const o = io();
  assert.equal(await main(["config", "show"], o), 0);
  assert.match(o.lines.join(""), /invalid.*config repair/s);
});

test("repair quarantines and resets", async () => {
  sandbox();
  seed("{bad");
  const o = io();
  assert.equal(await main(["config", "repair"], o), 0);
  const names = fs.readdirSync(path.dirname(cfgFile()));
  const kept = names.find((n) => n.startsWith("config.json.corrupt-"));
  assert.ok(kept);
  assert.equal(fs.readFileSync(path.join(path.dirname(cfgFile()), kept), "utf8"), "{bad");
  assert.match(o.lines.join(""), /config\.json\.corrupt-/);
  assert.equal(stored().preset, "default");
});

test("repair leaves a valid config alone", async () => {
  sandbox();
  await main(["config", "set", "preset", "advisory"], io());
  assert.equal(await main(["config", "repair"], io()), 0);
  assert.equal(stored().preset, "advisory");
  assert.equal(fs.readdirSync(path.dirname(cfgFile())).length, 1);
});

test("a symlinked config is refused by set and repair, and its target is untouched", async () => {
  const h = sandbox();
  const target = path.join(h, "target.json");
  fs.writeFileSync(target, "{bad");
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.symlinkSync(target, cfgFile());
  assert.equal(await main(["config", "repair"], io()), 1);
  assert.equal(await main(["config", "set", "preset", "balanced"], io()), 1);
  assert.equal(fs.lstatSync(cfgFile()).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, "utf8"), "{bad");
});

test("a config owned by another user is refused by set and repair", async () => {
  sandbox();
  seed("{bad");
  ownerSeam.set({ statUid: () => 4242 });
  try {
    assert.equal(await main(["config", "repair"], io()), 1);
    assert.equal(await main(["config", "set", "preset", "balanced"], io()), 1);
    assert.equal(fs.readFileSync(cfgFile(), "utf8"), "{bad");
  } finally { ownerSeam.reset(); }
});

test("set events.path refuses a symlink, a directory, and a missing parent; accepts a valid path", async () => {
  const h = sandbox();
  const real = path.join(h, "real.jsonl");
  fs.writeFileSync(real, "");
  const link = path.join(h, "link.jsonl");
  fs.symlinkSync(real, link);
  const dir = path.join(h, "adir");
  fs.mkdirSync(dir);
  for (const [p, why] of [[link, /symlink/], [dir, /not regular file/], [path.join(h, "nope", "e.jsonl"), /missing parent/]]) {
    const o = io();
    assert.equal(await main(["config", "set", "events.path", p], o), 1, p);
    assert.equal(fs.existsSync(cfgFile()), false);
    assert.match(o.lines.join(""), why);
    assert.match(o.lines.join(""), /events_path_rejected/);
  }
  const good = path.join(h, "ok.jsonl");
  const o = io();
  assert.equal(await main(["config", "set", "events.path", good], o), 0);
  assert.equal(stored().events.path, good);
  assert.match(o.lines.join(""), new RegExp(`events: ${good}`));
});

test("set rubric echoes the stored absolute path", async () => {
  const h = sandbox();
  const r = path.join(h, "r.md");
  fs.copyFileSync(new URL("../../plugin/rubric/default.md", import.meta.url), r);
  const o = io();
  await main(["config", "set", "rubric", r], o);
  assert.match(o.lines.join(""), new RegExp(`rubric: ${r}`));
});

test("set on an invalid or symlinked config names `review-loop config repair`", async () => {
  const h = sandbox();
  seed("{bad");
  const a = io();
  assert.equal(await main(["config", "set", "preset", "balanced"], a), 1);
  assert.match(a.lines.join(""), /review-loop config repair/);
  fs.rmSync(cfgFile());
  fs.writeFileSync(path.join(h, "t.json"), "{}");
  fs.symlinkSync(path.join(h, "t.json"), cfgFile());
  const b = io();
  assert.equal(await main(["config", "set", "preset", "balanced"], b), 1);
  assert.match(b.lines.join(""), /review-loop config repair/);
});

test("bare `config` acts as show without taking the CLI lock", async () => {
  const { COMMANDS } = await import("../../cli/review-loop.mjs");
  assert.equal(COMMANDS.config.mutates([]), false);
  assert.equal(COMMANDS.config.mutates(["show"]), false);
  assert.equal(COMMANDS.config.mutates(["set", "preset", "x"]), true);
  assert.equal(COMMANDS.config.mutates(["repair"]), true);
});
