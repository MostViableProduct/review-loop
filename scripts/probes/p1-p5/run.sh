#!/bin/sh
# Runs P1 (block, deny, PostToolUse stop) and P5 (systemMessage) in an isolated CLAUDE_CONFIG_DIR.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PROBE_HOME=${PROBE_HOME:?set PROBE_HOME to an empty dir with a signed-in .claude}
export CLAUDE_CONFIG_DIR="$PROBE_HOME/.claude"
WORK=$(mktemp -d); cd "$WORK"; git init -q
claude plugin marketplace add "$HERE" >/dev/null
claude plugin install rl-probe@rl-probe --scope user >/dev/null
run_case() { # $1 case, $2 prompt
  out="$WORK/out-$1"; mkdir -p "$out"
  PROBE_OUT="$out" PROBE_CASE="$1" claude -p "$2" --output-format stream-json --verbose \
    --allowedTools "Bash" < /dev/null > "$out/stream.jsonl" 2> "$out/stderr.txt" || true
  echo "$out"
}
B=$(run_case block "Reply with the word HELLO and nothing else.")
D=$(run_case deny "Run this exact bash command: touch $WORK/sentinel-deny # probe-deny")
C=$(run_case none "Run the bash command 'echo probe-first', then run the bash command 'touch $WORK/sentinel-control'.")
S=$(run_case stop "Run the bash command 'echo probe-first', then run the bash command 'touch $WORK/sentinel-after-stop'.")
W=$(run_case warn "Run the bash command 'echo hi', then reply OK.")
echo "P1.stop.count=$(cat "$B/stop.count")  (expect 2)"
echo "P1.stop.second_active=$(sed -n 2p "$B/stop.inputs.jsonl" | grep -c '"stop_hook_active":true')  (expect 1)"
echo "P1.deny.sentinel_exists=$([ -e "$WORK/sentinel-deny" ] && echo yes || echo no)  (expect no)"
echo "P1.deny.reason_seen=$(grep -c probe-deny-reason "$D/stream.jsonl")  (expect >=1)"
echo "P1.post.control_sentinel=$([ -e "$WORK/sentinel-control" ] && echo yes || echo no)  (expect yes)"
echo "P1.post.control_tool_uses=$(grep -o '"type":"tool_use"' "$C/stream.jsonl" | wc -l | tr -d ' ')  (expect >=2)"
echo "P1.post.stop_tool_uses=$(grep -o '"type":"tool_use"' "$S/stream.jsonl" | wc -l | tr -d ' ')  (expect 1)"
echo "P1.post.count=$(cat "$S/post.count")  (expect 1)"
echo "P1.post.sentinel_after_stop=$([ -e "$WORK/sentinel-after-stop" ] && echo yes || echo no)  (expect no)"
echo "P5.warning_stop_seen=$(grep -c probe-warning-stop "$W/stream.jsonl")  (expect >=1)"
echo "P5.warning_pre_seen=$(grep -c probe-warning-pre "$W/stream.jsonl")  (expect >=1)"
echo "P5.tool_ran=$(grep -c '"hi' "$W/stream.jsonl")  (expect >=1)"
echo "WORK=$WORK"
