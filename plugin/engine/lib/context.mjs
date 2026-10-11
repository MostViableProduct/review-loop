// The project's operating context (spec D1): one reader for the round and every gate, so they can't disagree about
// what the context is. A PR's comes from its base commit, never its head: a PR must not be able to declare its own
// risks accepted or its own actors trusted.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ReviewLoopError } from "./errors.mjs";
import { safeReadFile, sha256hex } from "./fsutil.mjs";
import { git, budgetMs } from "./git.mjs";
import { DIMENSIONS } from "./scoring.mjs";
import { TRUSTED_ACTORS, classKey } from "./value.mjs";

export const CONTEXT_REL = ".claude/review-context.md";
export const CONTEXT_MAX_BYTES = 8 * 1024;
const CODE = "review_context_invalid";
const AR_LINE = new RegExp(`^- (AR-\\d{1,3}) \\((\\d{4}-\\d{2}-\\d{2})\\) \\[(${DIMENSIONS.join("|")})\\] class=([^:;]{3,80}): (.+)$`);
const TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * @typedef {import("./value.mjs").AcceptedRisk} AcceptedRisk
 * @typedef {{ kind: "file", digest: string, text: string, trusted: string[], accepted: Map<string, AcceptedRisk> } | { kind: "default" } | { kind: "none" }} Context
 */

/** The path and the reason only: never the file's content. @param {string} why */
const invalid = (why) => new ReviewLoopError(CODE, `${CONTEXT_REL}: ${why}; fix or remove it`);

/**
 * The two kinds of line the engine reads; the rest is free Markdown passed to Codex verbatim.
 * @param {string} text
 * @returns {{ trusted: string[], accepted: Map<string, AcceptedRisk> }}
 */
export function parseContext(text) {
  /** @type {string[] | null} */
  let trusted = null;
  /** @type {Map<string, AcceptedRisk>} */
  const accepted = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Either delimiter would let the file's text close the focus's data block early (spec D1, "What Codex sees").
    if (line === "<<<CONTEXT" || line === "CONTEXT>>>") throw invalid("a line is one of the focus's context delimiters");
    const t = /^Trusted: (.+)$/.exec(line);
    if (t) {
      if (trusted !== null) throw invalid("it has more than one Trusted: line");
      trusted = t[1].split(",").map((s) => s.trim());
      if (!trusted.every((n) => TRUSTED_ACTORS.includes(n))) throw invalid(`Trusted: may list only ${TRUSTED_ACTORS.join(", ")}`);
      continue;
    }
    if (!line.startsWith("- AR-")) continue;
    const m = AR_LINE.exec(line);
    if (!m) throw invalid("an accepted-risk line does not match `- AR-<n> (<YYYY-MM-DD>) [<Dimension>] class=<label>: <text>`");
    if (accepted.has(m[1])) throw invalid("an accepted-risk id is defined twice");
    accepted.set(m[1], { dimension: m[3], classKey: classKey(m[3], m[4]), text: line });
  }
  return { trusted: trusted ?? [], accepted };
}

/** @param {string} text a strictly decoded file, BOM and all @param {string} digest the sha256 of its bytes @returns {Context} */
function fromText(text, digest) {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  return { kind: "file", digest, text: body, ...parseContext(body) };
}

/** @param {string} root @returns {Context} */
function fromTree(root) {
  const abs = path.join(root, CONTEXT_REL);
  let dir;
  let st;
  try {
    dir = fs.lstatSync(path.dirname(abs), { throwIfNoEntry: false });
    st = fs.lstatSync(abs, { throwIfNoEntry: false });
  } catch {
    throw invalid("its path cannot be looked up");
  }
  // safeReadFile refuses a linked .claude only once there is a file to read, so check the directory first: an absent
  // file behind a linked (or non-directory) .claude is refused, never taken for the default.
  if (dir !== undefined && !dir.isDirectory()) throw invalid("its .claude directory is a link or not a directory");
  if (st === undefined) return { kind: "default" };
  // Links on the path or below the root, non-regular files and the size are all checked before a byte is read.
  const buf = safeReadFile(abs, CONTEXT_MAX_BYTES, { missing: CODE, symlink: CODE, linkedParent: CODE, tooLarge: CODE, notFile: CODE }, { within: root });
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    throw invalid("it is not valid UTF-8");
  }
  return fromText(text, sha256hex(buf));
}

