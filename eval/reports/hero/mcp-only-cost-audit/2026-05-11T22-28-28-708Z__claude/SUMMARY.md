# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T22:28:28.715Z
**Duration:** 180.2s
**Bash calls:** 4

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 17 supported · 8 inconclusive
- **Value delivered:** 0.95 — The synthesis directly and accurately answers all three user questions with verbatim pattern/service names and quoted costs, correctly reports the negative growth-driver result honestly rather than inventing data, and adds actionable recommendations an SRE can act on immediately.
- **Value received:** 0.80 — The MCP returned concrete, usable cost and volume data for current rankings and services, but the growth-driver query returned a truthful negative (no drivers detected), leaving one of the three requested answers empty—though this reflects real environment state rather than a tool failure.
- **Cost (runner only):** $0.0404 — 7416 in / 1209 out tokens across 3 API calls

## Sub-agent final synthesis

I have all three answers from tool stdout. Let me compile the final synthesis:

---

## Week-over-Week Cost Audit — `otel-demo` Environment

---

### (1) Top 3 Cost Drivers — Current Rank (by cost, this week)
Source: `log10x_top_patterns` · total environment: **$25/wk**

| Rank | Pattern (verbatim) | Cost |
|------|--------------------|------|
| #1 | `(unknown)` | **$4.2/wk** |
| #2 | `service instance id service name otelcol contrib service version otelcol` (log level: ERROR) | **$3.9/wk** |
| #3 | `open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** |

---

### (2) Top 3 Week-over-Week Growth Drivers
Source: `log10x_cost_drivers` · window: 7d vs. 3-window rolling average (offsets: 7d/14d/21d)

> **"no cost drivers detected (this week)"** — All 1,217 patterns are within normal range. No pattern crossed the delta threshold. This is a truthful negative result, not a tool failure.

**Growth drivers: none to report.** The environment is stable week-over-week.

---

### (3) Top 3 Services by Volume
Source: `log10x_services`

| Rank | Service (verbatim) | Volume | Cost |
|------|--------------------|--------|------|
| #1 | `(unknown)` | **35.0 GB** | **$52/wk** |
| #2 | `email` | **11.8 MB** | **$0.02/wk** |
| #3 | `frontend` | **17.1 KB** | **$0.0000/wk** |

Total: 4 services · 35.0 GB · $52/wk at $1.5/GB. Top 3 = 100% of volume.

---

### Recommendations

1. **Service attribution gap is the #1 problem.** The `(unknown)` service accounts for 35.0 GB / $52/wk — effectively 100% of volume — meaning telemetry is flowing without proper `service.name` labels. Fix OTel resource attribution first; until then, cost governance is blind.
2. **Investigate ERROR-level pattern.** The `service instance id service name otelcol contrib service version otelcol` (ERROR) pattern at $3.9/wk is the second-ranked cost item and an ERROR log level — likely noisy failures worth triaging via `log10x_investigate`.
3. **No growth emergency today.** `log10x_cost_drivers` found zero week-over-week movers across all 1,217 patterns — the spend profile is flat, so there is no urgent spike to chase right now.
4. **Long tail is significant.** The top 10 patterns cover only 48% of volume; 52% is in the tail — consider running `log10x_exclusion_filter` or `log10x_savings` to identify compression opportunities in the unattributed `(unknown)` service.

## Oracle validation

- Claims found: 25 numeric, 0 pattern names
- Supported by oracle: 17 · Unsupported: 0 · Inconclusive: 8
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$25** — env ~5.46GB/day; claim within plausible cost band
    > Rank (by cost, this week) Source: `log10x_top_patterns` · total environment: **$25/wk** | Rank | Pattern (verbatim) | Cost | |------|--------------------|----
- [OK] **$4.2** — env ~5.46GB/day; claim within plausible cost band
    > (verbatim) | Cost | |------|--------------------|------| | #1 | `(unknown)` | **$4.2/wk** | | #2 | `service instance id service name otelcol contrib service ver
- [OK] **$3.9** — env ~5.46GB/day; claim within plausible cost band
    > id service name otelcol contrib service version otelcol` (log level: ERROR) | **$3.9/wk** | | #3 | `open telemetry opentelemetry collector contrib exporter open
- [OK] **$3.8** — env ~5.46GB/day; claim within plausible cost band
    > open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** | --- ### (2) Top 3 Week-over-Week Growth Drivers Source: `log10x_co
