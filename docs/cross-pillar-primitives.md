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
| `threshold_basis` | `"default_uncalibrated"` \| `"caller_override"` | Provenance of the threshold. |
| `anchor_ref` | `{ type, expression }` | Echo of the anchor used. Survives multi-tool chains so the agent doesn't lose context. |
| `anchor_dispersion` | number | CV of the anchor over the window. Zero = no phase separation. |
| `n_candidates_usable` | number | Candidates that produced usable signal (excludes evaluation_failed). |
| `low_candidate_count` | `"severe"` \| `"medium"` \| `null` | Tier on usable-N. |
| `query_count` | number | Total backend queries the tool issued. |
| `total_latency_ms` | number | Sum of per-query latencies. |
| `backend_pressure_hint` | `"ok"` \| `"slow"` \| `"throttled"` \| `null` | Coarse rate-pacing signal. |
| `human_summary` | string | One paragraph in plain prose for paste-to-user. |
| `error` | `PrimitiveError` (optional) | Populated only when `status === "error"`. |

Tool-specific fields (`moved[]`, `ranked[]`, `series[]`, `facts`) sit alongside the shared block.

## Status branching — the agent contract

### `status: "success"`

The math ran cleanly. Read tool-specific output.

Agent SHOULD:
- Read `human_summary` for a one-paragraph paste-to-user.
- Read `moved[]` / `ranked[]` / `series` + `facts` for structured detail.
- Check `threshold_basis`. If `default_uncalibrated`:
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

**An agent MUST NOT trigger auto-mitigation (rollback, restart, alert dismissal, scale-down) based on a primitive output where `threshold_basis === "default_uncalibrated"`.**

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

- `default_uncalibrated` — `LOG10X_THRESHOLDS_FILE` env var not set; using hand-picked SPEC_DEFAULTS.
- `config_file` — `LOG10X_THRESHOLDS_FILE` points at a calibrated config (operator took ownership).
- `caller_override` — reserved for future per-call threshold overrides (not exposed yet).

Same auto-mitigation gate applies: agents MUST NOT auto-mitigate when `threshold_basis === "default_uncalibrated"`.

### Investigate output framing — observations, not verdicts

The investigate template uses observation-shaped headings:

- "Strongest temporal evidence (lead by lag time, not proven cause)"
- "Temporal chain (lead-time order, not proven cause)"
- "Co-movers (lower confidence)"

The `human_summary` field always includes the phrase "correlation, not proven cause" when a lead is identified. Agents reading this output and presenting it to a human MUST preserve that framing. Reframing as "the cause is X" violates the contract.

## Quick reference — output state cheatsheet

```
status                          → agent next-action
─────────────────────────────────────────────────────────────────────────
success + default_uncalibrated  → surface, do NOT auto-mitigate
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
