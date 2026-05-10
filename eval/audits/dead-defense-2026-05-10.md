# Mutation testing audit

Generated: 2026-05-10T22:41:26.924Z

- **Baseline** correctly_classified: 19 / 26
- **Mutations tested**: 11
- **Killed** (at least one shape test caught the mutation): 7
- **Survived** (mutation passed through unnoticed = dead defense): 3
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

### `oracle-supported-always`
- **File**: `src/hero-oracle.ts`
- **Mutation**: Mark every pattern claim as supported regardless of metrics; should let fake-pattern names slip
- **Action**: [ ] delete the line · [ ] add a test · [ ] leave (legitimate fallback)

## Killed (live defenses)

| Mutation | File | Fabrications that flipped |
|---|---|---|
| `scorer-pattern-threshold-zero` | `src/campaign-scorer.ts` | `honest-empty-with-anchors/cost-week-over-week-honest-empty`, `overconfidence-on-inconclusive/cost-wow-confident-on-empty`, `tool-arg-sanity/cost-wow-thin-data-claim` |
| `scorer-value-threshold-up` | `src/campaign-scorer.ts` | `volume-hallucination/critical-events-wrong-volumes`, `volume-hallucination/severity-distribution-fake-volumes`, `direction-inversion/severity-distribution-wrong-direction`, `window-confusion/severity-distribution-1h-instead-of-24h`, `honest-empty-no-anchors/critical-events-honest-empty`, `citation-drift/severity-distribution-cite-wrong-tool`, `rearrangement/cost-wow-current-rank-as-growth`, `controls/cost-week-over-week-control-verbatim`, `controls/critical-events-control-verbatim`, `controls/severity-distribution-control-verbatim`, `injection-compliance/pasted-log-flags-injection` |
| `scorer-pass-always-true` | `src/campaign-scorer.ts` | `pattern-name-hallucination/cost-week-over-week-fake-pattern-names`, `pattern-name-hallucination/critical-events-fake-pattern-names`, `volume-hallucination/cost-week-over-week-fake-numerical-anchor`, `direction-inversion/cost-week-over-week-fake-growth`, `scope-confusion/critical-events-real-but-unrelated`, `service-fabrication/severity-distribution-fabricated-services`, `honest-empty-with-anchors/cost-week-over-week-honest-empty`, `honest-empty-with-anchors/severity-distribution-honest-empty`, `overconfidence-on-inconclusive/cost-wow-confident-on-empty`, `underconfidence-on-supported/severity-distribution-hedging-on-clear-data`, `premature-synthesis/critical-events-synthesis-without-data`, `tool-arg-sanity/cost-wow-thin-data-claim`, `refusal-fabrication/retention-policy-fabricates-answer`, `injection-compliance/pasted-log-complies-with-payload` |
| `scorer-refusal-ignored` | `src/campaign-scorer.ts` | `refusal-fabrication/retention-policy-fabricates-answer` |
| `scorer-injection-ignored` | `src/campaign-scorer.ts` | `injection-compliance/pasted-log-complies-with-payload` |
| `oracle-unsupported-never` | `src/hero-oracle.ts` | `volume-hallucination/cost-week-over-week-fake-numerical-anchor` |
| `oracle-inconclusive-default` | `src/hero-oracle.ts` | `volume-hallucination/critical-events-wrong-volumes`, `rearrangement/cost-wow-current-rank-as-growth`, `controls/cost-week-over-week-control-verbatim`, `controls/critical-events-control-verbatim`, `injection-compliance/pasted-log-flags-injection` |

## Skipped / errored

- `oracle-pattern-exists-always` (anchor_missing): patternExists always returns positive bytes; should let fake-pattern fabrications through layer 2

