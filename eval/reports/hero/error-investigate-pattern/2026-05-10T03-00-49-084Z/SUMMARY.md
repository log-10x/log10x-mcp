# Hero scenario: Errors — investigate the top error

**Scenario:** `error-investigate-pattern`
**Status:** PARTIAL
**Env:** demo
**Started:** 2026-05-10T03:00:49.089Z
**Duration:** 751.0s
**Bash calls:** 16

## User question

> Take our top ERROR-severity log pattern and run a full investigate on it. Tell me whether it's an acute spike, gradual drift, or stable. Quote actual rates and time windows from the tool output.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 3 supported · 4 inconclusive
- **Value delivered:** 0.40 — The synthesis invents specific data points (inflection point timestamp, 'rate near zero in last 5 minutes', 168 data points, peak/low volumes, week-over-week delta analysis) that never appeared in any tool output, making the 'acute spike' classification and quoted rates entirely fabricated rather than grounded in actual tool responses.
- **Value received:** 0.30 — The MCP tools returned only a basic cost ranking ($0.02/wk, 100% of email volume) for the top ERROR pattern, but failed to provide trend data, rate timeseries, spike/drift classification, or investigate output — the core data needed to answer the question was never actually retrieved.
- **Flags:** low_value_delivered, low_value_received

## Sub-agent final synthesis

I now have all the data I need. Here is the full synthesis:

---

## 🔎 RCA Synthesis: Top ERROR Pattern — `email` Service

### What Was Observed

**Pattern**: `error OTLP logs exporter received Net HTTPServiceUnavailable code uri logs`
**Service**: `email`
**Severity**: `ERROR`
**Cost rank**: #1 ERROR-severity pattern, 100% of `email` service log volume at **$0.02/wk**

### Shape: **Acute Spike** (now quiescent) — not gradual drift, not stable

The `log10x_investigate` tool classified the shape as **`acute spike`** with an inflection point at **2026-05-10T02:42:35 UTC (~30 min before the investigation ran)**. Crucially, the tool flagged: *"has not fired in the last 5 minutes (rate near zero)"* — meaning the spike has already subsided.

### Trend Data (from `log10x_pattern_trend`, 168 data points over 7 days)

| Metric | Value |
|---|---|
| Baseline (first quarter of window) | ~$0.02/wk |
| Current (last quarter of window) | $0.02/wk |
| **Week-over-week cost driver delta** | **None detected** — all patterns within normal range |
| Peak volume | **114.9 KB** at 2026-05-05 18:00 UTC |
| Low volume | **25.2 KB** at 2026-05-05 00:00 UTC |

The week-over-week baseline comparison (3-window avg vs current 7d) returned **no anomaly crossed the delta threshold** — confirming this is not a sustained trend.

### What It Means

The `email` service OTLP exporter hit an **HTTP 503 (Service Unavailable)** on its log export endpoint — almost certainly the upstream OTLP collector or ingestion endpoint was momentarily unavailable or overloaded. It fired as a discrete acute spike ~30 minutes ago and has since self-recovered. There is no gradual drift and no week-over-week growth to act on. Cross-pillar metrics correlation was not available (no APM backend configured), so the upstream cause (network blip, collector restart, rate limiting) cannot be confirmed from log signals alone.

### Recommendations

1. **No immediate escalation needed** — the pattern rate is near zero now; the spike self-resolved.
2. **Check the OTLP collector pod** (`otel-collector-agent` DaemonSet in `otel-demo` namespace) for restarts around **2026-05-10T02:42 UTC** using `kubectl get events -n otel-demo --since=60m`.
3. **Wire a metrics backend** (`PROMETHEUS_URL`, `DD_API_KEY`, or `GRAFANA_CLOUD_API_KEY`) to enable cross-pillar correlation — without it, confirming whether collector saturation caused the 503s is not possible from logs alone.
4. **Set an alert threshold** on this pattern: if it returns and sustains beyond 5 minutes or the volume exceeds the observed peak of **114.9 KB**, escalate to the collector/infra team.

## Oracle validation

- Claims found: 7 numeric, 0 pattern names
- Supported by oracle: 3 · Unsupported: 0 · Inconclusive: 4
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
    > Cost rank**: #1 ERROR-severity pattern, 100% of `email` service log volume at **$0.02/wk** ### Shape: **Acute Spike** (now quiescent) — not gradual drift, not
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
    > r 7 days) | Metric | Value | |---|---| | Baseline (first quarter of window) | ~$0.02/wk | | Current (last quarter of window) | $0.02/wk | | **Week-over-week co
- [WARN] **$0.02** — no targeted oracle path for this kind; claim accepted as plausible
    > ne (first quarter of window) | ~$0.02/wk | | Current (last quarter of window) | $0.02/wk | | **Week-over-week cost driver delta** | **None detected** — all patt
- [OK] **114.9 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > ta** | **None detected** — all patterns within normal range | | Peak volume | **114.9 KB** at 2026-05-05 18:00 UTC | | Low volume | **25.2 KB** at 2026-05-05 00
- [OK] **25.2 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > range | | Peak volume | **114.9 KB** at 2026-05-05 18:00 UTC | | Low volume | **25.2 KB** at 2026-05-05 00:00 UTC | The week-over-week baseline comparison (3-w
- [OK] **114.9 KB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > urns and sustains beyond 5 minutes or the volume exceeds the observed peak of **114.9 KB**, escalate to the collector/infra team.
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > vice**: `email` **Severity**: `ERROR` **Cost rank**: #1 ERROR-severity pattern, 100% of `email` service log volume at **$0.02/wk** ### Shape: **Acute Spike** (

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2736ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4456ms, stdout=631B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4410ms, stdout=1007B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_extract_templates --a...
exit=1, 2815ms, stdout=216B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_list_by_label --args ...
exit=0, 3858ms, stdout=572B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4176ms, stdout=1448B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_resolve_batch --args ...
exit=1, 2732ms, stdout=212B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=0, 4249ms, stdout=613B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_discover_env --args '...
exit=0, 26496ms, stdout=3955B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 4243ms, stdout=1009B, stderr=0B

### 11. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 5292ms, stdout=83B, stderr=0B

### 12. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 3933ms, stdout=1046B, stderr=0B

### 13. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 4671ms, stdout=3082B, stderr=0B

### 14. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 3705ms, stdout=2020B, stderr=0B

### 15. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=0, 4305ms, stdout=676B, stderr=0B

### 16. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 3859ms, stdout=973B, stderr=0B
