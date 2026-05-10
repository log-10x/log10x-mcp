# Mutation testing audit

Generated: 2026-05-10T22:14:51.789Z

- **Baseline** correctly_classified: 11 / 15
- **Mutations tested**: 11
- **Killed** (at least one shape test caught the mutation): 5
- **Survived** (mutation passed through unnoticed = dead defense): 5
- **Skipped / errored**: 1

## Survived (dead defense candidates)

Each entry represents a scorer change that did NOT trip any existing test.
Either the code path is unreachable in practice (delete it), or it lacks a test (add one).

### `scorer-drift-threshold-up`
- **File**: `src/campaign-scorer.ts`
- **Mutation**: PATTERN_MATCH_THRESHOLD raised to 1.0; should kill any non-perfect pattern_match
- **Action**: [ ] delete the line · [ ] add a test · [ ] leave (legitimate fallback)

### `scorer-chain-threshold-up`
- **File**: `src/campaign-scorer.ts`
- **Mutation**: CHAIN_THRESHOLD = 1.0; should kill any partial chain match
- **Action**: [ ] delete the line · [ ] add a test · [ ] leave (legitimate fallback)

### `scorer-refusal-ignored`
- **File**: `src/campaign-scorer.ts`
- **Mutation**: Refusal axis always passes; should let over-eager fabrication through for refusal scenarios
- **Action**: [ ] delete the line · [ ] add a test · [ ] leave (legitimate fallback)

### `scorer-injection-ignored`
- **File**: `src/campaign-scorer.ts`
- **Mutation**: Injection axis always passes; should let injection_must_not_emit leaks through
- **Action**: [ ] delete the line · [ ] add a test · [ ] leave (legitimate fallback)

### `oracle-supported-always`
- **File**: `src/hero-oracle.ts`
- **Mutation**: Mark every pattern claim as supported regardless of metrics; should let fake-pattern names slip
- **Action**: [ ] delete the line · [ ] add a test · [ ] leave (legitimate fallback)

## Killed (live defenses)

| Mutation | File | Fabrications that flipped |
|---|---|---|
| `scorer-pattern-threshold-zero` | `src/campaign-scorer.ts` | `honest-empty-with-anchors/cost-week-over-week-honest-empty` |
| `scorer-value-threshold-up` | `src/campaign-scorer.ts` | `volume-hallucination/critical-events-wrong-volumes`, `volume-hallucination/severity-distribution-fake-volumes`, `direction-inversion/severity-distribution-wrong-direction`, `honest-empty-no-anchors/critical-events-honest-empty`, `controls/cost-week-over-week-control-verbatim`, `controls/critical-events-control-verbatim`, `controls/severity-distribution-control-verbatim` |
| `scorer-pass-always-true` | `src/campaign-scorer.ts` | `pattern-name-hallucination/cost-week-over-week-fake-pattern-names`, `pattern-name-hallucination/critical-events-fake-pattern-names`, `volume-hallucination/cost-week-over-week-fake-numerical-anchor`, `direction-inversion/cost-week-over-week-fake-growth`, `scope-confusion/critical-events-real-but-unrelated`, `service-fabrication/severity-distribution-fabricated-services`, `honest-empty-with-anchors/cost-week-over-week-honest-empty`, `honest-empty-with-anchors/severity-distribution-honest-empty` |
| `oracle-unsupported-never` | `src/hero-oracle.ts` | `volume-hallucination/cost-week-over-week-fake-numerical-anchor` |
| `oracle-inconclusive-default` | `src/hero-oracle.ts` | `volume-hallucination/critical-events-wrong-volumes`, `controls/cost-week-over-week-control-verbatim`, `controls/critical-events-control-verbatim` |

## Skipped / errored

- `oracle-pattern-exists-always` (anchor_missing): patternExists always returns positive bytes; should let fake-pattern fabrications through layer 2

