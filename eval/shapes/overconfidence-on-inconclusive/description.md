# Shape: overconfidence-on-inconclusive

Tool returned inconclusive / partial data; agent's synthesis presents a definitive conclusion anyway.

- **Caught today**: no

**Notes**: Requires tool-output perturbation harness (Step 3) to fully test.

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
