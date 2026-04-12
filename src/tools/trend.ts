/**
 * log10x_pattern_trend — volume trend for a specific pattern over time.
 *
 * Shows time series data with spike detection.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryRange } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { bytesToCost } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { fmtDollar, fmtPattern, fmtBytes, parseTimeframe, costPeriodLabel } from '../lib/format.js';

export const trendSchema = {
  pattern: z.string().describe('Pattern name (e.g., "Payment_Gateway_Timeout")'),
  timeRange: z.enum(['1d', '7d', '30d']).default('7d').describe('Time range'),
  step: z.enum(['5m', '1h', '6h', '1d']).default('1h').describe('Data point interval'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB'),
  environment: z.string().optional().describe('Environment nickname'),
};

export async function executeTrend(
  args: { pattern: string; timeRange: string; step: string; analyzerCost: number },
  env: EnvConfig
): Promise<string> {
  const tf = parseTimeframe(args.timeRange);
  const costPerGb = args.analyzerCost;
  const period = costPeriodLabel(tf.days);
  const metricsEnv = await resolveMetricsEnv(env);

  const now = Math.floor(Date.now() / 1000);
  const start = now - tf.days * 86400;
  const stepSeconds = parseStep(args.step);

  const query = pql.patternBytesOverTime(args.pattern, metricsEnv, args.step);
  const res = await queryRange(env, query, start, now, stepSeconds);

  if (res.status !== 'success' || res.data.result.length === 0) {
    return `No trend data for pattern "${args.pattern}" in the ${tf.label}.`;
  }

  // Extract time series
  const series = res.data.result[0];
  const points: { ts: number; bytes: number }[] = [];
  for (const [ts, val] of (series.values || [])) {
    points.push({ ts, bytes: parseFloat(val) || 0 });
  }

  if (points.length === 0) {
    return `No data points for pattern "${args.pattern}".`;
  }

  // Compute stats
  const totalBytes = points.reduce((s, p) => s + p.bytes, 0);
  const totalCost = bytesToCost(totalBytes, costPerGb);
  const avgBytes = totalBytes / points.length;
  const maxPoint = points.reduce((max, p) => p.bytes > max.bytes ? p : max, points[0]);
  const minPoint = points.reduce((min, p) => p.bytes < min.bytes ? p : min, points[0]);

  // Detect spike: find first point that exceeds 3x average
  const spikeThreshold = avgBytes * 3;
  const spikePoint = points.find(p => p.bytes > spikeThreshold);

  // Baseline: first quarter of points
  const baselineSlice = points.slice(0, Math.max(1, Math.floor(points.length / 4)));
  const baselineAvg = baselineSlice.reduce((s, p) => s + p.bytes, 0) / baselineSlice.length;
  const baselineCost = bytesToCost(baselineAvg * (tf.days * 86400 / stepSeconds), costPerGb);

  // Current: last quarter of points
  const recentSlice = points.slice(-Math.max(1, Math.floor(points.length / 4)));
  const recentAvg = recentSlice.reduce((s, p) => s + p.bytes, 0) / recentSlice.length;
  const recentCost = bytesToCost(recentAvg * (tf.days * 86400 / stepSeconds), costPerGb);

  // Format
  const lines: string[] = [];
  lines.push(`${fmtPattern(args.pattern)} — ${tf.label} trend`);
  lines.push('');

  lines.push(`  Baseline (first quarter):  ~${fmtDollar(baselineCost)}${period}`);
  lines.push(`  Current (last quarter):    ${fmtDollar(recentCost)}${period}`);

  if (baselineCost > 0 && recentCost > baselineCost * 1.5) {
    const pctChange = Math.round(((recentCost - baselineCost) / baselineCost) * 100);
    lines.push(`  Change: +${pctChange}% increase`);
  } else if (baselineCost > 0 && recentCost < baselineCost * 0.7) {
    const pctChange = Math.round(((baselineCost - recentCost) / baselineCost) * 100);
    lines.push(`  Change: -${pctChange}% decrease`);
  } else {
    lines.push(`  Change: stable`);
  }

  if (spikePoint) {
    lines.push(`  Spike detected: ${formatTimestamp(spikePoint.ts)}`);
  }

  lines.push('');
  lines.push(`  Peak: ${fmtBytes(maxPoint.bytes)} at ${formatTimestamp(maxPoint.ts)}`);
  lines.push(`  Low:  ${fmtBytes(minPoint.bytes)} at ${formatTimestamp(minPoint.ts)}`);
  lines.push(`  Total: ${fmtDollar(totalCost)}${period} across ${points.length} data points`);

  // Mini sparkline
  if (points.length >= 4) {
    lines.push('');
    lines.push(`  ${renderSparkline(points)}`);
  }

  return lines.join('\n');
}

function parseStep(step: string): number {
  const match = step.match(/^(\d+)(m|h|d)$/);
  if (!match) return 3600;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case 'm': return val * 60;
    case 'h': return val * 3600;
    case 'd': return val * 86400;
    default: return 3600;
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function renderSparkline(points: { bytes: number }[]): string {
  const blocks = ['░', '▒', '▓', '█'];
  const max = Math.max(...points.map(p => p.bytes));
  if (max === 0) return points.map(() => blocks[0]).join('');

  // Downsample to ~40 chars
  const targetLen = 40;
  const step = Math.max(1, Math.floor(points.length / targetLen));
  const sampled: number[] = [];
  for (let i = 0; i < points.length; i += step) {
    const slice = points.slice(i, i + step);
    sampled.push(slice.reduce((s, p) => s + p.bytes, 0) / slice.length);
  }

  return sampled.map(v => {
    const level = Math.floor((v / max) * (blocks.length - 1));
    return blocks[Math.min(level, blocks.length - 1)];
  }).join('');
}
