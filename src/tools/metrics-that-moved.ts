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
import { resolveBackend } from '../lib/customer-metrics.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { LABELS } from '../lib/promql.js';
import { parseTimeframe } from '../lib/format.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const metricsThatMovedSchema = {
  anchor_type: z
    .enum(['log10x_pattern', 'customer_metric'])
    .describe('Anchor side. `log10x_pattern` = anchor is a 10x pattern. `customer_metric` = anchor is a customer PromQL.'),
  anchor: z.string().describe('Anchor identity (pattern symbol_message OR customer PromQL expression).'),
  candidates: z
    .array(z.string())
    .min(1)
    .max(200)
    .describe('Customer-side PromQL expressions to evaluate. Compose with `metrics_sharing_resource` or pull from `customer_metrics_query` to build this list.'),
  window: z.string().default('1h').describe('Time window. Alias: `timeRange`.'),
  timeRange: z.string().optional(),
  step: z.string().default('30s').describe('Bucket step.'),
  phase_gap_floor: z
    .number()
    .min(0.0)
    .max(1.0)
    .default(0.15)
    .describe('Relative gap floor between anchor-high and anchor-low phase means. Candidate is "moved" iff its gap ≥ this. Default 0.15 (=15%).'),
  environment: z.string().optional(),
  view: z.enum(['summary', 'markdown']).default('summary'),
};

interface MovedCandidate {
  candidate: string;
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

interface MetricsThatMovedSummary {
  anchor_expression: string;
  window: string;
  step_seconds: number;
  phase_gap_floor: number;
  n_anchor_buckets: number;
  n_candidates_evaluated: number;
  /** Candidates whose phase_gap ≥ floor. Sorted by gap descending. */
  moved: MovedCandidate[];
  /** Candidates whose phase_gap < floor. Returned for transparency so
   * the agent can see what was filtered out. */
  not_moved: MovedCandidate[];
  /** Candidates that couldn't be evaluated (insufficient data on either
   * phase). Surface so the agent doesn't assume "absent = not moved." */
  evaluation_failed: string[];
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
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  const window = args.window ?? args.timeRange ?? '1h';
  const stepStr = args.step ?? '30s';
  const stepSeconds = parseStep(stepStr);
  const floor = args.phase_gap_floor ?? 0.15;
  const view = args.view ?? 'summary';

  const tf = parseTimeframe(window);
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - Math.floor(tf.days * 86400);

