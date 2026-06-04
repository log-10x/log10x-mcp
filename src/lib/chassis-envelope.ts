/**
 * ChassisEnvelope — the shared envelope chassis for all Class A tools.
 *
 * WHY THIS EXISTS
 *
 * After a live walk on otel-demo (2026-06-03) we catalogued two tool
 * classes:
 *
 *   Class A (older, chaotic):
 *     top_patterns, pattern_examples, pattern_mitigate, cost_options,
 *     estimate_savings, preview_filter, pattern_detail, pattern_trend
 *     — inconsistent arg names, no threshold disclosure, no source
 *       disclosure, empty actions[], human_summary missing or tautological.
 *
 *   Class B (newer, cross-pillar):
 *     metrics_that_moved, investigate, rank_by_shape_similarity,
 *     metric_overlay
 *     — threshold_basis explicit, threshold_audit nested, candidates
 *       split usable/evaluated/failed, human_summary honest with
 *       next-step, investigation_id for traceability.
 *
 * The catalog has ~30 tools. Every Class A tool that adopts this chassis
 * gets Class B consistency without a per-tool refactor of the logic:
 * the builder enforces the shape at construction time, and the Zod
 * schema rejects drift at the boundary.
 *
 * RELATIONSHIP TO EXISTING ENVELOPE
 *
 * ChassisEnvelope does NOT replace StructuredOutput from output-types.ts.
 * The outer transport envelope (schema_version / schema_epoch / tool /
 * generated_at / view / summary / data / actions / render_hint /
 * truncated / next_cursor / warnings / images) stays unchanged.
 *
 * What changes is what goes INSIDE `data`. Class A tools historically
 * put an ad-hoc object there. From now on they put a ChassisData object.
 * `buildChassisEnvelope()` produces a complete StructuredOutput where
 * `data` is a validated ChassisData.
 *
 * BACK-COMPAT
 *
 * Old call sites that read flat fields from `data` (status, query_count,
 * total_latency_ms, human_summary) still work because ChassisData puts
 * them at the top of its flat surface via `toLegacyDataShape()`. Tools
 * can migrate incrementally: pass `legacyCompat: true` and
 * `legacyExtraFields: { ...existingDataFields }` to add those fields
 * alongside the structured chassis fields during the transition.
 *
 * USAGE
 *
 *   import { buildChassisEnvelope, newChasisTelemetry } from '../lib/chassis-envelope.js';
 *
 *   const telemetry = newChassisTelemetry();
 *   // ... do work, call telemetry.recordQuery() after each backend call ...
 *
 *   return buildChassisEnvelope({
 *     tool: 'log10x_top_patterns',
 *     view: 'summary',
 *     headline: '12 patterns above floor, top 3 are auth-service ERROR.',
 *     status: 'success',
 *     decisions: {
 *       threshold_used: floorBytesPerSec,
 *       threshold_basis: 'default',
 *     },
 *     source_disclosure: {
 *       bytes_source: 'tsdb',
 *       rate_source: rateSourceFromEnv,
 *       pattern_count_source: {
 *         kind: 'top_n_above_threshold',
 *         count: shownPatterns.length,
 *         denominator_meaning: 'Top N patterns above the 1 KB/s floor in window',
 *       },
 *     },
 *     scope: { window: timeRange, window_basis: 'explicit' },
 *     payload: { patterns: shownPatterns, totals, incidents },
 *     human_summary: '...',
 *     actions: [...],
 *     telemetry,
 *   });
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  SCHEMA_VERSION,
  SCHEMA_EPOCH,
  buildEnvelope,
  type StructuredOutput,
  type View,
  type Action,
  type RenderHint,
  type Summary,
  type InlineImage,
} from './output-types.js';
import { PRIMITIVE_ERROR_TYPES, type PrimitiveErrorType } from './primitive-errors.js';
import { filterActionsByActiveMode } from './actions-filter.js';
import type { Mode } from './mode-detect.js';

// ── Version / epoch ────────────────────────────────────────────────────────────

/**
 * Chassis schema version. Bumped when the ChassisData shape changes
 * in a way that is NOT back-compatible with older readers. Distinct
 * from SCHEMA_VERSION (the outer transport envelope version).
 */
