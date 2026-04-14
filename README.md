# Log10x MCP Server

Observability memory for your logs, exposed to AI assistants. Ask Claude (or any MCP-compatible AI) *"why did our log costs spike this week?"*, *"triage these 3000 events"*, *"what's causing the payments-svc error spike"*, or *"pull all payment_retry events for acme-corp from Jan 15 through Apr 15"* — and get structured answers backed by stable per-pattern identity, not best-effort clustering.

## What it does

Log10x fingerprints every log line into a stable `templateHash` — a structural identity that stays constant across deploys, restarts, pod names, timestamps, and request IDs. That identity is the key to a per-pattern Prometheus time series (volume + cost) and, optionally, a Bloom-indexed S3 archive of the raw events. This MCP server exposes both surfaces to AI assistants as a set of tools:

### Cost attribution and daily-habit tools

| Tool | Answers | Tier |
|---|---|---|
| `log10x_cost_drivers` | "Why did our log costs spike?" — dollar-ranked patterns with before→after deltas, keyed by stable templateHash (Datadog Log Patterns re-cluster per query and can't do this honestly) | Reporter |
| `log10x_event_lookup` | "What is this single log line?" — cost breakdown + AI classification | Reporter |
| `log10x_pattern_trend` | "When did this pattern start spiking?" — time series + sparkline | Reporter |
| `log10x_top_patterns` | "What's expensive right now?" — loudest patterns by current cost | Reporter |
| `log10x_list_by_label` | "Cost by namespace / severity / tenant?" — group-by ranking | Reporter |
| `log10x_services` | "What services are we monitoring?" — volume + cost by service | Reporter |
| `log10x_discover_labels` | "What labels can I filter on?" — label universe for the session | Reporter |
| `log10x_savings` | "How much are we saving?" — per-app savings with annual projection | Reporter |
| `log10x_dependency_check` | "Anything depending on this before I drop it?" — SIEM dependency scan | None |
| `log10x_exclusion_filter` | "How do I drop this in Datadog?" — config snippets for 14 vendors | None |

### Investigation, triage, and archive tools (v1.3)

| Tool | Answers | Tier |
|---|---|---|
| `log10x_investigate` | "Why is this spiking?" — single-call root-cause: anchor resolution, trajectory shape detection (acute-spike vs drift), cross-pattern lag correlation, causal chain with stat/lag/chain confidence sub-scores, drift cohort analysis, two-stage Streamer fallback, verification commands. Surfaces log-only signals (pool saturation, cache evictions, retry amplification) that APM structurally cannot see. | Reporter |
| `log10x_resolve_batch` | "Triage these events" — paste a file / array / text dump of raw log lines and get per-pattern frequency, severity, variable concentration, and next-action suggestions. Runs via the Log10x paste endpoint; works at any tier including CLI-only. | None |
| `log10x_streamer_query` | "Get me the actual events" — direct retrieval from the Storage Streamer archive by templateHash with JS filter expressions over event payloads. Queries the customer's own S3 via pre-computed Bloom filters. Answers forensic, audit, and out-of-retention retrieval. | Streamer |
| `log10x_backfill_metric` | "Create a new Datadog metric backfilled with 90 days of history" — pulls historical events from the Streamer, aggregates into a bucketed time series, emits to the destination TSDB with historical timestamps preserved. Datadog + Prometheus remote_write supported today. | Streamer |

All tools query `prometheus.log10x.com` (for Reporter-tier tools) over HTTPS, with the same `X-10X-Auth` header used by the rest of the Log10x stack. No log scanning; sub-second at any scale.

## ROI examples — three real flows

These are real round-trips against the Log10x demo environment, captured during development. Every tool call below is verbatim what the model would produce; outputs are abbreviated for the README.

### 1. "Why is checkout-svc cost up?" (`log10x_cost_drivers`)

**Prompt**: *"Why did checkout cost spike this week?"*

**Tool call**: `log10x_cost_drivers({ service: "cart", timeRange: "7d" })`

**Output** (abbreviated):

```
cart — $137 → $38K/wk (4 cost drivers)

#1  cart cartstore ValkeyCartStore     $51 → $13K/wk   INFO  13.3B events
#2  shipping service Post shipping...  $34 → $12K/wk   CRIT  1.6B events
#3  GetCartAsync called with userId    $34 → $8.7K/wk        8.7B events
#4  AddItemAsync called with...        $18 → $4.6K/wk        4.2B events

4 drivers = 49% of increase · 2442 other patterns

**Next actions**:
  - call `log10x_investigate({ starting_point: 'cart_cartstore_ValkeyCartStore' })` to trace the cause of the $13K delta on this pattern.
  - call `log10x_dependency_check({ pattern: '...' })` before muting or dropping — blast-radius safety.
```

The next-action hints in the output literally tell the model what to do next. No prompt engineering required.

### 2. "What's broken in payments-svc?" (`log10x_investigate`)

**Prompt**: *"Investigate kafka — there's an alert firing."*

**Tool call**: `log10x_investigate({ starting_point: "kafka", window: "1h" })`

**Output** (abbreviated 8-link causal chain):

```
## Investigation: kafka, last 1h

**Anchor**: cluster_metadata_Wrote_producer_snapshot... (resolved from service_name)
**Service**: kafka
**Inflection**: 2026-04-14T00:19:52Z UTC
**Shape**: acute spike
**Reporter tier**: edge

### Most likely root cause

Pattern: cluster_metadata_dir_tmp_kafka_logs_Rolled_new_segment...
Confidence: 43% (stat:1.00 lag:0.43 chain:1.00)
Why: peaked 300s before the anchor, magnitude 1.4× baseline.

### Causal chain

1. cluster_metadata_dir_tmp_kafka_logs_Rolled... — peaked T-300s
2. Successfully_wrote_snapshot_org_apache_kafka...  — peaked T-300s
3. opentelemetry_javaagent_shaded_instrumentation... — peaked T-300s
... (8 links total, each with stat × lag × chain confidence sub-scores)

### Suggested verification commands

gh api /repos/<owner>/kafka/commits?since=...&until=...
kubectl get events -n kafka --since=Xm
dog metric query "avg:trace.kafka.requests{*} by {resource_name}" --from ...
```

The full causal chain comes back in one tool call. The model doesn't need to compose. The verification commands are pre-substituted with the inflection timestamp so the user can paste them directly.

### 3. "Triage this Slack paste" (`log10x_resolve_batch`)

**Prompt**: *"My teammate dumped these 12 lines from order-processing-svc into Slack — what's happening?"*

**Tool call**: `log10x_resolve_batch({ source: "text", text: "..." })`

**Output** (abbreviated):

```
## Batch Triage

12 events, resolved into 3 distinct patterns. Templater wall time: 6.4s. Execution: Log10x paste endpoint.

**Severity mix**: INFO: 7 · ERROR: 4 · WARN: 1

### Top 3 patterns by interestingness

**#1  checkout_svc_tenant_acme_corp_order_status_failed_reason_payment_gateway**  · 4 events (33% of batch) · interestingness 0.47
severity: ERROR

Variable concentration (top values within this batch):
  - timestamp · 4 distinct · `1776067923000` 25%, `1776067925000` 25%, `1776067928000` 25%
  - order · 4 distinct · `12347` 25%, `12349` 25%, `12352` 25%

**Next actions**:
  - call `log10x_investigate({ starting_point: '...' })` for historical correlation (requires Reporter tier).
  - call `log10x_streamer_query({ pattern: '...', filters: ["event.order === \"12347\""] })` to retrieve all historical events concentrated on order=12347 (requires Streamer tier).
  - native Datadog follow-up: `dog log search '@order:"12347"' --from now-24h` — filters to the dominant variable concentration directly in the SIEM.
```

Every pattern is ranked by an interestingness score (severity-weighted); the dominant variable is identified; ready-to-paste next-action commands are pre-constructed for both Log10x tools and the customer's SIEM. The model just needs to relay the output and ask which path the user wants to take.

## Install

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "log10x": {
      "command": "npx",
      "args": ["-y", "log10x-mcp"],
      "env": {
        "LOG10X_API_KEY": "your-api-key",
        "LOG10X_ENV_ID": "your-env-id"
      }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add --transport stdio \
  --env LOG10X_API_KEY=your-api-key \
  --env LOG10X_ENV_ID=your-env-id \
  log10x -- npx -y log10x-mcp
```

Verify with `/mcp`.

### Cursor / Windsurf / other MCP clients

Same pattern — add an `mcpServers` entry with `"command": "npx"`, `"args": ["-y", "log10x-mcp"]`, and the two env vars.

## Get your credentials

1. Log into [console.log10x.com](https://console.log10x.com)
2. Open Profile → API Settings
3. Copy your **API Key** and **Environment ID**
4. (Optional) Set your **Analyzer Cost** ($/GB for your SIEM) — the server reads this automatically

## Multi-environment setup

To query multiple Log10x environments (prod, staging, etc.), register one MCP server per environment with a distinct name:

```json
{
  "mcpServers": {
    "log10x-prod": {
      "command": "npx",
      "args": ["-y", "log10x-mcp"],
      "env": {
        "LOG10X_API_KEY": "prod-api-key",
        "LOG10X_ENV_ID": "prod-env-id"
      }
    },
    "log10x-staging": {
      "command": "npx",
      "args": ["-y", "log10x-mcp"],
      "env": {
        "LOG10X_API_KEY": "staging-api-key",
        "LOG10X_ENV_ID": "staging-env-id"
      }
    }
  }
}
```

Ask "check prod costs" and your AI assistant routes to the `log10x-prod` server automatically. Each environment gets its own toolset namespaced by server name — no param juggling, no footguns.

### Advanced: single-process multi-env (for 10+ environments)

If you need to query many environments from a single process, use `LOG10X_ENVS` with a JSON array of `{nickname, apiKey, envId}` objects. Queries accept an `environment` parameter to route by nickname. This is more complex but avoids spawning N subprocesses.

```bash
LOG10X_ENVS='[{"nickname":"prod","apiKey":"...","envId":"..."},{"nickname":"staging","apiKey":"...","envId":"..."}]'
```

## Usage

You never call tools directly. Just ask your AI assistant a question in plain English:

| You say | The AI calls |
|---|---|
| "Why did our log costs spike this week?" | `log10x_cost_drivers` |
| "What is this Payment Gateway Timeout pattern?" | `log10x_event_lookup` |
| "How much are we saving with the pipeline?" | `log10x_savings` |
| "When did the checkout service start spiking?" | `log10x_pattern_trend` |
| "What services are we monitoring?" | `log10x_services` |
| "How do I drop this in Datadog?" | `log10x_exclusion_filter` |
| "Anything depending on this before I drop it?" | `log10x_dependency_check` |

## Cost driver algorithm

When you ask about cost spikes, the server runs the same algorithm as the Log10x Slack bot:

1. **Query current window** — bytes per pattern for the selected timeframe
2. **Query baseline** — average of the 3 prior windows of the same size
3. **Compute delta** — `cost_this_period - cost_baseline` per pattern
4. **Apply gates** — a pattern is a cost driver when it passes both:
   - Dollar floor: delta exceeds `$500/period`
   - Contribution floor: delta is at least `5%` of the total service increase
5. **Sort by delta** descending

Example output:

```
cart — $103 → $13K/wk (3 cost drivers)

#1  cart cartstore ValkeyCartStore      $51 → $6.4K/wk   INFO  6.6B events
#2  GetCartAsync called with userId     $34 → $4.3K/wk         4.2B events
#3  AddItemAsync called with userId     $18 → $2.2K/wk         2.1B events

3 drivers = 98% of increase · 11 other patterns
```

## Environment variables

### Reporter-tier (required for cost, trend, and investigate tools)

| Variable | Required | Description |
|---|---|---|
| `LOG10X_API_KEY` | Yes (single-env) | Your Log10x API key |
| `LOG10X_ENV_ID` | Yes (single-env) | Your Log10x environment ID |
| `LOG10X_ENVS` | Yes (multi-env) | JSON array of `{nickname, apiKey, envId}` |
| `LOG10X_API_BASE` | No | API base URL (default: `https://prometheus.log10x.com`) |

### Pasted-batch triage (`log10x_resolve_batch`)

| Variable | Required | Description |
|---|---|---|
| `LOG10X_PASTE_URL` | No | Override the Log10x paste endpoint (default: `https://meljpepqpd.execute-api.us-east-1.amazonaws.com/paste`). Body limit 100 KB. |

### Storage Streamer (`log10x_streamer_query`, `log10x_backfill_metric`)

| Variable | Required | Description |
|---|---|---|
| `LOG10X_STREAMER_URL` | Yes (Streamer tier) | Base URL of the customer's deployed Storage Streamer query endpoint (e.g., `https://streamer.<your-domain>`). When unset, Streamer-dependent tools return a graceful "not configured" message. |
| `LOG10X_STREAMER_AUTH_HEADER` | No | Override the auth header name (default: `X-10X-Auth`, same as the Prometheus gateway). |
| `LOG10X_STREAMER_AUTH_VALUE` | No | Override the auth header value. Default is `${apiKey}/${envId}` from the active environment. |

### Metric backfill destinations (`log10x_backfill_metric`)

| Variable | Required | Description |
|---|---|---|
| `DATADOG_API_KEY` (or `DD_API_KEY`) | Yes (Datadog destination) | Datadog API key used to POST to `/api/v2/series`. |
| `DATADOG_SITE` | No | Datadog site (default: `datadoghq.com`, override for `datadoghq.eu`, `us5.datadoghq.com`, etc.) |
| `PROMETHEUS_REMOTE_WRITE_URL` | Yes (Prometheus destination) | URL of a Prometheus `remote_write`-compatible adapter. The MCP posts JSON; the adapter translates to the native protobuf/Snappy wire format. |

The server fetches your analyzer cost ($/GB) from your Console profile at startup and refreshes it hourly. To change it, update the cost in your profile — the server picks up the new value within an hour.

## Security

- All API calls use your personal API key (never exposed in tool output)
- The server runs locally — no data leaves your machine except Prometheus queries
- Dependency check scripts run locally with your own SIEM credentials (read-only)
- No caching of log content — all data comes from pre-aggregated metrics

## Documentation

Full documentation: [doc.log10x.com/manage/mcp-server](https://doc.log10x.com/manage/mcp-server/)

## License

MIT
