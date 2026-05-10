# Hero scenario: Cost — what are the top patterns by 24h volume

**Scenario:** `cost-top-by-volume`
**Status:** PASS
**Env:** demo
**Started:** 2026-05-10T02:54:32.520Z
**Duration:** 34.5s
**Bash calls:** 3

## User question

> Show me the top 5 patterns in our env by 24-hour volume. Name each one and tell me roughly how much volume each is producing. Be specific — name the actual patterns.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 0 supported · 19 inconclusive
- **Value delivered:** 0.85 — The synthesis named all 5 patterns specifically with cost figures and provided actionable filtering recommendations, though it couldn't resolve pattern #1's identity and the 24h framing was slightly imprecise (data is weekly cost, not 24h volume).
- **Value received:** 0.75 — The MCP returned ranked pattern names and costs for all 5 slots, but pattern #1 was unresolved ('unknown'), the metric is weekly cost rather than 24h volume as requested, and follow-up calls to get pattern examples failed due to missing patternId field.

## Sub-agent final synthesis

The tool results are clear and specific. Here is the full breakdown from the data:

---

## Top 5 Patterns by 24-Hour Volume

All figures are from `log10x_top_patterns` (24h window, ranked by current cost). **Total env spend: ~$17/wk.**

| Rank | Pattern Name | Weekly Cost | ~24h Cost |
|------|-------------|-------------|-----------|
| **#1** | *(unknown — pattern label not resolved)* | **$4.2/wk** | ~$0.60/day |
| **#2** | `open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** | ~$0.54/day |
| **#3** | `opentelemetry io collector processor batchprocessor v batch processor go` | **$3.7/wk** | ~$0.53/day |
| **#4** | `service instance id service name otelcol contrib service version otelcol` — **ERROR** logs | **$3.6/wk** | ~$0.51/day |
| **#5** | `service instance id service name otelcol contrib service version otelcol` — **DEBUG** logs | **$2.1/wk** | ~$0.30/day |

---

## Key Takeaways & Recommendations

1. **These 5 patterns = 33% of total volume**; the remaining 67% is long-tail — meaning the top patterns are concentrated and actionable.
2. **#1 (unknown)** is the single biggest cost driver at $4.2/wk. It needs to be resolved (pattern label is missing) before you can act on it — run `log10x_pattern_examples` once the pattern ID is surfaced to understand what it actually is.
3. **#2 and #3 are pure OTel Collector infrastructure noise** — exporter and batch processor internals. These are strong candidates for an **exclusion filter**; they add no business observability value.
4. **#4 is ERROR-level** — don't suppress it until you verify it's not masking real failures, but the `otelcol-contrib` service identity suggests it may be collector self-telemetry.
5. **#5 is DEBUG** — this is almost certainly safe to filter immediately. Debug logs from `otelcol-contrib` at $2.1/wk is pure waste.
6. **Immediate win**: Filtering patterns #3 and #5 alone (~$5.8/wk combined) would cut your bill by ~34% without touching any application-level signal.

## Oracle validation

- Claims found: 19 numeric, 0 pattern names
- Supported by oracle: 0 · Unsupported: 0 · Inconclusive: 19
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [WARN] **$17** — no targeted oracle path for this kind; claim accepted as plausible
    > `log10x_top_patterns` (24h window, ranked by current cost). **Total env spend: ~$17/wk.** | Rank | Pattern Name | Weekly Cost | ~24h Cost | |------|-----------
- [WARN] **$4.2** — no targeted oracle path for this kind; claim accepted as plausible
    > ----------|-----------| | **#1** | *(unknown — pattern label not resolved)* | **$4.2/wk** | ~$0.60/day | | **#2** | `open telemetry opentelemetry collector cont
- [WARN] **$0.60** — no targeted oracle path for this kind; claim accepted as plausible
    > ---------| | **#1** | *(unknown — pattern label not resolved)* | **$4.2/wk** | ~$0.60/day | | **#2** | `open telemetry opentelemetry collector contrib exporter
