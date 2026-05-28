# Cross-pillar primitives + investigate — agent behavior contract

This contract covers the three cross-pillar primitives (`log10x_metrics_that_moved`, `log10x_rank_by_shape_similarity`, `log10x_metric_overlay`) AND the orchestrating `log10x_investigate` tool. They share the same envelope-shape principles and the same auto-mitigation gate.

The realistic caller is an AI agent reasoning over an incident, not a human typing into a CLI. This document specifies how the agent SHOULD branch on each tool's output. It is part of the tool's API surface — schema descriptions reference it.

The cross-pillar primitives take a log-pattern anchor and customer-TSDB metric candidates and answer "which metrics moved with this log pattern, when, and by how much." The `log10x_investigate` tool orchestrates a fuller narrative: anchor resolution, trajectory-shape detection, lag correlation, temporal-evidence chain, recommended next actions.

**Customer TSDB** = the customer's metrics backend, accessed via a PromQL-compatible read API. Supported backends include self-hosted Prometheus, Mimir, Cortex, AWS Managed Prometheus, GCP Managed Prometheus, Grafana Cloud Mimir, Datadog (Prometheus-compatible read API), and Log10x Cloud. The tools work against any of these via the adapter layer in `src/lib/customer-metrics.ts`.

## Composition

The three tools are designed to compose:

```
log10x_metrics_that_moved
    ↓ (caller passes moved[i].metric_ref forward)
log10x_rank_by_shape_similarity
    ↓ (caller passes ranked[0].metric_ref forward)
log10x_metric_overlay
```

Step 1 is a cheap deterministic filter — cuts the candidate pool from hundreds to a handful. Step 2 ranks the survivors by Pearson similarity + signed lag. Step 3 returns aligned timeseries for visual or programmatic verification of the top suspect.

`metric_ref` is round-trippable. Pass the value from one tool's output directly into the next tool's input — no reformatting.

## Output envelope (shared across all three)

Every tool returns a `StructuredOutput` envelope. The `data` block always carries:

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | enum | Top-level call state. Branch on this BEFORE reading any other field. |
| `threshold_used` | number | The numeric threshold applied (phase gap floor, phase-aligned floor). |
| `threshold_basis` | `"unvalidated_default"` \| `"caller_override"` | Provenance of the threshold. |
| `threshold_audit` | object | **Floor + observed-distribution disclosure.** See below. |
| `anchor_ref` | `{ type, expression }` | Echo of the anchor used. Survives multi-tool chains so the agent doesn't lose context. |
| `anchor_dispersion` | number | CV of the anchor over the window. Zero = no phase separation. |
| `n_candidates_usable` | number | Candidates that produced usable signal (excludes evaluation_failed). |
| `low_candidate_count` | `"severe"` \| `"medium"` \| `null` | Tier on usable-N. |
| `query_count` | number | Total backend queries the tool issued. |
| `total_latency_ms` | number | Sum of per-query latencies. |
| `backend_pressure_hint` | `"ok"` \| `"slow"` \| `"throttled"` \| `null` | Coarse rate-pacing signal. |
| `human_summary` | string | One paragraph in plain prose for paste-to-user. Always references both the floor and the observed distribution when applicable. |
| `error` | `PrimitiveError` (optional) | Populated only when `status === "error"`. |

Tool-specific fields (`moved[]`, `ranked[]`, `series[]`, `facts`) sit alongside the shared block.

### `threshold_audit` — honest disclosure path

The tools do NOT auto-calibrate. Every consult round on inline auto-calibration (median CV, P25, agent-supplied seeds) was rejected as statistical theater without external ground truth. Instead, the tools surface the data the caller would calibrate from, alongside the floor it was compared to. The agent (or human) reads the distribution next to the floor and decides per-call.

Each tool's `threshold_audit` field shape:

**`metrics_that_moved`**:
```ts
threshold_audit: {
  phase_gap_floor: { value: number; basis: "unvalidated_default" | "caller_override" };
  observed_phase_gap_distribution: { n, min, p25, p50, p75, max } | null;
}
```

**`rank_by_shape_similarity`**:
```ts
threshold_audit: {
  anchor_phase_aligned_floor: { value, basis };
  lag_search_max_abs: { value, basis };
  observed_pearson_magnitude_distribution: { n, min, p25, p50, p75, max } | null;
  observed_anchor_phase_gap_distribution: { n, min, p25, p50, p75, max } | null;
  n_lag_at_bound: number;  // candidates whose peak landed at the search boundary
}
```

