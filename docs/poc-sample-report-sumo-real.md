> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.

# Log10x POC Report — Sumo Logic

_24h window · scope=`Http Input` · snapshot_id=`d00e287d-b0a5-464f-bb9e-20bbcaa1967d`_

## 1. Executive Summary

Analyzed **3.6K events** (749.4 KB) from Sumo Logic across the last 24h.

- **Observed cost (window)**: $0.00
- **Projected weekly cost**: $0.00
- **Potential savings (window)**: $0.00 — 0.0% of analyzed cost
- **Analyzer rate**: $0.25/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Mute `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` → save $0.00
- Mute `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` → save $0.00
- Mute `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` → save $0.00

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | Http Input | DEBUG | 796 | 22% | $0.00 | $0.00 |  |
| 2 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | Http Input | DEBUG | 497 | 14% | $0.00 | $0.00 |  |
| 3 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | Http Input | DEBUG | 399 | 11% | $0.00 | $0.00 |  |
| 4 | `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | Http Input | DEBUG | 342 | 9% | $0.00 | $0.00 |  |
| 5 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | Http Input | DEBUG | 105 | 3% | $0.00 | $0.00 |  |
| 6 | `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | Http Input | TRACE | 83 | 2% | $0.00 | $0.00 |  |
| 7 | `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | Http Input | ERROR | 84 | 2% | $0.00 | $0.00 |  |
| 8 | `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | Http Input | INFO | 66 | 2% | $0.00 | $0.00 |  |
| 9 | `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | Http Input | INFO | 66 | 2% | $0.00 | $0.00 |  |
| 10 | `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | Http Input | INFO | 66 | 2% | $0.00 | $0.00 |  |
| 11 | `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | Http Input | INFO | 67 | 2% | $0.00 | $0.00 |  |
| 12 | `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | Http Input | INFO | 52 | 1% | $0.00 | $0.00 |  |
| 13 | `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | Http Input | INFO | 55 | 2% | $0.00 | $0.00 |  |
| 14 | `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | Http Input | INFO | 60 | 2% | $0.00 | $0.00 |  |
| 15 | `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | Http Input | INFO | 50 | 1% | $0.00 | $0.00 |  |
| 16 | `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | Http Input | CRITICAL | 50 | 1% | $0.00 | $0.00 |  |
| 17 | `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | Http Input | INFO | 52 | 1% | $0.00 | $0.00 |  |
| 18 | `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | Http Input | TRACE | 47 | 1% | $0.00 | $0.00 |  |
| 19 | `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | Http Input | INFO | 49 | 1% | $0.00 | $0.00 |  |
| 20 | `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | Http Input | INFO | 36 | 1.0% | $0.00 | $0.00 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| Http Input | 3.6K | $0.00 | DEBUG 60%, INFO 23%, TRACE 7% |

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (22% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (22% of analyzed volume) — candidate for mute after dependency check."
```

### #2 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (14% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (14% of analyzed volume) — candidate for mute after dependency check."
```

### #3 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (11% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (11% of analyzed volume) — candidate for mute after dependency check."
```

### #4 — `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (9% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c
  action: drop
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (9% of analyzed volume) — candidate for mute after dependency check."
```

### #5 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (3% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (3% of analyzed volume) — candidate for mute after dependency check."
```

### #6 — `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags`  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume TRACE pattern (2% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags
  action: drop
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "High-volume TRACE pattern (2% of analyzed volume) — candidate for mute after dependency check."
```

### #7 — `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client`  _(medium confidence)_

- **Action**: keep
- **Reasoning**: severity=ERROR — keep for incident diagnosis.
- **Projected savings (window)**: $0.00
- **Dependency warning**: —

### #8 — `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment
  action: sample
    sampleRate: 20
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #9 — `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm
  action: sample
    sampleRate: 20
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #10 — `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen
  action: sample
    sampleRate: 20
  untilEpochSec: 1779286557   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

## 5. Native SIEM Exclusion Configs

Ready-to-paste configs for Sumo Logic and fluent-bit. Drop these into your pipeline **only** after running `log10x_dependency_check` on each pattern.

### Sumo Logic

```
# Drop rule #1 — Field Extraction Rules → Drop
matches "traces" AND matches "resource" AND matches "service"

# Drop rule #2 — Field Extraction Rules → Drop
matches "logs" AND matches "resource" AND matches "service"

# Drop rule #3 — Field Extraction Rules → Drop
matches "logs" AND matches "resource" AND matches "service"

# Drop rule #4 — Field Extraction Rules → Drop
matches "metrics" AND matches "resource" AND matches "service"

# Drop rule #5 — Field Extraction Rules → Drop
matches "traces" AND matches "resource" AND matches "service"
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
    Exclude    log traces.*resource.*service
# pattern identity: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co (#5)
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

1. Paste the Sumo Logic config from Section 5 into your SIEM admin console
2. Monitor ingestion volume for 24-48h to confirm the drop
3. Trade-offs vs regulator: no auto-expiry, no per-pattern verification metric, no GitOps-reviewable identity (regex will drift)

## 9. Appendix

### Full pattern table

| identity | events | bytes | severity | service | sample |
|---|---|---|---|---|---|
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 796 | 167.2 KB | DEBUG | Http Input | `2025-10-01T21:25:01.539Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 497 | 103.4 KB | DEBUG | Http Input | ` GetCartAsync called with userId=1730a34e-9f0d-11f0-9b9e-a666c4b68b87` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 399 | 79.7 KB | DEBUG | Http Input | `2025-10-01T21:25:00.116Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 342 | 72.1 KB | DEBUG | Http Input | `2025-10-01T21:24:59.732Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 105 | 21.7 KB | DEBUG | Http Input | `info: cart.cartstore.ValkeyCartStore[0]` |
| `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | 83 | 16.8 KB | TRACE | Http Input | `logger=ngalert.sender.router rule_uid=des78nlna99tsf org_id=1 t=2025-10-01T21:2…` |
| `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | 84 | 16.1 KB | ERROR | Http Input | ` GetCartAsync called with userId=` |
| `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | 66 | 14.0 KB | INFO | Http Input | `2025-10-01T21:24:19.122Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | 66 | 13.7 KB | INFO | Http Input | `2025-10-01T21:24:19.760Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | 66 | 13.6 KB | INFO | Http Input | `2025-10-01T21:24:19.358Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | 67 | 13.5 KB | INFO | Http Input | `2025-10-01T21:24:56.857Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | 52 | 12.2 KB | INFO | Http Input | `2025-10-01 21:24:16 - oteldemo.AdService - Targeted ad request received for [as…` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | 55 | 12.1 KB | INFO | Http Input | `2025-10-01T21:24:56.921Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | 60 | 12.1 KB | INFO | Http Input | `2025-10-01T21:24:20.326Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | 50 | 10.1 KB | INFO | Http Input | `2025-10-01 21:24:20 - oteldemo.AdService - no baggage found in context trace_id…` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 50 | 9.9 KB | CRITICAL | Http Input | `2025-10-01T21:24:40.049Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | 52 | 9.8 KB | INFO | Http Input | `2025-10-01T21:24:48.889Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 47 | 9.5 KB | TRACE | Http Input | `2025-10-01T21:24:58.084Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | 49 | 9.3 KB | INFO | Http Input | ` GetCartAsync called with userId=` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 36 | 8.1 KB | INFO | Http Input | `2025-10-01T21:24:11.725Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 31 | 6.1 KB | INFO | Http Input | `2025/10/01 21:24:11 failed to upload metrics: Post "https://otel-collector:4318…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | 29 | 6.1 KB | INFO | Http Input | ` GetCartAsync called with userId=` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 23 | 5.5 KB | — | Http Input | `2025-10-01T21:24:51.988Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | 21 | 4.8 KB | INFO | Http Input | `2025-10-01T21:24:11.525Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 20 | 4.4 KB | — | Http Input | `2025-10-01T21:23:03.844Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 19 | 3.7 KB | — | Http Input | `Error: 13 INTERNAL: shipping quote failure: failed POST to shipping service: Po…` |
| `info_0_filter_kube_metadata_stats_namespace_cache_size_pod_cache_size_pod_cache_api_updates_id_cache_miss_1_pod_cache_ho` | 18 | 3.6 KB | INFO | Http Input | `[2025-10-01 21:19:04,226] INFO Deleted producer state snapshot /tmp/kafka-logs/…` |
| `oteldemo_adservice_targeted_ad_request_received_for_travel_trace_id_span_id_trace_flags` | 16 | 3.6 KB | TRACE | Http Input | `2025-10-01 21:24:47,874 INFO [main] [recommendation_server.py:47] [trace_id=6b2…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 16 | 3.6 KB | INFO | Http Input | `2025-10-01T21:24:15.340Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `logger_sender_router_rule_uid_org_id_t_level_info_msg_sending_alerts_to_local_notifier_count1` | 14 | 3.5 KB | INFO | Http Input | ` GetCartAsync called with userId=1730a34e-9f0d-11f0-9b9e-a666c4b68b87` |
| `info_0_filter_kube_metadata_stats_namespace_cache_size_pod_cache_size_pod_cache_api_updates_id_cache_miss_1` | 16 | 3.4 KB | INFO | Http Input | `2025-10-01T21:24:56.046Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `oteldemo_adservice_targeted_ad_request_received_for_assembly_trace_id_span_id_trace_flags` | 18 | 3.1 KB | TRACE | Http Input | ` code: 13,` |
| `oteldemo_adservice_non_targeted_ad_request_received_preparing_random_response_trace_id_span_id_trace_flags` | 14 | 2.9 KB | TRACE | Http Input | `2025-10-01T21:23:07.473Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_ms_org_apach` | 13 | 2.9 KB | INFO | Http Input | `[2025-10-01 21:24:04,228] INFO Deleted log /tmp/kafka-logs/__cluster_metadata-0…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 13 | 2.7 KB | — | Http Input | `[2025-10-01 21:23:04,221] INFO [MetadataLog partition=__cluster_metadata-0, nod…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 15 | 2.7 KB | DEBUG | Http Input | `[2025-10-01 21:24:04,225] INFO Deleted snapshot files for snapshot OffsetAndEpo…` |
| `oteldemo_adservice_targeted_ad_request_received_for_accessories_trace_id_span_id_trace_flags` | 9 | 2.5 KB | TRACE | Http Input | `2025-10-01T21:18:51.636Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 12 | 2.4 KB | TRACE | Http Input | `info: cart.cartstore.ValkeyCartStore[0]` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 10 | 2.4 KB | TRACE | Http Input | `2025-10-01T21:22:47.440Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `oteldemo_adservice_targeted_ad_request_received_for_trace_id_span_id_trace_flags` | 11 | 2.3 KB | TRACE | Http Input | `info: cart.cartstore.ValkeyCartStore[0]` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 11 | 2.1 KB | — | Http Input | `2025-10-01 21:23:58,703 INFO [main] [recommendation_server.py:47] [trace_id=ebc…` |
| `oteldemo_adservice_targeted_ad_request_received_for_binoculars_trace_id_span_id_trace_flags` | 11 | 2.1 KB | TRACE | Http Input | `2025-10-01T21:23:53.423Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | 8 | 2.1 KB | INFO | Http Input | `2025-10-01 21:22:35,274 INFO [main] [recommendation_server.py:47] [trace_id=304…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 9 | 2.0 KB | INFO | Http Input | `2025-10-01T21:24:17.549Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 9 | 1.9 KB | TRACE | Http Input | `2025-10-01 21:24:07,027 INFO [main] [recommendation_server.py:47] [trace_id=9a3…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 6 | 1.6 KB | TRACE | Http Input | `2025-10-01T21:24:21.166Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 7 | 1.5 KB | INFO | Http Input | `2025-10-01T21:23:26.536Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 6 | 1.4 KB | — | Http Input | `2025-10-01T21:24:59.909Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `oteldemo_adservice_targeted_ad_request_received_for_books_trace_id_span_id_trace_flags` | 8 | 1.4 KB | TRACE | Http Input | `info: cart.cartstore.ValkeyCartStore[0]` |
| `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client_getcartasyn` | 6 | 1.2 KB | ERROR | Http Input | `2025-10-01T21:24:07.448Z info Logs {"resource": {"service.instance.id": "16a4f8…` |

_109 additional patterns omitted from the table (see JSON summary)._

### SIEM query used

```
_sourceCategory="Http Input"
```

### Methodology

- **Pattern identity** is the Log10x `templateHash` — a stable field-set fingerprint computed from the token structure of the event. Identity stays constant across deploys, restarts, pod names, timestamps, and request IDs.
- **Cost model**: `bytes × analyzer_cost_per_gb` over the pulled window. Window cost is projected to weekly cost via `$/window × (168h / window_hours)`.
- **Recommendation rules**: mute when pattern is DEBUG/INFO or below a minimum-value bar AND ≥1% of total volume; sample when MAX 10/s; keep when ERROR or WARN.
- **Confidence** is `high` for patterns with ≥100 events in the window (stable rate), `medium` for 10-99, `low` for <10.

### Run metadata

- **snapshot_id**: `d00e287d-b0a5-464f-bb9e-20bbcaa1967d`
- **started**: 2026-04-20T14:15:39.602Z
- **finished**: 2026-04-20T14:15:57.795Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 9888 (templater 8303ms)
- **events_analyzed**: 3.6K / target 5.0K (target_reached)
- **bytes_analyzed**: 749.4 KB
- **execution_mode**: local_cli


_Report saved to: /tmp/log10x-reports/poc_from_siem-2026-04-20T14-15-57.806Z.md_