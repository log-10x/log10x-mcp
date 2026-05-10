# Hero scenario: Errors — explain the untagged-severity volume

**Scenario:** `error-untagged-explanation`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T03:16:37.258Z
**Duration:** 137.2s
**Bash calls:** 14

## User question

> We see a lot of log volume without any severity tag. Tell me what fraction of our volume is untagged severity, why this might be happening, and how to fix it — without recommending we mute it (untagged content can still be important).

## Three axes

- **Hallucination (drift score):** 0 unsupported · 10 supported · 23 inconclusive
- **Value delivered:** 0.92 — The synthesis directly answers all three parts of the question (fraction=83%, why=OTel Collector self-logs via Fluentd without severity extraction, how to fix=three concrete pipeline changes) with enough specificity for an SRE to act immediately, and correctly avoids recommending muting.
- **Value received:** 0.85 — The MCP returned the critical severity breakdown with exact GB/cost figures, top untagged patterns by cost, service/container label data, and pipeline metadata that together enabled the full diagnosis, though pattern_examples failed due to missing scope configuration and some filter queries returned no incremental data.

## Sub-agent final synthesis

I now have everything I need. Let me synthesize the findings.

---

## Findings: 83% of Log Volume Has No Severity Tag

### What the data shows

| severity_level | Volume (7d) | Share | Cost/wk |
|---|---|---|---|
| **(empty — untagged)** | **28.9 GB** | **83%** | **$43** |
| ERROR | 3.0 GB | 9% | $4.5 |
| DEBUG | 1.5 GB | 4% | $2.2 |
| INFO | 839 MB | 2% | $1.2 |
| TRACE | 647 MB | 2% | $0.95 |
| CRITICAL | 15 MB | <1% | $0.02 |
| WARN | 49 KB | <1% | — |
| **Total** | **34.9 GB** | | **$52/wk** |

**83% of your 34.9 GB/week (28.9 GB, $43/wk) carries no `severity_level` tag.**

---

### Why this is happening — root causes confirmed by the data

1. **The dominant source is infrastructure/platform telemetry, not application code.** Every high-cost untagged pattern names OpenTelemetry Collector internals verbatim: `opentelemetry-collector-contrib exporter opensearchexporter` ($3.8/wk), `otelcol batchprocessor` ($3.7/wk), `ConsumeLogsFunc ConsumeLogs` ($1.8/wk), `opensearch-go transport` ($1.3/wk), and many more. The OTel Collector's own Go runtime logs do **not** emit an OTel-standard `SeverityText`/`SeverityNumber` field by default — they use the Zap logger but the field is not mapped into the OTel log record body's severity slot.

2. **The `tenx_user_service` label is also empty for all of this traffic (100% of volume shows `(empty)` for `tenx_user_service`, `k8s_container`).** This confirms the logs arrive with no resource-level service attribution — a Fluentd pipeline (the only `tenx_fwd_input` value present) is forwarding collector self-logs without attaching `k8s.container.name` or `service.name` attributes.

3. **Fluentd is the single ingestion point** (`tenx_fwd_input = fluentd`) and it is not applying a severity-parsing transform to the OTel Collector's log lines before shipping them. The collector logs arrive as plain text blobs; the severity field is either embedded in the log string (e.g., `"level":"info"`) but never extracted into the structured field, or absent entirely.

---

### What to do — structural fixes only, no muting

1. **Add a Fluentd `record_transformer` / `grep` + `record_transformer` filter** that parses the `level` or `severity` JSON key from the OTel Collector's structured log output and maps it to the standard severity field before forwarding. For Fluent Bit users, the `Modify` filter with `Copy level severity` achieves the same.

2. **Configure the OTel Collector's own telemetry exporter** to set `service.log_level` / `telemetry.logs.level` and ensure the Collector's internal Zap logger outputs to `SeverityNumber`-compliant OTel log records when the `otlp` self-telemetry receiver is used (`service::telemetry::logs`). This avoids the problem at the source.

3. **Add resource detection to the Fluentd pipeline** (`fluent-plugin-kubernetes_metadata_filter`) so that `k8s.container.name` and `service.name` are populated — this will fix both the empty severity mapping and the empty `tenx_user_service` label simultaneously.

4. **Do not mute this traffic.** The `doctor` tool flagged that a single pattern is 54% of 30-day spend. At least part of that is OTel Collector pipeline noise, but some fraction of it may contain genuine ERROR-class events that are currently invisible to alerting because severity is untagged. Fix the structural tagging gap first so you can make informed triage decisions.

## Oracle validation

- Claims found: 33 numeric, 0 pattern names
- Supported by oracle: 10 · Unsupported: 0 · Inconclusive: 23
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$43** — no targeted oracle path for this kind; claim accepted as plausible
    > ost/wk | |---|---|---|---| | **(empty — untagged)** | **28.9 GB** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 8
- [WARN] **$4.5** — no targeted oracle path for this kind; claim accepted as plausible
    > empty — untagged)** | **28.9 GB** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 64
- [WARN] **$2.2** — no targeted oracle path for this kind; claim accepted as plausible
    > ** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL
- [WARN] **$1.2** — no targeted oracle path for this kind; claim accepted as plausible
    > OR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN
- [WARN] **$0.95** — no targeted oracle path for this kind; claim accepted as plausible
    > UG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **Total*
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
    > 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **Total** | **34.9 GB** | | **$52/wk** | *
