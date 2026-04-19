> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.

# Log10x POC Report — Amazon CloudWatch Logs

_24h window · scope=`/log10x/poc-test-otel` · snapshot_id=`17ad2cf7-d53a-4af8-bff6-c71efaa834c2`_

## 1. Executive Summary

Analyzed **4.0K events** (526.3 KB) from Amazon CloudWatch Logs across the last 24h.

- **Observed cost (window)**: $0.00
- **Projected weekly cost**: $0.00
- **Potential savings (window)**: $0.00 — 0.0% of analyzed cost
- **Analyzer rate**: $0.50/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Mute `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` → save $0.00
- Mute `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` → save $0.00
- Mute `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` → save $0.00

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | INFO | 464 | 12% | $0.00 | $0.00 |  |
| 2 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | opentelemetry-collector | INFO | 272 | 7% | $0.00 | $0.00 |  |
| 3 | `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | opentelemetry-collector | INFO | 228 | 6% | $0.00 | $0.00 |  |
| 4 | `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | opentelemetry-collector | INFO | 206 | 5% | $0.00 | $0.00 |  |
| 5 | `go_syncing_iptables_rules_ipfamily_ipv4` | kafka | INFO | 43 | 1% | $0.00 | $0.00 |  |
| 6 | `go_complete_ipfamily_ipv4_elapsed` | kafka | INFO | 42 | 1% | $0.00 | $0.00 |  |
| 7 | `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | opentelemetry-collector | INFO | 53 | 1% | $0.00 | $0.00 |  |
| 8 | `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | opentelemetry-collector | ERROR | 59 | 1% | $0.00 | $0.00 |  |
| 9 | `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | opentelemetry-collector | INFO | 55 | 1% | $0.00 | $0.00 |  |
| 10 | `go_reloading_service_iptables_data_ipfamily_ipv4` | kafka | INFO | 33 | 0.8% | $0.00 | $0.00 |  |
| 11 | `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | opentelemetry-collector | INFO | 42 | 1% | $0.00 | $0.00 |  |
| 12 | `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | opentelemetry-collector | INFO | 42 | 1% | $0.00 | $0.00 |  |
| 13 | `info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_message_format_vers` | kafka | INFO | 49 | 1% | $0.00 | $0.00 |  |
| 14 | `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | opentelemetry-collector | INFO | 43 | 1% | $0.00 | $0.00 |  |
| 15 | `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | opentelemetry-collector | INFO | 37 | 0.9% | $0.00 | $0.00 |  |
| 16 | `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | opentelemetry-collector | INFO | 42 | 1% | $0.00 | $0.00 |  |
| 17 | `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | opentelemetry-collector | INFO | 40 | 1% | $0.00 | $0.00 |  |
| 18 | `info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa` | kafka | INFO | 49 | 1% | $0.00 | $0.00 |  |
| 19 | `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | opentelemetry-collector | TRACE | 39 | 1.0% | $0.00 | $0.00 |  |
| 20 | `info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_offsets2_kafka_clus` | kafka | INFO | 49 | 1% | $0.00 | $0.00 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| opentelemetry-collector | 2.0K | $0.00 | INFO 87%, TRACE 5%, — 5% |
| kafka | 879 | $0.00 | INFO 94%, — 3%, WARN 1% |
| grafana | 713 | $0.00 | INFO 99%, WARN 0.4%, — 0.3% |
| kube-proxy | 191 | $0.00 | — 65%, INFO 33%, WARN 2% |
| jaeger | 74 | $0.00 | INFO 81%, — 19% |
| image-provider | 41 | $0.00 | INFO 73%, — 27% |
| opensearch | 28 | $0.00 | INFO 54%, TRACE 29%, — 18% |
| load-generator | 8 | $0.00 | — 88%, TRACE 13% |

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (12% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: drop
  untilEpochSec: 1779226623   # auto-expires in 30d
  reason: "High-volume INFO pattern (12% of analyzed volume) — candidate for mute after dependency check."
```

### #2 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (7% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779226623   # auto-expires in 30d
  reason: "High-volume INFO pattern (7% of analyzed volume) — candidate for mute after dependency check."
```

### #3 — `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (6% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp
  action: drop
  untilEpochSec: 1779226623   # auto-expires in 30d
  reason: "High-volume INFO pattern (6% of analyzed volume) — candidate for mute after dependency check."
```

### #4 — `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume INFO pattern (5% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c
  action: drop
  untilEpochSec: 1779226623   # auto-expires in 30d
  reason: "High-volume INFO pattern (5% of analyzed volume) — candidate for mute after dependency check."
```

### #5 — `go_syncing_iptables_rules_ipfamily_ipv4`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "go_syncing_iptables_rules_ipfamily_ipv4")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: go_syncing_iptables_rules_ipfamily_ipv4
  action: sample
    sampleRate: 20
  untilEpochSec: 1779226623   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #6 — `go_complete_ipfamily_ipv4_elapsed`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "go_complete_ipfamily_ipv4_elapsed")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: go_complete_ipfamily_ipv4_elapsed
  action: sample
    sampleRate: 20
  untilEpochSec: 1779226623   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
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
  untilEpochSec: 1779226623   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #8 — `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client`  _(medium confidence)_

- **Action**: keep
- **Reasoning**: severity=ERROR — keep for incident diagnosis.
- **Projected savings (window)**: $0.00
- **Dependency warning**: —

### #9 — `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co
  action: sample
    sampleRate: 20
  untilEpochSec: 1779226623   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #10 — `go_reloading_service_iptables_data_ipfamily_ipv4`  _(medium confidence)_

- **Action**: keep
- **Reasoning**: Low volume or non-actionable signal — keep.
- **Projected savings (window)**: $0.00
- **Dependency warning**: —

## 5. Native SIEM Exclusion Configs

Ready-to-paste configs for Amazon CloudWatch Logs and fluent-bit. Drop these into your pipeline **only** after running `log10x_dependency_check` on each pattern.

### Amazon CloudWatch Logs

```
# Subscription filter: drop pattern #1
aws logs put-subscription-filter \
  --log-group-name "/aws/your/logs" \
  --filter-name "log10x-drop-0" \
  --filter-pattern '-"traces" -"resource" -"service"' \
  --destination-arn "<your-kinesis-or-lambda-arn>"

# Subscription filter: drop pattern #2
aws logs put-subscription-filter \
  --log-group-name "/aws/your/logs" \
  --filter-name "log10x-drop-1" \
  --filter-pattern '-"logs" -"resource" -"service"' \
  --destination-arn "<your-kinesis-or-lambda-arn>"

# Subscription filter: drop pattern #3
aws logs put-subscription-filter \
  --log-group-name "/aws/your/logs" \
  --filter-name "log10x-drop-2" \
  --filter-pattern '-"logs" -"resource" -"service"' \
  --destination-arn "<your-kinesis-or-lambda-arn>"

# Subscription filter: drop pattern #4
aws logs put-subscription-filter \
  --log-group-name "/aws/your/logs" \
  --filter-name "log10x-drop-3" \
  --filter-pattern '-"metrics" -"resource" -"service"' \
  --destination-arn "<your-kinesis-or-lambda-arn>"
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

1. Paste the Amazon CloudWatch Logs config from Section 5 into your SIEM admin console
2. Monitor ingestion volume for 24-48h to confirm the drop
3. Trade-offs vs regulator: no auto-expiry, no per-pattern verification metric, no GitOps-reviewable identity (regex will drift)

## 9. Appendix

### Full pattern table

| identity | events | bytes | severity | service | sample |
|---|---|---|---|---|---|
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 464 | 59.5 KB | INFO | opentelemetry-collector | `I1001 20:11:26.099209 1 proxier.go:822] "SyncProxyRules complete" ipFamily="IPv…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 272 | 31.9 KB | INFO | opentelemetry-collector | `I1001 20:07:50.327566 1 proxier.go:828] "Syncing iptables rules" ipFamily="IPv4"` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 228 | 26.8 KB | INFO | opentelemetry-collector | `I1001 20:07:12.014609 1 proxier.go:1547] "Reloading service iptables data" ipFa…` |
| `metrics_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_c` | 206 | 25.4 KB | INFO | opentelemetry-collector | `I1001 20:07:11.945481 1 shared_informer.go:320] Caches are synced for node conf…` |
| `go_syncing_iptables_rules_ipfamily_ipv4` | 43 | 7.8 KB | INFO | kafka | `[2025-10-01 20:13:14,803] INFO [Partition __consumer_offsets-43 broker=1] Log l…` |
| `go_complete_ipfamily_ipv4_elapsed` | 42 | 7.6 KB | INFO | kafka | `[2025-10-01 20:13:14,812] INFO Created log for partition __consumer_offsets-10 …` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | 53 | 7.5 KB | INFO | opentelemetry-collector | ` sasl.oauthbearer.jwks.endpoint.refresh.ms = 3600000` |
| `failed_to_upload_metrics_post_https_otel_collector_v1_metrics_http_server_gave_http_response_to_https_client` | 59 | 7.3 KB | ERROR | opentelemetry-collector | `I1001 20:07:14.396193 1 proxier.go:822] "SyncProxyRules complete" ipFamily="IPv…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 55 | 6.1 KB | INFO | opentelemetry-collector | `I1001 20:11:26.090295 1 proxier.go:828] "Syncing iptables rules" ipFamily="IPv4"` |
| `go_reloading_service_iptables_data_ipfamily_ipv4` | 33 | 6.0 KB | INFO | kafka | `[2025-10-01 20:13:14,896] INFO [LogLoader partition=__consumer_offsets-6, dir=/…` |
| `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | 42 | 5.9 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:14,477] INFO [ReplicaFetcherManager on broker 1] Removed fetc…` |
| `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | 42 | 5.7 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:14,466] INFO [SnapshotGenerator id=1] Creating new KRaft snap…` |
| `info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_message_format_vers` | 49 | 5.5 KB | INFO | kafka | `[2025-10-01 20:13:04,601] INFO [RaftManager id=1] Completed transition to Leade…` |
| `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | 43 | 5.5 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:14,567] INFO [LogLoader partition=__consumer_offsets-9, dir=/…` |
| `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | 37 | 5.4 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:04,599] INFO [RaftManager id=1] Attempting durable transition…` |
| `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | 42 | 5.4 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:14,487] INFO [SnapshotEmitter id=1] Successfully wrote snapsh…` |
| `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | 40 | 5.2 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:04,591] INFO [RaftManager id=1] Attempting durable transition…` |
| `info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa` | 49 | 4.7 KB | INFO | kafka | `[2025-10-01 20:13:04,622] INFO [kafka-1-raft-outbound-request-thread]: Starting…` |
| `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | 39 | 4.7 KB | TRACE | opentelemetry-collector | ` ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^` |
| `info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_offsets2_kafka_clus` | 49 | 4.6 KB | INFO | kafka | `[2025-10-01 20:13:04,624] INFO [kafka-1-raft-io-thread]: Starting (org.apache.k…` |
| `info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_watermark_kafka_clus` | 49 | 4.5 KB | INFO | kafka | `[2025-10-01 20:13:04,706] INFO [MetadataLoader id=1] initializeNewPublishers: t…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | 34 | 4.3 KB | INFO | opentelemetry-collector | ` zookeeper.metadata.migration.min.batch.size = 200` |
| `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | 34 | 4.2 KB | INFO | opentelemetry-collector | ` zookeeper.set.acl = false` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | 34 | 3.9 KB | INFO | opentelemetry-collector | ` sasl.oauthbearer.jwks.endpoint.retry.backoff.max.ms = 10000` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 24 | 3.6 KB | TRACE | opentelemetry-collector | `I1001 20:07:14.804529 1 shared_informer.go:350] "Waiting for caches to sync" co…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offset_breach_logsegmen` | 24 | 3.4 KB | INFO | opentelemetry-collector | ` zookeeper.session.timeout.ms = 18000` |
| `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | 30 | 3.3 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:14,523] INFO [LogLoader partition=__consumer_offsets-13, dir=…` |
| `opensearchexporter_v0_logger_go_request_failed_resource_service_instance_id_service_name_otelcol_contrib_service_version` | 24 | 3.0 KB | — | kube-proxy | `I1001 20:07:11.946643 1 shared_informer.go:320] Caches are synced for endpoint …` |
| `info_0_filter_kube_metadata_stats_namespace_cache_size_pod_cache_size_pod_cache_api_updates_id_cache_miss_1` | 13 | 2.3 KB | INFO | opentelemetry-collector | `2025-10-01T20:11:25.785Z info internal/retry_sender.go:133 Exporting failed. Wi…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 22 | 2.3 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:14,397] INFO Sent auto-creation request for Set(__consumer_of…` |
| `info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_groupcoordinator` | 48 | 1.8 KB | INFO | kafka | ` log.cleaner.min.compaction.lag.ms = 0` |
| `info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_in_milliseconds_for` | 40 | 1.8 KB | INFO | kafka | ` remote.log.manager.copier.thread.pool.size = -1` |
| `info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offsets_for_epoch_kafk` | 49 | 1.6 KB | INFO | kafka | ` log.cleaner.threads = 1` |
| `internal_retry_sender_go_exporting_failed_will_retry_the_request_after_interval_resource_service_instance_id_service_nam` | 13 | 1.5 KB | — | kube-proxy | `I1001 20:07:11.945539 1 proxier.go:805] "Not syncing iptables until Services an…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segment_files_logsegment_baseoffset_size_lastmodifi` | 9 | 1.5 KB | INFO | opentelemetry-collector | `[2025-10-01 20:13:14,630] INFO [LogLoader partition=__consumer_offsets-34, dir=…` |
| `oteldemo_adservice_targeted_ad_request_received_for_assembly_trace_id_span_id_trace_flags` | 10 | 1.4 KB | TRACE | opentelemetry-collector | `AssertionError: ` |
| `internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsupported_protocol_scheme_ship` | 13 | 1.4 KB | — | opentelemetry-collector | `[2025-10-01T20:12:32,403][INFO ][o.o.p.PluginsService ] [opensearch-0] loaded m…` |
| `go_reloading_service_iptables_data_ipfamily_ipv4_4` | 7 | 1.3 KB | INFO | kafka | `[2025-10-01 20:13:14,811] INFO [LogLoader partition=__consumer_offsets-10, dir=…` |
| `batchprocessor_v0_batch_processor_go_sender_failed_resource_service_instance_id_service_name_otelcol_contrib_service_ver` | 10 | 1.3 KB | — | kube-proxy | `I1001 20:07:50.330578 1 proxier.go:1547] "Reloading service iptables data" ipFa…` |
| `main_recommendation_server_py_trace_id_span_id_resource_service_name_recommendation_trace_sampled_true_receive_listrecom` | 8 | 1.3 KB | TRACE | opentelemetry-collector | `2025-10-01T20:11:22.552Z error scraperhelper@v0.135.0/obs_metrics.go:61 Error s…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 2 | 1.3 KB | — | opentelemetry-collector | `2025-10-01T20:11:21.545Z info healthcheckextension@v0.135.0/healthcheckextensio…` |
| `logs_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_comp` | 10 | 1.2 KB | — | opentelemetry-collector | `[2025-10-01T20:12:27,735][INFO ][o.o.n.Node ] [opensearch-0] version[3.2.0], pi…` |
| `traces_resource_service_instance_id_service_name_otelcol_contrib_service_version_2_otelcol_component_id_debug_otelcol_co` | 6 | 1.2 KB | — | opentelemetry-collector | `[2025-10-01T20:13:04,959][INFO ][o.o.c.m.MetadataMappingService] [opensearch-0]…` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_ms_org_apach` | 10 | 1.1 KB | INFO | opentelemetry-collector | ` unclean.leader.election.enable = false` |
| `batchprocessor_v0_batch_processor_go_sender_failed_resource_service_instance_id_service_name_otelcol_contrib_service_ver` | 8 | 1.1 KB | — | kube-proxy | `I1001 20:07:12.046263 1 proxier.go:822] "SyncProxyRules complete" ipFamily="IPv…` |
| `info_o_o_p_pluginsservice_opensearch_onindexmodule_index_opensearch_sap_log_types_config` | 6 | 1.0 KB | INFO | kafka | `[2025-10-01 20:17:04,182] INFO [UnifiedLog partition=__cluster_metadata-0, dir=…` |
| `traceback_most_recent_call_last_file_usr_local_lib_python3_site_packages_gevent_threading_py_line_in_after_fork_in_child` | 4 | 1.0 KB | — | kafka | `[2025-10-01 20:13:14,972] INFO [GroupMetadataManager brokerId=1] Finished loadi…` |
| `internal_base_exporter_go_exporting_failed_rejecting_data_try_enabling_sending_queue_to_survive_temporary_failures_resou` | 9 | 1.0 KB | — | kube-proxy | `I1001 20:07:40.325910 1 proxier.go:822] "SyncProxyRules complete" ipFamily="IPv…` |
| `internal_retry_sender_go_exporting_failed_will_retry_the_request_after_interval_resource_service_instance_id_service_nam` | 8 | 948 B | — | kube-proxy | `I1001 20:11:26.094690 1 proxier.go:1547] "Reloading service iptables data" ipFa…` |
| `grpc_v1_clientconn_go_core_channel_1_subchannel_2_grpc_addrconn_createtransport_failed_to_connect_to_addr_jaeger_collect` | 7 | 948 B | — | kube-proxy | `I1001 20:07:11.845647 1 shared_informer.go:313] Waiting for caches to sync for …` |

