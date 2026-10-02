import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const TAG = /@(?:type|param|arg|argument|returns?|typedef|template|property|prop|satisfies|this|enum|callback|throws|exception|yields|implements|augments|extends|member|var|const|constant)\s*\{/g;

/**
 * Every JSDoc type expression in `src`, with nesting (`{{ a: X }}`) and multi-line blocks handled by brace counting.
 * @param {string} src @returns {Array<{ expr: string, line: number }>}
 */
export function typeExprs(src) {
  const out = [];
  for (const m of src.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const block = m[0];
    for (const t of block.matchAll(TAG)) {
      let depth = 1;
      let i = /** @type {number} */ (t.index) + t[0].length;
      const from = i;
      for (; i < block.length && depth > 0; i++) depth += block[i] === "{" ? 1 : block[i] === "}" ? -1 : 0;
      const line = src.slice(0, /** @type {number} */ (m.index) + from).split("\n").length;
      out.push({ expr: block.slice(from, i - 1), line });
    }
  }
  return out;
}

const W = "an" + "y";  // built, so this file's own fixtures never match the scan below
// `*` and `?` are JSDoc's own spellings of the same type when they fill a whole type position; `?string` and `x?:` are
// not. Multi-line continuation stars are stripped first so they never read as a type.
const WILDCARD = /(?:^|[<{(\[,:|=])\s*[*?]\s*(?=$|[>})\],|=])/;
/** @param {string} expr */
const isAnyType = (expr) => {
  const e = expr.replace(/\n\s*\*(?!\/)/g, "\n");
  return new RegExp(`\\b${W}\\b`).test(e) || WILDCARD.test(e);
};
const hasAny = (/** @type {string} */ src) => typeExprs(src).some((t) => isAnyType(t.expr));

test("the scanner catches nested, generic and multi-line forms; ignores prose", () => {
  assert.ok(hasAny(`/** @param {{value: ${W}}} input */`));
  assert.ok(hasAny(`/** @type {Array<${W}>} */`));
  assert.ok(hasAny(`/** @returns {Record<string, ${W}>} */`));
  assert.ok(hasAny(`/**\n * @param {{\n *   deep: { inner: ${W} }\n * }} x\n */`));
  assert.ok(hasAny(`const y = /** @type {${W}} */ (x);`));
  assert.ok(!hasAny(`/** @param {{ many: string }} x ${W}thing, company, "${W}" in prose */`));
  assert.ok(!hasAny(`/** @type {unknown} */`));
});

test("the scanner catches the `*` and `?` spellings and ignores nullable/optional forms", () => {
  for (const t of ["*", "?", " * ", "Array<*>", "Record<string, ?>", "{ a: * }", "(string|*)", "Map<*, string>"]) assert.ok(hasAny(`/** @type {${t}} */`), t);
  assert.ok(hasAny(`/**\n * @param {{\n *   deep: *\n * }} x\n */`));
  for (const t of ["?string", "string?", "{ a?: string }", "Array<?number>", "function(): void"]) assert.ok(!hasAny(`/** @type {${t}} */`), t);
  assert.ok(!hasAny(`/**\n * @param {{\n *   deep: string\n * }} x\n */`), "continuation stars are not types");
});

test("the scanner covers every JSDoc tag that takes a type", () => {
  for (const tag of ["type", "param", "arg", "argument", "returns", "return", "typedef", "template", "property", "prop", "satisfies", "this", "enum", "callback", "throws", "exception", "yields", "implements", "augments", "extends", "member", "var", "const", "constant"]) {
    assert.ok(hasAny(`/** @${tag} {Array<${W}>} x */`), `@${tag}`);
  }
});

const files = (/** @type {string} */ d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).filter((f) => f.endsWith(".mjs") || f.endsWith(".js")).map((f) => path.join(d, f)) : []);

test("no `any` type in any source or test file", () => {
  const hits = [];
  for (const f of ["plugin", "cli", "scripts", "test"].flatMap(files)) {
    for (const t of typeExprs(fs.readFileSync(f, "utf8"))) if (isAnyType(t.expr)) hits.push(`${f}:${t.line}`);
  }
  assert.deepEqual(hits, []);
});
