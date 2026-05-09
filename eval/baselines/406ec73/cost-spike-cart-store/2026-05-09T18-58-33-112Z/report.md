# Cost spike attribution → fallback to current-cost view (stable demo env)

**Scenario:** `cost-spike-cart-store`
**Mode:** deterministic
**Outcome:** completed
**Steps:** 10
**Duration:** 112.97s
**Started:** 2026-05-09T18:58:33.112Z
**Passed criteria:** PASS

## Scores

| Dimension | 0..1 | Raw |
|-----------|------|-----|
| Reasoning | 0.70 | tool_selection=0 params=0 seq=2 |
| Value | 0.00 | accuracy=0 follow_through=0 |
| Autonomy | 0.75 | — |
| Hallucination | 0.00 | (lower = better) |

## Sequence diff

```
expected: log10x_cost_drivers
actual:   log10x_cost_drivers -> log10x_top_patterns -> log10x_savings -> log10x_investigate -> log10x_cost_drivers -> log10x_top_patterns -> log10x_dependency_check -> log10x_correlate_cross_pillar -> log10x_pattern_trend -> log10x_exclusion_filter
missing:  none
extra:    log10x_top_patterns, log10x_savings, log10x_investigate, log10x_top_patterns, log10x_dependency_check, log10x_correlate_cross_pillar, log10x_pattern_trend, log10x_exclusion_filter
must_not violations: none
subsequence satisfied: true
```

## Ground truth (3/3 passed)

- [PASS] **cost_drivers result is well-formed: either reports drivers OR reports a truthful 'no drivers detected' negative result with comparison** — regex /(cost driver|no cost drivers detected|growth deltas|truthful negative result)/i matched
- [PASS] **cost_drivers emits a NEXT_ACTIONS hint (either dependency_check on the success path or top_patterns/savings/investigate on the no-growth fallback path)** — regex /NEXT_ACTIONS:.*(log10x_dependency_check|log10x_investigate|log10x_top_patterns|log10x_savings)/ matched
- [PASS] **the chain invoked a downstream triage tool (top_patterns / dependency_check / investigate) — not just cost_drivers in isolation** — regex /(starting_point|pattern.*cart|pattern.*open|timeRange).*/ matched

## Autonomy metrics

- Tool calls: 10 (optimal: 4)
- Stalled (final-text marker): false
- Abandoned NEXT_ACTIONS hints: 0
- Score: 0.75

## Judge verdict

_(judge not run)_

## Flags

_(none)_

## Artifacts

- transcript: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/cost-spike-cart-store/2026-05-09T18-58-33-112Z/transcript.jsonl`
- step log: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/cost-spike-cart-store/2026-05-09T18-58-33-112Z/step-log.jsonl`
