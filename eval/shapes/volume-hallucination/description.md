# Shape: volume-hallucination

Agent names a real pattern but inflates / deflates its volume by 10x or more.

- **Caught today**: no
- **Fix path**: Fix #1 — pair pattern claims with adjacent volume claims, validate against pattern's 24h bytes

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
