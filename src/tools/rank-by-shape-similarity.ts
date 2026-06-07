/**
 * log10x_rank_by_shape_similarity — deterministic primitive: rank a
 * candidate set against an anchor by Pearson + lag, returning ONLY raw
 * arithmetic. No tier, no causal framing, no judgment.
 *
 * Design rationale: Pearson IS deterministic given inputs. The fuzzy
 * compression is in TIER labels ("confirmed" / "service-match" /
 * "coincidence") and implicit "this is the cause" framing — both
 * compress what the agent needs to judge. This primitive keeps the
 * math, drops the compression. The agent reads pearson_signed +
 * lag_direction + flags and decides. metric_overlay verifies the
 * curves. metrics_that_moved filters anchor-aligned movement.
 *
 * No tier. No "confirmed." No "coincidence." Just numbers.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryRange } from '../lib/api.js';
import { resolveBackend, customerMetricsNotConfiguredMessage, formatDetectionTrace } from '../lib/customer-metrics.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { buildPatternAnchorRateQuery } from '../lib/anchor-promql.js';
import { parseTimeframe } from '../lib/format.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { computeAnchorDispersion, ANCHOR_DISPERSION_FLOOR } from '../lib/anchor-dispersion.js';
import { canonicalMetricRef } from '../lib/metric-ref.js';
import { wrapBackendError, type PrimitiveError } from '../lib/primitive-errors.js';
import { buildChassisEnvelope } from '../lib/chassis-envelope.js';
import {
  suggestHigherVariationAnchors,
  renderAnchorSuggestionsBlock,
  type AnchorSuggestion,
} from '../lib/anchor-suggestions.js';

// Default lag offsets, widened to ±1800s to catch slow-moving upstream
// causes. Hand-picked from the 58-candidate chaos test (not calibrated
// against customer data) — see README "Threshold provenance" for the
// caveat. Callers can narrow the range via `lag_search_max_abs` when
// the use case has a known tighter bound.
export const LAG_OFFSETS_SECONDS = [
  -1800, -1200, -600, -300, -180, -120, -60, -30, 0, 30, 60, 120, 180, 300, 600, 1200, 1800,
];
export const DEFAULT_LAG_SEARCH_MAX_ABS = Math.max(...LAG_OFFSETS_SECONDS.map((s) => Math.abs(s)));
// Default phase-aligned flag floor. Same provenance caveat as the lag
// list — derived from one chaos shape, not a customer-data calibration.
export const DEFAULT_ANCHOR_PHASE_ALIGNED_FLOOR = 0.15;

export const rankByShapeSimilaritySchema = {
  anchor_type: z.enum(['log10x_pattern', 'customer_metric']),
  anchor: z.string().describe('Anchor identity. For `anchor_type=log10x_pattern`: the pattern Symbol Message NAME or its 11-char `pattern_hash` (= `tenx_hash`) — the tool detects shape and queries the correct PromQL label (`message_pattern` vs `tenx_hash`). For `anchor_type=customer_metric`: a customer PromQL expression.'),
  candidates: z.array(z.string()).min(1).max(100).describe('Customer-side PromQL expressions to rank (max 100). An AI caller reasoning over results can\'t meaningfully digest more than a few dozen; the cap reflects that, not a backend constraint.'),
  window: z.string().default('1h'),
  timeRange: z.string().optional(),
  step: z.string().default('30s'),
  lag_search_max_abs: z
    .number()
    .min(0)
    .default(DEFAULT_LAG_SEARCH_MAX_ABS)
    .describe('Maximum absolute lag in seconds to scan. Default 1800s — uncalibrated. Output is tagged `unvalidated_default` when used as-is. Narrow it when the use case has a known tighter upper bound on cascade latency (e.g. 300 for sub-5-min cascades). See `docs/cross-pillar-primitives.md` for the calibration playbook.'),
  anchor_phase_aligned_floor: z
    .number()
    .min(0.0)
    .max(1.0)
    .default(DEFAULT_ANCHOR_PHASE_ALIGNED_FLOOR)
    .describe('Relative phase-gap floor for the `anchor_phase_aligned` flag. Default 0.15 — uncalibrated, same provenance caveat as lag_search_max_abs.'),
  environment: z.string().optional(),
  customer_metrics_url: z
    .string()
    .optional()
    .describe(
      'Per-call override for the customer metrics backend URL. Wins over LOG10X_CUSTOMER_METRICS_URL env var. Use when MCP was launched with an empty/stale URL.'
    ),
  customer_metrics_type: z
    .enum(['grafana_cloud', 'amp', 'datadog_prom', 'generic_prom', 'log10x'])
    .optional(),
  customer_metrics_auth: z.string().optional(),
};

interface RankedCandidate {
  candidate: string;
  /** Canonical metric_ref — round-trippable across the cross-pillar primitives. */
  metric_ref: string;
  /** Magnitude of Pearson at the peak lag (= |signed Pearson|). */
  pearson_magnitude: number;
  /** Signed Pearson at the peak lag. Positive = co-moves; negative =
   * anti-correlated. */
  pearson_signed: number;
  /** Lag in seconds at the peak. Negative = candidate leads anchor.
   * Positive = candidate lags anchor. */
  lag_seconds: number;
  /** True iff the peak landed at the search range bound. */
  lag_at_bound: boolean;
  /** Phase concentration of the Pearson peak across lag offsets, 0..1. */
  lag_tightness: number;
  /** Anchor-high vs anchor-low phase gap (re-uses the metrics_that_moved
   * logic so the agent can read both signals in one place). */
  anchor_phase_gap: number;
  anchor_phase_aligned: boolean;
  /** How many buckets the candidate had data in over the window. */
  n_buckets: number;
}

