# Services listing — pipeline health baseline

**Scenario:** `services-baseline`
**Mode:** deterministic
**Outcome:** completed
**Steps:** 4
**Duration:** 1.62s
**Started:** 2026-05-09T19:07:35.746Z
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
expected: log10x_services
actual:   log10x_services -> log10x_cost_drivers -> log10x_top_patterns -> log10x_investigate
missing:  none
extra:    log10x_cost_drivers, log10x_top_patterns, log10x_investigate
must_not violations: none
subsequence satisfied: true
```

## Ground truth (2/2 passed)

- [PASS] **services result lists at least one service row (not the empty-data terminal text)** — regex /(\$\d|\d+%|\d+ MB|service|namespace)/i matched
- [PASS] **services emits a NEXT_ACTIONS hint to a downstream tool (top_patterns / cost_drivers / list_by_label)** — regex /NEXT_ACTIONS:.*(log10x_top_patterns|log10x_cost_drivers|log10x_list_by_label|log10x_investigate)/ matched

## Autonomy metrics

- Tool calls: 4 (optimal: 1)
- Stalled (final-text marker): false
- Abandoned NEXT_ACTIONS hints: 0
- Score: 0.75

## Judge verdict

_(judge not run)_

## Flags

_(none)_

## Artifacts

- transcript: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/services-baseline/2026-05-09T19-07-35-745Z/transcript.jsonl`
- step log: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/services-baseline/2026-05-09T19-07-35-745Z/step-log.jsonl`
