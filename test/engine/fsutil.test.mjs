import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { safeReadFile, atomicWriteJson, atomicWriteText, readJsonValidated, isObject, MiB } from "../../plugin/engine/lib/fsutil.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rl-fs-"));

test("safeReadFile reads a regular file", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "a.md"), "hello");
  assert.equal(safeReadFile(path.join(d, "a.md"), 100).toString(), "hello");
});

test("safeReadFile rejects a symlink without opening its target", (t) => {
  const d = tmp();
  const secret = path.join(d, "secret.txt");
  fs.writeFileSync(secret, "TOP SECRET");
  fs.symlinkSync(secret, path.join(d, "spec.md"));
  const opened = [];
  const realOpen = fs.openSync;
  t.mock.method(fs, "openSync", (p, ...rest) => {
    opened.push(String(p));
    return realOpen(p, ...rest);
  });
  assert.throws(() => safeReadFile(path.join(d, "spec.md"), 1000), { code: "artifact_symlink_rejected" });
  assert.deepEqual(opened, [], "no file may be opened for a symlinked artifact");
});

test("safeReadFile within: a symlinked parent below the root is rejected; a link above the root is the trust anchor", (t) => {
  const d = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "notes.md"), "SECRET");
  fs.mkdirSync(path.join(d, "docs"));
  fs.symlinkSync(outside, path.join(d, "docs", "specs"));
  const opened = [];
  const realOpen = fs.openSync;
  t.mock.method(fs, "openSync", (p, ...rest) => {
    opened.push(String(p));
    return realOpen(p, ...rest);
  });
  assert.throws(() => safeReadFile(path.join(d, "docs/specs/notes.md"), 100, {}, { within: d }), { code: "artifact_symlink_rejected" });
  assert.deepEqual(opened, [], "the linked-to file must never be opened");
  assert.equal(safeReadFile(path.join(d, "docs/specs/notes.md"), 100).toString(), "SECRET", "control: without `within` only the last component is checked");

  fs.mkdirSync(path.join(d, "real"));
  fs.writeFileSync(path.join(d, "real", "ok.md"), "ok");
  fs.symlinkSync(d, path.join(outside, "anchor"));
  assert.equal(safeReadFile(path.join(outside, "anchor", "real", "ok.md"), 100, {}, { within: path.join(outside, "anchor") }).toString(), "ok");
  assert.throws(() => safeReadFile(path.join(outside, "notes.md"), 100, {}, { within: d }), { code: "artifact_outside_root" });
});

test("safeReadFile within: a parent swapped to a link and back around the open is caught after the open", (t) => {
  const d = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "notes.md"), "SECRET");
  fs.mkdirSync(path.join(d, "docs", "specs"), { recursive: true });
  const target = path.join(d, "docs", "specs", "notes.md");
  fs.writeFileSync(target, "inside");
  const specs = path.join(d, "docs", "specs");
  const realOpen = fs.openSync;
  const readSync = t.mock.method(fs, "readSync");
  t.mock.method(fs, "openSync", (p, ...rest) => {
    // The attacker's window: after the parent walk, before the open — and put back before anyone looks again.
    fs.renameSync(specs, `${specs}.real`);
    fs.symlinkSync(outside, specs);
    try {
      return realOpen(p, ...rest);
    } finally {
      fs.rmSync(specs);
      fs.renameSync(`${specs}.real`, specs);
    }
  });
  assert.throws(() => safeReadFile(target, 100, {}, { within: d }), { code: "artifact_symlink_rejected" });
  assert.equal(readSync.mock.callCount(), 0, "the outside file's bytes are never read");
});

test("safeReadFile: a FIFO swapped in after lstat is rejected without blocking", (t) => {
  const d = tmp();
  const target = path.join(d, "spec.md");
  fs.writeFileSync(target, "regular");
  const realOpen = fs.openSync;
  t.mock.method(fs, "openSync", (p, ...rest) => {
    fs.rmSync(target);
    execFileSync("mkfifo", [target]);
    return realOpen(p, ...rest);
  });
  assert.throws(() => safeReadFile(target, 100), { code: "artifact_not_regular_file" });
});

