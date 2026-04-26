> **Note**: Pull stopped at 2,000 events (reason: error). Rerun with a larger max_pull_minutes for deeper coverage.

> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.

# Log10x POC Report — Datadog

_24h window · scope=`main` · snapshot_id=`7627e2c2-1645-4d16-8c6f-ff5908635b8f`_

## 1. Executive Summary

Analyzed **1.4K events** (268.9 KB) from Datadog across the last 24h.

> **Volume-scaled mode**: 100 GB/day (user-supplied)
>
> Cost figures below extrapolate from the pulled sample (268.9 KB) to the full daily volume by per-pattern %. Pattern rankings + regulator YAML + native exclusion configs are the same regardless of volume; only dollar figures scale.

- **Projected daily cost**: $250
- **Projected monthly cost**: $7.5K
- **Projected annual cost**: $91K
- **Potential annual savings**: **$77K** — 84% of annual cost
- **Analyzer rate**: $2.50/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Mute **Traces Debug Exporter** (`traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`) → save $59
- Mute **Logs Debug Exporter** (`logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`) → save $39
- Mute **Logs Debug Exporter** (`logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`) → save $31

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | **Traces Debug Exporter**<br>`traces_resource_service_instance_id_se…` | opentelemetry-collector | INFO | 325 | 24% | $59 | $414 |  |
| 2 | **Logs Debug Exporter**<br>`logs_resource_service_instance_id_serv…` | opentelemetry-collector | INFO | 201 | 15% | $39 | $272 |  |
| 3 | **Logs Debug Exporter**<br>`logs_resource_service_instance_id_serv…` | opentelemetry-collector | INFO | 154 | 11% | $31 | $214 |  |
| 4 | **Metrics Debug Exporter**<br>`metrics_resource_service_instance_id_s…` | opentelemetry-collector | INFO | 129 | 10% | $25 | $172 |  |
| 5 | **Metrics Upload Failure**<br>`failed_to_upload_metrics_post_https_ot…` | opentelemetry-collector | INFO | 38 | 3% | $6.8 | $48 |  |
| 6 | **AdService Missing Baggage**<br>`oteldemo_adservice_no_baggage_found_in…` | opentelemetry-collector | INFO | 34 | 3% | $6.4 | $45 |  |
| 7 | **Traces Debug Exporter**<br>`traces_resource_service_instance_id_se…` | opentelemetry-collector | INFO | 27 | 2% | $5.5 | $38 |  |
| 8 | **LocalLog Segment Roll**<br>`info_locallog_partition_cluster_metada…` | opentelemetry-collector | INFO | 26 | 2% | $5.5 | $38 |  |
| 9 | **KRaft Snapshot Create**<br>`info_snapshotgenerator_id_creating_new…` | opentelemetry-collector | INFO | 20 | 1% | $4.5 | $31 |  |
| 10 | **ProducerState Snapshot Write**<br>`info_producerstatemanager_partition_cl…` | opentelemetry-collector | INFO | 20 | 1% | $4.0 | $28 |  |
| 11 | **Offset Index Deleted**<br>`info_deleted_offset_index_tmp_kafka_lo…` | opentelemetry-collector | INFO | 24 | 2% | $3.8 | $27 |  |
| 12 | **SnapshotEmitter Wrote Snapshot**<br>`info_snapshotemitter_id_successfully_w…` | opentelemetry-collector | INFO | 16 | 1% | $3.6 | $25 |  |
| 13 | **Log Segment Deleted**<br>`info_deleted_log_tmp_kafka_logs_cluste…` | cart | INFO | 24 | 2% | $3.4 | $24 |  |
| 14 | **UnifiedLog Offset Increment**<br>`info_unifiedlog_partition_cluster_meta…` | opentelemetry-collector | INFO | 18 | 1% | $3.2 | $23 |  |
| 15 | **Time Index Deleted**<br>`info_deleted_time_index_tmp_kafka_logs…` | cart | INFO | 24 | 2% | $2.8 | $20 |  |
| 16 | **Snapshot Marked Deletion**<br>`info_partition_cluster_metadata_nodeid…` | opentelemetry-collector | INFO | 17 | 1% | $2.7 | $19 |  |
| 17 | **Shipping Quote Failure**<br>`internal_shipping_quote_failure_failed…` | opentelemetry-collector | INFO | 15 | 1% | $2.6 | $18 |  |
| 18 | **Producer Snapshot Deleted**<br>`info_deleted_producer_state_snapshot_t…` | cart | INFO | 24 | 2% | $2.6 | $18 |  |
| 19 | **ListRecommendations Trace**<br>`main_recommendation_server_py_trace_id…` | opentelemetry-collector | INFO | 12 | 0.9% | $2.5 | $17 |  |
| 20 | **UnifiedLog Segment Breach Delete**<br>`info_unifiedlog_partition_cluster_meta…` | opentelemetry-collector | INFO | 12 | 0.9% | $2.4 | $17 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| opentelemetry-collector | 1.2K | $231 | INFO 100% |
| cart | 131 | $15 | INFO 100% |
| kafka | 8 | $1.5 | INFO 100% |
| frontend | 12 | $1.2 | INFO 100% |
| ad | 3 | $0.36 | INFO 100% |

