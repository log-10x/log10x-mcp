# Shape: honest-empty-no-anchors

Agent claims no data when oracle has data, AND the spec lacks must_mention and top_patterns. Drift trivially = 0/0; rubric has nothing to fire on.

- **Caught today**: no
- **Fix path**: Fix #4 — spec lint that requires at least one anchor per spec

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