test("safeReadFile rejects oversize before reading", (t) => {
  const d = tmp();
  const big = path.join(d, "big.md");
  fs.writeFileSync(big, Buffer.alloc(MiB + 1, 0x61));
  const readSync = t.mock.method(fs, "readSync");
  assert.throws(() => safeReadFile(big, MiB), { code: "artifact_too_large" });
  assert.equal(readSync.mock.callCount(), 0, "an oversize file must never be read");
});

test("safeReadFile uses caller-supplied error codes", () => {
  const d = tmp();
  fs.symlinkSync("/etc/hosts", path.join(d, "shallow"));
  assert.throws(() => safeReadFile(path.join(d, "shallow"), 10, { symlink: "shallow_file_symlink" }), {
    code: "shallow_file_symlink"
  });
});

test("atomicWriteJson writes 0600 and leaves no temp files", () => {
  const d = tmp();
  const file = path.join(d, "nested", "r.json");
  atomicWriteJson(file, { a: 1 }, d);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["r.json"]);
});

test("atomicWriteText writes the exact bytes 0600; atomicWriteJson is its pretty-printed delegate", () => {
  const d = tmp();
  const text = '{"version":1,  "odd": "spacing"}';
  atomicWriteText(path.join(d, "t.json"), text, d);
  assert.equal(fs.readFileSync(path.join(d, "t.json"), "utf8"), text);
  assert.equal(fs.statSync(path.join(d, "t.json")).mode & 0o777, 0o600);
  atomicWriteJson(path.join(d, "j.json"), { a: 1 }, d);
  assert.equal(fs.readFileSync(path.join(d, "j.json"), "utf8"), '{\n  "a": 1\n}\n');
  assert.deepEqual(fs.readdirSync(d).sort(), ["j.json", "t.json"]);
});

test("readJsonValidated quarantines parseable-but-invalid state", () => {
  const d = tmp();
  const file = path.join(d, "r.json");
  fs.writeFileSync(file, JSON.stringify({ status: 42 }));
  const v = readJsonValidated(file, (x) => isObject(x) && typeof x.status === "string", d);
  assert.equal(v, null);
  assert.ok(fs.readdirSync(d).some((n) => n.startsWith("r.json.corrupt-")));
  assert.ok(!fs.existsSync(file));
});

test("readJsonValidated: a symlinked state file is quarantined as a link; the outside target's mode and bytes are untouched", () => {
  const d = tmp();
  const outside = path.join(tmp(), "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ status: "ok" }), { mode: 0o644 });
  fs.chmodSync(outside, 0o644);
  const file = path.join(d, "r.json");
  fs.symlinkSync(outside, file);
  assert.equal(readJsonValidated(file, isObject, d), null);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(outside, "utf8"), JSON.stringify({ status: "ok" }));
  assert.ok(fs.readdirSync(d).some((n) => n.startsWith("r.json.corrupt-")));
});

test("readJsonValidated: a dangling symlink state file does not throw and reads as absent", () => {
  const d = tmp();
  const file = path.join(d, "r.json");
  fs.symlinkSync(path.join(d, "nowhere.json"), file);
  assert.equal(readJsonValidated(file, isObject, d), null);
});

test("readJsonValidated returns null for a missing file without quarantining", () => {
  const d = tmp();
  assert.equal(readJsonValidated(path.join(d, "none.json"), isObject, d), null);
  assert.deepEqual(fs.readdirSync(d), []);
});

test("quarantine re-checks the parents: a dir swapped to a link after the read is never renamed through", () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "r.json"), "{}");
  fs.mkdirSync(path.join(root, "records"));
  fs.writeFileSync(path.join(root, "records", "r.json"), "{}");
  const swapThenReject = () => {
    fs.renameSync(path.join(root, "records"), path.join(root, "records.real"));
    fs.symlinkSync(outside, path.join(root, "records"));
    return false;
  };
  assert.throws(() => readJsonValidated(path.join(root, "records", "r.json"), (v) => swapThenReject() && isObject(v), root), { code: "state_symlink_rejected" });
  assert.deepEqual(fs.readdirSync(outside), ["r.json"], "the outside file was not quarantine-renamed");
});

