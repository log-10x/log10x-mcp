/**
 * log10x_cost_drivers — the core attribution tool.
 *
 * Finds patterns whose cost increase exceeds both the dollar floor
 * and contribution gate, ranked by delta. Equivalent to `/log10x {service}`.
 *
 * Algorithm (ported from SlackPatternService.java):
 * 1. Query current window bytes per pattern
 * 2. Query 3 baseline windows (offset N, 2N, 3N days)
 * 3. Compute delta = current cost - avg baseline cost
 * 4. Filter: delta > $500/wk AND delta/totalDelta > 5%
 * 5. Sort by delta descending
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { applyCostDriverGates, DEFAULT_GATES } from '../lib/gates.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import {
  fmtDollar, fmtPattern, fmtSeverity, fmtCount, fmtPct,
  parseTimeframe, costPeriodLabel, type Timeframe
} from '../lib/format.js';
import { renderPatternStanzas, type PatternStanzaRow } from '../lib/pattern-render.js';

export const costDriversSchema = {
  service: z.string().optional().describe("Service name to filter (e.g., 'checkout'). Omit for all services."),
  timeRange: z.enum(['1d', '7d', '30d']).default('7d').describe('Time range to analyze. For sub-day "what changed in the last hour" questions, use `log10x_pattern_trend` or `log10x_investigate` — cost_drivers baseline math requires day-level offsets.'),
  limit: z.number().min(1).max(20).default(10).describe('Max patterns to return'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from your profile if omitted.'),
  baselineOffsetDays: z.number().min(1).max(90).optional().describe(
    'Override the baseline comparison. Default behavior averages three prior windows (offset ' +
    '= timeRange, 2×timeRange, 3×timeRange days) to smooth noise. ' +
    'Set this to compare against a single specific offset instead — e.g., ' +
    '`{timeRange: "1d", baselineOffsetDays: 1}` means "compare today to yesterday" ' +
    '(deploy-delta pattern). `{timeRange: "7d", baselineOffsetDays: 14}` means ' +
    '"compare this week to the week two weeks ago" (skip a week). Use when you need ' +
    'anchor-aligned comparison rather than the default 3-window average.'
  ),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups)'),
};

interface Pattern {
  hash: string;
  service: string;
  severity: string;
  costNow: number;
  costBaseline: number;
  delta: number;
  isNew: boolean;
  events: number;
}

export async function executeCostDrivers(
  args: {
    service?: string;
    timeRange?: string;
    limit?: number;
    analyzerCost?: number;
    baselineOffsetDays?: number;
  },
  env: EnvConfig
): Promise<string> {
  // Defensive defaults — match `costDriversSchema` (timeRange:'7d',
  // limit:10). The MCP SDK normally fills these via Zod-defaults at
  // dispatch time, but tools also get invoked directly from internal
  // chains, scripts, the eval harness, and NEXT_ACTIONS hints — none
  // of which run the schema. Crashing on undefined timeRange (the
  // earlier behavior) leaks a TypeError up the chain and confuses
  // autonomous agents reading the result.
  const timeRange = args.timeRange ?? '7d';
  const limit = args.limit ?? 10;
  const tf = parseTimeframe(timeRange);
  // analyzerCost is normally injected by the index.ts dispatch (auto-
  // detect from user profile). Direct/script callers might omit it —
  // fall back to the default mid-tier rate so cost output is still
  // populated rather than NaN. The dollar floor in gates.ts uses this
  // same default elsewhere.
  const costPerGb = args.analyzerCost ?? 1.0;
  const period = costPeriodLabel(tf.days);
  // If the caller supplied an explicit baseline offset, use it as the sole comparison window
  // instead of the 3-window average (tf.baselineOffsets default = [days, 2*days, 3*days]).
  const baselineOffsets = args.baselineOffsetDays
    ? [args.baselineOffsetDays]
    : tf.baselineOffsets;

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;

  // Resolve edge vs cloud
  const metricsEnv = Object.keys(filters).length > 0
    ? await resolveMetricsEnvFiltered(env, filters)
    : await resolveMetricsEnv(env);

  // Query 1: current window
  const currentRes = await queryInstant(env, pql.bytesPerPattern(filters, metricsEnv, tf.range));
  if (currentRes.status !== 'success' || currentRes.data.result.length === 0) {
    return 'No pattern data available. Patterns appear after the first 24h of data collection.';
  }

  const currentByHash = new Map<string, { service: string; severity: string; bytes: number }>();
  for (const r of currentRes.data.result) {
    const hash = r.metric[LABELS.pattern];
    if (!hash) continue;
    currentByHash.set(hash, {
      service: r.metric[LABELS.service] || '',
      severity: r.metric[LABELS.severity] || '',
      bytes: parsePrometheusValue(r),
    });
  }

  // Queries 2-4: baseline windows (3 prior periods by default, or 1 explicit offset)
  const baselineByHash = new Map<string, number[]>();
  for (const offsetDays of baselineOffsets) {
    const baseRes = await queryInstant(env, pql.bytesPerPattern(filters, metricsEnv, tf.range, offsetDays));
    if (baseRes.status === 'success') {
      for (const r of baseRes.data.result) {
        const hash = r.metric[LABELS.pattern];
        if (!hash) continue;
        const arr = baselineByHash.get(hash) || [];
        arr.push(parsePrometheusValue(r));
        baselineByHash.set(hash, arr);
      }
    }
  }

  // Query 5: event counts
  const eventsRes = await queryInstant(env, pql.eventsPerPattern(filters, metricsEnv, tf.range));
  const eventsByHash = new Map<string, number>();
  if (eventsRes.status === 'success') {
    for (const r of eventsRes.data.result) {
      const hash = r.metric[LABELS.pattern];
      if (hash) eventsByHash.set(hash, parsePrometheusValue(r));
    }
  }

  // Build patterns with cost + delta
  const allPatterns: Pattern[] = [];
  let totalPositiveDelta = 0;

  for (const [hash, row] of currentByHash) {
    const costNow = bytesToCost(row.bytes, costPerGb);
    const baseWeeks = baselineByHash.get(hash) || [];
    const isNew = baseWeeks.length === 0;
    const costBaseline = isNew ? 0 : bytesToCost(
      baseWeeks.reduce((a, b) => a + b, 0) / baseWeeks.length,
      costPerGb
    );
    const delta = costNow - costBaseline;

    allPatterns.push({
      hash, service: row.service, severity: row.severity,
      costNow, costBaseline, delta, isNew,
      events: eventsByHash.get(hash) || 0,
    });

    if (delta > 0) totalPositiveDelta += delta;
  }

  // Sort by delta descending
  allPatterns.sort((a, b) => b.delta - a.delta);

  // Apply cost driver gates
  const drivers = applyCostDriverGates(allPatterns, totalPositiveDelta, DEFAULT_GATES);

  // Format output
  const lines: string[] = [];
  const displayName = args.service || 'all services';

  if (drivers.length > 0) {
    const driversCost = drivers.reduce((s, d) => s + d.costNow, 0);
    const baselineCost = drivers.reduce((s, d) => s + d.costBaseline, 0);
    // Describe the exact comparison so the agent can quote it correctly in its answer.
    const comparison = args.baselineOffsetDays
      ? `current ${tf.range} vs ${args.baselineOffsetDays}d-offset baseline`
      : `current ${tf.range} vs 3-window avg baseline (offsets: ${tf.baselineOffsets.join('d/')}d)`;
    lines.push(`Cost drivers · ${tf.label} · ${displayName}`);
    lines.push(`Total: ${fmtDollar(baselineCost)} -> ${fmtDollar(driversCost)}${period} · ${drivers.length} cost driver${drivers.length > 1 ? 's' : ''}`);
    lines.push(`Comparison: ${comparison}`);
    lines.push(`_Growth deltas (current window vs prior baseline), not a current-rank list._`);
    lines.push(agentOnly(`Constraint: these are GROWTH deltas (current window vs prior baseline), NOT current ranking. Do not re-rank or merge with log10x_top_patterns output.`));
    lines.push('');

    const shown = drivers.slice(0, limit);
    const stanzaRows: PatternStanzaRow[] = shown.map(d => ({
      pattern: d.hash,
      service: d.service,
      severity: d.severity,
      bytes: 0,
      cost: d.costNow,
      costBaseline: d.costBaseline,
      barValue: Math.max(0, d.delta),
      events: d.events,
      deltaLabel: d.isNew
        ? '(NEW)'
        : d.costBaseline > 0
          ? `(+${fmtPct(((d.costNow - d.costBaseline) / d.costBaseline) * 100)})`
          : '(+inf%)',
      flags: d.isNew ? ['NEW'] : [],
    }));
    lines.push(renderPatternStanzas(stanzaRows, {
      title: 'Cost drivers',
      scopeLabel: displayName,
      windowLabel: tf.label,
      periodSuffix: period,
      suppressHeader: true,
    }));

    // Summary line
    const driverPct = totalPositiveDelta > 0
      ? Math.round((drivers.reduce((s, d) => s + d.delta, 0) / totalPositiveDelta) * 100)
      : 0;
    const stableCount = allPatterns.length - drivers.length;
    lines.push('');
    lines.push(`${drivers.length} driver${drivers.length > 1 ? 's' : ''} = ${driverPct}% of increase · ${stableCount} other pattern${stableCount !== 1 ? 's' : ''}`);

    // next_action hints — nudge the model toward investigate for each top driver.
    const nextActions: NextAction[] = [];
    const hints: string[] = [];
    for (const d of drivers.slice(0, 3)) {
      hints.push(`Trace the ${fmtDollar(d.delta)} delta on '${d.hash}': log10x_investigate({ starting_point: '${d.hash}' }).`);
      nextActions.push({
        tool: 'log10x_investigate',
        args: { starting_point: d.hash },
        reason: `trace the ${fmtDollar(d.delta)} delta driver`,
      });
    }
    hints.push(`Blast-radius safety before muting/dropping the top driver: log10x_dependency_check({ pattern: '${drivers[0].hash}' }).`);
    nextActions.push({
      tool: 'log10x_dependency_check',
      args: { pattern: drivers[0].hash },
      reason: 'blast-radius check before muting top driver',
    });
    hints.push(`Reduce the cost of the top driver: log10x_pattern_mitigate({ pattern: '${drivers[0].hash}' }) — presents drop @ analyzer / drop @ forwarder / mute @ 10x / compact @ 10x, gated on env capabilities.`);
    nextActions.push({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: drivers[0].hash },
      reason: 'cost-reduction menu — four options gated on env capabilities',
    });
    lines.push('');
    lines.push(agentOnly(`Suggested next calls: ${hints.join(' ')}`));
    const block = renderNextActions(nextActions);
    if (block) lines.push('', block);
  } else {
    // No drivers — show top patterns by current cost.
    // Print the comparison that WAS attempted so the agent can report it correctly
    // rather than inferring. A null result with no comparison label looks like "tool
    // didn't run"; a null result with an explicit comparison label is an answer.
    const comparison = args.baselineOffsetDays
      ? `current ${tf.range} vs ${args.baselineOffsetDays}d-offset baseline`
      : `current ${tf.range} vs 3-window avg baseline (offsets: ${tf.baselineOffsets.join('d/')}d)`;
    lines.push(`Cost drivers · ${tf.label} · ${displayName}: none detected`);
    lines.push(`Comparison attempted: ${comparison}`);
    lines.push(`Interpretation: no pattern crossed the delta threshold. The environment is stable vs this baseline. This is a truthful negative result, not a tool failure.`);
    lines.push(`All ${allPatterns.length} patterns are within normal range.`);
    lines.push('');
    lines.push(`Top patterns by current cost:`);
    lines.push('');

    const top = allPatterns
      .sort((a, b) => b.costNow - a.costNow)
      .slice(0, Math.min(5, limit));

    const fallbackRows: PatternStanzaRow[] = top.map(p => ({
      pattern: p.hash,
      service: p.service,
      severity: p.severity,
      bytes: 0,
      cost: p.costNow,
      barValue: p.costNow,
      events: p.events,
    }));
    lines.push(renderPatternStanzas(fallbackRows, {
      title: 'Top patterns by current cost',
      scopeLabel: displayName,
      windowLabel: tf.label,
      periodSuffix: period,
      suppressHeader: true,
    }));

    // Even on the no-movement path, give chain walkers somewhere to go.
    // top_patterns is the right next step (the agent now wants the
    // current-rank view since growth math returned empty); savings
    // surfaces ROI numbers if the user's "bill is high" framing was
    // current-cost not delta. Without this hint the autonomous chain
    // dead-ends and the model stalls asking "what would you like next?".
    const fallback: NextAction[] = [
      {
        tool: 'log10x_top_patterns',
        args: { timeRange: tf.range, ...(args.service ? { service: args.service } : {}) },
        reason: 'no growth detected; pivot to current-rank view',
      },
      {
        tool: 'log10x_savings',
        args: { timeRange: tf.range },
        reason: 'no growth detected; surface pipeline ROI for the current bill question',
      },
    ];
    if (top[0] && top[0].hash) {
      fallback.push({
        tool: 'log10x_investigate',
        args: { starting_point: top[0].hash, window: '1h' },
        reason: 'investigate the largest current pattern even though it is not a growth driver',
      });
    }
    const block = renderNextActions(fallback);
    if (block) lines.push('', block);
  }

  return lines.join('\n');
}
