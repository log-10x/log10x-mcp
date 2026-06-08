# log10x MCP — live exploration of the demo env

A Monday-morning SRE walks through the new log10x MCP against the public demo env. Every JSON block below is captured live from `node build/index.js`; no synthetic envelopes. Tool calls go through the MCP stdio transport; `structuredContent` is the typed envelope the agent reads.

Demo env: `https://prometheus.log10x.com`, env_id `6aa99191-f827-4579-a96a-c0ebdfe73884` (public, read-only).

---

## Step 1 — what's expensive right now

### 👤 You ask

> Monday morning. The cost alert flagged the weekend ran hot. What's expensive in our env right now, last hour?

### 🔧 Tool the agent picks

`log10x_services` with args:

```json
{
  "limit": 5,
  "timeRange": "1h",
  "view": "summary"
}
```

Question is "where is the money going right now?" — `log10x_services` ranks every service by current cost. Always the right first call when the scope is "what's expensive".

### 📊 Real envelope returned

```json
{
  "schema_version": "1.0",
  "schema_epoch": "2026-05-25",
  "tool": "log10x_services",
  "generated_at": "2026-05-26T23:18:27.558Z",
  "view": "summary",
  "summary": {
    "headline": "18 services over last 1h: opentelemetry-collector leads at $0.30/1h (71% of total $0.43/1h)."
  },
  "data": {
    "time_range": "last 1h",
    "cost_per_gb": 1.5,
    "period": "/1h",
    "total_bytes": 305438705,
    "total_cost": 0.4267,
    "service_count": 18,
    "top_n_share_pct": 91,
    "services": [
      {
        "rank": 1,
        "name": "opentelemetry-collector",
        "bytes": 218074172,
        "cost": 0.3046,
        "pct": 71.4
      },
      {
        "rank": 2,
        "name": "payment",
        "bytes": 49251624,
        "cost": 0.0688,
        "pct": 16.1
      },
      {
        "rank": 3,
        "name": "cart",
        "bytes": 11280939,
        "cost": 0.0158,
        "pct": 3.7
      },
      {
        "rank": 4,
        "name": "product-reviews",
        "bytes": 11252187,
        "cost": 0.0157,
        "pct": 3.7
      },
      {
        "rank": 5,
        "name": "llm",
        "bytes": 4536161,
        "cost": 0.0063,
        "pct": 1.5
      },
      {
        "rank": 6,
        "name": "kafka",
        "bytes": 2104745,
        "cost": 0.0029,
        "pct": 0.7
      },
      "... 12 more elided"
    ]
  },
  "actions": [
    {
      "tool": "log10x_top_patterns",
      "args": {
        "service": "opentelemetry-collector"
      },
      "reason": "current top patterns for the highest-cost service"
    },
    {
      "tool": "log10x_investigate",
      "args": {
        "starting_point": "opentelemetry-collector"
      },
      "reason": "causal-chain analysis on the top service"
    }
  ],
  "truncated": false,
  "warnings": []
}
```

### 🤖 Log10x explains

**18 services** in the env over last 1h. `opentelemetry-collector` is the top spender at **$0.30/1h** — that's **71%** of the env-wide $0.43/1h. Headline: _18 services over last 1h: opentelemetry-collector leads at $0.30/1h (71% of total $0.43/1h)._

### 🔗 Chain hint

Envelope's first chain hint: **`log10x_top_patterns`** with args `{"service":"opentelemetry-collector"}` — _current top patterns for the highest-cost service_

---

## Step 2 — top patterns in the top service

### 👤 You ask

> Top patterns in `opentelemetry-collector` over the last hour — that's the service that's bleeding cost.

### 🔧 Tool the agent picks

`log10x_top_patterns` with args:

```json
{
  "service": "opentelemetry-collector",
  "limit": 5,
  "timeRange": "1h",
  "view": "summary"
}
```

Now we know payments / opentelemetry-collector / whoever is on top; the natural drill-down is "which patterns are driving THAT service's spend?" — `log10x_top_patterns` filtered to that service.

### 📊 Real envelope returned

