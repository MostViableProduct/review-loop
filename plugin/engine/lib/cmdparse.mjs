import path from "node:path";
import { ReviewLoopError } from "./errors.mjs";

/**
 * @typedef {{ text: string, unsafe: boolean, brace?: boolean }} Word
 *   unsafe = contains a shell expansion ($, backtick); brace = an unquoted brace expansion (`{a,b}`, `{x..y}`)
 */

/**
 * Quote-aware split into command segments. Never evaluates anything; expansions are only flagged.
 * @param {string} command
 * @returns {Word[][]}
 */
export function tokenize(command) {
  /** @type {Word[][]} */
  const segments = [[]];
  /** @type {Word | null} */
  let word = null;
  // Unquoted `{` groups open in the current word: true once the group holds an unquoted `,` or `..`.
  /** @type {boolean[]} */
  let braces = [];
  let dotAt = -2;
  const push = () => {
    if (word) segments[segments.length - 1].push(word);
    word = null;
    braces = [];
    dotAt = -2;
  };
  const cut = () => {
    push();
    if (segments[segments.length - 1].length) segments.push([]);
  };
  const cur = () => (word ??= { text: "", unsafe: false });

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) throw new ReviewLoopError("pr_args_unresolvable", "unterminated single quote");
      cur().text += command.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      const w = cur();
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\" && j + 1 < command.length && '"\\$`'.includes(command[j + 1])) {
          w.text += command[++j];
        } else {
          if (command[j] === "$" || command[j] === "`") w.unsafe = true;
          w.text += command[j];
        }
      }
      if (j >= command.length) throw new ReviewLoopError("pr_args_unresolvable", "unterminated double quote");
      i = j;
    } else if (c === "\\") {
      if (i + 1 < command.length && command[i + 1] !== "\n") cur().text += command[++i];
      else i += 1;
    } else if (c === "$" && command[i + 1] === "'" && command.indexOf("'", i + 2) !== -1 && !command.slice(i + 2, command.indexOf("'", i + 2)).includes("\\")) {
      // ANSI-C quoting with no escape is its literal text (`$'merge'` is `merge`); one with an escape is refused later.
      const end = command.indexOf("'", i + 2);
      cur().text += command.slice(i + 2, end);
      i = end;
    } else if (c === "$" || c === "`") {
      const w = cur();
      w.unsafe = true;
      w.text += c;
    } else if (c === "#" && word === null) {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
    } else if (";&|()\n".includes(c)) {
      cut();
    } else if (/\s/.test(c)) {
      push();
    } else {
      const w = cur();
      w.text += c;
      if (c === "{") braces.push(false);
      else if (braces.length > 0 && (c === "," || (c === "." && dotAt === i - 1))) braces[braces.length - 1] = true;
      else if (c === "}" && braces.pop()) w.brace = true;
      if (c === ".") dotAt = i;
    }
  }
  push();
  return segments.filter((s) => s.length > 0);
}

/** `gh pr new` is gh's built-in alias of `gh pr create`. */
const CREATE_SUBCOMMANDS = new Set(["create", "new"]);

/**
 * Cheap pre-filter shared by the hook fast path and the parser. Quotes and backslashes are dropped first because the
 * shell joins `c''reate` / `cr\eate` into `create`. Commands built at run time (variables, eval, scripts, user
 * aliases) are out of reach of any text check — the gate guards a cooperative agent, not deliberate evasion.
 * @param {string} command
 */
export function mentionsPrCreate(command) {
  return mentionsPrSubcommand(command) || mentionsApiPulls(command) || mentionsShellRewrite(command);
}

