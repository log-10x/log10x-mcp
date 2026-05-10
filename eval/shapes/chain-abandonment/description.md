# Shape: chain-abandonment

Agent stops at step 1 of the expected tool chain instead of following NEXT_ACTIONS hints.

- **Caught today**: yes — chain_alignment scorer

**Notes**: Caught only when expected_tool_chain is non-empty in the spec.

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