```json
{
  "schema_version": "1.0",
  "schema_epoch": "2026-05-25",
  "tool": "log10x_top_patterns",
  "generated_at": "2026-05-26T23:18:30.301Z",
  "view": "summary",
  "summary": {
    "headline": "Top 5 patterns over last 1h cost ~$219/mo total. 2 incident clusters detected.",
    "callout": "These look like 2 incidents: 2 patterns in `opentelemetry-collector` share `retryable_error_Permanent_error_flush_dial_tcp_loo`; 2 patterns in `opentelemetry-collector` share `tinfo_records`"
  },
  "data": {
    "patterns": [
      {
        "rank": 1,
        "identity": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
        "template_hash": "A4Rp6cSyTtY",
        "service": "opentelemetry-collector",
        "severity": "ERROR",
        "cost_per_hour_usd": 0.1989,
        "cost_per_month_usd": 143.213,
        "bytes": 142383123,
        "events": 3337,
        "first_seen_age_seconds": 515908,
        "badge": "STABLE",
        "descriptor": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
        "trend_bytes_per_sec": [
          39027,
          34898,
          40818,
          "... 142 more elided"
        ]
      },
      {
        "rank": 2,
        "identity": "retryable_error_Permanent_error_flush_dial_tcp_lookup_opensearch_no_such_host_error_flush_dial_tcp_lookup_opensearch_no_such",
        "template_hash": "ZRJMij8tDok",
        "service": "opentelemetry-collector",
        "severity": "ERROR",
        "cost_per_hour_usd": 0.0749,
        "cost_per_month_usd": 53.9457,
        "bytes": 53633114,
        "events": 5941,
        "first_seen_age_seconds": 767908,
        "badge": "STABLE",
        "descriptor": "retryable_error_Permanent_error_flush_dial_tcp_lookup_opensearch_no_such_host_error_flush_dial_tcp_lookup_opensearch_no_such",
        "trend_bytes_per_sec": [
          14741,
          12809,
          14957,
          "... 142 more elided"
        ]
      },
      {
        "rank": 3,
        "identity": "retryable_error_Permanent_error_flush_dial_tcp_lookup_opensearch_no_such_host_error_Permanent_error_flush_dial_tcp_lookup",
        "template_hash": "blOldHmCwzA",
        "service": "opentelemetry-collector",
        "severity": "ERROR",
        "cost_per_hour_usd": 0.0076,
        "cost_per_month_usd": 5.4974,
        "bytes": 5465592,
        "events": 653,
        "first_seen_age_seconds": 767908,
        "badge": "SHRINKING",
        "descriptor": "retryable_error_Permanent_error_flush_dial_tcp_lookup_opensearch_no_such_host_error_Permanent_error_flush_dial_tcp_lookup",
        "trend_bytes_per_sec": [
          1302,
          1589,
          1710,
          "... 140 more elided"
        ]
      },
      {
        "rank": 4,
        "identity": "tinfo_records",
        "template_hash": "AS2QDTmfMWM",
        "service": "opentelemetry-collector",
        "severity": "DEBUG",
        "cost_per_hour_usd": 0.0052,
        "cost_per_month_usd": 3.763,
        "bytes": 3741157,
        "events": 3337,
        "first_seen_age_seconds": 515908,
        "badge": "STABLE",
        "descriptor": "tinfo_records",
        "trend_bytes_per_sec": [
          993,
          874,
          1012,
          "... 142 more elided"
        ]
      },
      {
        "rank": 5,
        "identity": "tinfo_",
        "template_hash": "paF84Ahl88s",
        "service": "opentelemetry-collector",
        "severity": "DEBUG",
        "cost_per_hour_usd": 0.0052,
        "cost_per_month_usd": 3.7503,
        "bytes": 3728600,
        "events": 3327,
        "first_seen_age_seconds": 515908,
        "badge": "STABLE",
        "descriptor": "tinfo_",
        "trend_bytes_per_sec": [
          1006,
          873,
          1072,
          "... 142 more elided"
        ]
      }
    ],
    "incidents": [
      {
        "members": [
          {
            "identity": "ZRJMij8tDok",
            "cost_per_month_usd": 53.9457,
            "descriptor": "retryable_error_Permanent_error_flush_dial_tcp_lookup_opensearch_no_such_host_error_flush_dial_tcp_lookup_opensearch_no_such"
          },
          {
            "identity": "blOldHmCwzA",
            "cost_per_month_usd": 5.4974,
            "descriptor": "retryable_error_Permanent_error_flush_dial_tcp_lookup_opensearch_no_such_host_error_Permanent_error_flush_dial_tcp_lookup"
          }
        ],
        "representative_label": "retryable_error_Permanent_error_flush_dial_tcp_lookup_opensearch_no_such_host_error_flush_dial_tcp_lookup_opensearch_no_such",
        "service": "opentelemetry-collector",
        "combined_monthly_usd": 59.4432,
        "join_signal": "jaccard_direct",
        "confidence": 1
      },
      {
        "members": [
          {
            "identity": "AS2QDTmfMWM",
            "cost_per_month_usd": 3.763,
            "descriptor": "tinfo_records"
          },
          {
            "identity": "paF84Ahl88s",
            "cost_per_month_usd": 3.7503,
            "descriptor": "tinfo_"
          }
        ],
        "representative_label": "tinfo_records",
        "service": "opentelemetry-collector",
        "combined_monthly_usd": 7.5133,
        "join_signal": "jaccard_direct",
        "confidence": 0.5
      }
    ],
    "totals": {
      "monthly_usd": 219.3452,
      "bytes_per_sec": 60576,
      "pattern_count_shown": 5,
      "pattern_count_total": 17
    },
    "window": "last 1h",
    "pattern_count_shown": 5,
    "pattern_count_total": 17
  },
  "actions": [
    {
      "tool": "log10x_investigate",
      "args": {
        "starting_point": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
        "window": "24h"
      },
      "reason": "root-cause the top error loop before suppressing it (surfaces log-only signals: DNS, connection-pool, dependency failures)"
    },
    {
      "tool": "log10x_pattern_mitigate",
      "args": {
        "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project"
      },
      "reason": "env-gated mitigation options + exact configs for this pattern"
    },
    {
      "tool": "log10x_savings",
      "args": {
        "timeRange": "1h"
      },
      "reason": "projected savings across the env if you act — drop vs compact vs sample"
    },
    {
      "tool": "log10x_cost_drivers",
      "args": {
        "timeRange": "7d"
      },
      "reason": "growth/delta ranking over 7d — what is rising, vs the current-cost ranking shown here"
    },
    {
      "tool": "log10x_pattern_examples",
      "args": {
        "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project"
      },
      "reason": "deeper sample retrieval + slot distribution for the top pattern"
    }
  ],
  "render_hint": {
    "chart": "timeseries",
    "units": "$/mo"
  },
  "truncated": true,
  "warnings": [],
  "images": [
    {
      "data": "<base64 PNG omitted; rendered inline by hosts that support image content>",
      "mimeType": "image/png",
      "alt": "Top 5 patterns by monthly cost over last 1h"
    }
  ]
}
```