/**
 * Top-level call status. Agent branches on this before reading anything else.
 *   - `success`: math ran cleanly; read `ranked[]`.
 *   - `anchor_no_phase_separation`: anchor MAD/median < 0.15. Refused.
 *   - `no_signal`: every candidate either failed or returned r≈0. Stop searching.
 *   - `error`: structural failure; read `data.error`.
 */
export type RankByShapeStatus =
  | 'success'
  | 'anchor_no_phase_separation'
  | 'no_signal'
  | 'error';

interface RankByShapeSummary {
  status: RankByShapeStatus;
  threshold_used: number;
  threshold_basis: 'unvalidated_default' | 'caller_override';
  anchor_ref: {
    type: 'log10x_pattern' | 'customer_metric';
    expression: string;
  };
  anchor_dispersion: number;
  anchor_expression: string;
  window: string;
  step_seconds: number;
  n_anchor_buckets: number;
  n_candidates_evaluated: number;
  n_candidates_usable: number;
  low_candidate_count: 'severe' | 'medium' | null;
  query_count: number;
  total_latency_ms: number;
  backend_pressure_hint: 'ok' | 'slow' | 'throttled' | null;
  human_summary: string;
  ranked: RankedCandidate[];
  evaluation_failed: string[];
  /**
   * Candidate strings that did NOT resolve to a real metric series in
   * the customer TSDB (no samples for `count(<candidate>)`, or the
   * backend rejected the expression as invalid PromQL). Skipped before
   * the shape pipeline so we never compare the anchor against a
   * fabricated zero-series. Each entry carries the candidate string and
   * a short reason tag the agent can surface to the user.
   */
  evaluation_unknown?: Array<{ candidate: string; reason: 'candidate_unknown'; detail: string }>;
  /**
   * Populated when `status === 'no_signal'` to disambiguate the empty
   * result. `all_candidates_unknown` = none of the inputs existed in the
   * TSDB; `no_correlated_match` = candidates existed but nothing crossed
   * the correlation floor; `no_usable_buckets` = candidates existed but
   * returned <3 buckets each.
   */
  no_signal_reason?: 'all_candidates_unknown' | 'no_correlated_match' | 'no_usable_buckets';
  /**
   * Threshold audit — the floors used and the empirical distributions
   * of observed values across the ranked pool. Lets the agent see "the
   * Pearson floor I'm comparing against is 0.15, but observed Pearson
   * magnitudes across this run cluster at 0.85" vs "...cluster at 0.05."
   * Honest disclosure path; the tool does NOT auto-calibrate.
   */
  threshold_audit?: ThresholdAudit;
  /** Populated only when `status === 'error'`. */
  error?: PrimitiveError;
  /**
   * Populated only when `status === 'anchor_no_phase_separation'`. Up to
   * 3 patterns from the same env whose volume varies enough to be good
   * starting points (CV ≥ 0.5). Empty array when the scan found none or
   * errored — the refusal envelope still ships, the table just doesn't
   * render. Per Note 30: "re-anchor" without suggestions is dead-end UX.
   */
  anchor_suggestions?: AnchorSuggestion[];
}