_1312 additional patterns omitted from the table (see JSON summary)._

### SIEM query used

```
/log10x/poc-test-otel
```

### Methodology

- **Pattern identity** is the Log10x `templateHash` — a stable field-set fingerprint computed from the token structure of the event. Identity stays constant across deploys, restarts, pod names, timestamps, and request IDs.
- **Cost model**: `bytes × analyzer_cost_per_gb` over the pulled window. Window cost is projected to weekly cost via `$/window × (168h / window_hours)`.
- **Recommendation rules**: mute when pattern is DEBUG/INFO or below a minimum-value bar AND ≥1% of total volume; sample when MAX 10/s; keep when ERROR or WARN.
- **Confidence** is `high` for patterns with ≥100 events in the window (stable rate), `medium` for 10-99, `low` for <10.

### Run metadata

- **snapshot_id**: `17ad2cf7-d53a-4af8-bff6-c71efaa834c2`
- **started**: 2026-04-19T21:36:44.200Z
- **finished**: 2026-04-19T21:37:03.939Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 10781 (templater 8956ms)
- **events_analyzed**: 4.0K / target 30K (source_exhausted)
- **bytes_analyzed**: 526.3 KB
- **execution_mode**: local_cli


_Report saved to: /tmp/log10x-reports/poc_from_siem-2026-04-19T21-37-03.982Z.md_