export const CHASSIS_VERSION = '1.0' as const;

// ── Status ─────────────────────────────────────────────────────────────────────

/**
 * Top-level call status. Every tool must set this so agents can branch
 * on it before reading anything else.
 *
 *   - success        — results are available and usable; read payload.
 *   - no_signal      — search ran, nothing crossed the threshold; stop,
 *                      do not auto-retry with the same params.
 *   - partial        — some sub-queries failed; results are available
 *                      but partial. Read scope.candidates_failed[] for
 *                      what was skipped. May be worth a narrower retry.
 *   - insufficient_data — anchor resolved but window / backend coverage
 *                      too thin to produce a usable result. Widen or
 *                      re-anchor.
 *   - error          — structural failure; read data.error.
 */
export const ChassisStatusSchema = z.enum([
  'success',
  'no_signal',
  'partial',
  'insufficient_data',
  'error',
]);
export type ChassisStatus = z.infer<typeof ChassisStatusSchema>;

// ── Threshold / decisions block ────────────────────────────────────────────────

/**
 * Where the threshold number came from. Agents use this to decide
 * whether to act on the result:
 *
 *   customer_supplied   — caller passed it explicitly; treat as trusted.
 *   snapshot            — read from a stored config/calibration file.
 *   default             — a hand-picked spec constant; use with caution.
 *   unvalidated_default — same as default but the tool explicitly flags
 *                         that no empirical calibration has been done on
 *                         this deployment's data. Agents MUST NOT
 *                         auto-mitigate when this is set.
 */
export const ThresholdBasisSchema = z.enum([
  'customer_supplied',
  'snapshot',
  'default',
  'unvalidated_default',
]);
export type ThresholdBasis = z.infer<typeof ThresholdBasisSchema>;

/**
 * Observed distribution summary for the pool of values the threshold
 * was compared against. The agent compares threshold_used against
 * this distribution to judge whether the threshold is well above noise,
 * at the noise floor, or below it (false positives).
 */
export const ThresholdAuditDistributionSchema = z
  .object({
    n: z.number().int().nonnegative(),
    min: z.number(),
    p25: z.number(),
    p50: z.number(),
    p75: z.number(),
    max: z.number(),
  })
  .nullable();

export const ThresholdAuditSchema = z
  .object({
    value: z.number().nullable(),
    basis: z.string(),
    observed_distribution: ThresholdAuditDistributionSchema.optional(),
    /**
     * Number of candidate slots considered for the observed_distribution.
     * Populated by find_skew (skew-concentration analysis) to show how
     * many slots were scanned before the threshold was applied.
     */
    n_candidate_slots: z.number().int().nonnegative().optional(),
  })
  .nullable();
export type ThresholdAudit = z.infer<typeof ThresholdAuditSchema>;

/**
 * All numeric thresholds the tool applied, plus their provenance.
 * Mandatory on every tool; if a tool has no threshold semantics, set
 * threshold_used: null and threshold_basis: 'default'.
 */
export const DecisionsSchema = z.object({
  threshold_used: z.number().nullable(),
  threshold_basis: ThresholdBasisSchema,
  /**
   * Optional richer audit. Populate for tools where showing the
   * floor vs the observed distribution is meaningful (all the
   * cross-pillar primitives, estimate_savings, etc.). Tools that
   * have no numeric distribution to show omit this field.
   */
  threshold_audit: ThresholdAuditSchema.optional(),
});
export type Decisions = z.infer<typeof DecisionsSchema>;

// ── Source disclosure ──────────────────────────────────────────────────────────

