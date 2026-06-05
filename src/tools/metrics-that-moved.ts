/**
 * log10x_metrics_that_moved — deterministic primitive: list customer
 * metrics whose value during an anchor's incident window meaningfully
 * differs from their value during the anchor's quiet baseline phase.
 *
 * Design rationale (from the design-dilemma consult): movement is the
 * first filter a sharp SRE applies. "What was different DURING the
 * incident than otherwise?" answers that. Without this filter, the
 * candidate pool stays at hundreds-to-thousands of metrics at customer
 * scale, and Pearson on a flat-but-correlated-by-shape gauge co-occurs
 * with real movement and gets ranked alongside it.
 *
 * The deterministic rule: partition the anchor's bucket grid into
 * "anchor high-phase" (anchor > anchor median) and "anchor low-phase".
 * For each candidate, compute its mean during each phase. Keep the
 * candidate when |mean_high - mean_low| / max(|mean_high|, |mean_low|)
 * ≥ threshold (default 15%). Surfaced as a standalone filter, returnable
 * as a deterministic candidate list before any Pearson pass runs.
 *
 * NOT a correlation tool. Returns the list of metrics that moved with
 * the anchor's phase + the magnitude of the move. Pearson lives in
 * rank_by_shape_similarity; visual overlay lives in metric_overlay.
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

/** Default phase-gap floor. Hand-picked, uncalibrated — see README "Threshold provenance". */
export const DEFAULT_PHASE_GAP_FLOOR = 0.15;

export const metricsThatMovedSchema = {
  anchor_type: z
    .enum(['log10x_pattern', 'customer_metric'])
    .describe('Anchor side. `log10x_pattern` = anchor is a 10x pattern. `customer_metric` = anchor is a customer PromQL.'),
  anchor: z.string().describe('Anchor identity. For `anchor_type=log10x_pattern`: the pattern Symbol Message NAME or its 11-char `pattern_hash` (= `tenx_hash`) — the tool detects shape and queries the correct PromQL label (`message_pattern` vs `tenx_hash`). For `anchor_type=customer_metric`: a customer PromQL expression.'),
  candidates: z
    .array(z.string())
    .min(1)
    .max(100)
    .describe('Customer-side PromQL expressions to evaluate (max 100). An AI caller reasoning over results can\'t meaningfully digest more than a few dozen; the cap reflects that, not a backend constraint. Pre-filter with `metrics_sharing_resource` or label-scoped `customer_metrics_query` queries.'),
  window: z.string().default('1h').describe('Time window. Alias: `timeRange`.'),
  timeRange: z.string().optional(),
  step: z.string().default('30s').describe('Bucket step.'),
  phase_gap_floor: z
    .number()
    .min(0.0)
    .max(1.0)
    .default(DEFAULT_PHASE_GAP_FLOOR)
    .describe('Relative gap floor between anchor-high and anchor-low phase means. Candidate is "moved" iff its gap ≥ this. Default 0.15 (=15%) is an uncalibrated default — output is tagged `unvalidated_default` until a caller-side calibration overrides it. See `docs/cross-pillar-primitives.md` for the calibration playbook.'),
  environment: z.string().optional(),
};

interface MovedCandidate {
  candidate: string;
  /** Canonical metric_ref string — round-trippable across the three
   * cross-pillar primitives. Pass this verbatim to rank_by_shape_similarity
   * or metric_overlay. */
  metric_ref: string;
  /** Mean of candidate during anchor's high-phase buckets. */
  mean_anchor_high: number;
  /** Mean of candidate during anchor's low-phase buckets. */
  mean_anchor_low: number;
  /** Relative gap = |mean_high - mean_low| / max(|mean_high|, |mean_low|). */
  phase_gap: number;
  /** Sign of (mean_high - mean_low): positive = candidate is HIGHER during
   * anchor-high, negative = LOWER (anti-correlated movement). */
  direction: 'co' | 'anti';
  /** How many of the candidate's data points fell into each phase. Low
   * counts on either side make the gap unreliable. */
  n_high: number;
  n_low: number;
}

/**
 * Top-level call status. Agent branches on this before reading anything else.
 *   - `success`: math ran cleanly; read `moved[]` / `not_moved[]`.
 *   - `anchor_no_phase_separation`: anchor MAD/median < 0.15. Refused.
 *     Agent should re-anchor with a clearer log pattern.
 *   - `no_signal`: search completed, but every candidate either failed or
 *     fell below the threshold. Agent should stop, not retry.
 *   - `error`: a structural failure (backend down, schema invalid, etc.).
 *     Read `data.error` for the structured envelope.
 */
