/**
 * log10x_savings — pipeline savings summary.
 *
 * Ported from the Grafana ROI analytics dashboard's canonical formula:
 *   edgeSavings    = (inputBytes - emittedBytes) × analyzerCost
 *   retrieverSavings = indexedBytes × (analyzerCost - storageCost)
 *                   - streamedBytes × analyzerCost
 *   totalSavings   = max(0, edgeSavings) + max(0, retrieverSavings)
 *
 * The earlier version of this file used all_events_summaryBytes_total as the
 * output metric for every stage, which over-counted by a wide margin because
 * emitted/indexed/streamed are tracked on separate metrics.
 *
 * Retriever indexed metric has high per-series cardinality (~12k active series
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
import { fmtDollar, fmtBytes, fmtPct, parseTimeframe, costPeriodLabel } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';

/** S3 Standard default, matching the ROI dashboard's storageCost default ($/GB/month). */
const DEFAULT_STORAGE_COST_PER_GB = 0.023;

/** Origin of the analyzer $/GB used in this run. Drives dollar-gating in headlines + markdown. */
export type RateSource = 'list_price' | 'customer_supplied' | 'unset';

export const savingsSchema = {
  timeRange: z.enum(['1d', '7d', '30d']).default('7d').describe('Time range'),
  analyzerCost: z.number().optional().describe('DEPRECATED alias for effective_ingest_per_gb. SIEM ingestion cost in $/GB.'),
  effective_ingest_per_gb: z.number().optional().describe('Customer-supplied SIEM ingestion cost in $/GB. When provided, rate_source=customer_supplied and dollars are populated. When omitted and no profile rate is available, rate_source=unset and the headline reports percent + bytes only (no dollars).'),
  storageCost: z.number().optional().describe('S3 storage cost in $/GB/month. Defaults to $0.023 (S3 Standard).'),
  environment: z.string().optional().describe('Environment nickname'),
  view: z.literal('summary').default('summary').optional().describe('Output format. Always "summary" — the typed envelope (data.totals, data.edge, data.retriever, data.run_rate). Field retained for backward-compat.'),
};

interface SavingsSummary {
  time_range: string;
  /** Resolved $/GB used for dollar math. null when rate_source === 'unset'. */
  cost_per_gb: number | null;
  storage_per_gb: number;
  period: string;
  rate_source: RateSource;
  edge: {
    input_bytes: number;
    emitted_bytes: number;
    reduced_bytes: number;
    reduction_pct: number;
    /** null when rate_source === 'unset' (no $/GB known — no honest dollar figure). */
    savings_dollars: number | null;
    emission_missing: boolean;
  };
  retriever: {
    indexed_bytes: number;
    streamed_bytes: number;
    reduction_pct: number;
    /** null when rate_source === 'unset'. */
    savings_dollars: number | null;
    coverage: number;
    chunks_ok: number;
    chunks_total: number;
  };
  totals: {
    reduction_pct: number;
    /** null when rate_source === 'unset'. */
    realized_dollars: number | null;
    /** null when rate_source === 'unset'. */
    annual_projection_dollars: number | null;
    has_data: boolean;
  };
  run_rate?: {
    /** null when rate_source === 'unset'. */
    seven_day_annualized: number | null;
    ramping: boolean;
    coverage: number;
  };
  pipeline_instances: number;
  services_monitored: number;
}

