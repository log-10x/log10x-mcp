> **Low-confidence mode**: fewer than 10,000 events analyzed. Top-5 drivers are reliable; long-tail recommendations are flagged low-confidence. Rerun with a larger `target_event_count` or `window` for deeper coverage.

# Log10x POC Report — Amazon CloudWatch Logs

_24h window · scope=`/log10x/poc-test-otel` · snapshot_id=`ed1ccf0f-c974-4603-9349-83068c150da4`_

## 1. Executive Summary

Analyzed **4.0K events** (3.7 MB) from Amazon CloudWatch Logs across the last 24h.

- **Observed cost (window)**: $0.00
- **Projected weekly cost**: $0.01
- **Potential savings (window)**: $0.00 — 0.0% of analyzed cost
- **Analyzer rate**: $0.50/GB (from vendors.json; override via `analyzer_cost_per_gb`)

**Top 3 wins**:
- Mute `stream_stdout_log_info_cart_cartstore_valkeycartstore_docker_container_id_kubernetes_container_name_cart_namespace_name_` → save $0.00
- Sample `stream_stdout_log_getcartasync_called_with_userid_docker_container_id_kubernetes_container_name_cart_namespace_name_defa` at 1/20 → save $0.00
- Sample `stream_stdout_log_info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cl` at 1/20 → save $0.00

## 2. Top Cost Drivers

| # | pattern identity | service | sev | events | % total | $/window | $/wk projected | newly-emerged |
|---|---|---|---|---|---|---|---|---|
| 1 | `stream_stdout_log_info_cart_cartstore_valkeycartstore_docker_container_id_kubernetes_container_name_cart_namespace_name_` | cart | — | 120 | 3% | $0.00 | $0.00 |  |
| 2 | `stream_stdout_log_getcartasync_called_with_userid_docker_container_id_kubernetes_container_name_cart_namespace_name_defa` | cart | — | 52 | 1% | $0.00 | $0.00 |  |
| 3 | `stream_stdout_log_info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cl` | kafka | — | 49 | 1% | $0.00 | $0.00 |  |
| 4 | `stream_stdout_log_info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_wa` | kafka | — | 49 | 1% | $0.00 | $0.00 |  |
| 5 | `stream_stdout_log_info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_m` | kafka | — | 49 | 1% | $0.00 | $0.00 |  |
| 6 | `stream_stdout_log_info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_o` | kafka | — | 49 | 1% | $0.00 | $0.00 |  |
| 7 | `stream_stderr_log_go_syncing_iptables_rules_ipfamily_ipv4_docker_container_id_kubernetes_container_name_kube_proxy_names` | kafka | — | 43 | 1% | $0.00 | $0.00 |  |
| 8 | `stream_stderr_log_go_complete_ipfamily_ipv4_elapsed_docker_container_id_kubernetes_container_name_kube_proxy_namespace_n` | kafka | — | 42 | 1% | $0.00 | $0.00 |  |
| 9 | `stream_stdout_log_info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offs` | kafka | — | 49 | 1% | $0.00 | $0.00 |  |
| 10 | `stream_stdout_log_info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_` | kafka | — | 46 | 1% | $0.00 | $0.00 |  |
| 11 | `stream_stdout_log_waiting_for_kafka_docker_container_id_kubernetes_container_name_wait_for_kafka_namespace_name_default_` | accounting | — | 52 | 1% | $0.00 | $0.00 |  |
| 12 | `stream_stdout_log_waiting_for_kafka_docker_container_id_kubernetes_container_name_wait_for_kafka_namespace_name_default_` | flagd | — | 43 | 1% | $0.00 | $0.00 |  |
| 13 | `stream_stdout_log_info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_i` | kafka | — | 40 | 1.0% | $0.00 | $0.00 |  |
| 14 | `stream_stderr_log_go_reloading_service_iptables_data_ipfamily_ipv4_docker_container_id_kubernetes_container_name_kube_pr` | kafka | — | 33 | 0.8% | $0.00 | $0.00 |  |
| 15 | `stream_stdout_log_waiting_for_kafka_docker_container_id_kubernetes_container_name_wait_for_kafka_namespace_name_default_` | cart | — | 43 | 1% | $0.00 | $0.00 |  |
| 16 | `stream_stdout_log_additemasync_called_with_userid_productid_quantity_docker_container_id_kubernetes_container_name_cart_` | cart | — | 35 | 0.9% | $0.00 | $0.00 |  |
| 17 | `stream_stdout_log_oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags_docker_container_id_kubern` | ad | — | 29 | 0.7% | $0.00 | $0.00 |  |
| 18 | `stream_stdout_log_getcartasync_called_with_userid_docker_container_id_kubernetes_container_name_cart_namespace_name_defa` | cart | — | 31 | 0.8% | $0.00 | $0.00 |  |
| 19 | `stream_stderr_log_tinfo_retry_sender_go_failed_will_retry_the_request_after_interval_t_resource_service_instance_id_serv` | kube-proxy | — | 13 | 0.3% | $0.00 | $0.00 |  |
| 20 | `stream_stdout_log_info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_i` | kafka | — | 13 | 0.3% | $0.00 | $0.00 |  |