interface ThresholdAudit {
  anchor_phase_aligned_floor: {
    value: number;
    basis: 'unvalidated_default' | 'caller_override';
  };
  lag_search_max_abs: {
    value: number;
    basis: 'unvalidated_default' | 'caller_override';
  };
  observed_pearson_magnitude_distribution: Distribution | null;
  observed_anchor_phase_gap_distribution: Distribution | null;
  n_lag_at_bound: number;
}

interface Distribution {
  n: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  max: number;
}

export async function executeRankByShapeSimilarity(
  args: {
    anchor_type: 'log10x_pattern' | 'customer_metric';
    anchor: string;
    candidates: string[];
    window?: string;
    timeRange?: string;
    step?: string;
    lag_search_max_abs?: number;
    anchor_phase_aligned_floor?: number;
    environment?: string;
    customer_metrics_url?: string;
    customer_metrics_type?: string;
    customer_metrics_auth?: string;
    /** Ignored. Retained in the args type for backward-compat with
     * in-process callers (tests, eval harness); the markdown view was
     * removed from the public schema in favor of the structured
     * `human_summary` field. */
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<StructuredOutput> {
  const window = args.window ?? args.timeRange ?? '1h';
  const stepStr = args.step ?? '30s';
  const stepSeconds = parseStep(stepStr);
  const lagMaxAbs = args.lag_search_max_abs ?? DEFAULT_LAG_SEARCH_MAX_ABS;
  const phaseAlignedFloor = args.anchor_phase_aligned_floor ?? DEFAULT_ANCHOR_PHASE_ALIGNED_FLOOR;
  const offsetsForScan = LAG_OFFSETS_SECONDS.filter((s) => Math.abs(s) <= lagMaxAbs);
  const effectiveMaxAbs = offsetsForScan.length === 0
    ? 0
    : Math.max(...offsetsForScan.map((s) => Math.abs(s)));
  const thresholdBasis: 'unvalidated_default' | 'caller_override' =
    phaseAlignedFloor === DEFAULT_ANCHOR_PHASE_ALIGNED_FLOOR && lagMaxAbs === DEFAULT_LAG_SEARCH_MAX_ABS
      ? 'unvalidated_default'
      : 'caller_override';

  const tf = parseTimeframe(window);
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - Math.floor(tf.days * 86400);

  let queryCount = 0;
  let totalLatencyMs = 0;
  let throttledHit = false;
  const timedQuery = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    queryCount += 1;
    try {
      return await fn();
    } finally {
      totalLatencyMs += Date.now() - t0;
    }
  };

  // ── Anchor ──────────────────────────────────────────────────────────
  let anchorExpression: string;
  let anchorSeries: number[];
  try {
    if (args.anchor_type === 'log10x_pattern') {
      const metricsEnv = await resolveMetricsEnv(env);
      anchorExpression = buildPatternAnchorRateQuery(
        args.anchor,
        metricsEnv,
        Math.max(stepSeconds * 3, 180),
      );
      const res = await timedQuery(() => queryRange(env, anchorExpression, fromSec, nowSec, stepSeconds));
      anchorSeries = extractValues(res);
    } else {
      anchorExpression = args.anchor;
      const backendInfo = await resolveBackend({
        url: args.customer_metrics_url,
        type: args.customer_metrics_type,
        auth: args.customer_metrics_auth,
      });
      if (!backendInfo.backend) {
        // Expected not_configured state, not a failure; branchable envelope
        // so the chain continues (cross-pillar primitives are graceful).
        return buildNotConfiguredEnvelope({
          tool: 'log10x_rank_by_shape_similarity',
          kind: 'customer_metrics',
          remediation: customerMetricsNotConfiguredMessage(formatDetectionTrace(backendInfo.trace)),
        });
      }
      const res = await timedQuery(() => backendInfo.backend!.queryRange(args.anchor, fromSec, nowSec, stepSeconds));
      anchorSeries = extractValues(res);
    }
  } catch (e) {
    const err = wrapBackendError(e);
    if (/HTTP 429/.test(err.hint)) throttledHit = true;
    return rankErrorEnvelope({
      anchor_type: args.anchor_type,
      anchor_expression: args.anchor,
      window,
      stepSeconds,
      floor: phaseAlignedFloor,
      thresholdBasis,
      queryCount,
      totalLatencyMs,
      throttledHit,
      err,
    });
  }
  if (anchorSeries.length < 3) {
    return rankErrorEnvelope({
      anchor_type: args.anchor_type,
      anchor_expression: anchorExpression,
      window,
      stepSeconds,
      floor: phaseAlignedFloor,
      thresholdBasis,
      queryCount,
      totalLatencyMs,
      throttledHit,
      err: {
        error_type: 'anchor_not_found',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `Anchor returned ${anchorSeries.length} buckets — need ≥3 to rank. Widen the window or pick a different anchor.`,
      },
    });
  }

  // ── Anchor dispersion guard ────────────────────────────────────────
  const anchorDispersion = computeAnchorDispersion(anchorSeries);
  if (anchorDispersion < ANCHOR_DISPERSION_FLOOR) {
    // Per Note 30: refusing without alternatives is dead-end UX. Scan the
    // env's recent top patterns for ones with enough variation to be
    // good starting points, surface up to 3. Helper degrades to [] on
    // any error so the refusal still ships even if the suggestion query
    // fails.
    const tfRefuse = parseTimeframe(window);
    const windowSecondsForScan = Math.floor(tfRefuse.days * 86400);
    const suggestions = await suggestHigherVariationAnchors(
      env,
      windowSecondsForScan,
      stepSeconds,
    );
    const suggestionsBlock = renderAnchorSuggestionsBlock(suggestions);
    const baseProse =
      `The pattern we looked at is too steady over this window to compare its shape against other metrics. Try a different starting pattern or widen the window.`;
    const refuseSummary = suggestionsBlock
      ? `${baseProse}\n${suggestionsBlock}`
      : baseProse;
    const data: RankByShapeSummary = {
      status: 'anchor_no_phase_separation',
      threshold_used: phaseAlignedFloor,
      threshold_basis: thresholdBasis,
      anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(anchorExpression) },
      anchor_dispersion: anchorDispersion,
      anchor_expression: anchorExpression,
      window,
      step_seconds: stepSeconds,
      n_anchor_buckets: anchorSeries.length,
      n_candidates_evaluated: 0,
      n_candidates_usable: 0,
      low_candidate_count: null,
      query_count: queryCount,
      total_latency_ms: totalLatencyMs,
      backend_pressure_hint: rankPressureHint(queryCount, totalLatencyMs, throttledHit),
      // Per Notes 10-12: drop "anchor", "dispersion", raw PromQL expression
      // from user prose. The numeric audit lives in payload for the agent.
      human_summary: refuseSummary,
      ranked: [],
      evaluation_failed: [],
      anchor_suggestions: suggestions,
    };
    // Plain English per Notes 10-12: drop "anchor", "dispersion", "refusing".
    const headline = `The pattern we looked at is too steady to compare against other metrics. Try a different starting pattern.`;
    return buildChassisEnvelope({
      tool: 'log10x_rank_by_shape_similarity',
      view: 'summary',
      headline,
      status: 'insufficient_data',
      decisions: { threshold_used: phaseAlignedFloor, threshold_basis: thresholdBasis === 'caller_override' ? 'customer_supplied' as const : thresholdBasis },
      source_disclosure: {},
      scope: { window, window_basis: 'explicit', candidates_count: args.candidates.length, candidates_usable: 0 },
      payload: data,
      human_summary: data.human_summary,
    });
  }

  // ── Candidates ──────────────────────────────────────────────────────
  const customer = await resolveBackend({
    url: args.customer_metrics_url,
    type: args.customer_metrics_type,
    auth: args.customer_metrics_auth,
  });
  if (!customer.backend) {
    return buildNotConfiguredEnvelope({
      tool: 'log10x_rank_by_shape_similarity',
      kind: 'customer_metrics',
      remediation: customerMetricsNotConfiguredMessage(formatDetectionTrace(customer.trace)),
    });
  }

  const ranked: RankedCandidate[] = [];
  const failed: string[] = [];
  // ── Candidate existence pre-pass ───────────────────────────────────
  // Bug fix: the tool used to accept any string as a candidate and run
  // the shape pipeline against whatever queryRange returned (often an
  // empty / placeholder zero-series), producing meaningless ranks. We
  // now ask the backend whether each candidate resolves to a real
  // metric series via `count(<candidate>)`. Candidates that don't
  // resolve are tagged `candidate_unknown` and skipped before any
  // shape math runs. If NONE survive we short-circuit to `no_signal`
  // with `no_signal_reason: 'all_candidates_unknown'`.
  const unknown: Array<{ candidate: string; reason: 'candidate_unknown'; detail: string }> = [];
  const survivors: string[] = [];
  for (const cand of args.candidates) {
    const verdict = await validateCandidateExists(
      cand,
      customer.backend!,
      timedQuery,
    );
    if (verdict.ok) {
      survivors.push(cand);
    } else {
      if (verdict.throttled) throttledHit = true;
      unknown.push({ candidate: cand, reason: 'candidate_unknown', detail: verdict.detail });
    }
  }

  for (const cand of survivors) {
    try {
      const res = await timedQuery(() => customer.backend!.queryRange(cand, fromSec, nowSec, stepSeconds));
      const candSeries = extractValues(res);
      if (candSeries.length < 3) {
        failed.push(cand);
        continue;
      }
      const corr = computeTemporalCorrelation(anchorSeries, candSeries, stepSeconds, offsetsForScan);
      const gap = anchorPhaseGap(anchorSeries, candSeries);
      ranked.push({
        candidate: cand,
        metric_ref: canonicalMetricRef(cand),
        pearson_magnitude: Math.abs(corr.r),
        pearson_signed: corr.r,
        lag_seconds: corr.lagSeconds,
        lag_at_bound: Math.abs(corr.lagSeconds) >= effectiveMaxAbs && effectiveMaxAbs > 0,
        lag_tightness: corr.lagTightness,
        anchor_phase_gap: gap,
        anchor_phase_aligned: gap >= phaseAlignedFloor,
        n_buckets: candSeries.length,
      });
    } catch (e) {
      if (e instanceof Error && /HTTP 429/.test(e.message)) throttledHit = true;
      failed.push(cand);
    }
  }
  ranked.sort((a, b) => b.pearson_magnitude - a.pearson_magnitude);

  const nUsable = ranked.length;
  // Math-lens workflow wxk3k628c: prior code emitted 'severe' whenever
  // nUsable < 10, INCLUDING the degenerate case where ALL candidates
  // were unknown to the backend (fetch failure, not a low-pool diagnostic).
  // Reading 'severe' on an all-candidates-unknown call misdirects
  // remediation toward "widen the metric pool" when the actual failure
  // is connectivity. Gate the tier on having at least one EVALUABLE
  // candidate; otherwise leave low_candidate_count=null and let
  // no_signal_reason='all_candidates_unknown' drive the prose.
  const lowCandidateCount: 'severe' | 'medium' | null =
    nUsable === 0 && unknown.length === args.candidates.length
      ? null  // all-unknown case → distinct failure mode
      : nUsable < 10 ? 'severe' : nUsable < 20 ? 'medium' : null;
  // No-signal status: all candidates had near-zero correlation, OR
  // every candidate was rejected as `candidate_unknown` by the
  // existence pre-pass (in which case `survivors.length === 0` and we
  // short-circuit with a distinct reason tag).
  const anyMeaningfulCorr = ranked.some((r) => r.pearson_magnitude >= 0.1);
  const status: RankByShapeStatus =
    survivors.length === 0 || ranked.length === 0 || !anyMeaningfulCorr ? 'no_signal' : 'success';
  // Disambiguate the no_signal envelope so the agent can choose between
  // "widen the candidate set" (all_candidates_unknown) and "pick a
  // different anchor" (no_correlated_match).
  const noSignalReason: 'all_candidates_unknown' | 'no_correlated_match' | 'no_usable_buckets' | undefined =
    status === 'no_signal'
      ? survivors.length === 0
        ? 'all_candidates_unknown'
        : ranked.length === 0
          ? 'no_usable_buckets'
          : 'no_correlated_match'
      : undefined;
  const top = ranked[0];

  const pearsonDist = distribute(ranked.map((r) => r.pearson_magnitude));

  // Per Notes 9-12: drop "Pearson", "@lag", "candidates", "anchor",
  // "evaluated" from user prose. Drop the calibration caveat on
  // no_signal entirely (Note 9). Numeric audit lives in
  // decisions / threshold_audit for the agent to branch on.
  const unknownNote = unknown.length > 0 ? ` ${unknown.length} weren't found in the metrics backend` : '';
  const human_summary =
    status === 'no_signal'
      ? noSignalReason === 'all_candidates_unknown'
        ? `None of the candidate metrics exist in the metrics backend over this window. Check the metric names or widen the metric pool.`
        : `No metric matched the shape of this pattern over the window. ${ranked.length} checked${failed.length > 0 ? `, ${failed.length} couldn't be checked` : ''}${unknownNote ? `,${unknownNote}` : ''}. Try a different starting pattern or widen the metric pool.`
      : `Matched ${ranked.length} metric(s) by shape over the window.${
          top
            ? ` Top match: ${top.candidate} (shape match ${top.pearson_magnitude.toFixed(2)}${top.lag_seconds !== 0 ? `, ${top.lag_seconds > 0 ? `lags by ${top.lag_seconds}s` : `leads by ${Math.abs(top.lag_seconds)}s`}` : ''}${top.lag_at_bound ? ', real offset may be wider' : ''}).`
            : ''
        }${failed.length > 0 ? ` ${failed.length} couldn't be checked.` : ''}${unknownNote ? `${unknownNote}.` : ''}${lowCandidateCount === 'severe' ? ' Very few metrics were usable — treat as weak evidence.' : ''}${thresholdBasis === 'unvalidated_default' ? ' Match threshold is a default (not yet tuned for your data).' : ''}`;


  const phaseGapDist = distribute(ranked.map((r) => r.anchor_phase_gap));
  const nAtBound = ranked.filter((r) => r.lag_at_bound).length;

  const data: RankByShapeSummary = {
    status,
    threshold_used: phaseAlignedFloor,
    threshold_basis: thresholdBasis,
    anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(anchorExpression) },
    anchor_dispersion: anchorDispersion,
    anchor_expression: anchorExpression,
    window,
    step_seconds: stepSeconds,
    n_anchor_buckets: anchorSeries.length,
    n_candidates_evaluated: survivors.length - failed.length,
    n_candidates_usable: nUsable,
    low_candidate_count: lowCandidateCount,
    query_count: queryCount,
    total_latency_ms: totalLatencyMs,
    backend_pressure_hint: rankPressureHint(queryCount, totalLatencyMs, throttledHit),
    human_summary,
    ranked,
    evaluation_failed: failed,
    evaluation_unknown: unknown.length > 0 ? unknown : undefined,
    no_signal_reason: noSignalReason,
    threshold_audit: {
      anchor_phase_aligned_floor: { value: phaseAlignedFloor, basis: thresholdBasis },
      lag_search_max_abs: { value: lagMaxAbs, basis: thresholdBasis },
      observed_pearson_magnitude_distribution: pearsonDist,
      observed_anchor_phase_gap_distribution: phaseGapDist,
      n_lag_at_bound: nAtBound,
    },
  };
  // Plain English per Notes 10-12: drop "Pearson", "@lag", "candidates",
  // "evaluated" from user prose. Counts stay in scope / payload.
  const unknownHeadline = unknown.length > 0 ? `, ${unknown.length} not found in metrics backend` : '';
  const headline = status === 'no_signal' && noSignalReason === 'all_candidates_unknown'
    ? `None of the candidate metrics exist in the metrics backend over the window.`
    : ranked.length === 0
      ? `No metrics matched the shape of this pattern over the window${failed.length > 0 ? ` (${failed.length} couldn't be checked${unknownHeadline})` : unknown.length > 0 ? ` (${unknown.length} not found in metrics backend)` : ''}.`
      : `Matched ${ranked.length} metric(s) by shape over the window${failed.length > 0 ? ` (${failed.length} couldn't be checked${unknownHeadline})` : unknown.length > 0 ? ` (${unknown.length} not found in metrics backend)` : ''}.`;

  return buildChassisEnvelope({
    tool: 'log10x_rank_by_shape_similarity',
    view: 'summary',
    headline,
    status: status === 'no_signal' ? 'no_signal' : 'success',
    decisions: {
      threshold_used: phaseAlignedFloor,
      threshold_basis: thresholdBasis === 'caller_override' ? 'customer_supplied' : thresholdBasis,
      threshold_audit: data.threshold_audit ? {
        value: data.threshold_audit.anchor_phase_aligned_floor.value,
        basis: data.threshold_audit.anchor_phase_aligned_floor.basis,
        observed_distribution: data.threshold_audit.observed_pearson_magnitude_distribution,
      } : null,
    },
    source_disclosure: {},
    scope: {
      window,
      window_basis: 'explicit',
      candidates_count: args.candidates.length,
      candidates_usable: nUsable,
      candidates_evaluated: survivors.length - failed.length,
      // Math-lens workflow wxk3k628c: prior code left
      // scope.candidates_failed=[] while payload.evaluation_unknown
      // listed candidates that failed validation (metric doesn't exist).
      // The sibling metrics_that_moved lumps unknown into
      // candidates_failed — leaving scope-level empty here was a schema
      // inconsistency on the same concept ("which candidates produced
      // no result"). Merge unknowns into candidates_failed so the
      // chassis surface agrees with metrics_that_moved; payload.
      // evaluation_unknown stays for callers that want the
      // unknown-vs-failed distinction.
      candidates_failed: [...failed, ...unknown.map((u) => u.candidate)],
    },
    payload: data,
    human_summary,
  });
}

/**
 * Verify that a candidate PromQL expression resolves to a real metric
 * series in the customer TSDB. We wrap the candidate in `count(...)` and
 * run it as an instant query: a passing candidate returns a vector with
 * at least one finite, non-zero count; anything else (parse error from
 * the backend, empty vector, all-NaN, sum to zero) is treated as
 * `candidate_unknown` and skipped.
 *
 * Why `count(...)` and not just the raw expression: the candidate is
 * already a rate / sum / quantile expression in most calls — running it
 * directly costs the full evaluation. `count(...)` shortcircuits to
 * series-existence and is cheap on every Prom-compatible backend we
 * support. If the wrap itself parse-errors (rare; usually means the
 * candidate is structurally invalid PromQL), we still get a
 * `candidate_unknown` verdict — which is the right answer.
 */
async function validateCandidateExists(
  candidate: string,
  backend: { queryInstant(promql: string): Promise<{ status: string; data: { resultType: string; result: Array<{ value?: [number, string] }> } }> },
  timedQuery: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{ ok: true } | { ok: false; detail: string; throttled: boolean }> {
  // Defensive: reject the empty-string-as-candidate edge case so the
  // backend doesn't see `count()`.
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return { ok: false, detail: 'empty candidate expression', throttled: false };
  }
  try {
    const res = await timedQuery(() => backend.queryInstant(`count(${trimmed})`));
    if (!res || res.status !== 'success') {
      return { ok: false, detail: 'backend returned non-success status', throttled: false };
    }
    const results = res.data?.result ?? [];
    if (results.length === 0) {
      return { ok: false, detail: 'no series resolve in TSDB over the window', throttled: false };
    }
    let totalCount = 0;
    let anyFinite = false;
    for (const r of results) {
      const v = r.value?.[1];
      if (v === undefined) continue;
      const parsed = parseFloat(v);
      if (!Number.isFinite(parsed)) continue;
      anyFinite = true;
      totalCount += parsed;
    }
    if (!anyFinite || totalCount <= 0) {
      return { ok: false, detail: 'count(<candidate>) resolved to 0 series', throttled: false };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const throttled = /HTTP 429/.test(msg);
    // Parse errors from the backend (HTTP 4xx with "bad_data" / "parse
    // error" in body) flow through here. Treat as candidate_unknown
    // rather than aborting the whole call.
    return { ok: false, detail: `validation query failed: ${msg.slice(0, 160)}`, throttled };
  }
}

/** Same shape as metrics_that_moved's errorEnvelope, scoped to RankByShapeSummary. */
function rankErrorEnvelope(args: {
  anchor_type: 'log10x_pattern' | 'customer_metric';
  anchor_expression: string;
  window: string;
  stepSeconds: number;
  floor: number;
  thresholdBasis: 'unvalidated_default' | 'caller_override';
  queryCount: number;
  totalLatencyMs: number;
  throttledHit: boolean;
  err: PrimitiveError;
}): StructuredOutput {
  const data: RankByShapeSummary = {
    status: 'error',
    threshold_used: args.floor,
    threshold_basis: args.thresholdBasis,
    anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(args.anchor_expression) },
    anchor_dispersion: 0,
    anchor_expression: args.anchor_expression,
    window: args.window,
    step_seconds: args.stepSeconds,
    n_anchor_buckets: 0,
    n_candidates_evaluated: 0,
    n_candidates_usable: 0,
    low_candidate_count: null,
    query_count: args.queryCount,
    total_latency_ms: args.totalLatencyMs,
    backend_pressure_hint: rankPressureHint(args.queryCount, args.totalLatencyMs, args.throttledHit),
    human_summary: `Call failed: ${args.err.hint}`,
    ranked: [],
    evaluation_failed: [],
    error: args.err,
  };
  return buildChassisEnvelope({
    tool: 'log10x_rank_by_shape_similarity',
    view: 'summary',
    headline: `Error (${args.err.error_type}): ${args.err.hint.slice(0, 120)}`,
    status: 'error',
    decisions: { threshold_used: args.floor, threshold_basis: args.thresholdBasis === 'caller_override' ? 'customer_supplied' as const : args.thresholdBasis },
    source_disclosure: {},
    scope: { window: args.window, window_basis: 'explicit' },
    payload: data,
    human_summary: `Call failed: ${args.err.hint}`,
    error: args.err,
  });
}

/**
 * Empirical distribution helper. Returns the min / p25 / median / p75 /
 * max of a numeric series, or null when the input is empty. Used by
 * the threshold_audit field so the agent can compare floors against
 * observed values on this backend.
 */
function distribute(values: number[]): {
  n: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  max: number;
} | null {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))];
  return {
    n,
    min: sorted[0],
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    max: sorted[n - 1],
  };
}

