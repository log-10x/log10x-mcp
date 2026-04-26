# `log10x_poc_from_siem` — MCP-native SIEM cost POC

`log10x_poc_from_siem_submit` + `log10x_poc_from_siem_status` is an async MCP
tool pair that pulls a representative event sample from your SIEM,
templatizes it into stable Log10x pattern identities, and produces a
9-section markdown report covering:

1. Executive summary — events analyzed, cost, projected savings, top wins
2. Top cost drivers — ranked pattern table with $/window, WoW flags
3. Service-level breakdown — cost + severity mix per service
4. Regulator recommendations — ready-to-paste Log10x regulator YAML
5. Native SIEM exclusion configs — per-SIEM + fluent-bit configs
6. Compaction potential — Splunk / Elasticsearch / ClickHouse only
7. Risk / dependency check — cheap-looking drops that may be load-bearing
8. Deployment paths — automated (regulator) and manual (native drops)
9. Appendix — full pattern table, methodology, run metadata

The tool returns the markdown inline AND writes it to
`${LOG10X_REPORT_DIR:-/tmp/log10x-reports}/poc_from_siem-<timestamp>.md`.

See the sample output in [poc-sample-report.md](./poc-sample-report.md).

## Supported SIEMs

| SIEM | Credentials | `scope` | `query` |
|---|---|---|---|
| cloudwatch | AWS credential chain (`AWS_*`, SSO, IMDS) | Log group name or wildcard `/aws/ecs/*` | CloudWatch filter pattern |
| datadog | `DD_API_KEY` + `DD_APP_KEY` (also `DATADOG_*`); optional `DD_SITE` | Index name | Datadog query |
| sumo | `SUMO_ACCESS_ID` + `SUMO_ACCESS_KEY` + `SUMO_ENDPOINT` | `_sourceCategory` value | Sumo query |
| gcp-logging | `GOOGLE_APPLICATION_CREDENTIALS` or ambient ADC | GCP project id | Log filter expression |
| elasticsearch | `ELASTIC_URL` + (`ELASTIC_API_KEY` or `ELASTIC_USERNAME`+`ELASTIC_PASSWORD`) | Index pattern | KQL / query_string |
| azure-monitor | `AZURE_LOG_ANALYTICS_WORKSPACE_ID` + DefaultAzureCredential | Workspace id | KQL |
| splunk | `SPLUNK_HOST` + `SPLUNK_TOKEN`, or `~/.splunkrc` | Index name | SPL |
| clickhouse | `CLICKHOUSE_URL` + (`CLICKHOUSE_USER`+`CLICKHOUSE_PASSWORD` or `CLICKHOUSE_API_KEY`) | Database name | SQL WHERE clause |

## How auto-discovery works

Omit `siem` and the tool probes every connector's `discoverCredentials()` in
parallel. Rules:

- **1 SIEM detected** → used automatically, noted in `plan_summary`.
- **0 SIEMs detected** → submit fails with an error listing the env vars
  needed for each supported SIEM.
- **2+ SIEMs detected** → submit fails and asks the caller to pass `siem=`.
  Explicit `env` credentials beat `ambient` credentials — a specific
  env-var set with DD keys beats a stray `aws sso login` session from
  earlier in the day.
- **Only ambient creds** → used automatically, but the `plan_summary`
  flags which kind of credentials were picked up so the caller can
  course-correct.

Call `log10x_doctor` to see a per-connector credential-discovery table
without kicking off a pull.

## ClickHouse schemas

ClickHouse log schemas vary by deployment. The connector auto-detects two
well-known schemas and falls back to explicit column mapping:

1. **OpenObserve** (`_timestamp`, `log`, `stream`, …) — detected from
   columns named `_timestamp`, `log`, `stream`. Auto-mapped to the canonical
   `{timestamp, message, service}` shape.
