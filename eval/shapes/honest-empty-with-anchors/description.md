# Shape: honest-empty-with-anchors

Agent claims no data / nothing-firing when oracle has data, AND the spec has must_mention or top_patterns anchors that the empty answer fails to surface.

- **Caught today**: yes — must_mention / top_patterns enforcement

**Notes**: Only caught because the spec has anchors. See honest-empty-no-anchors for the no-anchor case.

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