> ⚠ **Anomaly**: `opentelemetry-collector` is 93% of analyzed cost. One service dominating spend is either a hot-loop emitter (filter opportunity) or a mis-routed service (instrumentation issue).

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — **Traces Debug Exporter** (`traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`)  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (24% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $59
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "High-volume INFO pattern (24% of analyzed volume) — candidate for mute after dependency check."
```

### #2 — **Logs Debug Exporter** (`logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`)  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (15% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $39
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "High-volume INFO pattern (15% of analyzed volume) — candidate for mute after dependency check."
```

### #3 — **Logs Debug Exporter** (`logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`)  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (11% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $31
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "High-volume INFO pattern (11% of analyzed volume) — candidate for mute after dependency check."
```

### #4 — **Metrics Debug Exporter** (`metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c`)  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (10% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $25
- **Dependency warning**: run `log10x_dependency_check(pattern: "metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c
  action: drop
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "High-volume INFO pattern (10% of analyzed volume) — candidate for mute after dependency check."
```

### #5 — **Metrics Upload Failure** (`failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client`)  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $6.8
- **Dependency warning**: run `log10x_dependency_check(pattern: "failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client
  action: drop
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check."
```

### #6 — **AdService Missing Baggage** (`oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags`)  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $6.4
- **Dependency warning**: run `log10x_dependency_check(pattern: "oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags
  action: drop
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check."
```

### #7 — **Traces Debug Exporter** (`traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`)  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $5.2
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: sample
    sampleRate: 20
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #8 — **LocalLog Segment Roll** (`info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog`)  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $5.2
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog
  action: sample
    sampleRate: 20
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #9 — **KRaft Snapshot Create** (`info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k`)  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $4.2
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k
  action: sample
    sampleRate: 20
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #10 — **ProducerState Snapshot Write** (`info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa`)  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $3.8
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa
  action: sample
    sampleRate: 20
  untilEpochSec: 1779296160   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

## 5. Native SIEM Exclusion Configs

Ready-to-paste configs for Datadog and fluent-bit. Drop these into your pipeline **only** after running `log10x_dependency_check` on each pattern.

### Datadog

```
# Exclusion filter #1
{
  "name": "Drop traces_resource_service_instance_id_serv",
  "is_enabled": true,
  "filter": {
    "query": "@message:/traces.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*co/"
  }
}

# Exclusion filter #2
{
  "name": "Drop logs_resource_service_instance_id_servic",
  "is_enabled": true,
  "filter": {
    "query": "@message:/logs.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*comp/"
  }
}

# Exclusion filter #3
{
  "name": "Drop logs_resource_service_instance_id_servic",
  "is_enabled": true,
  "filter": {
    "query": "@message:/logs.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*comp/"
  }
}

# Exclusion filter #4
{
  "name": "Drop metrics_resource_service_instance_id_ser",
  "is_enabled": true,
  "filter": {
    "query": "@message:/metrics.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*c/"
  }
}

# Exclusion filter #5
{
  "name": "Drop failed_to_upload_metrics_post_https_otel",
  "is_enabled": true,
  "filter": {
    "query": "@message:/failed.*to.*upload.*metrics.*post.*https.*otel.*collector.*v1.*metrics.*http.*server.*gave.*http.*response.*to.*https.*client/"
  }
}
```

### Fluent Bit (universal forwarder)

```
[FILTER]
    Name       grep
    Match      *
    Exclude    log traces.*resource.*service
# pattern identity: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co (#1)

[FILTER]
    Name       grep
    Match      *
    Exclude    log logs.*resource.*service
# pattern identity: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp (#2)

[FILTER]
    Name       grep
    Match      *
    Exclude    log logs.*resource.*service
# pattern identity: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp (#3)

[FILTER]
    Name       grep
    Match      *
    Exclude    log metrics.*resource.*service
# pattern identity: metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c (#4)

[FILTER]
    Name       grep
    Match      *
    Exclude    log failed.*to.*upload
# pattern identity: failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client (#5)
```

## 7. Risk / Dependency Check

_All top drop candidates are high-volume, non-error patterns. Standard dependency check recommended but risk is low._

Before applying any drop, run `log10x_dependency_check(pattern: "<identity>")` which scans Datadog monitors, Splunk saved searches, Grafana dashboards, and Prometheus rules for references. Dropping a pattern that feeds a live alert silently breaks the alert.

## 8. Deployment Paths

### Automated — log10x regulator (recommended)

1. Install the Log10x Regulator in your forwarder pipeline — https://docs.log10x.com/apps/edge/regulator/
2. Commit the generated regulator YAML above into your GitOps repo (the regulator watches a ConfigMap)
3. Mutes auto-expire at `untilEpochSec`, so stale rules self-clean. The regulator publishes exact pattern-match metrics, so you can verify the intended traffic is being dropped before committing permanently.

### Manual — native SIEM config (no log10x runtime)

1. Paste the Datadog config from Section 5 into your SIEM admin console
2. Monitor ingestion volume for 24-48h to confirm the drop
3. Trade-offs vs regulator: no auto-expiry, no per-pattern verification metric, no GitOps-reviewable identity (regex will drift)

## 9. Appendix

### Full pattern table

| identity | events | bytes | severity | service | sample |
|---|---|---|---|---|---|
| **Traces Debug Exporter**<br>`traces_resource_service_instance_id_se…` | 325 | 63.6 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:27.100Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **Logs Debug Exporter**<br>`logs_resource_service_instance_id_serv…` | 201 | 41.7 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:27.592Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **Logs Debug Exporter**<br>`logs_resource_service_instance_id_serv…` | 154 | 32.9 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:24.942Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **Metrics Debug Exporter**<br>`metrics_resource_service_instance_id_s…` | 129 | 26.4 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:30.514Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **Metrics Upload Failure**<br>`failed_to_upload_metrics_post_https_ot…` | 38 | 7.3 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:30.030Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **AdService Missing Baggage**<br>`oteldemo_adservice_no_baggage_found_in…` | 34 | 6.9 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:29.217Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **Traces Debug Exporter**<br>`traces_resource_service_instance_id_se…` | 27 | 5.9 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:35.515Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **LocalLog Segment Roll**<br>`info_locallog_partition_cluster_metada…` | 26 | 5.9 KB | INFO | opentelemetry-collector | `[2025-10-01 22:24:26,903] INFO [LocalLog partition=__cluster_metadata-0, dir=/t…` |
| **KRaft Snapshot Create**<br>`info_snapshotgenerator_id_creating_new…` | 20 | 4.8 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:37.144Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **ProducerState Snapshot Write**<br>`info_producerstatemanager_partition_cl…` | 20 | 4.3 KB | INFO | opentelemetry-collector | `[2025-10-01 22:24:26,903] INFO [ProducerStateManager partition=__cluster_metada…` |
| **Offset Index Deleted**<br>`info_deleted_offset_index_tmp_kafka_lo…` | 24 | 4.1 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:52.986Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **SnapshotEmitter Wrote Snapshot**<br>`info_snapshotemitter_id_successfully_w…` | 16 | 3.9 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:37.329Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **Log Segment Deleted**<br>`info_deleted_log_tmp_kafka_logs_cluste…` | 24 | 3.7 KB | INFO | cart | `2025-10-01T22:24:52.691Z info Metrics {"resource": {"service.instance.id": "16a…` |
| **UnifiedLog Offset Increment**<br>`info_unifiedlog_partition_cluster_meta…` | 18 | 3.5 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:53.010Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **Time Index Deleted**<br>`info_deleted_time_index_tmp_kafka_logs…` | 24 | 3.0 KB | INFO | cart | `2025-10-01T22:24:53.211Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **Snapshot Marked Deletion**<br>`info_partition_cluster_metadata_nodeid…` | 17 | 2.9 KB | INFO | opentelemetry-collector | `[2025-10-01 22:24:56,940] INFO [ProducerStateManager partition=__cluster_metada…` |
| **Shipping Quote Failure**<br>`internal_shipping_quote_failure_failed…` | 15 | 2.8 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| **Producer Snapshot Deleted**<br>`info_deleted_producer_state_snapshot_t…` | 24 | 2.8 KB | INFO | cart | `2025-10-01T22:24:54.421Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **ListRecommendations Trace**<br>`main_recommendation_server_py_trace_id…` | 12 | 2.7 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=` |
| **UnifiedLog Segment Breach Delete**<br>`info_unifiedlog_partition_cluster_meta…` | 12 | 2.6 KB | INFO | opentelemetry-collector | `[2025-10-01 22:24:56,939] INFO [LocalLog partition=__cluster_metadata-0, dir=/t…` |
| **Snapshot Files Deleted**<br>`info_deleted_snapshot_files_for_snapsh…` | 17 | 2.2 KB | INFO | cart | `at <unknown> (.next/server/pages/api/checkout.js:1:4375)` |
| **Traces Debug Exporter**<br>`traces_resource_service_instance_id_se…` | 9 | 2.2 KB | INFO | opentelemetry-collector | `[2025-10-01 22:25:56,494] INFO [SnapshotGenerator id=1] Creating new KRaft snap…` |
| **LocalLog Segment Files Deletion**<br>`info_locallog_partition_cluster_metada…` | 12 | 1.9 KB | INFO | cart | `at new Promise (<anonymous>) {` |
| **Kube Metadata Filter Stats**<br>`info_0_filter_kube_metadata_stats_name…` | 10 | 1.6 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| **ListRecommendations Trace**<br>`main_recommendation_server_py_trace_id…` | 6 | 1.4 KB | INFO | opentelemetry-collector | `2025-10-01T22:25:21.618Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **AdService Targeted Accessories**<br>`oteldemo_adservice_targeted_ad_request…` | 7 | 1.2 KB | INFO | opentelemetry-collector | `2025-10-01T22:25:02.919Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **Metrics Debug Exporter**<br>`metrics_resource_service_instance_id_s…` | 5 | 1.1 KB | INFO | opentelemetry-collector | `2025/10/01 22:24:41 failed to upload metrics: Post "https://otel-collector:4318…` |
| **AdService Targeted Generic**<br>`oteldemo_adservice_targeted_ad_request…` | 5 | 1.0 KB | INFO | opentelemetry-collector | `2025-10-01T22:24:29.422Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **AdService Targeted Assembly**<br>`oteldemo_adservice_targeted_ad_request…` | 5 | 1.0 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=940f8ddc-9f15-11f0-9b9e-a666c4b68b87` |
| **AdService Random Response**<br>`oteldemo_adservice_non_targeted_ad_req…` | 4 | 1004 B | INFO | opentelemetry-collector | `GetCartAsync called with userId=6768f96c-9f15-11f0-9b9e-a666c4b68b87` |
| **Shipping Quote Failure**<br>`internal_shipping_quote_failure_failed…` | 5 | 994 B | INFO | cart | `info: cart.cartstore.ValkeyCartStore[0]` |
| **Metrics Debug Exporter**<br>`metrics_resource_service_instance_id_s…` | 2 | 946 B | INFO | opentelemetry-collector | `2025-10-01T22:25:21.620Z info Metrics {"resource": {"service.instance.id": "16a…` |
| **SnapshotEmitter Plus CartStore**<br>`info_snapshotemitter_id_successfully_w…` | 3 | 908 B | INFO | opentelemetry-collector | `[2025-10-01 22:27:04,253] INFO [UnifiedLog partition=__cluster_metadata-0, dir=…` |
| **Metrics Debug Exporter**<br>`metrics_resource_service_instance_id_s…` | 4 | 853 B | INFO | opentelemetry-collector | `[2025-10-01 22:26:42,038] INFO [LocalLog partition=__cluster_metadata-0, dir=/t…` |
| **Grafana Alert Notifier Send**<br>`logger_sender_router_rule_uid_org_id_t…` | 3 | 826 B | INFO | opentelemetry-collector | `2025-10-01T22:24:50.201Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **Traces Debug Exporter**<br>`traces_resource_service_instance_id_se…` | 3 | 780 B | INFO | opentelemetry-collector | `2025-10-01T22:25:11.687Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **AdService Targeted Binoculars**<br>`oteldemo_adservice_targeted_ad_request…` | 3 | 731 B | INFO | kafka | `[2025-10-01 22:25:04,252] INFO Deleted producer state snapshot /tmp/kafka-logs/…` |
| **AdService Targeted Books**<br>`oteldemo_adservice_targeted_ad_request…` | 4 | 701 B | INFO | opentelemetry-collector | `2025-10-01T22:24:39.180Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **ListRecommendations Trace**<br>`main_recommendation_server_py_trace_id…` | 3 | 689 B | INFO | opentelemetry-collector | `2025-10-01T22:26:32.721Z info Metrics {"resource": {"service.instance.id": "16a…` |
| **ListRecommendations Trace**<br>`main_recommendation_server_py_trace_id…` | 3 | 688 B | INFO | opentelemetry-collector | `2025-10-01T22:25:24.031Z info Metrics {"resource": {"service.instance.id": "16a…` |
| **Shipping Quote Failure**<br>`internal_shipping_quote_failure_failed…` | 2 | 676 B | INFO | opentelemetry-collector | `2025-10-01T22:26:17.468Z info Metrics {"resource": {"service.instance.id": "16a…` |
| **LocalLog Segment Files Deletion**<br>`info_locallog_partition_cluster_metada…` | 6 | 632 B | INFO | cart | `2025-10-01T22:24:52.379Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| **Traces Debug Exporter**<br>`traces_resource_service_instance_id_se…` | 3 | 598 B | INFO | opentelemetry-collector | `2025/10/01 22:24:31 failed to upload metrics: Post "https://otel-collector:4318…` |
| **UnifiedLog Segment Breach Delete**<br>`info_unifiedlog_partition_cluster_meta…` | 6 | 573 B | INFO | cart | `[2025-10-01 22:24:57,938] INFO [SnapshotGenerator id=1] Creating new KRaft snap…` |
| **ProducerState Snapshot Legacy**<br>`info_producerstatemanager_partition_cl…` | 2 | 493 B | INFO | opentelemetry-collector | `2025-10-01T22:24:47.187Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **ListRecommendations Trace**<br>`main_recommendation_server_py_trace_id…` | 2 | 452 B | INFO | opentelemetry-collector | `2025/10/01 22:24:51 failed to upload metrics: Post "https://otel-collector:4318…` |
| **Logs Debug Exporter**<br>`logs_resource_service_instance_id_serv…` | 2 | 451 B | INFO | opentelemetry-collector | `2025/10/01 22:25:21 failed to upload metrics: Post "https://otel-collector:4318…` |
| **Out-Of-Order Exemplars Dropped**<br>`time_level_warn_source_write_handler_g…` | 2 | 450 B | INFO | opentelemetry-collector | `2025-10-01T22:24:40.361Z info Traces {"resource": {"service.instance.id": "16a4…` |
| **Grafana Alert Notifier Send**<br>`logger_sender_router_rule_uid_org_id_t…` | 3 | 432 B | INFO | frontend | `details: 'shipping quote failure: failed POST to shipping service: Post "shippi…` |
| **Shipping Quote Failure**<br>`internal_shipping_quote_failure_failed…` | 2 | 413 B | INFO | opentelemetry-collector | `2025-10-01T22:24:37.946Z info Traces {"resource": {"service.instance.id": "16a4…` |

_47 additional patterns omitted from the table (see JSON summary)._

### SIEM query used

```
index:main
```

### Methodology

- **Pattern identity** is the Log10x `templateHash` — a stable field-set fingerprint computed from the token structure of the event. Identity stays constant across deploys, restarts, pod names, timestamps, and request IDs.
- **Cost model**: `bytes × analyzer_cost_per_gb` over the pulled window. Window cost is projected to weekly cost via `$/window × (168h / window_hours)`.
- **Recommendation rules**: mute when pattern is DEBUG/INFO or below a minimum-value bar AND ≥1% of total volume; sample when MAX 10/s; keep when ERROR or WARN.
- **Confidence** is `high` for patterns with ≥100 events in the window (stable rate), `medium` for 10-99, `low` for <10.

### Run metadata

- **snapshot_id**: `7627e2c2-1645-4d16-8c6f-ff5908635b8f`
- **started**: 2026-04-20T16:55:51.417Z
- **finished**: 2026-04-20T16:56:00.623Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 1163 (templater 8042ms)
- **events_analyzed**: 1.4K / target 3.0K (error)
- **bytes_analyzed**: 268.9 KB
- **execution_mode**: local_cli
- **volume_scaling**: 100 GB/day (costs scaled from sample)
- **ai_prettify**: 31 patterns renamed via subagent-simulated MCP sampling
- **pull notes**:
  - datadog_page_error: HTTP-Code: 429
Message: {"additionalProperties":{"status":"error","code":429,"statuspage":"http://status.us5.datadoghq.com","twitter":"http://twitter.com/datadogops","email":"support@datadoghq.com"},"


_Report saved to: /tmp/log10x-reports/poc_from_siem-2026-04-20T16-56-00.635Z.md_