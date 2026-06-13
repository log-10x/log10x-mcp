/**
 * log10x_pattern_trend — volume trend for a specific pattern over time.
 *
 * Shows time series data with spike detection.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryRange, queryInstant } from '../lib/api.js';
import { formatPatternLabel } from '../lib/pattern-label.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, buildDisclosedDollarValue, type DisclosedDollarValue, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { fmtDollar, fmtPattern, fmtBytes, fmtDisclosedDollar, parseTimeframe, costPeriodLabel, normalizePattern } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { lineChart } from '../lib/line-chart.js';
import { patternDisplay } from '../lib/pattern-descriptor.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import {
  buildChassisEnvelope,
  newChassisTelemetry,
  recordQuery,
} from '../lib/chassis-envelope.js';
import { resolvePatternHashFromMetrics } from '../lib/resolve-pattern-hash.js';

export const trendSchema = {
  pattern: z.string().optional().describe('Pattern name (e.g., "Payment_Gateway_Timeout"). Provide either pattern or pattern_hash — pattern_hash is preferred when available (skips a metrics lookup).'),
  pattern_hash: z.string().optional().describe('The tenx_hash of the pattern (11-char stable identity from top_patterns / preview_filter). Preferred over pattern when available.'),
  timeRange: z.enum(['15m', '1h', '6h', '24h', '1d', '7d', '30d']).default('7d').describe("Time range. '24h' and '1d' are equivalent (one-day window). Sub-day values show fine-grained trajectory around an incident."),
  step: z
    .enum(['auto', '1m', '5m', '15m', '1h', '6h', '1d'])
    .default('auto')
    .describe(
      'Data point interval. Default `auto` sizes the step to give ~12–30 buckets per window ' +
      '(1h→5m, 6h→15m, 1d/24h→1h, 7d→6h, 30d→1d). ' +
      'Override only when a specific resolution is required; an over-coarse step (e.g. 1h on a 1h window) ' +
      'produces a 2-point series with no usable trend shape.'
    ),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB'),
  environment: z.string().optional().describe('Environment nickname'),
  view: z.literal('summary').default('summary').optional().describe('Output format. Always "summary" — the structured envelope. Field retained for backward-compat.'),
  // PL-12b — engine-decision cohort scope. Supersedes the prior binary
  // dropped flag. Three states: `kept` (default, pre-PL-12 behavior)
  // = events the engine forwarded as-is (selector `routeState!="drop"`,
  // absence-tolerant so legacy series without the label still match);
  // `dropped` = events stamped routeState="drop" by the engine;
  // `both` = the pre-decision union, with a parallel `dropped_*` series
  // added to the envelope so a single call surfaces the offload share
  // over time. The dual-query path runs both queries in parallel.
  include: z
    .enum(['kept', 'dropped', 'both'])
    .default('kept')
    .describe(
      'Which engine-decision cohort to scope the trend to. ' +
      '`kept` (default) = events the engine forwarded as-is (routeState!="drop") — the pre-PL-12 behavior. ' +
      '`dropped` = events stamped routeState="drop" by the engine (the offload/down-tier cohort). ' +
      '`both` = the pre-decision union; envelope adds a parallel `dropped_time_series` and `dropped_share_pct` so one call shows offload share over time. ' +
      'Use `dropped` to verify post-deploy realised savings or to chart "what we are offloading right now". ' +
      'Use `both` to overlay kept vs dropped on the same window.'
    ),
  include_chart: z
    .boolean()
    .default(false)
    .describe(
      'Set include_chart=true to embed the rendered chart inline (large; default false to avoid response truncation).'
    ),
};

interface PatternTrendSummary {
  pattern: string;
  // Stable tenx_hash identity for this pattern — echoed here so the
  // catalog-identity-handoff (top_patterns → trend → event_lookup) carries
  // the hash through every chain step without a downstream re-resolve.
  // Resolved from metrics during pattern lookup; empty string when the
  // pattern is not present in TSDB (no_signal path).
  pattern_hash: string;
  window: string;
  step: string;
  time_series: Array<{ ts: number; bytes: number }>;
  total_bytes: number;
  total_bytes_display: string;
  // DEP: feat/x-percent-mcp-cost-tooling — dollar fields are now null when
  // no rate is set (no `?? 1.0` lie). `rate_source` advertises the axis the
  // dollar columns were computed against ('list_price' | 'customer_supplied'
  // | 'unset'). Headline + markdown body lead with bytes/percent and gate
  // the dollar clause on `rate_source !== 'unset'`.
  total_cost_usd: number | null;
  baseline_run_rate_usd: number | null;
  recent_run_rate_usd: number | null;
  // Dollar-discipline migration: disclosed-value mirrors of every dollar
  // field above. Renderers MUST consume these via `fmtDisclosedDollar`
  // (the disclosure tail carries `rate_source` semantics — no inline
  // "(at customer_supplied)" suffix). null iff the matching `*_usd`
  // numeric is null (i.e. rate_source === 'unset'). trend has no
  // destination context, so siemLabel passes through as null —
  // customer_supplied cells render with disclosure=null per design.
  total_cost_usd_disclosed: DisclosedDollarValue | null;
  baseline_run_rate_usd_disclosed: DisclosedDollarValue | null;
  recent_run_rate_usd_disclosed: DisclosedDollarValue | null;
  change_pct: number;
  spike_detected: boolean;
  spike_at_ts?: number;
  peak_bytes: number;
  peak_bytes_display: string;
  low_bytes: number;
  low_bytes_display: string;
  sample_count: number;
  rate_source: 'list_price' | 'customer_supplied' | 'unset';
  // PL-12b — engine-decision cohort surface. `include` echoes the param
  // so an agent reading the envelope knows which cohort `time_series`
  // and `total_bytes` describe. The `kept_*` / `dropped_*` fields are
  // populated only when `include === 'both'` (dual-query path); when
  // `include === 'kept'` they are null; when `include === 'dropped'`
  // `dropped_*` mirror the main fields and `kept_*` are null.
  include: 'kept' | 'dropped' | 'both';
  kept_bytes_total: number | null;
  dropped_bytes_total: number | null;
  dropped_share_pct: number | null;
  dropped_time_series: Array<{ ts: number; bytes: number }> | null;
}

export async function executeTrend(
  args: { pattern?: string; pattern_hash?: string; timeRange?: string; step?: string; analyzerCost?: number; view?: 'summary'; include?: 'kept' | 'dropped' | 'both'; include_chart?: boolean },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const telemetry = newTelemetry();
  const chassisTelemetry = newChassisTelemetry();

  // Validate: at least one of pattern / pattern_hash must be provided.
  if (!args.pattern && !args.pattern_hash) {
    const headline = 'pattern_trend: provide either pattern (name) or pattern_hash.';
    return buildChassisEnvelope({
      tool: 'log10x_pattern_trend',
      view: 'summary',
      headline,
      status: 'error',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      // bytes_source is TSDB for all trend queries; known even before the
      // query runs so we carry it on validation-error envelopes too.
      source_disclosure: { bytes_source: 'tsdb' },
      scope: { window: 'unknown', window_basis: 'auto_default' },
      payload: { ...buildUnifiedFields({ status: 'insufficient_data', telemetry, humanSummary: headline }) },
      human_summary: headline,
      error: {
        error_type: 'missing_identifier',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'Pass pattern (Symbol Message name) or pattern_hash (11-char tenx_hash from top_patterns).',
      },
      telemetry: chassisTelemetry,
    });
  }

  // Resolve pattern name from hash when only pattern_hash is given.
  // We need a name for the PromQL query (pattern label selector).
  // Also capture the resolved hash for catalog-identity-handoff so the
  // summary can echo it on both the name-input and hash-input paths.
  let patternName: string | undefined = args.pattern;
  let resolvedHash: string | undefined = args.pattern_hash;
  if (!patternName && args.pattern_hash) {
    // Reverse-lookup: find the most-emitting pattern label for this hash.
    const metricsEnv = await resolveMetricsEnv(env).catch(() => null);
    if (metricsEnv) {
      try {
        const q =
          `topk(1, sum by (${LABELS.pattern}) (increase(all_events_summaryBytes_total{` +
          `${LABELS.hash}="${args.pattern_hash.replace(/"/g, '\\"')}",` +
          `${LABELS.env}="${metricsEnv}"}[7d])))`;
        const res = await queryInstant(env, q);
        recordQuery(chassisTelemetry);
        if (res.status === 'success' && res.data.result.length > 0) {
          patternName = res.data.result[0].metric[LABELS.pattern];
        }
      } catch {
        // fall through — pattern stays undefined, inner fn will return no data
      }
    }
  } else if (patternName && !resolvedHash) {
    // Name-input path: forward-lookup the stable hash so the summary can
    // echo it for downstream chain steps (event_lookup, pattern_examples).
    try {
      resolvedHash = await resolvePatternHashFromMetrics(env, normalizePattern(patternName));
      recordQuery(chassisTelemetry);
    } catch {
      // Hash resolution is best-effort; absent hash collapses to '' in summary.
    }
  }

  // Normalise '1d' legacy alias to '24h' before passing to inner.
  const normalizedTimeRange = args.timeRange === '1d' ? '24h' : args.timeRange;
  const effectiveWindow = normalizedTimeRange ?? args.timeRange ?? '7d';

  const sumOut: { data?: PatternTrendSummary } = {};
  await executeTrendInner({ ...args, pattern: patternName ?? '', timeRange: normalizedTimeRange, pattern_hash: resolvedHash }, env, sumOut);
  recordQuery(chassisTelemetry);

  if (!sumOut.data) {
    const id = patternName ?? args.pattern_hash ?? '(unknown)';
    const headline = `No trend data available for \`${id}\` in this environment.`;
    return buildChassisEnvelope({
      tool: 'log10x_pattern_trend',
      view: 'summary',
      headline,
      status: 'no_signal',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: { bytes_source: 'tsdb' },
      scope: { window: effectiveWindow, window_basis: 'explicit' },
      payload: { ...buildUnifiedFields({ status: 'insufficient_data', telemetry, humanSummary: headline }) },
      human_summary: headline,
      telemetry: chassisTelemetry,
    });
  }
  const d = sumOut.data;
  // Percent-first headline. Bytes/change lead;
  // the measured-spend clause is gated on `rate_source !== 'unset'` so we
  // never print a $1.0/GB lie. When unset, suffix "(rate unset)" so the
  // agent knows why the dollar number is missing.
  // PL-12b: headline branches on `include`. `kept` keeps the prior wording.
  // `dropped` re-titles to "offloaded" so the reader sees that the bytes
  // describe the cohort the engine flagged. `both` adds the offload-share %.
  const changeSign = d.change_pct >= 0 ? '+' : '';
  // Dollar-discipline: read the disclosed mirror; drop the inline
  // `(at ${rate_source})` suffix (disclosure tail carries it for
  // list_price; customer_supplied has disclosure=null by design).
  const dollarClause =
    d.rate_source !== 'unset' && d.total_cost_usd_disclosed !== null
      ? `, ${fmtDisclosedDollar(d.total_cost_usd_disclosed)} measured spend`
      : ', (rate unset)';
  const spikeClause = d.spike_detected ? ', spike detected' : '';
  let headline: string;
  //   (1) Pattern name was embedded as a raw underscored blob; the
  //       no-hash-in-headlines rule applies. Replaced with an
  //       underscores-to-spaces hint, same shape as the other dollar tools.
  //   (2) "Currently offloaded" mislabels generic routeState="drop" bytes as
  //       offload-specific; same fix shape as top_patterns. Replaced with
  //       action-neutral "currently reduced".
  //   (3) "<pattern> offloaded over <window>" on include='dropped' headline:
  //       same offload-overreach; cohort is generic routeState="drop", not
  //       offload-specific. Renamed to "<pattern> reduced cohort
  //       over <window>".
  // Uses shared formatPatternLabel helper with 60-char cap. pattern_trend
  // has no services[] context (single-pattern view), so we lean on the
  // symbol_message as the only signal.
  const shortPattern = formatPatternLabel({
    symbol_message: d.pattern,
    maxHintChars: 60,
  });
  if (d.include === 'dropped') {
    headline = `\`${shortPattern}\` reduced cohort over ${d.window}: ${fmtBytes(d.total_bytes)} dropped, change ${changeSign}${d.change_pct}%${dollarClause}${spikeClause}`;
  } else if (d.include === 'both' && d.dropped_share_pct !== null) {
    const sharePct = Math.round(d.dropped_share_pct);
    headline = `\`${shortPattern}\` over ${d.window}: ${fmtBytes(d.total_bytes)} union, ${sharePct}% currently reduced, change ${changeSign}${d.change_pct}%${dollarClause}${spikeClause}`;
  } else {
    headline = `\`${shortPattern}\` over ${d.window}: ${fmtBytes(d.total_bytes)}, change ${changeSign}${d.change_pct}% (last quarter vs first quarter run-rate)${dollarClause}${spikeClause}`;
  }
  // FIX 1 — Gate chart PNG behind include_chart opt-in (default false) to
  // avoid consuming response-token budget on every call.
  let images: import('../lib/output-types.js').InlineImage[] | undefined;
  if (args.include_chart === true) {
  try {
    const { renderTimeseries } = await import('../lib/chart-renderer.js');
    const points = d.time_series.map((p) => ({
      t: new Date(p.ts * 1000).toISOString().replace('T', ' ').slice(0, 16),
      value: p.bytes,
    }));
    const png = await renderTimeseries(points, {
      title: `${d.pattern} — bytes/sec over ${d.window}`,
      yLabel: 'bytes/sec',
      lineColor: d.spike_detected ? '#ef4444' : '#1e88e5',
    });
    if (png) {
      images = [{ data: png.base64, mimeType: png.mimeType, alt: `Timeseries chart of ${d.pattern} over ${d.window}` }];
    }
  } catch (_e) {
    /* chart rendering is best-effort; never block tool execution */
  }
  } // end include_chart gate

  // Spike-detect threshold disclosure for decisions block.
  const spikeThresholdInfo = d.spike_detected
    ? { threshold_used: 3.0, threshold_basis: 'default' as const }
    : { threshold_used: null, threshold_basis: 'default' as const };

  const rateSourceForChassis = d.rate_source === 'customer_supplied'
    ? 'customer_supplied' as const
    : d.rate_source === 'list_price'
      ? 'list_price' as const
      : 'none' as const;

  const human_summary = `${d.pattern} over ${d.window}: ${fmtBytes(d.total_bytes)} volume, change ${changeSign}${d.change_pct}%.` +
    (d.spike_detected ? ' Spike detected.' : '') +
    (d.dropped_share_pct !== null ? ` ${Math.round(d.dropped_share_pct)}% offloaded.` : '');

  // ── must_render_verbatim ─────────────────────────────────────────
  // render_hint.chart === 'timeseries' tells downstream renderers the
  // envelope wants a chart. The chassis path was emitting that hint but
  // no actual chart bytes — the host had to either re-render or fall
  // back to JSON. Plumb the same ASCII lineChart the markdown body
  // already produces into must_render_verbatim so the chart is the
  // tool's primary visual artifact.
  //
  // The chart is built off `d.time_series` (already bucketed by the
  // auto-step path). lineChart's y-axis labels are per-hour rates, so we
  // feed it bytes-per-second (divide by step seconds) — identical to the
  // legacy markdown body's prep step, kept consistent here.
  const tfForChart = parseTimeframe(d.window);
  const stepSecondsForChart = (() => {
    const m = d.step.match(/^(\d+)(m|h|d)$/);
    if (!m) return 3600;
    const v = parseInt(m[1], 10);
    return m[2] === 'm' ? v * 60 : m[2] === 'h' ? v * 3600 : v * 86400;
  })();
  const chartLines: string[] = [];
  // Headline at top so the chart block is self-contained when a host
  // renders must_render_verbatim verbatim (no JSON context around it).
  chartLines.push(headline);
  if (d.time_series.length > 0) {
    const rates = d.time_series.map((p) => p.bytes / stepSecondsForChart);
    const chart = lineChart(rates, { widthCap: 60, spanSeconds: tfForChart.days * 86400 });
    if (chart) {
      chartLines.push('');
      chartLines.push('```text');
      chartLines.push(chart);
      chartLines.push('```');
      chartLines.push(`${d.time_series.length} samples @ ${d.step}`);
    }
  }
  const mustRenderVerbatim = chartLines.join('\n');

  // ── actions[] ────────────────────────────────────────────────────
  // pattern_trend is the volume/time-axis view. The slot/content angle
  // lives in pattern_examples (no slot data here; route to
  // pattern_examples for it). Always include the
  // examples handoff so an agent reading a trend envelope has a clear
  // next step for the content question.
  const trendActions: import('../lib/output-types.js').Action[] = [];
  if (d.pattern_hash) {
    trendActions.push({
      tool: 'log10x_pattern_examples',
      args: { pattern_hash: d.pattern_hash },
      reason: "content/slot angle — real events + slot variations for this pattern (the WHAT to pair with trend's WHEN)",
      role: 'recommended-next',
    });
  } else if (d.pattern) {
    // Fall-back when hash resolution missed (no_signal path) — still
    // give the agent a routable handoff using the pattern name.
    trendActions.push({
      tool: 'log10x_pattern_examples',
      args: { pattern: d.pattern },
      reason: "content/slot angle — real events + slot variations for this pattern (the WHAT to pair with trend's WHEN)",
      role: 'recommended-next',
    });
  }

  return buildChassisEnvelope({
    tool: 'log10x_pattern_trend',
    view: 'summary',
    headline,
    status: d.total_bytes > 0 ? 'success' : 'no_signal',
    decisions: {
      threshold_used: spikeThresholdInfo.threshold_used,
      threshold_basis: spikeThresholdInfo.threshold_basis,
    },
    source_disclosure: {
      bytes_source: 'tsdb',
      rate_source: rateSourceForChassis,
      siem_vendor: undefined,
    },
    scope: {
      window: d.window,
      window_basis: 'explicit',
    },
    payload: { ...d, ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }) },
    human_summary,
    must_render_verbatim: mustRenderVerbatim,
    actions: trendActions,
    render_hint: { chart: 'timeseries', units: 'bytes/sec' },
    images,
    telemetry: chassisTelemetry,
  });
}