**`metric_overlay`** does not have thresholds and does not emit `threshold_audit`.

How the agent reads this:
- Floor 0.15, observed `{p50: 0.08, p75: 0.12, max: 0.85}` → floor is comfortably above the bulk of the noise; the candidate at 0.85 is a real mover.
- Floor 0.15, observed `{p50: 0.22, p75: 0.38, max: 0.92}` → floor is BELOW the noise floor for this backend; most "moved" candidates are likely noise. Treat results with extreme skepticism, or raise the floor.
- Floor 0.15, observed `{p50: 0.03, p75: 0.04, max: 0.07}` → no candidate crossed the floor. Either re-anchor or widen the candidate pool — the floor isn't the problem, the absence of movement is.

## Status branching — the agent contract

### `status: "success"`

The math ran cleanly. Read tool-specific output.

Agent SHOULD:
- Read `human_summary` for a one-paragraph paste-to-user.
- Read `moved[]` / `ranked[]` / `series` + `facts` for structured detail.
- Check `threshold_basis`. If `unvalidated_default`:
  - Do NOT auto-mitigate based on this result alone.
  - When presenting to a human, include "thresholds are uncalibrated for this backend."
- Check `low_candidate_count`. If `severe`, require corroboration from another signal (trace, deploy event, alert) before acting.
- Check `backend_pressure_hint`. If `slow` or `throttled`, pace subsequent calls or narrow the next candidate pool.

### `status: "anchor_no_phase_separation"`

The anchor doesn't have a real busy/quiet split (dispersion below 0.15). The phase-partition math is structurally meaningless on this anchor. The tool refuses cleanly.

Agent SHOULD:
- NOT retry the same anchor with the same window — the math will keep refusing.
- Read `anchor_dispersion` to confirm the actual value.
- Choose one of:
  - Re-anchor with a different log pattern that has a clearer incident shape.
  - Widen the window so a busy/quiet split appears.
  - Stop — there may genuinely be no signal here.

`moved[]`, `not_moved[]`, `evaluation_failed[]`, `ranked[]` are empty by design. Don't treat them as "no movement found" — the partition was refused, no candidate was evaluated.

### `status: "no_signal"`

The math ran, but no candidate produced a meaningful signal — every candidate was evaluated and either fell below the threshold or returned r ≈ 0.

Agent SHOULD:
- Stop searching with this anchor + candidate set. Do NOT call the same tool again with the same inputs.
- Read `n_candidates_usable` to confirm enough candidates were actually evaluated.
- Choose one of:
  - Widen the candidate pool (different label scope).
  - Re-anchor.
  - Conclude "no detectable cross-pillar signal" and report that.

The difference vs `anchor_no_phase_separation`: the anchor was fine, the candidates simply didn't move with it.

### `status: "error"`

A structural failure (backend down, schema invalid, anchor query 404, etc.) prevented analysis. `data.error` is populated.

Agent SHOULD:
- Read `data.error.error_type` and branch:

| `error_type` | Meaning | Agent action |
| --- | --- | --- |
| `backend_unavailable` | Backend returned 502/503/504 OR connection failed. | Retry after `suggested_backoff_ms`. |
| `backend_timeout` | Backend returned 408 or 429. | Retry after `suggested_backoff_ms` (longer for 429). |
| `anchor_not_found` | Backend returned 404 OR anchor query produced too few buckets. | Do NOT retry the same query. Re-anchor or widen the window. |
| `schema_invalid` | Backend returned 400/422 — the PromQL was malformed. | Do NOT retry the same query. Fix the syntax. |
| `candidate_too_many` | Caller exceeded the schema cap (100). | Split into batches and re-call. |
| `partial_failure` | Some candidates succeeded; check `evaluation_failed[]`. | Process successful candidates; optionally retry failed ones. |
| `unknown` | Unmapped error. | Log + surface to user. Do NOT auto-retry. |

- Check `retryable`. If `false`, never auto-retry — the error is permanent for this input.
- Check `suggested_backoff_ms`. Wait at least this long before retrying.

## Auto-mitigation gate

The single most important rule:

**An agent MUST NOT trigger auto-mitigation (rollback, restart, alert dismissal, scale-down) based on a primitive output where `threshold_basis === "unvalidated_default"`.**

