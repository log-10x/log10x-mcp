# Cost-by-label drilldown (namespace)

**Scenario:** `cost-by-namespace`
**Mode:** deterministic
**Outcome:** max_steps
**Steps:** 5
**Duration:** 7.18s
**Started:** 2026-05-09T19:32:49.022Z
**Passed criteria:** PASS

## Scores

| Dimension | 0..1 | Raw |
|-----------|------|-----|
| Reasoning | 0.70 | tool_selection=0 params=0 seq=2 |
| Value | 0.00 | accuracy=0 follow_through=0 |
| Autonomy | 0.50 | — |
| Hallucination | 0.00 | (lower = better) |

## Sequence diff

```
expected: log10x_list_by_label
actual:   log10x_list_by_label -> log10x_top_patterns -> log10x_cost_drivers -> log10x_cost_drivers -> log10x_top_patterns
missing:  none
extra:    log10x_top_patterns, log10x_cost_drivers, log10x_cost_drivers, log10x_top_patterns
must_not violations: none
subsequence satisfied: true
```

## Ground truth (1/1 passed)

- [PASS] **list_by_label result lists at least one namespace row with a dollar amount** — regex /(\$\d|namespace|otel-demo|demo|kube)/i matched

## Autonomy metrics

- Tool calls: 5 (optimal: 1)
- Stalled (final-text marker): false
- Abandoned NEXT_ACTIONS hints: 4
- Score: 0.50

## Judge verdict

_(judge not run)_

## Flags

_(none)_

## Artifacts

- transcript: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/cost-by-namespace/2026-05-09T19-32-49-021Z/transcript.jsonl`
- step log: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/cost-by-namespace/2026-05-09T19-32-49-021Z/step-log.jsonl`