async function executeTrendInner(
  args: { pattern: string; pattern_hash?: string; timeRange?: string; step?: string; analyzerCost?: number; include?: 'kept' | 'dropped' | 'both' },
  env: EnvConfig,
  sumOut?: { data?: PatternTrendSummary }
): Promise<string> {
  // Defensive defaults — match trendSchema.
  // Normalise '1d' legacy alias → '24h'.
  const timeRange = (args.timeRange === '1d' ? '24h' : args.timeRange) ?? '7d';
  // Auto-step: when the caller passes `'auto'` (the schema default) we
  // pick a step that yields ~12–30 buckets per window. A coarse step
  // (e.g. `1h` on a `1h` window) produces a 2-point series with no
  // usable trend shape.
  const requestedStep = args.step ?? 'auto';
  const step = requestedStep === 'auto' ? pql.autoStepForWindow(timeRange) : requestedStep;
  const include = args.include ?? 'kept';
  const tf = parseTimeframe(timeRange);
  // DEP: feat/x-percent-mcp-cost-tooling — drop the silent `?? 1.0` lie.
  // When the caller provides an explicit $/GB via `analyzerCost`, the dollar
  // axis is 'customer_supplied'. Otherwise it is 'unset' and every dollar
  // field collapses to `null` (never 0, never 1). No list-price fallback
  // here: trend has no destination-cost-model handle and no
  // log10x_savings-style profile read. The headline + markdown render
  // gate every dollar string on `rate_source !== 'unset'`.
  const rateSource: 'customer_supplied' | 'unset' =
    typeof args.analyzerCost === 'number' ? 'customer_supplied' : 'unset';
  const costPerGb: number | null =
    rateSource === 'customer_supplied' ? (args.analyzerCost as number) : null;
  const period = costPeriodLabel(tf.days);
  const metricsEnv = await resolveMetricsEnv(env);

  // Reporter pattern labels are always snake_case. Normalize in case an
  // agent re-fed a display form from top_patterns / cost_drivers.
  const pattern = normalizePattern(args.pattern);

  const now = Math.floor(Date.now() / 1000);
  const start = now - tf.days * 86400;
  const stepSeconds = parseStep(step);

  // PL-12b — engine-decision cohort scope. patternBytesOverTime doesn't
  // take a selector map (the pattern selector is inlined), so we splice
  // the `routeState` label into the existing `{...}` selector via
  // string replace. `kept` uses the absence-tolerant `!=` form so legacy
  // series without the label still match. `dropped` uses exact `=`.
  // `both` runs two queries in parallel: the union (no `routeState`
  // selector) AND the dropped slice, joined by timestamp downstream.
  const { droppedFilter, runBoth } = pql.includeToSelector(include);
  const baseQuery = pql.patternBytesOverTime(pattern, metricsEnv, step);
  const spliceRouteState = (q: string, op: '=' | '!=', val: string) =>
    q.replace(/\}\[/, `,routeState${op}"${val}"}[`);
  // `includeToSelector` only returns the object form (never a raw string)
  // for `kept`/`dropped`, so narrow with a type guard the compiler accepts.
  let primaryQuery: string;
  if (droppedFilter !== null && typeof droppedFilter !== 'string') {
    primaryQuery = spliceRouteState(baseQuery, droppedFilter.op, droppedFilter.val);
  } else {
    primaryQuery = baseQuery;
  }
  const droppedQuery = runBoth ? spliceRouteState(baseQuery, '=', 'drop') : null;
  const [res, droppedRes] = await Promise.all([
    queryRange(env, primaryQuery, start, now, stepSeconds),
    droppedQuery
      ? queryRange(env, droppedQuery, start, now, stepSeconds).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (res.status !== 'success' || res.data.result.length === 0) {
    return `No trend data for pattern "${pattern}" in the ${tf.label}.`;
  }

  // Extract time series
  const series = res.data.result[0];
  const points: { ts: number; bytes: number }[] = [];
  for (const [ts, val] of (series.values || [])) {
    points.push({ ts, bytes: parseFloat(val) || 0 });
  }

  if (points.length === 0) {
    return `No data points for pattern "${pattern}".`;
  }

  // PL-12b — extract the dropped-cohort series when `include === 'both'`.
  // When `include === 'dropped'`, the primary series already IS the
  // dropped slice; we mirror it into `droppedPoints` so the envelope's
  // `dropped_time_series` is populated and downstream callers don't have
  // to special-case the include value.
  let droppedPoints: { ts: number; bytes: number }[] | null = null;
  let droppedBytesTotal: number | null = null;
  if (include === 'both' && droppedRes && droppedRes.status === 'success' && droppedRes.data.result.length > 0) {
    droppedPoints = [];
    for (const [ts, val] of (droppedRes.data.result[0].values || [])) {
      droppedPoints.push({ ts, bytes: parseFloat(val) || 0 });
    }
    droppedBytesTotal = droppedPoints.reduce((s, p) => s + p.bytes, 0);
  } else if (include === 'both') {
    // Both requested but dropped query returned nothing — treat as zero
    // offload (the union is fully `kept`).
    droppedPoints = [];
    droppedBytesTotal = 0;
  }

  // Compute stats
  const totalBytes = points.reduce((s, p) => s + p.bytes, 0);
  // Dollar axes are null when `rate_source === 'unset'`. Every downstream
  // print gates on this — naive `${totalCost}` interpolation would emit
  // `$null`, which we explicitly avoid via the gated headline/body.
  const totalCost: number | null =
    costPerGb !== null ? bytesToCost(totalBytes, costPerGb) : null;
  const avgBytes = totalBytes / points.length;
  const maxPoint = points.reduce((max, p) => p.bytes > max.bytes ? p : max, points[0]);
  const minPoint = points.reduce((min, p) => p.bytes < min.bytes ? p : min, points[0]);

  // Detect spike: a point > 3x average that appears AFTER the first quarter
  // (so the spike is not the baseline itself, which would produce a spurious
  // "spike detected" + "stable/decreasing" contradiction).
  const spikeThreshold = avgBytes * 3;
  const firstQuarterEnd = Math.floor(points.length / 4);
  const spikePoint = points.slice(firstQuarterEnd).find(p => p.bytes > spikeThreshold);

  // Baseline: first quarter of points
  const baselineSlice = points.slice(0, Math.max(1, Math.floor(points.length / 4)));
  const baselineAvg = baselineSlice.reduce((s, p) => s + p.bytes, 0) / baselineSlice.length;
  const baselineBytes = baselineAvg * (tf.days * 86400 / stepSeconds);
  const baselineCost: number | null =
    costPerGb !== null ? bytesToCost(baselineBytes, costPerGb) : null;

  // Current: last quarter of points
  const recentSlice = points.slice(-Math.max(1, Math.floor(points.length / 4)));
  const recentAvg = recentSlice.reduce((s, p) => s + p.bytes, 0) / recentSlice.length;
  const recentBytes = recentAvg * (tf.days * 86400 / stepSeconds);
  const recentCost: number | null =
    costPerGb !== null ? bytesToCost(recentBytes, costPerGb) : null;

  // Report the MEASURED change as a signed
  // delta + the two quarter run-rates, NOT an asserted RISING/FALLING/STABLE
  // label. The fine time series is trend's differentiated context; the
  // asserted trend word competed with the agent's live judgment and read as
  // a verdict to distrust. The reader sees the % + the curve and judges
  // direction. Three $ numbers confused readers before: `total` is the
  // ACTUAL cost over the window; baseline/current are PROJECTED run-rates
  // from the first/last quarter (used only to gauge direction). "quarter" =
  // first/last 25% of the time window (not calendar Q).
  // Percent direction is bytes-driven so it works whether or not a $/GB rate
  // was supplied (cost is a linear function of bytes when set, so the
  // bytes-ratio percent equals the dollar-ratio percent to the rounding
  // precision we report).
  let pct = 0;
  if (baselineBytes > 0) {
    pct = Math.round(((recentBytes - baselineBytes) / baselineBytes) * 100);
  }
  const changeStr =
    baselineBytes > 0
      ? `${pct >= 0 ? '+' : ''}${pct}% (last quarter vs first quarter run-rate)`
      : '(no first-quarter baseline to compare against)';

  // Populate typed summary for view='summary' callers.
  // PL-12b — fill the cohort fields per the include semantics:
  //   kept     → dropped_* are null, kept_bytes_total = total_bytes
  //   dropped  → kept_* null, dropped_* mirror the primary series
  //   both     → both populated, dropped_share_pct = dropped / union
  let keptBytesTotal: number | null;
  let droppedBytesTotalOut: number | null;
  let droppedSharePct: number | null;
  let droppedTimeSeriesOut: Array<{ ts: number; bytes: number }> | null;
  if (include === 'kept') {
    keptBytesTotal = totalBytes;
    droppedBytesTotalOut = null;
    droppedSharePct = null;
    droppedTimeSeriesOut = null;
  } else if (include === 'dropped') {
    keptBytesTotal = null;
    droppedBytesTotalOut = totalBytes;
    droppedSharePct = totalBytes > 0 ? 100 : null;
    droppedTimeSeriesOut = points;
  } else {
    // include === 'both' — droppedBytesTotal was computed above (defaults
    // to 0 when the dropped query was empty). The union is in totalBytes.
    droppedBytesTotalOut = droppedBytesTotal ?? 0;
    keptBytesTotal = Math.max(0, totalBytes - droppedBytesTotalOut);
    droppedSharePct =
      totalBytes > 0 ? (droppedBytesTotalOut / totalBytes) * 100 : null;
    droppedTimeSeriesOut = droppedPoints ?? [];
  }

  // Dollar-discipline migration: build the disclosed-value mirrors here so
  // renderers consume `*_disclosed` via `fmtDisclosedDollar` instead of bare
  // numbers + ad-hoc "(at X)" suffixes. trend has NO destination context
  // (see the rateSource comment above), so siemLabel is null and the
  // listRatePerGb argument is null too — the only non-unset path here is
  // `customer_supplied`, whose disclosure is null by design. The
  // `rate_source === 'unset'` branch collapses every mirror to null.
  const toAxisSource = rateSource;
  const totalCostDisclosed: DisclosedDollarValue | null =
    totalCost !== null ? buildDisclosedDollarValue(totalCost, toAxisSource, null, null) : null;
  const baselineCostDisclosed: DisclosedDollarValue | null =
    baselineCost !== null ? buildDisclosedDollarValue(baselineCost, toAxisSource, null, null) : null;
  const recentCostDisclosed: DisclosedDollarValue | null =
    recentCost !== null ? buildDisclosedDollarValue(recentCost, toAxisSource, null, null) : null;

  // Catalog-identity-handoff: echo the stable tenx_hash on the summary so
  // chained tools (event_lookup, pattern_examples) don't re-resolve it.
  // Prefer the caller-supplied hash (forward- or reverse-resolved in
  // executeTrend); fall back to an inner resolve, then to '' on miss.
  let summaryHash = args.pattern_hash ?? '';
  if (!summaryHash) {
    const resolved = await resolvePatternHashFromMetrics(env, pattern).catch(() => undefined);
    summaryHash = resolved ?? '';
  }

  if (sumOut) {
    const stepSecs = stepSeconds;
    sumOut.data = {
      pattern,
      pattern_hash: summaryHash,
      window: tf.label,
      step,
      time_series: points,
      total_bytes: totalBytes,
      total_bytes_display: fmtBytes(totalBytes),
      total_cost_usd: totalCost,
      baseline_run_rate_usd: baselineCost,
      recent_run_rate_usd: recentCost,
      total_cost_usd_disclosed: totalCostDisclosed,
      baseline_run_rate_usd_disclosed: baselineCostDisclosed,
      recent_run_rate_usd_disclosed: recentCostDisclosed,
      change_pct: pct,
      spike_detected: !!spikePoint,
      spike_at_ts: spikePoint?.ts,
      peak_bytes: maxPoint.bytes,
      peak_bytes_display: fmtBytes(maxPoint.bytes),
      low_bytes: minPoint.bytes,
      low_bytes_display: fmtBytes(minPoint.bytes),
      sample_count: points.length,
      rate_source: rateSource,
      include,
      kept_bytes_total: keptBytesTotal,
      dropped_bytes_total: droppedBytesTotalOut,
      dropped_share_pct: droppedSharePct,
      dropped_time_series: droppedTimeSeriesOut,
    };
    void stepSecs;
  }

  const lines: string[] = [];
  // Description-first headline (shared patternDisplay): a readable
  // description, not the raw token. trend fetches no sample, so this is the
  // algorithmic token descriptor; the exact pattern id stays in the
  // agent-only next-action hints below for chaining.
  // PL-12b — title prefix when the trend describes the offload cohort, so
  // a human reader sees the framing without having to read the param.
  const titlePrefix = include === 'dropped' ? '[OFFLOADED] ' : '';
  lines.push(`${titlePrefix}${patternDisplay(pattern).title} · trend over ${tf.label}`);
  lines.push(`Change over ${tf.label}: ${changeStr}${spikePoint ? `; peak ${(maxPoint.bytes / avgBytes).toFixed(1)}× the window average at ${formatTimestamp(spikePoint.ts)}` : ''}`);
  lines.push('');
  // Bytes-first body. Dollar lines are gated on `rate_source !== 'unset'`
  // (mirrors the headline rule). When unset we still show the volume
  // direction check in bytes so the reader has a usable comparison.
  lines.push(`  Measured volume over ${tf.label}: ${fmtBytes(totalBytes)}  (${points.length} samples @ ${step})`);
  // PL-12b — one-line offload share callout. Only emitted on the `both`
  // path so the default (kept) markdown is byte-identical to today, and
  // the `dropped` path doesn't tautologically print "100%".
  if (include === 'both' && droppedSharePct !== null && droppedBytesTotalOut !== null) {
    lines.push(`  Currently offloaded: ${fmtBytes(droppedBytesTotalOut)} (${Math.round(droppedSharePct)}% of union)`);
  }
  if (rateSource !== 'unset' && totalCostDisclosed !== null) {
    // Dollar-discipline: use the disclosed mirror; drop the inline
    // `(at ${rateSource})` suffix — disclosure tail covers it.
    lines.push(`  Measured spend over ${tf.label}: ${fmtDisclosedDollar(totalCostDisclosed)}`);
  }
  lines.push(`  Direction check (extrapolated run-rate, NOT the bill, used only to gauge direction):`);
  if (rateSource !== 'unset' && baselineCostDisclosed !== null && recentCostDisclosed !== null) {
    lines.push(`    first quarter ~${fmtDisclosedDollar(baselineCostDisclosed)}${period}  ->  last quarter ${fmtDisclosedDollar(recentCostDisclosed)}${period}`);
    lines.push(`  _The two numbers differ on purpose: the first is the actual spend over the window; the run-rates annualize each quarter's average rate to judge rising/falling, so they will not equal the measured spend._`);
  } else {
    lines.push(`    first quarter ~${fmtBytes(baselineBytes)}${period}  ->  last quarter ${fmtBytes(recentBytes)}${period}`);
    lines.push(`  _Run-rates are bytes annualized from each quarter's average rate, used only to gauge direction. Pass \`analyzerCost\` to overlay $/period._`);
  }
  lines.push(`  Peak ${fmtBytes(maxPoint.bytes)} @ ${formatTimestamp(maxPoint.ts)} · Low ${fmtBytes(minPoint.bytes)} @ ${formatTimestamp(minPoint.ts)}`);

  // Big line chart (the same one top_patterns uses). trend is a focused
  // single-pattern view, so it gets the full labeled chart, not a compact
  // sparkline — consistent chart strategy across the MCP.
  // lineChart labels its y-axis as a per-hour rate, so it expects
  // bytes-PER-SECOND values (what top_patterns feeds it). trend's points are
  // bytes per `stepSeconds` bucket, so divide to get the rate — otherwise the
  // axis reads ~stepSeconds× too high (e.g. "23608 MB/h" for a 6.6 MB peak).
  const chart = lineChart(points.map((p) => p.bytes / stepSeconds), { widthCap: 60, spanSeconds: tf.days * 86400 });
  if (chart) {
    lines.push('');
    lines.push('**Volume trend**');
    lines.push('```text');
    lines.push(chart);
    lines.push('```');
  }

  // next_action hints — prose for human readers, structured NEXT_ACTIONS
  // block for autonomous-chain agents. Spike or sustained drift → suggest
  // investigate. Always recommend dependency_check before any mute action.
  // Bytes-driven thresholds so spike/drift suggestions fire under
  // rate_source='unset' too (the dollar values are a linear function of
  // bytes when set, so the ratios are equivalent).
  const elevated = baselineBytes > 0 && recentBytes > baselineBytes * 1.5;
  const sustainedSlope = baselineBytes > 0 && recentBytes > baselineBytes * 1.2 && !spikePoint;
  const nextActions: NextAction[] = [];
  if (spikePoint || elevated) {
    lines.push('');
    lines.push(agentOnly(
      `Inflection or spike detected. Suggested next calls: ` +
      `Trace the cause — log10x_investigate({ starting_point: '${pattern}', window: '${timeRange}' }). ` +
      `Find which customer metrics moved with the spike — log10x_metrics_that_moved({ anchor_type: 'log10x_pattern', anchor: '${pattern}', window: '${timeRange}' }), then rank with log10x_rank_by_shape_similarity and overlay with log10x_metric_overlay.`
    ));
    nextActions.push({
      tool: 'log10x_investigate',
      args: { starting_point: pattern, window: timeRange },
      reason: spikePoint ? 'spike detected — trace the cause' : 'elevated vs baseline — trace the cause',
    });
    nextActions.push({
      tool: 'log10x_metrics_that_moved',
      args: { anchor_type: 'log10x_pattern', anchor: pattern, window: timeRange },
      reason: 'first composition step: deterministic filter on which customer metrics actually moved with the spike',
    });
  } else if (sustainedSlope) {
    lines.push('');
    lines.push(agentOnly(
      `Gradual drift (no discrete inflection). Suggested next call: ` +
      `log10x_investigate({ starting_point: '${pattern}', window: '30d' }) for slope-similarity cohort analysis and historical investigation guidance.`
    ));
    nextActions.push({
      tool: 'log10x_investigate',
      args: { starting_point: pattern, window: '30d' },
      reason: 'gradual drift — slope-similarity cohort analysis',
    });
  }
  // Always offer baseline next steps — even a STABLE trend is not a
  // dead end: the SRE still wants the full cost/services breakdown and
  // the reduce-cost menu. Without this the tool ended with nothing to
  // do next (the discoverability gap a cold review flagged).
  nextActions.push({
    tool: 'log10x_event_lookup',
    args: { pattern },
    reason: 'full per-service cost breakdown and a real sample for this pattern',
  });
  nextActions.push({
    tool: 'log10x_pattern_mitigate',
    args: { pattern },
    reason: 'env-gated mitigation options + exact configs for this pattern',
  });

  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);
  return lines.join('\n');
}

function parseStep(step: string): number {
  const match = step.match(/^(\d+)(m|h|d)$/);
  if (!match) return 3600;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case 'm': return val * 60;
    case 'h': return val * 3600;
    case 'd': return val * 86400;
    default: return 3600;
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
