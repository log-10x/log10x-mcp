# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T22:28:28.055Z
**Duration:** 238.3s
**Bash calls:** 5

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 17 supported · 4 inconclusive
- **Value delivered:** 0.95 — The sub-agent answered all three questions verbatim from tool output, correctly reported the truthful negative for growth drivers rather than fabricating data, and provided actionable next steps including attribution fix and exclusion filter recommendations.
- **Value received:** 0.75 — The MCP returned solid current-rank and service volume data, but the cost_drivers tool returned 'no drivers detected' for both the global and per-service call (the latter timed out with no data), leaving the growth-driver question unanswerable beyond a truthful negative.
- **Cost (runner only):** $0.0538 — 10769 in / 1432 out tokens across 4 API calls

## Sub-agent final synthesis

I now have all the data I need from tool stdout. Here is the complete, verbatim-grounded week-over-week cost audit:

---

## otel-demo Cost Audit — 7-Day Window

### (1) Top 3 Current Cost-Rank Patterns

Sourced from `log10x_top_patterns` (7d, all services). These are ranked by current spend, **not** growth:

| Rank | Pattern (verbatim) | Cost |
|------|--------------------|------|
| #1 | `(unknown)` | **$4.2/wk** |
| #2 | `service instance id service name otelcol contrib service version otelcol` | **$3.9/wk** (ERROR severity) |
| #3 | `open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** |

---

### (2) Top 3 Week-over-Week Growth Drivers

`log10x_cost_drivers` (7d window, current vs. 3-window avg baseline at offsets 7d/14d/21d) returned:

> **"no cost drivers detected (this week)"** — All 1,217 patterns are within normal range. No pattern crossed the delta threshold.

This is a truthful negative result. **There are no growth drivers to report.** The environment is stable week-over-week.

---

### (3) Top 3 Services by Volume

Sourced from `log10x_services` (this week, 4 services total, $52/wk at $1.5/GB):

| Rank | Service (verbatim) | Volume | Cost |
|------|--------------------|--------|------|
| #1 | `(unknown)` | **35.0 GB** | **$52/wk** |
| #2 | `email` | **11.8 MB** | **$0.02/wk** |
| #3 | `frontend` | **17.1 KB** | **$0.0000/wk** |

The `(unknown)` service alone represents **100%** of the weekly cost at $52/wk.

---

### Synthesis & Recommendations

1. **Dominant cost is unattributed.** The `(unknown)` service accounts for 35.0 GB / $52/wk — virtually all spend. The root cause is that the OTel collector (`otelcol-contrib`) pipelines are not emitting a `service.name` resource attribute, causing logs to fall into the `(unknown)` bucket. **Fix: add a `resource/set-service-name` processor in the collector config** to tag logs before export.

2. **No growth emergency.** All 1,217 patterns are stable vs. the 3-week rolling baseline — no week-over-week acceleration to act on urgently. Budget is predictable at current levels.

3. **Top named patterns are collector internals.** Patterns like `open telemetry opentelemetry collector contrib exporter opensearchexporter` ($3.8/wk) and `opentelemetry io collector processor batchprocessor v batch processor go` ($3.7/wk) are collector self-telemetry (debug/internal logs). Consider applying an `log10x_exclusion_filter` on collector-internal log levels (DEBUG/TRACE) to reduce noise volume at low risk.

## Oracle validation

- Claims found: 21 numeric, 0 pattern names
- Supported by oracle: 17 · Unsupported: 0 · Inconclusive: 4
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$4.2** — env ~5.45GB/day; claim within plausible cost band
    > (verbatim) | Cost | |------|--------------------|------| | #1 | `(unknown)` | **$4.2/wk** | | #2 | `service instance id service name otelcol contrib service ver
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > `service instance id service name otelcol contrib service version otelcol` | **$3.9/wk** (ERROR severity) | | #3 | `open telemetry opentelemetry collector cont
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** | --- ### (2) Top 3 Week-over-Week Growth Drivers `log10x_cost_driv
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > ervices by Volume Sourced from `log10x_services` (this week, 4 services total, $52/wk at $1.5/GB): | Rank | Service (verbatim) | Volume | Cost | |------|-----
- [OK] **$1.5** — env ~5.45GB/day; claim within plausible cost band
    > Volume Sourced from `log10x_services` (this week, 4 services total, $52/wk at $1.5/GB): | Rank | Service (verbatim) | Volume | Cost | |------|---------------
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > ----|--------------------|--------|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **1
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | The `(unknown)`
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | The `(unknown)` service alone represents **100%** of the weekly
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > wk** | The `(unknown)` service alone represents **100%** of the weekly cost at $52/wk. --- ### Synthesis & Recommendations 1. **Dominant cost is unattribute
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > Dominant cost is unattributed.** The `(unknown)` service accounts for 35.0 GB / $52/wk — virtually all spend. The root cause is that the OTel collector (`otelco
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > e `open telemetry opentelemetry collector contrib exporter opensearchexporter` ($3.8/wk) and `opentelemetry io collector processor batchprocessor v batch proces
- [OK] **$3.7** — env ~5.45GB/day; claim within plausible cost band
    > and `opentelemetry io collector processor batchprocessor v batch processor go` ($3.7/wk) are collector self-telemetry (debug/internal logs). Consider applying a
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > e | Cost | |------|--------------------|--------|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `f
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ----|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | T
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > *$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | The `(unknown)` service alone represents **100%**
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ons 1. **Dominant cost is unattributed.** The `(unknown)` service accounts for 35.0 GB / $52/wk — virtually all spend. The root cause is that the OTel collecto
- [WARN] **217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > ets 7d/14d/21d) returned: > **"no cost drivers detected (this week)"** — All 1,217 patterns are within normal range. No pattern crossed the delta threshold. T
- [WARN] **3 Services** — no targeted oracle path for this kind; claim accepted as plausible
    > rivers to report.** The environment is stable week-over-week. --- ### (3) Top 3 Services by Volume Sourced from `log10x_services` (this week, 4 services tota
- [OK] **4 services** — oracle reports 2 services
    > - ### (3) Top 3 Services by Volume Sourced from `log10x_services` (this week, 4 services total, $52/wk at $1.5/GB): | Rank | Service (verbatim) | Volume | Co
- [WARN] **217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > ollector config** to tag logs before export. 2. **No growth emergency.** All 1,217 patterns are stable vs. the 3-week rolling baseline — no week-over-week acce
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > d` | **17.1 KB** | **$0.0000/wk** | The `(unknown)` service alone represents **100%** of the weekly cost at $52/wk. --- ### Synthesis & Recommendations 1. *

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 32445ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 55254ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 38558ms, stdout=1009B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=-1, 60190ms, stdout=83B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 18637ms, stdout=1448B, stderr=0B
