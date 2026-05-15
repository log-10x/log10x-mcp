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
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';

export const topPatternsSchema = {
  service: z.string().optional().describe('Service name to scope the result. Omit for all services.'),
  severity: z.string().optional().describe('Severity level to scope the result (e.g., `ERROR`, `CRITICAL`, `DEBUG`). Omit for all severities. Caught by the eval-harness anti-hallucination campaign — agents asked for "top CRITICAL patterns" couldn\'t scope without this filter and the synthesis was missing the requested top-N.'),
  timeRange: z.string().regex(/^\d+[mhd]$/, 'Time range must look like `15m`, `48h`, `2d`, etc.').default('7d').describe('Time range to aggregate over. Free-form `<n><m|h|d>` — any number of minutes / hours / days. Examples: `15m`, `48h`, `3d`, `7d`, `30d`. Bounds: minimum 1 minute, maximum 90 days. Sub-day values are useful for incident investigation; day-level values for cost and trend analysis. (cost_drivers, which uses 3-window baseline math, remains snapped to `1d` / `7d` / `30d` for offset symmetry.)'),
  limit: z.number().min(1).max(50).default(10).describe('Number of patterns to return.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

export async function executeTopPatterns(
  args: { service?: string; severity?: string; timeRange: string; limit: number; analyzerCost?: number },
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
  // Default $/GB when caller doesn't supply analyzerCost. Matches the
  // default in executeServices; without this, every cost cell renders
  // as `$NaN/15m` (bytes * undefined). Caught against the real GC
  // SaaS roundtrip on 2026-05-14.
  const costPerGb = args.analyzerCost ?? 1.0;
  const period = costPeriodLabel(tf.days);

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;
  if (args.severity) filters[LABELS.severity] = args.severity;

  const metricsEnv = Object.keys(filters).length > 0
    ? await resolveMetricsEnvFiltered(env, filters)
    : await resolveMetricsEnv(env);

  // Run the top-N query and a recent-activity probe in parallel.
  // The recent-activity probe is the freshness guardrail: a row that
  // ranks top-N over 7d but has zero rate in the last hour is residue
  // from a closed incident, not an active cost driver. Surface that
  // explicitly so the agent does not treat stale series as current.
  const [res, recentRes] = await Promise.all([
    queryInstant(env, pql.topPatternsFull(filters, metricsEnv, tf.range, args.limit)),
    queryInstant(env, pql.recentRateByPattern(filters, metricsEnv, '1h')).catch(() => null),
  ]);
  if (res.status !== 'success' || res.data.result.length === 0) {
    return 'No pattern data available. Patterns appear after the first 24h of data collection.';
  }

  // Build recent-rate lookup keyed by (pattern, service, severity).
  // Track whether the probe itself succeeded — on failure we must NOT
  // tag rows as stale (an empty lookup against a failed probe is a
  // false positive: "everything is stale because we couldn't ask").
  const recentRateKey = (p: string, s: string, sv: string) => `${p}\x00${s}\x00${sv}`;
  const recentRates = new Map<string, number>();
  const freshnessProbeOk = !!(recentRes && recentRes.status === 'success');
  if (freshnessProbeOk) {
    for (const r of recentRes!.data.result) {
      const k = recentRateKey(
        r.metric[LABELS.pattern] || '',
        r.metric[LABELS.service] || '',
        r.metric[LABELS.severity] || ''
      );
      const v = parsePrometheusValue(r);
      if (Number.isFinite(v)) recentRates.set(k, v);
    }
  }

  // (no-symbol) replaces the older (unknown) placeholder. An empty
  // message_pattern label means the engine tokenized the event but
  // symbol-lookup did not produce a canonical name — the metric does
  // not tell us what the events were. Agents must not speculate about
  // event content from this row; the rendered output says so below.
  const NO_SYMBOL = '(no-symbol)';
  interface Row { hash: string; service: string; severity: string; bytes: number; cost: number; recentRate: number; isStale: boolean; isNoSymbol: boolean }
  const rows: Row[] = res.data.result.map(r => {
    const rawPattern = r.metric[LABELS.pattern] || '';
    const service = r.metric[LABELS.service] || '';
    const severity = r.metric[LABELS.severity] || '';
    const bytes = parsePrometheusValue(r);
    const rate = recentRates.get(recentRateKey(rawPattern, service, severity)) ?? 0;
    return {
      hash: rawPattern || NO_SYMBOL,
      service,
      severity,
      bytes,
      cost: bytesToCost(bytes, costPerGb),
      recentRate: rate,
      isStale: freshnessProbeOk && rate <= 0,
      isNoSymbol: !rawPattern,
    };
  });
  rows.sort((a, b) => b.cost - a.cost);

  const displayName = args.service || 'all services';
  const totalTopBytes = rows.reduce((s, r) => s + r.bytes, 0);
  const totalTopCost = rows.reduce((s, r) => s + r.cost, 0);

  // Coverage probe: one additional PromQL for the total volume in scope,
  // so the agent can see whether top-N is the iceberg or the tip. At high
  // volume this is load-bearing — "Top 10 = 18% of total" is a very
  // different situation from "Top 10 = 92% of total" and changes the
  // next-action recommendation.
  let scopeCoveragePct: number | undefined;
  try {
    const totalRes = await queryInstant(env, pql.totalBytesInScope(filters, metricsEnv, tf.range));
    if (totalRes.status === 'success' && totalRes.data.result.length > 0) {
      const scopeTotalBytes = parsePrometheusValue(totalRes.data.result[0]);
      if (Number.isFinite(scopeTotalBytes) && scopeTotalBytes > 0) {
        scopeCoveragePct = (totalTopBytes / scopeTotalBytes) * 100;
      }
    }
  } catch {
    // non-fatal; skip coverage line if the probe fails
  }

  const lines: string[] = [];
  lines.push(`Top ${rows.length} patterns — ${displayName} (${tf.label}) · ${fmtDollar(totalTopCost)}${period} total`);
  // User-facing caveat: short, factual, no directives or tool names.
  lines.push(`_Current rank by cost — point-in-time, not a growth/week-over-week ranking._`);
  // Agent-facing constraint: don't re-label, and the tool name to use for growth.
  lines.push(agentOnly(`Constraint: these rows are CURRENT RANK by cost over the window, not a growth/delta ranking. Do not re-label as "cost drivers" or quote these as week-over-week changes. For growth, call log10x_cost_drivers.`));
  lines.push('');
  let staleCount = 0;
  let noSymbolCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const name = fmtPattern(r.hash).padEnd(35);
    const cost = fmtDollar(r.cost) + period;
    const sev = fmtSeverity(r.severity);
    const svc = r.service ? `  ${r.service}` : '';
    const stale = r.isStale ? '  [stale: no activity in last 1h — residue of closed incident in this window]' : '';
    lines.push(`#${i + 1}  ${name} ${cost.padEnd(12)} ${sev}${svc}${stale}`);
    if (r.isStale) staleCount++;
    if (r.isNoSymbol) noSymbolCount++;
  }

  // Explicit guardrail for the (no-symbol) row: the metric does NOT
  // tell us what the events were. Agents must not invent a name or
  // speculate about content from this row's other labels alone.
  if (noSymbolCount > 0) {
    lines.push('');
    // User-facing: explain what (no-symbol) means.
    lines.push(
      `_${noSymbolCount} row${noSymbolCount > 1 ? 's' : ''} above marked \`${NO_SYMBOL}\`: the engine tokenized these events but symbol-lookup did not produce a canonical name. ` +
      `The metric shows volume + bytes + the labels (service, severity). It does not tell you the event text itself._`
    );
    // Agent-facing: don't speculate; specific follow-up tool.
    lines.push(agentOnly(
      `Constraint: do not speculate about event content from a (no-symbol) row. To inspect the actual events, use log10x_retriever_query (if Retriever is deployed for this env) or check the source pod's stdout directly.`
    ));
  }
  if (staleCount > 0) {
    lines.push('');
    // User-facing: explain what stale means.
    lines.push(
      `_${staleCount} row${staleCount > 1 ? 's' : ''} above tagged \`stale\`: ranked top-N over ${tf.label} but produced zero events in the last hour. Residue of a past incident inside the lookback window, not a current cost driver._`
    );
    lines.push(agentOnly(
      `Constraint: when recommending action, discount stale rows — they aren't currently firing. Prefer non-stale rows as starting_point.`
    ));
  }

  if (scopeCoveragePct !== undefined) {
    const shownPct = Math.round(scopeCoveragePct);
    const tailPct = Math.max(0, 100 - shownPct);
    lines.push('');
    lines.push(`Top ${rows.length} = ${shownPct}% of total volume in scope / ${tailPct}% in the long tail.`);
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

  const nextActions: NextAction[] = [];
  // Pick the first row that is BOTH a real pattern identity AND
  // currently active. A stale row or a (no-symbol) row is not a
  // useful starting_point — investigate can't resolve (no-symbol),
  // and stale rows just lead the agent back to a closed incident.
  const topActiveRow = rows.find(r => !r.isNoSymbol && !r.isStale && r.hash);
  if (rows[0]) {
    // Build the structured + prose next-action hints for the agent.
    // The user has no use for "call log10x_X" instructions; the agent does.
    const hints: string[] = [];
    if (topActiveRow) {
      hints.push(`Trace the top active pattern (skipping stale/no-symbol rows): log10x_investigate({ starting_point: '${topActiveRow.hash}' }).`);
      nextActions.push({
        tool: 'log10x_investigate',
        args: { starting_point: topActiveRow.hash },
        reason: 'trace the top active pattern (skipping stale/no-symbol rows)',
      });
    }
    if (newlyEmerged.length > 0 && newlyEmerged[0].hash && newlyEmerged[0].hash !== '(no-symbol)' && newlyEmerged[0].hash !== '(unknown)') {
      hints.push(`Newly-emerged pattern (firing now, not yet in the cost ranking): log10x_investigate({ starting_point: '${newlyEmerged[0].hash}', window: '15m' }).`);
      nextActions.push({
        tool: 'log10x_investigate',
        args: { starting_point: newlyEmerged[0].hash, window: '15m' },
        reason: 'investigate newly-emerged pattern',
      });
    }
    const svcHint = args.service || topActiveRow?.service || rows[0]?.service;
    if (svcHint) {
      hints.push(`Week-over-week deltas on the top service: log10x_cost_drivers({ service: '${svcHint}', timeRange: '7d' }).`);
      nextActions.push({
        tool: 'log10x_cost_drivers',
        args: { service: svcHint, timeRange: '7d' },
        reason: 'week-over-week deltas on the top service',
      });
    } else {
      hints.push(`Week-over-week deltas across all services: log10x_cost_drivers({ timeRange: '7d' }).`);
      nextActions.push({
        tool: 'log10x_cost_drivers',
        args: { timeRange: '7d' },
        reason: 'week-over-week deltas across all services',
      });
    }
    // Drop-routine-pattern path: discoverable only if the agent reads
    // this hint. Gated on topActiveRow so we don't recommend dropping
    // a (no-symbol) or stale series.
    if (topActiveRow) {
      hints.push(`Reduce the cost of a high-volume pattern: log10x_pattern_mitigate({ pattern: '${topActiveRow.hash}' }) — presents the four options (drop @ analyzer / drop @ forwarder / mute @ 10x / compact @ 10x) gated on this env's capabilities, then routes to the right sub-tool based on user choice.`);
    }
    if (hints.length > 0) {
      lines.push('');
      lines.push(agentOnly(`Suggested next calls: ${hints.join(' ')}`));
    }
  }
  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);
  return lines.join('\n');
}
