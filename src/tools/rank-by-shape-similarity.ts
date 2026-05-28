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
import { resolveBackend } from '../lib/customer-metrics.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { LABELS } from '../lib/promql.js';
import { parseTimeframe } from '../lib/format.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { computeAnchorDispersion, ANCHOR_DISPERSION_FLOOR } from '../lib/anchor-dispersion.js';
import { canonicalMetricRef } from '../lib/metric-ref.js';
import { wrapBackendError, type PrimitiveError } from '../lib/primitive-errors.js';

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
  anchor: z.string().describe('Anchor identity (pattern symbol_message OR customer PromQL).'),
  candidates: z.array(z.string()).min(1).max(100).describe('Customer-side PromQL expressions to rank (max 100). An AI caller reasoning over results can\'t meaningfully digest more than a few dozen; the cap reflects that, not a backend constraint.'),
  window: z.string().default('1h'),
  timeRange: z.string().optional(),
  step: z.string().default('30s'),
  lag_search_max_abs: z
    .number()
    .min(0)
    .default(DEFAULT_LAG_SEARCH_MAX_ABS)
    .describe('Maximum absolute lag in seconds to scan. Default 1800s — uncalibrated. Output is tagged `default_uncalibrated` when used as-is. Narrow it when the use case has a known tighter upper bound on cascade latency (e.g. 300 for sub-5-min cascades). See `docs/cross-pillar-primitives.md` for the calibration playbook.'),
  anchor_phase_aligned_floor: z
    .number()
    .min(0.0)
    .max(1.0)
    .default(DEFAULT_ANCHOR_PHASE_ALIGNED_FLOOR)
    .describe('Relative phase-gap floor for the `anchor_phase_aligned` flag. Default 0.15 — uncalibrated, same provenance caveat as lag_search_max_abs.'),
  environment: z.string().optional(),
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
  threshold_basis: 'default_uncalibrated' | 'caller_override';
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
  /** Populated only when `status === 'error'`. */
  error?: PrimitiveError;
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
    /** Ignored. Retained for backward-compat with in-process callers. */
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
  const thresholdBasis: 'default_uncalibrated' | 'caller_override' =
    phaseAlignedFloor === DEFAULT_ANCHOR_PHASE_ALIGNED_FLOOR && lagMaxAbs === DEFAULT_LAG_SEARCH_MAX_ABS
      ? 'default_uncalibrated'
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
      const escaped = args.anchor.replace(/"/g, '\\"');
      anchorExpression = `sum(rate(all_events_summaryBytes_total{${LABELS.pattern}="${escaped}",${LABELS.env}="${metricsEnv}"}[${Math.max(stepSeconds * 3, 180)}s]))`;
      const res = await timedQuery(() => queryRange(env, anchorExpression, fromSec, nowSec, stepSeconds));
      anchorSeries = extractValues(res);
    } else {
      anchorExpression = args.anchor;
      const backendInfo = await resolveBackend();
      if (!backendInfo.backend) {
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
            error_type: 'backend_unavailable',
            retryable: false,
            suggested_backoff_ms: null,
            hint: 'Customer metrics backend not configured. Set LOG10X_CUSTOMER_METRICS_URL.',
          },
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
      human_summary: `Anchor "${anchorExpression}" has dispersion ${anchorDispersion.toFixed(3)} — below the ${ANCHOR_DISPERSION_FLOOR} floor. The shape-similarity rank would be meaningless on this anchor. Re-anchor with a clearer pattern.`,
      ranked: [],
      evaluation_failed: [],
    };
    const headline = `Anchor lacks phase separation (dispersion ${anchorDispersion.toFixed(3)} < ${ANCHOR_DISPERSION_FLOOR}). Refusing — re-anchor.`;
    return buildEnvelope({
      tool: 'log10x_rank_by_shape_similarity',
      view: 'summary',
      summary: { headline },
      data,
    });
  }

  // ── Candidates ──────────────────────────────────────────────────────
  const customer = await resolveBackend();
  if (!customer.backend) {
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
        error_type: 'backend_unavailable',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'Customer metrics backend not configured. Set LOG10X_CUSTOMER_METRICS_URL.',
      },
    });
  }

  const ranked: RankedCandidate[] = [];
  const failed: string[] = [];

  for (const cand of args.candidates) {
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
  const lowCandidateCount: 'severe' | 'medium' | null =
    nUsable < 10 ? 'severe' : nUsable < 20 ? 'medium' : null;
  // No-signal status: all candidates had near-zero correlation.
  const anyMeaningfulCorr = ranked.some((r) => r.pearson_magnitude >= 0.1);
  const status: RankByShapeStatus = ranked.length === 0 || !anyMeaningfulCorr ? 'no_signal' : 'success';
  const top = ranked[0];
  const human_summary =
    status === 'no_signal'
      ? `No candidate showed meaningful shape similarity to the anchor (|Pearson| ≥ 0.1). ${ranked.length} ranked, ${failed.length} failed. Stop searching — re-anchor or widen the candidate pool.${thresholdBasis === 'default_uncalibrated' ? ' Thresholds are uncalibrated defaults — calibrate per backend.' : ''}`
      : `Ranked ${ranked.length} candidate(s) by |Pearson@lag|; ${failed.length} could not be evaluated.${
          top
            ? ` Top match: ${top.candidate} with |r|=${top.pearson_magnitude.toFixed(2)} at lag ${top.lag_seconds}s${top.lag_at_bound ? ' (boundary-pinned, real lag may be wider)' : ''}.`
            : ''
        }${lowCandidateCount === 'severe' ? ' Very few candidates were usable — weak evidence.' : ''}${thresholdBasis === 'default_uncalibrated' ? ' Thresholds uncalibrated.' : ''}`;

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
    n_candidates_evaluated: args.candidates.length - failed.length,
    n_candidates_usable: nUsable,
    low_candidate_count: lowCandidateCount,
    query_count: queryCount,
    total_latency_ms: totalLatencyMs,
    backend_pressure_hint: rankPressureHint(queryCount, totalLatencyMs, throttledHit),
    human_summary,
    ranked,
    evaluation_failed: failed,
  };
  const headline = `Ranked ${ranked.length} candidates by |Pearson@lag|. ${failed.length} could not be evaluated.`;

  // Markdown branch retained for in-process callers; deprecated.
  if (args.view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_rank_by_shape_similarity',
      summary: { headline },
      markdown: renderMarkdown(data),
    });
  }
  return buildEnvelope({
    tool: 'log10x_rank_by_shape_similarity',
    view: 'summary',
    summary: { headline },
    data,
  });
}