// Backslash-newline goes first, as a pair: the shell joins `cr\<newline>eate` into `create`, so dropping only the
// backslash would leave a newline splitting the word and the prefilter would miss the call.
const unquoted = (/** @type {string} */ command) => command.replace(/\\\n/g, "").replace(/['"\\]/g, "");
// The counters' words: the unquoted text cut at whitespace, shell operators, expansion marks and brace syntax, so
// `$(echo gh)`, `x=gh`, `{gh,api}` and `gh {pr,merge}` all yield their `gh`, `api`, `pr` and `merge` words.
const COUNT_WORD = /[^\s;&|()<>`${},]+/g;
// A gh command word: `gh`, `/usr/local/bin/gh`, `x=$(gh` … Case-insensitive: macOS resolves `GH` to gh.
const GH_WORD = /(^|\W)gh$/i;
// A word gh can only read as a subcommand name: a lowercase literal separated from the word before by whitespace
// alone. Anything else (a flag, a redirection `2>&1`, an expansion `$E`, a brace list) may vanish or be skipped.
const SUBCOMMAND_NAME = /^[a-z][a-z0-9-]*$/;

/** @typedef {ReadonlyArray<(word: string) => boolean>} Steps the subcommand's words, in order */
/** @type {Steps} */
const API_STEPS = [(w) => w === "api"];
/** @type {Steps} */
const PR_CREATE_STEPS = [(w) => w === "pr", (w) => CREATE_SUBCOMMANDS.has(w)];
/** @type {Steps} */
const PR_MERGE_STEPS = [(w) => w === "pr", (w) => w === "merge"];

/**
 * The `gh` command words in the unquoted text that may reach the subcommand `steps`. The count may over-count, never
 * under-count: each parser compares it with the calls it isolated, so a gh word this misses is a call nobody reads.
 * - A gh word counts when the words after it are the steps, in order. Before each step, a word that is not a plain
 *   subcommand name (a flag, a redirection, an expansion) lets the step appear anywhere later: gh (cobra) strips flags
 *   to find its subcommand, and which flags take a value, or how the splitter cut a value up, is never guessed.
 * - A plain name that is not the step stops the gh word: `gh pr create --title "Add api for pulls"` never reaches api.
 * - Each gh word is judged alone. No word resets another's count, so a `gh` inside a flag value cannot hide the call.
 * One right-to-left pass: `reach[l]` says the word at j starts a path through steps l…, `later[l]` that some word
 * after j does. Linear, as this runs on every Bash command.
 * @param {string} command
 * @param {Steps} steps
 */
function countGhCalls(command, steps) {
  const text = unquoted(command);
  /** @type {string[]} */
  const words = [];
  /** @type {boolean[]} */
  const plain = [];
  let end = 0;
  for (const m of text.matchAll(COUNT_WORD)) {
    words.push(m[0]);
    plain.push(SUBCOMMAND_NAME.test(m[0]) && /^\s*$/.test(text.slice(end, m.index)));
    end = m.index + m[0].length;
  }
  const last = steps.length - 1;
  let reach = steps.map(() => false);
  let later = steps.map(() => false);
  let hits = 0;
  for (let j = words.length - 1; j >= 0; j--) {
    if (GH_WORD.test(words[j]) && reach[0]) hits += 1;
    const here = steps.map((is, l) => (is(words[j]) && (l === last || reach[l + 1])) || (!plain[j] && later[l]));
    later = later.map((v, l) => v || here[l]);
    reach = here;
  }
  return hits;
}

// ---- shell rewriting the parsers cannot read: brace expansion, ANSI-C quoting, gh aliases ----

// bash's sequence expression `{x..y[..step]}`: single letters or integers. Matched on the unquoted text, so one inside
// `bash -c "…"` counts too; a list `{a,b}` is read from the tokenizer's quote state (`Word.brace`) instead, because
// jq and GraphQL bodies use comma lists in quotes.
const BRACE_SEQUENCE = /\{(-?\d+|[A-Za-z])\.\.(?:-?\d+|[A-Za-z])(?:\.\.-?\d+)?\}/;
const BRACE_SEQUENCES = new RegExp(BRACE_SEQUENCE.source, "g");
// `$'…'` with a backslash escape: `$'\155erge'` is `merge` to the shell. Matched on the raw text, nested strings too.
const ANSI_C_ESCAPE = /\$'[^']*\\/;
// A gh command word or subcommand, as the shell would see it once braces expand. `api.github.com` is a host, not `api`.
const GH_KEYWORD = /(?<![\w.])(?:gh|pr|api)(?![\w.])/i;

/**
 * The unquoted text names gh, pr or api, read as is and with brace syntax expanded the cheap way: each sequence
 * collapsed to its first element, then list braces and commas either dropped (`{p,}r` → `pr`) or spaced
 * (`{gh,api}` → `gh api`). So `{g..g}h`, `g{h..h}` and `{p..p}r` all count. Linear: three regex passes.
 * @param {string} t unquoted text
 */
function namesGh(t) {
  if (GH_KEYWORD.test(t)) return true;
  const seq = t.replace(BRACE_SEQUENCES, "$1");
  return GH_KEYWORD.test(seq.replace(/[{},]/g, "")) || GH_KEYWORD.test(seq.replace(/[{},]/g, " "));
}

/** @param {string} command */
function tokenBraces(command) {
  try {
    return tokenize(command).some((seg) => seg.some((w) => w.brace));
  } catch {
    return false;
  }
}

/**
 * Fast-path arm: a brace expansion or an escaped `$'…'` in a command that names gh, pr or api routes to the parsers,
 * whatever else the text says (`gh pr {m..m}erge 5` mentions no merge). Linear.
 * @param {string} command
 */
function mentionsShellRewrite(command) {
  const t = unquoted(command);
  if (!t.includes("{") && !command.includes("$'")) return false;
  if (!namesGh(t)) return false;
  return ANSI_C_ESCAPE.test(command) || BRACE_SEQUENCE.test(t) || tokenBraces(command);
}

const BODY_HINT = " (for a multi-line PR body use `--body-file <file>` or a quoted heredoc)";

/**
 * Refuse text the shell rewrites before gh runs, in a command that names gh, pr or api:
 * - a brace expansion anywhere, the command word included (`{gh,api} …`, `{g..g}h …`, `gh pr {m..m}erge 5`,
 *   `gh api …/merge {-X,} PUT`). gh placeholders (`{owner}`) have no `,` or `..`;
 * - an ANSI-C string with an escape (`gh pr $'\155erge' 5`). A plain `$'merge'` is read as its text;
 * - `gh alias set` / `gh alias import`: an alias the agent defines runs under a name no parser reads.
 * @param {Word[][]} segments
 * @param {string} command
 */
function assertNoShellRewrite(segments, command) {
  const t = unquoted(command);
  if (!namesGh(t)) return;
  if (segments.some((seg) => seg.some((w) => w.brace)) || BRACE_SEQUENCE.test(t)) {
    throw new ReviewLoopError("pr_args_unresolvable", `a brace expansion ({a,b} or {x..y}) in a gh command is rewritten by the shell before gh runs; spell the command out${BODY_HINT}`);
  }
  if (ANSI_C_ESCAPE.test(command)) {
    throw new ReviewLoopError("pr_args_unresolvable", `an ANSI-C string with an escape ($'\\…') in a gh command is rewritten by the shell before gh runs; spell the command out${BODY_HINT}`);
  }
}

/** @type {Steps} */
const ALIAS_STEPS = [(w) => w === "alias", (w) => w === "set" || w === "import"];

/**
 * True when the words match in this order, each word-bounded, anything between. One left-to-right pass, each search
 * resuming where the last one ended; the earliest hit for each word never rules out a later full match. The regex form
 * `\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b` backtracks super-linearly (7.5 s on a 19 KB command). That matters because this
 * runs on every Bash call, and a PreToolUse hook killed at its 40 s timeout does not block the call.
 * @param {string} text @param {readonly RegExp[]} words each with the g flag
 */
function inOrder(text, words) {
  let at = 0;
  for (const re of words) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) return false;
    at = m.index + m[0].length;
  }
  return true;
}
const W = Object.freeze({ gh: /\bgh\b/gi, alias: /\balias\b/g, aliasDefine: /\b(?:set|import)\b/g, pr: /\bpr\b/g,createOrNew: /\b(?:create|new)\b/g, api: /\bapi\b/g, merge: /\bmerge\b/g, slashMerge: /\/merge\b/gi });
const mentionsPrSubcommand = (/** @type {string} */ command) => inOrder(unquoted(command), [W.gh, W.pr, W.createOrNew]);
const mentionsApiPulls = (/** @type {string} */ command) => {
  const t = unquoted(command);
  // `%`: a percent-escape can spell the endpoint (`%67raphql` is GraphQL to GitHub), so the parser decodes and decides.
  return inOrder(t, [W.gh, W.api]) && /pulls|createPullRequest|graphql|%/i.test(t);
};

const API_FIELD_FLAGS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);
// `gh api --help`: the flags that take a value (-R/--repo too, since a pre-subcommand repo is passed in with them).
const API_VALUE_SHORT = new Set(["X", "F", "H", "q", "p", "f", "t", "R"]);
const API_VALUE_LONG = new Set(["--cache", "--field", "--header", "--hostname", "--input", "--jq", "--method", "--preview", "--raw-field", "--template", "--repo"]);

/**
 * Read `gh api` arguments the way gh's flag parser (pflag) does: glued values (`-XPOST`, `-X=POST`, `--method=POST`),
 * grouped shorthands (`-iX POST`) and separate values only for flags that take one. An unknown flag consumes nothing,
 * so the word after it stays a positional — every possible endpoint is checked (fails closed).
 * @param {string[]} texts
 */
export function readApiArgs(texts) {
  /** @type {Array<{ flag: string, value: string | null }>} */
  const flags = [];
  /** @type {string[]} */
  const positionals = [];
  for (let k = 0; k < texts.length; k++) {
    const t = texts[k];
    if (t === "--") {
      positionals.push(...texts.slice(k + 1));
      break;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      flags.push({ flag: name, value: eq !== -1 ? t.slice(eq + 1) : API_VALUE_LONG.has(name) ? texts[++k] ?? "" : null });
    } else if (t.startsWith("-") && t.length > 1) {
      for (let c = 1; c < t.length; c++) {
        if (!API_VALUE_SHORT.has(t[c])) {
          flags.push({ flag: `-${t[c]}`, value: null });
          continue;
        }
        const rest = t.slice(c + 1);
        flags.push({ flag: `-${t[c]}`, value: rest !== "" ? rest.replace(/^=/, "") : texts[++k] ?? "" });
        break;
      }
    } else {
      positionals.push(t);
    }
  }
  return { flags, positionals };
}

/**
 * `gh api` can open a PR without `gh pr create`: a POST to repos/o/r/pulls or a createPullRequest mutation.
 * gh api defaults to POST as soon as a field or --input is given.
 * @param {Word[]} args words after `gh api`
 */
function assertApiIsNotPrCreate(args) {
  const texts = args.map((w) => w.text);
  if (texts.some((t) => /createPullRequest/i.test(t))) {
    throw new ReviewLoopError("pr_via_api_unsupported", "a createPullRequest mutation bypasses the review gate; use `gh pr create`");
  }
  const { flags, positionals } = readApiArgs(texts);
  const has = (/** @type {string[]} */ names) => flags.filter((f) => names.includes(f.flag));
  const paths = positionals.map(decodedApiPath);
  const lastMethod = has(["-X", "--method"]).at(-1)?.value?.toUpperCase() ?? (flags.some((f) => API_FIELD_FLAGS.has(f.flag)) ? "POST" : "GET");
  if (paths.includes(null) && lastMethod !== "GET") {
    throw new ReviewLoopError("pr_via_api_unsupported", "a `gh api` endpoint with a malformed %-escape cannot be read by the review gate; spell the endpoint out");
  }
  if (paths.includes("graphql") && graphqlBodyUnreadable(args, flags)) {
    // A GraphQL body the gate cannot read could hold createPullRequest. Inline queries were checked above.
    throw new ReviewLoopError("pr_via_api_unsupported", "`gh api graphql` with a body the review gate cannot read (file, stdin or shell expansion) is denied; inline the query");
  }
  // Decoded, like the GraphQL route. Defensive: GitHub answers a REST `repos/o/r/%70ulls` with 404.
  const endpoint = positionals.find((_, i) => /(^|\/)pulls$/.test(paths[i] ?? ""));
  if (!endpoint) return;
  // gh keeps the LAST -X/--method, so reading any single occurrence could judge GET while POST is sent: refuse repeats.
  const methods = has(["-X", "--method"]);
  if (methods.length > 1) {
    throw new ReviewLoopError("pr_args_unresolvable", `\`gh api ${endpoint}\` sets its method more than once; pass one`);
  }
  const method = methods[0]?.value?.toUpperCase() ?? (flags.some((f) => API_FIELD_FLAGS.has(f.flag)) ? "POST" : "GET");
  if (method !== "GET") {
    throw new ReviewLoopError("pr_via_api_unsupported", `\`gh api ${endpoint}\` with ${method} creates a PR outside the review gate; use \`gh pr create\``);
  }
}

const VALUE_FLAGS = new Set([
  "-t", "--title", "-b", "--body", "-F", "--body-file", "-a", "--assignee", "-l", "--label",
  "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "--recover"
]);
const WANTED = { "--base": "base", "-B": "base", "--head": "head", "-H": "head", "--repo": "repo", "-R": "repo" };

/**
 * Find the `gh` call a segment runs, past `VAR=…`, `command` and `env` prefixes. `k` indexes the subcommand.
 * Flags before the subcommand: -R/--repo is kept in `pre`. Any other flag there stops isolation, and each parser's
 * text-hit accounting then refuses the command (we cannot tell that flag's value from the subcommand).
 * @param {Word[]} seg
 * @returns {{ ghRepoEnv: string | null, pre: Word[], k: number } | null}
 */
function locateGh(seg) {
  let i = 0;
  /** @type {string | null} */
  let ghRepoEnv = null;
  while (i < seg.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i].text) || seg[i].text === "command" || seg[i].text === "env")) {
    const m = /^GH_REPO=(.*)$/.exec(seg[i].text);
    if (m) {
      if (seg[i].unsafe) throw new ReviewLoopError("pr_args_unresolvable", "GH_REPO uses a shell expansion; pass a literal -R owner/repo");
      ghRepoEnv = m[1];
    }
    i += 1;
  }
  if (!(seg[i] && path.basename(seg[i].text).toLowerCase() === "gh")) return null;
  /** @type {Word[]} */
  const pre = [];
  let k = i + 1;
  for (; seg[k]?.text.startsWith("-"); k++) {
    const t = seg[k].text;
    if (t === "-R" || t === "--repo") pre.push(seg[k], seg[++k]);
    else if (/^(--repo=|-R.)/.test(t)) pre.push(seg[k]);
    else break;
  }
  return { ghRepoEnv, pre: pre.filter((w) => w !== undefined), k };
}