## 3. Service-Level Breakdown

| service | events | $/window | severity mix |
|---|---|---|---|
| grafana | 1.6K | $0.00 | — 100% |
| kafka | 1.0K | $0.00 | — 100% |
| kube-proxy | 266 | $0.00 | — 100% |
| cart | 295 | $0.00 | — 100% |
| frontend | 153 | $0.00 | — 100% |
| frontend-proxy | 110 | $0.00 | — 100% |
| accounting | 129 | $0.00 | — 100% |
| flagd | 136 | $0.00 | — 100% |
| jaeger | 74 | $0.00 | — 100% |
| ad | 66 | $0.00 | — 100% |
| fraud-detection | 66 | $0.00 | — 100% |
| coredns | 49 | $0.00 | — 100% |
| image-provider | 41 | $0.00 | — 100% |
| checkout | 34 | $0.00 | — 100% |
| load-generator | 12 | $0.00 | — 100% |

## 4. Regulator Recommendations

Per-pattern recommendations with reasoning, projected savings, and ready-to-paste log10x regulator mute-file YAML. Mutes auto-expire at `untilEpochSec`; sampling retains a statistical slice for debug.

### #1 — `stream_stdout_log_info_cart_cartstore_valkeycartstore_docker_container_id_kubernetes_container_name_cart_namespace_name_`  _(high confidence)_

- **Action**: mute (drop all events)
- **Reasoning**: High-volume info-class pattern (3% of analyzed volume) — candidate for mute after dependency check.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stdout_log_info_cart_cartstore_valkeycartstore_docker_container_id_kubernetes_container_name_cart_namespace_name_")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stdout_log_info_cart_cartstore_valkeycartstore_docker_container_id_kubernetes_container_name_cart_namespace_name_
  action: drop
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "High-volume info-class pattern (3% of analyzed volume) — candidate for mute after dependency check."
```

### #2 — `stream_stdout_log_getcartasync_called_with_userid_docker_container_id_kubernetes_container_name_cart_namespace_name_defa`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stdout_log_getcartasync_called_with_userid_docker_container_id_kubernetes_container_name_cart_namespace_name_defa")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stdout_log_getcartasync_called_with_userid_docker_container_id_kubernetes_container_name_cart_namespace_name_defa
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

### #3 — `stream_stdout_log_info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cl`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stdout_log_info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cl")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stdout_log_info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cl
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

### #4 — `stream_stdout_log_info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_wa`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stdout_log_info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_wa")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stdout_log_info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_wa
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

### #5 — `stream_stdout_log_info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_m`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stdout_log_info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_m")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stdout_log_info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_m
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

### #6 — `stream_stdout_log_info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_o`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stdout_log_info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_o")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stdout_log_info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_o
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

### #7 — `stream_stderr_log_go_syncing_iptables_rules_ipfamily_ipv4_docker_container_id_kubernetes_container_name_kube_proxy_names`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stderr_log_go_syncing_iptables_rules_ipfamily_ipv4_docker_container_id_kubernetes_container_name_kube_proxy_names")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stderr_log_go_syncing_iptables_rules_ipfamily_ipv4_docker_container_id_kubernetes_container_name_kube_proxy_names
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

### #8 — `stream_stderr_log_go_complete_ipfamily_ipv4_elapsed_docker_container_id_kubernetes_container_name_kube_proxy_namespace_n`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stderr_log_go_complete_ipfamily_ipv4_elapsed_docker_container_id_kubernetes_container_name_kube_proxy_namespace_n")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stderr_log_go_complete_ipfamily_ipv4_elapsed_docker_container_id_kubernetes_container_name_kube_proxy_namespace_n
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

### #9 — `stream_stdout_log_info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offs`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stdout_log_info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offs")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stdout_log_info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offs
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

### #10 — `stream_stdout_log_info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_`  _(medium confidence)_

- **Action**: sample 1/20
- **Reasoning**: Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug.
- **Projected savings (window)**: $0.00
- **Dependency warning**: run `log10x_dependency_check(pattern: "stream_stdout_log_info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_")` first to surface alerts/dashboards/saved searches referencing this pattern

```yaml
# regulator mute file entry — commit to your GitOps ConfigMap
- pattern: stream_stdout_log_info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_
  action: sample
    sampleRate: 20
  untilEpochSec: 1779218986   # auto-expires in 30d
  reason: "Moderate-volume info-class pattern — sample 1/20 to retain a trickle for debug."
