import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { run } from "../../plugin/engine/lib/proc.mjs";
import { tmpDir } from "./helpers.mjs";
import { signalPid } from "../fakes/signal.mjs";

const PROC = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "plugin", "engine", "lib", "proc.mjs");

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** @param {() => boolean} cond @param {number} ms */
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

test("a timeout kills the child's whole group: a descendant holding the pipes dies too", { timeout: 10_000 }, async () => {
  const pidfile = path.join(tmpDir("rl-proc-"), "pid");
  const r = await run("sh", ["-c", `sleep 30 & echo $! > ${pidfile}; wait`], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  const pid = Number(fs.readFileSync(pidfile, "utf8"));
  assert.ok(await until(() => !alive(pid), 2000), "the backgrounded sleep was killed with its group");
});

test("a timeout settles even when a descendant escaped the group and still holds the pipes", { timeout: 10_000 }, async () => {
  const pidfile = path.join(tmpDir("rl-proc-"), "pid");
  const script = "const c = require('child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); require('fs').writeFileSync(process.env.PIDFILE, String(c.pid)); setInterval(() => {}, 1000);";
  try {
    const started = Date.now();
    const r = await run(process.execPath, ["-e", script], { timeoutMs: 500, env: { ...process.env, PIDFILE: pidfile } });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 5000, "settled on the child's exit, not the escaped holder's");
  } finally {
    // An empty or partly written pid file reads as 0: never signal that (it is this runner's own group).
    if (fs.existsSync(pidfile)) signalPid(Number(fs.readFileSync(pidfile, "utf8")), "SIGKILL");
  }
});

test("SIGTERM to this process reaps its live child groups before it dies", { timeout: 10_000 }, async () => {
  const dir = tmpDir("rl-proc-");
  const pidfile = path.join(dir, "pid");
  const driver = path.join(dir, "driver.mjs");
  fs.writeFileSync(driver, `import { run } from ${JSON.stringify(PROC)};\nawait run("sh", ["-c", "echo $$ > ${pidfile}; exec sleep 30"], { timeoutMs: 60_000 });\n`);
  const parent = spawn(process.execPath, [driver], { stdio: "ignore" });
  let pid = 0;
  try {
    assert.ok(await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").trim() !== "", 5000), "the child started");
    pid = Number(fs.readFileSync(pidfile, "utf8"));
    const exited = new Promise((r) => parent.once("exit", (_code, sig) => r(sig)));
    parent.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM", "the driver still dies of SIGTERM");
    assert.ok(await until(() => !alive(pid), 2000), "its detached child was reaped, not orphaned");
  } finally {
    if (alive(pid)) signalPid(pid, "SIGKILL");
    parent.kill("SIGKILL");
  }
});

test("reap-only (the CLI's mode): a signal no other listener handles still stops the process, and its child is reaped", { timeout: 10_000 }, async () => {
  const dir = tmpDir("rl-proc-");
  const pidfile = path.join(dir, "pid");
  const driver = path.join(dir, "driver.mjs");
  fs.writeFileSync(driver, `import { run, setSignalMode } from ${JSON.stringify(PROC)};\nsetSignalMode("reap-only");\nawait run("sh", ["-c", "echo $$ > ${pidfile}; exec sleep 30"], { timeoutMs: 60_000 });\n`);
  const parent = spawn(process.execPath, [driver], { stdio: "ignore" });
  let pid = 0;
  try {
    assert.ok(await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").trim() !== "", 5000), "the child started");
    pid = Number(fs.readFileSync(pidfile, "utf8"));
    const exited = new Promise((r) => parent.once("exit", (_code, sig) => r(sig)));
    parent.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM", "SIGTERM is not swallowed when nothing else handles it");
    assert.ok(await until(() => !alive(pid), 2000), "its child was reaped");
  } finally {
    if (alive(pid)) signalPid(pid, "SIGKILL");
    parent.kill("SIGKILL");
  }
});

test("reapChildren kills live children and refuses later spawns, so abandoned work cannot keep the process alive", async () => {
  const url = new URL("../../plugin/engine/lib/proc.mjs", import.meta.url).href;
  const script = `const p = await import(${JSON.stringify(url)});
const slow = p.run("sleep", ["30"], { timeoutMs: 60_000 });
await new Promise((r) => setTimeout(r, 200));
const t = Date.now();
p.reapChildren();
const killed = await slow;
let refused = null;
try { await p.run("true", []); } catch (e) { refused = e.message; }
console.log(JSON.stringify({ killedQuickly: Date.now() - t < 5000 && killed.code !== 0, refused }));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => { out += b; });
  const code = await new Promise((r) => child.once("close", r));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { killedQuickly: true, refused: "spawns_closed" });
});