The default thresholds (0.15 phase gap, 1800s lag search range) come from one synthetic chaos test. They are not calibrated for any specific customer backend. Acting on an uncalibrated finding risks false-positive rollbacks of services that didn't actually cause the problem.

Allowed actions on uncalibrated findings:
- Surface to a human with full context (`human_summary` paste + uncalibrated tag).
- File a low-priority ticket for human review.
- Continue the investigation chain (calling the next primitive).

Once a customer has calibrated the thresholds (overrides via `phase_gap_floor`, `lag_search_max_abs`, `anchor_phase_aligned_floor`), the agent sees `threshold_basis: "caller_override"` and the auto-mitigation gate lifts.

## Calibration playbook

The default thresholds are placeholders. For a real customer backend, calibrate per backend:

1. Pick a metric in the customer's TSDB that you know has a real busy/quiet split (e.g. `node_cpu_seconds_total` during a known incident window).
2. Run `log10x_metrics_that_moved` with a small candidate set you know co-moves with that anchor. Note the gaps the tool reports for true positives.
3. Run again with candidates you know DON'T co-move (e.g. unrelated services). Note the gaps the tool reports for true negatives.
4. Pick `phase_gap_floor` between the two distributions — typically the 95th percentile of the noise distribution.
5. Repeat for `lag_search_max_abs` (longest known cascade time × 2) and `anchor_phase_aligned_floor` (same as `phase_gap_floor` is fine).

The chaos generator at `backend/terraform/demo/chaos.tf` produces a known-shape signal you can use as a calibration anchor in a test environment. See `backend/terraform/demo/README.md` "First-customer-pilot validation playbook" for the 4-shape matrix.

## `log10x_investigate` envelope additions

Investigate composes its narrative from the same primitives plus a separate trajectory-shape and lag-correlation pipeline. Its envelope reuses the shared fields (`status`, `threshold_basis`, `anchor_ref`, `total_latency_ms`, `human_summary`) with these additions:

| Field | Type | Meaning |
| --- | --- | --- |
| `findings[]` | array | Structured evidence rows. Each has `pattern`, `service`, `lag_seconds`, `confidence`, `evidence_strength` (strong/medium/weak), `kind`, and a `suggestion` for the agent's next move. |
| `n_chain_steps` | number | Length of the temporal chain extracted from the report. |
| `n_co_movers` | number | Lower-confidence co-mover count. |
| `report_markdown` | string | Full long-form narrative for paste-to-user. |
| `shape` | enum | `acute` / `drift` / `environment` / `no_significant_movement` / `empty`. |
| `mode` | enum | `pattern` / `service` / `environment` / `raw_line`. |
| `investigation_id` | uuid | Cache key for later retrieval. |

### Investigate-specific status states

`success`, `no_signal`, `insufficient_data`, `error` — same semantics as the primitives, plus:

- `insufficient_data` fires when the anchor resolves but trajectory analysis can't produce a usable shape (window too short, sparse backend coverage, anchor below noise floor). Agent should widen the window or re-anchor.
- `no_signal` fires when the anchor moved but no co-mover crossed the confidence threshold. The investigation IS valid but produced no leads. Agent should stop searching with this anchor.

### Investigate-specific threshold provenance

Investigate has its own threshold pile (clean-chain confidence floor, acute noise floor, drift slope per severity, max co-movers for lag, etc.) defined in `src/lib/thresholds.ts`. Provenance values:

- `unvalidated_default` — `LOG10X_THRESHOLDS_FILE` env var not set; using hand-picked SPEC_DEFAULTS.
- `config_file` — `LOG10X_THRESHOLDS_FILE` points at a calibrated config (operator took ownership).
- `caller_override` — reserved for future per-call threshold overrides (not exposed yet).

Same auto-mitigation gate applies: agents MUST NOT auto-mitigate when `threshold_basis === "unvalidated_default"`.

### Investigate output framing — observations, not verdicts

The investigate template uses observation-shaped headings:

- "Strongest temporal evidence (lead by lag time, not proven cause)"
- "Temporal chain (lead-time order, not proven cause)"
- "Co-movers (lower confidence)"

The `human_summary` field always includes the phrase "correlation, not proven cause" when a lead is identified. Agents reading this output and presenting it to a human MUST preserve that framing. Reframing as "the cause is X" violates the contract.

