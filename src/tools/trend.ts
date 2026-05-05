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
import { fmtDollar, fmtPattern, fmtBytes, parseTimeframe, costPeriodLabel, normalizePattern } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';

export const trendSchema = {
  pattern: z.string().describe('Pattern name (e.g., "Payment_Gateway_Timeout")'),
  timeRange: z.enum(['15m', '1h', '6h', '1d', '7d', '30d']).default('7d').describe('Time range. Sub-day values show fine-grained trajectory around an incident.'),
  step: z.enum(['1m', '5m', '15m', '1h', '6h', '1d']).default('1h').describe('Data point interval. Use `1m`/`5m` for sub-day windows (15m/1h/6h), `1h`/`6h` for day-level, `1d` for week+ windows.'),
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

  // Reporter pattern labels are always snake_case. Normalize in case an
  // agent re-fed a display form from top_patterns / cost_drivers.
  const pattern = normalizePattern(args.pattern);

  const now = Math.floor(Date.now() / 1000);
  const start = now - tf.days * 86400;
  const stepSeconds = parseStep(args.step);

  const query = pql.patternBytesOverTime(pattern, metricsEnv, args.step);
  const res = await queryRange(env, query, start, now, stepSeconds);

  if (res.status !== 'success' || res.data.result.length === 0) {
    return `No trend data for pattern "${pattern}" in the ${tf.label}.`;
  }

  // Extract time series
  const series = res.data.result[0];
  const points: { ts: number; bytes: number }[] = [];
  for (const [ts, val] of (series.values || [])) {
    points.push({ ts, bytes: parseFloat(val) || 0 });
  }

  if (points.length === 0) {
    return `No data points for pattern "${pattern}".`;
  }

  // Compute stats
  const totalBytes = points.reduce((s, p) => s + p.bytes, 0);
  const totalCost = bytesToCost(totalBytes, costPerGb);
  const avgBytes = totalBytes / points.length;
  const maxPoint = points.reduce((max, p) => p.bytes > max.bytes ? p : max, points[0]);
  const minPoint = points.reduce((min, p) => p.bytes < min.bytes ? p : min, points[0]);

  // Detect spike: a point > 3x average that appears AFTER the first quarter
  // (so the spike is not the baseline itself, which would produce a spurious
  // "spike detected" + "stable/decreasing" contradiction).
  const spikeThreshold = avgBytes * 3;
  const firstQuarterEnd = Math.floor(points.length / 4);
  const spikePoint = points.slice(firstQuarterEnd).find(p => p.bytes > spikeThreshold);

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
  lines.push(`${fmtPattern(pattern)} — ${tf.label} trend`);
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

  // next_action hints — prose for human readers, structured NEXT_ACTIONS
  // block for autonomous-chain agents. Spike or sustained drift → suggest
  // investigate. Always recommend dependency_check before any mute action.
  const elevated = baselineCost > 0 && recentCost > baselineCost * 1.5;
  const sustainedSlope = baselineCost > 0 && recentCost > baselineCost * 1.2 && !spikePoint;
  const nextActions: NextAction[] = [];
  if (spikePoint || elevated) {
    lines.push('');
    lines.push('**Next actions**:');
    lines.push(`  - Inflection or spike detected — call \`log10x_investigate({ starting_point: '${pattern}', window: '${args.timeRange}' })\` to trace the cause.`);
    nextActions.push({
      tool: 'log10x_investigate',
      args: { starting_point: pattern, window: args.timeRange },
      reason: spikePoint ? 'spike detected — trace the cause' : 'elevated vs baseline — trace the cause',
    });
    lines.push(`  - Cross-pillar correlation: \`log10x_correlate_cross_pillar({ anchor_type: 'log10x_pattern', anchor: '${pattern}', window: '${args.timeRange}' })\` to find the upstream metric anomaly.`);
    nextActions.push({
      tool: 'log10x_correlate_cross_pillar',
      args: { anchor_type: 'log10x_pattern', anchor: pattern, window: args.timeRange },
      reason: 'find upstream metric anomaly co-moving with the spike',
    });
  } else if (sustainedSlope) {
    lines.push('');
    lines.push('**Next action**:');
    lines.push(`  - This pattern shows gradual drift (no discrete inflection). Call \`log10x_investigate({ starting_point: '${pattern}', window: '30d' })\` for slope-similarity cohort analysis and historical investigation guidance.`);
    nextActions.push({
      tool: 'log10x_investigate',
      args: { starting_point: pattern, window: '30d' },
      reason: 'gradual drift — slope-similarity cohort analysis',
    });
  }

  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);
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
