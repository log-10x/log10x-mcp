# Environment-wide investigation sweep

**Scenario:** `investigate-environment-sweep`
**Mode:** deterministic
**Outcome:** completed
**Steps:** 6
**Duration:** 13.69s
**Started:** 2026-05-09T19:29:10.936Z
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
expected: log10x_investigate
actual:   log10x_investigate -> log10x_investigate -> log10x_dependency_check -> log10x_correlate_cross_pillar -> log10x_pattern_trend -> log10x_exclusion_filter
missing:  none
extra:    log10x_dependency_check, log10x_correlate_cross_pillar, log10x_pattern_trend, log10x_exclusion_filter
must_not violations: none
subsequence satisfied: true
```

## Ground truth (1/1 passed)

- [PASS] **investigate produces a coherent report — either a result body, a 'no significant movement' negative, or an honest empty-environment marker** — regex /(Investigation:|## |significant movement|no .{0,40}(detected|found|movement)|Environment-wide|drift|spike|cohort|inflection)/i matched

## Autonomy metrics

- Tool calls: 6 (optimal: 2)
- Stalled (final-text marker): false
- Abandoned NEXT_ACTIONS hints: 0
- Score: 0.75

## Judge verdict

_(judge not run)_

## Flags

_(none)_

## Artifacts

- transcript: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/investigate-environment-sweep/2026-05-09T19-29-10-936Z/transcript.jsonl`
- step log: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/investigate-environment-sweep/2026-05-09T19-29-10-936Z/step-log.jsonl`
