# Chassis Envelope

Every Class A tool in this catalog returns its response through `buildChassisEnvelope()` from `src/lib/chassis-envelope.ts`. The chassis enforces a uniform shape so agents can branch on `status`, audit the basis of every numeric decision, trace chains via `invocation_id`, and recover from errors via a structured `error` block — without scraping prose or HTML comments.

This document is the **spec** new tools follow from day one. Old tools that haven't been migrated should converge on it.

## Why this exists

A live walk on otel-demo (2026-06-03) catalogued two coexisting tool classes:

```
Class A (older, chaotic — top_patterns, pattern_examples, pattern_mitigate,
  cost_options, estimate_savings, preview_filter, pattern_detail, pattern_trend)
  - inconsistent arg names (service / pattern / pattern_hash / anchor / starting_point)
  - inconsistent enums (24h vs 1d)
  - no threshold disclosure (compute floors silently)
  - no source disclosure (rate / bytes / count source unlabeled)
  - empty actions[] when chain follow-ups exist
  - human_summary missing or tautological
  - cross-tool fields with same name meaning different things

Class B (newer cross-pillar — metrics_that_moved, investigate,
  rank_by_shape_similarity, metric_overlay)
  + threshold_basis explicit
  + threshold_audit nested with value + basis + observed distribution
  + n_candidates_usable / n_evaluated / evaluation_failed[] split
  + anchor_dispersion + window auto-derived
  + human_summary honest, includes next-step
  + investigation_id for traceability
  + structured error envelope (retryable + suggested_backoff_ms + hint)
```

Per-defect cleanup of Class A drift produced ~12 envelope fixes in one session and still left gaps. The catalog has ~30 tools; that math kept getting worse. The chassis fixes the **shape** so future tools inherit Class B's consistency without per-tool refactors.

## Relationship to existing envelope

`ChassisEnvelope` does **not** replace `StructuredOutput`. The outer transport envelope (schema_version, schema_epoch, tool, generated_at, view, summary, actions, warnings, render_hint, truncated, next_cursor, images) is unchanged.

What changes is what goes **inside** `data`. Class A tools historically put an ad-hoc object there. From now on `data` is a validated `ChassisData` produced by `buildChassisEnvelope()`. `invocation_id` and `performance` live at the top level alongside the existing envelope fields.

## The canonical shape

