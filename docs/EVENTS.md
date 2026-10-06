# Sending the event log to your log pipeline

review-loop writes one line per event to `~/.claude/state/review-loop/events.jsonl`: codes, counts, scores and
model names only, never file paths, file contents, review text, emails or environment values. Nothing is sent
anywhere; this page is for teams that want to collect the file themselves.

`events.jsonl` has one JSON object per line, schema `review-loop.event/1`, in this field order:
`schema, ts, run_id, source, event, code, detail, exit_code, version, session_id, artifact_key, data`.
Each line is at most 4 KiB. The file rotates at 5 MiB to `events.jsonl.1` (one generation). To write it
elsewhere: `review-loop config set events.path /abs/path.jsonl`.

Ship it with any file-tailing agent (OpenTelemetry Collector, Vector, Fluent Bit, the Datadog agent).
An OpenTelemetry Collector `filelog` example:

```yaml
receivers:
  filelog/review_loop:
    include: ["${env:HOME}/.claude/state/review-loop/events.jsonl"]
    start_at: beginning
    operators:
      - type: json_parser
        timestamp:
          parse_from: attributes.ts
          layout_type: gotime
          layout: "2006-01-02T15:04:05.000Z07:00"
exporters:
  debug: {}
service:
  pipelines:
    logs:
      receivers: [filelog/review_loop]
      exporters: [debug]
```

## Event types

Generated from the engine's event catalog: every event type, who writes it, and its `data` fields. A field
that does not pass its check is written as `null`.

<!-- events:start -->
| Event | Written by | Data fields |
|---|---|---|
| `cli.exit` | cli | `command`, `duration_ms` |
| `gate.decision` | hook | `gate`, `outcome`, `preset`, `pending_count` |
| `round.result` | round | `kind`, `round`, `pass`, `mean`, `dims`, `model`, `effort`, `effort_source`, `preset`, `duration_ms` |
| `round.decision` | round | `kind`, `option`, `reason` |
| `round.dispute` | round | `kind` |
| `round.push` | round | — |
| `round.sweep` | round | `swept`, `brokers_left`, `failed`, `unattributed`, `incomplete`, `held`, `partition`, `partitions` |
| `round.stop_orphan` | round | `status` |
| `round.orphans` | round | `verified`, `count` |
| `round.broker_stop` | round | `reason`, `left`, `unattributed`, `snapshot` |
| `hook.error` | hook, round, cli | `stage`, `mode` |
| `config.invalid` | hook, cli, round | — |
| `override` | hook, round, cli | `kind`, `action` |
| `event_unregistered` | cli, hook, round | — |
<!-- events:end -->