### 🤖 Log10x explains

**5 of 17 patterns** shown (the rest elided by limit=5; `truncated: true`). #1 is `open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opens…` at **$143/mo** — severity `ERROR`, badge `STABLE`. Visible-5 sum: **$210/mo**; `totals.monthly_usd` across all 17 patterns: **$219/mo**.

### 🔗 Chain hint

Envelope's first chain hint: **`log10x_investigate`** with args `{"starting_point":"open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_o` — _root-cause the top error loop before suppressing it (surfaces log-only signals: DNS, connection-pool, dependency failures)_

---

## Step 3 — show me the actual events

### 👤 You ask

> Show me a few real events of the #1 pattern so I can see what they actually look like.

### 🔧 Tool the agent picks

`log10x_pattern_examples` with args:

```json
{
  "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
  "limit": 3,
  "timeRange": "1h",
  "view": "summary"
}
```

A pattern identity alone doesn't tell us much. Pull a few real events so we can SEE what the pattern looks like — and the slot-distribution surfaces what the dominant variable values are.

### 📊 Real envelope returned

```json
{
  "schema_version": "1.0",
  "schema_epoch": "2026-05-25",
  "tool": "log10x_pattern_examples",
  "generated_at": "2026-05-26T23:18:41.775Z",
  "view": "summary",
  "summary": {
    "headline": "`open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project` (cloudwatch, 1h): 102 events pulled, 102 retained across 1 templates via tenx_hash-exact"
  },
  "data": {
    "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
    "vendor": "cloudwatch",
    "window": "1h",
    "probe_path": "tenx_hash-exact",
    "events_pulled": 102,
    "distinct_templates": 1,
    "retained_events": 102,
    "retained_templates": 1,
    "dropped_jaccard_events": 0,
    "multi_line_detected": false,
    "buckets": [
      {
        "rank": 1,
        "template_hash": "2qiwE{k$rY",
        "tenx_hash": "4Fwju8mGbu4",
        "event_count": 102,
        "jaccard": 1,
        "severity": "ERROR",
        "service": "tenx-fluentd",
        "sample_event": "2026-05-26T22:19:42.507Z\terror\topensearchexporter@v0.142.0/logger.go:36\tRequest failed.\t{\"resource\": {\"service.instance.id\": \"1aab212a-1c9e-423a-9b98-cc7cd26c17ae\", \"service.name\": \"otelcol-contrib\", \"service.version\": \"0.142.0\"}, \"otelcol.component.id\": \"opensearch\", \"otelcol.component.kind\": \"exporter\", \"otelcol.signal\": \"logs\", \"path\": \"/_bulk\", \"method\": \"POST\", \"duration\": 0.003808389, \"reason\": \"dial tcp: lookup opensearch on 172.20.0.10:53: no such host\"}",
        "template_body": "$(yyyy-MM-dd'T'HH:mm:ss.SSS'Z')\terror\topensearchexporter@v0.$.$//logger.go:$\tRequest failed.\t{\"resource\": {\"service.instance.id\": \"$-$-$-$-$\", \"service.name\": \"otelcol-contrib\", \"service.version\": \"$7.$8.$7\"}, \"otelcol.component.id\": \"opensearch\", \"otelcol.component.kind\": \"exporter\", \"otelcol.signal\": \"logs\", \"path\": \"//_bulk\", \"method\": \"POST\", \"duration\": $7.$, \"reason\": \"dial tcp: lookup opensearch on $.$.$.$:$: no such host\"}",
        "slot_distribution": [
          {
            "slot": "timestamp",
            "distinct_count": 20,
            "is_constant": false,
            "sample_values": [
              "1779833982507",
              "1779833982712",
              "1779833982914"
            ],
            "inferred_name": "timestamp",
            "naming_confidence": "high",
            "naming_source": "format_spec"
          },
          {
            "slot": "slot_9",
            "distinct_count": 20,
            "is_constant": false,
            "preceding_token": "h\", \"otelcol.component.kind\": \"exporter\", \"otelcol.signal\": \"logs\", \"path\": \"//_bulk\", \"method\": \"POST\", \"duration\": $7.",
            "sample_values": [
              "003808389",
              "00222526",
              "001809115"
            ],
            "inferred_name": "duration_part2",
            "naming_confidence": "medium",
            "naming_source": "json_key_composite"
          },
          {
            "slot": "slot_1",
            "distinct_count": 1,
            "is_constant": true,
            "preceding_token": "\terror\topensearchexporter@v0.",
            "sample_values": [
              "142"
            ]
          },
          {
            "slot": "slot_2",
            "distinct_count": 1,
            "is_constant": true,
            "preceding_token": ".",
            "sample_values": [
              "0"
            ]
          },
          {
            "slot": "slot_3",
            "distinct_count": 1,
            "is_constant": true,
            "preceding_token": "//logger.go:",
            "sample_values": [
              "36"
            ],
            "inferred_name": "line",
            "naming_confidence": "medium",
            "naming_source": "delimiter_heuristic"
          },
          {
            "slot": "slot_4",
            "distinct_count": 1,
            "is_constant": true,
            "preceding_token": "\tRequest failed.\t{\"resource\": {\"service.instance.id\": \"",
            "sample_values": [
              "1aab212a"
            ],
            "inferred_name": "resource.service.instance.id",
            "naming_confidence": "high",
            "naming_source": "json_key"
          }
        ],
        "cohorts": [
          {
            "member_slots": [
              "slot_4",
              "slot_5",
              "slot_6",
              "slot_7",
              "slot_8"
            ],
            "inferred_name": "resource.service.instance.id",
            "naming_confidence": "high",
            "kind": "uuid",
            "cardinality": 1,
            "sample_values": [
              "1aab212a-1c9e-423a-9b98-cc7cd26c17ae"
            ]
          },
          {
            "member_slots": [
              "slot_10",
              "slot_11",
              "slot_12",
              "slot_13"
            ],
            "inferred_name": "ipv4",
            "naming_confidence": "medium",
            "kind": "ipv4",
            "cardinality": 1,
            "sample_values": [
              "172.20.0.10"
            ]
          }
        ]
      }
    ],
    "probe_notes": [
      "scope auto-discovered: 4 group(s) under \"/log10x*\""
    ]
  },
  "actions": [],
  "truncated": true,
  "warnings": []
}
```

