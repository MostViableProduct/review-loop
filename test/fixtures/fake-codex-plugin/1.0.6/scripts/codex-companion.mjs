const USAGE = [
  "Usage:",
  "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
];
if (process.argv[2] === "help") console.log(USAGE.join("\n"));
