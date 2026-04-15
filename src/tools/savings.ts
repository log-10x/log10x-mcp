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
 *
 * Streamer indexed metric has high per-series cardinality (~12k active series
 * per env because of the index_file label). A single `sum(increase(...[7d]))`
 * query blows the Prometheus server's query resource budget and returns 503.
 * The workaround is to chunk the window into N × 1d queries in parallel and
 * sum the results client-side — each 1d increase is cheap enough for the
 * server to complete, and the total is mathematically equivalent so long as
 * each chunk is computed per-series before summing (which preserves counter
 * reset handling).
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

  // Streamer indexed/streamed metrics need chunked evaluation: the indexed
  // metric's ~12k series blows a single 7d/30d `increase()` query. Issue
  // tf.days parallel 1d-chunk queries and sum client-side.
  const chunkOffsets = Array.from({ length: tf.days }, (_, i) => i);
  const chunkSum = async (builder: (off: number) => string): Promise<number> => {
    const results = await Promise.all(
      chunkOffsets.map((off) => queryInstant(env, builder(off)).catch(() => null))
    );
    return results.reduce((total, res) => {
      const v = res?.data?.result?.[0] ? parsePrometheusValue(res.data.result[0]) : 0;
      return total + v;
    }, 0);
  };

  // For multi-day windows, also fetch 7d in parallel to detect ramp-up
  // (so we can flag when 7d run-rate projects significantly higher than the trailing average).
  const fetch7d = tf.days > 7;
  const sevenDayOffsets = Array.from({ length: 7 }, (_, i) => i);
  const chunk7dSum = async (builder: (off: number) => string): Promise<number> => {
    const results = await Promise.all(
      sevenDayOffsets.map((off) => queryInstant(env, builder(off)).catch(() => null))
    );
    return results.reduce((total, res) => {
      const v = res?.data?.result?.[0] ? parsePrometheusValue(res.data.result[0]) : 0;
      return total + v;
    }, 0);
  };

  // Query all savings metrics in parallel
  const [edgeInRes, edgeOutRes, indexedBytes, streamedBytes, pipeRes, svcRes,
         edgeIn7dRes, edgeOut7dRes, indexed7d, streamed7d] = await Promise.all([
    queryInstant(env, pql.edgeInputBytes(tf.range)).catch(() => null),
    queryInstant(env, pql.edgeEmittedBytes(tf.range)).catch(() => null),
    chunkSum(pql.streamerIndexedBytesChunk),
    chunkSum(pql.streamerStreamedBytesChunk),
    queryInstant(env, pql.pipelineUp()).catch(() => null),
    queryInstant(env, pql.distinctServices(tf.range)).catch(() => null),
    fetch7d ? queryInstant(env, pql.edgeInputBytes('7d')).catch(() => null) : Promise.resolve(null),
    fetch7d ? queryInstant(env, pql.edgeEmittedBytes('7d')).catch(() => null) : Promise.resolve(null),
    fetch7d ? chunk7dSum(pql.streamerIndexedBytesChunk) : Promise.resolve(0),
    fetch7d ? chunk7dSum(pql.streamerStreamedBytesChunk) : Promise.resolve(0),
  ]);

  const edgeIn = edgeInRes?.data?.result?.[0] ? parsePrometheusValue(edgeInRes.data.result[0]) : 0;
  const edgeEmitted = edgeOutRes?.data?.result?.[0] ? parsePrometheusValue(edgeOutRes.data.result[0]) : 0;
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

    // When querying a multi-day window, compare to the 7d run-rate to catch ramp-up environments.
    // If the 7d projection is >2× the trailing-average projection, flag it.
    if (fetch7d && edgeIn7dRes) {
      const edgeIn7d = edgeIn7dRes?.data?.result?.[0] ? parsePrometheusValue(edgeIn7dRes.data.result[0]) : 0;
      const edgeOut7d = edgeOut7dRes?.data?.result?.[0] ? parsePrometheusValue(edgeOut7dRes.data.result[0]) : 0;
      const edgeReduced7d = Math.max(0, edgeIn7d - edgeOut7d);
      const edge7dSavings = bytesToCost(edgeReduced7d, costPerGb);
      const streamer7dSavings = Math.max(
        0,
        bytesToCost(indexed7d as number, costPerGb - storagePerGb) - bytesToCost(streamed7d as number, costPerGb)
      );
      const total7d = edge7dSavings + streamer7dSavings;
      const annual7d = total7d * (365 / 7);
      if (annual7d > annualProjection * 2) {
        lines.push('');
        lines.push(`  **Run-rate note**: The last 7 days project to ${fmtDollar(annual7d)}/yr — ${Math.round(annual7d / annualProjection)}× higher than the ${tf.label} trailing average. Volume has been ramping. Use the 7-day figure for forward-looking projections.`);
      }
    }
  }

  if (pipeCount > 0 || svcCount > 0) {
    lines.push('');
    const parts: string[] = [];
    if (pipeCount > 0) parts.push(`${Math.round(pipeCount)} pipeline instance${pipeCount !== 1 ? 's' : ''}`);
    if (svcCount > 0) parts.push(`${Math.round(svcCount)} service${svcCount !== 1 ? 's' : ''} monitored`);
    lines.push(`  ${parts.join(' · ')}`);
  }

  // Warn when Streamer data was present — those chunked queries can take 30–90s
  // on high-cardinality envs. Let the caller know this is expected.
  if (indexedBytes > 0) {
    lines.push('');
    lines.push('  _Streamer figures use chunked parallel queries (one per day) to avoid server budget limits on high-cardinality indexed metrics. This call may take 30–90s on large deployments._');
  }

  return lines.join('\n');
}