/**
 * Locate `gh pr create` and read --base/--head/--repo (and an inline GH_REPO=… assignment).
 * Any expansion, duplicate, or a `gh pr create` we cannot isolate cleanly → pr_args_unresolvable.
 * @param {string} command
 * @returns {null | { base: string | null, head: string | null, repo: string | null, ghRepoEnv: string | null }}
 */
export function parsePrCreate(command) {
  if (!mentionsPrCreate(command)) return null;
  const segments = tokenize(command);
  assertNoShellRewrite(segments, command);
  /** @type {Array<{ base: string | null, head: string | null, repo: string | null, ghRepoEnv: string | null }>} */
  const found = [];
  let helpSegments = 0;
  let apiSegments = 0;
  for (const seg of segments) {
    const call = locateGh(seg);
    if (!call) continue;
    const { ghRepoEnv, pre, k } = call;
    if (seg[k]?.text === "api") {
      assertApiIsNotPrCreate([...pre, ...seg.slice(k + 1)].filter((w) => w !== undefined));
      apiSegments += 1;
      continue;
    }
    if (!(seg[k]?.text === "pr" && CREATE_SUBCOMMANDS.has(seg[k + 1]?.text ?? ""))) continue;
    /** @type {{ base: string | null, head: string | null, repo: string | null }} */
    const out = { base: null, head: null, repo: null };
    const set = (/** @type {"base"|"head"|"repo"} */ k, /** @type {Word | undefined} */ w) => {
      if (!w) throw new ReviewLoopError("pr_args_unresolvable", `missing value for --${k}`);
      if (w.unsafe) throw new ReviewLoopError("pr_args_unresolvable", `--${k} uses a shell expansion; pass a literal value`);
      if (out[k] !== null) throw new ReviewLoopError("pr_args_unresolvable", `--${k} given more than once`);
      out[k] = w.text;
    };
    const args = [...pre, ...seg.slice(k + 2)];
    let help = false;
    for (let j = 0; j < args.length; j++) {
      const t = args[j].text;
      const eq = /^(--base|--head|--repo)=(.*)$/.exec(t);
      if (eq) {
        set(WANTED[/** @type {keyof typeof WANTED} */ (eq[1])], { text: eq[2], unsafe: args[j].unsafe });
      } else if (t in WANTED) {
        set(WANTED[/** @type {keyof typeof WANTED} */ (t)], args[++j]);
      } else if (/^-[BHR].+/.test(t)) {
        set(WANTED[/** @type {keyof typeof WANTED} */ (t.slice(0, 2))], { text: t.slice(2), unsafe: args[j].unsafe });
      } else if (VALUE_FLAGS.has(t)) {
        j += 1;
      } else if (t === "--help" || t === "-h") {
        help = true;
      }
    }
    if (help) helpSegments += 1;
    else found.push({ ...out, ghRepoEnv });
  }
  // Every text hit must be accounted for by an isolated segment (a creation, a help-only call, or a `gh api` call that
  // passed the POST check). A surplus hit sits inside something we cannot see through (`bash -c "…"`, a quoted word).
  // Counted per hit: one isolated harmless `gh api` must not vouch for a second, wrapped one.
  const textHits = countGhCalls(command, PR_CREATE_STEPS);
  const apiTextHits = countGhCalls(command, API_STEPS);
  const apiUnaccounted = mentionsApiPulls(command) && apiTextHits > apiSegments;
  if (textHits <= found.length + helpSegments && !apiUnaccounted) {
    if (found.length > 1) throw new ReviewLoopError("pr_args_unresolvable", "more than one PR creation in one command; run them separately");
    return found[0] ?? null;
  }
  const what = textHits > found.length + helpSegments ? "`gh pr create`" : "`gh api` touching pulls/graphql";
  throw new ReviewLoopError("pr_args_unresolvable", `found ${what} but could not isolate it as a plain command; run it directly`);
}