/**
 * Where bytes figures come from. Every tool that surfaces GB/s, bytes,
 * or cost numbers must label the origin so an agent or human reader
 * knows what they are comparing.
 */
export const BytesSourceSchema = z.enum([
  'tsdb',
  'customer_supplied_csv',
  'engine_aggregated_csv',
  'siem_direct',
  'estimate',
]);
export type BytesSource = z.infer<typeof BytesSourceSchema>;

/**
 * Where the $/GB rate came from. Absent when the tool surfaces no
 * dollar values.
 */
export const RateSourceSchema = z.enum([
  'customer_supplied',
  'list_price',
  'snapshot',
  'none',
]);
export type RateSource = z.infer<typeof RateSourceSchema>;

/**
 * Pattern count semantics. Populating this field prevents the most
 * common Class A ambiguity: "10 patterns" — 10 of how many? Above what?
 */
export const PatternCountSourceSchema = z.object({
  kind: z.enum([
    'top_n_above_threshold',
    'scoped_total_above_threshold',
    'env_total',
    'scoped_total',
    'above_volume_floor',
    'raw_label_universe',
  ]),
  count: z.number().int().nonnegative(),
  /**
   * One-line caveat explaining what the denominator is. Examples:
   *   "Top N patterns above the 1 KB/s floor in window"
   *   "All ERROR patterns in payment-service over 24h"
   */
  denominator_meaning: z.string(),
});
export type PatternCountSource = z.infer<typeof PatternCountSourceSchema>;

/**
 * Source labels for every number class the tool surfaces. All fields
 * are optional because not every tool surfaces every number type. When
 * a tool surfaces a number and omits the source field, the Zod
 * validator will NOT reject the envelope — but the principle is that
 * any number that could be ambiguous should carry a label.
 */
export const SourceDisclosureSchema = z.object({
  bytes_source: BytesSourceSchema.optional(),
  rate_source: RateSourceSchema.optional(),
  pattern_count_source: PatternCountSourceSchema.optional(),
  /**
   * SIEM vendor in scope. Populated by tools that query or surface
   * SIEM data so a reader knows the cost model and query dialect.
   */
  siem_vendor: z.string().optional(),
  /**
   * How the Retriever URL + bucket was resolved. Populated by tools that
   * consume the Retriever (retriever_query, retriever_series, backfill_metric,
   * overflow_contents) so an agent can tell whether the resolution came from
   * env vars, the discovery snapshot, a live kubectl probe, or was absent.
   */
  retriever_state_source: z.enum(['env_var', 'snapshot', 'helm_release_probe', 'kubectl_probe', 'none']).optional(),
  /**
   * Service count semantics. Mirrors pattern_count_source for tools that
   * surface a list of services. Without this field "12 services" is
   * ambiguous — 12 above what floor, from what universe?
   */
  service_count_source: PatternCountSourceSchema.optional(),
  /**
   * Label source — for label-domain tools (discover_labels, discover_join).
   * Identifies which Prometheus backend the label universe came from.
   */
  label_source: z.enum(['log10x_prom', 'customer_prom']).optional(),
});
export type SourceDisclosure = z.infer<typeof SourceDisclosureSchema>;

// ── Scope ─────────────────────────────────────────────────────────────────────

/**
 * What universe the tool queried. Mirrors the Class B n_candidates_*
 * split to let agents reason about result completeness.
 */
export const ScopeSchema = z.object({
  window: z.string(),
  window_basis: z.enum(['explicit', 'auto_default']),
  /**
   * Total candidates considered before filtering. Absent for tools
   * that don't have a candidate selection step.
   */
  candidates_count: z.number().int().nonnegative().optional(),
  /**
   * Candidates that had enough data to be evaluated (after filtering
   * out insufficient-data cases). Subset of candidates_count.
   */
  candidates_usable: z.number().int().nonnegative().optional(),
  /**
   * Candidates that were actually evaluated. May be less than
   * candidates_usable when a per-call cap is applied.
   */
  candidates_evaluated: z.number().int().nonnegative().optional(),
  /**
   * Candidates that failed evaluation (insufficient data, backend
   * error, or timeout). Carrying these explicitly is what distinguishes
   * Class B from Class A — the agent can see what was dropped.
   */
  candidates_failed: z.array(z.string()).optional(),
});
export type Scope = z.infer<typeof ScopeSchema>;

