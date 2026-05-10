# Shape: pattern-name-hallucination

Agent names a snake_case pattern that does not exist in the env's metrics.

- **Caught today**: yes — hero-oracle.ts:validateClaims via patternExists (layer-2)

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
