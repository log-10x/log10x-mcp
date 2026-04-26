<!-- SYNTHETIC FIXTURE — numbers below are derived from a deterministic pattern set, NOT a real SIEM pull. -->
<!-- For a real sample, set credentials and run log10x_poc_from_siem_submit against your stack. -->
# Log10x POC Report — Splunk

_7d window · scope=`main` · snapshot_id=`sample-synthetic-000`_

## 1. Executive Summary

Analyzed **250K events** (125.0 MB) from Splunk across the last 7d.

- **Observed cost (window)**: $0.72
- **Projected weekly cost**: $0.72
- **Potential savings (window)**: $0.71 — 71% of analyzed cost
- **Analyzer rate**: $6.00/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Mute `checkout_svc_heartbeat_pod_uptimes` → save $0.38
- Mute `cache_svc_cache_lookup_key_hit` → save $0.14
- Sample `db_proxy_slow_query_took_ms_target_500ms` at 1/10 → save $0.08

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | `checkout_svc_heartbeat_pod_uptimes` | checkout-svc | INFO | 140K | 56% | $0.38 | $0.38 |  |
| 2 | `cache_svc_cache_lookup_key_hit` | cache-svc | DEBUG | 48K | 19% | $0.14 | $0.14 |  |
| 3 | `db_proxy_slow_query_took_ms_target_500ms` | db-proxy | WARN | 9.2K | 4% | $0.09 | $0.09 |  |
| 4 | `checkout_svc_request_end_rid_status_tookms` | checkout-svc | INFO | 35K | 14% | $0.07 | $0.07 |  |
| 5 | `ingress_gw_healthz_200_tookms_client` | ingress-gw | INFO | 15K | 6% | $0.04 | $0.04 |  |
| 6 | `auth_svc_token_refresh_tenant_ttls` | auth-svc | INFO | 2.6K | 1% | $0.01 | $0.01 |  |
| 7 | `payments_svc_payment_gateway_timeout_customer_amount_provider` | payments-svc | ERROR | 412 | 0.2% | $0.00 | $0.00 |  |
| 8 | `inventory_svc_upstream_connection_refused_host_port` | inventory-svc | ERROR | 87 | 0.0% | $0.00 | $0.00 |  |
| 9 | `otel_collector_exported_spans_batch` | otel-collector | INFO | 170 | 0.1% | $0.00 | $0.00 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| checkout-svc | 175K | $0.45 | INFO 100% |
| cache-svc | 48K | $0.14 | DEBUG 100% |
| db-proxy | 9.2K | $0.09 | WARN 100% |
| ingress-gw | 15K | $0.04 | INFO 100% |
| auth-svc | 2.6K | $0.01 | INFO 100% |
| payments-svc | 412 | $0.00 | ERROR 100% |
| inventory-svc | 87 | $0.00 | ERROR 100% |
| otel-collector | 170 | $0.00 | INFO 100% |

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — `checkout_svc_heartbeat_pod_uptimes`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (56% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.38
- **Dependency warning**: run `log10x_dependency_check(pattern: "checkout_svc_heartbeat_pod_uptimes")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: checkout_svc_heartbeat_pod_uptimes
  action: drop
  untilEpochSec: 1779211132   # auto-expires in 30d
  reason: "High-volume INFO pattern (56% of analyzed volume) — candidate for mute after dependency check."
```

### #2 — `cache_svc_cache_lookup_key_hit`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (19% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.14
- **Dependency warning**: run `log10x_dependency_check(pattern: "cache_svc_cache_lookup_key_hit")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: cache_svc_cache_lookup_key_hit
  action: drop
  untilEpochSec: 1779211132   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (19% of analyzed volume) — candidate for mute after dependency check."
```

### #3 — `db_proxy_slow_query_took_ms_target_500ms`  _(high confidence)_

- **Action**: sample 1/10
- **Reasoning**: WARN pattern is 4% of volume — sample 1/10 to keep signal without paying full cost.
- **Projected savings (window)**: $0.08
- **Dependency warning**: run `log10x_dependency_check(pattern: "db_proxy_slow_query_took_ms_target_500ms")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: db_proxy_slow_query_took_ms_target_500ms
  action: sample
    sampleRate: 10
  untilEpochSec: 1779211132   # auto-expires in 30d
  reason: "WARN pattern is 4% of volume — sample 1/10 to keep signal without paying full cost."
```

### #4 — `checkout_svc_request_end_rid_status_tookms`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (14% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.07
- **Dependency warning**: run `log10x_dependency_check(pattern: "checkout_svc_request_end_rid_status_tookms")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: checkout_svc_request_end_rid_status_tookms
  action: drop
  untilEpochSec: 1779211132   # auto-expires in 30d
  reason: "High-volume INFO pattern (14% of analyzed volume) — candidate for mute after dependency check."
```

### #5 — `ingress_gw_healthz_200_tookms_client`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (6% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.04
- **Dependency warning**: run `log10x_dependency_check(pattern: "ingress_gw_healthz_200_tookms_client")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: ingress_gw_healthz_200_tookms_client
  action: drop
  untilEpochSec: 1779211132   # auto-expires in 30d
  reason: "High-volume INFO pattern (6% of analyzed volume) — candidate for mute after dependency check."
```

### #6 — `auth_svc_token_refresh_tenant_ttls`  _(high confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.01
- **Dependency warning**: run `log10x_dependency_check(pattern: "auth_svc_token_refresh_tenant_ttls")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: auth_svc_token_refresh_tenant_ttls
  action: sample
    sampleRate: 20
  untilEpochSec: 1779211132   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #7 — `payments_svc_payment_gateway_timeout_customer_amount_provider`  _(high confidence)_

- **Action**: keep
- **Reasoning**: severity=ERROR — keep for incident diagnosis.
- **Projected savings (window)**: $0.00
- **Dependency warning**: —

### #8 — `inventory_svc_upstream_connection_refused_host_port`  _(medium confidence)_

- **Action**: keep
- **Reasoning**: severity=ERROR — keep for incident diagnosis.
- **Projected savings (window)**: $0.00
- **Dependency warning**: —

### #9 — `otel_collector_exported_spans_batch`  _(high confidence)_

- **Action**: keep
- **Reasoning**: Low volume or non-actionable signal — keep.
- **Projected savings (window)**: $0.00
- **Dependency warning**: —

## 5. Native SIEM Exclusion Configs

Ready-to-paste configs for Splunk and fluent-bit. Drop these into your pipeline **only** after running `log10x_dependency_check` on each pattern.

### Splunk

```
# props.conf
[your_sourcetype]
TRANSFORMS-log10x_drop = log10x_drop_0, log10x_drop_1, log10x_drop_2, log10x_drop_3

# transforms.conf
[log10x_drop_0]
REGEX = checkout.*svc.*heartbeat.*pod.*uptimes
DEST_KEY = queue
FORMAT = nullQueue

[log10x_drop_1]
REGEX = cache.*svc.*cache.*lookup.*key.*hit
DEST_KEY = queue
FORMAT = nullQueue

[log10x_drop_2]
REGEX = checkout.*svc.*request.*end.*rid.*status.*tookms
DEST_KEY = queue
FORMAT = nullQueue

[log10x_drop_3]
REGEX = ingress.*gw.*healthz.*200.*tookms.*client
DEST_KEY = queue
FORMAT = nullQueue
```

### Fluent Bit (universal forwarder)

```
[FILTER]
    Name       grep
    Match      *
    Exclude    log checkout.*svc.*heartbeat
# pattern identity: checkout_svc_heartbeat_pod_uptimes (#1)

[FILTER]
    Name       grep
    Match      *
    Exclude    log cache.*svc.*cache
# pattern identity: cache_svc_cache_lookup_key_hit (#2)

[FILTER]
    Name       grep
    Match      *
    Exclude    log checkout.*svc.*request
# pattern identity: checkout_svc_request_end_rid_status_tookms (#3)

[FILTER]
    Name       grep
    Match      *
    Exclude    log ingress.*gw.*healthz
# pattern identity: ingress_gw_healthz_200_tookms_client (#4)
```

## 6. Compaction Potential

The Log10x optimizer **losslessly compacts** events by storing structure once and shipping only variable values. For Splunk, the compaction ratio typically runs 5-10× on structured JSON logs, 2-3× on semi-structured.

| pattern | current bytes/window | est. compact bytes | est. savings | before sample | after (compact) |
|---|---|---|---|---|---|
| `checkout_svc_heartbeat_pod_uptimes` | 64.0 MB | 12.8 MB (5.0×) | $0.30 | `2026-04-13T10:00:00Z INFO checkout-svc heartbeat pod=checko…` | `~$(yyyy-MM-dd'T'HH:mm:ss'Z') INFO checkout-svc heartbeat pod…` |
| `cache_svc_cache_lookup_key_hit` | 24.0 MB | 4.8 MB (5.0×) | $0.11 | `2026-04-13T10:00:00Z DEBUG cache-svc cache lookup key=user:…` | `~$(ts) DEBUG cache-svc cache lookup key=$ hit=$` |
| `db_proxy_slow_query_took_ms_target_500ms` | 15.0 MB | 3.0 MB (5.0×) | $0.07 | `2026-04-13T10:00:00Z WARN db-proxy slow query: select * fro…` | `~$(ts) WARN db-proxy slow query: $ took $ ms (target 500ms)` |
| `checkout_svc_request_end_rid_status_tookms` | 12.0 MB | 2.4 MB (5.0×) | $0.06 | `2026-04-13T10:00:00Z INFO checkout-svc request end rid=a7f …` | `~$(ts) INFO checkout-svc request end rid=$ status=$ took=$ms` |
| `ingress_gw_healthz_200_tookms_client` | 6.0 MB | 1.2 MB (5.0×) | $0.03 | `2026-04-13T10:00:00Z INFO ingress-gw /healthz 200 took=3ms …` | `~$(ts) INFO ingress-gw /healthz 200 took=$ms client=$` |
| `auth_svc_token_refresh_tenant_ttls` | 1.1 MB | 225.3 KB (5.0×) | $0.01 | `2026-04-13T10:00:00Z INFO auth-svc token refresh tenant=acm…` | `~$(ts) INFO auth-svc token refresh tenant=$ ttl=$s` |
| `payments_svc_payment_gateway_timeout_customer_amount_provider` | 439.5 KB | 88.0 KB (5.0×) | $0.00 | `2026-04-13T10:00:00Z ERROR payments-svc payment_gateway_tim…` | `~$(ts) ERROR payments-svc payment_gateway_timeout customer=$…` |
| `inventory_svc_upstream_connection_refused_host_port` | 92.8 KB | 18.6 KB (5.0×) | $0.00 | `2026-04-13T10:00:00Z ERROR inventory-svc upstream connectio…` | `~$(ts) ERROR inventory-svc upstream connection refused host=…` |

Install: see https://docs.log10x.com/apps/cloud/optimizer/ — the optimizer runs as a forwarder sidecar. Compaction is transparent to downstream queries.

## 7. Risk / Dependency Check

**These drop candidates need careful review**:

- `db_proxy_slow_query_took_ms_target_500ms` — severity=WARN — may feed alerts

Before applying any drop, run `log10x_dependency_check(pattern: "<identity>")` which scans Datadog monitors, Splunk saved searches, Grafana dashboards, and Prometheus rules for references. Dropping a pattern that feeds a live alert silently breaks the alert.

## 8. Deployment Paths

### Automated — log10x regulator (recommended)

1. Install the Log10x Regulator in your forwarder pipeline — https://docs.log10x.com/apps/edge/regulator/
2. Commit the generated regulator YAML above into your GitOps repo (the regulator watches a ConfigMap)
3. Mutes auto-expire at `untilEpochSec`, so stale rules self-clean. The regulator publishes exact pattern-match metrics, so you can verify the intended traffic is being dropped before committing permanently.

### Manual — native SIEM config (no log10x runtime)

1. Paste the Splunk config from Section 5 into your SIEM admin console
2. Monitor ingestion volume for 24-48h to confirm the drop
3. Trade-offs vs regulator: no auto-expiry, no per-pattern verification metric, no GitOps-reviewable identity (regex will drift)

## 9. Appendix

### Full pattern table

| identity | events | bytes | severity | service | sample |
|---|---|---|---|---|---|
| `checkout_svc_heartbeat_pod_uptimes` | 140K | 64.0 MB | INFO | checkout-svc | `2026-04-13T10:00:00Z INFO checkout-svc heartbeat pod=checkout-7f9b uptime=124s` |
| `cache_svc_cache_lookup_key_hit` | 48K | 24.0 MB | DEBUG | cache-svc | `2026-04-13T10:00:00Z DEBUG cache-svc cache lookup key=user:1234 hit=true` |
| `db_proxy_slow_query_took_ms_target_500ms` | 9.2K | 15.0 MB | WARN | db-proxy | `2026-04-13T10:00:00Z WARN db-proxy slow query: select * from orders took 1240 m…` |
| `checkout_svc_request_end_rid_status_tookms` | 35K | 12.0 MB | INFO | checkout-svc | `2026-04-13T10:00:00Z INFO checkout-svc request end rid=a7f status=200 took=42ms` |
| `ingress_gw_healthz_200_tookms_client` | 15K | 6.0 MB | INFO | ingress-gw | `2026-04-13T10:00:00Z INFO ingress-gw /healthz 200 took=3ms client=kube-probe` |
| `auth_svc_token_refresh_tenant_ttls` | 2.6K | 1.1 MB | INFO | auth-svc | `2026-04-13T10:00:00Z INFO auth-svc token refresh tenant=acme ttl=3600s` |
| `payments_svc_payment_gateway_timeout_customer_amount_provider` | 412 | 439.5 KB | ERROR | payments-svc | `2026-04-13T10:00:00Z ERROR payments-svc payment_gateway_timeout customer=acme-c…` |
| `inventory_svc_upstream_connection_refused_host_port` | 87 | 92.8 KB | ERROR | inventory-svc | `2026-04-13T10:00:00Z ERROR inventory-svc upstream connection refused host=redis…` |
| `otel_collector_exported_spans_batch` | 170 | 92.8 KB | INFO | otel-collector | `2026-04-13T10:00:00Z INFO otel-collector exported 500 spans batch=20f` |

### SIEM query used

```
search index=main
```

### Methodology

- **Pattern identity** is the Log10x `templateHash` — a stable field-set fingerprint computed from the token structure of the event. Identity stays constant across deploys, restarts, pod names, timestamps, and request IDs.
- **Cost model**: `bytes × analyzer_cost_per_gb` over the pulled window. Window cost is projected to weekly cost via `$/window × (168h / window_hours)`.
- **Recommendation rules**: mute when pattern is DEBUG/INFO or below a minimum-value bar AND ≥1% of total volume; sample when MAX 10/s; keep when ERROR or WARN.
- **Confidence** is `high` for patterns with ≥100 events in the window (stable rate), `medium` for 10-99, `low` for <10.

### Run metadata

- **snapshot_id**: `sample-synthetic-000`
- **started**: 2026-04-19T00:00:00Z
- **finished**: 2026-04-19T00:04:35Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 180000 (templater 95000ms)
- **events_analyzed**: 250K / target 250K (target_reached)
- **bytes_analyzed**: 125.0 MB
- **execution_mode**: paste_lambda