### 🤖 Log10x explains

**102 events pulled** over 1h; 102 retained across 1 template via tenx_hash-exact. Top template has **102 events**. Constant slots: `slot_1`, `slot_2`, `line`, `resource.service.instance.id`. Variable slots: `timestamp`=20 distinct; `duration_part2`=20 distinct. Cohorts: `resource.service.instance.id` (uuid, cardinality=1), `ipv4` (ipv4, cardinality=1). Sample event: `2026-05-26T22:19:42.507Z	error	opensearchexporter@v0.142.0/logger.go:36	Request failed.	{"resource": {"service.instance.…`

### 🔗 Chain hint

_No `actions[]` chain hint on this envelope — the agent decides the next step from the headline._

---

## Step 4 — is this getting worse

### 👤 You ask

> Has this pattern been getting worse over the last 24h, or is the current hour just a blip?

### 🔧 Tool the agent picks

`log10x_pattern_trend` with args:

```json
{
  "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
  "timeRange": "1d",
  "view": "summary"
}
```

Before recommending any action, check whether this is a chronic burner or a spike. `log10x_pattern_trend` returns a time-bucketed series + a spike-detected flag.

### 📊 Real envelope returned

```json
{
  "schema_version": "1.0",
  "schema_epoch": "2026-05-25",
  "tool": "log10x_pattern_trend",
  "generated_at": "2026-05-26T23:18:42.505Z",
  "view": "summary",
  "summary": {
    "headline": "`open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project` over last 24h: $4.98 measured spend, change +0% (last quarter vs first quarter run-rate)"
  },
  "data": {
    "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
    "window": "last 24h",
    "step": "1h",
    "time_series": [
      {
        "ts": 1779750000,
        "bytes": 142077919
      },
      {
        "ts": 1779753600,
        "bytes": 144477889
      },
      {
        "ts": 1779757200,
        "bytes": 143273898
      },
      {
        "ts": 1779760800,
        "bytes": 141983666
      },
      {
        "ts": 1779764400,
        "bytes": 142568915
      },
      {
        "ts": 1779768000,
        "bytes": 140241554
      },
      "... 19 more elided"
    ],
    "total_bytes": 3562391630,
    "total_cost_usd": 4.9766,
    "baseline_run_rate_usd": 4.7756,
    "recent_run_rate_usd": 4.7752,
    "change_pct": 0,
    "spike_detected": false,
    "peak_bytes": 145468292,
    "low_bytes": 139018904,
    "sample_count": 25
  },
  "actions": [],
  "render_hint": {
    "chart": "timeseries",
    "units": "bytes/sec"
  },
  "truncated": false,
  "warnings": [],
  "images": [
    {
      "data": "<base64 PNG omitted; rendered inline by hosts that support image content>",
      "mimeType": "image/png",
      "alt": "Timeseries chart of open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project over last 24h"
    }
  ]
}
```

