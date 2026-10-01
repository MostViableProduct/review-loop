import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpDir } from "../engine/helpers.mjs";
import { makeFakeBin } from "../fakes/fakebin.mjs";

const bin = path.join(tmpDir(), "bin");
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.CLAUDECODE;
/** A `ps -Ao pid=,ppid=,args=` answer: right-aligned pid and ppid columns, then the args. */
const psTable = (/** @type {string[]} */ rows) => ({ "*": { stdout: rows.map((r) => { const [pid, ppid, ...a] = r.split(" "); return `${pid.padStart(5)} ${ppid.padStart(5)} ${a.join(" ")}`; }).join("\n") + "\n" } });
/** A machine with no session: only pure helpers, including a Chrome native host launched with only the extension origin (R-P6b). */
const NO_CLAUDE = ["1 0 /sbin/launchd", "200 1 -zsh", "201 200 vim notes.md", "300 1 /Users/x/.local/bin/claude daemon", "301 1 /Users/x/.local/bin/claude chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"];
const quiet = () => { makeFakeBin(bin, "ps", psTable(NO_CLAUDE)); makeFakeBin(bin, "lsof", { "*": { code: 1 } }); };
const { ASK_RULES, updateSettings, settingsPath, listClaudeProcesses, seams } = await import("../../cli/lib/settings.mjs");
const addRules = (o) => { o.permissions ??= {}; o.permissions.ask ??= []; let ch = false; for (const r of ASK_RULES) if (!o.permissions.ask.includes(r)) { o.permissions.ask.push(r); ch = true; } return ch; };
const io = { isTTY: false, err: () => {}, out: () => {}, ask: async () => true };

function sandbox(initial) {
  const home = tmpDir();
  process.env.HOME = home;
  process.env.REVIEW_LOOP_STATE_DIR = path.join(home, "state");
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  if (initial !== undefined) fs.writeFileSync(settingsPath(), initial);
  quiet();
  seams.reset();
  return home;
}
const read = () => JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
const backups = (home) => fs.existsSync(path.join(home, "state", "settings-backups")) ? fs.readdirSync(path.join(home, "state", "settings-backups")) : [];

