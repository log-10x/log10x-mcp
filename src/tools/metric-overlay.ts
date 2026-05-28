/**
 * log10x_metric_overlay — deterministic primitive: return two timeseries
 * pre-aligned to the same timestamp grid, plus a small set of deterministic
 * facts the agent can read directly (peak_at, peak_value, peak_offset).
 *
 * Design rationale (from the design-dilemma consult + the chaos retest):
 * the agent's hardest call in cross-pillar correlation is "does this
 * candidate's curve actually lead/lag/co-move with the anchor's curve."
 * Pearson collapses that into one number; correlation tier compresses
 * further. The agent then has to trust the tool's verdict OR ask for
 * the raw curves anyway. This primitive gives the curves directly with
 * NO interpretation layer — no Pearson, no tier, no causal claim. The
 * agent eyeballs lead/lag the same way an SRE opens two Grafana panels
 * side by side.
 *
 * Inputs: anchor expression (a Log10x pattern OR a customer PromQL),
 * candidate expression (a customer PromQL), window + step.
 *
 * Output: aligned arrays of `(ts, anchor_value, candidate_value)` tuples
 * plus deterministic facts:
 *   - peak_anchor_at, peak_anchor_value
 *   - peak_candidate_at, peak_candidate_value
 *   - peak_offset_seconds (candidate_peak_ts - anchor_peak_ts; negative
 *     = candidate leads anchor)
 *   - n_buckets_aligned (how many buckets where both series have data)
 *
 * No Pearson. No tier. No verdict. Composes with rank_by_shape_similarity
 * (when the agent has many candidates) and metrics_that_moved (when the
 * agent is narrowing the candidate pool first).
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

export const metricOverlaySchema = {
  anchor_type: z
    .enum(['log10x_pattern', 'customer_metric'])
    .describe('Which side the anchor comes from. `log10x_pattern`: anchor is a 10x pattern symbol_message. `customer_metric`: anchor is a customer PromQL expression.'),
  anchor: z
    .string()
    .describe('The anchor identity. For `log10x_pattern`: the pattern symbol_message (e.g. `error_processing_payment_$`). For `customer_metric`: a PromQL expression (e.g. `apm_request_duration_p99{service="payments"}`).'),
  candidate: z
    .string()
    .describe('The candidate metric to overlay against the anchor. Must be a customer-side PromQL expression that returns a single series (use `sum(...)` if needed to collapse multi-series results).'),
  window: z
    .string()
    .default('1h')
    .describe('Time window. PromQL-style duration: `15m`, `1h`, `6h`, `24h`. Alias: `timeRange`.'),
  timeRange: z.string().optional().describe('Alias for `window`.'),
  step: z
    .string()
    .default('30s')
    .describe('Bucket step. Smaller = more samples + more cost. Default 30s.'),
  max_buckets: z
    .number()
    .min(20)
    .max(2000)
    .default(240)
    .describe('Max buckets to return in the aligned output. Pre-truncates from the most recent end if window/step exceeds this.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

/**
 * Top-level call status. Agent branches on this before reading anything else.
 *   - `success`: math ran cleanly; read `series` and `facts`.
 *   - `anchor_no_phase_separation`: anchor MAD/median < 0.15. Refused.
 *   - `no_signal`: anchor or candidate returned no overlapping data.
 *   - `error`: structural failure; read `data.error`.
 */
export type MetricOverlayStatus =
  | 'success'
  | 'anchor_no_phase_separation'
  | 'no_signal'
  | 'error';

interface MetricOverlaySummary {
  status: MetricOverlayStatus;
  threshold_basis: 'default_uncalibrated' | 'caller_override';
  anchor_ref: {
    type: 'log10x_pattern' | 'customer_metric';
    expression: string;
  };
  candidate_ref: string;
  anchor_dispersion: number;
  query_count: number;
  total_latency_ms: number;
  backend_pressure_hint: 'ok' | 'slow' | 'throttled' | null;
  human_summary: string;
  anchor: { type: 'log10x_pattern' | 'customer_metric'; expression: string };
  candidate: string;
  window: string;
  step_seconds: number;
  n_anchor_buckets: number;
  n_candidate_buckets: number;
  n_buckets_aligned: number;
  /**
   * Aligned timeseries: each entry is one shared timestamp with both
   * values. When a series has no data at that timestamp, the value is
   * `null` (NOT zero — zero is a real value an SRE may need to
   * distinguish from absence).
   */
  series: Array<{
    ts: number;
    anchor_value: number | null;
    candidate_value: number | null;
  }>;
  /**
   * Deterministic facts. Each peak is the timestamp where the value
   * reached its maximum across the aligned window. `peak_offset_seconds`
   * = candidate_peak_ts - anchor_peak_ts; NEGATIVE = candidate leads
   * anchor (possible cause), POSITIVE = candidate lags (possible
   * effect), ZERO = concurrent. Null when one side has no data.
   */
  facts: {
    peak_anchor_at: number | null;
    peak_anchor_value: number | null;
    peak_candidate_at: number | null;
    peak_candidate_value: number | null;
    peak_offset_seconds: number | null;
    anchor_value_at_candidate_peak: number | null;
    candidate_value_at_anchor_peak: number | null;
  };
  /** Populated only when `status === 'error'`. */
  error?: PrimitiveError;
}

