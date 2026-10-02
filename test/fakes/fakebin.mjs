// A fake CLI for tests: answers from a response map keyed by the joined argv and records every call.
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} dir directory to put on PATH
 * @param {string} name executable name (gh, claude, codex, ps, lsof)
 * @param {Record<string, FakeResponse | FakeResponse[]>} responses keys: argv joined by " ", or "*". An array is
 *   consumed in order, one entry per call, and its last entry repeats (models "installed, then removed").
 * @returns {{ log(): string[][], set(responses: Record<string, FakeResponse | FakeResponse[]>): void }} `log` returns every
 *   recorded argv; `set` replaces the response map and resets the per-key call counts, so the next call answers from it.
 */
export function makeFakeBin(dir, name, responses) {
  fs.mkdirSync(dir, { recursive: true });
  const map = path.join(dir, `${name}.responses.json`);
  const log = path.join(dir, `${name}.log.jsonl`);
  const counts = path.join(dir, `${name}.counts.json`);
  fs.writeFileSync(map, JSON.stringify(responses));
  fs.writeFileSync(log, "");
  fs.writeFileSync(counts, "{}");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const map = JSON.parse(fs.readFileSync(${JSON.stringify(map)}, "utf8"));
const key = Object.hasOwn(map, args.join(" ")) ? args.join(" ") : Object.hasOwn(map, "*") ? "*" : null;
let hit = key === null ? { code: 1, stderr: "fake " + ${JSON.stringify(name)} + ": no response for " + args.join(" ") } : map[key];
if (Array.isArray(hit)) {
  const c = JSON.parse(fs.readFileSync(${JSON.stringify(counts)}, "utf8"));
  const i = c[key] ?? 0;
  c[key] = i + 1;
  fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify(c));
  hit = hit[Math.min(i, hit.length - 1)];
}
if (hit.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hit.delayMs);
if (hit.stdout) process.stdout.write(hit.stdout);
if (hit.stderr) process.stderr.write(hit.stderr);
process.exitCode = hit.code ?? 0; // not process.exit(): a piped stdout would be cut short
`;
  fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  return {
    log: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    set: (/** @type {Record<string, FakeResponse | FakeResponse[]>} */ r) => { fs.writeFileSync(map, JSON.stringify(r)); fs.writeFileSync(counts, "{}"); }
  };
}
/** @typedef {{ code?: number, stdout?: string, stderr?: string, delayMs?: number }} FakeResponse */
