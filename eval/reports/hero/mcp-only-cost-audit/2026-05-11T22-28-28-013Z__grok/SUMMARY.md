# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PASS
**Env:** demo
**Runner model:** `grok-4-latest` (xai)
**Started:** 2026-05-11T22:28:28.019Z
**Duration:** 348.2s
**Bash calls:** 6

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 12 supported · 1 inconclusive
- **Value delivered:** 0.85 — The synthesis accurately answers all three parts of the question with verbatim names and quoted costs: top 3 current cost patterns from log10x_cost_drivers, an honest 'no drivers detected' for growth, and top 3 services by volume—all directly actionable for an SRE, though the agent mislabeled log10x_cost_drivers output as 'top 3 current cost drivers' when log10x_top_patterns was actually the more authoritative source for current rank.
- **Value received:** 0.75 — The MCP returned real, usable data for current cost patterns, service volumes, and an honest negative for growth drivers, but log10x_cost_drivers for the '(unknown)' service returned 'no pattern data available' which left a gap in per-service drill-down analysis.
- **Cost (runner only):** $0.0801 — 23257 in / 690 out tokens across 5 API calls

## Sub-agent final synthesis

In the otel-demo environment, log10x_cost_drivers reported no cost drivers detected (this week) for growth, based on current 7d vs 3-window avg baseline (offsets: 7d/14d/21d), with all 1217 patterns within normal range.

Top 3 current cost drivers per log10x_cost_drivers: "open telemetry opentelemetry collector contrib exporter opensearchexporter" $3.8/wk, "opentelemetry io collector processor batchprocessor v batch processor go" $3.7/wk, "go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLogs" $1.8/wk.

Top 3 growth drivers: no cost drivers detected (this week), as returned by log10x_cost_drivers.

Top 3 services by volume per log10x_services: "(unknown)" 35.0 GB $52/wk, "email" 11.8 MB $0.02/wk, "frontend" 17.1 KB $0.0000/wk.

These observations indicate a stable, low-volume environment (~35 GB total this week) dominated by OTEL collector logs in an unattributed service, with no significant week-over-week cost increases.

This means costs are predictable at $52/wk total, but lack of service attribution hinders targeted optimization.

Recommendations: Run log10x_investigate on "open telemetry opentelemetry collector contrib exporter opensearchexporter" to analyze root causes; add service labels to reduce "(unknown)" volume; re-run log10x_cost_drivers in 7d for ongoing monitoring.

## Oracle validation

- Claims found: 13 numeric, 0 pattern names
- Supported by oracle: 12 · Unsupported: 0 · Inconclusive: 1
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > s: "open telemetry opentelemetry collector contrib exporter opensearchexporter" $3.8/wk, "opentelemetry io collector processor batchprocessor v batch processor
- [OK] **$3.7** — env ~5.45GB/day; claim within plausible cost band
    > /wk, "opentelemetry io collector processor batchprocessor v batch processor go" $3.7/wk, "go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLogs" $1
- [OK] **$1.8** — env ~5.45GB/day; claim within plausible cost band
    > " $3.7/wk, "go opentelemetry io collector consumer ConsumeLogsFunc ConsumeLogs" $1.8/wk. Top 3 growth drivers: no cost drivers detected (this week), as returne
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > ost_drivers. Top 3 services by volume per log10x_services: "(unknown)" 35.0 GB $52/wk, "email" 11.8 MB $0.02/wk, "frontend" 17.1 KB $0.0000/wk. These observat
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > ices by volume per log10x_services: "(unknown)" 35.0 GB $52/wk, "email" 11.8 MB $0.02/wk, "frontend" 17.1 KB $0.0000/wk. These observations indicate a stable,
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > vices: "(unknown)" 35.0 GB $52/wk, "email" 11.8 MB $0.02/wk, "frontend" 17.1 KB $0.0000/wk. These observations indicate a stable, low-volume environment (~35 G
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > significant week-over-week cost increases. This means costs are predictable at $52/wk total, but lack of service attribution hinders targeted optimization. Re
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > log10x_cost_drivers. Top 3 services by volume per log10x_services: "(unknown)" 35.0 GB $52/wk, "email" 11.8 MB $0.02/wk, "frontend" 17.1 KB $0.0000/wk. These
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > p 3 services by volume per log10x_services: "(unknown)" 35.0 GB $52/wk, "email" 11.8 MB $0.02/wk, "frontend" 17.1 KB $0.0000/wk. These observations indicate a
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > g10x_services: "(unknown)" 35.0 GB $52/wk, "email" 11.8 MB $0.02/wk, "frontend" 17.1 KB $0.0000/wk. These observations indicate a stable, low-volume environmen
- [OK] **35 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > KB $0.0000/wk. These observations indicate a stable, low-volume environment (~35 GB total this week) dominated by OTEL collector logs in an unattributed servi
- [WARN] **1217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > h, based on current 7d vs 3-window avg baseline (offsets: 7d/14d/21d), with all 1217 patterns within normal range. Top 3 current cost drivers per log10x_cost_d
- [OK] **3 services** — oracle reports 2 services
    > no cost drivers detected (this week), as returned by log10x_cost_drivers. Top 3 services by volume per log10x_services: "(unknown)" 35.0 GB $52/wk, "email" 11

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 44301ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 37344ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 26985ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 25338ms, stdout=1448B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 9719ms, stdout=83B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 7556ms, stdout=359B, stderr=0B
