# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PASS
**Env:** demo
**Runner model:** `grok-4-latest` (xai)
**Started:** 2026-05-11T22:28:28.460Z
**Duration:** 367.0s
**Bash calls:** 5

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 15 supported · 1 inconclusive
- **Value delivered:** 0.95 — The synthesis directly answers all three questions with verbatim pattern/service names and quoted costs, correctly reports 'no drivers detected' for growth, and provides actionable next steps — an SRE could act on this immediately.
- **Value received:** 0.85 — The MCP returned concrete cost figures, ranked patterns, and service volume data; the only gap is that growth drivers returned a truthful negative (no delta threshold crossed), which limits actionability but is honest and data-backed rather than a stub or error.
- **Cost (runner only):** $0.0661 — 18721 in / 660 out tokens across 5 API calls

## Sub-agent final synthesis

### Week-over-Week Cost Audit of otel-demo

**Observations:**  
(1) Top 3 current cost drivers (from log10x_top_patterns, 7d window): "(unknown)" at $4.2/wk, "service instance id service name otelcol contrib service version otelcol" at $3.9/wk (ERROR tag), "open telemetry opentelemetry collector contrib exporter opensearchexporter" at $3.8/wk. Total environment cost $25/wk.  
(2) Top 3 growth drivers (from log10x_cost_drivers, current 7d vs prior 7d/14d/21d baseline): no cost drivers detected; no patterns crossed delta threshold. All 1217 patterns stable.  
(3) Top 3 services by volume (from log10x_services, 7d window): "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Total 35.0 GB ($52/wk at $1.5/GB). Freshness not reported in these tool outputs.  

**Meaning:** The demo environment is stable with no week-over-week growth in costs; dominant volume is unattributed ("(unknown)" service and pattern), suggesting instrumentation gaps. Top patterns indicate collector/exporter overhead drives current costs, but without spikes.  

**Recommendations:** Investigate "(unknown)" via log10x_investigate for attribution; add service labels to otelcol contrib for better breakdowns. Monitor with log10x_cost_drivers weekly; if growth appears, prioritize exporter optimizations for ~$3-4/wk savings potential.

## Oracle validation

- Claims found: 16 numeric, 0 pattern names
- Supported by oracle: 15 · Unsupported: 0 · Inconclusive: 1
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$4.2** — env ~5.45GB/day; claim within plausible cost band
    > op 3 current cost drivers (from log10x_top_patterns, 7d window): "(unknown)" at $4.2/wk, "service instance id service name otelcol contrib service version otelc
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > , "service instance id service name otelcol contrib service version otelcol" at $3.9/wk (ERROR tag), "open telemetry opentelemetry collector contrib exporter op
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > "open telemetry opentelemetry collector contrib exporter opensearchexporter" at $3.8/wk. Total environment cost $25/wk. (2) Top 3 growth drivers (from log10x_
- [OK] **$25** — env ~5.45GB/day; claim within plausible cost band
    > llector contrib exporter opensearchexporter" at $3.8/wk. Total environment cost $25/wk. (2) Top 3 growth drivers (from log10x_cost_drivers, current 7d vs prio
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > 3 services by volume (from log10x_services, 7d window): "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Tota
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > g10x_services, 7d window): "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Total 35.0 GB ($52/wk at $1.5/GB)
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > wn)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Total 35.0 GB ($52/wk at $1.5/GB). Freshness not reported in these
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > mail" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Total 35.0 GB ($52/wk at $1.5/GB). Freshness not reported in these tool outputs. **Meaning:*
- [OK] **$1.5** — env ~5.45GB/day; claim within plausible cost band
    > 1.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Total 35.0 GB ($52/wk at $1.5/GB). Freshness not reported in these tool outputs. **Meaning:** The demo
- [OK] **$3** — env ~5.45GB/day; claim within plausible cost band
    > _cost_drivers weekly; if growth appears, prioritize exporter optimizations for ~$3-4/wk savings potential.
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > (3) Top 3 services by volume (from log10x_services, 7d window): "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > (from log10x_services, 7d window): "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Total 35.0 GB ($52/wk at
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > : "(unknown)" at 35.0 GB ($52/wk), "email" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Total 35.0 GB ($52/wk at $1.5/GB). Freshness not reported
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > 2/wk), "email" at 11.8 MB ($0.02/wk), "frontend" at 17.1 KB ($0.0000/wk). Total 35.0 GB ($52/wk at $1.5/GB). Freshness not reported in these tool outputs. **
- [WARN] **1217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > d baseline): no cost drivers detected; no patterns crossed delta threshold. All 1217 patterns stable. (3) Top 3 services by volume (from log10x_services, 7d w
- [OK] **3 services** — oracle reports 2 services
    > ected; no patterns crossed delta threshold. All 1217 patterns stable. (3) Top 3 services by volume (from log10x_services, 7d window): "(unknown)" at 35.0 GB (

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 35645ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 46810ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 25122ms, stdout=1448B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 19521ms, stdout=1279B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{"ti...
exit=0, 12257ms, stdout=1009B, stderr=0B