test("settingsPath honors CLAUDE_CONFIG_DIR", () => {
  const home = sandbox();
  assert.equal(settingsPath(), path.join(home, ".claude", "settings.json"));
  process.env.CLAUDE_CONFIG_DIR = path.join(home, "alt");
  try { assert.equal(settingsPath(), path.join(home, "alt", "settings.json")); } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test("R-P6: the session classifier on the P6 synthetic table (docs/probes/P6-2026-09-28.md)", () => {
  sandbox();
  const ps = makeFakeBin(bin, "ps", psTable([
    "101 1 claude",
    "102 1 claude --resume",
    "103 1 claude --model x -p hi",
    "104 1 claude --output-format stream-json --input-format stream-json",
    "105 1 claude mcp serve",
    "106 1 /Users/x/Library/Application Support/Claude/claude-code/2.1.284/claude",
    "107 1 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "108 1 claude daemon",
    "109 1 claude bg-pty-host",
    "110 1 claude bg-spare",
    "111 1 /Users/x/.local/bin/claude --chrome-native-host",
    "112 1 /usr/bin/grep claude",
    "113 1 vim claude.md",
    "114 1 /Users/x/Apps Folder/claude",
    "115 1 /Users/x/My grep tools/claude --resume"
  ]));
  const r = listClaudeProcesses();
  assert.deepEqual(r.pids, [101, 102, 103, 104, 105, 106, 107, 114, 115]);
  assert.equal(r.parent, false);
  assert.deepEqual(ps.log(), [["-ww", "-Ao", "pid=,ppid=,args="]], "-ww: the args column is never truncated (procps with COLUMNS)");
});

test("R-P6b: the Chrome native host is the flag first, or only Chrome launch arguments; any other word counts", () => {
  sandbox();
  makeFakeBin(bin, "ps", psTable([
    "120 1 /Users/x/.local/bin/claude --chrome-native-host",
    "122 1 /Users/x/.local/bin/claude chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/",
    "123 1 /Users/x/.local/bin/claude chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/ --parent-window=0",
    "124 1 /Users/x/.local/bin/claude --chrome-native-host\\012chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/",
    "125 1 /Users/x/.local/bin/claude chrome-extension://abc/\\012--parent-window=0",
    "126 1 node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js --chrome-native-host",
    "130 1 claude --resume chrome-extensions-notes",
    "131 1 claude -p --chrome-native-host-like",
    "132 1 claude -p explain\\012chrome-extension",
    "133 1 claude daemonize",
    "134 1 claude --verbose --chrome-native-host",
    "135 1 claude -p summarize chrome-extension://abc manifest",
    "136 1 claude -p explain the --chrome-native-host flag",
    "137 1 claude chrome-extension://abc/ -p hi",
    "138 1 node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js -p explain --chrome-native-host"
  ]));
  assert.deepEqual(listClaudeProcesses().pids, [130, 131, 132, 133, 134, 135, 136, 137, 138]);
});

test("R-P6: this CLI's own ancestry is not counted as a session, but reported as the parent", () => {
  sandbox();
  makeFakeBin(bin, "ps", psTable([`${process.pid} 4242 node review-loop.mjs setup`, "4242 4241 -zsh", "4241 1 /Users/x/.local/bin/claude --resume", "4300 1 -zsh"]));
  assert.deepEqual(listClaudeProcesses(), { pids: [], parent: true });
  makeFakeBin(bin, "ps", psTable([`${process.pid} 4242 node review-loop.mjs setup`, "4242 1 -zsh", "4300 1 claude"]));
  assert.deepEqual(listClaudeProcesses(), { pids: [4300], parent: false });
});

test("R-P6: an ancestor whose path merely contains a claude directory is not Claude Code", async () => {
  sandbox("{}");
  makeFakeBin(bin, "ps", psTable([`${process.pid} 4242 node review-loop.mjs setup`, "4242 4241 /bin/zsh /Users/x/claude/bin/tool", "4241 1 /Users/x/claude/bin/tool"]));
  assert.deepEqual(listClaudeProcesses(), { pids: [], parent: false });
  await updateSettings(addRules, { io, yes: true });
  assert.equal(read().permissions.ask.length, 5);
});

test("T-SET-9: idempotent — the second run changes no byte, makes no backup", async () => {
  const home = sandbox(JSON.stringify({ theme: "dark" }));
  await updateSettings(addRules, { io, yes: true });
  const bytes = fs.readFileSync(settingsPath());
  const mtime = fs.statSync(settingsPath()).mtimeMs;
  const n = backups(home).length;
  const r = await updateSettings(addRules, { io, yes: true });
  assert.equal(r.changed, false);
  assert.deepEqual(fs.readFileSync(settingsPath()), bytes);
  assert.equal(fs.statSync(settingsPath()).mtimeMs, mtime);
  assert.equal(backups(home).length, n);
});

test("T-SET-10: foreign keys deep-equal, same order", async () => {
  sandbox(JSON.stringify({ z: 1, hooks: { Stop: [] }, env: { A: "1" }, a: [1, 2] }));
  await updateSettings(addRules, { io, yes: true });
  const o = read();
  assert.deepEqual(Object.keys(o), ["z", "hooks", "env", "a", "permissions"]);
  assert.deepEqual([o.z, o.hooks, o.env, o.a], [1, { Stop: [] }, { A: "1" }, [1, 2]]);
});

test("T-SET-11: invalid JSON refused, bytes unchanged, no backup", async () => {
  const home = sandbox('{"a":1,}');
  await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_invalid_json" });
  assert.equal(fs.readFileSync(settingsPath(), "utf8"), '{"a":1,}');
  assert.equal(backups(home).length, 0);
});

test("T-SET-11: a JSON value that is not an object is refused", async () => {
  for (const body of ["[]", "null", "\"x\""]) {
    sandbox(body);
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_invalid_json" });
    assert.equal(fs.readFileSync(settingsPath(), "utf8"), body);
  }
});

test("[RF-1] BOM and CRLF parse; output is LF with no BOM", async () => {
  sandbox("﻿{\r\n  \"theme\": \"dark\"\r\n}\r\n");
  await updateSettings(addRules, { io, yes: true });
  const raw = fs.readFileSync(settingsPath(), "utf8");
  assert.ok(!raw.startsWith("﻿") && !raw.includes("\r"));
  assert.equal(read().theme, "dark");
});

test("T-SET-11b: an oversized settings.json is refused before it is buffered; bytes unchanged, no backup", async () => {
  const home = sandbox("{}");
  const big = `{"x":"${"a".repeat(1024 * 1024)}"}`;
  fs.writeFileSync(settingsPath(), big);
  await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_too_large" });
  assert.equal(fs.readFileSync(settingsPath(), "utf8").length, big.length);
  assert.equal(backups(home).length, 0);
});

test("T-SET-12b: a dangling settings symlink is refused and left exactly as it was", async () => {
  const home = sandbox();
  const missing = path.join(home, "dotfiles", "settings.json");
  fs.symlinkSync(missing, settingsPath());
  await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_target_insecure" });
  assert.ok(fs.lstatSync(settingsPath()).isSymbolicLink());
  assert.equal(fs.readlinkSync(settingsPath()), missing);
  assert.equal(fs.existsSync(missing), false, "no file created through the link");
  assert.equal(backups(home).length, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(settingsPath())).filter((n) => n.endsWith(".tmp")), []);
});

test("T-SET-12: symlinked settings — link survives, target updated, mode preserved; foreign-owned target refused", async () => {
  const home = sandbox();
  const real = path.join(home, "dotfiles", "settings.json");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, "{}", { mode: 0o644 });
  fs.chmodSync(real, 0o644);
  fs.symlinkSync(real, settingsPath());
  await updateSettings(addRules, { io, yes: true });
  assert.ok(fs.lstatSync(settingsPath()).isSymbolicLink());
  assert.equal(fs.statSync(real).mode & 0o777, 0o644);
  assert.ok(JSON.parse(fs.readFileSync(real, "utf8")).permissions.ask.length === 5);
  seams.set({ statUid: () => 12345 });
  await assert.rejects(updateSettings((o) => { o.x = 1; return true; }, { io, yes: true }), { code: "settings_target_insecure" });
});