// ── Must-ask + must-render blocks ─────────────────────────────────────────────

/**
 * Structured question the agent MUST surface to the user before
 * routing to any follow-up tool. This moves compliance directives OUT
 * of prose markdown (where they are routinely ignored) and into a
 * typed field agents can read and act on mechanically.
 */
export const MustAskUserSchema = z
  .object({
    question: z.string(),
    options: z.array(z.string()),
  })
  .optional();
export type MustAskUser = z.infer<typeof MustAskUserSchema>;

// ── Performance block ──────────────────────────────────────────────────────────

/**
 * Per-call telemetry surfaced on every envelope. Enables agents to
 * pace themselves and flag slow backends.
 */
export const PerformanceSchema = z.object({
  query_count: z.number().int().nonnegative(),
  total_latency_ms: z.number().nonnegative(),
  backend_pressure_hint: z
    .enum(['ok', 'slow', 'throttled'])
    .nullable(),
});
export type Performance = z.infer<typeof PerformanceSchema>;

// ── Chassis data (what goes inside StructuredOutput.data) ─────────────────────

/**
 * The full ChassisData shape. Every Class A tool puts one of these
 * inside the `data` field of its StructuredOutput envelope.
 *
 * `payload` is generic — the tool-specific result rows go there.
 * The chassis validates everything around it.
 */
export const ChassisDataSchema = z.object({
  // ── Status ────────────────────────────────────────────────────────
  status: ChassisStatusSchema,

  // ── Threshold + source provenance ─────────────────────────────────
  decisions: DecisionsSchema,
  source_disclosure: SourceDisclosureSchema,

  // ── Query scope ────────────────────────────────────────────────────
  scope: ScopeSchema,

  // ── Tool-specific result rows ──────────────────────────────────────
  /** The actual result. Tool defines its own sub-type; validated by
   * the tool's per-tool Zod schema after this envelope is assembled. */
  payload: z.unknown(),

  // ── Agent-facing rendering ─────────────────────────────────────────
  /**
   * Honest, plain-English summary that includes the next recommended
   * action. The agent can quote this verbatim. NOT a restatement of
   * the headline — it adds calibration warnings, next-step pointers,
   * and anything else that the agent needs to convey to a human user
   * without parsing the payload.
   */
  human_summary: z.string().min(1),

  /**
   * Pre-rendered markdown the agent MUST surface verbatim, without
   * paraphrasing. Used by orientation-style tools (log10x_start,
   * cost_options) whose formatting carries semantic structure the
   * agent must not reflow.
   */
  must_render_verbatim: z.string().optional(),

  /**
   * Structured question the agent MUST surface before routing anywhere.
   * Replaces the HTML-comment pattern used in the legacy next-actions
   * protocol, which agents routinely skip.
   */
  must_ask_user: MustAskUserSchema,

  /**
   * Tools the agent MUST NOT call until the user has answered
   * must_ask_user. The list carries MCP tool names (e.g.
   * 'log10x_estimate_savings'). An agent that skips must_ask_user and
   * calls one of these directly violates the protocol.
   */
  forbidden_next_actions: z.array(z.string()).optional(),

  // ── Structured error (populated only when status === 'error') ──────
  /** Structured error envelope. Present only when status === 'error'. */
  error: z
    .object({
      /**
       * Structured taxonomy from primitive-errors.ts. Agents branch on
       * this value to decide retry/backoff/surface-to-user behaviour.
       */
      error_type: z.enum(PRIMITIVE_ERROR_TYPES),
      retryable: z.boolean(),
      suggested_backoff_ms: z.number().nullable(),
      hint: z.string(),
    })
    .optional(),
});

