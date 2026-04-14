/**
 * log10x_event_lookup — analyze a specific log pattern.
 *
 * Finds the pattern across all services, shows cost breakdown,
 * and requests AI analysis. Equivalent to `/log10x event {pattern}`.
 *
 * Ported from SlackPatternService.queryPatternAcrossServices().
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant, queryAi } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import {
  fmtDollar, fmtPattern, fmtSeverity, fmtCount,
  parseTimeframe, costPeriodLabel
} from '../lib/format.js';

export const eventLookupSchema = {
  pattern: z.string().describe('Pattern name or search term to look up (e.g., "Payment_Gateway_Timeout")'),
  service: z.string().optional().describe('Service to scope the lookup'),
  timeRange: z.enum(['1d', '7d', '30d']).default('7d').describe('Time range'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB'),
  environment: z.string().optional().describe('Environment nickname'),
};

export async function executeEventLookup(
  args: { pattern: string; service?: string; timeRange: string; analyzerCost: number },
  env: EnvConfig
): Promise<string> {
  const tf = parseTimeframe(args.timeRange);
  const costPerGb = args.analyzerCost;
  const period = costPeriodLabel(tf.days);
  const metricsEnv = await resolveMetricsEnv(env);

  // Current window: bytes per service for this pattern
  const currentRes = await queryInstant(env, pql.patternAcrossServices(args.pattern, metricsEnv, tf.range));

  if (currentRes.status !== 'success' || currentRes.data.result.length === 0) {
    // Try fuzzy match with regex
    const fuzzyPattern = args.pattern.replace(/[_ ]+/g, '.*');
    const fuzzyQuery = `sum by (${LABELS.service}, ${LABELS.severity}) (increase(all_events_summaryBytes_total{${LABELS.pattern}=~"${fuzzyPattern}",${LABELS.env}="${metricsEnv}"}[${tf.range}]))`;
    const fuzzyRes = await queryInstant(env, fuzzyQuery);

    if (fuzzyRes.status !== 'success' || fuzzyRes.data.result.length === 0) {
      return `No data found for pattern "${args.pattern}". Check the pattern name (use underscores, e.g., Payment_Gateway_Timeout).`;
    }
    // Use fuzzy results
    return formatResults(fuzzyRes.data.result, args.pattern, metricsEnv, tf, costPerGb, period, env);
  }

  return formatResults(currentRes.data.result, args.pattern, metricsEnv, tf, costPerGb, period, env);
}

async function formatResults(
  results: Array<{ metric: Record<string, string>; value?: [number, string] }>,
  pattern: string,
  metricsEnv: string,
  tf: ReturnType<typeof parseTimeframe>,
  costPerGb: number,
  period: string,
  env: EnvConfig
): Promise<string> {
  // Aggregate bytes per service (multiple severity levels possible)
  const serviceBytes = new Map<string, number>();
  const serviceSev = new Map<string, { sev: string; bytes: number }>();

  for (const r of results) {
    const svc = r.metric[LABELS.service] || '';
    const sev = r.metric[LABELS.severity] || '';
    const bytes = parsePrometheusValue(r);
    serviceBytes.set(svc, (serviceBytes.get(svc) || 0) + bytes);
    // Keep dominant severity
    const current = serviceSev.get(svc);
    if (!current || bytes > current.bytes) {
      serviceSev.set(svc, { sev, bytes });
    }
  }

  // Baseline per service
  const baselineByService = new Map<string, number[]>();
  for (const offsetDays of tf.baselineOffsets) {
    const baseRes = await queryInstant(env, pql.patternAcrossServices(pattern, metricsEnv, tf.range, offsetDays));
    if (baseRes.status === 'success') {
      for (const r of baseRes.data.result) {
        const svc = r.metric[LABELS.service] || '';
        const arr = baselineByService.get(svc) || [];
        arr.push(parsePrometheusValue(r));
        baselineByService.set(svc, arr);
      }
    }
  }

  // Event counts per service
  const eventsRes = await queryInstant(env, pql.eventsPerServiceForPattern(pattern, metricsEnv, tf.range));
  const eventsBySvc = new Map<string, number>();
  if (eventsRes.status === 'success') {
    for (const r of eventsRes.data.result) {
      const svc = r.metric[LABELS.service] || '';
      eventsBySvc.set(svc, parsePrometheusValue(r));
    }
  }

  // Build service rows
  interface SvcRow {
    service: string; severity: string;
    costNow: number; costBaseline: number; events: number; isNew: boolean;
  }
  const rows: SvcRow[] = [];
  let totalCostNow = 0;
  let totalCostBase = 0;
  let totalEvents = 0;

  for (const [svc, bytes] of serviceBytes) {
    const costNow = bytesToCost(bytes, costPerGb);
    const baseWeeks = baselineByService.get(svc) || [];
    const isNew = baseWeeks.length === 0;
    const costBase = isNew ? 0 : bytesToCost(
      baseWeeks.reduce((a, b) => a + b, 0) / baseWeeks.length,
      costPerGb
    );
    const events = eventsBySvc.get(svc) || 0;

    rows.push({ service: svc, severity: serviceSev.get(svc)?.sev || '', costNow, costBaseline: costBase, events, isNew });
    totalCostNow += costNow;
    totalCostBase += costBase;
    totalEvents += events;
  }

  rows.sort((a, b) => b.costNow - a.costNow);

  // Format output
  const lines: string[] = [];
  lines.push(`${fmtPattern(pattern)} — ${fmtDollar(totalCostBase)} → ${fmtDollar(totalCostNow)}${period}`);
  lines.push('');

  lines.push('Services:');
  for (const r of rows) {
    const svc = r.service.padEnd(15);
    const sev = fmtSeverity(r.severity).padEnd(6);
    const cost = `${fmtDollar(r.costNow)}${period}`;
    const delta = `(${fmtDollar(r.costBaseline)} → ${fmtDollar(r.costNow)})`;
    const events = r.events > 0 ? `  ${fmtCount(r.events)} events` : '';
    const newFlag = r.isNew ? '  NEW' : '';
    lines.push(`  ${svc} ${sev} ${cost.padEnd(12)} ${delta}${events}${newFlag}`);
  }

  // AI analysis
  try {
    const queryResultJson = JSON.stringify(results.slice(0, 5));
    const aiPrompt = `Classify this log pattern and recommend an action. Pattern: ${pattern}. Provide: CATEGORY (error/debug/info/metric/health), CONFIDENCE (high/medium/low), ACTION (filter/keep/reduce), FILTER_PCT (% safe to filter), EXPLANATION (one line).`;
    const aiResult = await queryAi(env, queryResultJson, aiPrompt, costPerGb);

    if (aiResult) {
      lines.push('');
      lines.push('AI Analysis:');
      for (const line of aiResult.split('\n')) {
        if (line.trim()) lines.push(`  ${line.trim()}`);
      }
    }
  } catch {
    // AI analysis is optional — skip silently
  }

  lines.push('');
  lines.push(`${rows.length} service${rows.length !== 1 ? 's' : ''} · ${fmtCount(totalEvents)} events`);

  // next_action hint — if this pattern is elevated vs its own baseline, nudge toward investigate.
  if (totalCostBase > 0 && totalCostNow > totalCostBase * 2) {
    const pctChange = Math.round(((totalCostNow - totalCostBase) / totalCostBase) * 100);
    lines.push('');
    lines.push('**Next actions**:');
    lines.push(`  - This pattern is up ${pctChange}% vs its baseline — call \`log10x_investigate({ starting_point: '${pattern}' })\` to trace the cause.`);
    lines.push(`  - Or call \`log10x_pattern_trend({ pattern: '${pattern}' })\` for the time series.`);
  }

  return lines.join('\n');
}