// ---- merges (spec §7.1 (3)) ----

const MERGE_MUTATIONS = /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest/;

/**
 * A GraphQL mutation that merges, enqueues or arms auto-merge for a pull request. Beyond the three known names, any
 * mutation whose identifier pairs "PullRequest" with "merge" or "enqueue" counts, so a renamed or new merge mutation
 * fails closed. Disabling auto-merge and dequeuing are not merges.
 * @param {string} text
 */
function graphqlMerges(text) {
  if (MERGE_MUTATIONS.test(text)) return true;
  if (!/\bmutation\b/i.test(text)) return false;
  for (const id of text.match(/[A-Za-z_]\w*/g) ?? []) {
    const l = id.toLowerCase();
    if (l.includes("pullrequest") && /merge|enqueue/.test(l) && !/^(?:disable|dequeue)/.test(l)) return true;
  }
  return false;
}

// Best effort (spec AC-23 scope): raw HTTP clients against GitHub's pulls/merge API. Token scans, never a
// `client[\s\S]*host…` regex, for the same backtracking reason as `inOrder`.
const RAW_CLIENT_WORD = /(?:^|[;&|()`/])(?:curl|wget|https?|xhs?)$/i;
const HTTPIE_WORD = /(?:^|[;&|()`/])(?:https?|xhs?)$/i;
// Case-insensitive, optional trailing dot and :443: all reach the same API.
const GITHUB_API_HOST = /api\.github\.com\.?(?::443)?\//i;
const PULLS_OR_MERGE = /\/(?:pulls|merge)\b/i;
const METHOD_WORD = /^(?:-[A-Za-z]*X=?|--request=|--method=)?(?:put|post|patch|delete)$/i;
const BODY_WORD = /^(?:-[A-Za-z]*[dFT]\S*|--(?:data[\w-]*|form[\w-]*|json|upload-file|post-data|post-file|body-data|body-file)(?:=\S*)?)$/;
// HTTPie/xh send a body (and so POST) as soon as one `field=value` or `field:=json` item follows the URL.
const HTTPIE_ITEM = /^[A-Za-z0-9_][\w.[\]-]*:?=(?!=)/;

