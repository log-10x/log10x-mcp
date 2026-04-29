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
| `log10x_investigate` | "Why is this spiking?" — single-call root-cause: anchor resolution, trajectory shape detection (acute-spike vs drift), cross-pattern lag correlation, causal chain with stat/lag/chain confidence sub-scores, drift cohort analysis, two-stage Retriever fallback, verification commands. Surfaces log-only signals (pool saturation, cache evictions, retry amplification) that APM structurally cannot see. | Reporter |
| `log10x_resolve_batch` | "Triage these events" — paste a file / array / text dump of raw log lines and get per-pattern frequency, severity, variable concentration, and next-action suggestions. Runs via the Log10x paste endpoint; works at any tier including CLI-only. | None |
| `log10x_retriever_query` | "Get me the actual events" — direct retrieval from the Retriever archive by templateHash with JS filter expressions over event payloads. Queries the customer's own S3 via pre-computed Bloom filters. Answers forensic, audit, and out-of-retention retrieval. | Retriever |
| `log10x_backfill_metric` | "Create a new Datadog metric backfilled with 90 days of history" — pulls historical events from the Retriever, aggregates into a bucketed time series, emits to the destination TSDB with historical timestamps preserved. Datadog + Prometheus remote_write supported today. | Retriever |

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
  - call `log10x_retriever_query({ pattern: '...', filters: ["event.order === \"12347\""] })` to retrieve all historical events concentrated on order=12347 (requires Retriever tier).
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
        "LOG10X_API_KEY": "your-api-key"
      }
    }
  }
}
```

Restart Claude Desktop. The server autodiscovers every env your account can reach (default + any shared with you) — pass `environment: "<nickname>"` on any tool call to switch between them.

If `LOG10X_API_KEY` is omitted, the MCP boots in **demo mode** against the public Log10x demo env (read-only). Run `log10x_signin` and the LLM will walk you through the GitHub Device Flow — it mints a real key, writes it to `~/.log10x/credentials`, and hot-reloads without an MCP-host restart.

### Claude Code

```bash
claude mcp add --transport stdio \
  --env LOG10X_API_KEY=your-api-key \
  log10x -- npx -y log10x-mcp
```

Verify with `/mcp`.

### Cursor / Windsurf / other MCP clients

Same pattern — add an `mcpServers` entry with `"command": "npx"`, `"args": ["-y", "log10x-mcp"]`, and `LOG10X_API_KEY`.

## Get your credentials

Two options:

1. **Sign in via GitHub**: launch the MCP without `LOG10X_API_KEY` set, then ask the LLM to "sign in to Log10x". `log10x_signin` runs the GitHub Device Flow, mints an API key, and saves it to `~/.log10x/credentials` — works across every MCP host on the same machine.
2. **Console**: log into [console.log10x.com](https://console.log10x.com) → Profile → API Settings → copy your API Key. (Optional: set your **Analyzer Cost** ($/GB for your SIEM) on that page — the server reads it automatically.)

## Multi-environment access

Two patterns, depending on what you need:

**Same account, multiple envs** (e.g., your account owns prod, staging, dev). Nothing special to configure — the MCP autodiscovers all envs your account can reach via `GET /api/v1/user`. Pass `environment: "<nickname>"` on any tool call, or just say "check staging costs" and the LLM routes there. The chosen env sticks for follow-up calls until you switch again.

**Multiple accounts** (e.g., a consultant accessing customer envs). The Log10x backend supports per-env permission sharing (OWNER / WRITE / READ). Have the env owner grant your account READ on their env from the console — it then shows up in your `/api/v1/user` response automatically, no client-side multi-credential setup needed. If you genuinely need parallel access from distinct API keys, register one MCP server per account in your host config with distinct server names.

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
| `LOG10X_API_KEY` | No | Your Log10x API key. Omit to boot in demo mode + use `log10x_signin` to mint one via GitHub. The env list is autodiscovered from `GET /api/v1/user` — no env-id pinning needed. |
| `LOG10X_API_BASE` | No | API base URL (default: `https://prometheus.log10x.com`) |

### Pasted-batch triage (`log10x_resolve_batch`)

| Variable | Required | Description |
|---|---|---|
| `LOG10X_PASTE_URL` | No | Override the Log10x paste endpoint (default: `https://meljpepqpd.execute-api.us-east-1.amazonaws.com/paste`). Body limit 100 KB. |

### Retriever (`log10x_retriever_query`, `log10x_backfill_metric`)