```ts
{
  // ── Outer transport (unchanged) ────────────────────────────
  schema_version: '1.0',
  schema_epoch: '2026-05-25',
  tool: 'log10x_<name>',
  generated_at: '2026-06-03T20:00:00.000Z',
  view: 'summary',
  summary: { headline: string },

  // ── Chassis additions at top level ─────────────────────────
  invocation_id: string,         // UUID for chain traceability
  performance: {
    query_count: number,
    total_latency_ms: number,
    backend_pressure_hint: 'ok' | 'slow' | 'throttled' | null,
  },

  // ── Validated ChassisData ──────────────────────────────────
  data: {
    status:
      'success'             // math ran cleanly; read payload
      | 'no_signal'         // ran, but no actionable result (anchor flat, etc.)
      | 'partial'            // some candidates resolved, some failed
      | 'error'              // structural failure; read data.error
      | 'insufficient_data', // window too narrow / not enough samples

    // Every numeric decision the tool made discloses its threshold + basis
    decisions: {
      threshold_used: number | null,
      threshold_basis:
        'customer_supplied'    // user provided the value via envs.json / env var
        | 'snapshot'            // value came from a discover_env snapshot
        | 'default'             // calibrated default
        | 'unvalidated_default' // hardcoded; not yet calibrated against real data
        | 'caller_override',    // caller passed it explicitly
      threshold_audit: {
        value: number | null,
        basis: string,
        observed_distribution: { p50, p90, p99 } | null,
      } | null,
    },

    // Every number labels where it came from
    source_disclosure: {
      bytes_source?:
        'tsdb' | 'engine_aggregated_csv'
        | 'customer_supplied_csv' | 'list_price',
      rate_source?:
        'customer_supplied' | 'list_price' | 'none',
      pattern_count_source?: {
        kind:
          'top_n_above_threshold'     // a top-N display
          | 'scoped_total_above_threshold'  // all above a floor in the window
          | 'env_total'               // every pattern the prom backend has retained
          | 'scoped_total',           // all in the window, no floor
        count: number,
        denominator_meaning: string,  // one-line plain-English caveat
      },
      siem_vendor?: 'cloudwatch' | 'splunk' | 'datadog' | ...,
    },

    // What universe was queried
    scope: {
      window: string,                 // 'last 24h', '30d', etc.
      window_basis: 'explicit' | 'auto_default',
      candidates_count?: number,
      candidates_usable?: number,
      candidates_evaluated?: number,
      candidates_failed?: string[],
    },

    // The actual result — tool-specific
    payload: <tool-specific shape>,

    // Agent-facing rendering
    human_summary: string,            // honest, includes next-step. Required.
    must_render_verbatim?: string,    // surface this verbatim, do not paraphrase
    must_ask_user?: {                 // structured user question + options
      question: string,
      options: string[],
    },
    forbidden_next_actions?: string[], // tool names the agent must NOT call
                                        // until must_ask_user is answered

    // Chain follow-ups — STRUCTURED, never in markdown comments
    actions: Array<{
      tool: string,
      args: object,
      reason: string,
      role: 'recommended-next' | 'alternative' | 'optional-followup',
    }>,

    // Populated only when status === 'error'
    error?: {
      error_type:
        'backend_unavailable' | 'backend_timeout' | 'anchor_not_found'
        | 'candidate_too_many' | 'schema_invalid' | 'config_missing'
        | 'no_signal' | 'unknown',
      retryable: boolean,
      suggested_backoff_ms: number | null,
      hint: string,
    },
  },

  warnings: string[],
  truncated: boolean,
}
```

## Builder usage

```ts
import { buildChassisEnvelope, newChassisTelemetry } from '../lib/chassis-envelope.js';

const telemetry = newChassisTelemetry();

// ... do work, call telemetry.recordQuery({latency_ms: 234}) after each backend call ...

return buildChassisEnvelope({
  tool: 'log10x_top_patterns',
  view: 'summary',
  headline: `Top ${shownPatterns.length} patterns above floor, top 3 are auth-service ERROR.`,
  status: 'success',
  decisions: {
    threshold_used: floorBytesPerSec,
    threshold_basis: 'default',
  },
  source_disclosure: {
    bytes_source: 'tsdb',
    rate_source: rateSourceFromEnv,
    pattern_count_source: {
      kind: 'top_n_above_threshold',
      count: shownPatterns.length,
      denominator_meaning: `Top ${shownPatterns.length} patterns above the 1 KB/s floor in ${window} of ${envTotal} env total`,
    },
    siem_vendor: 'cloudwatch',
  },
  scope: { window: timeRange, window_basis: 'explicit' },
  payload: { patterns: shownPatterns, totals, incidents },
  human_summary: `${shownPatterns.length} top-volume patterns over ${timeRange}. The env has ${envTotal} patterns total — this is a top-N view scoped to the window. Run log10x_pattern_examples on a row to drill in.`,
  actions: [
    { tool: 'log10x_pattern_examples', args: { pattern: shownPatterns[0].name }, reason: 'drill into the top pattern', role: 'recommended-next' },
  ],
  telemetry,
});
```

## Error variant

When a backend call fails or a precondition isn't met, return an error envelope. The structured `error` block is required so agents can decide retry vs surface-to-user without parsing prose:

```ts
import { buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';

return buildChassisErrorEnvelope({
  tool: 'log10x_metric_overlay',
  headline: 'Backend unavailable (retry after 3s).',
  error: {
    error_type: 'backend_unavailable',
    retryable: true,
    suggested_backoff_ms: 3000,
    hint: 'Network-level failure reaching the customer backend. Retry after backoff.',
  },
  // Partial fields where possible — never silently null everything
  source_disclosure: { siem_vendor: detectedVendor },
  scope: { window, window_basis: 'explicit' },
  payload: { anchor_ref, candidate_ref, n_anchor_buckets: 0, series: [] },
  human_summary: 'Call failed: backend unreachable. Wait 3s and retry, or check log10x_doctor.',
  telemetry,
});
```

The error block fields:

```
error_type            structured taxonomy from src/lib/primitive-errors.ts
                      agents branch on this for retry / backoff / surface decisions
retryable             true = caller can retry. false = pointless to retry
suggested_backoff_ms  how long to wait. null = no specific recommendation
hint                  human-readable explanation for the user
```

`error_type === 'no_signal'` is reserved for the case where everything ran cleanly but no actionable result emerged (anchor flat, all candidates failed evaluation, etc.). Don't use `'error'` status for that — use `'no_signal'` status with `error: undefined`.

## Source disclosure cheat sheet

Pick the right fields based on what the tool computes:

```
Tool computes…                       Required source_disclosure fields
─────────────────────────────────────────────────────────────────────
bytes / volume per pattern           bytes_source
$ / cost per pattern                 bytes_source + rate_source
pattern counts                       pattern_count_source { kind, denominator_meaning }
SIEM-side action / config            siem_vendor
metric correlation                   (none — Class B envelope semantics carry it)
capability detection                 siem_vendor + the detection's specific basis
```

`pattern_count_source.kind` matters a lot. A caller seeing `count: 4` from one tool, `count: 65` from another, `count: 4323` from a third — with no kind label — has no way to reconcile. The kind tells them whether they're looking at a top-N display, a scoped total, or env-wide.

## must_ask_user + forbidden_next_actions protocol

Some tools (`log10x_start`, `log10x_cost_options`) present a menu that the agent **must not** route past without an answer. Use the structured protocol — not HTML comments, not markdown alone:

```ts
return buildChassisEnvelope({
  ...
  status: 'success',
  must_render_verbatim: `### Pick a mode\n\n1. drop — ...\n2. sample — ...\n3. compact — ...`,
  must_ask_user: {
    question: 'Pick the enforcement mode that matches what you want.',
    options: [
      '1. drop',
      '2. sample',
      '3. compact',
    ],
  },
  forbidden_next_actions: [
    'log10x_estimate_savings',
    'log10x_configure_engine',
    'log10x_pattern_mitigate',
  ],
});
```

Agents that skip `must_ask_user` and call a `forbidden_next_action` violate the protocol. Tests assert that any envelope with `must_ask_user` also has `forbidden_next_actions` listing the routes that protocol blocks.

## Chain breadcrumbs (actions[])

Every tool that has a natural follow-up populates `actions[]`. Empty `actions[]` is allowed only when the tool is genuinely a leaf in the chain. Roles:

```
recommended-next     the right next call for the common case
alternative           a parallel path the agent can offer
optional-followup     useful but not load-bearing
```

Never put the next-action contract in markdown HTML comments (the legacy investigate pattern). Agents routinely skip it. Put it in `actions[]` with a real `args` object.

## Threshold audit

If the tool has a numeric decision (a noise floor, a top-N cap, a similarity floor, a confidence interval), surface it in `decisions.threshold_audit`. Agents that auto-apply mitigations check the basis before acting on the result:

```ts
decisions: {
  threshold_used: 0.15,
  threshold_basis: 'unvalidated_default',
  threshold_audit: {
    value: 0.15,
    basis: 'unvalidated_default',
    observed_distribution: { p50: 0.08, p90: 0.31, p99: 0.74 },
  },
},
```

`unvalidated_default` is a flag — the agent shouldn't auto-mitigate based on a floor that hasn't been calibrated. Use `'default'` when the value has at least one customer-validated baseline, `'customer_supplied'` when the user passed it.

If the tool has multiple thresholds (e.g., `rank_by_shape_similarity` has both `anchor_phase_aligned_floor` and `lag_search_max_abs`), nest them under the audit:

```ts
threshold_audit: {
  anchor_phase_aligned_floor: { value: 0.15, basis: 'unvalidated_default' },
  lag_search_max_abs:          { value: 1800, basis: 'unvalidated_default' },
  observed_pearson_magnitude_distribution: null,
}
```

## Migration: porting an old tool

Steps:

1. Add the imports:

   ```ts
   import { buildChassisEnvelope, newChassisTelemetry } from '../lib/chassis-envelope.js';
   ```

2. At the top of the handler, instantiate telemetry and call `telemetry.recordQuery({latency_ms})` after each backend call.

3. Replace ad-hoc `return { schema_version, schema_epoch, tool, ... data: { ... } }` with `return buildChassisEnvelope({...})`.

4. Move the existing payload fields into `data.payload`. If callers read flat fields from `data`, pass `legacyExtraFields` to keep them surfaced during the transition.

5. Wire up `source_disclosure` from where the data actually came (the env_config rate, the prom query response, etc.).

6. Wire up `decisions` from any threshold the tool applies (even a hardcoded top-N counts).

7. Make sure `human_summary` is honest — not just a restatement of the headline. Include the next-step recommendation.

8. Populate `actions[]` with structured chain follow-ups. Empty array is allowed only if the tool is a leaf.

9. For every error / refusal path, return `buildChassisErrorEnvelope({...})` with the structured `error` block. Don't return ad-hoc error objects.

10. Add a Zod assertion at the entry of every test: `ChassisDataSchema.parse(result.data)`. Drift fails the test.

## Tier 1 / 2 / 3 migration status

The chassis is enforced for the entire catalog as of 2026-06-03:

```
Tier 1 (b298ce0)  top_patterns, pattern_examples, pattern_mitigate
Tier 2 (9394168)  cost_options, estimate_savings, preview_filter,
                   pattern_detail, pattern_trend
