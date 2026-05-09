# Install advisor — Receiver readwrite, no compact

**Scenario:** `install-advisor-receiver`
**Mode:** deterministic
**Outcome:** completed
**Steps:** 6
**Duration:** 26.84s
**Started:** 2026-05-09T18:34:16.349Z
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
expected: log10x_discover_env -> log10x_advise_receiver
actual:   log10x_discover_env -> log10x_advise_install -> log10x_advise_receiver -> log10x_advise_reporter -> log10x_advise_retriever -> log10x_advise_compact
missing:  none
extra:    log10x_advise_install, log10x_advise_reporter, log10x_advise_retriever, log10x_advise_compact
must_not violations: none
subsequence satisfied: true
```

## Ground truth (3/3 passed)

- [PASS] **discover_env returns a snapshot id (disc-<uuid>)** — regex /disc-[a-f0-9]{6,}/ matched
- [PASS] **advise_receiver was called with a snapshot_id arg (chain handoff)** — regex /"snapshot_id"/ matched
- [PASS] **advise_receiver result is a coherent advisor plan (Target/Blockers/Plan section headers)** — regex /(## Target|## Blockers|## Install plan|## Verify|advisor)/i matched

## Autonomy metrics

- Tool calls: 6 (optimal: 4)
- Stalled (final-text marker): false
- Abandoned NEXT_ACTIONS hints: 0
- Score: 0.85

## Judge verdict

_(judge not run)_

## Flags

_(none)_

## Artifacts

- transcript: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/install-advisor-receiver/2026-05-09T18-34-16-349Z/transcript.jsonl`
- step log: `/Users/talweiss/git/l1x-co/log10x-mcp/eval/reports/install-advisor-receiver/2026-05-09T18-34-16-349Z/step-log.jsonl`