export type MetricsThatMovedStatus =
  | 'success'
  | 'anchor_no_phase_separation'
  | 'no_signal'
  | 'error';

interface MetricsThatMovedSummary {
  status: MetricsThatMovedStatus;
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
  phase_gap_floor: number;
  n_anchor_buckets: number;
  n_candidates_evaluated: number;
  n_candidates_usable: number;
  low_candidate_count: 'severe' | 'medium' | null;
  query_count: number;
  total_latency_ms: number;
  backend_pressure_hint: 'ok' | 'slow' | 'throttled' | null;
  human_summary: string;
  /** Candidates whose phase_gap ≥ floor. Sorted by gap descending. */
  moved: MovedCandidate[];
  /** Candidates whose phase_gap < floor. Returned for transparency so
   * the agent can see what was filtered out. */
  not_moved: MovedCandidate[];
  /** Candidates that couldn't be evaluated (insufficient data on either
   * phase OR the backend errored on their fetch). */
  evaluation_failed: string[];
  /**
   * Threshold audit — the floor used and the empirical distribution of
   * observed phase_gap values across the evaluated candidate pool. Lets
   * the agent see "the floor I compared against was 0.15, the actual
   * observed values clustered at 0.08 — the floor is well above noise
   * on this backend" OR "...clustered at 0.22 — the floor is below
   * noise; treat moved[] with extreme skepticism."
   *
   * This is the honest disclosure path. The tool does NOT auto-calibrate
   * (every empirical calibration attempt was rejected by the consult as
   * statistical theater without external ground truth). Instead it
   * surfaces the data the caller would calibrate from, alongside the
   * floor it compared to.
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
  phase_gap_floor: {
    value: number;
    basis: 'unvalidated_default' | 'caller_override';
  };
  observed_phase_gap_distribution: {
    n: number;
    min: number;
    p25: number;
    p50: number;
    p75: number;
    max: number;
  } | null;
}

export async function executeMetricsThatMoved(
  args: {
    anchor_type: 'log10x_pattern' | 'customer_metric';
    anchor: string;
    candidates: string[];
    window?: string;
    timeRange?: string;
    step?: string;
    phase_gap_floor?: number;
    environment?: string;
    /** Ignored. Retained in the signature for backward-compat with
     * existing in-process callers; the markdown view was removed from
     * the public schema in favor of the structured `human_summary`
     * field that lives inside the success envelope. */
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<StructuredOutput> {
  const window = args.window ?? args.timeRange ?? '1h';
  const stepStr = args.step ?? '30s';
  const stepSeconds = parseStep(stepStr);
  const floor = args.phase_gap_floor ?? DEFAULT_PHASE_GAP_FLOOR;
  const thresholdBasis: 'unvalidated_default' | 'caller_override' =
    floor === DEFAULT_PHASE_GAP_FLOOR ? 'unvalidated_default' : 'caller_override';

  const tf = parseTimeframe(window);
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - Math.floor(tf.days * 86400);

  // Query telemetry — surfaced in the envelope so the agent can pace itself.
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

  // ── Anchor series ──────────────────────────────────────────────────
  let anchorExpression: string;
  let anchorSeries: Array<[number, number]>;
  try {
    if (args.anchor_type === 'log10x_pattern') {
      const metricsEnv = await resolveMetricsEnv(env);
      anchorExpression = buildPatternAnchorRateQuery(
        args.anchor,
        metricsEnv,
        Math.max(stepSeconds * 3, 180),
      );
      const res = await timedQuery(() => queryRange(env, anchorExpression, fromSec, nowSec, stepSeconds));
      anchorSeries = extractFirstSeries(res);
    } else {
      anchorExpression = args.anchor;
      const backendInfo = await resolveBackend();
      if (!backendInfo.backend) {
        // Missing customer metrics backend is an expected not_configured
        // state, not a failure: return a branchable envelope so the chain
        // continues. (Design intent: the cross-pillar primitives are
        // graceful chain participants, not loud throwers or error returns.)
        return buildNotConfiguredEnvelope({
          tool: 'log10x_metrics_that_moved',
          kind: 'customer_metrics',
          remediation: customerMetricsNotConfiguredMessage(formatDetectionTrace(backendInfo.trace)),
        });
      }
      const res = await timedQuery(() => backendInfo.backend!.queryRange(args.anchor, fromSec, nowSec, stepSeconds));
      anchorSeries = extractFirstSeries(res);
    }
  } catch (e) {
    const err = wrapBackendError(e);
    if (/HTTP 429/.test(err.hint)) throttledHit = true;
    return errorEnvelope({
      tool: 'log10x_metrics_that_moved',
      anchor_type: args.anchor_type,
      anchor_expression: args.anchor,
      window,
      stepSeconds,
      floor,
      thresholdBasis,
      queryCount,
      totalLatencyMs,
      throttledHit,
      err,
    });
  }

  if (anchorSeries.length < 6) {
    return errorEnvelope({
      tool: 'log10x_metrics_that_moved',
      anchor_type: args.anchor_type,
      anchor_expression: anchorExpression,
      window,
      stepSeconds,
      floor,
      thresholdBasis,
      queryCount,
      totalLatencyMs,
      throttledHit,
      err: {
        error_type: 'anchor_not_found',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `Anchor returned only ${anchorSeries.length} buckets — need ≥6 to partition into high/low phases. Widen the window or pick a different anchor.`,
      },
    });
  }

  // ── Anchor dispersion guard ────────────────────────────────────────
  // If the anchor doesn't have a real busy/quiet split, the phase
  // partition is arbitrary and downstream movers are meaningless.
  // Refuse with status: anchor_no_phase_separation.
  const anchorValues = anchorSeries.map(([, v]) => v);
  const anchorDispersion = computeAnchorDispersion(anchorValues);
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
      `The pattern we looked at is too steady over this window to compare against other metrics. Try a different starting pattern or widen the window.`;
    const refuseSummary = suggestionsBlock
      ? `${baseProse}\n${suggestionsBlock}`
      : baseProse;
    const data: MetricsThatMovedSummary = {
      status: 'anchor_no_phase_separation',
      threshold_used: floor,
      threshold_basis: thresholdBasis,
      anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(anchorExpression) },
      anchor_dispersion: anchorDispersion,
      anchor_expression: anchorExpression,
      window,
      step_seconds: stepSeconds,
      phase_gap_floor: floor,
      n_anchor_buckets: anchorSeries.length,
      n_candidates_evaluated: 0,
      n_candidates_usable: 0,
      low_candidate_count: null,
      query_count: queryCount,
      total_latency_ms: totalLatencyMs,
      backend_pressure_hint: pressureHint(queryCount, totalLatencyMs, throttledHit),
      // Per Notes 10-12: drop "anchor", "dispersion", raw PromQL expression
      // from user prose. The numeric audit lives in payload for the agent.
      human_summary: refuseSummary,
      moved: [],
      not_moved: [],
      evaluation_failed: [],
      anchor_suggestions: suggestions,
    };
    // Plain English per Notes 10-12: drop "anchor", "dispersion", "refusing".
    const headline = `The pattern we looked at is too steady to compare against other metrics. Try a different starting pattern.`;
    return buildChassisEnvelope({
      tool: 'log10x_metrics_that_moved',
      view: 'summary',
      headline,
      status: 'insufficient_data',
      decisions: { threshold_used: floor, threshold_basis: thresholdBasis === 'caller_override' ? 'customer_supplied' as const : thresholdBasis },
      source_disclosure: {},
      scope: { window, window_basis: 'explicit', candidates_count: args.candidates.length, candidates_usable: 0 },
      payload: data,
      human_summary: data.human_summary,
    });
  }

  const anchorPartition = partitionAnchorByMedian(anchorSeries);
  const anchorHighTs = anchorPartition.highTs;
  const anchorLowTs = anchorPartition.lowTs;

  // ── Candidates ──────────────────────────────────────────────────────
  const customerBackend = await resolveBackend();
  if (!customerBackend.backend) {
    return buildNotConfiguredEnvelope({
      tool: 'log10x_metrics_that_moved',
      kind: 'customer_metrics',
      remediation: customerMetricsNotConfiguredMessage(formatDetectionTrace(customerBackend.trace)),
    });
  }

  const moved: MovedCandidate[] = [];
  const notMoved: MovedCandidate[] = [];
  const failed: string[] = [];

  for (const cand of args.candidates) {
    try {
      const res = await timedQuery(() => customerBackend.backend!.queryRange(cand, fromSec, nowSec, stepSeconds));
      const candSeries = extractFirstSeries(res);
      const signal = computeMovedSignal(anchorPartition, candSeries, stepSeconds);
      if (signal.kind === 'failed') {
        failed.push(cand);
        continue;
      }
      const row: MovedCandidate = {
        candidate: cand,
        metric_ref: canonicalMetricRef(cand),
        mean_anchor_high: signal.meanHigh,
        mean_anchor_low: signal.meanLow,
        phase_gap: signal.phaseGap,
        direction: signal.direction,
        n_high: signal.nHigh,
        n_low: signal.nLow,
      };
      if (signal.phaseGap >= floor) moved.push(row);
      else notMoved.push(row);
    } catch (e) {
      if (e instanceof Error && /HTTP 429/.test(e.message)) throttledHit = true;
      failed.push(cand);
    }
  }

  moved.sort((a, b) => b.phase_gap - a.phase_gap);
  notMoved.sort((a, b) => b.phase_gap - a.phase_gap);

  const nUsable = moved.length + notMoved.length;
  const lowCandidateCount: 'severe' | 'medium' | null =
    nUsable < 10 ? 'severe' : nUsable < 20 ? 'medium' : null;
  const status: MetricsThatMovedStatus = moved.length === 0 ? 'no_signal' : 'success';
  const human_summary = buildHumanSummary({
    status,
    moved,
    notMoved,
    failed,
    floor,
    thresholdBasis,
    anchorDispersion,
    lowCandidateCount,
  });

  const observedDistribution = computeObservedPhaseGapDistribution(moved, notMoved);

  const data: MetricsThatMovedSummary = {
    status,
    threshold_used: floor,
    threshold_basis: thresholdBasis,
    anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(anchorExpression) },
    anchor_dispersion: anchorDispersion,
    anchor_expression: anchorExpression,
    window,
    step_seconds: stepSeconds,
    phase_gap_floor: floor,
    n_anchor_buckets: anchorSeries.length,
    n_candidates_evaluated: args.candidates.length - failed.length,
    n_candidates_usable: nUsable,
    low_candidate_count: lowCandidateCount,
    query_count: queryCount,
    total_latency_ms: totalLatencyMs,
    backend_pressure_hint: pressureHint(queryCount, totalLatencyMs, throttledHit),
    human_summary,
    moved,
    not_moved: notMoved,
    evaluation_failed: failed,
    threshold_audit: {
      phase_gap_floor: { value: floor, basis: thresholdBasis },
      observed_phase_gap_distribution: observedDistribution,
    },
  };

  // Plain English per Notes 10-12: drop "candidates", "anchor", "phase_gap".
  // The structured threshold + counts still live in payload / decisions.
  const headline = moved.length > 0
    ? `${moved.length} of ${args.candidates.length} metric(s) moved with this pattern over the window.`
    : `No metrics moved with this pattern over the window (${args.candidates.length} checked).`;

  return buildChassisEnvelope({
    tool: 'log10x_metrics_that_moved',
    view: 'summary',
    headline,
    status: moved.length > 0 ? 'success' : 'no_signal',
    decisions: {
      threshold_used: floor,
      threshold_basis: thresholdBasis === 'caller_override' ? 'customer_supplied' : thresholdBasis,
      threshold_audit: data.threshold_audit ? {
        value: data.threshold_audit.phase_gap_floor.value,
        basis: data.threshold_audit.phase_gap_floor.basis,
        observed_distribution: data.threshold_audit.observed_phase_gap_distribution,
      } : null,
    },
    source_disclosure: {},
    scope: {
      window,
      window_basis: 'explicit',
      candidates_count: args.candidates.length,
      candidates_usable: nUsable,
      candidates_evaluated: args.candidates.length - failed.length,
      candidates_failed: failed,
    },
    payload: data,
    human_summary,
  });
}

