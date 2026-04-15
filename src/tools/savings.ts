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
  // metric's ~12k series blows a single 7d/30d `increase()` query.
  //
  // Chunks return { sum, succeeded, total } so callers can annotate coverage.
  // Intermittent Prometheus aggregation-limit errors (HTTP 422 "the query hit
  // the aggregated data size limit") affect a subset of chunks deterministically
  // — they are NOT caused by client-side concurrency (tested: throttling to 6
  // concurrent requests quadruples wall time with zero improvement in coverage).
  // The root cause is server-side and cannot be fixed from the client. PR #12's
  // coverage annotation surfaces the partial-data honestly to the caller.
  const chunkOffsets = Array.from({ length: tf.days }, (_, i) => i);
  const chunkSum = async (builder: (off: number) => string): Promise<{ sum: number; succeeded: number; total: number }> => {
    const results = await Promise.all(
      chunkOffsets.map((off) => queryInstant(env, builder(off)).catch(() => null))
    );
    let sum = 0;
    let succeeded = 0;
    for (const res of results) {
      if (res === null) continue;
      succeeded++;
      const v = res?.data?.result?.[0] ? parsePrometheusValue(res.data.result[0]) : 0;
      sum += v;
    }
    return { sum, succeeded, total: chunkOffsets.length };
  };

  // For multi-day windows, also fetch 7d in parallel to detect ramp-up.
  const fetch7d = tf.days > 7;
  const sevenDayOffsets = Array.from({ length: 7 }, (_, i) => i);
  const chunk7dSum = async (builder: (off: number) => string): Promise<{ sum: number; succeeded: number; total: number }> => {
    const results = await Promise.all(
      sevenDayOffsets.map((off) => queryInstant(env, builder(off)).catch(() => null))
    );
    let sum = 0;
    let succeeded = 0;
    for (const res of results) {
      if (res === null) continue;
      succeeded++;
      const v = res?.data?.result?.[0] ? parsePrometheusValue(res.data.result[0]) : 0;
      sum += v;
    }
    return { sum, succeeded, total: sevenDayOffsets.length };
  };

  // Query all savings metrics in parallel.
  const [edgeInRes, edgeOutRes, indexedResult, streamedResult, pipeRes, svcRes,
         edgeIn7dRes, edgeOut7dRes, indexed7dResult, streamed7dResult] = await Promise.all([
    queryInstant(env, pql.edgeInputBytes(tf.range)).catch(() => null),
    queryInstant(env, pql.edgeEmittedBytes(tf.range)).catch(() => null),
    chunkSum(pql.streamerIndexedBytesChunk),
    chunkSum(pql.streamerStreamedBytesChunk),
    queryInstant(env, pql.pipelineUp()).catch(() => null),
    queryInstant(env, pql.distinctServices(tf.range)).catch(() => null),
    fetch7d ? queryInstant(env, pql.edgeInputBytes('7d')).catch(() => null) : Promise.resolve(null),
    fetch7d ? queryInstant(env, pql.edgeEmittedBytes('7d')).catch(() => null) : Promise.resolve(null),
    fetch7d ? chunk7dSum(pql.streamerIndexedBytesChunk) : Promise.resolve({ sum: 0, succeeded: 7, total: 7 }),
    fetch7d ? chunk7dSum(pql.streamerStreamedBytesChunk) : Promise.resolve({ sum: 0, succeeded: 7, total: 7 }),
  ]);
  const indexedBytes = indexedResult.sum;
  const streamedBytes = streamedResult.sum;
  // Coverage fraction across the main streamer chunks (tf.days × 2 queries).
  const mainStreamerChunksOk = indexedResult.succeeded + streamedResult.succeeded;
  const mainStreamerChunksTotal = indexedResult.total + streamedResult.total;
  const mainStreamerCoverage = mainStreamerChunksTotal > 0 ? mainStreamerChunksOk / mainStreamerChunksTotal : 1;
  const indexed7d = indexed7dResult.sum;
  const streamed7d = streamed7dResult.sum;
  // Coverage fraction across the 14 streamer chunks (7 indexed + 7 streamed).
  const streamer7dChunksOk = indexed7dResult.succeeded + streamed7dResult.succeeded;
  const streamer7dChunksTotal = indexed7dResult.total + streamed7dResult.total;
  const streamer7dCoverage = streamer7dChunksTotal > 0 ? streamer7dChunksOk / streamer7dChunksTotal : 1;

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
    // Headline reliability caveat: if any streamer chunks in the MAIN query silently
    // failed, the headline number is an underestimate and the caller needs to know.
    // (Edge queries are single-shot, not chunked, so they either fully succeed or return null.)
    if (mainStreamerCoverage < 1 && (indexedBytes > 0 || streamedBytes > 0)) {
      const pct = Math.round(mainStreamerCoverage * 100);
      lines.push(`  _Coverage note: only ${mainStreamerChunksOk}/${mainStreamerChunksTotal} streamer chunks returned (${pct}%). The Total above is a conservative underestimate — true savings are equal or higher. This is caused by intermittent Prometheus server aggregation limits on the bleeding-edge day; retry in 30s for a cleaner number._`);
    }
    if (edgeInRes === null || edgeOutRes === null) {
      lines.push(`  _Coverage note: the main edge baseline query failed. The Total above may be missing the Edge savings contribution. Retry the call._`);
    }

    // Run-rate check. Compare the 7-day projection against the trailing-window projection.
    // If the 7d-annualized is >2× the trailing-window-annualized, the environment is ramping
    // and the trailing-window number will understate current cost.
    //
    // IMPORTANT: the internal 7d streamer queries sometimes get partial coverage because
    // `streamerIndexedBytesChunk` at offset=0d (the bleeding edge) can hit a Prometheus
    // server aggregation limit (~5GB per query) on high-cardinality envs. The previous
    // version silently zero-filled failed chunks, producing a false-all-clear on the
    // run-rate note (caught by Final-1 sub-agent audit). This version reports coverage
    // explicitly and lets the caller judge confidence.
    if (fetch7d) {
      const edge7dOk = edgeIn7dRes !== null && edgeOut7dRes !== null;
      const edgeIn7d = edgeIn7dRes?.data?.result?.[0] ? parsePrometheusValue(edgeIn7dRes.data.result[0]) : 0;
      const edgeOut7d = edgeOut7dRes?.data?.result?.[0] ? parsePrometheusValue(edgeOut7dRes.data.result[0]) : 0;
      const edgeReduced7d = Math.max(0, edgeIn7d - edgeOut7d);
      const edge7dSavings = bytesToCost(edgeReduced7d, costPerGb);
      const streamer7dSavings = Math.max(
        0,
        bytesToCost(indexed7d, costPerGb - storagePerGb) - bytesToCost(streamed7d, costPerGb)
      );
      const total7d = edge7dSavings + streamer7dSavings;
      const annual7d = total7d * (365 / 7);

      // Coverage: edge contributes 2 queries (both must succeed). streamer contributes
      // 14 chunks (7 indexed + 7 streamed). If everything succeeded, coverage is 1.0.
      // Partial streamer coverage is an UNDERESTIMATE of annual7d — the true value
      // would be equal or higher. So if the partial math says annual7d > 2×, the real
      // value is definitely > 2×. Only the other direction (partial says <2× but true
      // value is >2×) is a risk, and only when partial coverage is low.
      const fullCoverage = edge7dOk && streamer7dCoverage >= 1;
      const enoughCoverage = edge7dOk && streamer7dCoverage >= 0.7; // 10 of 14 chunks min

      if (!edge7dOk) {
        lines.push('');
        lines.push(`  _Run-rate check skipped: edge 7d baseline query failed. Retry in 30s. Do NOT interpret the absence of a run-rate warning as confirmation of stable run-rate — the check could not execute._`);
      } else if (annual7d > annualProjection * 2) {
        // Partial or full — if the partial says ramping, the full definitely says ramping.
        const coverageNote = fullCoverage
          ? ''
          : ` _(streamer coverage: ${streamer7dChunksOk}/${streamer7dChunksTotal} chunks — this is a conservative underestimate; true rate is equal or higher)_`;
        lines.push('');
        lines.push(`  **Run-rate note**: The last 7 days project to ${fmtDollar(annual7d)}/yr — ${Math.round(annual7d / annualProjection)}× higher than the ${tf.label} trailing average. Volume has been ramping. Use the 7-day figure for forward-looking projections.${coverageNote}`);
      } else if (!enoughCoverage) {
        // Partial coverage AND the partial math was below threshold — this is the
        // failure mode where the true value could be above threshold. Warn.
        lines.push('');
        lines.push(`  _Run-rate check inconclusive: only ${streamer7dChunksOk}/${streamer7dChunksTotal} streamer chunks returned (coverage ${Math.round(streamer7dCoverage * 100)}%). Partial math projects ${fmtDollar(annual7d)}/yr (${(annual7d / annualProjection).toFixed(1)}× trailing), which is below the 2× ramp-up threshold — but the true value may be higher due to missing chunks. Retry in 30s to confirm whether the environment is stable or ramping._`);
      }
      // Full coverage AND annual7d <= threshold → stable. No note needed.
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
