#!/bin/sh
# Probe hook. Records every call under $PROBE_OUT, then answers per mode and $PROBE_CASE.
mode="$1"; input=$(cat); n_file="$PROBE_OUT/$mode.count"
n=$(( $(cat "$n_file" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$n_file"
printf '%s\n' "$input" >> "$PROBE_OUT/$mode.inputs.jsonl"
case "$PROBE_CASE:$mode" in
  block:stop)
    case "$input" in *'"stop_hook_active":true'*) exit 0;; esac
    printf '{"decision":"block","reason":"probe-block: say DONE and stop"}\n';;
  deny:pre)
    case "$input" in *probe-deny*) printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"probe-deny-reason"}}\n';; esac;;
  stop:post)
    case "$input" in *probe-first*) printf '{"continue":false,"stopReason":"probe-stop"}\n';; esac;;
  warn:stop)
    printf '{"systemMessage":"probe-warning-stop"}\n';;
  warn:pre)
    printf '{"systemMessage":"probe-warning-pre"}\n';;
esac
exit 0