/** Same shape as metrics_that_moved's errorEnvelope, scoped to RankByShapeSummary. */
function rankErrorEnvelope(args: {
  anchor_type: 'log10x_pattern' | 'customer_metric';
  anchor_expression: string;
  window: string;
  stepSeconds: number;
  floor: number;
  thresholdBasis: 'default_uncalibrated' | 'caller_override';
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
  return buildEnvelope({
    tool: 'log10x_rank_by_shape_similarity',
    view: 'summary',
    summary: { headline: `Error (${args.err.error_type}): ${args.err.hint.slice(0, 120)}` },
    data,
  });
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

function renderMarkdown(d: RankByShapeSummary): string {
  const lines: string[] = [];
  lines.push(`## Shape similarity ranking`);
  lines.push('');
  lines.push(`**Anchor**: \`${d.anchor_expression}\``);
  lines.push(`**Window**: ${d.window} · step ${d.step_seconds}s · anchor ${d.n_anchor_buckets} buckets`);
  lines.push('');
  lines.push('| Candidate | r | lag (s) | tightness | bound | phase-aligned |');
  lines.push('|---|---:|---:|---:|---|---|');
  for (const r of d.ranked.slice(0, 20)) {
    const short = r.candidate.length > 50 ? r.candidate.slice(0, 47) + '...' : r.candidate;
    lines.push(`| \`${short}\` | ${r.pearson_signed >= 0 ? '+' : ''}${r.pearson_signed.toFixed(2)} | ${r.lag_seconds} | ${r.lag_tightness.toFixed(2)} | ${r.lag_at_bound ? 'YES' : ''} | ${r.anchor_phase_aligned ? 'YES' : 'no'} |`);
  }
  return lines.join('\n');
}
