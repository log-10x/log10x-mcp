> **Note**: Pull stopped at 2,000 events (reason: error). Rerun with a larger max_pull_minutes for deeper coverage.

> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.

# Log10x POC Report — Datadog

_24h window · scope=`main` · snapshot_id=`409ff14e-8751-49ce-9a7f-d09e59409ae1`_

## 1. Executive Summary

Analyzed **1.5K events** (336.1 KB) from Datadog across the last 24h.

- **Observed cost (window)**: $0.00
- **Projected weekly cost**: $0.01
- **Potential savings (window)**: $0.00 — 0.1% of analyzed cost
- **Analyzer rate**: $2.50/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Mute `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` → save $0.00
- Mute `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` → save $0.00
- Mute `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` → save $0.00

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | INFO | 356 | 23% | $0.00 | $0.00 |  |
| 2 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | opentelemetry-collector | INFO | 250 | 16% | $0.00 | $0.00 |  |
| 3 | `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | opentelemetry-collector | INFO | 153 | 10% | $0.00 | $0.00 |  |
| 4 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | opentelemetry-collector | INFO | 144 | 9% | $0.00 | $0.00 |  |
| 5 | `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | opentelemetry-collector | INFO | 50 | 3% | $0.00 | $0.00 |  |
| 6 | `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | opentelemetry-collector | INFO | 44 | 3% | $0.00 | $0.00 |  |
| 7 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | INFO | 35 | 2% | $0.00 | $0.00 |  |
| 8 | `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | opentelemetry-collector | INFO | 29 | 2% | $0.00 | $0.00 |  |
| 9 | `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | opentelemetry-collector | INFO | 29 | 2% | $0.00 | $0.00 |  |
| 10 | `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | opentelemetry-collector | INFO | 29 | 2% | $0.00 | $0.00 |  |
| 11 | `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | opentelemetry-collector | INFO | 29 | 2% | $0.00 | $0.00 |  |
| 12 | `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | opentelemetry-collector | INFO | 29 | 2% | $0.00 | $0.00 |  |
| 13 | `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | opentelemetry-collector | INFO | 24 | 2% | $0.00 | $0.00 |  |
| 14 | `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | opentelemetry-collector | INFO | 23 | 1% | $0.00 | $0.00 |  |
| 15 | `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | opentelemetry-collector | INFO | 22 | 1% | $0.00 | $0.00 |  |
| 16 | `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | opentelemetry-collector | INFO | 21 | 1% | $0.00 | $0.00 |  |
| 17 | `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | opentelemetry-collector | INFO | 20 | 1% | $0.00 | $0.00 |  |
| 18 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | INFO | 16 | 1% | $0.00 | $0.00 |  |
| 19 | `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | opentelemetry-collector | INFO | 22 | 1% | $0.00 | $0.00 |  |
| 20 | `info_0_filter_kube_metadata_stats_namespace_cache_size_pod_cache_size_pod_cache_api_updates_id_cache_miss_1_pod_cache_ho` | opentelemetry-collector | INFO | 14 | 0.9% | $0.00 | $0.00 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| opentelemetry-collector | 1.5K | $0.00 | INFO 100% |
| kafka | 23 | $0.00 | INFO 100% |
| cart | 14 | $0.00 | INFO 100% |
| frontend | 4 | $0.00 | INFO 100% |
| ad | 4 | $0.00 | INFO 100% |

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (23% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "High-volume INFO pattern (23% of analyzed volume) — candidate for mute after dependency check."
```

### #2 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (16% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "High-volume INFO pattern (16% of analyzed volume) — candidate for mute after dependency check."
```

### #3 — `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (10% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c
  action: drop
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "High-volume INFO pattern (10% of analyzed volume) — candidate for mute after dependency check."
```

### #4 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (9% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "High-volume INFO pattern (9% of analyzed volume) — candidate for mute after dependency check."
```

### #5 — `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags`  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags
  action: drop
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check."
```

### #6 — `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client`  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client
  action: drop
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check."
```

### #7 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (2% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "High-volume INFO pattern (2% of analyzed volume) — candidate for mute after dependency check."
```

### #8 — `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals
  action: sample
    sampleRate: 20
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #9 — `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog
  action: sample
    sampleRate: 20
  untilEpochSec: 1779248793   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #10 — `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment
  action: sample
    sampleRate: 20
  untilEpochSec: 1779248793   # auto-expires in 30d
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
  "name": "Drop metrics_resource_service_instance_id_ser",
  "is_enabled": true,
  "filter": {
    "query": "@message:/metrics.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*c/"
  }
}

