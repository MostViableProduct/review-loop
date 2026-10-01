import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ReviewLoopError } from "./errors.mjs";

export const MiB = 1024 * 1024;

/** @param {Buffer | string} data */
export function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** @param {string} filePath @param {string} root @param {string} code */
export function assertNoLinkedParent(filePath, root, code) {
  const rel = path.relative(root, path.dirname(filePath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ReviewLoopError("artifact_outside_root", `${filePath}: outside ${root}`, { path: filePath });
  }
  let cur = root;
  for (const part of rel === "" ? [] : rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return; // A missing parent surfaces as the file's own `missing` code below.
    }
    if (st.isSymbolicLink()) throw new ReviewLoopError(code, `${filePath}: parent ${cur} is a symlink; never followed`, { path: filePath });
  }
}

/**
 * lstat → reject symlink → bound size → open with O_NOFOLLOW → read. Never follows a link,
 * never buffers more than maxBytes.
 * `within`: every directory between this trusted root and the file is lstat'ed too — O_NOFOLLOW only guards the
 * final component, so a symlinked parent (`docs/specs -> ~/.ssh`) would otherwise be followed. The root itself is
 * the trust anchor and may be reached through links (macOS `/var -> /private/var`).
 * @param {string} filePath
 * @param {number} maxBytes
 * @param {{ symlink?: string, linkedParent?: string, tooLarge?: string, missing?: string, notFile?: string }} [codes]
 * @param {{ within?: string }} [opts]
 * @returns {Buffer}
 */
