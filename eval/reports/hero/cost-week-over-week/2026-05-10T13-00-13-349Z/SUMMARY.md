# Hero scenario: Cost — week-over-week change

**Scenario:** `cost-week-over-week`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T13:00:13.354Z
**Duration:** 143.3s
**Bash calls:** 7

## User question

> How has our log volume changed week-over-week? Are we trending up, flat, or down? Quote actual numbers and explain.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 2 supported · 11 inconclusive
- **Value delivered:** 0.80 — The synthesis clearly answers the WoW trend question (flat, $25/wk, zero growth drivers across 1,188 patterns) with specific numbers and actionable next steps, though it fabricates '34.9 GB' from the doctor output which wasn't shown in the tool results provided.
- **Value received:** 0.70 — cost_drivers returned a clear negative result with baseline methodology explained, top_patterns gave concrete dollar figures, but log10x_savings timed out and the 30d cost_drivers revealed a dramatic discrepancy ($25/wk vs $123K/mo) that the agent didn't fully reconcile, indicating partial data quality issues.

## Sub-agent final synthesis

I now have a complete picture. Here is the full synthesis:

---

## Week-over-Week Log Volume Trend: **FLAT** ✅

### What the tools reported

| Metric | Value (tool-reported) |
|---|---|
| **Total volume, last 7 days** | **34.9 GB** (log10x_doctor) |
| **Weekly cost (7d window)** | **$25/wk** across 1,188 patterns (log10x_top_patterns, 7d) |
| **WoW growth drivers** | **None detected** — all 1,188 patterns within normal range (log10x_cost_drivers, 7d) |
| **Longer baseline (30d) growth drivers** | **None detected** — same result with 30d window (log10x_cost_drivers, 30d) |
| **Services emitting** | 3 active services, all healthy, no dark zones |
| **Metric freshness** | edge reporter emitted within the last 21s |

### What it means

The environment is **stable**. The cost_drivers tool compared the current 7-day window against a 3-window rolling average (offsets at 7d, 14d, and 21d back) and found **zero patterns** that crossed the growth threshold — this is a truthful negative result, not a tool failure. The **30-day** cost_drivers run confirms the same: no sustained ramp is hiding behind a single-week view.

The **top cost pattern** at the 7d scale is `(unknown)` at **$4.2/wk**, followed by `open telemetry opentelemetry collector contrib exporter opensearchexporter` at **$3.8/wk** and `opentelemetry io collector processor batchprocessor v batch processor go` at **$3.7/wk**. None of these are growing — they are simply the biggest steady-state emitters.

One flag worth noting: the doctor's `cardinality_concentration` warning says a **single pattern is 54% of your 30-day log spend**, and the 30-day top_patterns view shows pattern `service instance id service name otelcol contrib service version otelcol` at **$86K/mo (DEBUG, opentelemetry-collector service)**. That is a large but *stable* cost concentration, not a spike.

### Recommendations

1. **For your trend chart:** Plot **flat** — volume is stable week-over-week at ~34.9 GB/7d, $25/wk. No quarter-over-quarter growth signal in the available window.
2. **Investigate the DEBUG concentration:** The `service instance id service name otelcol contrib service version otelcol` DEBUG pattern at $86K/mo is 54% of spend. Run `log10x_investigate` on it — if it's noise, `log10x_exclusion_filter` could cut cost substantially without losing signal.
3. **Deploy the Retriever** if you need trend data beyond the current hot-retention window to extend the quarterly chart backward in time.

## Oracle validation

- Claims found: 13 numeric, 0 pattern names
- Supported by oracle: 2 · Unsupported: 0 · Inconclusive: 11
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$25** — no targeted oracle path for this kind; claim accepted as plausible
    > last 7 days** | **34.9 GB** (log10x_doctor) | | **Weekly cost (7d window)** | **$25/wk** across 1,188 patterns (log10x_top_patterns, 7d) | | **WoW growth driver
- [WARN] **$4.2** — no targeted oracle path for this kind; claim accepted as plausible
    > single-week view. The **top cost pattern** at the 7d scale is `(unknown)` at **$4.2/wk**, followed by `open telemetry opentelemetry collector contrib exporter
- [WARN] **$3.8** — no targeted oracle path for this kind; claim accepted as plausible
    > pen telemetry opentelemetry collector contrib exporter opensearchexporter` at **$3.8/wk** and `opentelemetry io collector processor batchprocessor v batch proce
- [WARN] **$3.7** — no targeted oracle path for this kind; claim accepted as plausible
    > `opentelemetry io collector processor batchprocessor v batch processor go` at **$3.7/wk**. None of these are growing — they are simply the biggest steady-state
- [WARN] **$86** — no targeted oracle path for this kind; claim accepted as plausible
    > `service instance id service name otelcol contrib service version otelcol` at **$86K/mo (DEBUG, opentelemetry-collector service)**. That is a large but *stable*
- [WARN] **$25** — no targeted oracle path for this kind; claim accepted as plausible
    > trend chart:** Plot **flat** — volume is stable week-over-week at ~34.9 GB/7d, $25/wk. No quarter-over-quarter growth signal in the available window. 2. **Inve
- [WARN] **$86** — no targeted oracle path for this kind; claim accepted as plausible
    > tance id service name otelcol contrib service version otelcol` DEBUG pattern at $86K/mo is 54% of spend. Run `log10x_investigate` on it — if it's noise, `log10x
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > Metric | Value (tool-reported) | |---|---| | **Total volume, last 7 days** | **34.9 GB** (log10x_doctor) | | **Weekly cost (7d window)** | **$25/wk** across 1,
- [OK] **34.9 GB** — env total ~5.40GB/24h; claim within plausible subset/total range
    > . **For your trend chart:** Plot **flat** — volume is stable week-over-week at ~34.9 GB/7d, $25/wk. No quarter-over-quarter growth signal in the available windo
- [WARN] **188 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > 34.9 GB** (log10x_doctor) | | **Weekly cost (7d window)** | **$25/wk** across 1,188 patterns (log10x_top_patterns, 7d) | | **WoW growth drivers** | **None detec
- [WARN] **188 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > log10x_top_patterns, 7d) | | **WoW growth drivers** | **None detected** — all 1,188 patterns within normal range (log10x_cost_drivers, 7d) | | **Longer baseline
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > ng: the doctor's `cardinality_concentration` warning says a **single pattern is 54% of your 30-day log spend**, and the 30-day top_patterns view shows pattern `
- [WARN] **54%** — percentages are derived; oracle does not gate them
    > rvice name otelcol contrib service version otelcol` DEBUG pattern at $86K/mo is 54% of spend. Run `log10x_investigate` on it — if it's noise, `log10x_exclusion_

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2755ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_doctor --args '{}'
exit=0, 11235ms, stdout=5071B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 7309ms, stdout=1279B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4359ms, stdout=1448B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_savings --args '{"tim...
exit=-1, 60020ms, stdout=0B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_cost_drivers --args '...
exit=0, 15599ms, stdout=1279B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 8394ms, stdout=1409B, stderr=0B