export async function executeMetricOverlay(
  args: {
    anchor_type: 'log10x_pattern' | 'customer_metric';
    anchor: string;
    candidate: string;
    window?: string;
    timeRange?: string;
    step?: string;
    max_buckets?: number;
    environment?: string;
    /** Ignored. Retained for backward-compat with in-process callers. */
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<StructuredOutput> {
  const window = args.window ?? args.timeRange ?? '1h';
  const stepStr = args.step ?? '30s';
  const stepSeconds = parseStep(stepStr);
  const maxBuckets = args.max_buckets ?? 240;

  const tf = parseTimeframe(window);
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - Math.floor(tf.days * 86400);

  // metric_overlay has no thresholds, so threshold_basis is always
  // default_uncalibrated (no caller can override what doesn't exist).
  const thresholdBasis: 'default_uncalibrated' | 'caller_override' = 'default_uncalibrated';

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

  // ── Fetch anchor series ─────────────────────────────────────────────
  let anchorSeries: Array<[number, number]>;
  let anchorExpression: string;
  try {
    if (args.anchor_type === 'log10x_pattern') {
      const metricsEnv = await resolveMetricsEnv(env);
      const escaped = args.anchor.replace(/"/g, '\\"');
      anchorExpression = `sum(rate(all_events_summaryBytes_total{${LABELS.pattern}="${escaped}",${LABELS.env}="${metricsEnv}"}[${Math.max(stepSeconds * 3, 180)}s]))`;
      const res = await timedQuery(() => queryRange(env, anchorExpression, fromSec, nowSec, stepSeconds));
      anchorSeries = extractFirstSeries(res);
    } else {
      anchorExpression = args.anchor;
      const backend = await resolveBackend();
      if (!backend.backend) {
        return overlayErrorEnvelope({
          anchor_type: args.anchor_type,
          anchor_expression: anchorExpression,
          candidate: args.candidate,
          window,
          stepSeconds,
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
      const res = await timedQuery(() => backend.backend!.queryRange(args.anchor, fromSec, nowSec, stepSeconds));
      anchorSeries = extractFirstSeries(res);
    }
  } catch (e) {
    const err = wrapBackendError(e);
    if (/HTTP 429/.test(err.hint)) throttledHit = true;
    return overlayErrorEnvelope({
      anchor_type: args.anchor_type,
      anchor_expression: args.anchor,
      candidate: args.candidate,
      window,
      stepSeconds,
      thresholdBasis,
      queryCount,
      totalLatencyMs,
      throttledHit,
      err,
    });
  }

  // ── Anchor dispersion guard ────────────────────────────────────────
  const anchorValues = anchorSeries.map(([, v]) => v);
  const anchorDispersion = computeAnchorDispersion(anchorValues);
  if (anchorSeries.length >= 6 && anchorDispersion < ANCHOR_DISPERSION_FLOOR) {
    return overlayDispersionRefusal({
      anchor_type: args.anchor_type,
      anchor_expression: anchorExpression,
      candidate: args.candidate,
      window,
      stepSeconds,
      thresholdBasis,
      queryCount,
      totalLatencyMs,
      throttledHit,
      anchorDispersion,
      nAnchorBuckets: anchorSeries.length,
      view: args.view ?? 'summary',
    });
  }

  // ── Fetch candidate series (always customer-side) ───────────────────
  const backend = await resolveBackend();
  if (!backend.backend) {
    return overlayErrorEnvelope({
      anchor_type: args.anchor_type,
      anchor_expression: anchorExpression,
      candidate: args.candidate,
      window,
      stepSeconds,
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
  let candSeries: Array<[number, number]>;
  try {
    const candRes = await timedQuery(() => backend.backend!.queryRange(args.candidate, fromSec, nowSec, stepSeconds));
    candSeries = extractFirstSeries(candRes);
  } catch (e) {
    const err = wrapBackendError(e);
    if (/HTTP 429/.test(err.hint)) throttledHit = true;
    return overlayErrorEnvelope({
      anchor_type: args.anchor_type,
      anchor_expression: anchorExpression,
      candidate: args.candidate,
      window,
      stepSeconds,
      thresholdBasis,
      queryCount,
      totalLatencyMs,
      throttledHit,
      err,
    });
  }

  // ── Build aligned grid ──────────────────────────────────────────────
  // Use a deterministic timestamp grid based on (fromSec, nowSec, stepSeconds)
  // so the two series align on the same buckets regardless of what each
  // backend returned. Missing data on either side → null (NOT zero — zero
  // is a real value the agent must distinguish from absence).
  const gridStart = nowSec - Math.floor((nowSec - fromSec) / stepSeconds) * stepSeconds;
  const totalBuckets = Math.min(
    maxBuckets,
    Math.floor((nowSec - gridStart) / stepSeconds) + 1,
  );
  const gridFromSec = nowSec - (totalBuckets - 1) * stepSeconds;

  const anchorMap = new Map<number, number>();
  for (const [ts, v] of anchorSeries) {
    const aligned = Math.round((ts - gridFromSec) / stepSeconds) * stepSeconds + gridFromSec;
    anchorMap.set(aligned, v);
  }
  const candMap = new Map<number, number>();
  for (const [ts, v] of candSeries) {
    const aligned = Math.round((ts - gridFromSec) / stepSeconds) * stepSeconds + gridFromSec;
    candMap.set(aligned, v);
  }

  const series: MetricOverlaySummary['series'] = [];
  let nAligned = 0;
  for (let i = 0; i < totalBuckets; i++) {
    const ts = gridFromSec + i * stepSeconds;
    const a = anchorMap.has(ts) ? anchorMap.get(ts)! : null;
    const c = candMap.has(ts) ? candMap.get(ts)! : null;
    if (a !== null && c !== null) nAligned += 1;
    series.push({ ts, anchor_value: a, candidate_value: c });
  }

  // ── Deterministic facts ─────────────────────────────────────────────
  const aPeak = peakOf(series.map((s) => ({ ts: s.ts, v: s.anchor_value })));
  const cPeak = peakOf(series.map((s) => ({ ts: s.ts, v: s.candidate_value })));
  const peakOffset =
    aPeak && cPeak ? cPeak.ts - aPeak.ts : null;
  const anchorAtCandPeak = cPeak
    ? (series.find((s) => s.ts === cPeak.ts)?.anchor_value ?? null)
    : null;
  const candAtAnchorPeak = aPeak
    ? (series.find((s) => s.ts === aPeak.ts)?.candidate_value ?? null)
    : null;

  // Status: no_signal when either side has no data OR the aligned
  // overlap is empty. Otherwise success.
  const status: MetricOverlayStatus =
    anchorSeries.length === 0 || candSeries.length === 0 || nAligned === 0
      ? 'no_signal'
      : 'success';

  const candidate_ref = canonicalMetricRef(args.candidate);
  const human_summary =
    status === 'no_signal'
      ? `No overlapping data between anchor "${anchorExpression}" and candidate "${args.candidate}" in this window. Either widen the window, check that both metrics emitted during it, or pick a different candidate.`
      : peakOffset === null
        ? `Overlay of "${args.candidate}" against the anchor. ${nAligned} aligned buckets. One side has no peak — likely too few data points on the candidate.`
        : peakOffset < 0
          ? `Candidate "${args.candidate}" peaks ${Math.abs(peakOffset)}s BEFORE the anchor. Possible upstream cause. ${nAligned} aligned buckets.`
          : peakOffset > 0
            ? `Candidate "${args.candidate}" peaks ${peakOffset}s AFTER the anchor. Possible downstream effect. ${nAligned} aligned buckets.`
            : `Candidate "${args.candidate}" peaks at the same time as the anchor. ${nAligned} aligned buckets.`;

  const data: MetricOverlaySummary = {
    status,
    threshold_basis: thresholdBasis,
    anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(anchorExpression) },
    candidate_ref,
    anchor_dispersion: anchorDispersion,
    query_count: queryCount,
    total_latency_ms: totalLatencyMs,
    backend_pressure_hint: overlayPressureHint(queryCount, totalLatencyMs, throttledHit),
    human_summary,
    anchor: { type: args.anchor_type, expression: anchorExpression },
    candidate: args.candidate,
    window,
    step_seconds: stepSeconds,
    n_anchor_buckets: anchorSeries.length,
    n_candidate_buckets: candSeries.length,
    n_buckets_aligned: nAligned,
    series,
    facts: {
      peak_anchor_at: aPeak?.ts ?? null,
      peak_anchor_value: aPeak?.v ?? null,
      peak_candidate_at: cPeak?.ts ?? null,
      peak_candidate_value: cPeak?.v ?? null,
      peak_offset_seconds: peakOffset,
      anchor_value_at_candidate_peak: anchorAtCandPeak,
      candidate_value_at_anchor_peak: candAtAnchorPeak,
    },
  };

  const headline = buildHeadline(data);
  if (args.view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_metric_overlay',
      summary: { headline },
      markdown: renderMarkdown(data),
    });
  }
  return buildEnvelope({
    tool: 'log10x_metric_overlay',
    view: 'summary',
    summary: { headline },
    data,
  });
}

function overlayErrorEnvelope(args: {
  anchor_type: 'log10x_pattern' | 'customer_metric';
  anchor_expression: string;
  candidate: string;
  window: string;
  stepSeconds: number;
  thresholdBasis: 'default_uncalibrated' | 'caller_override';
  queryCount: number;
  totalLatencyMs: number;
  throttledHit: boolean;
  err: PrimitiveError;
}): StructuredOutput {
  const data: MetricOverlaySummary = {
    status: 'error',
    threshold_basis: args.thresholdBasis,
    anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(args.anchor_expression) },
    candidate_ref: canonicalMetricRef(args.candidate),
    anchor_dispersion: 0,
    query_count: args.queryCount,
    total_latency_ms: args.totalLatencyMs,
    backend_pressure_hint: overlayPressureHint(args.queryCount, args.totalLatencyMs, args.throttledHit),
    human_summary: `Call failed: ${args.err.hint}`,
    anchor: { type: args.anchor_type, expression: args.anchor_expression },
    candidate: args.candidate,
    window: args.window,
    step_seconds: args.stepSeconds,
    n_anchor_buckets: 0,
    n_candidate_buckets: 0,
    n_buckets_aligned: 0,
    series: [],
    facts: {
      peak_anchor_at: null,
      peak_anchor_value: null,
      peak_candidate_at: null,
      peak_candidate_value: null,
      peak_offset_seconds: null,
      anchor_value_at_candidate_peak: null,
      candidate_value_at_anchor_peak: null,
    },
    error: args.err,
  };
  return buildEnvelope({
    tool: 'log10x_metric_overlay',
    view: 'summary',
    summary: { headline: `Error (${args.err.error_type}): ${args.err.hint.slice(0, 120)}` },
    data,
  });
}

function overlayDispersionRefusal(args: {
  anchor_type: 'log10x_pattern' | 'customer_metric';
  anchor_expression: string;
  candidate: string;
  window: string;
  stepSeconds: number;
  thresholdBasis: 'default_uncalibrated' | 'caller_override';
  queryCount: number;
  totalLatencyMs: number;
  throttledHit: boolean;
  anchorDispersion: number;
  nAnchorBuckets: number;
  view: 'summary' | 'markdown';
}): StructuredOutput {
  const humanSummary = `Anchor "${args.anchor_expression}" has dispersion ${args.anchorDispersion.toFixed(3)} — below the ${ANCHOR_DISPERSION_FLOOR} floor. The overlay would have no meaningful peak comparison. Re-anchor with a clearer pattern.`;
  const data: MetricOverlaySummary = {
    status: 'anchor_no_phase_separation',
    threshold_basis: args.thresholdBasis,
    anchor_ref: { type: args.anchor_type, expression: canonicalMetricRef(args.anchor_expression) },
    candidate_ref: canonicalMetricRef(args.candidate),
    anchor_dispersion: args.anchorDispersion,
    query_count: args.queryCount,
    total_latency_ms: args.totalLatencyMs,
    backend_pressure_hint: overlayPressureHint(args.queryCount, args.totalLatencyMs, args.throttledHit),
    human_summary: humanSummary,
    anchor: { type: args.anchor_type, expression: args.anchor_expression },
    candidate: args.candidate,
    window: args.window,
    step_seconds: args.stepSeconds,
    n_anchor_buckets: args.nAnchorBuckets,
    n_candidate_buckets: 0,
    n_buckets_aligned: 0,
    series: [],
    facts: {
      peak_anchor_at: null,
      peak_anchor_value: null,
      peak_candidate_at: null,
      peak_candidate_value: null,
      peak_offset_seconds: null,
      anchor_value_at_candidate_peak: null,
      candidate_value_at_anchor_peak: null,
    },
  };
  const headline = `Anchor lacks phase separation (dispersion ${args.anchorDispersion.toFixed(3)} < ${ANCHOR_DISPERSION_FLOOR}). Refusing — re-anchor.`;
  if (args.view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_metric_overlay',
      summary: { headline },
      markdown: humanSummary,
    });
  }
  return buildEnvelope({
    tool: 'log10x_metric_overlay',
    view: 'summary',
    summary: { headline },
    data,
  });
}

function overlayPressureHint(
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

function extractFirstSeries(
  res: { status?: string; data?: { result?: Array<{ values?: Array<[number, string]> }> } } | undefined,
): Array<[number, number]> {
  if (!res || res.status !== 'success') return [];
  const first = res.data?.result?.[0]?.values;
  if (!first) return [];
  return first.map(([t, v]) => [Number(t), parseFloat(v)] as [number, number]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
}

export function peakOf(points: Array<{ ts: number; v: number | null }>): { ts: number; v: number } | null {
  let best: { ts: number; v: number } | null = null;
  for (const p of points) {
    if (p.v === null) continue;
    if (!best || p.v > best.v) best = { ts: p.ts, v: p.v };
  }
  return best;
}

function buildHeadline(d: MetricOverlaySummary): string {
  if (d.n_buckets_aligned === 0) {
    return `No overlapping data: anchor has ${d.n_anchor_buckets} buckets, candidate has ${d.n_candidate_buckets}, no shared timestamps.`;
  }
  const offset = d.facts.peak_offset_seconds;
  const direction =
    offset === null
      ? 'no peak alignment'
      : offset === 0
      ? 'concurrent peaks'
      : offset < 0
      ? `candidate leads by ${-offset}s`
      : `candidate lags by ${offset}s`;
  return `Overlay over ${d.window}: ${d.n_buckets_aligned} aligned buckets, ${direction}.`;
}

function renderMarkdown(d: MetricOverlaySummary): string {
  const lines: string[] = [];
  lines.push(`## Metric overlay`);
  lines.push('');
  lines.push(`**Anchor** (${d.anchor.type}): \`${d.anchor.expression}\``);
  lines.push(`**Candidate**: \`${d.candidate}\``);
  lines.push(`**Window**: ${d.window} · step ${d.step_seconds}s · ${d.n_buckets_aligned} aligned of ${d.series.length} buckets`);
  lines.push('');
  lines.push('### Facts');
  if (d.facts.peak_anchor_at) {
    lines.push(`- Anchor peak: ${d.facts.peak_anchor_value} at ${new Date(d.facts.peak_anchor_at * 1000).toISOString()}`);
  }
  if (d.facts.peak_candidate_at) {
    lines.push(`- Candidate peak: ${d.facts.peak_candidate_value} at ${new Date(d.facts.peak_candidate_at * 1000).toISOString()}`);
  }
  if (d.facts.peak_offset_seconds !== null) {
    const o = d.facts.peak_offset_seconds;
    const dir = o === 0 ? 'concurrent' : o < 0 ? `candidate leads anchor by ${-o}s` : `candidate lags anchor by ${o}s`;
    lines.push(`- Peak offset: ${o}s (${dir})`);
  }
  if (d.facts.candidate_value_at_anchor_peak !== null) {
    lines.push(`- Candidate value when anchor peaked: ${d.facts.candidate_value_at_anchor_peak}`);
  }
  if (d.facts.anchor_value_at_candidate_peak !== null) {
    lines.push(`- Anchor value when candidate peaked: ${d.facts.anchor_value_at_candidate_peak}`);
  }
  lines.push('');
  lines.push(`### Aligned series (first 5, last 5 of ${d.series.length})`);
  for (const s of d.series.slice(0, 5)) {
    lines.push(`- ${new Date(s.ts * 1000).toISOString()}  anchor=${s.anchor_value}  candidate=${s.candidate_value}`);
  }
  if (d.series.length > 10) lines.push('  ...');
  for (const s of d.series.slice(-5)) {
    lines.push(`- ${new Date(s.ts * 1000).toISOString()}  anchor=${s.anchor_value}  candidate=${s.candidate_value}`);
  }
  return lines.join('\n');
}
