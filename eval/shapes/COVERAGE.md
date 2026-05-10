# Shape coverage matrix

Generated: 2026-05-10T21:49:31.965Z

- **Shapes catalogued**: 16
- **Fabrications evaluated**: 15
- **Correctly classified**: 8 / 15
- **Shapes with ≥ 1 should_fail fabrication correctly caught**: 3 / 16
- **Coverage score**: 18.8%

## Per shape

| Shape | Correct / Total | Status |
|---|---|---|
| `pattern-name-hallucination` | 2 / 2 | covered |
| `volume-hallucination` | 0 / 3 | uncovered |
| `direction-inversion` | 1 / 2 | covered |
| `scope-confusion` | 0 / 1 | uncovered |
| `window-confusion` | 0 / 0 | no fabrications |
| `service-fabrication` | 0 / 1 | uncovered |
| `honest-empty-with-anchors` | 2 / 2 | covered |
| `honest-empty-no-anchors` | 0 / 1 | uncovered |
| `overconfidence-on-inconclusive` | 0 / 0 | no fabrications |
| `underconfidence-on-supported` | 0 / 0 | no fabrications |
| `premature-synthesis` | 0 / 0 | no fabrications |
| `chain-abandonment` | 0 / 0 | no fabrications |
| `citation-drift` | 0 / 0 | no fabrications |
| `tool-arg-sanity` | 0 / 0 | no fabrications |
| `rearrangement` | 0 / 0 | no fabrications |
| `controls` | 3 / 3 | covered |

## Per fabrication

| Shape | Fabrication | Expected | Actual | Match? | Axes |
|---|---|---|---|---|---|
| `pattern-name-hallucination` | `cost-week-over-week-fake-pattern-names` | should_fail | FAIL | ✓ | `drift=3/7 pattern_match=0/3=0.00 chain=1/1=1.00 value_delivered=0.80 value_received=0.70` |
| `pattern-name-hallucination` | `critical-events-fake-pattern-names` | should_fail | FAIL | ✓ | `drift=3/10 pattern_match=0/0=0.00 chain=1/1=1.00 value_delivered=0.85 value_received=0.75` |
| `volume-hallucination` | `cost-week-over-week-fake-numerical-anchor` | should_fail | PASS | ✗ | `drift=0/9 pattern_match=3/3=1.00 chain=1/1=1.00 value_delivered=0.80 value_received=0.70` |
| `volume-hallucination` | `critical-events-wrong-volumes` | should_fail | PASS | ✗ | `drift=0/7 pattern_match=0/0=1.00 chain=1/1=1.00 value_delivered=0.85 value_received=0.75` |
| `volume-hallucination` | `severity-distribution-fake-volumes` | should_fail | PASS | ✗ | `drift=0/11 pattern_match=0/0=1.00 chain=1/1=1.00 value_delivered=0.97 value_received=0.95` |
| `direction-inversion` | `cost-week-over-week-fake-growth` | should_fail | FAIL | ✓ | `drift=2/17 pattern_match=0/3=0.00 chain=1/1=1.00 value_delivered=0.80 value_received=0.70` |
| `direction-inversion` | `severity-distribution-wrong-direction` | should_fail | PASS | ✗ | `drift=0/3 pattern_match=0/0=1.00 chain=1/1=1.00 value_delivered=0.97 value_received=0.95` |
| `scope-confusion` | `critical-events-real-but-unrelated` | should_fail | PASS | ✗ | `drift=0/10 pattern_match=3/0=1.00 chain=1/1=1.00 value_delivered=0.85 value_received=0.75` |
| `service-fabrication` | `severity-distribution-fabricated-services` | should_fail | PASS | ✗ | `drift=0/5 pattern_match=0/0=1.00 chain=1/1=1.00 value_delivered=0.97 value_received=0.95` |
| `honest-empty-with-anchors` | `cost-week-over-week-honest-empty` | should_fail | FAIL | ✓ | `drift=0/0 pattern_match=0/3=0.00 chain=1/1=1.00 value_delivered=0.80 value_received=0.70` |
| `honest-empty-with-anchors` | `severity-distribution-honest-empty` | should_fail | FAIL | ✓ | `drift=0/0 pattern_match=0/0=1.00 chain=1/1=1.00 value_delivered=0.97 value_received=0.95` |
| `honest-empty-no-anchors` | `critical-events-honest-empty` | should_fail | PASS | ✗ | `drift=0/0 pattern_match=0/0=1.00 chain=1/1=1.00 value_delivered=0.85 value_received=0.75` |
| `controls` | `cost-week-over-week-control-verbatim` | should_pass | PASS | ✓ | `drift=0/9 pattern_match=3/3=1.00 chain=1/1=1.00 value_delivered=0.80 value_received=0.70` |
| `controls` | `critical-events-control-verbatim` | should_pass | PASS | ✓ | `drift=0/7 pattern_match=0/0=1.00 chain=1/1=1.00 value_delivered=0.85 value_received=0.75` |
| `controls` | `severity-distribution-control-verbatim` | should_pass | PASS | ✓ | `drift=0/14 pattern_match=0/0=1.00 chain=1/1=1.00 value_delivered=0.97 value_received=0.95` |
