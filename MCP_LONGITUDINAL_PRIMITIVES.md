# MCP-side longitudinal primitives — scope

## Why this exists, and what the engine's role actually is

Slot-naming + sample-local heuristics make pattern data legible but don't differentiate the product. Any competitor with a JSON parser + a query engine can match "78% of these errors share `client_ip=10.0.1.5`" over their own indexes. The differentiation comes from **temporal observation anchored on `pattern_hash` that survives log-format drift** — the engine's stable identity property.

But the engine itself **does not store longitudinal history per slot**. Its role is stream processing: classify, cap, compact. It reads the incoming event firehose and emits both a compact stream and pattern-level Prometheus metrics. It is the wrong layer for durable per-(pattern, slot) state across days.

The historical stores that DO exist:

- **TSDB (Prometheus / Mimir / Cortex / Datadog Prom / GCP Managed)** — durable home for the engine's emitted metrics. Pattern-level: bytes per pattern, events per pattern, keyed by `pattern_hash × service × severity × env`. Retention per Prom config (typically days to weeks). Queryable via PromQL. **This is where pattern-level temporal data lives.**
- **SIEM** (Splunk / Datadog / Elastic / CloudWatch) — durable home for raw events. Retention per the analyzer's policy. Queryable via vendor-specific syntax. **This is where slot-level historical data lives** — to compute slot statistics at time T, the MCP samples events at T from the SIEM and runs them through the `tenx` CLI templater.

Longitudinal primitives are therefore **MCP orchestration over TSDB + SIEM**, not engine PRs. The engine stays focused.

## Two distinct cost classes

| Class | Backed by | Per-query cost | Reasonable to inline as descriptor enrichment? |
|---|---|---|---|
| **Pattern-level temporal** (bytes trajectory, first/last seen, slope, set membership across windows) | TSDB | 1 PromQL query, often parallelized | Yes — when the tool already queries TSDB |
| **Slot-level temporal** (cardinality drift, value-distribution shift, value-kind transitions, schema drift) | SIEM + `tenx` CLI | N × (SIEM query + templater pass) per N-anchor comparison | No — belongs in dedicated drill-down tools |

The latency / cost asymmetry is structural, not a bug to optimize away. Two SIEM samples + two templater passes for a "did slot_4 drift this week?" question is a real piece of work. Dedicate a tool name to it so the cost is visible.

## Primitives — current status + scope

### 1. `pattern_diff(timeRange)` — **SHIPPED**

Status: Live as `log10x_pattern_diff`. See `src/tools/pattern-diff.ts` and the user doc at `mksite/docs/apps/mcp/tools/costs/pattern-diff.md`.

Backed by: TSDB (two `bytes_per_pattern` queries at current window and offset window) + `fetchFirstSeenBatch` (TSDB metric backscan).

Claim: which patterns existed before the boundary but not after (retired), which existed after but not before (new), which existed in both (persistent), and which were flagged-new but actually existed earlier and went silent (re_emerged). Plus co-emergence clusters (3+ patterns sharing first_seen within ±60s — a deploy fingerprint without CI/CD integration).

Why differentiated: pattern_hash is stable across log-format drift, so the set diff is COHERENT. On any re-clustering competitor, the pattern IDs on each side of the boundary aren't comparable; the set diff is incoherent.

### 2. `pattern_genealogy(pattern_hash)` — TSDB-only, deferred

Status: not built. Both judges (Grok 4.3 + Claude subagent) ranked this lowest among the proposed primitives — "repackaging" of data already accessible via existing tools.

If built: returns first-seen + last-seen + lifetime event total + services that emitted it + peak rate + when, all from TSDB metrics. Pure consolidation tool.

Defer until pattern_diff is exercised in real workflows. The components are already available piecemeal; bundling them buys little until there's evidence agents are repeatedly chaining the same 3-4 queries to reconstruct the genealogy view.

### 3. `slot_cardinality_history(pattern_hash, slot, time_windows[])` — SIEM-orchestrated, expensive

Status: not built. **Heavy** — one SIEM query + one templater pass per time anchor.

If built: for the given pattern and slot, runs N SIEM samples at the requested time windows, templates each, extracts that slot's distinct count + dominant value at each anchor. Returns the curve.

