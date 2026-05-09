# Environment-wide investigation sweep

**Scenario:** `investigate-environment-sweep`
**Mode:** deterministic
**Outcome:** completed
**Steps:** 1
**Duration:** 1.31s
**Started:** 2026-05-09T19:00:52.416Z
**Passed criteria:** PASS

## Scores

| Dimension | 0..1 | Raw |
|-----------|------|-----|
| Reasoning | 0.70 | tool_selection=0 params=0 seq=2 |
| Value | 0.00 | accuracy=0 follow_through=0 |
| Autonomy | 1.00 | — |
| Hallucination | 0.00 | (lower = better) |

## Sequence diff

```
expected: log10x_investigate
actual:   log10x_investigate
missing:  none
extra:    none
must_not violations: none
subsequence satisfied: true
```

## Ground truth (1/1 passed)

- [PASS] **investigate produces a coherent report — either a result body, a 'no significant movement' negative, or an honest empty-environment marker** — regex /(Investigation:|## |significant movement|no .{0,40}(detected|found|movement)|Environment-wide|drift|spike|cohort|inflection)/i matched

## Autonomy metrics

- Tool calls: 1 (optimal: 2)
- Stalled (final-text marker): false
- Abandoned NEXT_ACTIONS hints: 0
- Score: 1.00

## Judge verdict

_(judge not run)_

## Flags

_(none)_

## Artifacts

- transcript: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/investigate-environment-sweep/2026-05-09T19-00-52-416Z/transcript.jsonl`
- step log: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/investigate-environment-sweep/2026-05-09T19-00-52-416Z/step-log.jsonl`
