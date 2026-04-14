/**
 * log10x_savings — pipeline savings summary.
 *
 * Ported from the Grafana ROI analytics dashboard's canonical formula:
 *   edgeSavings    = (inputBytes - emittedBytes) × analyzerCost
 *   streamerSavings = indexedBytes × (analyzerCost - storageCost)
 *                   - streamedBytes × analyzerCost
 *   totalSavings   = max(0, edgeSavings) + max(0, streamerSavings)
 *
 * The earlier version of this file used all_events_summaryBytes_total as the
 * output metric for every stage, which over-counted by a wide margin because
 * emitted/indexed/streamed are tracked on separate metrics.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { fmtDollar, fmtBytes, parseTimeframe, costPeriodLabel } from '../lib/format.js';

/** S3 Standard default, matching the ROI dashboard's storageCost default ($/GB/month). */
const DEFAULT_STORAGE_COST_PER_GB = 0.023;

export const savingsSchema = {
  timeRange: z.enum(['1d', '7d', '30d']).default('7d').describe('Time range'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  storageCost: z.number().optional().describe('S3 storage cost in $/GB/month. Defaults to $0.023 (S3 Standard).'),
  environment: z.string().optional().describe('Environment nickname'),
};

export async function executeSavings(
  args: { timeRange: string; analyzerCost: number; storageCost?: number },
  env: EnvConfig
): Promise<string> {
  const tf = parseTimeframe(args.timeRange);
  const costPerGb = args.analyzerCost;
  const storagePerGb = args.storageCost ?? DEFAULT_STORAGE_COST_PER_GB;
  const period = costPeriodLabel(tf.days);

  // Query all savings metrics in parallel
  const [edgeInRes, edgeOutRes, indexedRes, streamedRes, pipeRes, svcRes] = await Promise.all([
    queryInstant(env, pql.edgeInputBytes(tf.range)).catch(() => null),
    queryInstant(env, pql.edgeEmittedBytes(tf.range)).catch(() => null),
    queryInstant(env, pql.streamerIndexedBytes(tf.range)).catch(() => null),
    queryInstant(env, pql.streamerStreamedBytes(tf.range)).catch(() => null),
    queryInstant(env, pql.pipelineUp()).catch(() => null),
    queryInstant(env, pql.distinctServices(tf.range)).catch(() => null),
  ]);

  const edgeIn = edgeInRes?.data?.result?.[0] ? parsePrometheusValue(edgeInRes.data.result[0]) : 0;
  const edgeEmitted = edgeOutRes?.data?.result?.[0] ? parsePrometheusValue(edgeOutRes.data.result[0]) : 0;
  const indexedBytes = indexedRes?.data?.result?.[0] ? parsePrometheusValue(indexedRes.data.result[0]) : 0;
  const streamedBytes = streamedRes?.data?.result?.[0] ? parsePrometheusValue(streamedRes.data.result[0]) : 0;
  const pipeCount = pipeRes?.data?.result?.[0] ? parsePrometheusValue(pipeRes.data.result[0]) : 0;
  const svcCount = svcRes?.data?.result?.[0] ? parsePrometheusValue(svcRes.data.result[0]) : 0;

  // Edge savings: bytes that entered the pipeline minus bytes that left it
  const edgeReducedBytes = Math.max(0, edgeIn - edgeEmitted);
  const edgeSavings = bytesToCost(edgeReducedBytes, costPerGb);

  // Streamer savings: cost avoided by keeping data in S3 instead of the SIEM
  // = indexedBytes * (analyzerCost - storageCost) - streamedBytes * analyzerCost
  const streamerSavings = Math.max(
    0,
    bytesToCost(indexedBytes, costPerGb - storagePerGb) - bytesToCost(streamedBytes, costPerGb)
  );

  const totalSaved = edgeSavings + streamerSavings;
  const annualProjection = totalSaved * (365 / tf.days);

  const lines: string[] = [];
  lines.push(`Pipeline Savings (${tf.label}) at ${fmtDollar(costPerGb)}/GB analyzer · ${fmtDollar(storagePerGb)}/GB storage`);
  lines.push('');

  if (edgeReducedBytes > 0) {
    lines.push(`  Edge:      ${fmtBytes(edgeReducedBytes).padEnd(14)} reduced    → ${fmtDollar(edgeSavings)}${period} saved`);
    lines.push(`             (input ${fmtBytes(edgeIn)} − emitted ${fmtBytes(edgeEmitted)})`);
  }
  if (indexedBytes > 0 || streamedBytes > 0) {
    lines.push(`  Streamer:  ${fmtBytes(indexedBytes).padEnd(14)} in S3      → ${fmtDollar(streamerSavings)}${period} saved`);
    lines.push(`             (streamed back: ${fmtBytes(streamedBytes)})`);
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