function rankPressureHint(
  queryCount: number,
  totalLatencyMs: number,
  throttledHit: boolean,
): 'ok' | 'slow' | 'throttled' | null {
  if (queryCount === 0) return null;
  if (throttledHit) return 'throttled';
  if (totalLatencyMs / queryCount > 1000) return 'slow';
  return 'ok';
}

function parseStep(step: string): number {
  const m = step.match(/^(\d+)(s|m|h)$/);
  if (!m) return 30;
  const n = parseInt(m[1], 10);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}

function extractValues(
  res: { status?: string; data?: { result?: Array<{ values?: Array<[number, string]> }> } } | undefined,
): number[] {
  if (!res || res.status !== 'success') return [];
  const first = res.data?.result?.[0]?.values;
  if (!first) return [];
  return first.map(([, v]) => parseFloat(v)).filter((v) => Number.isFinite(v));
}

export interface TemporalResult {
  r: number;
  lagSeconds: number;
  lagTightness: number;
}

export function computeTemporalCorrelation(
  anchor: number[],
  candidate: number[],
  step: number,
  offsetsSeconds: number[] = LAG_OFFSETS_SECONDS,
): TemporalResult {
  if (anchor.length === 0 || candidate.length === 0) return { r: 0, lagSeconds: 0, lagTightness: 0 };
  // Right-align (sparse-anchor vs dense-candidate alignment fix from v4).
  const n = Math.min(anchor.length, candidate.length);
  const a = anchor.slice(-n);
  const c = candidate.slice(-n);
  const offsets = offsetsSeconds.map((s) => Math.round(s / step));
  const rValues: Array<{ offset: number; r: number }> = [];
  for (const offset of offsets) {
    const r = pearsonWithOffset(a, c, offset);
    if (Number.isFinite(r)) rValues.push({ offset, r });
  }
  if (rValues.length === 0) return { r: 0, lagSeconds: 0, lagTightness: 0 };
  rValues.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  const peak = rValues[0];
  const mean = rValues.slice(1).reduce((s, x) => s + Math.abs(x.r), 0) / Math.max(1, rValues.length - 1);
  const peakMag = Math.abs(peak.r);
  const tightness = peakMag > 0 ? Math.max(0, Math.min(1, (peakMag - mean) / peakMag)) : 0;
  return { r: peak.r, lagSeconds: peak.offset * step, lagTightness: tightness };
}

