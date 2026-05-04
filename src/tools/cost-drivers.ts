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
import {
  fmtDollar, fmtPattern, fmtSeverity, fmtCount, fmtPct,
  parseTimeframe, costPeriodLabel, type Timeframe
} from '../lib/format.js';

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
    timeRange: string;
    limit: number;
    analyzerCost: number;
    baselineOffsetDays?: number;
  },
  env: EnvConfig
): Promise<string> {
  const tf = parseTimeframe(args.timeRange);
  const costPerGb = args.analyzerCost;
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
    lines.push(`${displayName} — ${fmtDollar(baselineCost)} → ${fmtDollar(driversCost)}${period} (${drivers.length} cost driver${drivers.length > 1 ? 's' : ''})`);
    lines.push(`Comparison: ${comparison}`);
    lines.push(`⚠ These are GROWTH deltas (current window vs prior baseline), NOT current ranking. Do not re-rank or merge with log10x_top_patterns output.`);
    lines.push('');

    for (let i = 0; i < Math.min(drivers.length, args.limit); i++) {
      const d = drivers[i];
      const name = fmtPattern(d.hash).padEnd(35);
      const costStr = `${fmtDollar(d.costBaseline)} → ${fmtDollar(d.costNow)}${period}`;
      // Emit the exact delta percentage so agents do not fabricate one from before/after.
      // NEW patterns have no baseline — show "NEW" instead of a meaningless 100%.
      const pctStr = d.isNew
        ? '(NEW)'
        : d.costBaseline > 0
          ? `(+${fmtPct(((d.costNow - d.costBaseline) / d.costBaseline) * 100)})`
          : '(+∞%)';
      const sev = fmtSeverity(d.severity);
      const newFlag = d.isNew ? '  NEW' : '';
      const evtStr = d.events > 0 ? `  ${fmtCount(d.events)} events` : '';
      lines.push(`#${i + 1}  ${name} ${costStr} ${pctStr}   ${sev}${newFlag}${evtStr}`);
    }

    // Summary line
    const driverPct = totalPositiveDelta > 0
      ? Math.round((drivers.reduce((s, d) => s + d.delta, 0) / totalPositiveDelta) * 100)
      : 0;
    const stableCount = allPatterns.length - drivers.length;
    lines.push('');
    lines.push(`${drivers.length} driver${drivers.length > 1 ? 's' : ''} = ${driverPct}% of increase · ${stableCount} other pattern${stableCount !== 1 ? 's' : ''}`);

    // next_action hints — nudge the model toward investigate for each top driver.
    lines.push('');
    lines.push('**Next actions**:');
    const nextActions: NextAction[] = [];
    for (const d of drivers.slice(0, 3)) {
      lines.push(`  - call \`log10x_investigate({ starting_point: '${d.hash}' })\` to trace the cause of the ${fmtDollar(d.delta)} delta on this pattern.`);
      nextActions.push({
        tool: 'log10x_investigate',
        args: { starting_point: d.hash },
        reason: `trace the ${fmtDollar(d.delta)} delta driver`,
      });
    }
    lines.push(`  - call \`log10x_dependency_check({ pattern: '${drivers[0].hash}' })\` before muting or dropping — blast-radius safety.`);
    nextActions.push({
      tool: 'log10x_dependency_check',
      args: { pattern: drivers[0].hash },
      reason: 'blast-radius check before muting top driver',
    });
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
    lines.push(`${displayName} — no cost drivers detected (${tf.label})`);
    lines.push(`Comparison attempted: ${comparison}`);
    lines.push(`Interpretation: no pattern crossed the delta threshold. The environment is stable vs this baseline. This is a truthful negative result, not a tool failure.`);
    lines.push(`All ${allPatterns.length} patterns are within normal range.`);
    lines.push('');
    lines.push(`Top patterns by current cost:`);

    const top = allPatterns
      .sort((a, b) => b.costNow - a.costNow)
      .slice(0, Math.min(5, args.limit));

    for (const p of top) {
      lines.push(`  ${fmtPattern(p.hash).padEnd(35)} ${fmtDollar(p.costNow)}${period}   ${fmtSeverity(p.severity)}`);
    }
  }

  return lines.join('\n');
}