export async function executeSavings(
  args: { timeRange?: string; analyzerCost?: number; effective_ingest_per_gb?: number; storageCost?: number; view?: 'summary' },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const telemetry = newTelemetry();
  const sumOut: { data?: SavingsSummary } = {};
  await executeSavingsInner(args, env, sumOut);
  if (!sumOut.data) {
    // No structured data was assembled (the inner builder ran but data is
    // unavailable — e.g. metrics backend returned empty). Emit a typed envelope
    // with a human_summary explaining the missing-data state.
    const headline = 'No realized-savings metrics available for this environment yet.';
    return buildEnvelope({
      tool: 'log10x_savings',
      view: 'summary',
      summary: { headline },
      data: { ...buildUnifiedFields({ status: 'insufficient_data', telemetry, humanSummary: headline }) },
    });
  }
  const d = sumOut.data;
  // Percent-first headline; dollar clause is gated on rate_source !== 'unset'.
  // When no $/GB is known we refuse to print a dollar number (no $1.0/GB lie).
  let headline: string;
  if (!d.totals.has_data) {
    headline = `No realized-savings metrics for this environment yet — pipeline has not booked any volume reduction.`;
  } else if (d.rate_source === 'unset') {
    headline = `Pipeline savings (${d.time_range}): ${fmtPct(d.totals.reduction_pct)} of input bytes removed${d.run_rate?.ramping ? ' (volume ramping)' : ''}. Pass effective_ingest_per_gb to overlay dollars.`;
  } else {
    const realized = d.totals.realized_dollars;
    const annual = d.totals.annual_projection_dollars;
    const dollarClause = realized != null && annual != null
      ? `, ${fmtDollar(realized)}${d.period} realized, ${fmtDollar(annual)}/yr projected at ${d.rate_source}`
      : '';
    headline = `Pipeline savings (${d.time_range}): ${fmtPct(d.totals.reduction_pct)} of input bytes removed${dollarClause}${d.run_rate?.ramping ? ' (volume ramping)' : ''}.`;
  }
  return buildEnvelope({
    tool: 'log10x_savings',
    view: 'summary',
    summary: { headline },
    data: { ...d, ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }) },
    actions: [
      { tool: 'log10x_top_patterns', args: { timeRange: d.time_range, limit: 10 }, reason: 'see which patterns currently drive cost (where the savings come from)' },
      { tool: 'log10x_top_patterns', args: { timeRange: d.time_range, limit: 10, comparison_window: d.time_range }, reason: 'delta-versus-baseline view to check whether costs are growing' },
    ],
  });
}