/** @param {string} root @param {string} baseSha @param {number | undefined} deadlineAt @returns {Promise<Context>} */
async function fromBase(root, baseSha, deadlineAt) {
  const read = async (/** @type {string[]} */ args, /** @type {number} */ maxBuffer) => {
    const r = await git(root, args, { timeoutMs: budgetMs(deadlineAt, 30_000), maxBuffer });
    // A slow or failed git call is operational, not the file's fault: it keeps its own code and retry rule.
    if (r.timedOut) throw new ReviewLoopError("command_timeout", `git ${args[0]} timed out reading the base commit ${baseSha.slice(0, 12)}`);
    if (r.code !== 0) throw new ReviewLoopError("git_failed", `git ${args[0]} exited ${r.code} reading the base commit ${baseSha.slice(0, 12)}`);
    return r.stdout;
  };
  const entry = (await read(["ls-tree", baseSha, "--", CONTEXT_REL], 4096)).split("\n")[0];
  if (!entry) return { kind: "default" };
  const m = TREE_ENTRY.exec(entry);
  if (!m) throw invalid("the base commit's tree entry is unreadable");
  const [, mode, type, oid] = m;
  // A link (120000), an executable, a tree or a submodule is refused before anything is read.
  if (mode !== "100644" || type !== "blob") throw invalid(`it is not a regular file at the base commit (mode ${mode})`);
  const size = Number((await read(["cat-file", "-s", oid], 64)).trim());
  if (!Number.isInteger(size) || size > CONTEXT_MAX_BYTES) throw invalid(`it is over ${CONTEXT_MAX_BYTES} bytes at the base commit`);
  const text = await read(["cat-file", "blob", oid], CONTEXT_MAX_BYTES + 1);
  // run() decodes git's output leniently, turning an invalid byte into U+FFFD. The text is the blob's exact bytes only
  // when it hashes back to the blob's own id, so that is the UTF-8 check, and a real U+FFFD in the file stays valid.
  const bytes = Buffer.from(text, "utf8");
  const id = crypto.createHash(oid.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (id !== oid) throw invalid("it is not valid UTF-8 at the base commit");
  return fromText(text, sha256hex(bytes));
}

/**
 * @param {{ kind: string }} identity
 * @param {string | null} root the project root; null for a spec or plan outside any project
 * @param {{ baseSha?: string, deadlineAt?: number }} [opts] a PR (`branch`) is read at `baseSha`, never the work tree
 * @returns {Promise<Context>}
 */
export async function readContext(identity, root, opts = {}) {
  if (!root) return { kind: "none" };
  if (identity.kind !== "branch") return fromTree(root);
  if (typeof opts.baseSha !== "string" || !SHA.test(opts.baseSha)) throw invalid("there is no base commit to read a PR's context from");
  return fromBase(root, opts.baseSha, opts.deadlineAt);
}

/** @param {Context} c */
export function contextDigest(c) {
  return c.kind === "file" ? c.digest : c.kind;
}

/**
 * A gate's view: the digest to compare with a record's `reviewedContext`, or "error" when the file is invalid
 * (review_context_invalid). No record ever stores "error" (a round, decide and override all fail instead), so an
 * invalid file never clears. Any other failure (a timeout, a failed git call) is thrown: it isn't the file's fault,
 * and each gate reports it with its own code and retry rule.
 * @param {{ kind: string }} identity @param {string | null} root @param {{ baseSha?: string, deadlineAt?: number }} [opts]
 */
export async function gateContextDigest(identity, root, opts = {}) {
  try {
    return contextDigest(await readContext(identity, root, opts));
  } catch (err) {
    if (err instanceof ReviewLoopError && err.code === CODE) return "error";
    throw err;
  }
}
