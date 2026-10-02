#!/bin/sh
# Clean P3 run: dependency-free plugin rl-probe3 from the rl-probe2 marketplace, in an isolated CLAUDE_CONFIG_DIR.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PROBE_HOME=${PROBE_HOME:?set PROBE_HOME to a dir with a signed-in .claude}
export CLAUDE_CONFIG_DIR="$PROBE_HOME/.claude"
WORK=$(mktemp -d); cd "$WORK"; git init -q
claude plugin uninstall rl-probe2@rl-probe2 </dev/null >/dev/null 2>&1 || true
claude plugin uninstall rl-probe3@rl-probe2 </dev/null >/dev/null 2>&1 || true
claude plugin marketplace remove rl-probe2 </dev/null >/dev/null 2>&1 || true
claude plugin marketplace add "$HERE" </dev/null >"$WORK/mkt-add.txt" 2>&1
claude plugin install rl-probe3@rl-probe2 --scope user </dev/null >"$WORK/install.txt" 2>&1 || echo "install exit=$?"
claude plugin list --json </dev/null >"$WORK/list.json" 2>&1 || true
claude -p "run probe three" --output-format stream-json --verbose --allowedTools Bash </dev/null >"$WORK/p3.jsonl" 2>"$WORK/p3.err" || true
ROOT=$(grep -o 'ROOT=/[^"\\ ]*' "$WORK/p3.jsonl" | head -1 || true)
echo "P3.root=$ROOT  (expect ROOT=/.../rl-probe3/...)"
echo "P3.bash_tool_uses=$(grep -o '"type":"tool_use"' "$WORK/p3.jsonl" | wc -l | tr -d ' ')  (expect >=1)"
echo "P3.list_errors=$(grep -c errorDetails "$WORK/list.json" || true)  (expect 0)"
echo "WORK=$WORK"
