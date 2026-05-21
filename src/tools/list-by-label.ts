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
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';

export const listByLabelSchema = {
  label: z.string().describe('Label to group by. Pass a label name; common ones are tenx_user_service, severity_level, k8s_namespace, k8s_container, country, http_code.'),
  service: z.string().optional().describe('Scope the result to a single service (sets a tenx_user_service filter).'),
  severity: z.string().optional().describe('Filter by severity_level (e.g., "ERROR").'),
  timeRange: z.enum(['15m', '1h', '6h', '1d', '7d', '30d']).default('7d').describe('Time range to aggregate over. Sub-day values available for incident investigation.'),
  limit: z.number().min(1).max(50).default(20).describe('Max rows to return.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

export async function executeListByLabel(
  args: {
    label: string;
    service?: string;
    severity?: string;
    timeRange?: string;
    limit?: number;
    analyzerCost?: number;
  },
  env: EnvConfig
): Promise<string> {
  // Defensive defaults — match listByLabelSchema in case caller
  // bypassed the MCP-SDK Zod boundary.
  const timeRange = args.timeRange ?? '7d';
  const limit = args.limit ?? 20;
  const tf = parseTimeframe(timeRange);
  const costPerGb = args.analyzerCost ?? 1.0;
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
  const shown = rows.slice(0, limit);

  const totalCost = bytesToCost(totalBytes, costPerGb);
  const scopeParts: string[] = [];
  if (args.service) scopeParts.push(`service=${args.service}`);
  if (args.severity) scopeParts.push(`severity=${args.severity}`);
  const scope = scopeParts.length > 0 ? ` · ${scopeParts.join(' · ')}` : '';

  const lines: string[] = [];
  lines.push(`Cost by ${args.label} (${tf.label})${scope}`);
  // Data-quality note GATES the ranking (before the rows): when
  // `(empty)` is a meaningful share, say up front that the ranking
  // covers only the labeled remainder, so the SRE reads the caveat
  // before trusting the numbers (cold review: caveat should gate, not
  // trail). Applies to ANY label (was http_code-only).
  const emptyRow = shown.find(r => r.value === '(empty)');
  if (emptyRow && emptyRow.pct >= 25) {
    lines.push(`**Data quality note**: ${fmtPct(emptyRow.pct)} of log volume has no \`${args.label}\` label, so the ranking below covers only the labeled remainder. Events with no \`${args.label}\` are typically library / SDK / runtime logs that do not set this field. Not an error, but the dimension does not describe the bulk of the volume here.`);
  }
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

  // http_code-specific: flag values outside the valid HTTP range.
  if (args.label === 'http_code') {
    const invalidValues = shown.filter(r => {
      if (r.value === '(empty)') return false;
      const n = parseInt(r.value, 10);
      return isNaN(n) || n < 100 || n > 599;
    });
    if (invalidValues.length > 0) {
      const vals = invalidValues.map(r => r.value).join(', ');
      lines.push('');
      lines.push(`**Anomalous values detected**: \`${vals}\` are outside the valid HTTP status code range (100–599). These likely indicate gRPC status codes (0–16), an internal enum, or a field extraction mismatch. They are not real HTTP codes.`);
    }
  }

  const nextActions: NextAction[] = [];
  if (shown[0]) {
    const top = shown[0];
    const hints: string[] = [];
    if (args.label === LABELS.service || args.label === 'tenx_user_service') {
      hints.push(`Drill into the top service for week-over-week deltas: log10x_cost_drivers({ service: '${top.value}' }).`);
      hints.push(`Or investigate it: log10x_investigate({ starting_point: '${top.value}' }).`);
      nextActions.push({
        tool: 'log10x_cost_drivers',
        args: { service: top.value, timeRange: timeRange },
        reason: 'drill into the top service by week-over-week deltas',
      });
      nextActions.push({
        tool: 'log10x_investigate',
        args: { starting_point: top.value, window: tf.range },
        reason: 'investigate the top service',
      });
    } else {
      hints.push(`Filter cost_drivers / top_patterns to the top ${args.label} value: pass it into log10x_top_patterns or log10x_cost_drivers.`);
      nextActions.push({
        tool: 'log10x_top_patterns',
        args: { timeRange: timeRange, limit: 10 },
        reason: `top patterns scoped to the same window as the ${args.label} ranking`,
      });
      nextActions.push({
        tool: 'log10x_cost_drivers',
        args: { timeRange: timeRange },
        reason: 'check whether the top dimensions are growing',
      });
    }
    lines.push('');
    lines.push(agentOnly(`Suggested next calls: ${hints.join(' ')}`));
  }
  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);

  return lines.join('\n');
}