export type ChassisData = z.infer<typeof ChassisDataSchema>;

// ── Full chassis envelope type ─────────────────────────────────────────────────

/**
 * The complete chassis envelope. Outer wrapper is StructuredOutput
 * (transport layer, unchanged); `data` is a validated ChassisData.
 * `invocation_id` and `performance` live at the top level alongside
 * the existing envelope fields.
 *
 * This is a structural interface rather than a Zod schema because
 * StructuredOutput already has a Zod schema; we overlay the chassis
 * extension fields on top.
 */
export interface ChassisEnvelope extends StructuredOutput {
  /**
   * UUID for chain traceability. Pass this as `prior_invocation_id`
   * on follow-up calls so a harness can reconstruct the call graph
   * without parsing prose.
   */
  invocation_id: string;
  /**
   * Performance telemetry lifted to the top level for observability
   * harnesses that scan the outer envelope without deserializing `data`.
   */
  performance: Performance;
  /** Typed override — data is always a ChassisData on these envelopes. */
  data: ChassisData;
}

// ── Telemetry helper ──────────────────────────────────────────────────────────

/**
 * Mutable telemetry accumulator. Create one at the start of a handler,
 * call `recordQuery()` after each backend call, then pass it to
 * `buildChassisEnvelope()`.
 */
export interface ChassisTelemetry {
  readonly startedAt: number;
  queryCount: number;
  throttledHit: boolean;
}

export function newChassisTelemetry(): ChassisTelemetry {
  return { startedAt: Date.now(), queryCount: 0, throttledHit: false };
}

/**
 * Convenience mutator. Call after each backend query completes.
 * Returns `telemetry` so callers can chain if desired.
 */
export function recordQuery(telemetry: ChassisTelemetry, throttled = false): ChassisTelemetry {
  telemetry.queryCount += 1;
  if (throttled) telemetry.throttledHit = true;
  return telemetry;
}

/**
 * Compute the backend pressure hint from accumulated telemetry.
 * Returns null when no queries were made (paste-mode / local-only tools).
 */
export function computePressureHint(
  t: ChassisTelemetry,
  nowMs = Date.now(),
): Performance['backend_pressure_hint'] {
  if (t.queryCount === 0) return null;
  if (t.throttledHit) return 'throttled';
  if ((nowMs - t.startedAt) / t.queryCount > 1000) return 'slow';
  return 'ok';
}

// ── Builder ────────────────────────────────────────────────────────────────────

/**
 * Input to `buildChassisEnvelope()`. All fields are required except
 * where marked optional. The builder fills in:
 *   - schema_version, schema_epoch (from output-types.ts constants)
 *   - invocation_id (crypto.randomUUID)
 *   - generated_at (new Date().toISOString())
 *   - performance (derived from telemetry)
 *   - truncated default false
 *   - warnings default []
 */
export interface ChassisEnvelopeInput {
  // ── Identity ──────────────────────────────────────────────────────
  tool: string;
  view: View;

  // ── Outer envelope ─────────────────────────────────────────────────
  /** `summary.headline` — 1-3 sentence line the agent quotes cold. */
  headline: string;
  /** Optional bullets for the summary block. */
  headline_bullets?: string[];
  /** Optional callout for the summary block. */
  headline_callout?: string;

  // ── ChassisData fields ─────────────────────────────────────────────
  status: ChassisStatus;
  decisions: Decisions;
  source_disclosure: SourceDisclosure;
  scope: Scope;

  /**
   * The tool-specific result rows. Anything goes here; the chassis
   * does not validate the payload shape.
   */
  payload: unknown;

  human_summary: string;
  must_render_verbatim?: string;
  must_ask_user?: MustAskUser;
  forbidden_next_actions?: string[];