/**
 * The words after the first raw-client word, and the one addressing GitHub's pulls or merge API, if any.
 * @param {string} text
 * @returns {{ rest: string[], target: string, httpie: boolean } | null}
 */
function rawClientCall(text) {
  // A brace sequence may spell the client or the host (`{c..c}url`, `{a..a}pi.github.com`): read it expanded.
  const words = text.replace(BRACE_SEQUENCES, "$1").split(/\s+/);
  const ci = words.findIndex((w) => RAW_CLIENT_WORD.test(w));
  if (ci === -1) return null;
  const rest = words.slice(ci + 1);
  const target = rest.find((w) => {
    const h = GITHUB_API_HOST.exec(w);
    return h !== null && PULLS_OR_MERGE.test(w.slice(h.index + h[0].length - 1));
  });
  return target === undefined ? null : { rest, target, httpie: HTTPIE_WORD.test(words[ci]) };
}

/**
 * A write (non-GET) through a raw client: a method word in any case (`-X PUT`, `-XPUT`, `--method=PUT`, HTTPie's
 * `put`), a body flag, or an HTTPie/xh data item. A read passes. null = not a write.
 * @param {string} text one segment's words
 * @returns {{ merge: boolean } | null}
 */
function rawClientWrite(text) {
  const c = rawClientCall(text);
  if (!c) return null;
  const write = c.rest.some((w) => METHOD_WORD.test(w) || BODY_WORD.test(w) || (c.httpie && HTTPIE_ITEM.test(w)));
  return write ? { merge: /\/merge\b/i.test(c.target) } : null;
}

/** Fast path for the PreToolUse hook: linear text tests before any parsing. @param {string} command */
export function mentionsMerge(command) {
  const t = unquoted(command);
  // The rewrite arm comes to the merge gate first, so it owns every rewrite refusal, a creation's included.
  return inOrder(t, [W.gh, W.pr, W.merge]) || mentionsApiMerge(t) || rawClientCall(t) !== null || inOrder(t, [W.gh, W.alias, W.aliasDefine]) || mentionsShellRewrite(command);
}

