# Hero scenario: MCP-only — cost / growth / volume audit using log10x_* tools exclusively

**Scenario:** `mcp-only-cost-audit`
**Status:** PASS
**Env:** demo
**Runner model:** `claude-sonnet-4-6` (anthropic)
**Started:** 2026-05-11T22:28:27.978Z
**Duration:** 216.8s
**Bash calls:** 5

## User question

> We need a week-over-week cost audit of the otel-demo environment. Specifically: (1) which patterns are the top 3 cost drivers right now (current rank), (2) which patterns are the top 3 GROWTH drivers (week-over-week deltas), and (3) which 3 services consume the most volume. For each answer, name the pattern / service VERBATIM as returned by the tool and quote the cost number from tool stdout. Tools you may use are limited to the log10x_* MCP catalog only — do NOT use kubectl, do NOT use gh, do NOT use grep / awk / curl / or any other shell utility beyond the MCP CLI invocation itself. If the MCP returns 'no drivers detected' or 'no data' for a section, report that honestly instead of inventing numbers.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 20 supported · 5 inconclusive
- **Value delivered:** 0.95 — The sub-agent answered all three questions verbatim with quoted costs, correctly reported the honest negative for growth drivers, and provided actionable synthesis including root cause hypothesis for the (unknown) service and next steps.
- **Value received:** 0.85 — The MCP tools returned real, structured data for top patterns, services by volume, and a truthful negative for cost drivers, though log10x_cost_drivers timed out on first call and the top_patterns tool noted a discrepancy ($25/wk in-scope vs $52/wk total from services) suggesting partial scope coverage.
- **Cost (runner only):** $0.0538 — 10893 in / 1411 out tokens across 4 API calls

## Sub-agent final synthesis

Clear results across all three tools. Here is the complete week-over-week cost audit of the **otel-demo** environment:

---

## otel-demo Week-Over-Week Cost Audit

### (1) Top 3 Current Cost Drivers (by rank this week)

These are the highest-cost patterns **right now**, as returned verbatim by `log10x_top_patterns` (7d window, $25/wk total in-scope):

| Rank | Pattern (verbatim) | Cost |
|------|--------------------|------|
| #1 | `(unknown)` | **$4.2/wk** |
| #2 | `service instance id service name otelcol contrib service version otelcol` (ERROR level) | **$3.9/wk** |
| #3 | `open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** |

---

### (2) Top 3 Growth Drivers (Week-over-Week Deltas)

`log10x_cost_drivers` (7d window, compared against a 3-window rolling average baseline at offsets 7d/14d/21d) returned:

> **"all services — no cost drivers detected (this week)"**
> *"All 1217 patterns are within normal range."*

This is a truthful negative result. **No pattern crossed the growth delta threshold.** The environment is stable week-over-week. There are no top-3 growth drivers to report — not a tool failure, but a genuine signal of cost stability.

---

### (3) Top 3 Services by Volume

As returned verbatim by `log10x_services`:

| Rank | Service (verbatim) | Volume | Cost |
|------|--------------------|--------|------|
| #1 | `(unknown)` | **35.0 GB** | **$52/wk** |
| #2 | `email` | **11.8 MB** | **$0.02/wk** |
| #3 | `frontend` | **17.1 KB** | **$0.0000/wk** |

Total: 4 services monitored · 35.0 GB · $52/wk at $1.5/GB. The top 3 services = 100% of volume.

---

### Synthesis & Recommendations

1. **Volume is massively concentrated**: The `(unknown)` service alone accounts for 35.0 GB / $52/wk — effectively **100% of total volume**. The named services (`email`, `frontend`, `recommendation`) are negligible by comparison. The immediate ROI lever is resolving why so much telemetry is landing under `(unknown)` (likely missing `service.name` attributes in OTel resource detection).

2. **No week-over-week growth** — the environment is stable across all 1,217 patterns. There is no runaway growth fire to fight right now.

3. **Within `(unknown)`, the costliest patterns** are `open telemetry opentelemetry collector contrib exporter opensearchexporter` ($3.8/wk) and `opentelemetry io collector processor batchprocessor v batch processor go` ($3.7/wk) — both collector-internal telemetry. Consider applying an exclusion filter via `log10x_exclusion_filter` or tuning the OpenSearch exporter's verbosity to reclaim that spend.

4. **Call `log10x_savings`** next to surface any pipeline-level ROI opportunities against the current $52/wk bill.

## Oracle validation

- Claims found: 25 numeric, 0 pattern names
- Supported by oracle: 20 · Unsupported: 0 · Inconclusive: 5
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$25** — env ~5.45GB/day; claim within plausible cost band
    > tterns **right now**, as returned verbatim by `log10x_top_patterns` (7d window, $25/wk total in-scope): | Rank | Pattern (verbatim) | Cost | |------|----------
