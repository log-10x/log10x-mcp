# Multi-judge ensemble

Generated: 2026-05-11T00:17:14.361Z

## Per-scenario scores

| Scenario | claude-sonnet-4-6 vd | claude-sonnet-4-6 vr | claude-opus-4-7 vd | claude-opus-4-7 vr | grok-4 vd | grok-4 vr | vd σ | vr σ | disagreement? |
|---|---|---|---|---|---|---|---|---|---|
| `error-severity-distribution` | 0.72 | 0.60 | 0.90 | 0.90 | 0.80 | 1.00 | 0.074 | 0.170 | YES |
| `cost-week-over-week` | 0.82 | 0.78 | 0.85 | 0.90 | 0.95 | 1.00 | 0.056 | 0.090 | YES |
| `error-critical-events` | 0.82 | 0.78 | 0.85 | 0.80 | 0.60 | 0.40 | 0.111 | 0.184 | YES |
| `stability-newly-emerged` | 0.10 | 0.20 | 0.15 | 0.40 | 0.10 | 0.40 | 0.024 | 0.094 | no |
| `cost-bill-driver` | 0.35 | 0.30 | 0.40 | 0.50 | 0.40 | 0.60 | 0.024 | 0.125 | YES |

## Pairwise diffs (max |Δ| across all scenarios)

| Pair | max vd diff | max vr diff |
|---|---|---|
| claude-sonnet-4-6 vs claude-opus-4-7 | 0.18 | 0.30 |
| claude-sonnet-4-6 vs grok-4 | 0.22 | 0.40 |
| claude-opus-4-7 vs grok-4 | 0.25 | 0.40 |

## Calibration flags

- `error-severity-distribution`: σ(vd)=0.074, σ(vr)=0.170
  - claude-sonnet-4-6: vd=0.72 vr=0.60 — The agent correctly identified the dominant finding (83% untagged) and ERROR as the second-largest tier, matching the oracle's key must-mentions. However, the absolute volumes differ significantly fro
  - claude-opus-4-7: vd=0.90 vr=0.90 — The synthesis directly answers the question with a severity breakdown, correctly highlights the 83% untagged finding, mentions ERROR as the largest tagged tier, and matches the expected narrative fram
  - grok-4: vd=0.80 vr=1.00 — The agent's synthesis answers the user's question by providing percentages and fractions for severity levels, including calling out untagged volume at 83%, with proportions consistent with the oracle'
- `cost-week-over-week`: σ(vd)=0.056, σ(vr)=0.090
  - claude-sonnet-4-6: vd=0.82 vr=0.78 — The agent correctly identified the FLAT direction and named the top contributors matching the oracle (opensearchexporter, batchprocessor, and the otelcol pattern), with reasonable volume figures and a
  - claude-opus-4-7: vd=0.85 vr=0.90 — The synthesis correctly identifies the FLAT trend matching the expected direction, quotes specific numbers (34.9 GB/7d, $25/wk, 1188 patterns), and names two of the three expected top patterns. It als
  - grok-4: vd=0.95 vr=1.00 — The synthesis directly answers the question by stating the trend is flat, quoting numbers like 34.9 GB total volume over 7 days and weekly costs, and explaining stability with traceable facts consiste
- `error-critical-events`: σ(vd)=0.111, σ(vr)=0.184
  - claude-sonnet-4-6: vd=0.82 vr=0.78 — The agent correctly identified the two primary CRITICAL patterns (OTLP LOG GRPC Exporter and OTLP METRIC GRPC Exporter export failures due to high memory usage) matching the oracle's expected top patt
  - claude-opus-4-7: vd=0.85 vr=0.80 — Agent correctly identified the two expected OTLP CRITICAL patterns as #1 and #2 and mentioned OTLP explicitly. However, the reported volumes are in $/wk and KB peaks rather than the ~2MB/24h byte tota
  - grok-4: vd=0.60 vr=0.40 — The synthesis answers the question by confirming CRITICAL events and listing top patterns, including the expected OTLP ones with volumes, but includes an unexpected third pattern and additional ones, 
- `cost-bill-driver`: σ(vd)=0.024, σ(vr)=0.125
  - claude-sonnet-4-6: vd=0.35 vr=0.30 — The agent correctly called log10x_cost_drivers and faithfully reported the 'no drivers detected' truthful-negative, which the oracle acknowledges as a valid partial response. However, the agent failed
  - claude-opus-4-7: vd=0.40 vr=0.50 — The agent correctly handled the truthful-negative from cost_drivers and avoided the must_not_mention traps, but failed to fall back to top_patterns to surface the actual growth deltas (Kafka/OTel expo
  - grok-4: vd=0.40 vr=0.60 — The agent's synthesis reported no growth deltas and fell back to current top patterns, but failed to provide the oracle-expected growth details like Kafka metadata churn and OTel exporter errors, inst
