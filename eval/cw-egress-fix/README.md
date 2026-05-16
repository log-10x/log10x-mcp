# CW egress fix: Fluent Bit sidecar

The demo's `tenx-fluentd` daemonset ships 10x-enriched events (each
carrying a `tenx_hash`) to AWS CloudWatch Logs group
`/log10x/otel-demo/enriched`, stream `tenx-fluentd`. This is the data
plane the `verify-tenx-hash-e2e.sh` harness reads back from.

## What was broken

The fluentd image's Ruby `fluent-plugin-cloudwatch-logs` (v0.14.3)
**silently never flushed** under this pod/firehose topology. Hard
signature, reproduced every time:

- the file buffer filled (events were arriving fine from the 10x
  sidecar), the chunk left disk, CloudWatch stayed starved;
- `describe-log-streams lastIngestionTime` age climbed 1:1 with wall
  clock;
- the plugin emitted **zero** diagnostic lines (no flush, no retry,
  no AWS error) even with `@log_level info` set explicitly.

It was not a credentials / IRSA / AWS / network / tenx defect: a direct
`PutLogEvents` from the pod with its IRSA role succeeded. It is a
flush-scheduling pathology in the Ruby plugin in this topology.

Four fluentd-side fixes were attempted; **all failed identically**:

1. plain `kubectl rollout restart`;
2. bounded-retry (`retry_max_interval`, `retry_forever`) + capped
   memory buffer + `flush_thread_count 2`;
3. finite-retry + file buffer + bounded chunks;
4. `cloudwatch_logs` as the sole top-level `@OUTPUT` match (its own
   normal buffered-output flush context, no `copy`/`ignore_error`).

## The fix

Take CW egress **off** the Ruby plugin. fluentd keeps doing ingest +
the 10x receive/return; its `@OUTPUT` now `@type forward`s to a
**Fluent Bit sidecar** on `127.0.0.1:24226` whose Go `cloudwatch_logs`
output (an entirely separate codebase) does the `PutLogEvents`.

```
container logs -> fluentd tail -> k8s metadata -> forward:24224
   -> log10x sidecar (enriches: tenx_hash) -> forward back :24225
   -> fluentd @OUTPUT (grep-drop oiE13WLiimU) -> forward:24226
   -> fluent-bit in_forward -> cloudwatch_logs (Go) -> CW
```

Proven (2026-05-16): sustained ~50 ev/s over a 4-minute window, 7
consecutive 40s samples each ~38-41 `PutLogEvents` HTTP 200 +
`nextSequenceToken`, **zero** errors; newest CW event age ~0-5s;
readback events all carry `tenx_hash` (79 distinct hashes across real
otel-demo services in one 200-event page). Harness: **6 passed, 0
failed**.

## Files

| File | What |
|---|---|
| `fluent-bit.conf` | sidecar: forward in :24226 → cloudwatch_logs (Go), IRSA auto-injected |
| `04_outputs.conf` | fluentd `@OUTPUT`: grep-drop + forward to :24226 (replaces the broken cloudwatch_logs match) |
| `ds-patch.json` | strategic merge: adds the `fluent-bit` container + its config volume |
| `apply.sh` | idempotent re-apply (configmaps + ds patch + rollout) |

## Reproducibility / durability

This is a `kubectl patch` on the **Helm-managed** `tenx-fluentd`
daemonset plus a rewrite of the `fluentd-config-tenx` configmap and one
new `fluent-bit-cwl` configmap. A `helm upgrade` of the fluentd release
**reverts all of it**. After any such upgrade, re-run:

```bash
# kubectl context = log10x-otel-demo
bash eval/cw-egress-fix/apply.sh
bash eval/bin/verify-tenx-hash-e2e.sh 8     # expect 6 passed, 0 failed
```

The proper long-term home for this is the fluentd Helm values (sidecar
+ output config) in the chart repo; until then this directory is the
source of truth and `apply.sh` is the recovery path.