```

## 5. Native SIEM Exclusion Configs

Ready-to-paste configs for Amazon CloudWatch Logs and fluent-bit. Drop these into your pipeline **only** after running `log10x_dependency_check` on each pattern.

### Amazon CloudWatch Logs

```
# Subscription filter: drop pattern #1
aws logs put-subscription-filter \
  --log-group-name "/aws/your/logs" \
  --filter-name "log10x-drop-0" \
  --filter-pattern '-"stream" -"stdout" -"log"' \
  --destination-arn "<your-kinesis-or-lambda-arn>"
```

### Fluent Bit (universal forwarder)

```
[FILTER]
    Name       grep
    Match      *
    Exclude    log stream.*stdout.*log
# pattern identity: stream_stdout_log_info_cart_cartstore_valkeycartstore_docker_container_id_kubernetes_container_name_cart_namespace_name_ (#1)
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
| `stream_stdout_log_info_cart_cartstore_valkeycartstore_docker_container_id_kubernetes_container_name_cart_namespace_name_` | 120 | 98.9 KB | — | cart | `{"stream":"stderr","log":"time=\"2025-10-01T20:06:57Z\" level=info msg=\"Found …` |
| `stream_stdout_log_getcartasync_called_with_userid_docker_container_id_kubernetes_container_name_cart_namespace_name_defa` | 52 | 44.5 KB | — | cart | `{"stream":"stderr","log":"time=\"2025-10-01T20:06:57Z\" level=info msg=\"Found …` |
| `stream_stdout_log_info_created_log_for_partition_consumer_offsets_in_tmp_kafka_logs_consumer_offsets1_with_properties_cl` | 49 | 43.1 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:05,132] INFO [MetadataLoader id=1] …` |
| `stream_stdout_log_info_partition_consumer_offsets_broker_log_loaded_for_partition_consumer_offsets2_with_initial_high_wa` | 49 | 42.7 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:05,219] INFO [ControllerServer id=1…` |
| `stream_stdout_log_info_logloader_partition_consumer_offsets_dir_tmp_kafka_logs_loading_producer_state_till_offset_with_m` | 49 | 42.7 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:05,131] INFO [SocketServer listener…` |
| `stream_stdout_log_info_partition_consumer_offsets_broker_no_checkpointed_highwatermark_is_found_for_partition_consumer_o` | 49 | 42.6 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:05,142] INFO Awaiting socket connec…` |
| `stream_stderr_log_go_syncing_iptables_rules_ipfamily_ipv4_docker_container_id_kubernetes_container_name_kube_proxy_names` | 43 | 42.4 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,906] INFO [Partition __consumer_…` |
| `stream_stderr_log_go_complete_ipfamily_ipv4_elapsed_docker_container_id_kubernetes_container_name_kube_proxy_namespace_n` | 42 | 41.5 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,923] INFO [LogLoader partition=_…` |
| `stream_stdout_log_info_groupmetadatamanager_brokerid_scheduling_loading_of_offsets_and_group_metadata_from_consumer_offs` | 49 | 41.2 KB | — | kafka | `{"stream":"stdout","log":"\tlog.segment.bytes = 1073741824","docker":{"containe…` |
| `stream_stdout_log_info_groupcoordinator_elected_as_the_group_coordinator_for_partition_in_epoch_kafka_coordinator_group_` | 46 | 38.4 KB | — | kafka | `{"stream":"stdout","log":"\tlog.roll.ms = null","docker":{"container_id":"21f53…` |
| `stream_stdout_log_waiting_for_kafka_docker_container_id_kubernetes_container_name_wait_for_kafka_namespace_name_default_` | 52 | 35.2 KB | — | accounting | `{"stream":"stdout","log":"waiting for kafka","docker":{"container_id":"09b2c1ce…` |
| `stream_stdout_log_waiting_for_kafka_docker_container_id_kubernetes_container_name_wait_for_kafka_namespace_name_default_` | 43 | 33.7 KB | — | flagd | `{"stream":"stdout","log":"* Ruby version: ruby 3.4.4 (2025-05-14 revision a3853…` |
| `stream_stdout_log_info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_i` | 40 | 33.4 KB | — | kafka | `{"stream":"stdout","log":"\treplica.selector.class = null","docker":{"container…` |
| `stream_stderr_log_go_reloading_service_iptables_data_ipfamily_ipv4_docker_container_id_kubernetes_container_name_kube_pr` | 33 | 32.8 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,962] INFO [GroupMetadataManager …` |
| `stream_stdout_log_waiting_for_kafka_docker_container_id_kubernetes_container_name_wait_for_kafka_namespace_name_default_` | 43 | 32.4 KB | — | cart | `{"stream":"stdout","log":" AddItemAsync called with userId=945aa900-9f03-11f0-9…` |
| `stream_stdout_log_additemasync_called_with_userid_productid_quantity_docker_container_id_kubernetes_container_name_cart_` | 35 | 29.9 KB | — | cart | `{"stream":"stderr","log":"time=\"2025-10-01T20:06:57Z\" level=info msg=\"Update…` |
| `stream_stdout_log_oteldemo_adservice_no_baggage_found_in_context_trace_id_span_id_trace_flags_docker_container_id_kubern` | 29 | 27.1 KB | — | ad | `{"stream":"stderr","log":"SLF4J(W): Defaulting to no-operation (NOP) logger imp…` |
| `stream_stdout_log_getcartasync_called_with_userid_docker_container_id_kubernetes_container_name_cart_namespace_name_defa` | 31 | 26.5 KB | — | cart | `{"stream":"stdout","log":" Starting initialization of the feature provider","do…` |
| `stream_stderr_log_tinfo_retry_sender_go_failed_will_retry_the_request_after_interval_t_resource_service_instance_id_serv` | 13 | 12.6 KB | — | kube-proxy | `{"stream":"stderr","log":"I1001 20:10:54.577281 1 proxier.go:828] \"Syncing ipt…` |
| `stream_stdout_log_info_producerstatemanager_partition_cluster_metadata_wrote_producer_snapshot_at_offset_with_producer_i` | 13 | 12.5 KB | — | kafka | `{"stream":"stdout","log":"\tssl.principal.mapping.rules = DEFAULT","docker":{"c…` |
| `stream_stdout_log_info_snapshotemitter_id_successfully_wrote_snapshot_org_apache_kafka_image_publisher_snapshotemitter_d` | 13 | 12.2 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:05,114] INFO [ControllerServer id=1…` |
| `stream_stdout_log_info_snapshotgenerator_id_creating_new_kraft_snapshot_file_snapshot_because_we_have_replayed_at_least_` | 13 | 12.2 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:05,122] INFO [MetadataLoader id=1] …` |
| `stream_stderr_log_tgo_opentelemetry_io_collector_processor_batchprocessor_v0_batch_processor_go_docker_container_id_kube` | 11 | 10.6 KB | — | kube-proxy | `{"stream":"stderr","log":"I1001 20:10:55.727762 1 proxier.go:1547] \"Reloading …` |
| `stream_stdout_log_info_o_o_p_pluginsservice_opensearch_onindexmodule_index_otel_logs_docker_container_id_kubernetes_cont` | 11 | 10.6 KB | — | kube-proxy | `{"stream":"stderr","log":"I1001 20:07:11.622096 1 flags.go:64] FLAG: --machine-…` |
| `stream_stdout_log_info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_incremented_log_start_offset_to_due_to_s` | 9 | 9.9 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:06,186] INFO [KafkaRaftServer nodeI…` |
| `stream_stdout_log_info_partition_cluster_metadata_nodeid_marking_snapshot_0_offset_epoch3_for_deletion_because_its_times` | 9 | 8.8 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,466] INFO [SnapshotGenerator id=…` |
| `stream_stdout_log_waiting_for_valkey_cart_docker_container_id_kubernetes_container_name_wait_for_valkey_cart_namespace_n` | 10 | 8.5 KB | — | cart | `{"stream":"stdout","log":"info: cart.cartstore.ValkeyCartStore[0]","docker":{"c…` |
| `stream_stdout_log_info_deleted_log_tmp_kafka_logs_cluster_metadata_log_deleted_org_apache_kafka_storage_internals_log_lo` | 8 | 8.0 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,602] INFO [LogLoader partition=_…` |
| `stream_stdout_log_info_deleted_offset_index_tmp_kafka_logs_cluster_metadata_index_deleted_org_apache_kafka_storage_inter` | 8 | 8.0 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,603] INFO Created log for partit…` |
| `stream_stderr_log_error_internal_shipping_quote_failure_failed_post_to_shipping_service_post_shipping_get_quote_unsuppor` | 12 | 7.8 KB | — | flagd | `{"stream":"stdout","log":" \"defaultVariant\": \"off\"","docker":{"container_id…` |
| `stream_stdout_log_info_deleted_time_index_tmp_kafka_logs_cluster_metadata_timeindex_deleted_org_apache_kafka_storage_int` | 8 | 7.8 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,603] INFO [Partition __consumer_…` |
| `stream_stdout_log_info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kaf` | 8 | 7.6 KB | — | kafka | `{"stream":"stdout","log":"\ttransactional.id.expiration.ms = 604800000","docker…` |
| `stream_stdout_log_info_groupmetadatamanager_brokerid_finished_loading_offsets_and_group_metadata_from_consumer_offsets_i` | 9 | 7.5 KB | — | kafka | `{"stream":"stdout","log":"\treplica.lag.time.max.ms = 30000","docker":{"contain…` |
| `stream_stdout_log_info_o_o_c_m_metadatamappingservice_opensearch_otel_logs_update_mapping_doc_docker_container_id_kubern` | 8 | 7.4 KB | — | kube-proxy | `{"stream":"stderr","log":"I1001 20:07:11.622135 1 flags.go:64] FLAG: --oom-scor…` |
| `stream_stderr_log_v1_clientconn_go_t_core_channel_1_subchannel_2_grpc_addrconn_createtransport_failed_to_connect_to_addr` | 7 | 6.9 KB | — | kube-proxy | `{"stream":"stderr","log":"I1001 20:07:40.325910 1 proxier.go:822] \"SyncProxyRu…` |
| `stream_stdout_log_info_deleted_producer_state_snapshot_tmp_kafka_logs_cluster_metadata_snapshot_deleted_org_apache_kafka` | 7 | 6.9 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,615] INFO [Partition __consumer_…` |
| `stream_stderr_log_go_reloading_service_iptables_data_ipfamily_ipv4_4_docker_container_id_kubernetes_container_name_kube_` | 7 | 6.8 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,906] INFO [Partition __consumer_…` |
| `stream_stdout_log_info_plugin_kubernetes_waiting_for_kubernetes_api_before_starting_server_docker_container_id_kubernete` | 9 | 6.7 KB | — | checkout | `{"stream":"stdout","log":"waiting for kafka","docker":{"container_id":"47dede4f…` |
| `stream_stdout_log_info_plugin_kubernetes_waiting_for_kubernetes_api_before_starting_server_docker_container_id_kubernete` | 9 | 6.0 KB | — | checkout | `{"stream":"stdout","log":"waiting for kafka","docker":{"container_id":"47dede4f…` |
| `stream_stdout_log_info_deleted_snapshot_files_for_snapshot_0_offset_epoch_org_apache_kafka_snapshot_snapshots_docker_con` | 6 | 5.9 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,603] INFO [Partition __consumer_…` |
| `stream_stdout_log_info_unifiedlog_partition_cluster_metadata_dir_tmp_kafka_logs_deleting_segments_due_to_log_start_offse` | 6 | 5.9 KB | — | kafka | `{"stream":"stdout","log":"[2025-10-01 20:13:14,397] INFO Sent auto-creation req…` |
| `stream_stdout_log_info_locallog_partition_cluster_metadata_dir_tmp_kafka_logs_rolled_new_log_segment_at_offset_in_ms_kaf` | 6 | 5.7 KB | — | kafka | `{"stream":"stdout","log":"\ttransaction.state.log.replication.factor = 1","dock…` |
| `stream_stdout_log_info_o_o_p_pluginsservice_opensearch_onindexmodule_index_top_queries_jsh_docker_container_id_kubernete` | 6 | 5.7 KB | — | kube-proxy | `{"stream":"stderr","log":"I1001 20:07:11.845351 1 shared_informer.go:313] Waiti…` |
| `stream_stdout_log_oteldemo_adservice_targeted_ad_request_received_for_trace_id_span_id_trace_flags_docker_container_id_k` | 6 | 5.5 KB | — | ad | `{"stream":"stdout","log":"2025-10-01 20:12:34 - oteldemo.AdService - no baggage…` |
| `stream_stdout_log_oteldemo_adservice_targeted_ad_request_received_for_travel_trace_id_span_id_trace_flags_docker_contain` | 6 | 5.5 KB | — | ad | `{"stream":"stdout","log":"2025-10-01 20:12:55 - oteldemo.AdService - no baggage…` |
| `stream_stdout_log_info_o_o_s_l_opensearch_indexing_docker_container_id_kubernetes_container_name_opensearch_namespace_na` | 6 | 5.5 KB | — | kube-proxy | `{"stream":"stderr","log":"I1001 20:07:11.621954 1 flags.go:64] FLAG: --init-onl…` |
| `stream_stdout_log_info_o_o_p_pluginsservice_opensearch_onindexmodule_index_opensearch_sap_log_types_config_docker_contai` | 6 | 5.5 KB | — | kube-proxy | `{"stream":"stderr","log":"I1001 20:07:11.621894 1 flags.go:64] FLAG: --config=\…` |
| `stream_stdout_log_otel_collector_port_tcp_tcp_5_docker_container_id_kubernetes_container_name_accounting_namespace_name_` | 6 | 5.4 KB | — | accounting | `{"stream":"stdout","log":"[OTEL_COLLECTOR_PORT_14250_TCP, tcp://10.100.134.60:1…` |
| `stream_stdout_log_otel_collector_port_tcp_addr_docker_container_id_kubernetes_container_name_accounting_namespace_name_d` | 6 | 5.3 KB | — | accounting | `{"stream":"stdout","log":"[OTEL_COLLECTOR_PORT_14250_TCP_ADDR, 10.100.134.60]",…` |
| `stream_stdout_log_otel_collector_port_tcp_port_1_docker_container_id_kubernetes_container_name_accounting_namespace_name` | 6 | 5.3 KB | — | accounting | `{"stream":"stdout","log":"[OTEL_COLLECTOR_PORT_14250_TCP_PORT, 14250]","docker"…` |

_2672 additional patterns omitted from the table (see JSON summary)._

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

- **snapshot_id**: `ed1ccf0f-c974-4603-9349-83068c150da4`
- **started**: 2026-04-19T19:23:22.629Z
- **finished**: 2026-04-19T19:29:46.027Z
- **mcp_version**: 1.4.0
- **pull_wall_time_ms**: 5587 (templater 377808ms)
- **events_analyzed**: 4.0K / target 5.0K (target_reached)
- **bytes_analyzed**: 3.7 MB
- **execution_mode**: paste_lambda


_Report saved to: /tmp/log10x-reports/poc_from_siem-2026-04-19T19-29-46.249Z.md_