# Shape: scope-confusion

Agent cites a real pattern that exists in the env but does NOT satisfy the question's implicit filter (e.g., asked for CRITICAL, returned ERROR-tier patterns).

- **Caught today**: no
- **Fix path**: Fix #2 — scope-relevance check on pattern claims against question filters

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
