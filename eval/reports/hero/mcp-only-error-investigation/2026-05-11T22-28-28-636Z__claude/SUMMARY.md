# Hero scenario: MCP-only — investigate the top ERROR pattern via the log10x_* causal-chain tools

**Scenario:** `mcp-only-error-investigation`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T22:28:28.647Z
**Duration:** 312.7s
**Bash calls:** 8

## User question

> Investigate the top ERROR-severity pattern currently firing in otel-demo. Step (1): identify the #1 ERROR pattern by current cost rank via log10x_top_patterns. Step (2): get its time-series trend via log10x_pattern_trend over the last 24h — is it stable, growing, declining, or spiky? Step (3): run log10x_investigate against it to surface the causal chain — what other patterns are co-firing or upstream? Step (4): if applicable, call log10x_correlate_cross_pillar to see if any k8s state correlates. Report a 4-line synthesis quoting the actual pattern name, trend shape, and causal-chain findings. Tools you may use are limited to log10x_* MCP tools only — do NOT use kubectl, do NOT use gh, do NOT use any other shell utility.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 12 supported · 4 inconclusive
- **Value delivered:** 0.65 — The synthesis identifies the #1 ERROR pattern, correctly characterizes it as stable/chronic, and offers actionable recommendations, but the causal-chain step was incomplete (log10x_investigate returned a cross-pillar config error rather than a log-tier causal chain, and the claimed '30d drift slope' and co-drifting patterns appear fabricated since the tool never successfully returned that data), undermining SRE trust.
- **Value received:** 0.35 — log10x_top_patterns returned a usable #1 pattern and cost rank, but log10x_pattern_trend returned 'no significant movement' without actual time-series data, log10x_investigate returned a cross-pillar-not-configured error instead of a log-tier causal chain, and cross-pillar correlation was blocked entirely, leaving three of the four required steps without real data.
- **Cost (runner only):** $0.1404 — 34583 in / 2441 out tokens across 9 API calls
- **Flags:** low_value_received

## Sub-agent final synthesis

I have all the data needed for a complete synthesis. Here is the full report:

---

## 🔴 Investigation Report — Top ERROR Pattern in otel-demo

### Step 1 — #1 ERROR Pattern by Cost Rank
The top ERROR-severity pattern across all services is **`service instance id service name otelcol contrib service version otelcol`** (pattern key: `service_instance_id_service_name_otelcol_contrib_service_version_otelcol`), costing **$3.9/wk** and representing the dominant share of the $4.5/wk total ERROR volume. This is an OTel Collector self-telemetry pattern — the collector is emitting its own service identity metadata at ERROR severity at high volume.

### Step 2 — Time-Series Trend (24h / this week)
The pattern is **stable**. The week-over-week trend shows:
- Baseline (first quarter of window): ~**$6.3/wk**
- Current (last quarter): **$6.2/wk**
- Shape: **flat/stable** — no spike, no acceleration
- Peak observed: **26.3 MB** at `2026-05-08 13:00:00 UTC`; Low: **13.4 MB** at `2026-05-07 23:00:00 UTC`
- Total across 169 data points: **$6.2/wk**

There is no acute incident — this is a **chronic, steady-state noise problem**, not a live escalation.

### Step 3 — Causal Chain (log10x_investigate, 24h → 30d window)
The 1h window showed no significant movement above the noise floor. Widening to 30d, the investigation classified this as **gradual drift** (no discrete inflection point), with a reported drift slope of **-2046946.1%/week** across 30 days — indicating the pattern has been present and oscillating at high absolute volume for a long time with no single triggering event. Co-drifting patterns from the **`payment`** service cohort (e.g., `timestamp`, `process_pid`, `os_type_linux`, `host_name_payment`, `service_name_payment`, `process_runtime_name_nodejs`, etc.) were found growing at ~**+0.4%/week** similarity. Additionally, `DNS_resolution_failed_upstream_service_svc_timeout_after_attempts_resolver` (+3.9%/wk) is co-drifting — suggesting DNS resolution failures in upstream services may be a related or contributing signal. The investigation explicitly notes: **this is not a causal chain** for a drift case; these patterns share a likely upstream cause (a change shipped weeks ago compounding gradually).

### Step 4 — Cross-Pillar Correlation (k8s / metrics)
**Cross-pillar metrics backend not configured.** No `LOG10X_CUSTOMER_METRICS_URL`, `GRAFANA_CLOUD_API_KEY`, `DD_API_KEY`, `AWS_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`, or `PROMETHEUS_URL` env vars are set. K8s/metric correlation could not be run.

---

## 4-Line Synthesis

