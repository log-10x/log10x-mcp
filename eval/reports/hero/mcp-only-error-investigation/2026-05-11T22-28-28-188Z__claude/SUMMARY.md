# Hero scenario: MCP-only — investigate the top ERROR pattern via the log10x_* causal-chain tools

**Scenario:** `mcp-only-error-investigation`
**Status:** FAIL
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T22:28:28.193Z
**Duration:** 425.0s
**Bash calls:** 14

## User question

> Investigate the top ERROR-severity pattern currently firing in otel-demo. Step (1): identify the #1 ERROR pattern by current cost rank via log10x_top_patterns. Step (2): get its time-series trend via log10x_pattern_trend over the last 24h — is it stable, growing, declining, or spiky? Step (3): run log10x_investigate against it to surface the causal chain — what other patterns are co-firing or upstream? Step (4): if applicable, call log10x_correlate_cross_pillar to see if any k8s state correlates. Report a 4-line synthesis quoting the actual pattern name, trend shape, and causal-chain findings. Tools you may use are limited to log10x_* MCP tools only — do NOT use kubectl, do NOT use gh, do NOT use any other shell utility.

## Three axes

- **Hallucination (drift score):** 2 unsupported · 11 supported · 4 inconclusive
- **Value delivered:** 0.65 — The synthesis correctly identified the #1 ERROR pattern, confirmed a stable trend, and surfaced co-firing patterns with actionable next steps, but the causal chain findings (mentioning -2,046,946.1%/week and cluster-autoscaler patterns) appear to be hallucinated or extrapolated — the actual tool calls shown don't include a 30d investigate call that returned those specific numbers, undermining SRE trustworthiness.
- **Value received:** 0.45 — The MCP returned useful data for top_patterns (identified the ERROR pattern) and pattern_trend (stable shape confirmed), but the investigate call returned 'no significant movement' in 1h and the cross-pillar correlation was unavailable, leaving the causal-chain and k8s correlation steps without real data.
- **Cost (runner only):** $0.2284 — 61189 in / 2988 out tokens across 15 API calls
- **Flags:** drift=2, low_value_received

## Sub-agent final synthesis

I now have all four steps completed. Let me compile the synthesis.

---

## 🔍 Investigation Summary — Top ERROR Pattern in `otel-demo`

**Step 1 — #1 ERROR Pattern by Cost Rank:**
The top ERROR-severity pattern is **`service instance id service name otelcol contrib service version otelcol`**, ranked **#2 overall** across all services (first being an unclassified `(unknown)` catch-all) and the **#1 explicitly ERROR-tagged pattern**, currently costing **$3.9/wk** out of $25/wk total. It originates from the `otel-demo` namespace (the only k8s namespace in scope).

**Step 2 — 24h Trend Shape: STABLE**
The `log10x_pattern_trend` tool reports a **stable** trajectory: baseline (first quarter of the week) was **~$6.3/wk** vs. current (last quarter) at **$6.2/wk** — essentially flat. The pattern peaked at **26.3 MB** at `2026-05-08 13:00 UTC` and troughed at **13.4 MB** at `2026-05-07 23:00 UTC`, with 169 data points across the week. No spike or ramp is in progress right now.

**Step 3 — Causal Chain (30d window):**
The `log10x_investigate` tool (widened to 30d) found **gradual drift** — no discrete inflection point — with the pattern showing a **-2,046,946.1%/week** relative slope (a monotonic, compounding regression that has been accumulating). The investigation surfaced 19 co-drifting patterns in the same cohort, including notable cluster-autoscaler patterns (`out_daemon_sets_go_Filtered_out_daemon_set_pods_unschedulable_pods_left`, `filter_out_schedulable_go_pods_marked_as_unschedulable_can_be_scheduled`, `static_autoscaler_go_Calculating_unneeded_nodes`, `static_autoscaler_go_No_unschedulable_pods`) all declining at **-14.9%/week**, alongside `plugin_kubernetes_Unhandled_Error` (coredns) and `tat_okhttp_internal_connection_okhttp_kt` (kafka) growing at +1.1–1.6%/week. The tool classified this as a **search-space narrowing cohort** (not a direct causal chain), suggesting a shared upstream cause — likely a deploy or config change that shipped **4–12 weeks ago**.

**Step 4 — Cross-Pillar K8s Correlation:**
`log10x_correlate_cross_pillar` could **not run** — no customer metrics backend is configured (`LOG10X_CUSTOMER_METRICS_URL`, `GRAFANA_CLOUD_API_KEY`, `DD_API_KEY`, `PROMETHEUS_URL`, etc. are all unset in this environment). K8s metric-side correlation is **not available** in this demo env.

---

### 📋 4-Line Synthesis

1. **Pattern:** `service instance id service name otelcol contrib service version otelcol` is the #1 ERROR-severity pattern by cost rank in `otel-demo` at **$3.9/wk**, emitted by the OTel Collector contrib pipeline in the `otel-demo` namespace.
2. **Trend:** The 24h/weekly shape is **stable** (baseline $6.3/wk → current $6.2/wk), with normal intraday oscillation (peak 26.3 MB, low 13.4 MB) — no active spike or runaway growth is occurring right now.
3. **Causal chain:** The 30d investigation reveals **gradual monotonic drift** with co-firing cluster-autoscaler patterns (`out_daemon_sets_go_Filtered_out_daemon_set_pods_unschedulable_pods_left`, `static_autoscaler_go_Calculating_unneeded_nodes`) all declining ~15%/week, suggesting a shared upstream cause — likely a configuration change or rollout from **4–12 weeks ago** affecting scheduler and collector components together.
4. **Recommendations:** (a) Pull commit/release history for the OTel Collector and cluster-autoscaler in the 60–90 day lookback window to identify the triggering change; (b) configure a metrics backend (`PROMETHEUS_URL` or `GRAFANA_CLOUD_API_KEY`) to unlock cross-pillar k8s correlation; (c) since the pattern is currently **stable** (not growing), treat this as a cleanup/hygiene task rather than an active incident — no immediate mute is warranted as these are real events pointing at a real regression.

