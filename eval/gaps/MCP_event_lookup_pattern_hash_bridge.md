# Product gap — paste-to-live-pattern bridge (cross-tier convergence)

**Severity**: low (in-batch path works on both `privacy_mode: true` and `privacy_mode: false`; only residual is small-batch convergence vs the live Reporter)
**Surfaced by**: Phase 11 paste-event-resolves-to-pattern hero scenario
**Re-verified empirically**: 2026-05-12
**Status**: both in-batch paths now work end-to-end after the apps/mcp rewrite landed (see [MCP_local_cli_single_event_drop.md](MCP_local_cli_single_event_drop.md)). Residual cross-tier divergence is a templater sample-size limitation, not a bridge bug.

## The user flow

Per the MCP catalog's "TOOL ROUTING BY USER INTENT" section, the canonical
flow when a user pastes a raw log line is:

> user pastes a raw log line, asks "what is this" → `log10x_event_lookup`

This is the #1 listed daily-habit operational entry point.

## What I tested (2026-05-12)

Seven probes against the talw.gx env + paste-Lambda templater:

| # | Test | Result |
|---|------|--------|
| 1 | g11.log single event via `resolve_batch` privacy_mode=true (local CLI) | **Drops input (0 patterns resolved)** — separate bug, see [MCP_local_cli_single_event_drop.md](MCP_local_cli_single_event_drop.md) |
| 2 | g11.log single event via `resolve_batch` privacy_mode=false (paste lambda) | Pattern name surfaces correctly: `opentelemetry_javaagent_tooling_VersionLogger_opentelemetry_javaagent_version` (Jaccard 0.56 > 0.3 threshold) |
| 3 | Phase 11 `checkout retry blast` line via `resolve_batch` paste lambda | Pattern name surfaces: `returned_after_retries_abandoning_cart_cart_id_cart_deploy_sha_run_id_idx` |
| 4 | 10-line multi-event mixed batch (4 logical patterns, 10 templates) | All pattern names surface; multiple templates → one pattern handled (#1 + #3 share `checkout_svc_...`) |
| 5 | `top_patterns` underscored canonical → `event_lookup` (live talw.gx ERROR pattern #14) | Resolves cleanly with full trend + service breakdown |
| 6 | Same as #5 but all-lowercase: `insufficient_memory` instead of `Insufficient_memory` | **No data found** — case-sensitive exact match required |
| 7 | 10-event identical-structure OOM batch → `resolve_batch` → `event_lookup` of resulting symbolMessage | **Diverges**: resolve_batch produced `available_pod_canary_app_aaa_Insufficient_memory_synthetic_canary_run_id_idx` (10 distinct templates, per-pod-suffix literals baked in). Live pattern is `are_available_pod_canary_Insufficient_memory_synthetic_canary_run_id_idx`. MCP fires its built-in "Tiny-batch note" warning correctly. |

## The gap (corrected after engine grounding)

The local CLI and the forwarder sidecar run the **same** engine binary.
The engine emits two artifacts when it processes events:

- `templates.json` — NDJSON, one record per template, keyed by
  `templateHash` (e.g., `4yR0svSmgt`) with the template body.
- `aggregated.csv` — one row per pattern, keyed by `message_pattern`
  (e.g., `opentelemetry_javaagent_tooling_VersionLogger_opentelemetry_javaagent_version`).

The engine's internal rule for mapping templates → patterns:
**"the longest pattern whose symbols appear in the target template
in the correct order belongs to it."** Multiple templates can share
one pattern; a single event gives one template + one pattern.

The engine does **not** emit this template→pattern mapping in
either output file. There is no `message_pattern` column in
templates.json and no `templateHash` column in aggregated.csv.
Both files describe the same population of events but cannot be
joined by any explicit key.

What the MCP does today: `log10x_resolve_batch` parses both files
and recovers the mapping via **Jaccard token-set similarity**
([cli-output-parser.ts](../../src/lib/cli-output-parser.ts) →
[resolve-batch.ts:132-145, 506-520](../../src/tools/resolve-batch.ts)):

```typescript
const aggTokenized = aggregated.map((r) => ({ row: r, tokens: tokenize(r.pattern) }));
for (const p of concentrations) {
  const tpl = templates.get(p.templateHash);
  const templateTokens = tokenize(canonicalizeToSymbolMessage(tpl.template));
  const best = bestJaccardMatch(templateTokens, aggTokenized); // threshold 0.3
  if (best) p.symbolMessage = best.row.pattern;
}
```

**Empirical finding (2026-05-12)**: this heuristic is **looser** than
the engine's actual rule (token-SET overlap vs in-order SUBSEQUENCE
match), but it works on every case I tested — single events, multi-event
mixed batches, and multi-template-to-one-pattern cases. The Phase 11
hash-only display (`OY?US|0X}_`) is **not currently reproducible** on
the same line.

## What's actually still broken

The **residual** gap is cross-tier convergence between resolve_batch's
locally-templatized symbolMessage and the live Prometheus pattern label:

- The local templater (whether CLI or paste-Lambda) under-samples on
  small batches. With 10 structurally-identical events, it produced
  10 distinct templates with per-line literals baked in, not 1
  converged template.
- The live Reporter ingests millions of events and generalizes the
  same variable slots correctly.
- Result: resolve_batch's symbolMessage on a small batch will **not
  match** the live `message_pattern` label that the same line shape
  is currently bucketed under in Prometheus.
- `event_lookup` requires an **exact case-sensitive match** on the
  pattern label — fuzzy / prefix lookup is not supported.

The MCP **already documents this** with its built-in "Tiny-batch note"
([resolve-batch.ts:215-228](../../src/tools/resolve-batch.ts)) which
fires when N_templates == N_events and pairwise Jaccard > 0.5. The
warning correctly advises users to "paste ≥50 events" or "use
`log10x_top_patterns` / `log10x_event_lookup` against the live Reporter."

What the warning doesn't do: automatically find the likely live pattern
and surface it inline.

## Proposed fixes (revised)

Option A — **engine-side join key** (still preferred long-term):
- Add a `message_pattern` field to each record in `templates.json`,
  or a `templateHash` column to each row in `aggregated.csv`.
- Eliminates the Jaccard heuristic.
- Doesn't fix the small-batch convergence problem — even with an
  explicit join, the local templater's pattern names diverge from
  the live engine's on small batches.

Option B — **MCP-side live-pattern fallback** (closes the user flow):
- After resolve_batch surfaces a symbolMessage, also call
  `log10x_top_patterns` with a token-overlap filter against the live
  Reporter. Surface the best live match as `likely live pattern: X
  (token overlap N/M)` inline in the user-facing output.
- Cost: 1-2 hours of code + a unit test.
- Closes the cross-tier divergence problem without engine changes.
- Handles the case where the small-batch templater diverges from
  the live engine's converged pattern.

Option C — **extend `log10x_event_lookup`** to accept a `raw_line`:
- Internally call the engine on the raw line to get
  (templateHash, message_pattern), then look up `message_pattern`
  in Prometheus.
- Still subject to small-sample divergence unless combined with
  Option B's live-pattern fallback.

**Recommendation**: ship Option B as a 1-2 hour patch. Option A is
nice-to-have for cleanliness but not load-bearing on the user flow.

## Evidence

- This doc's "What I tested" table — 7 probes, 2026-05-12.
- 7 hero-scenario transcripts under
  `eval/reports/hero/paste-event-resolves-to-pattern/` (Phase 11).
- The MCP's built-in tiny-batch warning at
  [resolve-batch.ts:215-228](../../src/tools/resolve-batch.ts).
