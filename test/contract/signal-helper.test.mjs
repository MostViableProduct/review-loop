import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isRealPid, signalPid } from "../fakes/signal.mjs";

test("R3: after a failed spawn the test signal helper signals nothing (no kill(-0) of the npm test group)", async (t) => {
  const child = spawn(path.join(import.meta.dirname, "no-such-binary-rl"), [], { detached: true, stdio: "ignore" });
  await new Promise((r) => child.once("error", r));
  assert.equal(child.pid, undefined, "the spawn failed");
  const kill = t.mock.method(process, "kill", () => true);
  for (const pid of [child.pid, 0, 1, -1, -42, Number.NaN, 1.5, "123", null]) {
    assert.equal(signalPid(pid, "SIGKILL", { group: true }), false, `group ${String(pid)}`);
    assert.equal(signalPid(pid, "SIGKILL"), false, `single ${String(pid)}`);
    assert.equal(isRealPid(pid), false);
  }
  assert.equal(kill.mock.callCount(), 0, "process.kill was never called");
  kill.mock.restore();
});

test("R3: the helper does signal a real child, by pid or by group", async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const exited = new Promise((r) => child.once("exit", (_c, sig) => r(sig)));
  assert.ok(isRealPid(child.pid));
  assert.equal(signalPid(child.pid, 0), true, "alive");
  assert.equal(signalPid(child.pid, "SIGKILL", { group: true }), true);
  assert.equal(await exited, "SIGKILL");
});

test("R3: no test or script signals a process group outside the guarded helpers", () => {
  const root = path.resolve(import.meta.dirname, "..", "..");
  /** @type {string[]} */
  const hits = [];
  for (const dir of ["test", "scripts"]) {
    for (const rel of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      const f = path.join(dir, String(rel));
      if (!f.endsWith(".mjs") || f.includes(`${path.sep}fixtures${path.sep}`) || f === path.join("test", "contract", "signal-helper.test.mjs")) continue;
      const text = fs.readFileSync(path.join(root, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\.pid \?\? 0\b/.test(line)) hits.push(`${f}:${i + 1} pid ?? 0`);
        if (/process\.kill\(-/.test(line) && !/Number\.isInteger\(child\.pid\) && Number\(child\.pid\) > 1/.test(line) && f !== path.join("test", "fakes", "signal.mjs")) hits.push(`${f}:${i + 1} unguarded group kill`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
