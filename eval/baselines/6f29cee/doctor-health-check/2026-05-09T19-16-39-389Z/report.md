# Pipeline health probe (doctor)

**Scenario:** `doctor-health-check`
**Mode:** deterministic
**Outcome:** completed
**Steps:** 1
**Duration:** 8.70s
**Started:** 2026-05-09T19:16:39.390Z
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
expected: log10x_doctor
actual:   log10x_doctor
missing:  none
extra:    none
must_not violations: none
subsequence satisfied: true
```

## Ground truth (1/1 passed)

- [PASS] **doctor result is a structured report with at least one section / status / check marker** — regex /(##|PASS|FAIL|WARN|gateway|tier|freshness|env|retriever|paste|enrichment|check)/i matched

## Autonomy metrics

- Tool calls: 1 (optimal: 1)
- Stalled (final-text marker): false
- Abandoned NEXT_ACTIONS hints: 0
- Score: 1.00

## Judge verdict

_(judge not run)_

## Flags

_(none)_

## Artifacts

- transcript: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/doctor-health-check/2026-05-09T19-16-39-389Z/transcript.jsonl`
- step log: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/doctor-health-check/2026-05-09T19-16-39-389Z/step-log.jsonl`