- [OK] **$52** — env ~5.46GB/day; claim within plausible cost band
    > ----|--------------------|--------|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **1
- [OK] **$0.02** — env ~5.46GB/day; claim within plausible cost band
    > #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 servic
- [OK] **$0.0000** — env ~5.46GB/day; claim within plausible cost band
    > #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services · 35.0 GB · $52/wk at $1.5/GB. Top 3 = 100% of
- [OK] **$52** — env ~5.46GB/day; claim within plausible cost band
    > #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services · 35.0 GB · $52/wk at $1.5/GB. Top 3 = 100% of volume. --- ### Recommendations 1. **Servi
- [OK] **$1.5** — env ~5.46GB/day; claim within plausible cost band
    > tend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services · 35.0 GB · $52/wk at $1.5/GB. Top 3 = 100% of volume. --- ### Recommendations 1. **Service attribu
- [OK] **$52** — env ~5.46GB/day; claim within plausible cost band
    > ibution gap is the #1 problem.** The `(unknown)` service accounts for 35.0 GB / $52/wk — effectively 100% of volume — meaning telemetry is flowing without prope
- [OK] **$3.9** — env ~5.46GB/day; claim within plausible cost band
    > nce id service name otelcol contrib service version otelcol` (ERROR) pattern at $3.9/wk is the second-ranked cost item and an ERROR log level — likely noisy fai
- [OK] **35.0 GB** — env total ~5.46GB/24h; claim within plausible subset/total range
    > e | Cost | |------|--------------------|--------|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `f
- [OK] **11.8 MB** — env total ~5.46GB/24h; claim within plausible subset/total range
    > ----|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | T
- [OK] **17.1 KB** — env total ~5.46GB/24h; claim within plausible subset/total range
    > *$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services · 35.0 GB · $52/wk at $1.5/GB. T
- [OK] **35.0 GB** — env total ~5.46GB/24h; claim within plausible subset/total range
    > /wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services · 35.0 GB · $52/wk at $1.5/GB. Top 3 = 100% of volume. --- ### Recommendations
- [OK] **35.0 GB** — env total ~5.46GB/24h; claim within plausible subset/total range
    > rvice attribution gap is the #1 problem.** The `(unknown)` service accounts for 35.0 GB / $52/wk — effectively 100% of volume — meaning telemetry is flowing wit
- [WARN] **217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > age (offsets: 7d/14d/21d) > **"no cost drivers detected (this week)"** — All 1,217 patterns are within normal range. No pattern crossed the delta threshold. Th
- [WARN] **3 Services** — no targeted oracle path for this kind; claim accepted as plausible
    > : none to report.** The environment is stable week-over-week. --- ### (3) Top 3 Services by Volume Source: `log10x_services` | Rank | Service (verbatim) | Vo
- [OK] **4 services** — oracle reports 2 services
    > B** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services · 35.0 GB · $52/wk at $1.5/GB. Top 3 = 100% of volume. --- ### Reco
- [WARN] **217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > cy today.** `log10x_cost_drivers` found zero week-over-week movers across all 1,217 patterns — the spend profile is flat, so there is no urgent spike to chase r
- [WARN] **10 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > is no urgent spike to chase right now. 4. **Long tail is significant.** The top 10 patterns cover only 48% of volume; 52% is in the tail — consider running `log
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > ** | **$0.0000/wk** | Total: 4 services · 35.0 GB · $52/wk at $1.5/GB. Top 3 = 100% of volume. --- ### Recommendations 1. **Service attribution gap is the #
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > problem.** The `(unknown)` service accounts for 35.0 GB / $52/wk — effectively 100% of volume — meaning telemetry is flowing without proper `service.name` labe
- [WARN] **48%** — percentages are derived; oracle does not gate them
    > hase right now. 4. **Long tail is significant.** The top 10 patterns cover only 48% of volume; 52% is in the tail — consider running `log10x_exclusion_filter` o
- [WARN] **52%** — percentages are derived; oracle does not gate them
    > 4. **Long tail is significant.** The top 10 patterns cover only 48% of volume; 52% is in the tail — consider running `log10x_exclusion_filter` or `log10x_savin

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 33731ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 53413ms, stdout=1279B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 38497ms, stdout=1448B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 28980ms, stdout=1009B, stderr=0B
