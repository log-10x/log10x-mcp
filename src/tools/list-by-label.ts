/**
 * log10x_list_by_label — rank any label's values by cost.
 *
 * Use this when the user asks "which namespaces cost the most", "top countries
 * by log cost", "severity breakdown", or "cost by container". Equivalent to
 * `/log10x list {label}` in the Slack bot.
 *
 * Chains naturally with log10x_discover_labels — Claude can call discover_labels
 * first to learn what's queryable, then list_by_label to rank by that key.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { fmtDollar, fmtBytes, fmtPct, parseTimeframe, costPeriodLabel } from '../lib/format.js';

export const listByLabelSchema = {
  label: z.string().describe('Label to group by. Common choices: tenx_user_service, severity_level, k8s_namespace, k8s_container, country, http_code. Call log10x_discover_labels first to see what is queryable.'),
  service: z.string().optional().describe('Scope the result to a single service (sets a tenx_user_service filter).'),
  severity: z.string().optional().describe('Filter by severity_level (e.g., "ERROR").'),
  timeRange: z.enum(['1d', '7d', '30d']).default('7d').describe('Time range to aggregate over.'),
  limit: z.number().min(1).max(50).default(20).describe('Max rows to return.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

export async function executeListByLabel(
  args: {
    label: string;
    service?: string;
    severity?: string;
    timeRange: string;
    limit: number;
    analyzerCost: number;
  },
  env: EnvConfig
): Promise<string> {
  const tf = parseTimeframe(args.timeRange);
  const costPerGb = args.analyzerCost;
  const period = costPeriodLabel(tf.days);

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;
  if (args.severity) filters[LABELS.severity] = args.severity;

  const metricsEnv = Object.keys(filters).length > 0
    ? await resolveMetricsEnvFiltered(env, filters)
    : await resolveMetricsEnv(env);

  const res = await queryInstant(env, pql.bytesByLabel(args.label, filters, metricsEnv, tf.range));
  if (res.status !== 'success' || res.data.result.length === 0) {
    return `No data for label "${args.label}". Call log10x_discover_labels to see available labels.`;
  }

  interface Row { value: string; bytes: number; cost: number; pct: number }
  const rows: Row[] = res.data.result.map(r => ({
    value: r.metric[args.label] || '(empty)',
    bytes: parsePrometheusValue(r),
    cost: 0,
    pct: 0,
  }));

  const totalBytes = rows.reduce((s, r) => s + r.bytes, 0);
  for (const r of rows) {
    r.cost = bytesToCost(r.bytes, costPerGb);
    r.pct = totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0;
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  const shown = rows.slice(0, args.limit);

  const totalCost = bytesToCost(totalBytes, costPerGb);
  const scopeParts: string[] = [];
  if (args.service) scopeParts.push(`service=${args.service}`);
  if (args.severity) scopeParts.push(`severity=${args.severity}`);
  const scope = scopeParts.length > 0 ? ` · ${scopeParts.join(' · ')}` : '';

  const lines: string[] = [];
  lines.push(`Cost by ${args.label} (${tf.label})${scope}`);
  lines.push('');

  for (const r of shown) {
    const name = r.value.padEnd(24);
    const vol = fmtBytes(r.bytes).padEnd(10);
    const pct = fmtPct(r.pct).padStart(5);
    const cost = fmtDollar(r.cost) + period;
    lines.push(`  ${name} ${vol} ${pct}   ${cost}`);
  }

  lines.push('');
  lines.push(`  ${rows.length} row${rows.length !== 1 ? 's' : ''} · ${fmtBytes(totalBytes)} total · ${fmtDollar(totalCost)}${period}`);

  return lines.join('\n');
}
