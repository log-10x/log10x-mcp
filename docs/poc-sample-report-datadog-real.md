> **Note**: Pull stopped at 2,000 events (reason: error). Rerun with a larger max_pull_minutes for deeper coverage.

> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.

# Log10x POC Report — Datadog

_24h window · scope=`main` · snapshot_id=`83657028-d5f8-46b2-92c2-949dcb09096a`_

## 1. Executive Summary

Analyzed **1.4K events** (302.9 KB) from Datadog across the last 24h.

> **Volume-scaled mode**: costs below extrapolate the sample's pattern distribution to the supplied 100 GB/day ingest rate. Shown dollar figures represent projected spend across the full daily volume, not the sample's own cost. Set to 0 or omit `total_daily_gb` to see raw sample-only costs.

- **Projected daily cost**: $250
- **Projected weekly cost**: $1.8K
- **Projected annual cost**: $91K
- **Potential annual savings**: $77K — 85% of annual cost
- **Analyzer rate**: $2.50/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Mute `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` → save $60
- Mute `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` → save $36
- Mute `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` → save $27

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | INFO | 342 | 24% | $60 | $422 |  |
| 2 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | opentelemetry-collector | INFO | 208 | 14% | $36 | $250 |  |
| 3 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | opentelemetry-collector | INFO | 158 | 11% | $27 | $192 |  |
| 4 | `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | opentelemetry-collector | INFO | 137 | 9% | $26 | $181 |  |
| 5 | `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | opentelemetry-collector | INFO | 41 | 3% | $6.6 | $46 |  |
| 6 | `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | opentelemetry-collector | INFO | 30 | 2% | $6.2 | $43 |  |
| 7 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | INFO | 35 | 2% | $6.0 | $42 |  |
| 8 | `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | opentelemetry-collector | INFO | 28 | 2% | $4.6 | $32 |  |
| 9 | `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | opentelemetry-collector | INFO | 28 | 2% | $4.6 | $32 |  |
| 10 | `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | opentelemetry-collector | INFO | 21 | 1% | $4.5 | $32 |  |
| 11 | `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | opentelemetry-collector | INFO | 27 | 2% | $4.1 | $29 |  |
| 12 | `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | opentelemetry-collector | INFO | 28 | 2% | $4.1 | $29 |  |
| 13 | `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | opentelemetry-collector | INFO | 28 | 2% | $4.0 | $28 |  |
| 14 | `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | opentelemetry-collector | INFO | 18 | 1% | $3.8 | $27 |  |
| 15 | `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | opentelemetry-collector | INFO | 22 | 2% | $3.6 | $25 |  |
| 16 | `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | opentelemetry-collector | INFO | 20 | 1% | $3.3 | $23 |  |
| 17 | `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | opentelemetry-collector | INFO | 21 | 1% | $3.0 | $21 |  |
| 18 | `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | cart | INFO | 22 | 2% | $2.7 | $19 |  |
| 19 | `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | opentelemetry-collector | INFO | 12 | 0.8% | $2.5 | $18 |  |
| 20 | `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | opentelemetry-collector | INFO | 16 | 1% | $2.4 | $17 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| opentelemetry-collector | 1.4K | $239 | INFO 100% |
| cart | 47 | $5.0 | INFO 100% |
| kafka | 22 | $3.2 | INFO 100% |
| recommendation | 6 | $1.2 | INFO 100% |
| grafana | 5 | $0.69 | INFO 100% |
| valkey-cart | 2 | $0.29 | INFO 100% |
| ad | 2 | $0.26 | INFO 100% |
| frontend | 3 | $0.24 | INFO 100% |