  /**
   * Structured error. Required when status === 'error'; should be
   * omitted otherwise. The builder enforces this at runtime and emits
   * a warning if the contract is violated.
   */
  error?: ChassisData['error'];

  // ── Performance ────────────────────────────────────────────────────
  /**
   * Pass the tool's ChassisTelemetry accumulator. The builder derives
   * query_count, total_latency_ms, and backend_pressure_hint from it.
   *
   * When omitted (paste-mode / local tools), performance is set to
   * { query_count: 0, total_latency_ms: 0, backend_pressure_hint: null }.
   */
  telemetry?: ChassisTelemetry;

  // ── Outer envelope extras ──────────────────────────────────────────
  actions?: Action[];
  render_hint?: RenderHint;
  truncated?: boolean;
  next_cursor?: string;
  warnings?: string[];
  images?: InlineImage[];

  /**
   * Current boot mode. When provided, `buildChassisEnvelope()` filters
   * `actions[]` to remove entries for tools not registered in this mode,
   * and appends a warning for each dropped entry.
   *
   * Call sites that already have the boot mode available (e.g. those
   * that call `getBootMode()`) should pass it here. When omitted (null /
   * undefined), actions[] is passed through unfiltered — a safe default
   * for tools that run before mode detection completes.
   */
  mode?: Mode | null;

  /**
   * Back-compat mode. When true, `buildChassisEnvelope()` also spreads
   * `legacyExtraFields` into the `data` object alongside the chassis
   * fields. Allows a tool to return the new chassis shape while old
   * callers that read flat fields from `data` continue to work.
   *
   * Remove once all call sites have migrated to reading ChassisData.
   */
  legacyCompat?: boolean;
  /**
   * Extra fields to spread into `data` when `legacyCompat: true`.
   * Should carry the same flat fields the old tool returned
   * (status, query_count, total_latency_ms, human_summary, etc.).
   */
  legacyExtraFields?: Record<string, unknown>;
}

/**
 * Build a complete ChassisEnvelope from a tool handler's inputs.
 *
 * The returned object is a valid StructuredOutput (passes
 * `isStructuredOutput()` from output-types.ts) AND carries the
 * chassis extension fields (`invocation_id`, `performance`).
 *
 * Validation: ChassisDataSchema.parse() runs on the assembled `data`
 * block. If it throws, the error message contains the Zod path and the
 * reason — this is intentional; it surfaces schema drift at the
 * boundary during development rather than silently emitting malformed
 * output.
 *
 * In production: wrap the call site in try/catch and emit a
 * buildChassisErrorEnvelope() when a schema violation occurs so the
 * agent still gets a structured, branchable error envelope rather than
 * an MCP protocol error.
 */