## `log10x_find_skew` envelope additions

`log10x_find_skew` is a paste-mode tool — the caller supplies events (raw strings or JSON), the tool templates them locally and surfaces patterns where one slot value dominates. It does NOT query a customer TSDB, so the network-shaped fields (`query_count`, `backend_pressure_hint`) are no-ops.

It DOES share the same envelope shape and the same calibration honesty as the cross-pillar primitives:

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | enum | `success` / `no_signal` / `insufficient_data` / `error` |
| `threshold_basis` | enum | `unvalidated_default` / `caller_override` |
| `threshold_audit` | object | floor + observed distribution (see below) |
| `input_ref` | object | echo of the input size: `n_events`, `n_patterns_after_templating`, `n_patterns_above_min_events` |
| `query_count` | `0` | paste-mode tool, no backend queries |
| `total_latency_ms` | number | wall time of the templating + detection |
| `backend_pressure_hint` | `null` | not applicable |
| `human_summary` | string | one paragraph; references floor + observed median when applicable |
| `findings` | array | the skew findings (existing field) |
| `error` | `PrimitiveError` | populated only when `status === "error"` |

`threshold_audit` for find_skew:
```ts
threshold_audit: {
  min_concentration: { value: number; basis: "unvalidated_default" | "caller_override" };
  sample_n: { value: number; basis };
  observed_dominant_pct_distribution: { n, min, p25, p50, p75, max } | null;
  n_candidate_slots: number;
}
```

How the agent reads it:
- Floor 0.60, observed `{p50: 0.30, p75: 0.45}` → floor is well above the dataset's noise; treat findings as real signal.
- Floor 0.60, observed `{p50: 0.75, p90: 0.95}` → almost every slot is dominated; the floor is too low for this dataset, treat the `findings` count with skepticism.
- Floor 0.60, observed `{p50: 0.10, max: 0.40}` → no slot crossed; `status: "no_signal"` is the expected outcome.

### find_skew-specific status semantics

- `success`: ≥1 finding above the concentration floor.
- `no_signal`: ≥1 pattern qualified (had ≥ min_events) but no slot crossed the floor. Stop searching — either widen the input or lower the floor.
- `insufficient_data`: NO pattern had ≥ min_events after templating. Paste more events for the same patterns or widen the source.
- `error`: input failed validation OR templater crashed. Read `data.error.error_type` (`input_invalid` / `local_processing_failed`).

### find_skew error types

