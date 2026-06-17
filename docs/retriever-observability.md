# Retriever observability

The Retriever exposes four channels for observing query execution. Each channel answers a different question; together they form a complete picture of why a query returned 0 events or partial results.

## The four channels

| Channel | What it captures | When it's available |
|---------|-----------------|---------------------|
| Pod stdout | Coordinator startup errors, include-resolution failures, fatal JVM crashes | Always (no extra config needed) |
| CW queryLogGroup | Per-query structured events: query plan, scan stats, stream dispatch, worker completion | Only when `queryLogGroup` is set in helm values |
| S3 (_DONE.json + qr/ prefix) | Aggregate scan/dispatch stats; event JSONL files | Always after query completes |
| Prometheus | Pattern-level throughput, dropped-event ratios, forwarder offload share | Always (metric surface) |

## What lands where

| Diagnostic signal | Channel |
|-------------------|---------|
| `scanned`, `matched`, `submittedTasks`, `streamRequests` | S3 _DONE.json |
| `could not resolve include: 'cloud/streamer/subquery'` | Pod stdout only (chart 1.0.20-1.0.21) |
| Per-worker fetch bytes, result events | CW queryLogGroup |
| Query plan (templateHashes, vars, timeslice, dispatch) | CW queryLogGroup |
| ERROR-level query failures | CW queryLogGroup + pod stdout |
| `routeState="drop"` cohort share | Prometheus `all_events_summaryBytes_total{routeState="drop"}` |

## How to enable per-query CloudWatch logging

Add to your retriever helm values:

```yaml
queryLogGroup: log10x-retriever-query-events
```

Pre-create the log group (the retriever creates streams on demand but not the group):

```bash
aws logs create-log-group --log-group-name log10x-retriever-query-events
```

IRSA role must have these permissions on the log group:

```json
{
  "Effect": "Allow",
  "Action": [
    "logs:CreateLogStream",
    "logs:PutLogEvents"
  ],
  "Resource": "arn:aws:logs:{region}:{account}:log-group:log10x-retriever-query-events:*"
}
```

Without `queryLogGroup`, per-query CW logging is disabled and `log10x_retriever_query_status` will only read S3 data. Pod stdout remains visible via `kubectl logs`.

## How to read query events post-hoc

Use `log10x_retriever_query_status` with the queryId returned by a previous `log10x_retriever_query` call:

```json
{
  "tool": "log10x_retriever_query_status",
  "args": {
    "query_id": "3f7a1b2c-...",
    "target": "app",
    "include_pod_logs": true
  }
}
```

The tool:
1. Reads `s3://{bucket}/{indexSubpath}/tenx/{target}/qr/{queryId}/_DONE.json` for aggregate stats.
2. Lists event JSONL files under `qr/{queryId}/` and byte-count markers under `q/{queryId}/`.
3. If `queryLogGroup` is set: calls CloudWatch `FilterLogEvents` on the queryId over a 24h window and returns up to 100 structured log entries.
4. Runs the diagnostics engine on the combined data and returns a categorized verdict.

### Diagnostics categories

| Category | Meaning | Confidence levels |
|----------|---------|-------------------|
| `dispatcher_failure` | `submittedTasks > 0` but `scanned == 0` and `streamRequests == 0`; chart 1.0.20 rename-gap | `suspected` (from S3 only) or `confirmed` (S3 + pod log match) |
| `results_not_uploaded` | `matched > 0` but 0 event files in the `qr/` prefix | `suspected` |
| `dispatch_failure` | `elapsedMs == 0` and `reason != "dispatched"` | `suspected` |
| `observability_disabled` | `queryLogGroup` not set | `advisory` |
| `ok` | No anomalous pattern detected | `none` |

## Known limitations

### chart 1.0.20-1.0.21: incomplete streamer-to-retriever rename

The retriever chart was renamed from `streamer` to `retriever` across 1.0.20 and 1.0.21. If you are on 1.0.20, scan/stream worker Lambda functions still reference the old include path `cloud/streamer/subquery`. The indexer runs fine (it uses a different code path), but scan workers fail silently on every query:

- The indexer dispatches N scan tasks (`submittedTasks > 0`).
- Each worker Lambda resolves its launch macro and fails with `could not resolve include: 'cloud/streamer/subquery'`.
- The worker exits without writing any results; the indexer marks the query `dispatched` but `scanned=0`.

**Diagnosis** (automatic): `log10x_retriever_query` detects `scanned=0 + submittedTasks>0` in the diagnostics and replaces the generic "widen the window" message with the rename-gap explanation. `log10x_retriever_query_status` confirms the signature via pod logs when `include_pod_logs: true`.

**Fix**: upgrade to chart 1.0.21+, or apply the rename-residual fix in the `modules/feat/soft-drop` branch (which renames all `cloud/streamer/` references to `cloud/retriever/`).

### queryLogGroup default is empty

The retriever chart ships with `queryLogGroup: ""` by default. Per-query CW logging is opt-in. Set it explicitly to enable observability; `log10x_doctor` and `log10x_advise_retriever` (preflight mode) both warn when it is blank on an installed retriever.

## Troubleshooting recipes

### Zero events, no explanation

1. Call `log10x_retriever_query_status({query_id: "<id>", include_pod_logs: true})`.
2. Check `data.diagnostics.category`:
   - `dispatcher_failure`: upgrade chart or apply rename fix.
   - `results_not_uploaded`: check stream-worker pod logs for S3 write errors.
   - `dispatch_failure`: check coordinator pod for startup/config errors.
   - `observability_disabled`: enable `queryLogGroup` to see more.

### Partial results (`partial_results: true`)

The MCP poll budget expired before the engine finished. The engine continues running. Call `log10x_retriever_query_status` to check whether `_DONE.json` has appeared and then re-run with the same `queryId` pattern if needed.

### CloudWatch events missing for a known query

- Check that `queryLogGroup` is set in helm values.
- Verify the IRSA role has `logs:CreateLogStream` and `logs:PutLogEvents` on the log group ARN.
- Log streams are created on demand; they appear only after the first query executes post-config.
- The `FilterLogEvents` call uses a 24h look-back window; older queries are not visible.
