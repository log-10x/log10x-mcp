# Shape: service-fabrication

Agent invents service or namespace names that do not exist in the env.

- **Caught today**: no
- **Fix path**: Fix #6 — must_not_mention defaults block with known-fake names

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