| Variable | Required | Description |
|---|---|---|
| `__SAVE_LOG10X_RETRIEVER_URL__` | Yes (Retriever tier) | Base URL of the customer's deployed Retriever query endpoint (e.g., `https://retriever.<your-domain>`). When unset, Retriever-dependent tools return a graceful "not configured" message. |
| `LOG10X_RETRIEVER_AUTH_HEADER` | No | Override the auth header name (default: `X-10X-Auth`, same as the Prometheus gateway). |
| `LOG10X_RETRIEVER_AUTH_VALUE` | No | Override the auth header value. Default is `${apiKey}/${envId}` from the active environment. |
| `__SAVE_LOG10X_RETRIEVER_TARGET__` | No | Override the default target prefix under which retriever writes indexed objects (default: `app`). |
| `LOG10X_RETRIEVER_INDEX_SUBPATH` | No | Override the index subpath inside the bucket (default: `indexing-results`, matching the engine's indexContainer convention). |
| `LOG10X_RETRIEVER_POLL_MS` | No | Override the marker-stability poll interval (default: `1500` ms). |
| `LOG10X_RETRIEVER_TIMEOUT_MS` | No | Override the query timeout (default: `90000` ms). |

**Demo env retriever LB**: the otel-demo cluster has a pre-provisioned retriever LoadBalancer at `http://a2936089108bb492cb41d18cb5b75f8d-1298006809.us-east-1.elb.amazonaws.com`. Set `__SAVE_LOG10X_RETRIEVER_URL__` to that value for the demo. The demo bucket is `tenx-demo-cloud-retriever-351939435334/indexing-results/`.

**Known engine-side issues (GAPS G12)**: `log10x_retriever_query` has two unresolved engine-side bugs that `log10x_doctor` flags as `retriever_forensic_health` warnings: (1) it may return 0 events on windows where `log10x_pattern_trend` proves events exist, (2) it may crash with `MCP error -32000: Connection closed` when passed a canonical slash-underscore pattern name. Workarounds: use short/free-text pattern names, cross-check any zero result against `log10x_pattern_trend`, prefer `log10x_event_lookup` + `log10x_pattern_trend` for incident reconstruction where approximate timing is acceptable. See `docs/ENGINE_TICKETS.md` for the full engine-team ticket.

### Metric backfill destinations (`log10x_backfill_metric`)

| Variable | Required | Description |
|---|---|---|
| `DATADOG_API_KEY` (or `DD_API_KEY`) | Yes (Datadog destination) | Datadog API key used to POST to `/api/v2/series`. |
| `DATADOG_SITE` | No | Datadog site (default: `datadoghq.com`, override for `datadoghq.eu`, `us5.datadoghq.com`, etc.) |
| `PROMETHEUS_REMOTE_WRITE_URL` | Yes (Prometheus destination) | URL of a Prometheus `remote_write`-compatible adapter. The MCP posts JSON; the adapter translates to the native protobuf/Snappy wire format. |

The server fetches your analyzer cost ($/GB) from your Console profile at startup and refreshes it hourly. To change it, update the cost in your profile — the server picks up the new value within an hour.

## Spawning sub-agents that use this MCP

If you script Claude Code sub-agents (`Agent` tool, OpenAI Agents SDK, custom orchestrators) to call log10x MCP tools, watch out for **deferred-tool bootstrapping**. The sub-agent's static tool list does not always include `mcp__log10x__*` — those tools are loaded on demand via `ToolSearch` (or the equivalent in your client). A sub-agent that reads its tool list and concludes "no MCP tools available" without first calling `ToolSearch({query: "log10x"})` will refuse the task instead of using the tools.

In testing across 17 sub-agent runs, **prompt framing was the deciding factor**:

| Framing | Bootstrap success |
|---|---|
| Action-oriented ("pull the events", "build the slide", "investigate this") | 9/9 |
| Honesty-oriented ("don't fabricate", "refuse if you can't verify") | 0/5 |

The honesty disposition fires too early — the agent applies "be honest about my limits" before trying to discover deferred tools. The fix is one line at the top of every sub-agent prompt:

```
TOOL BOOTSTRAP: You have log10x MCP tools available, but they are
deferred-loaded. Before doing anything else, call
ToolSearch({query: "log10x", max_results: 20}) to load them.
After that you'll have mcp__log10x__log10x_* tools.
```

This raised bootstrap success from ~76% to 100% in our test runs and is harmless when MCP tools are already in scope.

## Development

Build:

```bash
npm install
npm run build   # tsc → build/index.js
```

**Operational gotcha — restart after rebuild.** MCP clients (Claude Desktop, Claude Code, Cursor) typically launch the server as a long-running child process. Node caches loaded modules in memory, so the running process **will not pick up your `npm run build` output until it is killed and respawned**. After rebuilding, find and kill the stale processes:

```bash
pgrep -fl "log10x-mcp/build/index.js"   # show running servers + start times
ps -o pid=,lstart= -p $(pgrep -f log10x-mcp/build/index.js)
pkill -f "log10x-mcp/build/index.js"    # client will respawn on next tool call
```

If you ship a tool description change or a routing-hint update and the agent's behavior doesn't seem to reflect it, this is the most likely cause. Verify by `grep`-ing the raw tool output (most clients log it) for any string you added — if it's missing, the server is stale.

## Security

- All API calls use your personal API key (never exposed in tool output)
- The server runs locally — no data leaves your machine except Prometheus queries
- Dependency check scripts run locally with your own SIEM credentials (read-only)
- No caching of log content — all data comes from pre-aggregated metrics

## Documentation

Full documentation: [doc.log10x.com/manage/mcp-server](https://doc.log10x.com/manage/mcp-server/)

## License

This package is licensed under the [Apache License 2.0](LICENSE).

### Important: Log10x Product License Required

This package is the open-source MCP server for Log10x. While the MCP itself is open source,
**using Log10x requires a commercial license**.

| Component | License |
|-----------|---------|
| This package (`log10x-mcp`) | Apache 2.0 (open source) |
| Log10x engine and runtime | Commercial license required |

**What this means:**
- You can freely use, modify, and distribute this MCP server
- The Log10x backend services and `tenx` runtime that this MCP talks to require a paid subscription
- A valid Log10x API key is required to call the account-scoped tools (sign in via `log10x_signin` or set `LOG10X_API_KEY`)

**Get Started:**
- [Log10x Pricing](https://log10x.com/pricing)
- [Documentation](https://doc.log10x.com)
- [Contact Sales](mailto:sales@log10x.com)
