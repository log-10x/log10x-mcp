> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.

# Log10x POC Report — Elasticsearch

_24h window · scope=`otel-logs` · snapshot_id=`1fdb3a0b-e8fb-42ba-903d-ae4563631403`_

## 1. Executive Summary

Analyzed **3.3K events** (378.3 KB) from Elasticsearch across the last 24h.

- **Observed cost (window)**: $0.00
- **Projected weekly cost**: $0.00
- **Potential savings (window)**: $0.00 — 0.0% of analyzed cost
- **Analyzer rate**: $1.00/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Sample `info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_watermark_kafka_clus` at 1/20 → save $0.00
- Sample `go_syncing_iptables_rules_ipfamily_ipv4` at 1/20 → save $0.00
- Sample `info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa` at 1/20 → save $0.00

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | `info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_watermark_kafka_clus` | grafana | INFO | 49 | 2% | $0.00 | $0.00 |  |
| 2 | `go_syncing_iptables_rules_ipfamily_ipv4` | kafka | INFO | 43 | 1% | $0.00 | $0.00 |  |
| 3 | `info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa` | grafana | INFO | 49 | 2% | $0.00 | $0.00 |  |
| 4 | `info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offsets_for_epoch_kafk` | grafana | INFO | 49 | 2% | $0.00 | $0.00 |  |
| 5 | `go_complete_ipfamily_ipv4_elapsed` | kafka | INFO | 42 | 1% | $0.00 | $0.00 |  |
| 6 | `info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_groupcoordinator` | grafana | INFO | 48 | 1% | $0.00 | $0.00 |  |
| 7 | `info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_offsets2_kafka_clus` | grafana | INFO | 49 | 2% | $0.00 | $0.00 |  |
| 8 | `info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_message_format_vers` | grafana | INFO | 49 | 2% | $0.00 | $0.00 |  |
| 9 | `info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_in_milliseconds_for` | grafana | INFO | 40 | 1% | $0.00 | $0.00 |  |
| 10 | `go_reloading_service_iptables_data_ipfamily_ipv4` | kafka | INFO | 33 | 1% | $0.00 | $0.00 |  |
| 11 | `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | ad | TRACE | 29 | 0.9% | $0.00 | $0.00 |  |
| 12 | `internal_retry_sender_go_exporting_failed_will_retry_the_request_after_interval_resource_service_instance_id_service_nam` | kafka | — | 13 | 0.4% | $0.00 | $0.00 |  |
| 13 | `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | grafana | INFO | 13 | 0.4% | $0.00 | $0.00 |  |
| 14 | `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | grafana | INFO | 13 | 0.4% | $0.00 | $0.00 |  |
| 15 | `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | grafana | INFO | 17 | 0.5% | $0.00 | $0.00 |  |
| 16 | `logger_migrator_t_level_info_msg_executing_migration_id_add_unique_index_alert_rule_tag_alert_id_tag_id` | frontend-proxy | INFO | 1 | 0.0% | $0.00 | $0.00 | new? |
| 17 | `logger_migrator_t_level_info_msg_executing_migration_id_add_dashboard_uid_column_to_annotation_table` | grafana | INFO | 1 | 0.0% | $0.00 | $0.00 | new? |
| 18 | `logger_migrator_t_level_info_msg_executing_migration_id_add_user_unique_id_to_user_auth` | grafana | INFO | 1 | 0.0% | $0.00 | $0.00 | new? |
| 19 | `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | grafana | INFO | 13 | 0.4% | $0.00 | $0.00 |  |
| 20 | `info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_in_milliseconds_for` | grafana | INFO | 9 | 0.3% | $0.00 | $0.00 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| grafana | 1.6K | $0.00 | INFO 97%, — 2%, WARN 0.2% |
| kafka | 511 | $0.00 | INFO 76%, — 20%, WARN 3% |
| frontend-proxy | 120 | $0.00 | INFO 100% |
| cart | 322 | $0.00 | INFO 79%, — 16%, ERROR 3% |
| jaeger | 69 | $0.00 | INFO 97%, — 1%, ERROR 1% |
| ad | 67 | $0.00 | TRACE 88%, INFO 7%, — 3% |
| frontend | 111 | $0.00 | INFO 100% |
| image-provider | 36 | $0.00 | INFO 100% |
| flagd | 129 | $0.00 | INFO 100% |
| accounting | 129 | $0.00 | — 98%, ERROR 2%, INFO 0.8% |
| coredns | 49 | $0.00 | INFO 100% |
| fraud-detection | 59 | $0.00 | INFO 100% |
| aws-node | 14 | $0.00 | INFO 71%, — 29% |
| email | 13 | $0.00 | INFO 100% |
| checkout | 44 | $0.00 | INFO 100% |

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — `info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_watermark_kafka_clus`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_watermark_kafka_clus")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_watermark_kafka_clus
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #2 — `go_syncing_iptables_rules_ipfamily_ipv4`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "go_syncing_iptables_rules_ipfamily_ipv4")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: go_syncing_iptables_rules_ipfamily_ipv4
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #3 — `info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #4 — `info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offsets_for_epoch_kafk`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offsets_for_epoch_kafk")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offsets_for_epoch_kafk
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #5 — `go_complete_ipfamily_ipv4_elapsed`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "go_complete_ipfamily_ipv4_elapsed")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: go_complete_ipfamily_ipv4_elapsed
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #6 — `info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_groupcoordinator`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_groupcoordinator")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_groupcoordinator
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #7 — `info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_offsets2_kafka_clus`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_offsets2_kafka_clus")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_offsets2_kafka_clus
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #8 — `info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_message_format_vers`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_message_format_vers")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_message_format_vers
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #9 — `info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_in_milliseconds_for`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_in_milliseconds_for")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_in_milliseconds_for
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