test("T-SET-12: a settings path that is not a regular file is refused", async () => {
  sandbox();
  fs.mkdirSync(settingsPath());
  await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_target_insecure" });
});

test("T-SET-13: concurrency, crash safety, detached writes, backups", async (t) => {
  await t.test("(2) foreign write before the re-hash → merged", async () => {
    sandbox(JSON.stringify({ a: 1 }));
    let fired = false;
    seams.set({ beforeRehash: () => { if (!fired) { fired = true; fs.writeFileSync(settingsPath(), JSON.stringify({ a: 1, foreign: true })); } } });
    await updateSettings(addRules, { io, yes: true });
    assert.equal(read().foreign, true);
    assert.equal(read().permissions.ask.length, 5);
  });
  await t.test("(2b) replace-style foreign write (temp + rename) before the re-hash → merged", async () => {
    sandbox(JSON.stringify({ a: 1 }));
    let fired = false;
    seams.set({ beforeRehash: () => { if (!fired) { fired = true; fs.writeFileSync(`${settingsPath()}.x`, JSON.stringify({ a: 1, foreign: true })); fs.renameSync(`${settingsPath()}.x`, settingsPath()); } } });
    await updateSettings(addRules, { io, yes: true });
    assert.equal(fired, true);
    assert.equal(read().foreign, true);
    assert.equal(read().permissions.ask.length, 5);
  });
  await t.test("(3) absent file → created 0600, no backup", async () => {
    const home = sandbox();
    await updateSettings(addRules, { io, yes: true });
    assert.deepEqual(Object.keys(read()), ["permissions"]);
    assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);
    assert.equal(backups(home).length, 0);
  });
  await t.test("(4b) a writer that starts after the preflight refuses the commit; bytes unchanged, no backup, no temp", async () => {
    const home = sandbox(JSON.stringify({ a: 1 }));
    const before = fs.readFileSync(settingsPath());
    seams.set({ beforeRecheck: () => makeFakeBin(bin, "lsof", { "*": { stdout: "p4242\ncvim\n" } }) });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_open_elsewhere" });
    assert.deepEqual(fs.readFileSync(settingsPath()), before);
    assert.equal(backups(home).length, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(settingsPath())).filter((n) => n.endsWith(".tmp")), []);
  });
  await t.test("(4c) Claude starting after the preflight refuses the commit", async () => {
    sandbox(JSON.stringify({ a: 1 }));
    seams.set({ beforeRecheck: () => makeFakeBin(bin, "ps", psTable([...NO_CLAUDE, "999 1 claude"])) });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "claude_running" });
    assert.deepEqual(read(), { a: 1 });
  });
  await t.test("(4d) an inconclusive writer check fails closed: ps error, empty or garbled ps, lsof error, lsof status 1 with output", async () => {
    for (const [tool, resp] of [
      ["ps", { code: 1, stderr: "ps: bad" }],
      ["ps", { stdout: "" }],
      ["ps", { stdout: "not a process table\n" }],
      ["lsof", { code: 2, stderr: "lsof: denied" }],
      ["lsof", { code: 1, stdout: "p1\ncvim\n" }]
    ]) {
      const home = sandbox(JSON.stringify({ a: 1 }));
      makeFakeBin(bin, tool, { "*": resp });
      await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_writer_check_failed" }, `${tool} ${JSON.stringify(resp)}`);
      assert.deepEqual(read(), { a: 1 });
      assert.equal(backups(home).length, 0);
    }
  });
  await t.test("(4d) ps that cannot be spawned fails closed", async () => {
    sandbox(JSON.stringify({ a: 1 }));
    fs.rmSync(path.join(bin, "ps"));
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_writer_check_failed" });
    } finally { process.env.PATH = saved; }
    assert.deepEqual(read(), { a: 1 });
  });
  await t.test("(4e) the commit-boundary re-check also fails closed", async () => {
    sandbox(JSON.stringify({ a: 1 }));
    seams.set({ beforeRecheck: () => makeFakeBin(bin, "lsof", { "*": { code: 2 } }) });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_writer_check_failed" });
    assert.deepEqual(read(), { a: 1 });
  });
  await t.test("(4) Claude running → claude_running (non-TTY)", async () => {
    sandbox("{}");
    makeFakeBin(bin, "ps", psTable([...NO_CLAUDE, "123 1 claude"]));
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "claude_running" });
    assert.deepEqual(read(), {});
  });
  await t.test("(4) interactive: asks, re-checks, then writes; declining cancels", async () => {
    sandbox("{}");
    makeFakeBin(bin, "ps", { "*": [psTable([...NO_CLAUDE, "123 1 claude"])["*"], psTable(NO_CLAUDE)["*"]] });
    const said = [];
    let asked = 0;
    const tty = { ...io, isTTY: true, err: (s) => said.push(s), ask: async () => ++asked === 1 };
    await updateSettings(addRules, { io: tty, yes: false });
    assert.equal(asked, 1);
    assert.match(said.join(""), /Quit all Claude Code sessions/);
    assert.equal(read().permissions.ask.length, 5);
    sandbox("{}");
    makeFakeBin(bin, "ps", psTable([...NO_CLAUDE, "123 1 claude"]));
    await assert.rejects(updateSettings(addRules, { io: { ...tty, ask: async () => false }, yes: false }), { code: "cancelled" });
    assert.deepEqual(read(), {});
  });
  await t.test("(5) parent is Claude Code → claude_parent_process", async () => {
    sandbox("{}");
    process.env.CLAUDECODE = "1";
    try { await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "claude_parent_process" }); } finally { delete process.env.CLAUDECODE; }
  });
  await t.test("(5) an ancestor that is Claude Code → claude_parent_process, even with CLAUDECODE unset and a TTY", async () => {
    sandbox("{}");
    makeFakeBin(bin, "ps", psTable([`${process.pid} 4242 node review-loop.mjs setup`, "4242 1 claude"]));
    await assert.rejects(updateSettings(addRules, { io: { ...io, isTTY: true }, yes: false }), { code: "claude_parent_process" });
    assert.deepEqual(read(), {});
  });
  await t.test("(5b) a process holds the file open → settings_open_elsewhere, message names the process only", async () => {
    sandbox("{}");
    makeFakeBin(bin, "lsof", { "*": { stdout: "p999\ncVim\n" } });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), (e) => e.code === "settings_open_elsewhere" && /Vim/.test(e.message) && !e.message.includes("/"));
  });
  await t.test("(5c) foreign write after our rename → redone on top, both present", async () => {
    sandbox("{}");
    let fired = false;
    seams.set({ afterRename: () => { if (!fired) { fired = true; fs.writeFileSync(settingsPath(), JSON.stringify({ late: true })); } } });
    await updateSettings(addRules, { io, yes: true });
    assert.equal(read().late, true);
    assert.equal(read().permissions.ask.length, 5);
  });
  await t.test("(6) crash between temp write and rename → target byte-identical, temp cleaned next run", async () => {
    const home = sandbox('{"keep":1}');
    seams.set({ beforeRename: () => { throw new Error("crash"); } });
    await assert.rejects(updateSettings(addRules, { io, yes: true }));
    assert.equal(fs.readFileSync(settingsPath(), "utf8"), '{"keep":1}');
    const stale = path.join(home, ".claude", ".settings.json.review-loop-1-deadbeef.tmp");
    fs.writeFileSync(stale, "{\"partial\":");
    seams.reset();
    await updateSettings(addRules, { io, yes: true });
    assert.deepEqual(fs.readdirSync(path.join(home, ".claude")).filter((n) => n.includes(".tmp")), []);
  });
  await t.test("(7) writes injected on every attempt → settings_concurrent_write after 3", async () => {
    sandbox("{}");
    let n = 0;
    seams.set({ beforeRehash: () => fs.writeFileSync(settingsPath(), JSON.stringify({ n: ++n })) });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_concurrent_write" });
    assert.equal(n, 3);
  });
  await t.test("(8a) descriptor opened before, written after rename → detached write kept + reported", async () => {
    const home = sandbox('{"a":1}');
    let fd;
    seams.set({ beforeLink: () => { fd = fs.openSync(settingsPath(), "r+"); }, afterRename: () => { fs.writeSync(fd, '{"a":2}', 0); fs.closeSync(fd); } });
    await assert.rejects(updateSettings(addRules, { io, yes: true }), { code: "settings_detached_write" });
    const [b] = backups(home);
    assert.match(fs.readFileSync(path.join(home, "state", "settings-backups", b), "utf8"), /"a":2/);
  });
  await t.test("(8b) modified backup survives pruning", async () => {
    const home = sandbox("{}");
    for (let i = 0; i < 7; i++) await updateSettings((o) => { o[`k${i}`] = i; return true; }, { io, yes: true });
    const dir = path.join(home, "state", "settings-backups");
    const all = fs.readdirSync(dir).sort();
    assert.equal(all.length, 5);
    fs.appendFileSync(path.join(dir, all[0]), " ");
    for (let i = 7; i < 12; i++) await updateSettings((o) => { o[`k${i}`] = i; return true; }, { io, yes: true });
    assert.ok(fs.readdirSync(dir).includes(all[0]), "a modified backup is never pruned");
  });
  await t.test("(9) backup privacy: 0700 dir, target mode unchanged, backup is the pre-image inode", async () => {
    const home = sandbox(JSON.stringify({ env: { SECRET: "ENVSECRET" } }));
    fs.chmodSync(settingsPath(), 0o644);
    const preIno = fs.statSync(settingsPath()).ino;
    const r = await updateSettings(addRules, { io, yes: true });
    assert.equal(fs.statSync(path.join(home, "state", "settings-backups")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o644);
    assert.equal(fs.statSync(r.backup).ino, preIno);
    assert.match(path.basename(r.backup), /^settings\.json\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{8}$/);
  });
  await t.test("(10b) EXDEV: a foreign write before the re-hash is merged (the target is re-hashed, not the copy)", async () => {
    for (const replace of [false, true]) {
      sandbox(JSON.stringify({ a: 1 }));
      let fired = false;
      seams.set({
        link: () => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); },
        beforeRehash: () => {
          if (fired) return;
          fired = true;
          const body = JSON.stringify({ a: 1, foreign: true });
          if (replace) { fs.writeFileSync(`${settingsPath()}.x`, body); fs.renameSync(`${settingsPath()}.x`, settingsPath()); } else fs.writeFileSync(settingsPath(), body);
        }
      });
      await updateSettings(addRules, { io, yes: true });
      assert.equal(read().foreign, true, `replace=${replace}`);
      assert.equal(read().permissions.ask.length, 5);
    }
  });
  await t.test("(10) EXDEV: the backup is a 0600 byte copy and the output says so", async () => {
    const home = sandbox('{"a":1}');
    fs.chmodSync(settingsPath(), 0o644);
    const said = [];
    seams.set({ link: () => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); } });
    const r = await updateSettings(addRules, { io: { ...io, err: (s) => said.push(s) }, yes: true });
    const [b] = backups(home);
    const bp = path.join(home, "state", "settings-backups", b);
    assert.equal(r.backup, bp);
    assert.equal(fs.readFileSync(bp, "utf8"), '{"a":1}');
    assert.equal(fs.statSync(bp).mode & 0o777, 0o600);
    assert.match(said.join(""), /backup is a copy/);
  });
});