- [WARN] **$52** — no targeted oracle path for this kind; claim accepted as plausible
    > 5 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **Total** | **34.9 GB** | | **$52/wk** | **83% of your 34.9 GB/week (28.9 GB, $43/wk) carries no `severity_le
- [WARN] **$43** — no targeted oracle path for this kind; claim accepted as plausible
    > **Total** | **34.9 GB** | | **$52/wk** | **83% of your 34.9 GB/week (28.9 GB, $43/wk) carries no `severity_level` tag.** --- ### Why this is happening — roo
- [WARN] **$3.8** — no targeted oracle path for this kind; claim accepted as plausible
    > ernals verbatim: `opentelemetry-collector-contrib exporter opensearchexporter` ($3.8/wk), `otelcol batchprocessor` ($3.7/wk), `ConsumeLogsFunc ConsumeLogs` ($1.
- [WARN] **$3.7** — no targeted oracle path for this kind; claim accepted as plausible
    > ector-contrib exporter opensearchexporter` ($3.8/wk), `otelcol batchprocessor` ($3.7/wk), `ConsumeLogsFunc ConsumeLogs` ($1.8/wk), `opensearch-go transport` ($1
- [WARN] **$1.8** — no targeted oracle path for this kind; claim accepted as plausible
    > ` ($3.8/wk), `otelcol batchprocessor` ($3.7/wk), `ConsumeLogsFunc ConsumeLogs` ($1.8/wk), `opensearch-go transport` ($1.3/wk), and many more. The OTel Collector
- [WARN] **$1.3** — no targeted oracle path for this kind; claim accepted as plausible
    > ($3.7/wk), `ConsumeLogsFunc ConsumeLogs` ($1.8/wk), `opensearch-go transport` ($1.3/wk), and many more. The OTel Collector's own Go runtime logs do **not** emi
- [OK] **28.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > Volume (7d) | Share | Cost/wk | |---|---|---|---| | **(empty — untagged)** | **28.9 GB** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB
- [OK] **3.0 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ---|---| | **(empty — untagged)** | **28.9 GB** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2
- [OK] **1.5 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ** | **28.9 GB** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95
- [OK] **839 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > *$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% |
- [OK] **647 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% |
- [OK] **15 MB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > .2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **Total** | **34.9 GB** | | *
- [OK] **49 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > 2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **Total** | **34.9 GB** | | **$52/wk** | **83% of your 34.9
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **Total** | **34.9 GB** | | **$52/wk** | **83% of your 34.9 GB/week (28.9 GB, $43/wk) carries
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > N | 49 KB | <1% | — | | **Total** | **34.9 GB** | | **$52/wk** | **83% of your 34.9 GB/week (28.9 GB, $43/wk) carries no `severity_level` tag.** --- ### Why
- [OK] **28.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > % | — | | **Total** | **34.9 GB** | | **$52/wk** | **83% of your 34.9 GB/week (28.9 GB, $43/wk) carries no `severity_level` tag.** --- ### Why this is happen
- [WARN] **83%** — percentages are derived; oracle does not gate them
    > now have everything I need. Let me synthesize the findings. --- ## Findings: 83% of Log Volume Has No Severity Tag ### What the data shows | severity_level
- [WARN] **83%** — percentages are derived; oracle does not gate them
    > Share | Cost/wk | |---|---|---|---| | **(empty — untagged)** | **28.9 GB** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 |
- [WARN] **9%** — percentages are derived; oracle does not gate them
    > | **(empty — untagged)** | **28.9 GB** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE
- [WARN] **4%** — percentages are derived; oracle does not gate them
    > .9 GB** | **83%** | **$43** | | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRIT
- [WARN] **2%** — percentages are derived; oracle does not gate them
    > | ERROR | 3.0 GB | 9% | $4.5 | | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | |
- [WARN] **2%** — percentages are derived; oracle does not gate them
    > | DEBUG | 1.5 GB | 4% | $2.2 | | INFO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **T
- [WARN] **1%** — percentages are derived; oracle does not gate them
    > FO | 839 MB | 2% | $1.2 | | TRACE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **Total** | **34.9 GB** | | **$52/wk**
- [WARN] **1%** — percentages are derived; oracle does not gate them
    > CE | 647 MB | 2% | $0.95 | | CRITICAL | 15 MB | <1% | $0.02 | | WARN | 49 KB | <1% | — | | **Total** | **34.9 GB** | | **$52/wk** | **83% of your 34.9 GB/week
- [WARN] **83%** — percentages are derived; oracle does not gate them
    > 0.02 | | WARN | 49 KB | <1% | — | | **Total** | **34.9 GB** | | **$52/wk** | **83% of your 34.9 GB/week (28.9 GB, $43/wk) carries no `severity_level` tag.** -
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > lot. 2. **The `tenx_user_service` label is also empty for all of this traffic (100% of volume shows `(empty)` for `tenx_user_service`, `k8s_container`).** This
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > *Do not mute this traffic.** The `doctor` tool flagged that a single pattern is 54% of 30-day spend. At least part of that is OTel Collector pipeline noise, but

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2852ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3264ms, stdout=844B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 6681ms, stdout=1279B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 3146ms, stdout=93B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_list_by_label --args ...
exit=0, 7385ms, stdout=1840B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4653ms, stdout=1910B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 5794ms, stdout=1279B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_list_by_label --args ...
exit=0, 3716ms, stdout=779B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=0, 8581ms, stdout=1212B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 6384ms, stdout=306B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 6177ms, stdout=113B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_list_by_label --args ...
exit=0, 3788ms, stdout=757B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_advise_receiver --arg...
exit=1, 2737ms, stdout=199B, stderr=0B

### 14. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=0, 11653ms, stdout=5071B, stderr=0B