### #10 — `go_reloading_service_iptables_data_ipfamily_ipv4`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "go_reloading_service_iptables_data_ipfamily_ipv4")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: go_reloading_service_iptables_data_ipfamily_ipv4
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218657   # auto-expires in 30d
  reason: "Moderate-volume INFO pattern — sample 1/20 to retain a trickle for debug."
```

## 5. Native SIEM Exclusion Configs

Ready-to-paste configs for Elasticsearch and fluent-bit. Drop these into your pipeline **only** after running `log10x_dependency_check` on each pattern.

_No high-confidence drop candidates in this window._

## 6. Compaction Potential

The Log10x optimizer **losslessly compacts** events by storing structure once and shipping only variable values. For Elasticsearch, the compaction ratio typically runs 5-10× on structured JSON logs, 2-3× on semi-structured.

| pattern | current bytes/window | est. compact bytes | est. savings | before sample | after (compact) |
|---|---|---|---|---|---|
| `info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_watermark_kafka_clus` | 7.8 KB | 1.7 KB (4.5×) | $0.00 | `logger=migrator t=2025-10-01T20:12:28.344152415Z level=info…` | `~[$(yyyy-MM-dd HH:mm:ss,SSS)] INFO [Partition __consumer_off…` |
| `go_syncing_iptables_rules_ipfamily_ipv4` | 7.7 KB | 1.6 KB (4.7×) | $0.00 | `{"level":"info","ts":1759349505.878872,"caller":"grpc@v1.60…` | `~$('I'MMdd HH:mm:ss.SSSSSS) $ $.go:$] "Syncing iptables rule…` |
| `info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa` | 7.7 KB | 1.8 KB (4.4×) | $0.00 | `logger=migrator t=2025-10-01T20:12:28.33952891Z level=info …` | `~[$(yyyy-MM-dd HH:mm:ss,SSS)] INFO Created log for partition…` |
| `info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offsets_for_epoch_kafk` | 7.6 KB | 1.7 KB (4.4×) | $0.00 | `logger=migrator t=2025-10-01T20:12:30.120838787Z level=info…` | `~[$(yyyy-MM-dd HH:mm:ss,SSS)] INFO [GroupMetadataManager bro…` |
| `go_complete_ipfamily_ipv4_elapsed` | 7.2 KB | 1.5 KB (4.7×) | $0.00 | `{"level":"info","ts":1759349505.8790379,"caller":"grpc/buil…` | `~$('I'MMdd HH:mm:ss.SSSSSS) $ $.go:$] "$ complete" ipFamily=…` |
| `info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_groupcoordinator` | 6.4 KB | 1.4 KB (4.5×) | $0.00 | `logger=migrator t=2025-10-01T20:12:30.12069447Z level=info …` | `~[$(yyyy-MM-dd HH:mm:ss,SSS)] INFO [GroupCoordinator $]: Ele…` |
| `info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_offsets2_kafka_clus` | 6.3 KB | 1.4 KB (4.4×) | $0.00 | `logger=migrator t=2025-10-01T20:12:28.343977635Z level=info…` | `~[$(yyyy-MM-dd HH:mm:ss,SSS)] INFO [Partition __consumer_off…` |
| `info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_message_format_vers` | 6.2 KB | 1.4 KB (4.3×) | $0.00 | `logger=migrator t=2025-10-01T20:12:28.338477119Z level=info…` | `~[$(yyyy-MM-dd HH:mm:ss,SSS)] INFO [LogLoader partition=__co…` |

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

1. Paste the Elasticsearch config from Section 5 into your SIEM admin console
2. Monitor ingestion volume for 24-48h to confirm the drop
3. Trade-offs vs regulator: no auto-expiry, no per-pattern verification metric, no GitOps-reviewable identity (regex will drift)

## 9. Appendix

### Full pattern table

| identity | events | bytes | severity | service | sample |
|---|---|---|---|---|---|
| `info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_watermark_kafka_clus` | 49 | 7.8 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:28.344152415Z level=info msg="Migration succ…` |
| `go_syncing_iptables_rules_ipfamily_ipv4` | 43 | 7.7 KB | INFO | kafka | `{"level":"info","ts":1759349505.878872,"caller":"grpc@v1.60.0/clientconn.go:122…` |
| `info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cleanup_policy_compa` | 49 | 7.7 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:28.33952891Z level=info msg="Migration succe…` |
| `info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offsets_for_epoch_kafk` | 49 | 7.6 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:30.120838787Z level=info msg="Migration succ…` |
| `go_complete_ipfamily_ipv4_elapsed` | 42 | 7.2 KB | INFO | kafka | `{"level":"info","ts":1759349505.8790379,"caller":"grpc/builder.go:115","msg":"C…` |
| `info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_groupcoordinator` | 48 | 6.4 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:30.12069447Z level=info msg="Executing migra…` |
| `info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_offsets2_kafka_clus` | 49 | 6.3 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:28.343977635Z level=info msg="Executing migr…` |
| `info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_message_format_vers` | 49 | 6.2 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:28.338477119Z level=info msg="Executing migr…` |
| `info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_in_milliseconds_for` | 40 | 6.1 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:30.843561136Z level=info msg="Migration succ…` |
| `go_reloading_service_iptables_data_ipfamily_ipv4` | 33 | 5.9 KB | INFO | kafka | `[2025-10-01 20:13:01,945] INFO Registered kafka:type=kafka.Log4jController MBea…` |
| `oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags` | 29 | 4.7 KB | TRACE | ad | `SLF4J(W): Defaulting to no-operation (NOP) logger implementation` |
| `internal_retry_sender_go_exporting_failed_will_retry_the_request_after_interval_resource_service_instance_id_service_nam` | 13 | 2.6 KB | — | kafka | ` zookeeper.connect = null` |
| `info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_ids_in_1_ms_org_apa` | 13 | 2.6 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:31.31388322Z level=info msg="Executing migra…` |
| `info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter` | 13 | 2.5 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:28.334129144Z level=info msg="Migration succ…` |
| `info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kafka_log_locallog` | 17 | 2.3 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:31.307627616Z level=info msg="Migration succ…` |
| `logger_migrator_t_level_info_msg_executing_migration_id_add_unique_index_alert_rule_tag_alert_id_tag_id` | 1 | 2.3 KB | INFO | frontend-proxy | `[2025-10-01 20:11:45.935][8][info][main] [source/server/server.cc:440] envoy.fi…` |
| `logger_migrator_t_level_info_msg_executing_migration_id_add_dashboard_uid_column_to_annotation_table` | 1 | 1.9 KB | INFO | grafana | `logger=featuremgmt t=2025-10-01T20:12:41.024373277Z level=info msg=FeatureToggl…` |
| `logger_migrator_t_level_info_msg_executing_migration_id_add_user_unique_id_to_user_auth` | 1 | 1.9 KB | INFO | grafana | `logger=featuremgmt t=2025-10-01T20:12:19.475211233Z level=info msg=FeatureToggl…` |
| `info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_bytes_org_apache_k` | 13 | 1.7 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:28.32954509Z level=info msg="Migration succe…` |
| `info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_in_milliseconds_for` | 9 | 1.3 KB | INFO | grafana | `logger=migrator t=2025-10-01T20:12:30.843409332Z level=info msg="Executing migr…` |
| `logger_migrator_t_level_info_msg_migration_successfully_executed_id_drop_index_annotation_tag_annotation_id_tag_id_v2_du` | 1 | 1.3 KB | INFO | frontend-proxy | `[2025-10-01 20:11:45.951][8][info][main] [source/server/server.cc:503] request …` |
| `info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_timestamp_is_now_older_` | 9 | 1.3 KB | INFO | grafana | `logger=resource-migrator t=2025-10-01T20:12:32.155014512Z level=info msg="Migra…` |
| `info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_snapshot_generated_` | 9 | 1.2 KB | INFO | grafana | `logger=resource-migrator t=2025-10-01T20:12:32.148804384Z level=info msg="Migra…` |
| `go_reloading_service_iptables_data_ipfamily_ipv4_4` | 7 | 1.1 KB | INFO | jaeger | `{"level":"info","ts":1759349505.87888,"caller":"grpc@v1.60.0/clientconn.go:1338…` |
| `info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_internals_log_logsegmen` | 8 | 1.1 KB | INFO | grafana | `logger=infra.usagestats.collector t=2025-10-01T20:12:34.517019386Z level=info m…` |
| `info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_internals_log_logsegm` | 8 | 1.0 KB | INFO | grafana | `logger=http.server t=2025-10-01T20:12:34.520709506Z level=info msg="HTTP Server…` |
| `info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_logsegment` | 8 | 1.0 KB | INFO | grafana | `logger=plugin.backgroundinstaller t=2025-10-01T20:12:34.514975679Z level=info m…` |
| `info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka_storage_internals` | 7 | 958 B | INFO | grafana | `logger=plugins.update.checker t=2025-10-01T20:12:34.738670347Z level=info msg="…` |
| `logger_migrator_t_level_info_msg_migration_successfully_executed_id_remove_unique_index_org_id_name_duration` | 1 | 947 B | INFO | frontend-proxy | `[2025-10-01 20:11:45.936][8][info][main] [source/server/server.cc:440] envoy.fi…` |
| `flags_go_flag_cleanup_false` | 1 | 929 B | INFO | image-provider | `{"stream":"stdout","log":"","docker":{"container_id":"df60e2438578bd8ad312b92b9…` |
| `flags_go_flag_conntrack_udp_timeout` | 1 | 929 B | INFO | image-provider | `{"stream":"stdout","log":"","docker":{"container_id":"df60e2438578bd8ad312b92b9…` |
| `flags_go_flag_conntrack_udp_timeout_stream` | 1 | 929 B | INFO | image-provider | `{"stream":"stdout","log":"","docker":{"container_id":"df60e2438578bd8ad312b92b9…` |
| `flags_go_flag_hostname_override_ip_ec2_internal` | 1 | 929 B | INFO | image-provider | `{"stream":"stdout","log":"","docker":{"container_id":"df60e2438578bd8ad312b92b9…` |
| `flags_go_flag_iptables_masquerade_bit` | 1 | 929 B | INFO | image-provider | `{"stream":"stdout","log":"","docker":{"container_id":"df60e2438578bd8ad312b92b9…` |
| `flags_go_flag_ipvs_exclude_cidrs` | 1 | 929 B | INFO | image-provider | `{"stream":"stdout","log":"","docker":{"container_id":"df60e2438578bd8ad312b92b9…` |
| `flags_go_flag_ipvs_strict_arp_false` | 1 | 929 B | INFO | image-provider | `{"stream":"stdout","log":"","docker":{"container_id":"df60e2438578bd8ad312b92b9…` |
| `oteldemo_adservice_targeted_ad_request_received_for_trace_id_span_id_trace_flags` | 6 | 918 B | TRACE | ad | `2025-10-01 20:12:34 - oteldemo.AdService - no baggage found in context trace_id…` |
| `oteldemo_adservice_targeted_ad_request_received_for_travel_trace_id_span_id_trace_flags` | 6 | 918 B | TRACE | ad | `2025-10-01 20:12:55 - oteldemo.AdService - no baggage found in context trace_id…` |
| `opensearchexporter_v0_logger_go_request_failed_resource_service_instance_id_service_name_otelcol_contrib_service_version` | 6 | 905 B | — | kafka | ` zookeeper.max.in.flight.requests = 10` |
| `waiting_for_kafka` | 52 | 884 B | — | accounting | `waiting for kafka` |
| `logger_migrator_t_level_info_msg_migration_successfully_executed_id_create_api_key_table_v2_duration` | 1 | 881 B | INFO | frontend | `{"stream":"stdout","log":"","docker":{"container_id":"55dcf25a8b5e274b978b954c1…` |
| `logger_migrator_t_level_info_msg_executing_migration_id_add_column_updated_in_star` | 1 | 850 B | INFO | flagd | `{"stream":"stdout","log":"","docker":{"container_id":"ea5de86fdcd5a24ff66aa71e9…` |
| `logger_migrator_t_level_info_msg_executing_migration_id_create_org_user_table_v1` | 1 | 850 B | INFO | flagd | `{"stream":"stdout","log":"","docker":{"container_id":"ea5de86fdcd5a24ff66aa71e9…` |
| `logger_migrator_t_level_info_msg_migration_successfully_executed_id_update_uid_column_values_in_alert_notification_durat` | 1 | 823 B | INFO | frontend-proxy | `[2025-10-01 20:11:45.936][8][info][main] [source/server/server.cc:440] envoy.ma…` |
| `logger_migrator_t_level_info_msg_executing_migration_id_rename_table_login_attempt_to_login_attempt_tmp_qwerty_v1` | 1 | 822 B | INFO | grafana | `logger=ngalert.state.manager rule_uid=des78nlna99tsf org_id=1 t=2025-10-01T20:1…` |
| `logger_migrator_t_level_info_msg_executing_migration_id_create_login_attempt_table` | 1 | 821 B | INFO | grafana | `logger=ngalert.state.manager rule_uid=des78nlna99tsf org_id=1 t=2025-10-01T20:1…` |
| `info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots` | 6 | 773 B | INFO | grafana | `logger=provisioning.alerting t=2025-10-01T20:12:34.549537051Z level=info msg="s…` |
| `logger_migrator_t_level_info_msg_migration_successfully_executed_id_rename_table_annotation_tag_to_annotation_tag_v2_v2_` | 1 | 773 B | INFO | frontend-proxy | `[2025-10-01 20:11:45.951][8][info][main] [source/server/server.cc:503] response…` |
| `shared_informer_go_waiting_for_caches_to_sync_for_node_config` | 1 | 764 B | INFO | jaeger | `{"level":"info","ts":1759349505.8774333,"caller":"grpc@v1.60.0/resolver_wrapper…` |
| `flags_go_flag_oom_score_adj` | 1 | 762 B | INFO | jaeger | `{"level":"info","ts":1759349505.8539035,"caller":"grpc@v1.60.0/resolver_wrapper…` |

_2257 additional patterns omitted from the table (see JSON summary)._

### SIEM query used

```
otel-logs
```

### Methodology

- **Pattern identity** is the Log10x `templateHash` — a stable field-set fingerprint computed from the token structure of the event. Identity stays constant across deploys, restarts, pod names, timestamps, and request IDs.
- **Cost model**: `bytes × analyzer_cost_per_gb` over the pulled window. Window cost is projected to weekly cost via `$/window × (168h / window_hours)`.
- **Recommendation rules**: mute when pattern is DEBUG/INFO or below a minimum-value bar AND ≥1% of total volume; sample when MAX 10/s; keep when ERROR or WARN.
- **Confidence** is `high` for patterns with ≥100 events in the window (stable rate), `medium` for 10-99, `low` for <10.

### Run metadata

- **snapshot_id**: `1fdb3a0b-e8fb-42ba-903d-ae4563631403`
- **started**: 2026-04-19T19:23:13.570Z
- **finished**: 2026-04-19T19:24:17.716Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 2779 (templater 61243ms)
- **events_analyzed**: 3.3K / target 5.0K (target_reached)
- **bytes_analyzed**: 378.3 KB
- **execution_mode**: paste_lambda


_Report saved to: /tmp/log10x-reports/poc_from_siem-2026-04-19T19-24-17.815Z.md_