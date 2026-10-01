#!/bin/sh
# Runs P3 (skill ${CLAUDE_PLUGIN_ROOT} substitution) and P4 (dependency auto-install) in an isolated CLAUDE_CONFIG_DIR.
# Optional: DEP_MARKETPLACE_SRC adds the dependency's marketplace to the probe home first.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PROBE_HOME=${PROBE_HOME:?set PROBE_HOME to a dir with a signed-in .claude}
export CLAUDE_CONFIG_DIR="$PROBE_HOME/.claude"
WORK=$(mktemp -d); cd "$WORK"; git init -q
claude plugin uninstall rl-probe2@rl-probe2 </dev/null >/dev/null 2>&1 || true
claude plugin marketplace add "$HERE" </dev/null >"$WORK/mkt-add.txt" 2>&1 || true
if [ -n "${DEP_MARKETPLACE_SRC:-}" ]; then
  claude plugin marketplace add "$DEP_MARKETPLACE_SRC" </dev/null >"$WORK/dep-mkt-add.txt" 2>&1 || true
fi
claude plugin install rl-probe2@rl-probe2 --scope user </dev/null >"$WORK/install.txt" 2>&1 || echo "install exit=$?"
claude plugin list --json </dev/null >"$WORK/list.json" 2>&1 || true
CODEX=$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1]));const a=Array.isArray(l)?l:(l.plugins||[]);console.log(a.some(p=>String(p.id||p.name).startsWith("codex")))' "$WORK/list.json" 2>/dev/null || echo parse-error)
claude -p "run probe three" --output-format stream-json --verbose --allowedTools Bash </dev/null >"$WORK/p3.jsonl" 2>"$WORK/p3.err" || true
ROOT=$(grep -o 'ROOT=/[^"\\ ]*' "$WORK/p3.jsonl" | head -1 || true)
echo "P4.codex_installed=$CODEX  (expect true)"
echo "P3.root=$ROOT  (expect ROOT=/.../rl-probe2/...)"
echo "WORK=$WORK"
