/**
 * log10x_services — list all monitored services with volume summary.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, bytesToGb, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { fmtDollar, fmtBytes, fmtPct, parseTimeframe, costPeriodLabel } from '../lib/format.js';

export const servicesSchema = {
  timeRange: z.enum(['15m', '1h', '6h', '1d', '7d', '30d']).default('7d').describe('Time range. Sub-day values available for incident-window service ranking.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB'),
  environment: z.string().optional().describe('Environment nickname'),
};

export async function executeServices(
  args: { timeRange: string; analyzerCost: number },
  env: EnvConfig
): Promise<string> {
  const tf = parseTimeframe(args.timeRange);
  const costPerGb = args.analyzerCost;
  const period = costPeriodLabel(tf.days);
  const metricsEnv = await resolveMetricsEnv(env);

  const res = await queryInstant(env, pql.bytesPerService(metricsEnv, tf.range));

  if (res.status !== 'success' || res.data.result.length === 0) {
    return 'No service data available. Data appears after the first 24h of collection.';
  }

  interface SvcRow { name: string; bytes: number; cost: number; pct: number }
  const rows: SvcRow[] = [];
  let totalBytes = 0;

  for (const r of res.data.result) {
    const name = r.metric[LABELS.service] || '(unknown)';
    const bytes = parsePrometheusValue(r);
    totalBytes += bytes;
    rows.push({ name, bytes, cost: bytesToCost(bytes, costPerGb), pct: 0 });
  }

  // Calculate percentages
  for (const r of rows) {
    r.pct = totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0;
  }

  rows.sort((a, b) => b.bytes - a.bytes);

  // Align columns to the longest service name (min 20, max 40)
  const nameWidth = Math.min(40, Math.max(20, ...rows.map(r => r.name.length)));

  const lines: string[] = [];
  lines.push(`Monitored Services (${tf.label})`);
  lines.push('');

  for (const r of rows) {
    const name = r.name.padEnd(nameWidth);
    const vol = fmtBytes(r.bytes).padEnd(10);
    const pct = fmtPct(r.pct).padStart(4);
    const cost = `${fmtDollar(r.cost)}${period}`;
    lines.push(`  ${name} ${vol} ${pct}   ${cost}`);
  }

  const totalCost = bytesToCost(totalBytes, costPerGb);
  lines.push('');
  lines.push(`  ${rows.length} service${rows.length !== 1 ? 's' : ''} · ${fmtBytes(totalBytes)} total · ${fmtDollar(totalCost)}${period} at ${fmtDollar(costPerGb)}/GB`);

  // Coverage line: how concentrated is the volume at the top? Tells the agent
  // whether a drill-down on the top few services captures the question or
  // whether the long tail matters. Especially load-bearing at high volume,
  // where "Top 10 patterns" can mean 90% of cost or 10%.
  if (rows.length > 1 && totalBytes > 0) {
    const topN = Math.min(3, rows.length);
    const topBytes = rows.slice(0, topN).reduce((s, r) => s + r.bytes, 0);
    const topPct = Math.round((topBytes / totalBytes) * 100);
    lines.push(`  Top ${topN} service${topN !== 1 ? 's' : ''} = ${topPct}% of volume.`);
  }

  if (rows[0]) {
    lines.push('');
    lines.push('**Next actions**:');
    lines.push(`  - Drill into the top service: \`log10x_cost_drivers({ service: '${rows[0].name}' })\` for week-over-week deltas, or \`log10x_top_patterns({ service: '${rows[0].name}' })\` for current top patterns.`);
    lines.push(`  - Investigate any spike: \`log10x_investigate({ starting_point: '${rows[0].name}' })\` for a full causal-chain analysis.`);
  }

  return lines.join('\n');
}