export function pearsonWithOffset(a: number[], b: number[], offset: number): number {
  let ax: number[], bx: number[];
  if (offset >= 0) {
    ax = a.slice(0, a.length - offset);
    bx = b.slice(offset);
  } else {
    ax = a.slice(-offset);
    bx = b.slice(0, b.length + offset);
  }
  const n = Math.min(ax.length, bx.length);
  if (n < 3) return 0;
  ax = ax.slice(0, n);
  bx = bx.slice(0, n);
  const meanA = ax.reduce((s, x) => s + x, 0) / n;
  const meanB = bx.reduce((s, x) => s + x, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - meanA;
    const db = bx[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

export function anchorPhaseGap(anchor: number[], candidate: number[]): number {
  const n = Math.min(anchor.length, candidate.length);
  if (n < 6) return 1;
  const a = anchor.slice(-n);
  const c = candidate.slice(-n);
  const sorted = [...a].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  let sumHigh = 0, nHigh = 0, sumLow = 0, nLow = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] > median) { sumHigh += c[i]; nHigh++; } else { sumLow += c[i]; nLow++; }
  }
  if (nHigh < 2 || nLow < 2) return 1;
  const meanHigh = sumHigh / nHigh;
  const meanLow = sumLow / nLow;
  const scale = Math.max(Math.abs(meanHigh), Math.abs(meanLow), 1e-9);
  return Math.abs(meanHigh - meanLow) / scale;
}

