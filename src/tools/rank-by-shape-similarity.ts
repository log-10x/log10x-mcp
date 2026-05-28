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

// Lag offsets widened to ±1800s to catch slow-moving upstream causes.
const LAG_OFFSETS_SECONDS = [
  -1800, -1200, -600, -300, -180, -120, -60, -30, 0, 30, 60, 120, 180, 300, 600, 1200, 1800,
];
const LAG_SEARCH_MAX_ABS = Math.max(...LAG_OFFSETS_SECONDS.map((s) => Math.abs(s)));

export const rankByShapeSimilaritySchema = {
  anchor_type: z.enum(['log10x_pattern', 'customer_metric']),
  anchor: z.string().describe('Anchor identity (pattern symbol_message OR customer PromQL).'),
  candidates: z.array(z.string()).min(1).max(200).describe('Customer-side PromQL expressions to rank.'),
  window: z.string().default('1h'),
  timeRange: z.string().optional(),
  step: z.string().default('30s'),
  environment: z.string().optional(),
  view: z.enum(['summary', 'markdown']).default('summary'),
};

interface RankedCandidate {
  candidate: string;
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

interface RankByShapeSummary {
  anchor_expression: string;
  window: string;
  step_seconds: number;
  n_anchor_buckets: number;
  n_candidates_evaluated: number;
  ranked: RankedCandidate[];
  evaluation_failed: string[];
}

export async function executeRankByShapeSimilarity(
  args: {
    anchor_type: 'log10x_pattern' | 'customer_metric';
    anchor: string;
    candidates: string[];
    window?: string;
    timeRange?: string;
    step?: string;
    environment?: string;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  const window = args.window ?? args.timeRange ?? '1h';
  const stepStr = args.step ?? '30s';
  const stepSeconds = parseStep(stepStr);
  const view = args.view ?? 'summary';

  const tf = parseTimeframe(window);
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - Math.floor(tf.days * 86400);

  // ── Anchor ──────────────────────────────────────────────────────────
  let anchorExpression: string;
  let anchorSeries: number[];
  if (args.anchor_type === 'log10x_pattern') {
    const metricsEnv = await resolveMetricsEnv(env);
    const escaped = args.anchor.replace(/"/g, '\\"');
    anchorExpression = `sum(rate(all_events_summaryBytes_total{${LABELS.pattern}="${escaped}",${LABELS.env}="${metricsEnv}"}[${Math.max(stepSeconds * 3, 180)}s]))`;
    const res = await queryRange(env, anchorExpression, fromSec, nowSec, stepSeconds);
    anchorSeries = extractValues(res);
  } else {
    anchorExpression = args.anchor;
    const backendInfo = await resolveBackend();
    if (!backendInfo.backend) {
      return buildMarkdownEnvelope({
        tool: 'log10x_rank_by_shape_similarity',
        summary: { headline: 'Customer metrics backend not configured.' },
        markdown: 'Anchor of type `customer_metric` requires a configured customer metrics backend.',
      });
    }
    const res = await backendInfo.backend.queryRange(args.anchor, fromSec, nowSec, stepSeconds);
    anchorSeries = extractValues(res);
  }
  if (anchorSeries.length < 3) {
    return buildMarkdownEnvelope({
      tool: 'log10x_rank_by_shape_similarity',
      summary: { headline: `Anchor has ${anchorSeries.length} buckets — too few to rank.` },
      markdown: 'Anchor returned too few data points for ranking.',
    });
  }

  // ── Candidates ──────────────────────────────────────────────────────
  const customer = await resolveBackend();
  if (!customer.backend) {
    return buildMarkdownEnvelope({
      tool: 'log10x_rank_by_shape_similarity',
      summary: { headline: 'Customer metrics backend not configured.' },
      markdown: 'Candidate ranking requires a configured customer metrics backend.',
    });
  }

  const ranked: RankedCandidate[] = [];
  const failed: string[] = [];

  for (const cand of args.candidates) {
    try {
      const res = await customer.backend.queryRange(cand, fromSec, nowSec, stepSeconds);
      const candSeries = extractValues(res);
      if (candSeries.length < 3) {
        failed.push(cand);
        continue;
      }
      const corr = computeTemporalCorrelation(anchorSeries, candSeries, stepSeconds);
      const gap = anchorPhaseGap(anchorSeries, candSeries);
      ranked.push({
        candidate: cand,
        pearson_magnitude: Math.abs(corr.r),
        pearson_signed: corr.r,
        lag_seconds: corr.lagSeconds,
        lag_at_bound: Math.abs(corr.lagSeconds) >= LAG_SEARCH_MAX_ABS,
        lag_tightness: corr.lagTightness,
        anchor_phase_gap: gap,
        anchor_phase_aligned: gap >= 0.15,
        n_buckets: candSeries.length,
      });
    } catch {
      failed.push(cand);
    }
  }
  ranked.sort((a, b) => b.pearson_magnitude - a.pearson_magnitude);

  const data: RankByShapeSummary = {
    anchor_expression: anchorExpression,
    window,
    step_seconds: stepSeconds,
    n_anchor_buckets: anchorSeries.length,
    n_candidates_evaluated: args.candidates.length - failed.length,
    ranked,
    evaluation_failed: failed,
  };
  const headline = `Ranked ${ranked.length} candidates by |Pearson@lag|. ${failed.length} could not be evaluated.`;

  if (view === 'markdown') {
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

interface TemporalResult {
  r: number;
  lagSeconds: number;
  lagTightness: number;
}

function computeTemporalCorrelation(anchor: number[], candidate: number[], step: number): TemporalResult {
  if (anchor.length === 0 || candidate.length === 0) return { r: 0, lagSeconds: 0, lagTightness: 0 };
  // Right-align (sparse-anchor vs dense-candidate alignment fix from v4).
  const n = Math.min(anchor.length, candidate.length);
  const a = anchor.slice(-n);
  const c = candidate.slice(-n);
  const offsets = LAG_OFFSETS_SECONDS.map((s) => Math.round(s / step));
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

function pearsonWithOffset(a: number[], b: number[], offset: number): number {
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

function anchorPhaseGap(anchor: number[], candidate: number[]): number {
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
