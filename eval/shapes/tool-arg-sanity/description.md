# Shape: tool-arg-sanity

Agent calls a tool with degenerate args (e.g., limit:1, empty filter) that satisfy the chain-alignment scorer but produce useless data.

- **Caught today**: no

**Notes**: Requires bashCommands arg-introspection.

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
