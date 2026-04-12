/**
 * log10x_savings — pipeline savings summary.
 *
 * Shows current savings from regulator (filtering), optimizer (compaction),
 * and streamer (indexing). Projects annual savings.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { bytesToCost, bytesToGb, parsePrometheusValue } from '../lib/cost.js';
import { fmtDollar, fmtBytes, parseTimeframe, costPeriodLabel } from '../lib/format.js';

export const savingsSchema = {
  timeRange: z.enum(['1d', '7d', '30d']).default('7d').describe('Time range'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB'),
  environment: z.string().optional().describe('Environment nickname'),
};

export async function executeSavings(
  args: { timeRange: string; analyzerCost: number },
  env: EnvConfig
): Promise<string> {
  const tf = parseTimeframe(args.timeRange);
  const costPerGb = args.analyzerCost;
  const period = costPeriodLabel(tf.days);

  // Query all savings metrics in parallel
  const [regInRes, regOutRes, optInRes, optOutRes, streamRes, pipeRes, svcRes] = await Promise.all([
    queryInstant(env, pql.regulatorInput(tf.range)).catch(() => null),
    queryInstant(env, pql.regulatorOutput(tf.range)).catch(() => null),
    queryInstant(env, pql.optimizerInput(tf.range)).catch(() => null),
    queryInstant(env, pql.optimizerOutput(tf.range)).catch(() => null),
    queryInstant(env, pql.streamerIndexed(tf.range)).catch(() => null),
    queryInstant(env, pql.pipelineUp()).catch(() => null),
    queryInstant(env, pql.distinctServices(tf.range)).catch(() => null),
  ]);

  const regIn = regInRes?.data?.result?.[0] ? parsePrometheusValue(regInRes.data.result[0]) : 0;
  const regOut = regOutRes?.data?.result?.[0] ? parsePrometheusValue(regOutRes.data.result[0]) : 0;
  const optIn = optInRes?.data?.result?.[0] ? parsePrometheusValue(optInRes.data.result[0]) : 0;
  const optOut = optOutRes?.data?.result?.[0] ? parsePrometheusValue(optOutRes.data.result[0]) : 0;
  const streamBytes = streamRes?.data?.result?.[0] ? parsePrometheusValue(streamRes.data.result[0]) : 0;
  const pipeCount = pipeRes?.data?.result?.[0] ? parsePrometheusValue(pipeRes.data.result[0]) : 0;
  const svcCount = svcRes?.data?.result?.[0] ? parsePrometheusValue(svcRes.data.result[0]) : 0;

  const regSavedBytes = Math.max(0, regIn - regOut);
  const optSavedBytes = Math.max(0, optIn - optOut);

  const regSavedCost = bytesToCost(regSavedBytes, costPerGb);
  const optSavedCost = bytesToCost(optSavedBytes, costPerGb);
  const streamCost = bytesToCost(streamBytes, costPerGb);

  const totalSaved = regSavedCost + optSavedCost + streamCost;
  const annualProjection = totalSaved * (365 / tf.days);

  const lines: string[] = [];
  lines.push(`Pipeline Savings (${tf.label}) at ${fmtDollar(costPerGb)}/GB`);
  lines.push('');

  if (regSavedBytes > 0) {
    lines.push(`  Regulator:  ${fmtBytes(regSavedBytes).padEnd(14)} filtered   → ${fmtDollar(regSavedCost)}${period} saved`);
  }
  if (optSavedBytes > 0) {
    lines.push(`  Optimizer:  ${fmtBytes(optSavedBytes).padEnd(14)} compacted  → ${fmtDollar(optSavedCost)}${period} saved`);
  }
  if (streamBytes > 0) {
    lines.push(`  Streamer:   ${fmtBytes(streamBytes).padEnd(14)} indexed    → ${fmtDollar(streamCost)}${period} saved`);
  }

  if (totalSaved === 0) {
    lines.push('  No savings data available yet. Savings appear once the pipeline processes data.');
  } else {
    lines.push('');
    lines.push(`  Total: ${fmtDollar(totalSaved)}${period} · ${fmtDollar(annualProjection)}/yr projected`);
  }

  if (pipeCount > 0 || svcCount > 0) {
    lines.push('');
    const parts: string[] = [];
    if (pipeCount > 0) parts.push(`${Math.round(pipeCount)} pipeline instance${pipeCount !== 1 ? 's' : ''}`);
    if (svcCount > 0) parts.push(`${Math.round(svcCount)} service${svcCount !== 1 ? 's' : ''} monitored`);
    lines.push(`  ${parts.join(' · ')}`);
  }

  return lines.join('\n');
}
