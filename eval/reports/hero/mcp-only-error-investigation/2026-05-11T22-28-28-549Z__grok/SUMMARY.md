# Hero scenario: MCP-only — investigate the top ERROR pattern via the log10x_* causal-chain tools

**Scenario:** `mcp-only-error-investigation`
**Status:** PASS
**Env:** demo
**Runner model:** `grok-4-latest` (xai)
**Started:** 2026-05-11T22:28:28.568Z
**Duration:** 536.0s
**Bash calls:** 10

## User question

> Investigate the top ERROR-severity pattern currently firing in otel-demo. Step (1): identify the #1 ERROR pattern by current cost rank via log10x_top_patterns. Step (2): get its time-series trend via log10x_pattern_trend over the last 24h — is it stable, growing, declining, or spiky? Step (3): run log10x_investigate against it to surface the causal chain — what other patterns are co-firing or upstream? Step (4): if applicable, call log10x_correlate_cross_pillar to see if any k8s state correlates. Report a 4-line synthesis quoting the actual pattern name, trend shape, and causal-chain findings. Tools you may use are limited to log10x_* MCP tools only — do NOT use kubectl, do NOT use gh, do NOT use any other shell utility.

## Three axes

- **Hallucination (drift score):** 0 unsupported · 3 supported · 1 inconclusive
- **Value delivered:** 0.70 — The synthesis correctly identifies the #1 ERROR pattern, its stable 24h trend, and causal-chain findings (no discrete inflection, co-drifting payment service patterns), and notes the cross-pillar gap — an SRE could act on this, though the -2046946.1%/week drift figure is clearly an artifact that wasn't flagged as suspicious, and the 4-line synthesis format wasn't followed.
- **Value received:** 0.65 — The MCP tools returned real, actionable data for top_patterns, pattern_trend, and investigate (including a co-drifting cohort table), but cross-pillar correlation was unavailable due to missing backend configuration, and the investigate tool's anomalous drift percentage suggests data quality issues that limit full trust in the causal chain output.
- **Cost (runner only):** $0.2152 — 67062 in / 933 out tokens across 11 API calls

## Sub-agent final synthesis

The top ERROR-severity pattern by current cost rank is "service instance id service name otelcol contrib service version otelcol" at $3.9/wk (from log10x_top_patterns).

Over the last 24h, its trend is stable with baseline ~$0.88/day and current $0.90/day (from log10x_pattern_trend).

log10x_investigate shows no significant movement in the last 1h, but over last 30d reveals gradual drift declining at -2046946.1%/week, with co-drifting patterns like "timestamp" and "process_pid" in the payment service (cohort, not a causal chain).

log10x_correlate_cross_pillar unavailable due to missing metrics backend; recommend checking commit history for affected services over the 30d drift window per tool suggestions.

## Oracle validation

- Claims found: 4 numeric, 0 pattern names
- Supported by oracle: 3 · Unsupported: 0 · Inconclusive: 1
- **Drift score: 0** (count of unsupported claims)

### Per-claim detail

- [OK] **$3.9** — env ~5.45GB/day; claim within plausible cost band
    > s "service instance id service name otelcol contrib service version otelcol" at $3.9/wk (from log10x_top_patterns). Over the last 24h, its trend is stable with
- [OK] **$0.88** — env ~5.45GB/day; claim within plausible cost band
    > om log10x_top_patterns). Over the last 24h, its trend is stable with baseline ~$0.88/day and current $0.90/day (from log10x_pattern_trend). log10x_investigate
- [OK] **$0.90** — env ~5.45GB/day; claim within plausible cost band
    > ). Over the last 24h, its trend is stable with baseline ~$0.88/day and current $0.90/day (from log10x_pattern_trend). log10x_investigate shows no significant
- [WARN] **-2046946.1%** — percentages are derived; oracle does not gate them
    > t movement in the last 1h, but over last 30d reveals gradual drift declining at -2046946.1%/week, with co-drifting patterns like "timestamp" and "process_pid" i

## Bash command trace

### 1. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=-1, 60201ms, stdout=0B, stderr=0B

### 2. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --list
exit=0, 26367ms, stdout=703B, stderr=0B

### 3. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 17694ms, stdout=1448B, stderr=0B

### 4. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_top_patterns --args '...
exit=0, 13194ms, stdout=1893B, stderr=0B

### 5. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=1, 11824ms, stdout=218B, stderr=0B

### 6. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_pattern_trend --args ...
exit=0, 6421ms, stdout=344B, stderr=0B

### 7. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 7050ms, stdout=1527B, stderr=0B

### 8. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 35554ms, stdout=5432B, stderr=0B

### 9. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_investigate --args '{...
exit=0, 36537ms, stdout=5431B, stderr=0B

### 10. node /Users/talweiss/git/l1x-co/log10x-mcp/eval/bin/mcp-call.mjs --tool log10x_correlate_cross_pilla...
exit=0, 3925ms, stdout=1657B, stderr=0B
