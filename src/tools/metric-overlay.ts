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
  view: z.enum(['summary', 'markdown']).default('summary').describe('Output format.'),
};

interface MetricOverlaySummary {
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
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  const window = args.window ?? args.timeRange ?? '1h';
  const stepStr = args.step ?? '30s';
  const stepSeconds = parseStep(stepStr);
  const maxBuckets = args.max_buckets ?? 240;
  const view = args.view ?? 'summary';

  const tf = parseTimeframe(window);
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - Math.floor(tf.days * 86400);

  // ── Fetch anchor series ─────────────────────────────────────────────
  let anchorSeries: Array<[number, number]>;
  let anchorExpression: string;
  if (args.anchor_type === 'log10x_pattern') {
    const metricsEnv = await resolveMetricsEnv(env);
    const escaped = args.anchor.replace(/"/g, '\\"');
    anchorExpression = `sum(rate(all_events_summaryBytes_total{${LABELS.pattern}="${escaped}",${LABELS.env}="${metricsEnv}"}[${Math.max(stepSeconds * 3, 180)}s]))`;
    const res = await queryRange(env, anchorExpression, fromSec, nowSec, stepSeconds);
    anchorSeries = extractFirstSeries(res);
  } else {
    anchorExpression = args.anchor;
    const backend = await resolveBackend();
    if (!backend.backend) {
      return buildMarkdownEnvelope({
        tool: 'log10x_metric_overlay',
        summary: { headline: 'Customer metrics backend not configured.' },
        markdown: 'Customer metric anchor requires a configured customer metrics backend. Set `LOG10X_CUSTOMER_METRICS_URL` or run `log10x_doctor` to diagnose.',
      });
    }
    const res = await backend.backend.queryRange(args.anchor, fromSec, nowSec, stepSeconds);
    anchorSeries = extractFirstSeries(res);
  }

  // ── Fetch candidate series (always customer-side) ───────────────────
  const backend = await resolveBackend();
  if (!backend.backend) {
    return buildMarkdownEnvelope({
      tool: 'log10x_metric_overlay',
      summary: { headline: 'Customer metrics backend not configured.' },
      markdown: 'Candidate requires a configured customer metrics backend. Set `LOG10X_CUSTOMER_METRICS_URL` or run `log10x_doctor`.',
    });
  }
  const candRes = await backend.backend.queryRange(args.candidate, fromSec, nowSec, stepSeconds);
  const candSeries = extractFirstSeries(candRes);

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

  const data: MetricOverlaySummary = {
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
  if (view === 'markdown') {
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
