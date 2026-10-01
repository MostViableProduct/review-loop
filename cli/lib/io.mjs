import readline from "node:readline/promises";

/** @typedef {{ out: (s: string) => void, err: (s: string) => void, ask: (q: string, def: boolean) => Promise<boolean>,
 *   choose: (q: string, options: string[], def: string) => Promise<string>, isTTY: boolean, color: boolean,
 *   env: Record<string, string | undefined> }} IO */

/** @returns {IO} */
export function realIO() {
  const isTTY = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const color = isTTY && !process.env.NO_COLOR;
  const rl = () => readline.createInterface({ input: process.stdin, output: process.stderr });
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    isTTY, color, env: process.env,
    async ask(q, def) {
      const r = rl();
      try {
        const a = (await r.question(`${q} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
        return a === "" ? def : a === "y" || a === "yes";
      } finally { r.close(); }
    },
    async choose(q, options, def) {
      const r = rl();
      try {
        const a = (await r.question(`${q} (${options.map((o) => (o === def ? `${o}*` : o)).join("/")}) `)).trim().toLowerCase();
        return a === "" ? def : options.includes(a) ? a : def;
      } finally { r.close(); }
    }
  };
}

/** Status words are always printed, so meaning never depends on color (screen readers, NO_COLOR). @param {"pass"|"fail"|"warn"|"skip"} s @param {boolean} color */
export function mark(s, color) {
  const word = { pass: "✓ OK  ", fail: "✗ FAIL", warn: "! WARN", skip: "- SKIP" }[s];
  if (!color) return word;
  const c = { pass: 32, fail: 31, warn: 33, skip: 90 }[s];
  return `\u001b[${c}m${word}\u001b[0m`;
}