2. **SigNoz** (`timestamp`, `body`, `severity_text`, `resources_string_*`) —
   detected from the presence of `body` + `severity_text`. Resource labels
   (service, container, etc.) are captured from the payload text — SigNoz
   stores them in a parallel key/value structure.
3. **Custom / unrecognized** — the connector returns an error asking the
   caller to pass column mappings:
   - `clickhouse_table` (required)
   - `clickhouse_timestamp_column`
   - `clickhouse_message_column`
   - `clickhouse_service_column` (optional)
   - `clickhouse_severity_column` (optional)

## Async lifecycle

```
log10x_poc_from_siem_submit({ siem, window, scope, ... })
  → { snapshot_id, plan_summary, siem_detected, estimated_duration_minutes }

log10x_poc_from_siem_status({ snapshot_id })
  → { status: 'pulling' | 'templatizing' | 'rendering',
      progress_pct, step_detail, elapsed_seconds, partial_patterns_found? }
  → (on complete) { status: 'complete', report_markdown, report_file_path,
                    summary: { events_analyzed, patterns_found, ... } }
  → (on failure) { status: 'failed', error, partial_report_markdown?, retry_hint? }
```

Snapshots live in-memory per MCP process. A restart clears them, so
persist the `report_file_path` if you need the report later.

## Defaults

- `window`: `7d`
- `target_event_count`: `250_000` (≈125 MB at 500B avg; templatizes in 2-3 min)
- `max_pull_minutes`: `5` (whichever of target count / time hits first)
- `analyzer_cost_per_gb`: per vendors.json (Splunk $6, Datadog $2.50,
  Elasticsearch $1, Azure $2.30, CloudWatch $0.50, GCP $0.50, Sumo $0.25,
  ClickHouse $0.15). Pass the arg to override.
- `privacy_mode`: `false` (templating routes through the Log10x paste
  endpoint). Set `true` to route through a locally-installed `tenx` CLI;
  the tool errors early with an install hint if `tenx` isn't on `PATH`
  (or `LOG10X_TENX_PATH`).

## Rate limiting, pagination, partial results

Every connector handles:

- Pagination until target event count reached OR time budget exhausted OR
  source returns "no more".
- HTTP 429 / throttling exceptions with exponential backoff; `Retry-After`
  header respected when present.
- Transient 5xx + network errors retried up to 3× with jittered backoff.
- Time exhaustion and source exhaustion are first-class outcomes — the
  report renders whatever was pulled and prepends an explicit banner when
  the pull stopped early.
- Zero-event pulls render a low-confidence banner rather than an empty
  table.

## Output file

The generated report is written to
`${LOG10X_REPORT_DIR:-/tmp/log10x-reports}/poc_from_siem-<ISO-timestamp>.md`.

First line of the file is a metadata header so third-party tooling can
parse the run provenance without reading the whole body:

```
<!-- Generated by log10x_poc_from_siem at <ISO> · siem=<id> · window=<window> · events_analyzed=<N> · snapshot_id=<uuid> -->
```

## Known edge cases

- **CloudWatch** requires `scope` (log group). A missing scope fails fast
  with an explicit message instead of pulling every group in the account.
- **Azure Monitor** deep pagination uses end-time chunking since KQL has
  no cursor; very large pulls should narrow the query via `query`.
- **ClickHouse** SQL identifier quoting rejects anything that isn't
  `[A-Za-z_][A-Za-z0-9_]*` — no injection through `scope`, `query`, or
  column override args.
- **Splunk** polling cadence grows from 1s to 5s across the lifetime of a
  search job. Very expensive SPL (`sourcetype=*` over 30d) can exhaust the
  `max_pull_minutes` budget before the first result page lands.
- **GCP Logging** requires ADC or explicit credentials; IMDS-only (GKE
  workload identity) works because `@google-cloud/logging` handles the
  metadata-server roundtrip, but `discoverCredentials` can't fully prove
  reachability without a live query — it returns `source: 'ambient'`.