/**
 * The `gh api` and GraphQL arms of the fast path, on unquoted text: an api call then `/merge`; a percent-escape in a
 * `gh api` call (it may spell `/merge` or `pulls`); a GraphQL merge mutation anywhere; a placeholder next to pulls.
 * @param {string} t
 */
function mentionsApiMerge(t) {
  const ghApi = () => inOrder(t, [W.gh, W.api]);
  // `%`: an escape may spell the endpoint (`%67raphql`, `%70ulls`); a gh placeholder may expand to a merge path;
  // a GraphQL body the gate cannot read (`--input`, `=@file`, an expansion) may hold a merge mutation.
  const hint = /%/.test(t) || GH_PLACEHOLDER.test(t) || (/graphql/i.test(t) && /--input|=@|[$`]/.test(t));
  return inOrder(t, [W.api, W.slashMerge]) || graphqlMerges(t) || (hint && ghApi());
}

/**
 * @typedef {{ kind: "pr-merge", number: number | null, repo: string | null, ghRepoEnv: string | null, bind: string | null, auto: boolean, admin: boolean }} PrMerge
 * @typedef {{ kind: "api-merge", repo: string | null, ghRepoEnv: string | null, number: number, bind: string | null, input: boolean }} ApiMerge
 * @typedef {PrMerge | ApiMerge | { kind: "graphql-merge", unreadable: boolean } | { kind: "raw-client", merge: boolean }} Merge
 */

/** @param {string} what */
const unresolvable = (what) => new ReviewLoopError("pr_args_unresolvable", what);

// `gh pr merge --help` (plus the inherited -R/--repo and --help). "value" flags take one; the rest are booleans.
/** @type {ReadonlyMap<string, "value" | "bind" | "repo" | "bool" | "auto" | "admin" | "off">} */
const PR_MERGE_SHORT = new Map([["A", "value"], ["b", "value"], ["F", "value"], ["t", "value"], ["R", "repo"], ["d", "bool"], ["m", "bool"], ["r", "bool"], ["s", "bool"], ["h", "off"]]);
/** @type {ReadonlyMap<string, "value" | "bind" | "repo" | "bool" | "auto" | "admin" | "off">} */
const PR_MERGE_LONG = new Map([
  ["--author-email", "value"], ["--body", "value"], ["--body-file", "value"], ["--subject", "value"], ["--match-head-commit", "bind"],
  ["--repo", "repo"], ["--admin", "admin"], ["--auto", "auto"], ["--delete-branch", "bool"], ["--merge", "bool"], ["--rebase", "bool"],
  ["--squash", "bool"], ["--disable-auto", "off"], ["--help", "off"]
]);
const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** pflag's boolean values. @param {string} name @param {string | undefined} v */
function flagBool(name, v) {
  if (v === undefined || /^(?:1|t|T|true|TRUE|True)$/.test(v)) return true;
  if (/^(?:0|f|F|false|FALSE|False)$/.test(v)) return false;
  throw unresolvable(`${name} takes true or false`);
}

/**
 * `gh pr merge` arguments, read the way pflag reads them. Grouped shorthands are walked letter by letter: a boolean
 * letter continues, a value letter takes the rest of the word (or the next word), so `-st 5` is a subject of "5"
 * merging the current branch's PR, and `-sRx/y 5` names repo x/y. An unknown flag is refused rather than guessed.
 * null = the call merges nothing (`--help`, `--disable-auto`).
 * @param {Word[]} args words after `pr merge`, preceded by any pre-subcommand -R
 * @param {string | null} ghRepoEnv
 * @returns {PrMerge | null}
 */
function readPrMerge(args, ghRepoEnv) {
  /** @type {PrMerge} */
  const out = { kind: "pr-merge", number: null, repo: null, ghRepoEnv, bind: null, auto: false, admin: false };
  /** @type {string | null} */
  let target = null;
  let off = false;
  /** @param {string} name @param {"value" | "bind" | "repo" | "bool" | "auto" | "admin" | "off"} kind @param {Word | undefined} v */
  const take = (name, kind, v) => {
    if (!v) throw unresolvable(`missing value for ${name}`);
    if (kind === "value") return;
    const key = kind === "bind" ? "bind" : "repo";
    if (v.unsafe) throw unresolvable(`${name} uses a shell expansion; pass a literal value`);
    if (out[key] !== null) throw unresolvable(`${name} given more than once`);
    out[key] = v.text;
  };
  /** @param {Word} w */
  const positional = (w) => {
    if (w.unsafe) throw unresolvable("the PR argument uses a shell expansion; pass a literal PR number");
    if (target !== null) throw unresolvable("more than one PR named; merge one PR per command");
    target = w.text;
  };
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    const a = w.text;
    if (a === "--") {
      args.slice(j + 1).forEach(positional);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      const inline = eq === -1 ? undefined : a.slice(eq + 1);
      const kind = PR_MERGE_LONG.get(name);
      if (!kind) throw unresolvable(`unknown flag ${name} for \`gh pr merge\``);
      if (kind === "value" || kind === "bind" || kind === "repo") take(name, kind, inline !== undefined ? { text: inline, unsafe: w.unsafe } : args[++j]);
      else if (kind === "auto") out.auto = flagBool(name, inline);
      else if (kind === "admin") out.admin = flagBool(name, inline);
      else if (kind === "off") off = flagBool(name, inline) || off;
      else flagBool(name, inline);
    } else if (a.startsWith("-") && a.length > 1) {
      for (let c = 1; c < a.length; c++) {
        const kind = PR_MERGE_SHORT.get(a[c]);
        if (!kind) throw unresolvable(`unknown shorthand flag -${a[c]} for \`gh pr merge\``);
        if (kind === "off") off = true;
        if (kind !== "value" && kind !== "repo") continue;
        const rest = a.slice(c + 1).replace(/^=/, "");
        take(`-${a[c]}`, kind, rest !== "" ? { text: rest, unsafe: w.unsafe } : args[++j]);
        break;
      }
    } else {
      positional(w);
    }
  }
  if (off) return null;
  /** @type {string | null} */
  const named = target;
  const url = named === null ? null : PR_URL.exec(named);
  if (url) {
    out.repo = url[1];
    out.number = Number(url[2]);
  } else if (named !== null && /^#?\d+$/.test(named)) {
    out.number = Number(named.replace("#", ""));
  }
  return out;
}

