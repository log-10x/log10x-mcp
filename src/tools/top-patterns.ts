/**
 * log10x_top_patterns — top N patterns by cost right now, no baseline filter.
 *
 * Use this when the user wants a quick "what's expensive" snapshot without
 * the "changed recently" framing of log10x_cost_drivers. Equivalent to
 * `/log10x top` in the Slack bot.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { fmtDollar, fmtPattern, fmtSeverity, fmtCount, parseTimeframe, costPeriodLabel } from '../lib/format.js';

export const topPatternsSchema = {
  service: z.string().optional().describe('Service name to scope the result. Omit for all services.'),
  timeRange: z.enum(['15m', '1h', '6h', '1d', '7d', '30d']).default('7d').describe('Time range to aggregate over. Sub-day values (`15m`, `1h`, `6h`) are useful for incident investigation; day-level values for cost and trend analysis.'),
  limit: z.number().min(1).max(50).default(10).describe('Number of patterns to return.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

export async function executeTopPatterns(
  args: { service?: string; timeRange: string; limit: number; analyzerCost: number },
  env: EnvConfig
): Promise<string> {
  const tf = parseTimeframe(args.timeRange);
  const costPerGb = args.analyzerCost;
  const period = costPeriodLabel(tf.days);

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;

  const metricsEnv = Object.keys(filters).length > 0
    ? await resolveMetricsEnvFiltered(env, filters)
    : await resolveMetricsEnv(env);

  const res = await queryInstant(env, pql.topPatternsFull(filters, metricsEnv, tf.range, args.limit));
  if (res.status !== 'success' || res.data.result.length === 0) {
    return 'No pattern data available. Patterns appear after the first 24h of data collection.';
  }

  interface Row { hash: string; service: string; severity: string; bytes: number; cost: number }
  const rows: Row[] = res.data.result.map(r => {
    const bytes = parsePrometheusValue(r);
    return {
      hash: r.metric[LABELS.pattern] || '(unknown)',
      service: r.metric[LABELS.service] || '',
      severity: r.metric[LABELS.severity] || '',
      bytes,
      cost: bytesToCost(bytes, costPerGb),
    };
  });
  rows.sort((a, b) => b.cost - a.cost);

  const displayName = args.service || 'all services';
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);

  const lines: string[] = [];
  lines.push(`Top ${rows.length} patterns — ${displayName} (${tf.label}) · ${fmtDollar(totalCost)}${period} total`);
  lines.push(`⚠ These are CURRENT RANK by cost (biggest right now). This is NOT a growth/delta ranking — do not re-label as "cost drivers" or quote these as week-over-week changes. For growth, call log10x_cost_drivers.`);
  lines.push('');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = fmtPattern(r.hash).padEnd(35);
    const cost = fmtDollar(r.cost) + period;
    const sev = fmtSeverity(r.severity);
    const svc = r.service ? `  ${r.service}` : '';
    lines.push(`#${i + 1}  ${name} ${cost.padEnd(12)} ${sev}${svc}`);
  }

  if (rows[0]) {
    lines.push('');
    lines.push('**Next actions**:');
    lines.push(`  - call \`log10x_investigate({ starting_point: '${rows[0].hash}' })\` to trace what\'s driving the top pattern.`);
    const svcHint = args.service || rows[0]?.service;
    if (svcHint) {
      lines.push(`  - call \`log10x_cost_drivers({ service: '${svcHint}' })\` for week-over-week deltas on the top service.`);
    } else {
      lines.push(`  - call \`log10x_cost_drivers()\` for week-over-week deltas across all services.`);
    }
  }
  return lines.join('\n');
}
