# Audit: Zod-default-bypass class bug across the MCP catalog

**Date**: 2026-05-10
**Trigger**: Round-2 Grok eval surfaced one instance in `top_patterns`
(`topk(undefined, …)` rendered when `limit` was absent because the
external harness called `executeTopPatterns` directly without
running args through `topPatternsSchema`).
**Question**: Are there other tools in the catalog with the same
shape — schema `.default(...)` for a value used in PromQL or
string concatenation, paired with no defensive `??` fallback in
the `executeFoo` body — that would crash or produce malformed
queries when called by a harness that bypasses Zod?

## Method

For each `src/tools/*.ts`:

1. List schema fields using `.default(...)`.
2. Open the corresponding `executeFoo(args, env)` and check whether
   the first ~20 lines apply a defensive `args.X ?? defaultValue`
   (matching the schema default) before the value is consumed.
3. Trace callers: only `src/index.ts` (MCP SDK runtime) and
   `eval/src/tool-registry.ts` (eval harness) call the
   `executeFoo` functions in this repo. Both apply the schema
   before dispatch (`parseArgs(schema, raw)` in the eval registry,
   `inputSchema` validation by the MCP SDK in index.ts).

## Findings

### Already defended (10)

These tools have explicit `args.X ?? defaultValue` guards matching
their schemas:

- `cost-drivers.ts` — `timeRange ?? '7d'`, `limit ?? 10`, `analyzerCost ?? 1.0`
- `top-patterns.ts` — `timeRange` and `limit` guarded (the bug catch from Grok round 2)
- `trend.ts` — `timeRange ?? '7d'`, `step ?? '1h'`, `analyzerCost ?? 1.0`
- `services.ts` — `timeRange ?? '7d'`, `analyzerCost ?? 1.0`
- `savings.ts` — `timeRange ?? '7d'`, `analyzerCost ?? 1.0`, `storageCost ?? DEFAULT`
- `list-by-label.ts` — `timeRange` and `limit` guarded
- `pattern-examples.ts` — guards present
- `discover-labels.ts` — `limit` guarded
- `discover-join.ts` — guards present
- `event-lookup.ts` — guards present

### No defensive guard, BUT no caller bypasses schema (10)

These tools have schema defaults and no defensive guard, but every
caller in the repo runs args through the schema first:

- `investigate.ts` (`window:'1h'`, `confidence:'normal'`, `use_bytes:false`)
- `retriever-query.ts` (`to:'now'`, `limit:500`, `mode:'events'`, `step:'5m'`)
- `retriever-series.ts` (`to:'now'`, `step:'5m'`, `step_strategy:'auto'`)
- `customer-metrics-query.ts` (`mode:'instant'`)
- `backfill-metric.ts` (`step:'5m'`, `agg:'count'`, `to:'now'`, `dry_run:false`)
- `correlate-cross-pillar.ts` (`window:'1h'`, `step:'60s'`, `mode:'normal'`, `min_confidence:0.3`)
- `translate-metric-to-patterns.ts` (same pattern as above)
- `exclusion-filter.ts` (`mode:'config'`)
- `resolve-batch.ts` (`top_n_patterns:20`, `include_next_actions:true`, `privacy_mode:true`)
- `extract-templates.ts` (`top_n:50`)

## Conclusion

**No new defensive guards needed.**

The Grok-round-2 finding was a real bug, but it was specifically
about an external harness that called `executeTopPatterns` without
parsing through `topPatternsSchema`. The fix in `top-patterns.ts`
hardened the function for that direct-call path. The same external
harness calling any of the other 10 tools in the second list above
WOULD produce the analogous bug — but no caller in this repo or in
the eval harness exhibits that shape. Speculatively adding 10 more
defensive blocks would:

- Add code without a real exercising caller.
- Drift away from the schema as the source of truth for defaults
  (now you maintain the default in two places per tool).
- Violate the "don't add error handling for scenarios that can't
  happen" principle in CLAUDE.md.

The existing 10 defensive guards are tracked-down patches for
specific reproducer paths. If a future external eval harness
(e.g., a cross-vendor evaluator) lands and exercises the
`executeFoo` functions directly, the right move is to make THAT
harness parse through the schema (the way `tool-registry.ts`
does), not to mirror defaults into every tool body.

## Action items

- [x] Audit complete; documented here.
- [ ] If a future harness lands that bypasses Zod and trips one of
      the 10 unguarded tools, add the matching `??` line and a
      comment pointing back here for context.
- [ ] (Optional, low priority) Consider extracting a
      `parseAndDispatch(schema, raw, executeFn)` helper so any
      external caller that imports `executeFoo` directly is
      nudged into the schema-validating path.