/** @param {string} s */
function decoded(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A `gh api` endpoint's path, as gh sends it: a full URL may spell the API host in any case, with a trailing dot or
 * :443; a `#fragment` never reaches the server; leading and trailing slashes don't change the route (`/graphql`,
 * `graphql/` and `https://api.github.com/graphql` are all `graphql`). `query` says a `?…` was present.
 * @param {string} endpoint
 * @returns {{ path: string, query: boolean }}
 */
function apiPath(endpoint) {
  const local = endpoint.replace(/^https?:\/\/api\.github\.com\.?(?::443)?\//i, "").split("#")[0];
  const q = local.indexOf("?");
  return { path: trimSlashes(q === -1 ? local : local.slice(0, q)), query: q !== -1 };
}

/** An index loop: the regex `/^\/+|\/+$/g` is quadratic on a long run of slashes (10 s at 80 KB). @param {string} s */
function trimSlashes(s) {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === "/") a += 1;
  while (b > a && s[b - 1] === "/") b -= 1;
  return s.slice(a, b);
}

/**
 * The endpoint's path as GitHub routes it: percent-decoded, slashes trimmed, lower-cased. `%67raphql` and `graphq%6C`
 * are `graphql`. null when an escape is malformed: the gate cannot read it, so a non-GET call fails closed.
 * @param {string} endpoint
 */
