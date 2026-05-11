# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PASS
**Env:** demo
**Runner model:** `grok-4-latest` (xai)
**Started:** 2026-05-11T22:28:28.276Z
**Duration:** 392.9s
**Bash calls:** 7

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 12 supported · 2 inconclusive
- **Value delivered:** 0.85 — The synthesis directly answered all three questions verbatim from tool output: top 3 cost drivers by rank with exact dollar figures, honest reporting of no growth drivers detected, and top 3 services by volume with exact numbers — fully actionable for an SRE.
- **Value received:** 0.75 — The MCP returned solid current-rank data from log10x_top_patterns and service volume from log10x_services, but log10x_cost_drivers returned no growth data and the per-service breakdown for '(unknown)' returned no pattern data, leaving gaps in the growth driver analysis.
- **Cost (runner only):** $0.1213 — 36510 in / 787 out tokens across 8 API calls

## Sub-agent final synthesis

### Week-Over-Week Cost Audit for otel-demo Environment

**Observations:**  
The log10x_cost_drivers tool reported no cost drivers detected (this week) for growth, based on current 7d vs 3-window avg baseline (offsets: 7d/14d/21d). All 1217 patterns are within normal range.  
From log10x_top_patterns (7d window), the top 3 patterns by current cost rank are: "(unknown)" at $4.2/wk, "service instance id service name otelcol contrib service version otelcol" at $3.9/wk, and "open telemetry opentelemetry collector contrib exporter opensearchexporter" at $3.8/wk.  
From log10x_services (this week), the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Total volume: 35.0 GB at $52/wk. Freshness not reported in these tool outputs.  

**Meaning:**  
Costs are stable with no significant week-over-week growth drivers, indicating a consistent logging pattern without spikes. The bulk of volume and cost stems from an unlabeled "(unknown)" service and OpenTelemetry collector-related patterns, which dominate the current rankings but show no delta changes.  

**Recommendations:**  
Prioritize labeling the "(unknown)" service for better attribution. Review and optimize top patterns (e.g., via sampling in the OpenTelemetry collector exporter) to potentially reduce costs without loss of observability. Run log10x_savings for ROI insights and monitor with log10x_cost_drivers weekly for any emerging deltas.

## Oracle validation

- Claims found: 14 numeric, 0 pattern names
- Supported by oracle: 12 · Unsupported: 0 · Inconclusive: 2
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$4.2** — env ~5.45GB/day; claim within plausible cost band
    > tterns (7d window), the top 3 patterns by current cost rank are: "(unknown)" at $4.2/wk, "service instance id service name otelcol contrib service version otelc
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > , "service instance id service name otelcol contrib service version otelcol" at $3.9/wk, and "open telemetry opentelemetry collector contrib exporter opensearch
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > "open telemetry opentelemetry collector contrib exporter opensearchexporter" at $3.8/wk. From log10x_services (this week), the top 3 services by volume are: "
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > services (this week), the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk).
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Total volume: 35.0 GB at $52/
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Total volume: 35.0 GB at $52/wk. Freshness not reported in these to
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Total volume: 35.0 GB at $52/wk. Freshness not reported in these tool outputs. **Meaning:** Costs ar
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > m log10x_services (this week), the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > , the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Total volume: 35.0 G
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Total volume: 35.0 GB at $52/wk. Freshness not reported in
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > l" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Total volume: 35.0 GB at $52/wk. Freshness not reported in these tool outputs. **Meaning:**
- [WARN] **1217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > growth, based on current 7d vs 3-window avg baseline (offsets: 7d/14d/21d). All 1217 patterns are within normal range. From log10x_top_patterns (7d window), t
- [WARN] **3 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > tterns are within normal range. From log10x_top_patterns (7d window), the top 3 patterns by current cost rank are: "(unknown)" at $4.2/wk, "service instance i
- [OK] **3 services** — oracle reports 2 services
    > ter opensearchexporter" at $3.8/wk. From log10x_services (this week), the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 45749ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 41055ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 26728ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 16452ms, stdout=1448B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 7383ms, stdout=83B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 7655ms, stdout=83B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=1, 4909ms, stdout=136B, stderr=0B
