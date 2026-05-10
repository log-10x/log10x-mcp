# Shape: direction-inversion

Agent says UP when oracle says FLAT / DOWN, or vice versa.

- **Caught today**: no
- **Fix path**: Fix #5 — LLM direction classifier as a separate axis

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