function decodedApiPath(endpoint) {
  try {
    return trimSlashes(decodeURIComponent(apiPath(endpoint).path)).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A GraphQL body the gate cannot read, which could hold any mutation: `--input` (file or stdin), `-F`/`--field k=@file`,
 * or a shell expansion.
 * @param {Word[]} args @param {Array<{ flag: string, value: string | null }>} flags
 */
function graphqlBodyUnreadable(args, flags) {
  return flags.some((f) => f.flag === "--input" || ((f.flag === "-F" || f.flag === "--field") && /^[^=]*=@/.test(f.value ?? ""))) || args.some((w) => w.unsafe);
}

// gh's own placeholder pattern (`gh api`): `{owner}`, `{repo}`, `{branch}` … and the older `:owner`, `:repo`, `:branch`.
const GH_PLACEHOLDER = /\{[a-z]+\}|:(?:owner|repo|branch)\b/;
const OWNER_REPO_PLACEHOLDER = /^repos\/(?:\{owner\}|:owner)\/(?:\{repo\}|:repo)(?=\/|$)/;
/**
 * Any placeholder other than owner/repo, anywhere in the path: `repos/o/r/{branch}` or `repos/o/r/pull:branch` can
 * expand to `…/pulls/5/merge` (a branch may be named `pulls/5/merge`), which the gate cannot read.
 * @param {string} path
 */
const otherPlaceholder = (path) => (path.match(new RegExp(GH_PLACEHOLDER.source, "g")) ?? []).some((p) => !/^(?:\{owner\}|\{repo\}|:owner|:repo)$/.test(p));

/**
 * `gh api` touching a merge endpoint. A read (effective method GET: "is it merged?") is not a merge. Any other method
 * is: a canonical `repos/<o>/<r>/pulls/<n>/merge` is gated by its `sha` field, and any other word containing `/merge`
 * (`repositories/<id>/…`, an encoded path, a second endpoint) is refused, because the gate cannot bind it.
 * `gh api` has no -R: `{owner}/{repo}` resolves from GH_REPO, then the current repository (`gh api --help`).
 * @param {Word[]} args words after `gh api`
 * @param {string | null} ghRepoEnv
 * @returns {ApiMerge | { kind: "graphql-merge", unreadable: boolean } | null}
 */
function readApiMerge(args, ghRepoEnv) {
  const texts = args.map((w) => w.text);
  const { flags, positionals } = readApiArgs(texts);
  const endpoint = positionals[0] ?? "";
  const ep = apiPath(endpoint);
  const route = decodedApiPath(endpoint);
  if (route === "graphql") {
    if (graphqlMerges(texts.join(" "))) return { kind: "graphql-merge", unreadable: false };
    return graphqlBodyUnreadable(args, flags) ? { kind: "graphql-merge", unreadable: true } : null;
  }
  const has = (/** @type {string[]} */ names) => flags.filter((f) => names.includes(f.flag));
  const fields = has(["-f", "-F", "--field", "--raw-field"]);
  // gh sends -f/-F as the JSON body of a non-GET call, whatever the endpoint: a merge mutation there is refused too.
  const graphqlBody = graphqlMerges(fields.map((f) => f.value ?? "").join(" "));
  const branchPlaceholder = otherPlaceholder(ep.path);
  const mergeWords = texts.filter((t) => /\/merge\b/i.test(t) || /\/merge\b/i.test(decoded(t)));
  if (!graphqlBody && !branchPlaceholder && route !== null && mergeWords.length === 0) return null;
  // gh keeps the LAST -X/--method, so reading any single occurrence could judge GET while PUT is sent: refuse repeats.
  const methods = has(["-X", "--method"]);
  if (methods.length > 1) throw unresolvable("`gh api` on a merge endpoint sets its method more than once; pass one");
  const method = methods[0]?.value?.toUpperCase() ?? (flags.some((f) => API_FIELD_FLAGS.has(f.flag)) ? "POST" : "GET");
  if (method === "GET") return null;
  if (graphqlBody) return { kind: "graphql-merge", unreadable: false };
  if (route === null) throw unresolvable("a `gh api` endpoint with a malformed %-escape cannot be read by the gate; spell the endpoint out");
  if (branchPlaceholder) throw unresolvable("a `{branch}`-style placeholder in a non-GET `gh api` endpoint can expand to a merge the gate cannot read; spell the endpoint out");
  const host = has(["--hostname"]).at(-1)?.value;
  if (host !== undefined && host !== null && host.toLowerCase().replace(/\.$/, "") !== "github.com") throw unresolvable("a merge through `gh api --hostname` is not on github.com; the gate cannot check it");
  const m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(ep.path);
  if (!m || mergeWords.length !== 1 || mergeWords[0] !== positionals[0]) {
    throw unresolvable("`gh api` merge call is not a plain repos/<owner>/<repo>/pulls/<n>/merge endpoint; call that endpoint directly");
  }
  // A query can carry its own sha (`merge?sha=<other>`) that the gate would not see next to -f sha: refuse any.
  if (ep.query) throw unresolvable("a query string on a merge endpoint is not read by the gate; pass the head with -f sha=<reviewed-sha> only");
  const placeholder = OWNER_REPO_PLACEHOLDER.test(`repos/${m[1]}`);
  if (!placeholder && /[{}:]/.test(m[1])) throw unresolvable("mixed {owner}/{repo} placeholders in a merge endpoint; name the repository");
  const shas = fields.filter((f) => (f.value ?? "").startsWith("sha="));
  if (shas.length > 1) throw unresolvable("the sha field is given more than once; pass one");
  // With --input, gh sends -f/-F as query parameters, so GitHub merges without the head check: nothing binds.
  const input = has(["--input"]).length > 0;
  return {
    kind: "api-merge",
    repo: placeholder ? null : m[1],
    ghRepoEnv,
    number: Number(m[2]),
    bind: shas.length && !input ? String(shas[0].value).slice(4) : null,
    input
  };
}

/**
 * Classify one Bash command as a merge. Every `gh pr merge` in the text must be an isolated call we read, as with
 * PR creation: one hidden inside `bash -c "…"` or behind a flag we cannot skip is refused, never waved through.
 * @param {string} command
 * @returns {null | Merge}
 */
export function parseMerge(command) {
  if (!mentionsMerge(command)) return null;
  const segments = tokenize(command);
  for (const seg of segments) {
    const raw = rawClientWrite(seg.map((w) => w.text).join(" "));
    if (raw) return { kind: "raw-client", merge: raw.merge };
  }
  assertNoShellRewrite(segments, command);
  if (countGhCalls(command, ALIAS_STEPS) > 0) {
    throw unresolvable("a gh alias could run `gh pr merge` or `gh api` under a name the review gate cannot read, so the agent can't define one (`gh alias set` / `gh alias import`) through the gate; run the gh command itself, or ask the user to define the alias outside the agent");
  }
  /** @type {Merge[]} */
  const found = [];
  let isolatedPrMerges = 0;
  let isolatedApiCalls = 0;
  for (const seg of segments) {
    const call = locateGh(seg);
    if (!call) continue;
    const { ghRepoEnv, pre, k } = call;
    if (seg[k]?.text === "pr" && seg[k + 1]?.text === "merge") {
      isolatedPrMerges += 1;
      const m = readPrMerge([...pre, ...seg.slice(k + 2)], ghRepoEnv);
      if (m) found.push(m);
    } else if (seg[k]?.text === "api") {
      isolatedApiCalls += 1;
      const m = readApiMerge(seg.slice(k + 1), ghRepoEnv);
      if (m) found.push(m);
    }
  }
  if (countGhCalls(command, PR_MERGE_STEPS) > isolatedPrMerges) throw unresolvable("found `gh pr merge` but could not isolate it as a plain command; run it directly");
  // The same rule for `gh api` merges (`timeout 30 gh api …`, `bash -c "gh api …"`, `gh -f … api graphql`): every gh
  // word that reaches `api` must be a call we read. A harmless isolated `gh api user` never vouches for a hidden one.
  if (mentionsApiMerge(unquoted(command)) && countGhCalls(command, API_STEPS) > isolatedApiCalls) {
    throw unresolvable("found `gh api` touching a merge but could not isolate it as a plain command; run it directly");
  }
  if (found.length > 1) throw unresolvable("more than one merge in one command; run them separately");
  return found[0] ?? null;
}