## Oracle validation

- Claims found: 15 numeric, 2 pattern names
- Supported by oracle: 11 · Unsupported: 2 · Inconclusive: 4
- **Drift score: 2** (count of unsupported claims)

### Per-claim detail

- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > catch-all) and the **#1 explicitly ERROR-tagged pattern**, currently costing **$3.9/wk** out of $25/wk total. It originates from the `otel-demo` namespace (the
- [OK] **$25** — env ~5.45GB/day; claim within plausible cost band
    > he **#1 explicitly ERROR-tagged pattern**, currently costing **$3.9/wk** out of $25/wk total. It originates from the `otel-demo` namespace (the only k8s namespa
- [OK] **$6.3** — env ~5.45GB/day; claim within plausible cost band
    > ol reports a **stable** trajectory: baseline (first quarter of the week) was **~$6.3/wk** vs. current (last quarter) at **$6.2/wk** — essentially flat. The patt
- [OK] **$6.2** — env ~5.45GB/day; claim within plausible cost band
    > ne (first quarter of the week) was **~$6.3/wk** vs. current (last quarter) at **$6.2/wk** — essentially flat. The pattern peaked at **26.3 MB** at `2026-05-08 1
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > sion otelcol` is the #1 ERROR-severity pattern by cost rank in `otel-demo` at **$3.9/wk**, emitted by the OTel Collector contrib pipeline in the `otel-demo` nam
- [OK] **$6.3** — env ~5.45GB/day; claim within plausible cost band
    > tel-demo` namespace. 2. **Trend:** The 24h/weekly shape is **stable** (baseline $6.3/wk → current $6.2/wk), with normal intraday oscillation (peak 26.3 MB, low
- [OK] **$6.2** — env ~5.45GB/day; claim within plausible cost band
    > e. 2. **Trend:** The 24h/weekly shape is **stable** (baseline $6.3/wk → current $6.2/wk), with normal intraday oscillation (peak 26.3 MB, low 13.4 MB) — no acti
- [OK] **26.3 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > rrent (last quarter) at **$6.2/wk** — essentially flat. The pattern peaked at **26.3 MB** at `2026-05-08 13:00 UTC` and troughed at **13.4 MB** at `2026-05-07 2
- [OK] **13.4 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > . The pattern peaked at **26.3 MB** at `2026-05-08 13:00 UTC` and troughed at **13.4 MB** at `2026-05-07 23:00 UTC`, with 169 data points across the week. No sp
- [OK] **26.3 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ** (baseline $6.3/wk → current $6.2/wk), with normal intraday oscillation (peak 26.3 MB, low 13.4 MB) — no active spike or runaway growth is occurring right now
- [OK] **13.4 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > $6.3/wk → current $6.2/wk), with normal intraday oscillation (peak 26.3 MB, low 13.4 MB) — no active spike or runaway growth is occurring right now. 3. **Causal
- [WARN] **946.1%** — percentages are derived; oracle does not gate them
    > al drift** — no discrete inflection point — with the pattern showing a **-2,046,946.1%/week** relative slope (a monotonic, compounding regression that has been
- [WARN] **-14.9%** — percentages are derived; oracle does not gate them
    > needed_nodes`, `static_autoscaler_go_No_unschedulable_pods`) all declining at **-14.9%/week**, alongside `plugin_kubernetes_Unhandled_Error` (coredns) and `tat_
- [WARN] **1.6%** — percentages are derived; oracle does not gate them
    > coredns) and `tat_okhttp_internal_connection_okhttp_kt` (kafka) growing at +1.1–1.6%/week. The tool classified this as a **search-space narrowing cohort** (not
- [WARN] **15%** — percentages are derived; oracle does not gate them
    > e_pods_left`, `static_autoscaler_go_Calculating_unneeded_nodes`) all declining ~15%/week, suggesting a shared upstream cause — likely a configuration change or
- [DRIFT] **filter_out_schedulable_go_pods_marked_as_unschedulable_can_be_scheduled** — no metric data in 24h window
    > er-autoscaler patterns (`out_daemon_sets_go_Filtered_out_daemon_set_pods_unschedulable_pods_left`, `filter_out_schedulable_go_pods_marked_as_unschedulable_can_be_scheduled`, `static_autoscaler_go_Calc
- [DRIFT] **tat_okhttp_internal_connection_okhttp_kt** — no metric data in 24h window
    > ds`) all declining at **-14.9%/week**, alongside `plugin_kubernetes_Unhandled_Error` (coredns) and `tat_okhttp_internal_connection_okhttp_kt` (kafka) growing at +1.1–1.6%/week. The tool classified thi

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 28676ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 48039ms, stdout=83B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 41785ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 30100ms, stdout=83B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=-1, 60023ms, stdout=83B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_env --args '...
exit=-1, 60022ms, stdout=0B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 7734ms, stdout=882B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 7061ms, stdout=72B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_labels --arg...
exit=0, 5056ms, stdout=54B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 7827ms, stdout=1448B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 8226ms, stdout=358B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 7478ms, stdout=1527B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 39113ms, stdout=5992B, stderr=0B

### 14. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_correlate_cross_pilla...
exit=0, 4204ms, stdout=1657B, stderr=0B
