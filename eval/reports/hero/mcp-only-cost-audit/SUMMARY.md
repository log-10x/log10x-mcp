# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PASS
**Env:** demo
**Runner model:** `grok-4-latest` (xai)
**Started:** 2026-05-11T22:28:28.477Z
**Duration:** 518.6s
**Bash calls:** 7

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 12 supported · 0 inconclusive
- **Value delivered:** 0.85 — The synthesis accurately answered all three questions verbatim from tool output: top 3 current cost patterns with quoted costs, honest 'no drivers detected' for 7d growth (correctly not inventing numbers), and top 3 services by volume — all directly actionable for an SRE, though the agent missed surfacing the 30d cost drivers data it retrieved in call 6 as supplementary context for the growth question.
- **Value received:** 0.80 — The MCP returned substantive, usable data for current patterns (log10x_top_patterns), services by volume (log10x_services), and even growth drivers on a 30d window (log10x_cost_drivers with timeRange:30d), though the 7d cost drivers returned a truthful negative and log10x_savings timed out with no output.
- **Cost (runner only):** $0.1209 — 36684 in / 724 out tokens across 7 API calls

## Sub-agent final synthesis

In the otel-demo environment over a 7-day window, log10x_cost_drivers reported no cost drivers detected, indicating stable costs with no patterns crossing the delta threshold versus the baseline (average of prior 7d/14d/21d windows).

Top 3 current cost patterns (from log10x_top_patterns, current rank by cost): (1) (unknown) $4.2/wk, (2) service instance id service name otelcol contrib service version otelcol $3.9/wk ERROR, (3) open telemetry opentelemetry collector contrib exporter opensearchexporter $3.8/wk.

Top 3 growth drivers (week-over-week deltas from log10x_cost_drivers): no growth drivers detected.

Top 3 services by volume (from log10x_services): (1) (unknown) 35.0 GB $52/wk, (2) email 11.8 MB $0.02/wk, (3) frontend 17.1 KB $0.0000/wk.

This means the environment's ~35 GB weekly volume ($52/wk total) is dominated by an unidentified "(unknown)" service and OTel collector-related logging patterns, with no recent growth spikes.

Recommendations: Drill into the "(unknown)" service and top patterns using log10x_investigate for potential optimizations; consider exclusion filters on verbose collector logs if they lack value; monitor for any emerging deltas in future weeks.

## Oracle validation

- Claims found: 12 numeric, 0 pattern names
- Supported by oracle: 12 · Unsupported: 0 · Inconclusive: 0
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$4.2** — env ~5.45GB/day; claim within plausible cost band
    > t cost patterns (from log10x_top_patterns, current rank by cost): (1) (unknown) $4.2/wk, (2) service instance id service name otelcol contrib service version ot
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > k, (2) service instance id service name otelcol contrib service version otelcol $3.9/wk ERROR, (3) open telemetry opentelemetry collector contrib exporter opens
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > (3) open telemetry opentelemetry collector contrib exporter opensearchexporter $3.8/wk. Top 3 growth drivers (week-over-week deltas from log10x_cost_drivers):
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > tected. Top 3 services by volume (from log10x_services): (1) (unknown) 35.0 GB $52/wk, (2) email 11.8 MB $0.02/wk, (3) frontend 17.1 KB $0.0000/wk. This means
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > volume (from log10x_services): (1) (unknown) 35.0 GB $52/wk, (2) email 11.8 MB $0.02/wk, (3) frontend 17.1 KB $0.0000/wk. This means the environment's ~35 GB
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > (1) (unknown) 35.0 GB $52/wk, (2) email 11.8 MB $0.02/wk, (3) frontend 17.1 KB $0.0000/wk. This means the environment's ~35 GB weekly volume ($52/wk total) is
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > rontend 17.1 KB $0.0000/wk. This means the environment's ~35 GB weekly volume ($52/wk total) is dominated by an unidentified "(unknown)" service and OTel colle
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ivers detected. Top 3 services by volume (from log10x_services): (1) (unknown) 35.0 GB $52/wk, (2) email 11.8 MB $0.02/wk, (3) frontend 17.1 KB $0.0000/wk. Th
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > vices by volume (from log10x_services): (1) (unknown) 35.0 GB $52/wk, (2) email 11.8 MB $0.02/wk, (3) frontend 17.1 KB $0.0000/wk. This means the environment's
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > rvices): (1) (unknown) 35.0 GB $52/wk, (2) email 11.8 MB $0.02/wk, (3) frontend 17.1 KB $0.0000/wk. This means the environment's ~35 GB weekly volume ($52/wk t
- [OK] **35 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > .8 MB $0.02/wk, (3) frontend 17.1 KB $0.0000/wk. This means the environment's ~35 GB weekly volume ($52/wk total) is dominated by an unidentified "(unknown)" s
- [OK] **3 services** — oracle reports 2 services
    > ek-over-week deltas from log10x_cost_drivers): no growth drivers detected. Top 3 services by volume (from log10x_services): (1) (unknown) 35.0 GB $52/wk, (2) e

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 30184ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 50662ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{"ti...
exit=0, 25007ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 19381ms, stdout=1448B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 19272ms, stdout=1279B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 13990ms, stdout=2010B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_savings --args '{"tim...
exit=-1, 60026ms, stdout=0B, stderr=0B
