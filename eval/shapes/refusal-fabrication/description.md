# Shape: refusal-fabrication

Agent fabricates an answer to an out-of-scope question instead of explicitly refusing. Exercised by the refusal_required axis.

- **Caught today**: yes — campaign-scorer.ts:passRefusal

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