- [OK] **$4.2** — env ~5.45GB/day; claim within plausible cost band
    > (verbatim) | Cost | |------|--------------------|------| | #1 | `(unknown)` | **$4.2/wk** | | #2 | `service instance id service name otelcol contrib service ver
- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > ance id service name otelcol contrib service version otelcol` (ERROR level) | **$3.9/wk** | | #3 | `open telemetry opentelemetry collector contrib exporter open
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** | --- ### (2) Top 3 Growth Drivers (Week-over-Week Deltas) `log10x_
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > ----|--------------------|--------|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **1
- [OK] **$0.02** — env ~5.45GB/day; claim within plausible cost band
    > #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 servic
- [OK] **$0.0000** — env ~5.45GB/day; claim within plausible cost band
    > #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services monitored · 35.0 GB · $52/wk at $1.5/GB. The t
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > tend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services monitored · 35.0 GB · $52/wk at $1.5/GB. The top 3 services = 100% of volume. --- ### Synthesis & Re
- [OK] **$1.5** — env ~5.45GB/day; claim within plausible cost band
    > 17.1 KB** | **$0.0000/wk** | Total: 4 services monitored · 35.0 GB · $52/wk at $1.5/GB. The top 3 services = 100% of volume. --- ### Synthesis & Recommendati
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > massively concentrated**: The `(unknown)` service alone accounts for 35.0 GB / $52/wk — effectively **100% of total volume**. The named services (`email`, `fro
- [OK] **$3.8** — env ~5.45GB/day; claim within plausible cost band
    > e `open telemetry opentelemetry collector contrib exporter opensearchexporter` ($3.8/wk) and `opentelemetry io collector processor batchprocessor v batch proces
- [OK] **$3.7** — env ~5.45GB/day; claim within plausible cost band
    > and `opentelemetry io collector processor batchprocessor v batch processor go` ($3.7/wk) — both collector-internal telemetry. Consider applying an exclusion fil
- [OK] **$52** — env ~5.45GB/day; claim within plausible cost band
    > ngs`** next to surface any pipeline-level ROI opportunities against the current $52/wk bill.
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > e | Cost | |------|--------------------|--------|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `f
- [OK] **11.8 MB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > ----|------| | #1 | `(unknown)` | **35.0 GB** | **$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | T
- [OK] **17.1 KB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > *$52/wk** | | #2 | `email` | **11.8 MB** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services monitored · 35.0 GB · $52/wk at
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services monitored · 35.0 GB · $52/wk at $1.5/GB. The top 3 services = 100% of volume. --- ### Synt
- [OK] **35.0 GB** — env total ~5.45GB/24h; claim within plausible subset/total range
    > *Volume is massively concentrated**: The `(unknown)` service alone accounts for 35.0 GB / $52/wk — effectively **100% of total volume**. The named services (`em
- [WARN] **1217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > returned: > **"all services — no cost drivers detected (this week)"** > *"All 1217 patterns are within normal range."* This is a truthful negative result. **
- [WARN] **3 Services** — no targeted oracle path for this kind; claim accepted as plausible
    > — not a tool failure, but a genuine signal of cost stability. --- ### (3) Top 3 Services by Volume As returned verbatim by `log10x_services`: | Rank | Servi
- [OK] **4 services** — oracle reports 2 services
    > B** | **$0.02/wk** | | #3 | `frontend` | **17.1 KB** | **$0.0000/wk** | Total: 4 services monitored · 35.0 GB · $52/wk at $1.5/GB. The top 3 services = 100% of
- [OK] **3 services** — oracle reports 2 services
    > 0000/wk** | Total: 4 services monitored · 35.0 GB · $52/wk at $1.5/GB. The top 3 services = 100% of volume. --- ### Synthesis & Recommendations 1. **Volume
- [WARN] **217 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > ion). 2. **No week-over-week growth** — the environment is stable across all 1,217 patterns. There is no runaway growth fire to fight right now. 3. **Within `
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > Total: 4 services monitored · 35.0 GB · $52/wk at $1.5/GB. The top 3 services = 100% of volume. --- ### Synthesis & Recommendations 1. **Volume is massively
- [WARN] **100%** — percentages are derived; oracle does not gate them
    > **: The `(unknown)` service alone accounts for 35.0 GB / $52/wk — effectively **100% of total volume**. The named services (`email`, `frontend`, `recommendation

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 32906ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=-1, 60027ms, stdout=0B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 39375ms, stdout=1448B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_services --args '{}'
exit=0, 27474ms, stdout=1009B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 27362ms, stdout=1279B, stderr=0B