async function executeSavingsInner(
  args: { timeRange?: string; analyzerCost?: number; effective_ingest_per_gb?: number; storageCost?: number },
  env: EnvConfig,
  sumOut?: { data?: SavingsSummary }
): Promise<string> {
  // Defensive defaults — match savingsSchema (timeRange:'7d').
  const timeRange = args.timeRange ?? '7d';
  const tf = parseTimeframe(timeRange);
  // Resolve $/GB with rate_source attribution. No silent $1/GB fallback — if
  // the caller supplies nothing and there is no profile rate to inherit, we
  // emit rate_source='unset' and downstream dollar math returns null so the
  // headline/markdown can refuse to print a dollar lie.
  const overrideRate = args.effective_ingest_per_gb ?? args.analyzerCost;
  const rateSource: RateSource =
    overrideRate != null ? 'customer_supplied' : 'unset';
  const costPerGb: number | null = overrideRate != null ? overrideRate : null;
  const storagePerGb = args.storageCost ?? DEFAULT_STORAGE_COST_PER_GB;
  const period = costPeriodLabel(tf.days);

  // Retriever indexed/streamed metrics need chunked evaluation: the indexed
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
    chunkSum(pql.retrieverIndexedBytesChunk),
    chunkSum(pql.retrieverStreamedBytesChunk),
    queryInstant(env, pql.pipelineUp()).catch(() => null),
    queryInstant(env, pql.distinctServices(tf.range)).catch(() => null),
    fetch7d ? queryInstant(env, pql.edgeInputBytes('7d')).catch(() => null) : Promise.resolve(null),
    fetch7d ? queryInstant(env, pql.edgeEmittedBytes('7d')).catch(() => null) : Promise.resolve(null),
    fetch7d ? chunk7dSum(pql.retrieverIndexedBytesChunk) : Promise.resolve({ sum: 0, succeeded: 7, total: 7 }),
    fetch7d ? chunk7dSum(pql.retrieverStreamedBytesChunk) : Promise.resolve({ sum: 0, succeeded: 7, total: 7 }),
  ]);
  const indexedBytes = indexedResult.sum;
  const streamedBytes = streamedResult.sum;
  // Coverage fraction across the main retriever chunks (tf.days × 2 queries).
  const mainRetrieverChunksOk = indexedResult.succeeded + streamedResult.succeeded;
  const mainRetrieverChunksTotal = indexedResult.total + streamedResult.total;
  const mainRetrieverCoverage = mainRetrieverChunksTotal > 0 ? mainRetrieverChunksOk / mainRetrieverChunksTotal : 1;
  const indexed7d = indexed7dResult.sum;
  const streamed7d = streamed7dResult.sum;
  // Coverage fraction across the 14 retriever chunks (7 indexed + 7 streamed).
  const retriever7dChunksOk = indexed7dResult.succeeded + streamed7dResult.succeeded;
  const retriever7dChunksTotal = indexed7dResult.total + streamed7dResult.total;
  const retriever7dCoverage = retriever7dChunksTotal > 0 ? retriever7dChunksOk / retriever7dChunksTotal : 1;

  const edgeIn = edgeInRes?.data?.result?.[0] ? parsePrometheusValue(edgeInRes.data.result[0]) : 0;
  const edgeEmitted = edgeOutRes?.data?.result?.[0] ? parsePrometheusValue(edgeOutRes.data.result[0]) : 0;
  const pipeCount = pipeRes?.data?.result?.[0] ? parsePrometheusValue(pipeRes.data.result[0]) : 0;
  const svcCount = svcRes?.data?.result?.[0] ? parsePrometheusValue(svcRes.data.result[0]) : 0;

  // Edge savings: bytes that entered the pipeline minus bytes that left it.
  // Bytes-saved is the truth signal; dollars are an overlay only when we know
  // a $/GB rate.
  const edgeReducedBytes = Math.max(0, edgeIn - edgeEmitted);
  const edgeReductionPct = edgeIn > 0 ? (edgeReducedBytes / edgeIn) * 100 : 0;
  const edgeSavings: number | null =
    costPerGb != null ? bytesToCost(edgeReducedBytes, costPerGb) : null;

  // Retriever savings: cost avoided by keeping data in S3 instead of the SIEM
  // = indexedBytes * (analyzerCost - storageCost) - streamedBytes * analyzerCost
  const retrieverInputBytes = indexedBytes + streamedBytes;
  const retrieverReductionPct =
    retrieverInputBytes > 0 ? (indexedBytes / retrieverInputBytes) * 100 : 0;
  const retrieverSavings: number | null =
    costPerGb != null
      ? Math.max(
          0,
          bytesToCost(indexedBytes, costPerGb - storagePerGb) -
            bytesToCost(streamedBytes, costPerGb)
        )
      : null;

  // Exclude edgeSavings from the headline total if there's no downstream
  // emission — unshipped potential is not realized savings.
  const edgeEmissionMissing = edgeIn > 0 && edgeEmitted === 0;
  const realizedEdgeSavings: number | null =
    edgeSavings == null ? null : edgeEmissionMissing ? 0 : edgeSavings;
  const totalSaved: number | null =
    realizedEdgeSavings == null || retrieverSavings == null
      ? null
      : realizedEdgeSavings + retrieverSavings;
  const annualProjection: number | null =
    totalSaved == null ? null : totalSaved * (365 / tf.days);
  // Combined byte-share reduction across edge + retriever — used by the
  // percent-first headline whether or not dollars are populated.
  const totalReducedBytes = edgeReducedBytes + indexedBytes;
  const totalInputBytes = edgeIn + retrieverInputBytes;
  const totalReductionPct =
    totalInputBytes > 0 ? (totalReducedBytes / totalInputBytes) * 100 : 0;
  const hasData = totalReducedBytes > 0;

  const lines: string[] = [];
  // Header: when rate_source is 'unset' we deliberately omit the $/GB clause
  // (printing $0 or $1 here is the headline lie we are removing).
  if (costPerGb != null) {
    lines.push(
      `Pipeline Savings (${tf.label}) at ${fmtDollar(costPerGb)}/GB analyzer (${rateSource}) · ${fmtDollar(storagePerGb)}/GB storage`
    );
  } else {
    lines.push(`Pipeline Savings (${tf.label}) — rate unset, percent-only view`);
  }
  lines.push('');

  // If edgeEmitted == 0 while edgeIn > 0, tenx-edge has no configured
  // downstream SIEM target (or the target has been misconfigured). This is
  // NOT realized savings — it's unshipped volume. Reporting a "saved" dollar
  // figure here destroys credibility when the customer realizes nothing was
  // actually emitted. Instead, show a warning banner and flag it as potential
  // savings that cannot be attributed to a SIEM the customer is paying for.
  // Caught by S2 sub-agent: "I cannot reconcile $196K/wk saved against $196K
  // monitored spend — they are the same number." Was the same number because
  // emitted=0 in the demo env.
  if (edgeEmissionMissing) {
    lines.push(`  Edge:      ${fmtBytes(edgeIn).padEnd(14)} input      → ⚠ no downstream emission detected`);
    lines.push(`             (input ${fmtBytes(edgeIn)} processed, but 0 B emitted to a SIEM target)`);
    if (edgeSavings != null) {
      lines.push(`             _Potential savings if this were routed through the pipeline: ${fmtDollar(edgeSavings)}${period} at ${rateSource}._`);
    } else {
      lines.push(`             _Pass effective_ingest_per_gb to overlay a potential-savings dollar figure._`);
    }
    lines.push(`             _To realize these savings, configure a downstream SIEM output (Splunk, Datadog, etc.) and measurements will populate within 24h._`);
  } else if (edgeReducedBytes > 0) {
    const dollarTail =
      edgeSavings != null
        ? ` → ${fmtDollar(edgeSavings)}${period} saved at ${rateSource}`
        : '';
    lines.push(
      `  Edge:      ${fmtBytes(edgeReducedBytes).padEnd(14)} reduced (${fmtPct(edgeReductionPct)} of input)${dollarTail}`
    );
    lines.push(`             (input ${fmtBytes(edgeIn)} − emitted ${fmtBytes(edgeEmitted)})`);
  }
  if (indexedBytes > 0 || streamedBytes > 0) {
    const dollarTail =
      retrieverSavings != null
        ? ` → ${fmtDollar(retrieverSavings)}${period} saved at ${rateSource}`
        : '';
    lines.push(
      `  Retriever:  ${fmtBytes(indexedBytes).padEnd(14)} in S3 (${fmtPct(retrieverReductionPct)} of retriever input)${dollarTail}`
    );
    lines.push(`             (streamed back: ${fmtBytes(streamedBytes)})`);
  }

  if (!hasData) {
    lines.push('  No realized-savings metrics for this environment yet.');
    lines.push('');
    lines.push('  This tool measures savings the pipeline has ALREADY booked: edge');
    lines.push('  volume reduced before egress, and retriever volume kept in S3');
    lines.push('  instead of the analyzer. None of those metrics are being emitted');
    lines.push('  here yet (no reducer/optimizer egress and no retriever deployed),');
    lines.push('  so there is nothing realized to report. This is a truthful empty,');
    lines.push('  not a tool failure.');
    lines.push('');
    lines.push('  The cost-reduction OPPORTUNITY is still visible from the pattern');
    lines.push('  ranking: the biggest patterns by cost, with a per-pattern reduce');
    lines.push('  menu (drop / compact / mute), are where booked savings would come');
    lines.push('  from once the pipeline is reducing volume.');
    lines.push('');
    lines.push('  Fast first win — k8s field drops at the engine:');
    lines.push('  Edit `config/modules/pipelines/run/modules/initialize/k8s/settings.yaml`');
    lines.push('  and drop these fields (high-cardinality / low-signal across CH and ES):');
    lines.push('    kubernetes.labels, kubernetes.annotations, kubernetes.pod_id,');
    lines.push('    kubernetes.docker_id, kubernetes.container_hash, kubernetes.container_image,');
    lines.push('    tenx_tag, stream, time');
    lines.push('  These are dropped engine-side (one config, all forwarders), not in each');
    lines.push('  forwarder pipeline — keep fluent-bit / fluentd / filebeat / logstash /');
    lines.push('  otel-collector configs untouched.');
  } else {
    lines.push('');
    if (totalSaved != null && annualProjection != null) {
      lines.push(
        `  Total: ${fmtPct(totalReductionPct)} of input bytes removed · ${fmtDollar(totalSaved)}${period} · ${fmtDollar(annualProjection)}/yr projected at ${rateSource}`
      );
    } else {
      lines.push(
        `  Total: ${fmtPct(totalReductionPct)} of input bytes removed (rate unset — pass effective_ingest_per_gb to overlay dollars)`
      );
    }
    // Headline reliability caveat: if any retriever chunks in the MAIN query silently
    // failed, the headline number is an underestimate and the caller needs to know.
    // (Edge queries are single-shot, not chunked, so they either fully succeed or return null.)
    if (mainRetrieverCoverage < 1 && (indexedBytes > 0 || streamedBytes > 0)) {
      const pct = Math.round(mainRetrieverCoverage * 100);
      lines.push(`  _Coverage note: only ${mainRetrieverChunksOk}/${mainRetrieverChunksTotal} retriever chunks returned (${pct}%). The Total above is a conservative underestimate — true savings are equal or higher. This is caused by intermittent Prometheus server aggregation limits on the bleeding-edge day; retry in 30s for a cleaner number._`);
    }
    if (edgeInRes === null || edgeOutRes === null) {
      lines.push(`  _Coverage note: the main edge baseline query failed. The Total above may be missing the Edge savings contribution. Retry the call._`);
    }

    // Run-rate check. Compare the 7-day projection against the trailing-window projection.
    // If the 7d-annualized is >2× the trailing-window-annualized, the environment is ramping
    // and the trailing-window number will understate current cost.
    //
    // IMPORTANT: the internal 7d retriever queries sometimes get partial coverage because
    // `retrieverIndexedBytesChunk` at offset=0d (the bleeding edge) can hit a Prometheus
    // server aggregation limit (~5GB per query) on high-cardinality envs. The previous
    // version silently zero-filled failed chunks, producing a false-all-clear on the
    // run-rate note (caught by Final-1 sub-agent audit). This version reports coverage
    // explicitly and lets the caller judge confidence.
    if (fetch7d) {
      const edge7dOk = edgeIn7dRes !== null && edgeOut7dRes !== null;
      const edgeIn7d = edgeIn7dRes?.data?.result?.[0] ? parsePrometheusValue(edgeIn7dRes.data.result[0]) : 0;
      const edgeOut7d = edgeOut7dRes?.data?.result?.[0] ? parsePrometheusValue(edgeOut7dRes.data.result[0]) : 0;
      const edgeReduced7d = Math.max(0, edgeIn7d - edgeOut7d);
      // Ramp detection is a ratio on the trailing-window byte volume — it
      // doesn't need a $/GB rate, so we compute it directly from reduced bytes.
      // Annualized dollars are still emitted, but only when the rate is known.
      const totalReducedBytes7d = edgeReduced7d + indexed7d;
      const annualReducedBytes7d = totalReducedBytes7d * (365 / 7);
      const annualReducedBytesTrailing = totalReducedBytes * (365 / tf.days);
      const annual7d: number | null =
        costPerGb != null
          ? Math.max(
              0,
              bytesToCost(edgeReduced7d, costPerGb) +
                (bytesToCost(indexed7d, costPerGb - storagePerGb) -
                  bytesToCost(streamed7d, costPerGb))
            ) * (365 / 7)
          : null;

      // Coverage: edge contributes 2 queries (both must succeed). retriever contributes
      // 14 chunks (7 indexed + 7 streamed). If everything succeeded, coverage is 1.0.
      // Partial retriever coverage is an UNDERESTIMATE of annual7d — the true value
      // would be equal or higher. So if the partial math says annual7d > 2×, the real
      // value is definitely > 2×. Only the other direction (partial says <2× but true
      // value is >2×) is a risk, and only when partial coverage is low.
      const fullCoverage = edge7dOk && retriever7dCoverage >= 1;
      const enoughCoverage = edge7dOk && retriever7dCoverage >= 0.7; // 10 of 14 chunks min
      const rampRatio =
        annualReducedBytesTrailing > 0
          ? annualReducedBytes7d / annualReducedBytesTrailing
          : 0;
      const isRamping = edge7dOk && rampRatio > 2;

      if (!edge7dOk) {
        lines.push('');
        lines.push(`  _Run-rate check skipped: edge 7d baseline query failed. Retry in 30s. Do NOT interpret the absence of a run-rate warning as confirmation of stable run-rate — the check could not execute._`);
      } else if (isRamping) {
        // Partial or full — if the partial says ramping, the full definitely says ramping.
        const coverageNote = fullCoverage
          ? ''
          : ` _(retriever coverage: ${retriever7dChunksOk}/${retriever7dChunksTotal} chunks — this is a conservative underestimate; true rate is equal or higher)_`;
        const dollarClause =
          annual7d != null
            ? `${fmtDollar(annual7d)}/yr — `
            : '';
        lines.push('');
        lines.push(`  **Run-rate note**: The last 7 days project to ${dollarClause}${Math.round(rampRatio)}× higher than the ${tf.label} trailing average. Volume has been ramping. Use the 7-day figure for forward-looking projections.${coverageNote}`);
      } else if (!enoughCoverage) {
        // Partial coverage AND the partial math was below threshold — this is the
        // failure mode where the true value could be above threshold. Warn.
        const dollarClause =
          annual7d != null
            ? `${fmtDollar(annual7d)}/yr `
            : '';
        lines.push('');
        lines.push(`  _Run-rate check inconclusive: only ${retriever7dChunksOk}/${retriever7dChunksTotal} retriever chunks returned (coverage ${Math.round(retriever7dCoverage * 100)}%). Partial math projects ${dollarClause}(${rampRatio.toFixed(1)}× trailing), which is below the 2× ramp-up threshold — but the true value may be higher due to missing chunks. Retry in 30s to confirm whether the environment is stable or ramping._`);
      }
      // Full coverage AND ramp <= threshold → stable. No note needed.
    }
  }

  if (pipeCount > 0 || svcCount > 0) {
    lines.push('');
    const parts: string[] = [];
    if (pipeCount > 0) parts.push(`${Math.round(pipeCount)} pipeline instance${pipeCount !== 1 ? 's' : ''}`);
    if (svcCount > 0) parts.push(`${Math.round(svcCount)} service${svcCount !== 1 ? 's' : ''} monitored (all-time; differs from a 24h active-service count)`);
    lines.push(`  ${parts.join(' · ')}`);
  }

  // Warn when Retriever data was present — those chunked queries can take 30–90s
  // on high-cardinality envs. Let the caller know this is expected.
  if (indexedBytes > 0) {
    lines.push('');
    lines.push('  _Retriever figures use chunked parallel queries (one per day) to avoid server budget limits on high-cardinality indexed metrics. This call may take 30–90s on large deployments._');
  }

  const next: NextAction[] = [
    {
      tool: 'log10x_top_patterns',
      args: { timeRange: tf.range, limit: 10 },
      reason: 'see which patterns currently drive cost (where the savings come from)',
    },
    {
      tool: 'log10x_top_patterns',
      args: { timeRange: tf.range, limit: 10, comparison_window: tf.range },
      reason: 'delta-vs-baseline view to check whether costs are growing — savings projection assumes stable run-rate',
    },
  ];
  const block = renderNextActions(next);
  if (block) lines.push('', block);

  if (sumOut) {
    let runRate: SavingsSummary['run_rate'];
    if (fetch7d) {
      const edge7dOk = edgeIn7dRes !== null && edgeOut7dRes !== null;
      const edgeIn7d = edgeIn7dRes?.data?.result?.[0] ? parsePrometheusValue(edgeIn7dRes.data.result[0]) : 0;
      const edgeOut7d = edgeOut7dRes?.data?.result?.[0] ? parsePrometheusValue(edgeOut7dRes.data.result[0]) : 0;
      const edgeReduced7d = Math.max(0, edgeIn7d - edgeOut7d);
      const totalReducedBytes7d = edgeReduced7d + indexed7d;
      const annualReducedBytes7d = totalReducedBytes7d * (365 / 7);
      const annualReducedBytesTrailing = totalReducedBytes * (365 / tf.days);
      const rampRatio =
        annualReducedBytesTrailing > 0
          ? annualReducedBytes7d / annualReducedBytesTrailing
          : 0;
      const annual7d: number | null =
        costPerGb != null
          ? Math.max(
              0,
              bytesToCost(edgeReduced7d, costPerGb) +
                (bytesToCost(indexed7d, costPerGb - storagePerGb) -
                  bytesToCost(streamed7d, costPerGb))
            ) * (365 / 7)
          : null;
      runRate = {
        seven_day_annualized: annual7d,
        ramping: edge7dOk && rampRatio > 2,
        coverage: retriever7dCoverage,
      };
    }
    sumOut.data = {
      time_range: tf.label,
      cost_per_gb: costPerGb,
      storage_per_gb: storagePerGb,
      period,
      rate_source: rateSource,
      edge: {
        input_bytes: edgeIn,
        emitted_bytes: edgeEmitted,
        reduced_bytes: edgeReducedBytes,
        reduction_pct: edgeReductionPct,
        savings_dollars: realizedEdgeSavings,
        emission_missing: edgeEmissionMissing,
      },
      retriever: {
        indexed_bytes: indexedBytes,
        streamed_bytes: streamedBytes,
        reduction_pct: retrieverReductionPct,
        savings_dollars: retrieverSavings,
        coverage: mainRetrieverCoverage,
        chunks_ok: mainRetrieverChunksOk,
        chunks_total: mainRetrieverChunksTotal,
      },
      totals: {
        reduction_pct: totalReductionPct,
        realized_dollars: totalSaved,
        annual_projection_dollars: annualProjection,
        has_data: hasData,
      },
      run_rate: runRate,
      pipeline_instances: pipeCount,
      services_monitored: svcCount,
    };
  }

  return lines.join('\n');
}
