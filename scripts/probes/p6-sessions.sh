#!/bin/sh
# P6: count Claude Code processes that could write settings.json. FAIL-SAFE: overcount is fine,
# undercount is not (ruling R-P6). Prints pid, kind and argv1 only, never full command lines.
# Usage: p6-sessions.sh            live processes
#        p6-sessions.sh --stdin    classify "pid args" lines from stdin (synthetic cases)
CLASSIFY='{
  pid = $1; a = $0; sub(/^ *[0-9]+ +/, "", a)
  if (a ~ /^([^ ]*\/)?(awk|ps|grep|pgrep)( |$)/) next
  if (match(a, /(^|\/)claude( |$)/)) {
    rest = substr(a, RSTART + RLENGTH); split(rest, w, " ")
    if (w[1] == "daemon" || w[1] == "bg-pty-host" || w[1] == "bg-spare" || w[1] == "--chrome-native-host") next
    print pid, "claude", w[1]; n++
  } else if (a ~ /\/claude-code\/cli\.js/) { print pid, "node-cli.js", ""; n++ }
}
END { print "robust count: " (n + 0) }'
if [ "$1" = "--stdin" ]; then awk "$CLASSIFY"; exit 0; fi
echo "naive pgrep -x claude: $(pgrep -x claude | wc -l | tr -d ' ')"
echo "robust command: ps -Ao pid=,args= | awk '<CLASSIFY in scripts/probes/p6-sessions.sh>'"
ps -Ao pid=,args= | awk "$CLASSIFY"
