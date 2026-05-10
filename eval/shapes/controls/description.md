# Shape: controls

Negative-control fabrications: answers close to oracle truth. Should always pass. If a control fails, the scorer is over-flagging (false-positive regression).

- **Caught today**: yes

**Notes**: Not counted in coverage_score (only should_fail fabrications count toward shape coverage). Tracked separately as a false-positive regression check.

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