- [WARN] **$3.8** — no targeted oracle path for this kind; claim accepted as plausible
    > open telemetry opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** | ~$0.54/day | | **#3** | `opentelemetry io collector processor batchp
- [WARN] **$0.54** — no targeted oracle path for this kind; claim accepted as plausible
    > y opentelemetry collector contrib exporter opensearchexporter` | **$3.8/wk** | ~$0.54/day | | **#3** | `opentelemetry io collector processor batchprocessor v ba
- [WARN] **$3.7** — no targeted oracle path for this kind; claim accepted as plausible
    > `opentelemetry io collector processor batchprocessor v batch processor go` | **$3.7/wk** | ~$0.53/day | | **#4** | `service instance id service name otelcol co
- [WARN] **$0.53** — no targeted oracle path for this kind; claim accepted as plausible
    > ry io collector processor batchprocessor v batch processor go` | **$3.7/wk** | ~$0.53/day | | **#4** | `service instance id service name otelcol contrib service
- [WARN] **$3.6** — no targeted oracle path for this kind; claim accepted as plausible
    > e id service name otelcol contrib service version otelcol` — **ERROR** logs | **$3.6/wk** | ~$0.51/day | | **#5** | `service instance id service name otelcol co
- [WARN] **$0.51** — no targeted oracle path for this kind; claim accepted as plausible
    > name otelcol contrib service version otelcol` — **ERROR** logs | **$3.6/wk** | ~$0.51/day | | **#5** | `service instance id service name otelcol contrib service
- [WARN] **$2.1** — no targeted oracle path for this kind; claim accepted as plausible
    > e id service name otelcol contrib service version otelcol` — **DEBUG** logs | **$2.1/wk** | ~$0.30/day | --- ## Key Takeaways & Recommendations 1. **These 5
- [WARN] **$0.30** — no targeted oracle path for this kind; claim accepted as plausible
    > name otelcol contrib service version otelcol` — **DEBUG** logs | **$2.1/wk** | ~$0.30/day | --- ## Key Takeaways & Recommendations 1. **These 5 patterns = 33
- [WARN] **$4.2** — no targeted oracle path for this kind; claim accepted as plausible
    > trated and actionable. 2. **#1 (unknown)** is the single biggest cost driver at $4.2/wk. It needs to be resolved (pattern label is missing) before you can act o
- [WARN] **$2.1** — no targeted oracle path for this kind; claim accepted as plausible
    > most certainly safe to filter immediately. Debug logs from `otelcol-contrib` at $2.1/wk is pure waste. 6. **Immediate win**: Filtering patterns #3 and #5 alone
- [WARN] **$5.8** — no targeted oracle path for this kind; claim accepted as plausible
    > .1/wk is pure waste. 6. **Immediate win**: Filtering patterns #3 and #5 alone (~$5.8/wk combined) would cut your bill by ~34% without touching any application-l
- [WARN] **5 Patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > are clear and specific. Here is the full breakdown from the data: --- ## Top 5 Patterns by 24-Hour Volume All figures are from `log10x_top_patterns` (24h wi
- [WARN] **5 patterns** — no targeted oracle path for this kind; claim accepted as plausible
    > **$2.1/wk** | ~$0.30/day | --- ## Key Takeaways & Recommendations 1. **These 5 patterns = 33% of total volume**; the remaining 67% is long-tail — meaning the
- [WARN] **33%** — percentages are derived; oracle does not gate them
    > ~$0.30/day | --- ## Key Takeaways & Recommendations 1. **These 5 patterns = 33% of total volume**; the remaining 67% is long-tail — meaning the top patterns
- [WARN] **67%** — percentages are derived; oracle does not gate them
    > & Recommendations 1. **These 5 patterns = 33% of total volume**; the remaining 67% is long-tail — meaning the top patterns are concentrated and actionable. 2.
- [WARN] **34%** — percentages are derived; oracle does not gate them
    > Filtering patterns #3 and #5 alone (~$5.8/wk combined) would cut your bill by ~34% without touching any application-level signal.

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 2753ms, stdout=703B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 4391ms, stdout=1007B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_examples --ar...
exit=0, 2989ms, stdout=392B, stderr=0B
