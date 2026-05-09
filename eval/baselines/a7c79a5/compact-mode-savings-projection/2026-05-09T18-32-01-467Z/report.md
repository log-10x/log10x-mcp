# Compact mode savings projection + GitOps PR

**Scenario:** `compact-mode-savings-projection`
**Mode:** deterministic
**Outcome:** completed
**Steps:** 6
**Duration:** 29.56s
**Started:** 2026-05-09T18:32:01.467Z
**Passed criteria:** PASS

## Scores

| Dimension | 0..1 | Raw |
|-----------|------|-----|
| Reasoning | 0.70 | tool_selection=0 params=0 seq=2 |
| Value | 0.00 | accuracy=0 follow_through=0 |
| Autonomy | 0.85 | — |
| Hallucination | 0.00 | (lower = better) |

## Sequence diff

```
expected: log10x_discover_env -> log10x_advise_compact
actual:   log10x_discover_env -> log10x_advise_install -> log10x_advise_receiver -> log10x_advise_reporter -> log10x_advise_retriever -> log10x_advise_compact
missing:  none
extra:    log10x_advise_install, log10x_advise_receiver, log10x_advise_reporter, log10x_advise_retriever
must_not violations: none
subsequence satisfied: true
```

## Ground truth (2/2 passed)

- [PASS] **discover_env emits a snapshot id** — regex /disc-[a-f0-9]{6,}/ matched
- [PASS] **advise_compact result is one of: full plan with `gh pr` command, OR a coherent truthful-negative explaining what's missing** — regex /(gh\s+pr\s+(create|edit)|compactReceiver advisor|GitOps not configured|missing target|snapshot.+not found)/i matched

## Autonomy metrics

- Tool calls: 6 (optimal: 3)
- Stalled (final-text marker): false
- Abandoned NEXT_ACTIONS hints: 0
- Score: 0.85

## Judge verdict

_(judge not run)_

## Flags

_(none)_

## Artifacts

- transcript: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/compact-mode-savings-projection/2026-05-09T18-32-01-467Z/transcript.jsonl`
- step log: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/compact-mode-savings-projection/2026-05-09T18-32-01-467Z/step-log.jsonl`