### 🤖 Log10x explains

Over last 24h: **$4.98** measured spend on this pattern alone. **+0% change** (last quarter vs first quarter of window). Spike detected: **no**. This is chronic, not acute — the value is still there but the urgency is lower.

### 🔗 Chain hint

_No `actions[]` chain hint on this envelope — the agent decides the next step from the headline._

---

## Step 5 — what are my options

### 👤 You ask

> OK, this looks like a real loss. What are my options for stopping it?

### 🔧 Tool the agent picks

`log10x_pattern_mitigate` with args:

```json
{
  "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
  "view": "summary"
}
```

Now we want options. `log10x_pattern_mitigate` returns the 4-option menu (drop at analyzer / drop at forwarder / cap at receiver / compact at receiver) with each option marked enabled/disabled based on the env's capabilities.

### 📊 Real envelope returned

```json
{
  "schema_version": "1.0",
  "schema_epoch": "2026-05-25",
  "tool": "log10x_pattern_mitigate",
  "generated_at": "2026-05-26T23:18:42.714Z",
  "view": "summary",
  "summary": {
    "headline": "`open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project`: 1 of 4 mitigation options enabled (drop_at_analyzer)"
  },
  "data": {
    "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
    "options": [
      {
        "id": "drop_at_analyzer",
        "enabled": true,
        "label": "Drop at Splunk"
      },
      {
        "id": "drop_at_forwarder",
        "enabled": false,
        "disabled_reason": "forwarder not detected from env / snapshot",
        "label": "Drop at forwarder"
      },
      {
        "id": "mute_at_10x",
        "enabled": false,
        "disabled_reason": "To enable mute/compact at the 10x engine, set `gitops.repo` (owner/name) in your `~/.log10x/envs.json` entry — or export `LOG10X_GH_REPO=<owner/name>` — or pass a `snapshot_id` from `log10x_discover_env` against a cluster with a receiver pod that has `GH_ENABLED=true` + `GH_REPO=<owner/name>` set.",
        "label": "Mute at 10x receiver"
      },
      {
        "id": "compact_at_10x",
        "enabled": false,
        "disabled_reason": "To enable mute/compact at the 10x engine, set `gitops.repo` (owner/name) in your `~/.log10x/envs.json` entry — or export `LOG10X_GH_REPO=<owner/name>` — or pass a `snapshot_id` from `log10x_discover_env` against a cluster with a receiver pod that has `GH_ENABLED=true` + `GH_REPO=<owner/name>` set.",
        "label": "Compact at 10x receiver"
      }
    ],
    "env_capabilities": {
      "can_mute": false,
      "can_compact": false,
      "has_retriever_archive": false,
      "analyzer_vendor": "splunk"
    }
  },
  "actions": [],
  "truncated": false,
  "warnings": []
}
```

