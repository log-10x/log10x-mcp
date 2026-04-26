> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.

# Log10x POC Report — Splunk

_24h window · scope=`main` · snapshot_id=`2428899f-cba2-4e09-87c5-ade2b555e25e`_

## 1. Executive Summary

Analyzed **3.5K events** (668.2 KB) from Splunk across the last 24h.

- **Observed cost (window)**: $0.00
- **Projected weekly cost**: $0.03
- **Potential savings (window)**: $0.00 — 0.3% of analyzed cost
- **Analyzer rate**: $6.00/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Mute `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` → save $0.00
- Mute `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` → save $0.00
- Mute `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` → save $0.00

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | DEBUG | 802 | 23% | $0.00 | $0.01 |  |
| 2 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | opentelemetry-collector | DEBUG | 493 | 14% | $0.00 | $0.00 |  |
| 3 | `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | opentelemetry-collector | DEBUG | 328 | 9% | $0.00 | $0.00 |  |
| 4 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | opentelemetry-collector | DEBUG | 337 | 10% | $0.00 | $0.00 |  |
| 5 | `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | opentelemetry-collector | ERROR | 78 | 2% | $0.00 | $0.00 |  |
| 6 | `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | opentelemetry-collector | TRACE | 88 | 3% | $0.00 | $0.00 |  |
| 7 | `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | opentelemetry-collector | INFO | 63 | 2% | $0.00 | $0.00 |  |
| 8 | `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | opentelemetry-collector | INFO | 62 | 2% | $0.00 | $0.00 |  |
| 9 | `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | opentelemetry-collector | INFO | 59 | 2% | $0.00 | $0.00 |  |
| 10 | `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | opentelemetry-collector | INFO | 62 | 2% | $0.00 | $0.00 |  |
| 11 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | DEBUG | 59 | 2% | $0.00 | $0.00 |  |
| 12 | `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | opentelemetry-collector | INFO | 57 | 2% | $0.00 | $0.00 |  |
| 13 | `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | opentelemetry-collector | INFO | 50 | 1% | $0.00 | $0.00 |  |
| 14 | `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | opentelemetry-collector | INFO | 59 | 2% | $0.00 | $0.00 |  |
| 15 | `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | opentelemetry-collector | CRITICAL | 58 | 2% | $0.00 | $0.00 |  |
| 16 | `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | opentelemetry-collector | INFO | 46 | 1% | $0.00 | $0.00 |  |
| 17 | `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | opentelemetry-collector | INFO | 49 | 1% | $0.00 | $0.00 |  |
| 18 | `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | opentelemetry-collector | INFO | 35 | 1% | $0.00 | $0.00 |  |
| 19 | `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | opentelemetry-collector | TRACE | 34 | 1.0% | $0.00 | $0.00 |  |
| 20 | `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | opentelemetry-collector | INFO | 45 | 1% | $0.00 | $0.00 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| opentelemetry-collector | 3.3K | $0.00 | DEBUG 62%, INFO 23%, TRACE 6% |
| cart | 97 | $0.00 | — 59%, TRACE 34%, INFO 5% |
| kafka | 61 | $0.00 | — 57%, TRACE 25%, INFO 18% |
| frontend | 18 | $0.00 | — 56%, INFO 44% |
| ad | 3 | $0.00 | — 100% |

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (23% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779219686   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (23% of analyzed volume) — candidate for mute after dependency check."
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
  untilEpochSec: 1779219686   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (14% of analyzed volume) — candidate for mute after dependency check."
```

### #3 — `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (9% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c
  action: drop
  untilEpochSec: 1779219686   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (9% of analyzed volume) — candidate for mute after dependency check."
```

### #4 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume DEBUG pattern (10% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779219686   # auto-expires in 30d
  reason: "High-volume DEBUG pattern (10% of analyzed volume) — candidate for mute after dependency check."
```

### #5 — `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client`  _(medium confidence)_

- **Action**: keep
- **Reasoning**: severity=ERROR — keep for incident diagnosis.
- **Projected savings (window)**: $0.00
- **Dependency warning**: —

### #6 — `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags`  _(medium confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume TRACE pattern (3% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags
  action: drop
  untilEpochSec: 1779219686   # auto-expires in 30d
  reason: "High-volume TRACE pattern (3% of analyzed volume) — candidate for mute after dependency check."
```

### #7 — `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog
  action: sample
    sampleRate: 20
  untilEpochSec: 1779219686   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #8 — `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen
  action: sample
    sampleRate: 20
  untilEpochSec: 1779219686   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #9 — `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa
  action: sample
    sampleRate: 20
  untilEpochSec: 1779219686   # auto-expires in 30d
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
  untilEpochSec: 1779219686   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

## 5. Native SIEM Exclusion Configs

Ready-to-paste configs for Splunk and fluent-bit. Drop these into your pipeline **only** after running `log10x_dependency_check` on each pattern.

### Splunk

```
# props.conf
[your_sourcetype]
TRANSFORMS-log10x_drop = log10x_drop_0, log10x_drop_1, log10x_drop_2, log10x_drop_3, log10x_drop_4

# transforms.conf
[log10x_drop_0]
REGEX = traces.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*co
DEST_KEY = queue
FORMAT = nullQueue

[log10x_drop_1]
REGEX = logs.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*comp
DEST_KEY = queue
FORMAT = nullQueue

[log10x_drop_2]
REGEX = metrics.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*c
DEST_KEY = queue
FORMAT = nullQueue

[log10x_drop_3]
REGEX = logs.*resource.*service.*instance.*id.*service.*name.*otelcol.*contrib.*service.*version.*2.*otelcol.*component.*id.*debug.*otelcol.*comp
DEST_KEY = queue
FORMAT = nullQueue

[log10x_drop_4]
REGEX = oteldemo.*adservice.*no.*baggage.*found.*in.*context.*trace.*id.*span.*id.*trace.*flags
DEST_KEY = queue
FORMAT = nullQueue
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

## 6. Compaction Potential

The Log10x optimizer **losslessly compacts** events by storing structure once and shipping only variable values. For Splunk, the compaction ratio typically runs 5-10× on structured JSON logs, 2-3× on semi-structured.

| pattern | current bytes/window | est. compact bytes | est. savings | before sample | after (compact) |
|---|---|---|---|---|---|
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 150.4 KB | 30.4 KB (5.0×) | $0.00 | `info: cart.cartstore.ValkeyCartStore[0]` | `~$(yyyy-MM-dd'T'HH:mm:ss.SSS'Z') info Traces {"resource": {"…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 94.2 KB | 19.1 KB (4.9×) | $0.00 | `info: cart.cartstore.ValkeyCartStore[0]` | `~$(yyyy-MM-dd'T'HH:mm:ss.SSS'Z') info Logs {"resource": {"se…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 65.5 KB | 13.4 KB (4.9×) | $0.00 | ` GetCartAsync called with userId=daedf8c4-9f1a-11f0-9b9e-a6…` | `~$(yyyy-MM-dd'T'HH:mm:ss.SSS'Z') info Metrics {"resource": {…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 63.4 KB | 13.0 KB (4.9×) | $0.00 | ` GetCartAsync called with userId=daedf8c4-9f1a-11f0-9b9e-a6…` | `~$(yyyy-MM-dd'T'HH:mm:ss.SSS'Z') info Logs {"resource": {"se…` |
| `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | 16.7 KB | 3.5 KB (4.8×) | $0.00 | ` AddItemAsync called with userId=daedf8c4-9f1a-11f0-9b9e-a6…` | `~$(yyyy/MM/dd HH:mm:ss) failed to upload metrics: Post "http…` |
| `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | 16.5 KB | 3.4 KB (4.8×) | $0.00 | `2025-10-01T23:03:30.727Z info Logs {"resource": {"service.i…` | `~$(yyyy-MM-dd HH:mm:ss) - oteldemo.AdService - no baggage fo…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | 12.9 KB | 2.7 KB (4.7×) | $0.00 | `2025-10-01T23:03:32.570Z info Logs {"resource": {"service.i…` | `~[$(yyyy-MM-dd HH:mm:ss,SSS)] INFO [LocalLog partition=__clu…` |
| `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | 12.5 KB | 2.7 KB (4.7×) | $0.00 | `2025-10-01 23:03:18 - oteldemo.AdService - Non-targeted ad …` | `~[$(yyyy-MM-dd HH:mm:ss,SSS)] INFO Deleted offset index //tm…` |

Install: see https://docs.log10x.com/apps/cloud/optimizer/ — the optimizer runs as a forwarder sidecar. Compaction is transparent to downstream queries.

## 7. Risk / Dependency Check

_All top drop candidates are high-volume, non-error patterns. Standard dependency check recommended but risk is low._

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
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 802 | 150.4 KB | DEBUG | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 493 | 94.2 KB | DEBUG | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 328 | 65.5 KB | DEBUG | opentelemetry-collector | ` GetCartAsync called with userId=daedf8c4-9f1a-11f0-9b9e-a666c4b68b87` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 337 | 63.4 KB | DEBUG | opentelemetry-collector | ` GetCartAsync called with userId=daedf8c4-9f1a-11f0-9b9e-a666c4b68b87` |
| `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | 78 | 16.7 KB | ERROR | opentelemetry-collector | ` AddItemAsync called with userId=daedf8c4-9f1a-11f0-9b9e-a666c4b68b87, productI…` |
| `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | 88 | 16.5 KB | TRACE | opentelemetry-collector | `2025-10-01T23:03:30.727Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | 63 | 12.9 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:32.570Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | 62 | 12.5 KB | INFO | opentelemetry-collector | `2025-10-01 23:03:18 - oteldemo.AdService - Non-targeted ad request received, pr…` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | 59 | 12.0 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:32.592Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | 62 | 11.7 KB | INFO | opentelemetry-collector | `2025-10-01 23:03:18 - oteldemo.AdService - no baggage found in context trace_id…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 59 | 11.5 KB | DEBUG | opentelemetry-collector | `2025-10-01 23:03:24 - oteldemo.AdService - no baggage found in context trace_id…` |
| `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | 57 | 11.3 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:18.575Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | 50 | 11.3 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:19.368Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | 59 | 11.2 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:18.565Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 58 | 10.6 KB | CRITICAL | opentelemetry-collector | `Error: 13 INTERNAL: shipping quote failure: failed POST to shipping service: Po…` |
| `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | 46 | 9.1 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:18.782Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | 49 | 8.8 KB | INFO | opentelemetry-collector | ` GetCartAsync called with userId=d8f39aa6-9f1a-11f0-9b9e-a666c4b68b87` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 35 | 7.8 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:19.132Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 34 | 7.7 KB | TRACE | opentelemetry-collector | `2025-10-01T23:03:31.958Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | 45 | 7.6 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 32 | 6.4 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:17.955Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | 26 | 6.0 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:11.932Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_0_filter_kube_metadata_stats_namespace_cache_size_pod_cache_size_pod_cache_api_updates_id_cache_miss_1` | 31 | 5.7 KB | INFO | opentelemetry-collector | ` GetCartAsync called with userId=d8f39aa6-9f1a-11f0-9b9e-a666c4b68b87` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | 24 | 4.8 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:17.925Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `oteldemo_adservice_targeted_ad_request_received_for_books_trace_id_span_id_trace_flags` | 21 | 4.3 KB | TRACE | opentelemetry-collector | `2025-10-01T23:03:31.011Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 19 | 3.9 KB | — | opentelemetry-collector | `2025-10-01T23:03:21.375Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 21 | 3.9 KB | — | opentelemetry-collector | `2025-10-01T23:01:46.353Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `oteldemo_adservice_targeted_ad_request_received_for_assembly_trace_id_span_id_trace_flags` | 19 | 3.8 KB | TRACE | opentelemetry-collector | `2025-10-01T23:02:08.247Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `logger_sender_router_rule_uid_org_id_t_level_info_msg_sending_alerts_to_local_notifier_count1` | 14 | 3.6 KB | INFO | opentelemetry-collector | `2025-10-01T23:02:30.489Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 13 | 2.9 KB | INFO | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 14 | 2.8 KB | — | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 18 | 2.7 KB | — | cart | ` AddItemAsync called with userId=c5f8005e-9f1a-11f0-9b9e-a666c4b68b87, productI…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 15 | 2.6 KB | TRACE | kafka | `2025-10-01T23:02:57.661Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 15 | 2.5 KB | INFO | opentelemetry-collector | `2025-10-01T23:03:12.892Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 8 | 2.5 KB | TRACE | opentelemetry-collector | `2025-10-01T23:03:21.141Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 13 | 2.3 KB | DEBUG | opentelemetry-collector | `[2025-10-01 23:03:04,299] INFO Deleted offset index /tmp/kafka-logs/__cluster_m…` |
| `oteldemo_adservice_targeted_ad_request_received_for_trace_id_span_id_trace_flags` | 14 | 2.2 KB | TRACE | cart | ` AddItemAsync called with userId=cdc77ad0-9f1a-11f0-9b9e-a666c4b68b87, productI…` |
| `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client_getcartasyn` | 8 | 2.0 KB | ERROR | opentelemetry-collector | `2025-10-01T23:02:31.355Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | 7 | 1.9 KB | INFO | kafka | `2025-10-01T22:58:46.172Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `oteldemo_adservice_targeted_ad_request_received_for_binoculars_trace_id_span_id_trace_flags` | 15 | 1.8 KB | TRACE | cart | `info: cart.cartstore.ValkeyCartStore[0]` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 8 | 1.7 KB | — | cart | `info: cart.cartstore.ValkeyCartStore[0]` |
| `oteldemo_adservice_targeted_ad_request_received_for_travel_trace_id_span_id_trace_flags` | 9 | 1.6 KB | TRACE | opentelemetry-collector | ` GetCartAsync called with userId=` |
| `oteldemo_adservice_non_targeted_ad_request_received_preparing_random_response_trace_id_span_id_trace_flags` | 10 | 1.6 KB | TRACE | opentelemetry-collector | ` at <unknown> (.next/server/pages/api/checkout.js:1:4375)` |
| `oteldemo_adservice_targeted_ad_request_received_for_accessories_trace_id_span_id_trace_flags` | 7 | 1.5 KB | TRACE | opentelemetry-collector | ` AddItemAsync called with userId=8b9e5872-9f1a-11f0-9b9e-a666c4b68b87, productI…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 6 | 1.5 KB | — | opentelemetry-collector | `2025-10-01T23:02:51.811Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags_metadata_metadata_details_shipping_quote_fai` | 5 | 1.3 KB | — | opentelemetry-collector | `2025-10-01T22:57:42.721Z info Metrics {"resource": {"service.instance.id": "16a…` |
| `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | 5 | 1.3 KB | INFO | opentelemetry-collector | `2025-10-01T22:57:30.857Z info Traces {"resource": {"service.instance.id": "16a4…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 6 | 1.3 KB | — | opentelemetry-collector | `info: cart.cartstore.ValkeyCartStore[0]` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 6 | 1.2 KB | TRACE | opentelemetry-collector | `2025-10-01T23:03:28.887Z info Logs {"resource": {"service.instance.id": "16a4f8…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 7 | 1.2 KB | TRACE | opentelemetry-collector | ` code: 13,` |

_107 additional patterns omitted from the table (see JSON summary)._

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

- **snapshot_id**: `2428899f-cba2-4e09-87c5-ade2b555e25e`
- **started**: 2026-04-19T19:40:01.499Z
- **finished**: 2026-04-19T19:41:26.345Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 2606 (templater 82237ms)
- **events_analyzed**: 3.5K / target 5.0K (target_reached)
- **bytes_analyzed**: 668.2 KB
- **execution_mode**: paste_lambda


_Report saved to: /tmp/log10x-reports/poc_from_siem-2026-04-19T19-41-26.361Z.md_