test("L1: quarantine never chmods through a link swapped in after the rename (before or after any check of it)", (t) => {
  for (const swapOn of ["renameSync", "lstatSync"]) {
    const d = tmp();
    const outside = path.join(tmp(), "outside.json");
    fs.writeFileSync(outside, "{}");
    fs.chmodSync(outside, 0o644);
    const file = path.join(d, "r.json");
    fs.writeFileSync(file, JSON.stringify({ status: 42 }), { mode: 0o644 });
    const swap = (/** @type {string} */ dest) => {
      fs.rmSync(dest);
      fs.symlinkSync(outside, dest);
    };
    const orig = swapOn === "renameSync" ? fs.renameSync : fs.lstatSync;
    let swapped = false;
    const spy = t.mock.method(fs, swapOn, (/** @type {string} */ a, /** @type {unknown} */ b) => {
      const r = /** @type {(x: string, y: unknown) => unknown} */ (orig)(a, b);
      const dest = swapOn === "renameSync" ? String(b) : String(a);
      if (!swapped && dest.includes(".corrupt-") && fs.existsSync(dest)) {
        swapped = true;
        swap(dest);
      }
      return r;
    });
    assert.equal(readJsonValidated(file, (x) => isObject(x) && typeof x.status === "string", d), null);
    spy.mock.restore();
    // The rename always runs, so that race is always staged; the lstat one only when quarantine checks the path.
    if (swapOn === "renameSync") assert.ok(swapped, "the race was staged");
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644, `${swapOn}: the link target's mode is untouched`);
  }
});

test("atomicWriteJson detects a parent swapped to a link mid-write: a redirected temp is removed, never renamed in", (t) => {
  const root = tmp();
  const outside = tmp();
  const dir = path.join(root, "records");
  const swap = () => {
    fs.renameSync(dir, `${dir}.real`);
    fs.symlinkSync(outside, dir);
  };
  const restore = () => {
    fs.rmSync(dir);
    fs.renameSync(`${dir}.real`, dir);
  };
  fs.mkdirSync(dir);
  const realOpen = fs.openSync;
  let armed = true;
  const open = t.mock.method(fs, "openSync", (p, ...rest) => {
    if (armed && String(p).endsWith(".tmp")) {
      armed = false;
      swap();
    }
    return realOpen(p, ...rest);
  });
  assert.throws(() => atomicWriteJson(path.join(dir, "r.json"), { a: 1 }, root), { code: "state_symlink_rejected" });
  open.mock.restore();
  assert.deepEqual(fs.readdirSync(outside), [], "the temp created through the link was removed");
  restore();

  const realRename = fs.renameSync;
  armed = true;
  const rename = t.mock.method(fs, "renameSync", (from, to) => {
    realRename(from, to);
    if (armed && String(to).endsWith("w.json")) {
      armed = false;
      swap();
    }
  });
  assert.throws(() => atomicWriteJson(path.join(dir, "w.json"), { a: 1 }, root), { code: "state_symlink_rejected" }, "a swap after the rename is reported, not silent");
  rename.mock.restore();
});

test("state under a linked directory is never read, renamed or written through the link", () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "r.json"), "not json — would be quarantined if reached");
  fs.writeFileSync(path.join(outside, "ok.json"), "{}");
  fs.symlinkSync(outside, path.join(root, "records"));
  assert.throws(() => readJsonValidated(path.join(root, "records", "r.json"), isObject, root), { code: "state_symlink_rejected" });
  assert.throws(() => readJsonValidated(path.join(root, "records", "ok.json"), isObject, root), { code: "state_symlink_rejected" }, "valid JSON outside is not state");
  assert.throws(() => atomicWriteJson(path.join(root, "records", "w.json"), { a: 1 }, root), { code: "state_symlink_rejected" });
  assert.deepEqual(fs.readdirSync(outside).sort(), ["ok.json", "r.json"], "the outside files were neither renamed nor joined by a write");
  fs.writeFileSync(path.join(root, "direct.json"), "{}");
  assert.deepEqual(readJsonValidated(path.join(root, "direct.json"), isObject, root), {}, "control: an unlinked path reads");
});
