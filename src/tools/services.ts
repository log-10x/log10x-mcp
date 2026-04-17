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
import { renderNextActions, type NextAction } from '../lib/next-actions.js';

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

  const nextActions: NextAction[] = [];
  if (rows[0]) {
    lines.push('');
    lines.push('**Next actions**:');
    lines.push(`  - Drill into the top service: \`log10x_cost_drivers({ service: '${rows[0].name}' })\` for week-over-week deltas, or \`log10x_top_patterns({ service: '${rows[0].name}' })\` for current top patterns.`);
    lines.push(`  - Investigate any spike: \`log10x_investigate({ starting_point: '${rows[0].name}' })\` for a full causal-chain analysis.`);
    nextActions.push(
      { tool: 'log10x_cost_drivers', args: { service: rows[0].name }, reason: 'week-over-week deltas on the top service' },
      { tool: 'log10x_top_patterns', args: { service: rows[0].name }, reason: 'current top patterns for the top service' },
      { tool: 'log10x_investigate', args: { starting_point: rows[0].name }, reason: 'causal-chain analysis on the top service' },
    );
  }

  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);
  return lines.join('\n');
}