  // ── Anchor series ──────────────────────────────────────────────────
  let anchorExpression: string;
  let anchorSeries: Array<[number, number]>;
  if (args.anchor_type === 'log10x_pattern') {
    const metricsEnv = await resolveMetricsEnv(env);
    const escaped = args.anchor.replace(/"/g, '\\"');
    anchorExpression = `sum(rate(all_events_summaryBytes_total{${LABELS.pattern}="${escaped}",${LABELS.env}="${metricsEnv}"}[${Math.max(stepSeconds * 3, 180)}s]))`;
    const res = await queryRange(env, anchorExpression, fromSec, nowSec, stepSeconds);
    anchorSeries = extractFirstSeries(res);
  } else {
    anchorExpression = args.anchor;
    const backendInfo = await resolveBackend();
    if (!backendInfo.backend) {
      return buildMarkdownEnvelope({
        tool: 'log10x_metrics_that_moved',
        summary: { headline: 'Customer metrics backend not configured.' },
        markdown: 'Anchor of type `customer_metric` requires a configured customer metrics backend.',
      });
    }
    const res = await backendInfo.backend.queryRange(args.anchor, fromSec, nowSec, stepSeconds);
    anchorSeries = extractFirstSeries(res);
  }

  if (anchorSeries.length < 6) {
    return buildMarkdownEnvelope({
      tool: 'log10x_metrics_that_moved',
      summary: { headline: `Anchor has only ${anchorSeries.length} buckets — insufficient for phase analysis.` },
      markdown: `Anchor returned ${anchorSeries.length} data points over the requested window. Need ≥6 to partition into high/low phases. Widen the window or check that the anchor actually emitted data during this window.`,
    });
  }

  // Compute anchor median (robust to long tails) and partition timestamps.
  const sorted = anchorSeries.map(([, v]) => v).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const anchorHighTs = new Set<number>();
  const anchorLowTs = new Set<number>();
  for (const [ts, v] of anchorSeries) {
    if (v > median) anchorHighTs.add(ts);
    else anchorLowTs.add(ts);
  }

  // ── Candidates ──────────────────────────────────────────────────────
  const customerBackend = await resolveBackend();
  if (!customerBackend.backend) {
    return buildMarkdownEnvelope({
      tool: 'log10x_metrics_that_moved',
      summary: { headline: 'Customer metrics backend not configured.' },
      markdown: 'Candidate evaluation requires a configured customer metrics backend.',
    });
  }

  const moved: MovedCandidate[] = [];
  const notMoved: MovedCandidate[] = [];
  const failed: string[] = [];

  for (const cand of args.candidates) {
    try {
      const res = await customerBackend.backend.queryRange(cand, fromSec, nowSec, stepSeconds);
      const candSeries = extractFirstSeries(res);
      if (candSeries.length < 6) {
        failed.push(cand);
        continue;
      }
      // Align candidate values to the anchor's timestamp partitions.
      // Round each candidate ts to the step grid for matching.
      let sumHigh = 0,
        nHigh = 0,
        sumLow = 0,
        nLow = 0;
      for (const [ts, v] of candSeries) {
        const aligned = Math.round(ts / stepSeconds) * stepSeconds;
        // Find the closest anchor bucket (within 1 step).
        const matchedHigh = inSetWithin(anchorHighTs, aligned, stepSeconds);
        const matchedLow = inSetWithin(anchorLowTs, aligned, stepSeconds);
        if (matchedHigh) {
          sumHigh += v;
          nHigh += 1;
        } else if (matchedLow) {
          sumLow += v;
          nLow += 1;
        }
      }
      if (nHigh < 2 || nLow < 2) {
        failed.push(cand);
        continue;
      }
      const meanHigh = sumHigh / nHigh;
      const meanLow = sumLow / nLow;
      const scale = Math.max(Math.abs(meanHigh), Math.abs(meanLow), 1e-9);
      const gap = Math.abs(meanHigh - meanLow) / scale;
      const direction: 'co' | 'anti' = meanHigh - meanLow >= 0 ? 'co' : 'anti';
      const row: MovedCandidate = {
        candidate: cand,
        mean_anchor_high: meanHigh,
        mean_anchor_low: meanLow,
        phase_gap: gap,
        direction,
        n_high: nHigh,
        n_low: nLow,
      };
      if (gap >= floor) moved.push(row);
      else notMoved.push(row);
    } catch {
      failed.push(cand);
    }
  }

  moved.sort((a, b) => b.phase_gap - a.phase_gap);
  notMoved.sort((a, b) => b.phase_gap - a.phase_gap);

  const data: MetricsThatMovedSummary = {
    anchor_expression: anchorExpression,
    window,
    step_seconds: stepSeconds,
    phase_gap_floor: floor,
    n_anchor_buckets: anchorSeries.length,
    n_candidates_evaluated: args.candidates.length - failed.length,
    moved,
    not_moved: notMoved,
    evaluation_failed: failed,
  };

  const headline = `${moved.length} of ${args.candidates.length} candidates moved with anchor (phase_gap ≥ ${floor}). ${notMoved.length} did not move. ${failed.length} could not be evaluated.`;

  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_metrics_that_moved',
      summary: { headline },
      markdown: renderMarkdown(data),
    });
  }
  return buildEnvelope({
    tool: 'log10x_metrics_that_moved',
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
  return first
    .map(([t, v]) => [Number(t), parseFloat(v)] as [number, number])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
}

function inSetWithin(s: Set<number>, ts: number, tolerance: number): boolean {
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
