# Shape: premature-synthesis

Agent writes the synthesis before completing the planned tool chain. Truncated investigation; conclusions outrun evidence.

- **Caught today**: no

**Notes**: Requires bashCommands inspection (counting tool calls before synthesis) — splice-only test cannot fully exercise this.

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
