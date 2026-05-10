# Shape: citation-drift

Agent quotes a number or pattern as having come from tool A when it actually came from tool B (or no tool at all).

- **Caught today**: no

**Notes**: Hard to detect without parsing the agent's attribution claims. Possible via LLM judge.

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