test("T-SET-8: env values never reach any output", async () => {
  sandbox(JSON.stringify({ env: { TOKEN: "ENVSECRET" } }));
  const seen = [];
  const cap = { ...io, err: (s) => seen.push(s), out: (s) => seen.push(s) };
  await updateSettings((o) => { addRules(o); o.env.TOKEN2 = "ENVSECRET2"; return true; }, { io: cap, yes: true, preview: true });
  assert.ok(seen.length > 0, "the preview printed something");
  assert.match(seen.join(""), /settings\.permissions/);
  assert.ok(!seen.join("").includes("ENVSECRET"));
});

test("T-SET-14: exactly the five strings; never permissions.allow; a similar string is untouched", async () => {
  sandbox(JSON.stringify({ permissions: { ask: ["Bash(*review-loop.off* )"] } }));
  await updateSettings(addRules, { io, yes: true });
  const o = read();
  assert.equal(o.permissions.ask.length, 6);
  assert.equal(o.permissions.ask[0], "Bash(*review-loop.off* )");
  assert.deepEqual(o.permissions.ask.slice(1), [...ASK_RULES]);
  assert.equal(o.permissions.allow, undefined);
});

test("ASK_RULES and LEGACY_HOOK_RE are the spec §6.2 values", async () => {
  const { LEGACY_HOOK_RE } = await import("../../cli/lib/settings.mjs");
  assert.deepEqual([...ASK_RULES], ["Bash(*review-loop.off*)", "Bash(*review-round.mjs decide*)", "Bash(*review-round.mjs override*)", "Bash(*review-round.mjs repin*)", "Edit(**/.claude/review-loop.off)"]);
  assert.ok(Object.isFrozen(ASK_RULES));
  assert.ok(LEGACY_HOOK_RE.test("node ~/.claude/review-loop/review-gate-hook.mjs stop"));
});

test("L12: hookCommands is the one flattening of settings.hooks, shared by doctor, migrate and uninstall", async () => {
  const { hookCommands } = await import("../../cli/lib/settings.mjs");
  const obj = { hooks: { Stop: [{ hooks: [{ command: "a" }, { type: "x" }, null] }, "junk"], Pre: "junk", Post: [{ hooks: "junk" }, { hooks: [{ command: "b" }] }] } };
  assert.deepEqual(hookCommands(obj), ["a", "", "", "b"]);
  assert.deepEqual(hookCommands({}), []);
  const dir = path.join(process.cwd(), "cli", "lib");
  const copies = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "settings.mjs" && /flatMap\(\(g\) => \(isObject\(g\) && Array\.isArray\(g\.hooks\)/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(copies, [], "a second implementation of the hook flattening");
});
