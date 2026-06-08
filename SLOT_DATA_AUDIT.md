# Slot-naming + slot-data audit — outcome

Final state after Phase A of slot-naming landed and the proposed expansion was reviewed by two outside judges (Grok 4.3, fresh Claude subagent) and the project owner.

## What slot-naming is, after Phase A

`src/lib/slot-naming.ts` derives logical field names from a template's static text per `$` slot. Layered match:

1. JSON-key context with depth-aware parent walking — `{"resource": {"service.instance.id": "$"` → `resource.service.instance.id`
2. KV-pair — `userId=$` → `user_id`; `decided on: $` → `decided_on` (verb-preposition compound)
3. Filename:line delimiter — `logger.go:$` → `line`
4. Noun-prefix vocabulary — `port $` → `port`
5. Cohort detection — 5 hex slots split by `-` → UUID cohort; IPv4 and MAC analogous

Verified against a 44-fixture cross-judge corpus (Grok + Claude subagent). Per-format accuracy:

| Family | Accuracy |
|---|---|
| JSON-formatted apps (Go, Python, Node, Rust) | 67-94% |
| K8s audit / structured security alerts | 58-83% |
| Java logback default + positional Postgres / syslog / nginx CLF / AWS VPC Flow / Windows Event Log | **0-17%** |

The positional-format gap is structural: those slot identities come from POSITION in a known layout, not surrounding text. Closing it requires engine-side cumulative observation, not more MCP-side heuristics.

## What's wired in today

- `pattern_examples` emits `slot_distribution[]` with `inferred_name`, `naming_confidence`, `naming_source`, `preceding_token`, plus a `cohorts[]` block for UUID/IPv4/MAC reassembly.
- `resolve_batch` surfaces `inferred_name` per slot.

That's it. Nine other tools that receive `ExtractedPattern` objects drop the slot data.

## What we explored — and what survives

A larger expansion was proposed (P0-P4 below). After review by both judges and the project owner, only one item survives as honest near-term work.

### Dropped — wrong frame or unreliable signal

- **P0 — `top_volume` cost-driver attribution.** Rejected. Cardinality-from-sample drives wrong cost decisions (a field constant in a 1h window may be 50-distinct over a week of rolling deploys). And moving a field from body to label doesn't reduce analyzer ingestion costs — analyzers charge on total event bytes regardless of where they sit. Cost framing was Cribl-playbook regex-recipe work; the agent angle didn't fix it.

- **P1 — `pattern_mitigate` cohort-aware ranking.** Rests on the same sample-cardinality signal as P0. Same failure mode. Park until engine emits population-level cardinality.

- **Cross-pattern correlation surface.** Both judges flagged systematic over-attribution: common infrastructure labels (`env=prod`, `region=us-east-1`) appear in every pattern by definition and would get presented as "root cause." Filters that prevent this (exclude all-pattern dominants; whitelist meaningful value-kinds; threshold ≥3 patterns × ≥40% dominance with template-family deduplication) are real work that doesn't exist yet. Shipping this without the filters would produce confident misdiagnosis. Park.

- **P4 — `investigate` cohort-delta detection.** Requires comparing slot distributions across time windows. Sample-vs-sample comparison has the same statistical hole. Real version requires engine-side longitudinal state. Move to the longitudinal track (see `ENGINE_LONGITUDINAL_PRIMITIVES.md`).

### Survives — small UX win, no statistical claims

- **P2 — `find_*` detectors use logical names in `fix_hint`.** The detectors (`find_skew`, `find_constant_slots`, `find_uuid_in_body`) already operate on slot statistics from the engine's aggregated metrics path. Today their `fix_hint` text references positional slot identifiers (`slot_4`). Calling `inferSlotName()` on the same slots and emitting `inferred_name` alongside makes the fix_hint readable. No new statistical claim — just label improvement on existing detector output.

- **P3 — `dependency_check` confirmed join keys.** Marginal. When `pattern_examples` has named a slot, surfacing it as a join-key candidate saves a `discover_join` roundtrip. Not high-impact alone; do it if it falls out cheaply.

## Discipline rules that emerged (carry forward)

Both judges and the user converged on these. They apply to ALL future tool-output design, not just slot naming:

1. **No interpretive labels** from sample data. Emit raw counts with explicit `sample_size` denominator. Drop "low cardinality" / "constant" / "noise" — let the agent read the numbers.
2. **No temporal verbs** in tool output. "Is" / "appears in" / "shares" — never "increased" / "drift" / "started" / "is now" / "spiking." Sample data has no time semantics; temporal verbs invite the agent to hallucinate trends from a snapshot.
3. **String-format ratios with denominators baked in**: `"195/250 (78%)"`, not `dominant_pct_in_sample: 0.78`. Agents copy strings faithfully but strip context from numeric ratios.
4. **No mitigation recommendations from sample-only data.** The agent can route TO mitigation tools, but the MCP doesn't say "drop this" based on what looks low-cardinality in 250 events.
5. **Population claims wait for engine annotations.** Cardinality drift, value-rarity claims, "this is increasing" — all wait for engine-side cumulative state.

## What unlocks the rest

The honest next track is engine-side cumulative cross-event observation surfaced through MCP — pattern genealogy, slot cardinality over time, deploy-diff, pattern drift. The slot-naming work makes patterns LEGIBLE; the longitudinal work makes them ACTIONABLE across time. That's the differentiator competitors can't replicate from a query layer over their own indexes.

Scope of that track: `ENGINE_LONGITUDINAL_PRIMITIVES.md`.

## Update — `pattern_diff` shipped

After a separate cross-judge review (Grok 4.3 + Claude subagent) focused on the first-seen capability, the first longitudinal primitive landed:

- **`log10x_pattern_diff`** — set diff of patterns across a time boundary. Returns `new` / `retired` / `persistent` / `re_emerged` plus `co_emergence_clusters` (deploy fingerprint without CI/CD integration). Source: `src/tools/pattern-diff.ts`. Doc: `mksite/docs/apps/mcp/tools/costs/pattern-diff.md`. Both judges identified this as the single highest-leverage move on the existing `first_seen` data.

Other ideas examined and parked:
- `pattern_genealogy(template_hash)` — repackaging existing data; defer until pattern_diff is exercised in real workflows.
- `still_emitting_now` flag on `whats_new` — cheap but commodity; not differentiated.
- Static `identity_stability` metadata field — both judges said agents ignore self-congratulatory tokens. Differentiation must show via tool BEHAVIOR.
- Cross-environment MCP coordination — architecture project; out of scope until single-env story tightens.
- CI/CD deploy event fetching — turns the MCP into an integration broker; expose timestamps, let the agent join externally.