### 🤖 Log10x explains

**1 of 4 options enabled** in this env. Enabled: `drop_at_analyzer`. Disabled: `drop_at_forwarder, mute_at_10x, compact_at_10x` — distinct reasons: `drop_at_forwarder`: forwarder not detected from env / snapshot; `mute_at_10x` / `compact_at_10x`: env lacks gitops wiring (`can_mute=false`, `can_compact=false`). The demo env detects analyzer=`splunk` so `drop_at_analyzer` is the realistic path.

### 🔗 Chain hint

_No `actions[]` chain hint on this envelope — the agent decides the next step from the headline._

---

## Step 6 — anything depend on this

### 👤 You ask

> Before I mute it at the analyzer, does anything depend on this pattern? Dashboards, alerts, saved searches?

### 🔧 Tool the agent picks

`log10x_dependency_check` with args:

```json
{
  "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
  "vendor": "splunk",
  "view": "summary"
}
```

Before muting anything, the safety gate. `log10x_dependency_check` scans the customer's SIEM/dashboards/alerts for references to this pattern — never silently break an alert.

### 📊 Real envelope returned

```json
{
  "schema_version": "1.0",
  "schema_epoch": "2026-05-25",
  "tool": "log10x_dependency_check",
  "generated_at": "2026-05-26T23:18:42.718Z",
  "view": "summary",
  "summary": {
    "headline": "`open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project`: 0 dependencies found in splunk (recommendation: unverifiable)"
  },
  "data": {
    "pattern": "open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opensearchexporter_v_go_github_opensearch_project",
    "vendor": "splunk",
    "execution_mode": "paste_ready",
    "scan_ran": false,
    "dependencies": [],
    "safe_to_drop_recommendation": "unverifiable"
  },
  "actions": [],
  "truncated": false,
  "warnings": []
}
```

### 🤖 Log10x explains

**Paste-ready mode** — the MCP doesn't have splunk credentials in the env, so it returns a shell command the SRE runs locally and pipes the output back. Without the scan running, `safe_to_drop_recommendation` is `"unverifiable"` — the agent does NOT claim "safe to drop" so we don't silently break a dashboard.

### 🔗 Chain hint

_No `actions[]` chain hint on this envelope — the agent decides the next step from the headline._

---

## What we learned

- Six tool calls. One agent.
- **`opentelemetry-collector`** leads at ~$0.30/1h on the demo env — 71% of total cost.
- The driver: `open_telemetry_opensearchexporter_clientLogger_LogRoundTrip_open_telemetry_opens…` at ~$143/mo. Trend: `spike_detected=false`, change_pct=0% over last 24h — chronic, not acute.
- Mitigation options enabled in the demo env: `drop_at_analyzer`
- Safety gate fired: `dependency_check` returned `execution_mode: "paste_ready"` with `safe_to_drop_recommendation: "unverifiable"`. The agent **does not** claim "safe to drop" without scan evidence.

**The point**: each tool call returned typed JSON the agent could chain on. `actions[]` told it where to go next. `truncated`, `env_capabilities.*`, `spike_detected`, `safe_to_drop_recommendation` all influenced the agent's surface-level reply without it having to parse markdown.
