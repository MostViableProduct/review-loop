import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1"
};

/** @param {string} cwd @param {...string} args */
export function g(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

export function tmpDir(prefix = "rl-") {
  // realpath: macOS /var → /private/var, so paths compare equal to git's --show-toplevel.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** @param {string} [dir] */
export function makeRepo(dir = tmpDir()) {
  g(dir, "init", "-q");
  return dir;
}

/** @param {string} repo @param {string} rel @param {string} content @param {string} [msg] */
export function commitFile(repo, rel, content, msg = `edit ${rel}`) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  g(repo, "add", "--", rel);
  g(repo, "commit", "-q", "-m", msg);
  return g(repo, "rev-parse", "HEAD");
}

/** @param {string} repo @param {string} rel @param {string} content */
export function writeFile(repo, rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/**
 * Criss-cross history: two best merge-bases (X1 and Y1).
 * @returns {{ repo: string, x: string, y: string }}
 */
export function crissCrossRepo() {
  const repo = makeRepo();
  commitFile(repo, "a.txt", "A");
  g(repo, "branch", "y");
  commitFile(repo, "x.txt", "X1");
  const x1 = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "y");
  commitFile(repo, "y.txt", "Y1");
  const y1 = g(repo, "rev-parse", "HEAD");
  g(repo, "merge", "-q", "--no-edit", "--no-ff", x1);
  const y2 = g(repo, "rev-parse", "HEAD");
  g(repo, "checkout", "-q", "main");
  g(repo, "merge", "-q", "--no-edit", "--no-ff", y1);
  const x2 = g(repo, "rev-parse", "HEAD");
  return { repo, x: x2, y: y2 };
}