| `error_type` | Meaning | Agent action |
| --- | --- | --- |
| `input_invalid` | Empty events, malformed payload, or input failed validation. | Do NOT retry the same input. |
| `local_processing_failed` | Templater crashed (typically because the privacy_mode tenx CLI isn't installed or the input shape is unparseable). | Surface to user; retry only if the underlying cause is resolved. |

## `log10x_pattern_mitigate` envelope additions

`log10x_pattern_mitigate` is action-shaped: it doesn't perform the action itself, but it generates the menu of options + routes the agent to the right sub-tool for each. The audit work focuses on capability-detection provenance, not numerical thresholds.

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | enum | `success` / `no_signal` / `insufficient_data` / `error` |
| `recommendation_basis` | enum | `env_config` / `env_config_plus_snapshot` / `snapshot` / `env_vars_only` / `unknown` — analogue of `threshold_basis` for action-shaped tools |
| `recommendation_audit` | object | per-capability source + snapshot age (see below) |
| `pattern_ref` | string | echo of the input pattern |
| `query_count: 0`, `total_latency_ms`, `backend_pressure_hint: null` | — | paste-mode-style telemetry; no backend queries |
| `human_summary` | string | references the basis prominently so the agent knows whether to auto-route |
| `options[]` | array | the 4 mitigation paths with `enabled` + `disabled_reason` (existing field) |
| `env_capabilities` | object | resolved capability flags (existing field) |
| `error` | `PrimitiveError` | populated only when `status === "error"` |

`recommendation_audit` shape:
```ts
{
  basis: RecommendationBasis,
  n_options_enabled: number,
  n_options_dimmed: number,
  capability_sources: {
    gitops: "envs_json" | "env_var" | "snapshot" | "absent",
    forwarder: "envs_json" | "env_var" | "snapshot" | "absent",
    analyzer: "envs_json" | "env_var" | "snapshot" | "absent",
    receiver: "snapshot" | "absent",
    retriever: "snapshot" | "absent",
  },
  snapshot_id?: string,
  snapshot_age_seconds: number | null,
}
```

### pattern_mitigate-specific status semantics

- `success`: ≥1 of the 4 options is enabled and routable.
- `no_signal`: pattern is valid but NO option is reachable (zero env config, no snapshot, no env vars). `human_summary` carries the setup hint.
- `insufficient_data`: pattern argument empty or whitespace-only.
- `error`: env-load crashed or another structural failure.

### pattern_mitigate-specific auto-mitigation gate

This is the auto-mitigation gate sharpened for action-shaped tools. Agents SHOULD:

1. Surface the option menu to the user. NEVER call the chosen sub-tool until the user picks.
2. When `recommendation_basis === "env_vars_only"` or `"snapshot"`: warn that capability detection used a single source. The user should confirm before the agent routes.
3. When `recommendation_basis === "env_config_plus_snapshot"` and `snapshot_age_seconds > 3600`: warn the snapshot is stale; capability flags may have drifted.
4. When `recommendation_basis === "unknown"` and `status === "no_signal"`: tell the user the env is unconfigured and surface `human_summary` (which carries the setup hint).
5. Always call `log10x_dependency_check` before any drop / mute path — already in the tool's `next_actions[]` chain.

### pattern_mitigate error types

| `error_type` | Meaning | Agent action |
| --- | --- | --- |
| `input_invalid` | Empty / whitespace-only pattern. | Do NOT retry the same input. Ask the user for the canonical pattern name. |
| `local_processing_failed` | Env-load or snapshot fetch crashed unexpectedly. | Surface the hint to the user; investigate the local config. |

## Low-woowoo data tools — envelope-consistency tier

The 14 data tools (`top_patterns`, `top_volume`, `pattern_trend`, `event_lookup`, `pattern_examples`, `resolve_batch`, `extract_templates`, `services`, `savings`, `dependency_check`, `discover_env`, `discover_labels`, `discover_join`, `customer_metrics_query`) don't make calibrated judgments — they return data. They DO carry the shared envelope fields so the agent reads a consistent shape across the catalog:

- `status` (generic enum: `success` / `no_signal` / `insufficient_data` / `error`, OR a tool-specific enum on the few tools that already had one like `discover_join`)
- `query_count`, `total_latency_ms`, `backend_pressure_hint` (telemetry — agent paces subsequent calls)
- `human_summary` (paste-to-user paragraph)
- `error: PrimitiveError` (only when status === error)

These were added via `src/lib/unified-envelope.ts`'s `buildUnifiedFields()` helper. The depth of the audit is intentionally shallower than the calibrated tools — these don't need `threshold_basis` / `threshold_audit` because they don't have calibrated thresholds.

What this tier DOES NOT include (deferred to selective review):
- Per-tool error envelope conversion of every failure path. Most tools still throw on backend errors; the throws propagate through the MCP wrapper.
- Per-tool human_summary tailoring beyond reuse of the existing headline.
- Per-tool `no_signal` semantics for nuanced cases (e.g. "0 patterns returned" vs "service has no data").

The shared envelope-conformance test in `test/envelope-conformance.test.ts` exercises a subset of the tools (paste-mode ones that can run without a live backend) to pin the field presence in CI. The rest is pinned by the source-level presence of `buildUnifiedFields(...)` calls.

## Quick reference — output state cheatsheet

```
status                          → agent next-action
─────────────────────────────────────────────────────────────────────────
success + unvalidated_default  → surface, do NOT auto-mitigate
success + caller_override       → trust within calibrated regime
success + low_candidate_count   → require corroboration
anchor_no_phase_separation      → re-anchor, do NOT retry same anchor
no_signal                       → stop searching, conclude no signal
error + retryable=true          → backoff + retry
error + retryable=false         → surface, do NOT retry
```

## What this contract is NOT

- It does not specify the tool's internal math (that's in the schemas + source).
- It does not specify how the agent should compose findings into a narrative (that's the agent's job).
- It does not promise the thresholds are correct (they're not — see the calibration section).

It DOES specify how the agent reads the output. Implementations that respect this contract get a predictable, auditable cross-pillar investigation flow. Implementations that ignore it get auto-mitigation on uncalibrated math, which is exactly the failure mode the contract exists to prevent.
