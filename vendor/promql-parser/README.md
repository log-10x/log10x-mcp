# promql-parser (vendored)

Vendored copy of [guychouk/promql-parser](https://github.com/guychouk/promql-parser)
@ commit-as-of 2026-05-14. MIT-licensed (see LICENSE).

Source files:
- `promql.js` — generated parser (~91KB) — what `metrics-backend.ts:DatadogBackend` imports
- `promql.pegjs` — PEG.js grammar (reference; not used at runtime)
- `index.d.ts` — TypeScript types for the AST

Not on npm; vendored rather than git-deps for hermetic builds.