> ⚠ **Anomaly**: `opentelemetry-collector` is 96% of analyzed cost. One service dominating spend is either a hot-loop emitter (filter opportunity) or a mis-routed service (instrumentation issue).

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (24% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $60
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "High-volume INFO pattern (24% of analyzed volume) — candidate for mute after dependency check."
```

### #2 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (14% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $36
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "High-volume INFO pattern (14% of analyzed volume) — candidate for mute after dependency check."
```

### #3 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (11% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $27
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "High-volume INFO pattern (11% of analyzed volume) — candidate for mute after dependency check."
```

### #4 — `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (9% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $26
- **Dependency warning**: run `log10x_dependency_check(pattern: "metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c
  action: drop
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "High-volume INFO pattern (9% of analyzed volume) — candidate for mute after dependency check."
```

### #5 — `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client`  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $6.6
- **Dependency warning**: run `log10x_dependency_check(pattern: "failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client
  action: drop
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "High-volume INFO pattern (3% of analyzed volume) — candidate for mute after dependency check."
```

### #6 — `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags`  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (2% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $6.2
- **Dependency warning**: run `log10x_dependency_check(pattern: "oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags
  action: drop
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "High-volume INFO pattern (2% of analyzed volume) — candidate for mute after dependency check."
```

### #7 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (2% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $6.0
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "High-volume INFO pattern (2% of analyzed volume) — candidate for mute after dependency check."
```

### #8 — `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $4.4
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals
  action: sample
    sampleRate: 20
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #9 — `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $4.3
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm
  action: sample
    sampleRate: 20
  untilEpochSec: 1779293522   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #10 — `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $4.3
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k
  action: sample
    sampleRate: 20
  untilEpochSec: 1779293522   # auto-expires in 30d
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
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 342 | 73.0 KB | INFO | opentelemetry-collector | `2025-10-01T22:17:57.828Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 208 | 43.3 KB | INFO | opentelemetry-collector | `2025-10-01T22:17:57.470Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 158 | 33.2 KB | INFO | opentelemetry-collector | `AddItemAsync called with userId=7ef424f4-9f14-11f0-9b9e-a666c4b68b87, productId…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 137 | 31.3 KB | INFO | opentelemetry-collector | `2025-10-01T22:17:57.978Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | 41 | 8.0 KB | INFO | opentelemetry-collector | `2025/10/01 22:18:01 failed to upload metrics: Post "https://otel-collector:4318…` |
| `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | 30 | 7.5 KB | INFO | opentelemetry-collector | `2025-10-01 22:18:01 - oteldemo.AdService - no baggage found in context trace_id…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 35 | 7.2 KB | INFO | opentelemetry-collector | `2025/10/01 22:18:11 failed to upload metrics: Post "https://otel-collector:4318…` |
| `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | 28 | 5.6 KB | INFO | opentelemetry-collector | `[2025-10-01 22:18:04,241] INFO [UnifiedLog partition=__cluster_metadata-0, dir=…` |
| `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | 28 | 5.5 KB | INFO | opentelemetry-collector | `[2025-10-01 22:18:04,240] INFO [UnifiedLog partition=__cluster_metadata-0, dir=…` |
| `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | 21 | 5.5 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:06.061Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | 27 | 5.0 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:07.471Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | 28 | 4.9 KB | INFO | opentelemetry-collector | `retention (60000) (kafka.raft.KafkaMetadataLog)` |
| `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | 28 | 4.8 KB | INFO | opentelemetry-collector | `[2025-10-01 22:18:04,240] INFO [UnifiedLog partition=__cluster_metadata-0, dir=…` |
| `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | 18 | 4.6 KB | INFO | opentelemetry-collector | `2025-10-01 22:18:07 - oteldemo.AdService - no baggage found in context trace_id…` |
| `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | 22 | 4.3 KB | INFO | opentelemetry-collector | `retention (60000) (kafka.raft.KafkaMetadataLog)` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | 20 | 4.0 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=` |
| `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | 21 | 3.7 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:02.600Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | 22 | 3.3 KB | INFO | cart | `info: cart.cartstore.ValkeyCartStore[0]` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 12 | 3.0 KB | INFO | opentelemetry-collector | `2025-10-01T22:19:32.586Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 16 | 2.9 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=` |
| `info_0_filter_kube_metadata_stats_namespace_cache_size_pod_cache_size_pod_cache_api_updates_id_cache_miss_1` | 12 | 2.9 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:17.526Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 11 | 2.4 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:47.516Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 16 | 2.2 KB | INFO | opentelemetry-collector | `GetCartAsync called with userId=7ef424f4-9f14-11f0-9b9e-a666c4b68b87` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 8 | 2.0 KB | INFO | opentelemetry-collector | `2025-10-01 22:18:11 - oteldemo.AdService - no baggage found in context trace_id…` |
| `oteldemo_adservice_targeted_ad_request_received_for_assembly_trace_id_span_id_trace_flags` | 7 | 1.7 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:21.070Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 6 | 1.3 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:52.878Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 6 | 1.3 KB | INFO | opentelemetry-collector | `[2025-10-01 22:18:04,242] INFO [MetadataLog partition=__cluster_metadata-0, nod…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 4 | 1.2 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:17.471Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 6 | 1.2 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 5 | 1.2 KB | INFO | opentelemetry-collector | `[2025-10-01 22:19:26,160] INFO [SnapshotGenerator id=1] Creating new KRaft snap…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 5 | 1.2 KB | INFO | opentelemetry-collector | `2025-10-01T22:19:40.468Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `oteldemo_adservice_non_targeted_ad_request_received_preparing_random_response_trace_id_span_id_trace_flags` | 5 | 1.1 KB | INFO | opentelemetry-collector | `2025-10-01 22:17:57 - oteldemo.AdService - Non-targeted ad request received, pr…` |
| `oteldemo_adservice_targeted_ad_request_received_for_travel_trace_id_span_id_trace_flags` | 5 | 1.1 KB | INFO | kafka | `2025-10-01 22:18:01 - oteldemo.AdService - Targeted ad request received for [tr…` |
| `oteldemo_adservice_targeted_ad_request_received_for_trace_id_span_id_trace_flags` | 4 | 1.0 KB | INFO | opentelemetry-collector | `2025-10-01T22:18:10.242Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 3 | 961 B | INFO | opentelemetry-collector | `2025-10-01T22:18:31.575Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `logger_sender_router_rule_uid_org_id_t_level_info_msg_sending_alerts_to_local_notifier_count1` | 4 | 709 B | INFO | grafana | `logger=ngalert.sender.router rule_uid=des78nlna99tsf org_id=1 t=2025-10-01T22:1…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 3 | 688 B | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 4 | 687 B | INFO | kafka | `GetCartAsync called with userId=` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_ms_org_apach` | 3 | 663 B | INFO | opentelemetry-collector | `2025-10-01T22:18:07.479Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 3 | 662 B | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 3 | 661 B | INFO | opentelemetry-collector | `2025-10-01T22:21:03.634Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 2 | 624 B | INFO | opentelemetry-collector | `2025-10-01T22:18:28.191Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `oteldemo_adservice_targeted_ad_request_received_for_travel_trace_id_span_id_trace_flags_info_cart_cartstore_valkeycartst` | 2 | 623 B | INFO | opentelemetry-collector | `2025-10-01T22:18:07.885Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `c_db_saved_on_disk` | 2 | 622 B | INFO | opentelemetry-collector | `2025-10-01T22:18:48.658Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `c_fork_cow_for_rdb_current_mb_peak_1_mb_average_1_mb` | 2 | 619 B | INFO | opentelemetry-collector | `2025-10-01T22:18:48.931Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 2 | 619 B | INFO | recommendation | `2025-10-01 22:22:56,966 INFO [main] [recommendation_server.py:47] [trace_id=a19…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 3 | 615 B | INFO | recommendation | `2025-10-01 22:17:58,480 INFO [main] [recommendation_server.py:47] [trace_id=ff6…` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 3 | 597 B | INFO | kafka | `[2025-10-01 22:20:04,242] INFO [MetadataLog partition=__cluster_metadata-0, nod…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 4 | 522 B | INFO | cart | `info: cart.cartstore.ValkeyCartStore[0]` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 2 | 397 B | INFO | cart | `info: cart.cartstore.ValkeyCartStore[0]` |

_48 additional patterns omitted from the table (see JSON summary)._

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

- **snapshot_id**: `83657028-d5f8-46b2-92c2-949dcb09096a`
- **started**: 2026-04-20T16:11:53.885Z
- **finished**: 2026-04-20T16:12:02.932Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 1223 (templater 7821ms)
- **events_analyzed**: 1.4K / target 3.0K (error)
- **bytes_analyzed**: 302.9 KB
- **execution_mode**: local_cli
- **volume_scaling**: 100 GB/day (costs scaled from sample)
- **pull notes**:
  - datadog_page_error: HTTP-Code: 429
Message: {"additionalProperties":{"status":"error","code":429,"statuspage":"http://status.us5.datadoghq.com","twitter":"http://twitter.com/datadogops","email":"support@datadoghq.com"},"


_Report saved to: /tmp/log10x-reports/poc_from_siem-2026-04-20T16-12-02.944Z.md_