export function buildChassisEnvelope(input: ChassisEnvelopeInput): ChassisEnvelope {
  const nowMs = Date.now();
  const t = input.telemetry;

  const performance: Performance = t
    ? {
        query_count: t.queryCount,
        total_latency_ms: nowMs - t.startedAt,
        backend_pressure_hint: computePressureHint(t, nowMs),
      }
    : { query_count: 0, total_latency_ms: 0, backend_pressure_hint: null };

  // Warn at runtime (not throw) when status/error contract is violated.
  const warnings = input.warnings ? [...input.warnings] : [];

  // Filter actions[] to only include tools registered in the current mode.
  // Dropped entries emit warnings[] so the gap is auditable even when
  // invisible to the agent. When mode is null/undefined, pass through
  // unfiltered (boot-race or test-only override — defensive default).
  const filteredActions = filterActionsByActiveMode(input.actions ?? [], input.mode ?? null, warnings);
  if (input.status === 'error' && !input.error) {
    // In development mode: fail fast so tool authors catch this at
    // test time rather than silently emitting an unbranchable error.
    if (process.env.NODE_ENV === 'development' || process.env.CHASSIS_STRICT === '1') {
      throw new Error(
        `chassis contract violation: status="error" on tool "${input.tool}" but no error block provided. ` +
        'Pass an error: { error_type, retryable, suggested_backoff_ms, hint } when status="error".',
      );
    }
    warnings.push(
      'chassis: status=error but no error field provided. This is a tool-authoring bug.',
    );
  }
  if (input.status !== 'error' && input.error) {
    warnings.push(
      'chassis: error field is present but status !== "error". The error field will be ignored by agents.',
    );
  }

  const chassisData: Record<string, unknown> = {
    status: input.status,
    decisions: input.decisions,
    source_disclosure: input.source_disclosure,
    scope: input.scope,
    payload: input.payload,
    human_summary: input.human_summary,
    ...(input.must_render_verbatim != null
      ? { must_render_verbatim: input.must_render_verbatim }
      : {}),
    ...(input.must_ask_user != null ? { must_ask_user: input.must_ask_user } : {}),
    ...(input.forbidden_next_actions != null
      ? { forbidden_next_actions: input.forbidden_next_actions }
      : {}),
    ...(input.error != null ? { error: input.error } : {}),
  };

  // Back-compat mode: spread legacy flat fields alongside chassis fields.
  // The chassis fields win on collision — intentional, they are the
  // source of truth going forward.
  if (input.legacyCompat && input.legacyExtraFields) {
    for (const [k, v] of Object.entries(input.legacyExtraFields)) {
      if (!(k in chassisData)) {
        chassisData[k] = v;
      }
    }
  }

  // Validate the chassis data block. In development this surfaces
  // schema drift immediately. In production, catch at the call site.
  const validatedData = ChassisDataSchema.parse(chassisData);

  const summary: Summary = {
    headline: input.headline,
    ...(input.headline_bullets != null ? { bullets: input.headline_bullets } : {}),
    ...(input.headline_callout != null ? { callout: input.headline_callout } : {}),
  };

  const outer = buildEnvelope({
    tool: input.tool,
    view: input.view,
    summary,
    data: validatedData,
    actions: filteredActions,
    render_hint: input.render_hint,
    truncated: input.truncated ?? false,
    next_cursor: input.next_cursor,
    warnings,
    ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
  });

  return {
    ...outer,
    invocation_id: randomUUID(),
    performance,
    // Override data with the fully-typed validated block.
    data: validatedData,
  };
}

// ── Error-case fast paths ──────────────────────────────────────────────────────

/**
 * Strip leading markdown H1/H2/... header lines from an error hint
 * before it is inserted into the structured `summary.headline` field.
 *
 * Some error paths (e.g. configure-engine.ts's renderError()) format
 * their output with a markdown heading as the first line, like
 * `# configure_engine — gitops repo not resolved`. When that string
 * flows verbatim into `buildChassisErrorEnvelope`, the H1 `# ` syntax
 * bleeds into the headline. This helper skips any leading `#+`-prefixed
 * lines and returns the first line of prose content.
 *
 * The original `errHint` (with the heading) is still passed to
 * `human_summary` and `payload.remediation` so markdown renderers see
 * it intact — only the `headline` field is sanitized.
 */
