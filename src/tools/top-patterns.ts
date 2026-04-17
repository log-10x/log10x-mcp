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
  // Defensive defaults so the function is safe to call without the zod schema
  // layer (direct callers, agentic harnesses, programmatic chains). Without
  // these, `topk(undefined, …)` renders as `topk(, …)` and Prometheus returns
  // "expected type scalar in aggregation parameter" — caught by Grok round-2
  // run on otel-demo when it called log10x_top_patterns without `limit`.
  // eslint-disable-next-line no-param-reassign
  if (!args.timeRange) (args as Record<string, unknown>).timeRange = '7d';
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    (args as Record<string, unknown>).limit = 10;
  }
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

  // ── Newly-emerged-patterns probe ──
  // The main ranking above is cost-weighted over `tf.range`, which buries
  // freshly-appearing patterns by design: a pattern that's been firing for
  // 90 seconds at 6 events/sec has ~540 events total, which is invisible
  // next to 24h-integrated steady-state patterns with billions of events.
  // Caught by sub-agent S10 (seeded retry-storm canary): the canary was at
  // rank #37 and the agent missed it entirely, finding a different
  // long-running APM-invisible bug instead.
  //
  // Fix: ALSO probe for patterns with significant current (5m) rate and
  // zero rate at 1h-ago. These are "newly emerged" by construction and
  // deserve a prominent section regardless of their cumulative cost.
  // Query cost: +1 PromQL query. Returns a small result set (typically 0-3
  // rows). No-op for steady-state environments.
  interface NewRow { hash: string; service: string; severity: string; rate: number }
  const newlyEmerged: NewRow[] = [];
  try {
    const scopeFilter = args.service ? `,${LABELS.service}="${args.service.replace(/"/g, '\\"')}"` : '';
    const newlyEmergedQ =
      `topk(5, sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"${scopeFilter}}[5m])) > 0.001) ` +
      `unless on (${LABELS.pattern}) ` +
      `(sum by (${LABELS.pattern}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"${scopeFilter}}[5m] offset 1h)) > 0)`;
    const newRes = await queryInstant(env, newlyEmergedQ);
    if (newRes.status === 'success') {
      for (const r of newRes.data.result) {
        const rate = parsePrometheusValue(r);
        if (!Number.isFinite(rate) || rate <= 0) continue;
        newlyEmerged.push({
          hash: r.metric[LABELS.pattern] || '(unknown)',
          service: r.metric[LABELS.service] || '',
          severity: r.metric[LABELS.severity] || '',
          rate,
        });
      }
      newlyEmerged.sort((a, b) => b.rate - a.rate);
    }
  } catch {
    // non-fatal
  }

  if (newlyEmerged.length > 0) {
    lines.push('');
    lines.push('### ⚡ Newly emerged patterns (last 5 min, no activity 1h ago)');
    lines.push('');
    lines.push('_These patterns are firing right now but were silent 1h ago. They are likely too fresh to appear in the cost ranking above (which integrates over a longer window). Investigate individually if unexpected._');
    lines.push('');
    for (let i = 0; i < newlyEmerged.length; i++) {
      const r = newlyEmerged[i];
      const name = fmtPattern(r.hash).padEnd(35);
      const rateLabel = `${r.rate.toFixed(3)} events/s`;
      const sev = fmtSeverity(r.severity);
      const svc = r.service ? `  ${r.service}` : '';
      lines.push(`  ${name} ${rateLabel.padEnd(18)} ${sev}${svc}`);
    }
  }

  if (rows[0]) {
    lines.push('');
    lines.push('**Next actions**:');
    lines.push(`  - call \`log10x_investigate({ starting_point: '${rows[0].hash}' })\` to trace what\'s driving the top pattern.`);
    if (newlyEmerged.length > 0) {
      lines.push(`  - **Investigate the newly-emerged pattern**: \`log10x_investigate({ starting_point: '${newlyEmerged[0].hash}', window: '15m' })\` — it is not in the cost ranking yet but is firing right now.`);
    }
    const svcHint = args.service || rows[0]?.service;
    if (svcHint) {
      lines.push(`  - call \`log10x_cost_drivers({ service: '${svcHint}' })\` for week-over-week deltas on the top service.`);
    } else {
      lines.push(`  - call \`log10x_cost_drivers()\` for week-over-week deltas across all services.`);
    }
  }
  return lines.join('\n');
}
