# Shape: rearrangement

Facts are individually correct but assembled in misleading narrative order — e.g., listing patterns ranked by 24h bytes but framing as week-over-week growth.

- **Caught today**: no

**Notes**: Semantic; needs LLM judge or structural template match.

## Fabrications

Each `fabrications/<id>.json` is a `(base_transcript, splice_finalText, expected_verdict)` triple. Re-scoring a fabrication via `bin/run-shapes.mjs` should produce `expected_verdict`; if it does not, the scorer has drifted with respect to this shape.

The aggregate is in [`../COVERAGE.md`](../COVERAGE.md).