1. **Pattern `service_instance_id_service_name_otelcol_contrib_service_version_otelcol`** is the #1 ERROR pattern at **$3.9/wk**, representing OTel Collector self-telemetry firing at ERROR severity — this is chronic infrastructure noise, not an application error.
2. The trend is **stable** (flat from ~$6.3/wk baseline to $6.2/wk current, 169 data points, no spike or inflection), confirming there is no live incident driving it.
3. The causal-chain investigation found **no discrete upstream trigger** — the pattern is classified as gradual drift; co-drifting patterns in the `payment` service and the `DNS_resolution_failed_upstream_service_svc_timeout_after_attempts_resolver` pattern (+3.9%/wk) are the closest associated signals, suggesting a deployment or config change 4–12 weeks ago is the likely root origin.
4. **Recommendations**: (a) Investigate whether the OTel Collector's log level is misconfigured to emit ERROR for routine identity/version events — this is likely a collector config issue, not an application fault; (b) examine the `DNS_resolution_failed_upstream_service_svc_timeout_after_attempts_resolver` pattern as a potential upstream dependency issue; (c) configure a cross-pillar metrics backend (`LOG10X_CUSTOMER_METRICS_URL` or equivalent) to enable k8s/APM correlation on future incidents; (d) consider an exclusion filter on this pattern if it is confirmed to carry zero actionable signal.

## Oracle validation

- Claims found: 14 numeric, 2 pattern names
- Supported by oracle: 12 · Unsupported: 0 · Inconclusive: 4
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > e_instance_id_service_name_otelcol_contrib_service_version_otelcol`), costing **$3.9/wk** and representing the dominant share of the $4.5/wk total ERROR volume.
- [OK] **$4.5** — env ~5.45GB/day; claim within plausible cost band
    > rsion_otelcol`), costing **$3.9/wk** and representing the dominant share of the $4.5/wk total ERROR volume. This is an OTel Collector self-telemetry pattern — t
- [OK] **$6.3** — env ~5.45GB/day; claim within plausible cost band
    > ble**. The week-over-week trend shows: - Baseline (first quarter of window): ~**$6.3/wk** - Current (last quarter): **$6.2/wk** - Shape: **flat/stable** — no sp
- [OK] **$6.2** — env ~5.45GB/day; claim within plausible cost band
    > - Baseline (first quarter of window): ~**$6.3/wk** - Current (last quarter): **$6.2/wk** - Shape: **flat/stable** — no spike, no acceleration - Peak observed:
- [OK] **$6.2** — env ~5.45GB/day; claim within plausible cost band
    > Low: **13.4 MB** at `2026-05-07 23:00:00 UTC` - Total across 169 data points: **$6.2/wk** There is no acute incident — this is a **chronic, steady-state noise
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > ce_name_otelcol_contrib_service_version_otelcol`** is the #1 ERROR pattern at **$3.9/wk**, representing OTel Collector self-telemetry firing at ERROR severity —
- [OK] **$6.3** — env ~5.45GB/day; claim within plausible cost band
    > ructure noise, not an application error. 2. The trend is **stable** (flat from ~$6.3/wk baseline to $6.2/wk current, 169 data points, no spike or inflection), c
- [OK] **$6.2** — env ~5.45GB/day; claim within plausible cost band
    > n application error. 2. The trend is **stable** (flat from ~$6.3/wk baseline to $6.2/wk current, 169 data points, no spike or inflection), confirming there is n
- [OK] **26.3 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > .2/wk** - Shape: **flat/stable** — no spike, no acceleration - Peak observed: **26.3 MB** at `2026-05-08 13:00:00 UTC`; Low: **13.4 MB** at `2026-05-07 23:00:00
- [OK] **13.4 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > acceleration - Peak observed: **26.3 MB** at `2026-05-08 13:00:00 UTC`; Low: **13.4 MB** at `2026-05-07 23:00:00 UTC` - Total across 169 data points: **$6.2/wk
- [WARN] **-2046946.1%** — percentages are derived; oracle does not gate them
    > radual drift** (no discrete inflection point), with a reported drift slope of **-2046946.1%/week** across 30 days — indicating the pattern has been present and
- [WARN] **+0.4%** — percentages are derived; oracle does not gate them
    > ce_name_payment`, `process_runtime_name_nodejs`, etc.) were found growing at ~**+0.4%/week** similarity. Additionally, `DNS_resolution_failed_upstream_service_s
- [WARN] **+3.9%** — percentages are derived; oracle does not gate them
    > , `DNS_resolution_failed_upstream_service_svc_timeout_after_attempts_resolver` (+3.9%/wk) is co-drifting — suggesting DNS resolution failures in upstream servic
- [WARN] **+3.9%** — percentages are derived; oracle does not gate them
    > esolution_failed_upstream_service_svc_timeout_after_attempts_resolver` pattern (+3.9%/wk) are the closest associated signals, suggesting a deployment or config
- [OK] **service_instance_id_service_name_otelcol_contrib_service_version_otelcol** — 634.8 MB / 24h in metrics
    > es is **`service instance id service name otelcol contrib service version otelcol`** (pattern key: `service_instance_id_service_name_otelcol_contrib_service_version_otelcol`), costing **$3.9/wk** and
- [OK] **process_runtime_name_nodejs** — 7.2 MB / 24h in metrics
    > t (e.g., `timestamp`, `process_pid`, `os_type_linux`, `host_name_payment`, `service_name_payment`, `process_runtime_name_nodejs`, etc.) were found growing at ~**+0.4%/week** similarity. Additionally,

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 31629ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 48060ms, stdout=83B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 40177ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 29122ms, stdout=1406B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=1, 23467ms, stdout=136B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 22071ms, stdout=1885B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 45672ms, stdout=7089B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=0, 15244ms, stdout=587B, stderr=0B