# Exclusion filter #4
{
  "name": "Drop logs_resource_service_instance_id_servic",
  "is_enabled": true,
  "filter": {
    "query": "@message:/logs.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*comp/"
  }
}

# Exclusion filter #5
{
  "name": "Drop oteldemo_adservice_no_baggage_found_in_c",
  "is_enabled": true,
  "filter": {
    "query": "@message:/oteldemo.*adservice.*no.*baggage.*found.*in.*context.*trace.*id.*span.*id.*trace.*flags/"
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
    Exclude    log metrics.*resource.*service
# pattern identity: metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c (#3)

[FILTER]
    Name       grep
    Match      *
    Exclude    log logs.*resource.*service
# pattern identity: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp (#4)

[FILTER]
    Name       grep
    Match      *
    Exclude    log oteldemo.*adservice.*no
# pattern identity: oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags (#5)
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
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 356 | 77.7 KB | INFO | opentelemetry-collector | `at <unknown> (.next/server/pages/api/checkout.js:1:4375)` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 250 | 54.6 KB | INFO | opentelemetry-collector | `code: 13,` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 153 | 35.4 KB | INFO | opentelemetry-collector | `}` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 144 | 33.4 KB | INFO | opentelemetry-collector | `at new Promise (<anonymous>) {` |
| `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | 50 | 11.1 KB | INFO | opentelemetry-collector | `[2025-10-01 20:29:35,267] INFO [ProducerStateManager partition=__cluster_metada…` |
| `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | 44 | 10.1 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:26.584Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 35 | 7.5 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | 29 | 6.3 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:56.303Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | 29 | 6.2 KB | INFO | opentelemetry-collector | `2025/10/01 20:29:31 failed to upload metrics: Post "https://otel-collector:4318…` |
| `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | 29 | 5.7 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:55.605Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | 29 | 5.4 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:55.901Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | 29 | 5.2 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:55.790Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | 24 | 5.0 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | 23 | 4.8 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=53015970-9f05-11f0-9b9e-a666c4b68b87` |
| `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | 22 | 4.6 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=642c4912-9f05-11f0-9b9e-a666c4b68b87` |
| `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | 21 | 4.4 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=` |
| `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | 20 | 3.8 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 16 | 3.8 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:44.052Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | 22 | 3.6 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:54.974Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_0_filter_kube_metadata_stats_namespace_cache_size_pod_cache_size_pod_cache_api_updates_id_cache_miss_1_pod_cache_ho` | 14 | 3.3 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=5e521828-9f05-11f0-9b9e-a666c4b68b87` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 15 | 2.7 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 11 | 2.6 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:37.796Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 10 | 2.4 KB | INFO | opentelemetry-collector | `logger=ngalert.sender.router rule_uid=des78nlna99tsf org_id=1 t=2025-10-01T20:3…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 15 | 2.3 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=` |
| `oteldemo_adservice_targeted_ad_request_received_for_travel_trace_id_span_id_trace_flags` | 11 | 2.2 KB | INFO | opentelemetry-collector | `2025-10-01T20:30:27.202Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `oteldemo_adservice_targeted_ad_request_received_for_binoculars_trace_id_span_id_trace_flags` | 7 | 1.8 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:35.764Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 7 | 1.7 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:55.499Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `logger_sender_router_rule_uid_org_id_t_level_info_msg_sending_alerts_to_local_notifier_count1` | 6 | 1.6 KB | INFO | opentelemetry-collector | `2025-10-01 20:29:54 - oteldemo.AdService - Targeted ad request received for [bo…` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 7 | 1.5 KB | INFO | opentelemetry-collector | `2025-10-01T20:31:08.154Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 7 | 1.5 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:57.909Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `oteldemo_adservice_targeted_ad_request_received_for_books_trace_id_span_id_trace_flags` | 6 | 1.2 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 5 | 1.2 KB | INFO | kafka | `GetCartAsync called with userId=53015970-9f05-11f0-9b9e-a666c4b68b87` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 6 | 1.2 KB | INFO | opentelemetry-collector | `2025-10-01T20:29:48.069Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 4 | 1.2 KB | INFO | opentelemetry-collector | `2025-10-01T20:30:46.071Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `oteldemo_adservice_non_targeted_ad_request_received_preparing_random_response_trace_id_span_id_trace_flags` | 4 | 1.1 KB | INFO | opentelemetry-collector | `2025-10-01T20:30:17.167Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `oteldemo_adservice_targeted_ad_request_received_for_accessories_trace_id_span_id_trace_flags` | 5 | 1.0 KB | INFO | opentelemetry-collector | `2025-10-01T20:30:38.906Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 4 | 967 B | INFO | opentelemetry-collector | `2025-10-01T20:32:29.257Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `time_level_warn_source_write_handler_go_msg_error_on_ingesting_out_of_order_exemplars_component_web_num_dropped` | 3 | 935 B | INFO | opentelemetry-collector | `2025-10-01T20:30:34.049Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 5 | 844 B | INFO | opentelemetry-collector | `[2025-10-01 20:29:35,266] INFO [LocalLog partition=__cluster_metadata-0, dir=/t…` |
| `oteldemo_adservice_targeted_ad_request_received_for_assembly_trace_id_span_id_trace_flags` | 3 | 838 B | INFO | opentelemetry-collector | `2025-10-01T20:31:20.018Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 4 | 759 B | INFO | cart | `2025-10-01T20:31:50.516Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `oteldemo_adservice_targeted_ad_request_received_for_assembly_trace_id_span_id_trace_flags_info_cart_cartstore_valkeycart` | 3 | 728 B | INFO | opentelemetry-collector | `AddItemAsync called with userId=9d2965ce-9f05-11f0-9b9e-a666c4b68b87, productId…` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 3 | 672 B | INFO | frontend | `Error: 13 INTERNAL: shipping quote failure: failed POST to shipping service: Po…` |
| `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter_info_cart_cartstore` | 2 | 648 B | INFO | opentelemetry-collector | `2025-10-01T20:29:43.045Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | 2 | 648 B | INFO | opentelemetry-collector | `2025-10-01T20:31:24.883Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 3 | 594 B | INFO | kafka | `[2025-10-01 20:32:35,454] INFO [ProducerStateManager partition=__cluster_metada…` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_ms_org_apach` | 2 | 477 B | INFO | opentelemetry-collector | `2025-10-01T20:29:31.906Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 2 | 392 B | INFO | kafka | `[2025-10-01 20:32:04,914] INFO [SnapshotGenerator id=1] Creating new KRaft snap…` |
| `oteldemo_adservice_targeted_ad_request_received_for_accessories_trace_id_span_id_trace_flags_info_cart_cartstore_valkeyc` | 1 | 356 B | INFO | kafka | `[2025-10-01 20:35:04,194] INFO [LocalLog partition=__cluster_metadata-0, dir=/t…` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 1 | 337 B | INFO | opentelemetry-collector | `2025-10-01T20:32:47.416Z info Metrics {"resource": {"service.instance.id": "16a…` |

_43 additional patterns omitted from the table (see JSON summary)._

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

- **snapshot_id**: `409ff14e-8751-49ce-9a7f-d09e59409ae1`
- **started**: 2026-04-20T03:46:23.040Z
- **finished**: 2026-04-20T03:46:33.540Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 1264 (templater 9234ms)
- **events_analyzed**: 1.5K / target 5.0K (error)
- **bytes_analyzed**: 336.1 KB
- **execution_mode**: local_cli
- **pull notes**:
  - datadog_page_error: HTTP-Code: 429
Message: {"additionalProperties":{"status":"error","code":429,"statuspage":"http://status.us5.datadoghq.com","twitter":"http://twitter.com/datadogops","email":"support@datadoghq.com"},"


_Report saved to: /tmp/log10x-reports/poc_from_siem-2026-04-20T03-46-33.548Z.md_