function sanitizeHeadline(msg: string): string {
  const lines = msg.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const nonHeader = lines.find((l) => !l.startsWith('#'));
  return nonHeader ?? (lines[0]?.replace(/^#+\s*/, '') ?? msg);
}

/**
 * Convenience builder for structural error envelopes. Use when the
 * tool cannot produce a payload because a backend call failed.
 *
 * The envelope still carries full traceability (invocation_id,
 * performance from the accumulated telemetry up to the failure point).
 */
export function buildChassisErrorEnvelope(opts: {
  tool: string;
  /** The PrimitiveError or equivalent structured error shape. */
  err: ChassisData['error'];
  telemetry?: ChassisTelemetry;
  /** Scope that was known before the failure, if any. */
  scope?: Partial<Scope>;
  /** Extra context already available (e.g. the input echo). */
  contextPayload?: Record<string, unknown>;
  warnings?: string[];
  /**
   * Partial source disclosure for fields known before the failure.
   * Callers that resolved vendor selection or know the bytes source
   * (e.g. 'tsdb') should pass what they have so the error envelope
   * carries traceable provenance. Defaults to {} for back-compat.
   */
  source_disclosure?: Partial<SourceDisclosure>;
  /**
   * Structured chain-next nudges. Error envelopes should populate this
   * when an obvious remediation tool exists (e.g. config_missing →
   * configure_env, backend_unavailable → doctor). Agents pick these up
   * without parsing human_summary text.
   */
  actions?: Action[];
}): ChassisEnvelope {
  const errHint = opts.err?.hint ?? 'Unknown error';
  const errType = opts.err?.error_type ?? 'unknown';

  return buildChassisEnvelope({
    tool: opts.tool,
    view: 'summary',
    headline: `Error (${errType}): ${sanitizeHeadline(errHint).slice(0, 120)}`,
    status: 'error',
    decisions: {
      threshold_used: null,
      threshold_basis: 'default',
    },
    source_disclosure: opts.source_disclosure ?? {},
    scope: {
      window: 'unknown',
      window_basis: 'auto_default',
      ...opts.scope,
    },
    payload: opts.contextPayload ?? {},
    human_summary: `Call failed: ${errHint}`,
    error: opts.err,
    telemetry: opts.telemetry,
    warnings: opts.warnings,
    actions: opts.actions,
  });
}

// ── Back-compat helpers ────────────────────────────────────────────────────────

/**
 * toLegacyShape — emit the pre-chassis flat data shape from a
 * ChassisEnvelope. Use this during the transition period when a call
 * site reads from the old flat fields (status, query_count,
 * total_latency_ms, human_summary) and has not yet been updated to
 * read ChassisData.
 *
 * Returns a plain Record<string, unknown> that matches what the old
 * tool would have put in StructuredOutput.data. It is NOT a validated
 * shape — it is a shim for old readers.
 */
export function toLegacyShape(envelope: ChassisEnvelope): Record<string, unknown> {
  const d = envelope.data;
  return {
    status: d.status,
    query_count: envelope.performance.query_count,
    total_latency_ms: envelope.performance.total_latency_ms,
    backend_pressure_hint: envelope.performance.backend_pressure_hint,
    human_summary: d.human_summary,
    ...(d.must_render_verbatim != null
      ? { must_render_verbatim: d.must_render_verbatim }
      : {}),
    ...(d.must_ask_user != null ? { must_ask_user: d.must_ask_user } : {}),
    ...(d.forbidden_next_actions != null
      ? { forbidden_next_actions: d.forbidden_next_actions }
      : {}),
    ...(d.error != null ? { error: d.error } : {}),
    // Spread the tool-specific payload at the top level, matching the
    // old pattern where data was a flat mix of meta + payload.
    ...(d.payload != null && typeof d.payload === 'object' ? (d.payload as Record<string, unknown>) : {}),
  };
}

/**
 * isChassisEnvelope — type guard that distinguishes a ChassisEnvelope
 * from a plain StructuredOutput. Use in `wrap()` or harnesses that
 * handle both old and new tool shapes.
 */
export function isChassisEnvelope(x: unknown): x is ChassisEnvelope {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.invocation_id === 'string' &&
    typeof o.performance === 'object' &&
    o.performance !== null
  );
}

/**
 * Zod schema for the full ChassisEnvelope shape, for use in test
 * assertions and harness-level validation. This schema validates
 * only the chassis-specific extension fields; outer StructuredOutput
 * fields are validated separately by StructuredOutputSchema.
 */
export const ChassisEnvelopeExtensionSchema = z.object({
  invocation_id: z.string().uuid(),
  performance: PerformanceSchema,
  data: ChassisDataSchema,
});
export type ChassisEnvelopeExtension = z.infer<typeof ChassisEnvelopeExtensionSchema>;
