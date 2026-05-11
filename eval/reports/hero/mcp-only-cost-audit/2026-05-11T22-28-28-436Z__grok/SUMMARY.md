# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PASS
**Env:** demo
**Runner model:** `grok-4-latest` (xai)
**Started:** 2026-05-11T22:28:28.441Z
**Duration:** 394.4s
**Bash calls:** 7

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 12 supported · 1 inconclusive
- **Value delivered:** 0.75 — The agent correctly answered all three parts (top 3 cost patterns, top 3 growth drivers with honest 'no drivers detected' for 7d, top 3 services by volume) with verbatim names and quoted costs, though the growth section inconsistently omitted the 30d data showing 4 real growth drivers that were actually retrieved.
- **Value received:** 0.80 — The MCP returned actionable data for current cost ranking, service volumes, and growth drivers (via 30d window), though the 7d cost_drivers returned no results and the service-scoped cost_drivers call returned no pattern data, creating gaps in the intended week-over-week analysis.
- **Cost (runner only):** $0.1134 — 33925 in / 776 out tokens across 7 API calls

## Sub-agent final synthesis

### Week-over-Week Cost Audit: otel-demo Environment

**Observations**: Using log10x_top_patterns (7d window), the top 3 patterns by current cost are:  
1. "(unknown)" at $4.2/wk  
2. "service instance id service name otelcol contrib service version otelcol $3.9/wk      ERROR" at $3.9/wk  
3. "open telemetry opentelemetry collector contrib exporter opensearchexporter" at $3.8/wk  
Using log10x_cost_drivers (7d window), no growth drivers detected (current 7d vs 3-window baseline of 7d/14d/21d offsets).  
Using log10x_services (7d window), the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Freshness not reported in this tool output.

**What it means**: The environment is stable week-over-week with no significant growth deltas above thresholds. Current costs are dominated by a few high-volume patterns and the "(unknown)" service, which accounts for nearly all volume (35 GB/week total). Tiny services like "email" and "frontend" contribute negligibly.

**What to do**: Investigate the top pattern "(unknown)" via log10x_investigate for potential optimization. Monitor for future growth by re-running log10x_cost_drivers weekly. Consider labeling the "(unknown)" service for better attribution if it's a real workload. No immediate action needed on growth since none detected.

## Oracle validation

- Claims found: 13 numeric, 0 pattern names
- Supported by oracle: 12 · Unsupported: 0 · Inconclusive: 1
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$4.2** — env ~5.45GB/day; claim within plausible cost band
    > tterns (7d window), the top 3 patterns by current cost are: 1. "(unknown)" at $4.2/wk 2. "service instance id service name otelcol contrib service version o
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > 2. "service instance id service name otelcol contrib service version otelcol $3.9/wk ERROR" at $3.9/wk 3. "open telemetry opentelemetry collector cont
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > id service name otelcol contrib service version otelcol $3.9/wk ERROR" at $3.9/wk 3. "open telemetry opentelemetry collector contrib exporter opensearch
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > "open telemetry opentelemetry collector contrib exporter opensearchexporter" at $3.8/wk Using log10x_cost_drivers (7d window), no growth drivers detected (cur
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > services (7d window), the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk).
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Freshness not reported in thi
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Freshness not reported in this tool output. **What it means**: The
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > g log10x_services (7d window), the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > , the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Freshness not report
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), and "frontend" at 17.1 KB ($0.0000/wk). Freshness not reported in this tool output. **What it mea
- [OK] **35 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ume patterns and the "(unknown)" service, which accounts for nearly all volume (35 GB/week total). Tiny services like "email" and "frontend" contribute negligib
- [WARN] **3 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > o Environment **Observations**: Using log10x_top_patterns (7d window), the top 3 patterns by current cost are: 1. "(unknown)" at $4.2/wk 2. "service instan
- [OK] **3 services** — oracle reports 2 services
    > w baseline of 7d/14d/21d offsets). Using log10x_services (7d window), the top 3 services by volume are: "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 38185ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 48137ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 26744ms, stdout=1448B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{"ti...
exit=0, 22493ms, stdout=1009B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 11758ms, stdout=83B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 14305ms, stdout=2010B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=1, 3173ms, stdout=308B, stderr=0B
