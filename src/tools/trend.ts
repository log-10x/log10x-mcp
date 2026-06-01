/**
 * log10x_pattern_trend — volume trend for a specific pattern over time.
 *
 * Shows time series data with spike detection.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryRange } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { bytesToCost } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { fmtDollar, fmtPattern, fmtBytes, parseTimeframe, costPeriodLabel, normalizePattern } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { lineChart } from '../lib/line-chart.js';
import { patternDisplay } from '../lib/pattern-descriptor.js';
import { buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';

export const trendSchema = {
  pattern: z.string().describe('Pattern name (e.g., "Payment_Gateway_Timeout")'),
  timeRange: z.enum(['15m', '1h', '6h', '1d', '7d', '30d']).default('7d').describe('Time range. Sub-day values show fine-grained trajectory around an incident.'),
  step: z.enum(['1m', '5m', '15m', '1h', '6h', '1d']).default('1h').describe('Data point interval. Use `1m`/`5m` for sub-day windows (15m/1h/6h), `1h`/`6h` for day-level, `1d` for week+ windows.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB'),
  environment: z.string().optional().describe('Environment nickname'),
  view: z.enum(['summary', 'markdown']).default('summary').describe('Output format. summary returns structured envelope; markdown returns rendered chart + stats.'),
  // DEP: feat/x-percent-mcp-cost-tooling — added per
  //   /tmp/poc-comparison/14d-24-implementation-spec.md (item 8).
  // feat/investigative-sharpening also touches this file; the addition
  // is strictly additive (new optional flag, inline label suffix on the
  // single range query) so the merge stays clean. When false/absent,
  // the PromQL emitted is byte-identical to the pre-change query — the
  // verify-mode caller in estimate-savings.ts sets it true to read the
  // engine-side "what would have been dropped" per-pattern byte series
  // over time (i.e. the overflow cohort).
  isDropped: z
    .boolean()
    .optional()
    .describe(
      'When true, scope the trend to events tagged isDropped="true" by the engine — i.e. the per-pattern overflow byte series over time (the cohort the regulator marked for drop/down-tier). Use to verify post-deploy realised savings. When absent/false, behavior is unchanged.'
    ),
};

interface PatternTrendSummary {
  pattern: string;
  window: string;
  step: string;
  time_series: Array<{ ts: number; bytes: number }>;
  total_bytes: number;
  // DEP: feat/x-percent-mcp-cost-tooling — dollar fields are now null when
  // no rate is set (no `?? 1.0` lie). `rate_source` advertises the axis the
  // dollar columns were computed against ('list_price' | 'customer_supplied'
  // | 'unset'). Headline + markdown body lead with bytes/percent and gate
  // the dollar clause on `rate_source !== 'unset'`.
  total_cost_usd: number | null;
  baseline_run_rate_usd: number | null;
  recent_run_rate_usd: number | null;
  change_pct: number;
  spike_detected: boolean;
  spike_at_ts?: number;
  peak_bytes: number;
  low_bytes: number;
  sample_count: number;
  rate_source: 'list_price' | 'customer_supplied' | 'unset';
}

export async function executeTrend(
  args: { pattern: string; timeRange?: string; step?: string; analyzerCost?: number; view?: 'summary' | 'markdown'; isDropped?: boolean },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const telemetry = newTelemetry();
  const sumOut: { data?: PatternTrendSummary } = {};
  const md = await executeTrendInner(args, env, sumOut);
  if (view === 'markdown' || !sumOut.data) {
    return buildMarkdownEnvelope({
      tool: 'log10x_pattern_trend',
      summary: { headline: md.split('\n')[0]?.slice(0, 200) || 'pattern_trend result' },
      markdown: md,
    });
  }
  const d = sumOut.data;
  // Percent-first headline (TOOL-AUDIT cost-honesty pass). Bytes/change lead;
  // the measured-spend clause is gated on `rate_source !== 'unset'` so we
  // never print a $1.0/GB lie. When unset, suffix "(rate unset)" so the
  // agent knows why the dollar number is missing.
  const changeSign = d.change_pct >= 0 ? '+' : '';
  const dollarClause =
    d.rate_source !== 'unset' && d.total_cost_usd !== null
      ? `, ${fmtDollar(d.total_cost_usd)} measured spend (at ${d.rate_source})`
      : ', (rate unset)';
  const headline = `\`${d.pattern}\` over ${d.window}: ${fmtBytes(d.total_bytes)}, change ${changeSign}${d.change_pct}% (last quarter vs first quarter run-rate)${dollarClause}${d.spike_detected ? ', spike detected' : ''}`;
  const { buildEnvelope } = await import('../lib/output-types.js');
  // G6: render a PNG timeseries chart of the trend so hosts that render
  // image content (Claude Desktop, ChatGPT Desktop) show it visually. The
  // chart is best-effort — if chart.js init fails (e.g. missing Cairo on
  // Linux) the renderer returns null and the result drops back to JSON
  // envelope + ASCII sparkline only.
  let images: import('../lib/output-types.js').InlineImage[] | undefined;
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
  return buildEnvelope({
    tool: 'log10x_pattern_trend',
    view: 'summary',
    summary: { headline },
    data: { ...d, ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }) },
    render_hint: { chart: 'timeseries', units: 'bytes/sec' },
    images,
  });
}

async function executeTrendInner(
  args: { pattern: string; timeRange?: string; step?: string; analyzerCost?: number; isDropped?: boolean },
  env: EnvConfig,
  sumOut?: { data?: PatternTrendSummary }
): Promise<string> {
  // Defensive defaults — match trendSchema.
  const timeRange = args.timeRange ?? '7d';
  const step = args.step ?? '1h';
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

  // DEP: feat/x-percent-mcp-cost-tooling — additive isDropped scope.
  // patternBytesOverTime doesn't take a selector map (single inline
  // pattern selector), so when isDropped=true we splice the label into
  // the existing `{...}` selector inline — same approach top-patterns
  // uses for its standalone range query (top-patterns.ts:252). When
  // absent/false, the emitted PromQL is byte-identical to before.
  let query = pql.patternBytesOverTime(pattern, metricsEnv, step);
  if (args.isDropped === true) {
    query = query.replace(/\}\[/, `,isDropped="true"}[`);
  }
  const res = await queryRange(env, query, start, now, stepSeconds);

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

  // De-verdict (TOOL-AUDIT Phase 2): report the MEASURED change as a signed
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
  if (sumOut) {
    const stepSecs = stepSeconds;
    sumOut.data = {
      pattern,
      window: tf.label,
      step,
      time_series: points,
      total_bytes: totalBytes,
      total_cost_usd: totalCost,
      baseline_run_rate_usd: baselineCost,
      recent_run_rate_usd: recentCost,
      change_pct: pct,
      spike_detected: !!spikePoint,
      spike_at_ts: spikePoint?.ts,
      peak_bytes: maxPoint.bytes,
      low_bytes: minPoint.bytes,
      sample_count: points.length,
      rate_source: rateSource,
    };
    void stepSecs;
  }

  const lines: string[] = [];
  // Description-first headline (shared patternDisplay): a readable
  // description, not the raw token. trend fetches no sample, so this is the
  // algorithmic token descriptor; the exact pattern id stays in the
  // agent-only next-action hints below for chaining.
  lines.push(`${patternDisplay(pattern).title} · trend over ${tf.label}`);
  lines.push(`Change over ${tf.label}: ${changeStr}${spikePoint ? `; peak ${(maxPoint.bytes / avgBytes).toFixed(1)}× the window average at ${formatTimestamp(spikePoint.ts)}` : ''}`);
  lines.push('');
  // Bytes-first body. Dollar lines are gated on `rate_source !== 'unset'`
  // (mirrors the headline rule). When unset we still show the volume
  // direction check in bytes so the reader has a usable comparison.
  lines.push(`  Measured volume over ${tf.label}: ${fmtBytes(totalBytes)}  (${points.length} samples @ ${step})`);
  if (rateSource !== 'unset' && totalCost !== null) {
    lines.push(`  Measured spend over ${tf.label}: ${fmtDollar(totalCost)} (at ${rateSource})`);
  }
  lines.push(`  Direction check (extrapolated run-rate, NOT the bill, used only to gauge direction):`);
  if (rateSource !== 'unset' && baselineCost !== null && recentCost !== null) {
    lines.push(`    first quarter ~${fmtDollar(baselineCost)}${period}  ->  last quarter ${fmtDollar(recentCost)}${period}`);
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