/**
 * Build the structured error envelope returned when a structural
 * failure (backend down, schema invalid, etc.) prevents the analysis
 * from running. Status='error', data.error is the typed PrimitiveError.
 */
function errorEnvelope(args: {
  tool: string;
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
  const data: MetricsThatMovedSummary = {
    status: 'error',
    threshold_used: args.floor,
    threshold_basis: args.thresholdBasis,
    anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(args.anchor_expression) },
    anchor_dispersion: 0,
    anchor_expression: args.anchor_expression,
    window: args.window,
    step_seconds: args.stepSeconds,
    phase_gap_floor: args.floor,
    n_anchor_buckets: 0,
    n_candidates_evaluated: 0,
    n_candidates_usable: 0,
    low_candidate_count: null,
    query_count: args.queryCount,
    total_latency_ms: args.totalLatencyMs,
    backend_pressure_hint: pressureHint(args.queryCount, args.totalLatencyMs, args.throttledHit),
    human_summary: `Call failed: ${args.err.hint}`,
    moved: [],
    not_moved: [],
    evaluation_failed: [],
    error: args.err,
  };
  return buildChassisEnvelope({
    tool: args.tool,
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
 * Compute the empirical phase_gap distribution across all evaluated
 * candidates (moved + not_moved). Returns null when no candidates
 * produced a usable gap value. The agent compares this distribution
 * against `phase_gap_floor` to judge whether the floor is well above
 * noise on this backend, well below it (false positives), or at the
 * boundary (treat with skepticism).
 */
function computeObservedPhaseGapDistribution(
  moved: MovedCandidate[],
  notMoved: MovedCandidate[],
): {
  n: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  max: number;
} | null {
  const gaps = [...moved, ...notMoved].map((c) => c.phase_gap).sort((a, b) => a - b);
  const n = gaps.length;
  if (n === 0) return null;
  const at = (q: number) => gaps[Math.min(n - 1, Math.floor(q * n))];
  return {
    n,
    min: gaps[0],
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    max: gaps[n - 1],
  };
}

/**
 * Backend pressure hint. Rough heuristic so the agent can decide
 * whether to back off, not a calibrated rate-limit detector.
 *   - `throttled`: any HTTP 429 surfaced during the call.
 *   - `slow`: average per-query latency exceeds 1000ms.
 *   - `ok`: everything within budget.
 *   - `null`: zero queries made (e.g. backend not configured path).
 */
function pressureHint(
  queryCount: number,
  totalLatencyMs: number,
  throttledHit: boolean,
): 'ok' | 'slow' | 'throttled' | null {
  if (queryCount === 0) return null;
  if (throttledHit) return 'throttled';
  if (totalLatencyMs / queryCount > 1000) return 'slow';
  return 'ok';
}

/**
 * One-paragraph plain-English summary the agent can paste verbatim to
 * a human user. No tables, no internal field names, no bikeshedding.
 */
function buildHumanSummary(args: {
  status: MetricsThatMovedStatus;
  moved: MovedCandidate[];
  notMoved: MovedCandidate[];
  failed: string[];
  floor: number;
  thresholdBasis: 'unvalidated_default' | 'caller_override';
  anchorDispersion: number;
  lowCandidateCount: 'severe' | 'medium' | null;
}): string {
  // Per Notes 9-12: drop "candidate", "phase-gap floor", "anchor",
  // "evaluated" from user prose. Drop the calibration caveat entirely on
  // no_signal (Note 9 — not load-bearing when nothing was found).
  if (args.status === 'no_signal') {
    const notMovedNote = args.notMoved.length > 0
      ? ` ${args.notMoved.length} stayed flat`
      : '';
    const failedNote = args.failed.length > 0
      ? `${notMovedNote ? ',' : ''} ${args.failed.length} couldn't be checked`
      : '';
    return `No metrics moved with this pattern over the window.${notMovedNote}${failedNote}. Try a different starting pattern or widen the window.`;
  }
  const lowTag =
    args.lowCandidateCount === 'severe'
      ? ' Only a few metrics were usable. Treat as weak evidence and look for corroborating signals.'
      : args.lowCandidateCount === 'medium'
        ? ' Metric sample was small. Weight the result accordingly.'
        : '';
  const top = args.moved[0];
  const topNote = top
    ? ` The strongest match is ${top.candidate} (${top.direction === 'co' ? 'rose with' : 'dropped against'} the pattern).`
    : '';
  const failedNote = args.failed.length > 0
    ? ` ${args.failed.length} couldn't be checked.`
    : '';
  const calibTag =
    args.thresholdBasis === 'unvalidated_default'
      ? ' Match threshold is a default (not yet tuned for your data).'
      : '';
  return `${args.moved.length} metric(s) moved with this pattern over the window.${topNote}${failedNote}${lowTag}${calibTag}`;
}

export interface AnchorPartition {
  median: number;
  highTs: Set<number>;
  lowTs: Set<number>;
}

export function partitionAnchorByMedian(anchorSeries: Array<[number, number]>): AnchorPartition {
  const sorted = anchorSeries.map(([, v]) => v).sort((a, b) => a - b);
  const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
  const highTs = new Set<number>();
  const lowTs = new Set<number>();
  for (const [ts, v] of anchorSeries) {
    if (v > median) highTs.add(ts);
    else lowTs.add(ts);
  }
  return { median, highTs, lowTs };
}

export type MovedSignal =
  | { kind: 'failed' }
  | {
      kind: 'evaluated';
      meanHigh: number;
      meanLow: number;
      phaseGap: number;
      direction: 'co' | 'anti';
      nHigh: number;
      nLow: number;
    };

export function computeMovedSignal(
  anchor: AnchorPartition,
  candSeries: Array<[number, number]>,
  stepSeconds: number,
): MovedSignal {
  if (candSeries.length < 6) return { kind: 'failed' };
  let sumHigh = 0;
  let nHigh = 0;
  let sumLow = 0;
  let nLow = 0;
  for (const [ts, v] of candSeries) {
    const aligned = Math.round(ts / stepSeconds) * stepSeconds;
    if (inSetWithin(anchor.highTs, aligned, stepSeconds)) {
      sumHigh += v;
      nHigh += 1;
    } else if (inSetWithin(anchor.lowTs, aligned, stepSeconds)) {
      sumLow += v;
      nLow += 1;
    }
  }
  if (nHigh < 2 || nLow < 2) return { kind: 'failed' };
  const meanHigh = sumHigh / nHigh;
  const meanLow = sumLow / nLow;
  const scale = Math.max(Math.abs(meanHigh), Math.abs(meanLow), 1e-9);
  const phaseGap = Math.abs(meanHigh - meanLow) / scale;
  const direction: 'co' | 'anti' = meanHigh - meanLow >= 0 ? 'co' : 'anti';
  return { kind: 'evaluated', meanHigh, meanLow, phaseGap, direction, nHigh, nLow };
}

function parseStep(step: string): number {
  const m = step.match(/^(\d+)(s|m|h)$/);
  if (!m) return 30;
  const n = parseInt(m[1], 10);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}

function extractFirstSeries(
  res: { status?: string; data?: { result?: Array<{ values?: Array<[number, string]> }> } } | undefined,
): Array<[number, number]> {
  if (!res || res.status !== 'success') return [];
  const first = res.data?.result?.[0]?.values;
  if (!first) return [];
  return first
    .map(([t, v]) => [Number(t), parseFloat(v)] as [number, number])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
}

export function inSetWithin(s: Set<number>, ts: number, tolerance: number): boolean {
  if (s.has(ts)) return true;
  if (s.has(ts - tolerance)) return true;
  if (s.has(ts + tolerance)) return true;
  return false;
}

function renderMarkdown(d: MetricsThatMovedSummary): string {
  const lines: string[] = [];
  lines.push(`## Metrics that moved`);
  lines.push('');
  lines.push(`**Anchor**: \`${d.anchor_expression}\``);
  lines.push(`**Window**: ${d.window} · step ${d.step_seconds}s · ${d.n_anchor_buckets} anchor buckets · floor ${d.phase_gap_floor}`);
  lines.push('');
  if (d.moved.length > 0) {
    lines.push(`### Moved (${d.moved.length})`);
    for (const r of d.moved) {
      const arrow = r.direction === 'co' ? '↑ with anchor' : '↓ with anchor (anti)';
      lines.push(`- \`${r.candidate}\` · gap=${r.phase_gap.toFixed(2)} ${arrow} · high_mean=${r.mean_anchor_high.toFixed(3)} low_mean=${r.mean_anchor_low.toFixed(3)} (${r.n_high}h/${r.n_low}l buckets)`);
    }
    lines.push('');
  }
  if (d.not_moved.length > 0) {
    lines.push(`### Did not move (${d.not_moved.length})`);
    for (const r of d.not_moved.slice(0, 5)) {
      lines.push(`- \`${r.candidate}\` · gap=${r.phase_gap.toFixed(2)}`);
    }
    if (d.not_moved.length > 5) lines.push(`  ... (${d.not_moved.length - 5} more)`);
  }
  if (d.evaluation_failed.length > 0) {
    lines.push('');
    lines.push(`### Evaluation failed (${d.evaluation_failed.length})`);
    for (const c of d.evaluation_failed.slice(0, 5)) lines.push(`- \`${c}\``);
  }
  return lines.join('\n');
}
