# Multi-judge ensemble

Generated: 2026-05-10T21:45:59.993Z

## Per-scenario scores

| Scenario | claude-sonnet-4-6 vd | claude-sonnet-4-6 vr | claude-opus-4-7 vd | claude-opus-4-7 vr | vd σ | vr σ | disagreement? |
|---|---|---|---|---|---|---|---|
| `error-severity-distribution` | 0.72 | 0.65 | 0.90 | 0.90 | 0.090 | 0.125 | YES |
| `cost-week-over-week` | 0.82 | 0.78 | 0.75 | 0.80 | 0.035 | 0.010 | no |
| `error-critical-events` | 0.35 | 0.40 | 0.60 | 0.70 | 0.125 | 0.150 | YES |
| `stability-newly-emerged` | 0.15 | 0.30 | 0.15 | 0.40 | 0.000 | 0.050 | no |
| `cost-bill-driver` | 0.35 | 0.30 | 0.40 | 0.50 | 0.025 | 0.100 | no |

## Pairwise diffs (max |Δ| across all scenarios)

| Pair | max vd diff | max vr diff |
|---|---|---|
| claude-sonnet-4-6 vs claude-opus-4-7 | 0.25 | 0.30 |

## Calibration flags

- `error-severity-distribution`: σ(vd)=0.090, σ(vr)=0.125
  - claude-sonnet-4-6: vd=0.72 vr=0.65 — The agent correctly identified the core finding (83% untagged) and got the ERROR tier roughly right in percentage terms (~9% vs oracle's ~8.6%). However, the absolute volumes are inflated by roughly 6
  - claude-opus-4-7: vd=0.90 vr=0.90 — The agent correctly identified the 83% untagged finding, called out ERROR as the second-largest tier, and provided a full severity breakdown with percentages matching the oracle's expected split. Abso
- `error-critical-events`: σ(vd)=0.125, σ(vr)=0.150
  - claude-sonnet-4-6: vd=0.35 vr=0.40 — The agent correctly confirmed CRITICAL events exist and listed patterns with some volume proxies (cost/KB), but the oracle expects a ~2.25 MB/24h byte-volume figure and specific patterns derived from 
  - claude-opus-4-7: vd=0.60 vr=0.70 — The agent correctly confirmed CRITICAL events exist and identified specific patterns with volume/cost figures, addressing the user's question directly. However, the reported volumes ($0.02/wk, KB peak