Tier 3 (pending)  discover_env, dependency_check, savings,
                   configure_engine, commitment_report, baseline,
                   doctor, services, event_lookup, overflow_contents,
                   measure_compaction, find_skew, resolve_batch,
                   extract_templates, metric_overlay, metrics_that_moved,
                   rank_by_shape_similarity, investigate
```

New tools added to the catalog **must** emit through `buildChassisEnvelope`. The Zod schema validation at the boundary fails the test suite if `data` doesn't conform.

## Anti-patterns

A few patterns that have caused real defects today, all banned:

```
✗  Returning a flat ad-hoc data object instead of going through the builder
✗  Setting threshold_basis: 'default' when the value has never been
   calibrated (use 'unvalidated_default')
✗  source_disclosure: {} on error envelopes (pass at least siem_vendor
   if you know it)
✗  Empty actions[] when an obvious chain follow-up exists
✗  Repeating the headline as the human_summary
✗  Putting next-action contracts in HTML comments inside markdown
✗  Cross-tool fields with the same name carrying different denominators
   (pattern_count without pattern_count_source.kind is one example)
✗  Mislabeling a window — "monthly" when the actual aggregation covers
   ~93 hours is a credibility-killer
✗  When both a categorical state label (STABLE/GROWING/SHRINKING/NEW) and a
   quantified delta (trend_delta with glyph+value+scope) describe the same
   fact, the payload MUST emit ONLY the quantified delta. The categorical
   label is duplicative; agents render both naively.
✗  Every raw numeric field in a payload that an agent might render to a
   human MUST have a sibling *_display field pre-formatted by the shared
   units helper (fmtBytes, fmtPct, fmtDollar from src/lib/format.ts). The
   display sibling carries the correct units, significant-figure precision,
   and trailing-zero rules so all agents render consistently. Raw bytes /
   percent / dollar fields with no display sibling are a defect.
```

The Zod schemas catch most of these at build time. The few that require runtime context (the source_disclosure-on-error-path one) are flagged by integration tests.