Cost example: 30 daily anchors over the last month = 30 SIEM queries + 30 templater passes. Maybe 1-2 seconds each = ~30-60s total wall time. Real product-level expense. Not a discovery tool — an explicit deep-dive.

Use case: "show me how slot_4's cardinality evolved over the last month." Most useful when paired with pattern_diff that already flagged the slot as interesting.

### 4. `pattern_schema_drift(pattern_hash, before_window, after_window)` — SIEM-orchestrated, expensive

Status: not built. Same cost class as #3.

If built: takes a pattern + two time windows. Samples events from SIEM at each window, runs `tenx` CLI templater on each sample, computes slot_distribution + cohorts at each window, diffs them. Surfaces:
- Slots whose distinct counts changed materially (cardinality drift)
- Slots whose dominant value changed (value-shift)
- Slots whose value-kind classification flipped (was UUID, now hex IDs)

Use case: "did this pattern's structure change after the deploy?" — direct schema-drift signal that nobody else can produce, because it requires both stable pattern identity AND structural templater output.

## Output shape — same discipline rules as the rest of the catalog

- No interpretive labels — emit counts and stamps, not "drift detected" / "spiking" / "anomalous."
- Temporal verbs ALLOWED in these tools (they're explicitly time-aware), but grounded in actual two-timestamp observation. "Pattern existed at T₁ and absent at T₂" — yes. "Pattern is rising" without two samples — no.
- Every numeric carries denominator + window stamps.
- String-format ratios with denominators baked in (per the agent-faithfulness rule from prior cross-judge review).
- Cross-window claims are pairwise comparisons of two deterministic snapshots, not statistical models.

## Where this is hard to copy

Any competitor running over their own indexed log store can compute these IF they have stable pattern identity. They don't — log-format mutations rotate their hashes. log10x's templater maintains identity across those mutations because it operates on field-set structure, not raw text.

Moat chain:
1. Template extraction with stable identity → engine work (exists).
2. Per-pattern TSDB metrics → engine emits, TSDB stores (exists).
3. Raw event retention → SIEM provides (customer infra).
4. MCP orchestration over 1+2+3 → this track.

A competitor missing layer 1 cannot produce primitives 1, 3, or 4 honestly. They fall back to commodity `min(timestamp)` queries with no semantic stability.

## What's NOT in scope

- **Anything sample-bounded with temporal-verb claims.** Today's sample of 250 events does NOT support "is rising / spiking / drifting." Those need real two-anchor observation.
- **Statistical anomaly detection / ML scoring layers.** Determinism is the design rule. Two-anchor diffs and pairwise comparisons only.
- **Cross-environment correlation.** Staging→prod pattern promotion is real but premature; multi-env MCP coordination is a substantial architecture project. Cheap intermediate: agent runs the same tool against env A and env B, joins results client-side.
- **Engine PRs to expose per-slot durable state.** The engine is stream processing. Asking it to retain slot-level historical state per pattern is the wrong layer.

## Open questions before any of #3, #4 ships

1. **Time-window resolution.** Daily anchors? Hourly? Affects N (number of SIEM queries) linearly. Sensible default + customer-configurable.
2. **SIEM-side query cost amortization.** Can a single SIEM query return events spanning multiple time buckets, then we partition client-side? Cheaper than N separate queries. Per-vendor: Splunk yes, Datadog conditional, CloudWatch no.
3. **Templater throughput at scale.** N × templater passes for high-N curves is the latency bottleneck. Parallelize where possible. The local-CLI mode (replacing paste-Lambda) helps because no network roundtrip per pass.
4. **Backfill / retention.** New deploys start accumulating TSDB metrics from T=0. Slot-level history is bounded by SIEM retention (which is the customer's analyzer, not log10x's concern).

## Next concrete step

Pattern_diff is live and being exercised. Before scoping #2-#4 in detail, evaluate pattern_diff usage from real workflows for ~2 weeks — does the agent reach for it, does it answer the questions, what follow-ups does it chain into? That tells us whether the next primitive is #3 (slot cardinality history) or #2 (genealogy consolidation) or something the usage data surfaces we didn't predict.