export function safeReadFile(filePath, maxBytes, codes = {}, opts = {}) {
  const symlinkCode = codes.symlink ?? "artifact_symlink_rejected";
  const parentCode = codes.linkedParent ?? symlinkCode;
  if (opts.within !== undefined) assertNoLinkedParent(filePath, opts.within, parentCode);
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    throw new ReviewLoopError(codes.missing ?? "artifact_missing", `${filePath}: not found`, { path: filePath });
  }
  if (st.isSymbolicLink()) {
    throw new ReviewLoopError(codes.symlink ?? "artifact_symlink_rejected", `${filePath}: symlinks are never followed`, { path: filePath });
  }
  if (!st.isFile()) {
    throw new ReviewLoopError(codes.notFile ?? "artifact_not_regular_file", `${filePath}: not a regular file`, { path: filePath });
  }
  if (st.size > maxBytes) {
    throw new ReviewLoopError(codes.tooLarge ?? "artifact_too_large", `${filePath}: ${st.size} bytes exceeds the ${maxBytes}-byte limit`, { path: filePath });
  }
  // O_NOFOLLOW closes the race where the path is swapped for a symlink between lstat and open.
  let fd;
  try {
    // O_NONBLOCK: a FIFO swapped in after lstat would otherwise block this synchronous open forever.
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    throw new ReviewLoopError(codes.symlink ?? "artifact_symlink_rejected", `${filePath}: could not open without following links`, { path: filePath });
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw new ReviewLoopError(codes.notFile ?? "artifact_not_regular_file", `${filePath}: not a regular file once opened`, { path: filePath });
    }
    if (opts.within !== undefined) {
      // Node has no openat(), so the walk above and the open are separate lookups. Re-verify after the open: the
      // parents are still link-free AND the path still names the inode we hold — a parent swapped to a link and
      // back around the open fails the inode match.
      assertNoLinkedParent(filePath, opts.within, parentCode);
      let now = null;
      try {
        now = fs.lstatSync(filePath);
      } catch {
        // Gone after the open: treated as a swap below.
      }
      if (!now || now.ino !== opened.ino || now.dev !== opened.dev) {
        throw new ReviewLoopError(symlinkCode, `${filePath}: changed while being opened; never read`, { path: filePath });
      }
    }
    const size = opened.size;
    if (size > maxBytes) {
      throw new ReviewLoopError(codes.tooLarge ?? "artifact_too_large", `${filePath}: ${size} bytes exceeds the ${maxBytes}-byte limit`, { path: filePath });
    }
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    // The file grew after fstat: refuse rather than silently truncate.
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, off) !== 0) {
      throw new ReviewLoopError(codes.tooLarge ?? "artifact_too_large", `${filePath}: grew while being read`, { path: filePath });
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create `dir` (0700) and hold every directory from `root` down to it to ours-and-private: mkdir's mode applies only
 * when it creates, so a pre-existing group/world-accessible directory is tightened, and one owned by another user is
 * refused. Below `root` a link is refused rather than followed — chmod would act on its target.
 * @param {string} dir
 * @param {string} [root] the trust anchor; it may itself be reached through links (macOS /var -> /private/var)
 */
export function ensurePrivateDir(dir, root = dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rel = path.relative(root, dir);
  const parts = rel === "" || rel.startsWith("..") ? [] : rel.split(path.sep);
  let cur = rel.startsWith("..") ? dir : root;
  for (let n = 0; n <= parts.length; n++) {
    if (n > 0) cur = path.join(cur, parts[n - 1]);
    const st = n === 0 ? fs.statSync(cur) : fs.lstatSync(cur);
    if (!st.isDirectory()) throw new ReviewLoopError("state_symlink_rejected", `${cur}: not a real directory; never used through`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new ReviewLoopError("state_dir_insecure", `${cur}: owned by uid ${st.uid}, not this user; refusing to keep review state there`);
    }
    if (st.mode & 0o077) fs.chmodSync(cur, 0o700);
  }
}

/** The exact text atomicWriteJson writes, so a caller can hash a write before making it. @param {unknown} value */
export const jsonText = (value) => JSON.stringify(value, null, 2) + "\n";

/** Write-then-rename of pretty-printed JSON (see atomicWriteText for the link-swap discussion). @param {string} file @param {unknown} value @param {string} within */
export function atomicWriteJson(file, value, within) {
  atomicWriteText(file, jsonText(value), within);
}

/**
 * Write-then-rename of exact bytes, so a concurrent reader sees the old file or the new one, never a partial one.
 * `within`: the state root; a linked directory below it would carry the write outside the state tree.
 * @param {string} file
 * @param {string} text
 * @param {string} within
 */
export function atomicWriteText(file, text, within) {
  ensurePrivateDir(path.dirname(file), within);
  assertNoLinkedParent(file, within, "state_symlink_rejected");
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Node has no openat()/renameat(), so a parent swapped to a link around these pathname calls can only be detected,
  // as in safeReadFile: re-walk before the rename (a temp redirected at open is removed, never renamed into place) and
  // after it (reported, never silent). No inode match on the final name: a concurrent writer's rename legitimately
  // replaces it. The window left (a swap between the last walk and rename) needs write access to the 0700 state tree,
  // i.e. the user's own privileges.
  try {
    assertNoLinkedParent(tmp, within, "state_symlink_rejected");
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.renameSync(tmp, file);
  assertNoLinkedParent(file, within, "state_symlink_rejected");
}

/**
 * Parse-then-validate. A malformed-but-parseable file is quarantined (renamed .corrupt-<ts>)
 * and treated as absent — it never reaches logic that assumes its shape.
 * A linked directory between `within` (the state root) and the file is not a corrupt file but a compromised tree:
 * it throws `state_symlink_rejected` — never read through, never renamed through, never silently "absent".
 * @template T
 * @param {string} file
 * @param {(v: unknown) => v is T} validate
 * @param {string} within
 * @param {number} [maxBytes]
 * @param {{ readOnly?: boolean }} [opts] readOnly: a damaged file still reads as absent but is left in place (doctor
 *   writes nothing); a linked parent still throws.
 * @returns {T | null}
 */
export function readJsonValidated(file, validate, within, maxBytes = 4 * MiB, opts = {}) {
  const aside = () => (opts.readOnly ? assertNoLinkedParent(file, within, "state_symlink_rejected") : quarantine(file, within));
  let raw;
  try {
    raw = safeReadFile(file, maxBytes, { missing: "state_missing", linkedParent: "state_symlink_rejected" }, { within });
  } catch (err) {
    if (err instanceof ReviewLoopError && err.code === "state_missing") return null;
    aside();
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    aside();
    return null;
  }
  if (!validate(parsed)) {
    aside();
    return null;
  }
  return parsed;
}

/**
 * Renames a damaged file aside (never following a link) and returns the new path, or null if it was already gone.
 * @param {string} file @param {string} within
 * @returns {string | null}
 */
export function quarantine(file, within) {
  assertNoLinkedParent(file, within, "state_symlink_rejected");
  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, dest);
  } catch {
    return null;
  }
  // Through an O_NOFOLLOW descriptor, not chmod(path): a quarantined symlink is renamed as a link, and a path check
  // before chmod would leave a window for a link to be swapped in; its target must never be chmodded.
  let fd;
  try {
    fd = fs.openSync(dest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (fs.fstatSync(fd).isFile()) fs.fchmodSync(fd, 0o600);
  } catch {
    // Best-effort, as the rename always was.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return dest;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
export function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
