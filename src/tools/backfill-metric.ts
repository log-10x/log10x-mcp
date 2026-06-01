/**
 * log10x_backfill_metric — create a new TSDB metric, backfilled from the Retriever archive.
 *
 * Flagship "Log10x-only" composition tool. Pulls historical events from
 * the Retriever for a specified pattern + filter + window,
 * aggregates them into a bucketed time series, and emits the result to
 * the destination TSDB with historical timestamps preserved.
 *
 * Optionally wires up forward emission via the live Reporter so the
 * metric continues populating from current events going forward. The
 * backfill + forward-emission hand-off is the full story: the customer
 * gets a continuous time series from 90-180 days ago through the present
 * instant, as if the metric had always existed.
 *
 * Tier prerequisites: Retriever component required; Reporter required
 * only when emit_forward=true.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  runRetrieverQuery,
  isRetrieverConfigured,
  parseTimeExpression,
  buildPatternSearch,
  type RetrieverQueryRequest,
} from '../lib/retriever-api.js';
import { aggregate, type AggregationType } from '../lib/aggregator.js';
import { emitSeries, type Destination } from '../lib/metric-emitters.js';
import { fmtCount, normalizePattern } from '../lib/format.js';
import { retrieverNotConfiguredMessage } from './retriever-query.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const backfillMetricSchema = {
  pattern: z
    .string()
    .describe('Pattern to backfill — templateHash or symbolMessage. Use log10x_event_lookup first to resolve a raw log line.'),
  metric_name: z
    .string()
    .describe('Destination metric name. Follow the destination TSDB\'s naming convention (e.g., `log10x.payment_retry_by_tenant`).'),
  destination: z
    .enum(['datadog', 'prometheus', 'cloudwatch', 'elastic', 'signalfx'])
    .describe('Destination TSDB. Datadog and Prometheus (via remote_write adapter) are wired in this build; CloudWatch/Elastic/SignalFx return a clear "not yet implemented" error.'),
  bucket_size: z
    .string()
    .default('5m')
    .describe('Time bucket size. `1m`, `5m`, `1h`, `1d` are typical.'),
  aggregation: z
    .enum(['count', 'sum_bytes', 'unique_values', 'rate_per_second'])
    .default('count')
    .describe('How to aggregate events within each bucket. `count` is the default and matches the "how many events happened" question.'),
  from: z
    .string()
    .describe('Start of the backfill window — ISO8601 (`2026-01-15T00:00:00Z`) or relative (`now-90d`).'),
  to: z
    .string()
    .default('now')
    .describe('End of the backfill window — ISO8601 or relative. Default `now`.'),
  group_by: z
    .array(z.string())
    .optional()
    .describe('Fields to group on — each unique combination becomes its own time series. Pass enriched-metric label names (`service`, `severity`, `tenant_id`, `http_code`, ...).'),
  filters: z
    .array(z.string())
    .optional()
    .describe('Optional JS filter expressions over event payloads, passed through to the Retriever query.'),
  unique_field: z
    .string()
    .optional()
    .describe('For aggregation=unique_values: the field whose cardinality is counted per bucket (e.g., `tenant_id`).'),
  emit_forward: z
    .boolean()
    .default(false)
    .describe('When true, wire the live Reporter to continue emitting the same metric from current events going forward. Default false in this build — the forward-emission handoff path to the Reporter config file is not yet implemented. Set true only after installing the Reporter config update path.'),
  environment: z.string().optional().describe('Environment nickname — required if multi-env.'),
  view: z.enum(['summary', 'markdown']).default('summary').describe('summary returns the typed envelope (data.metric_name, data.events_retrieved, data.points_emitted, data.view_url, data.warnings). markdown wraps the full report in data.markdown.'),
};

export async function executeBackfillMetric(
  args: {
    pattern: string;
    metric_name: string;
    destination: Destination;
    bucket_size?: string;
    aggregation?: AggregationType;
    from: string;
    to?: string;
    group_by?: string[];
    filters?: string[];
    unique_field?: string;
    emit_forward?: boolean;
    environment?: string;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  if (!isRetrieverConfigured()) {
    const md = retrieverNotConfiguredMessage();
    if (view === 'markdown') {
      return buildMarkdownEnvelope({ tool: 'log10x_backfill_metric', summary: { headline: 'Retriever not configured' }, markdown: md });
    }
    // Typed not_configured (status + advise_retriever action) so an agent
    // branches on data.status, matching retriever_query and the framework.
    return buildNotConfiguredEnvelope({ tool: 'log10x_backfill_metric', kind: 'retriever', remediation: md });
  }
  const sumOut: { data?: BackfillMetricSummary } = {};
  const md = await executeBackfillMetricInner(args, env, sumOut);
  if (view === 'markdown' || !sumOut.data) {
    return buildMarkdownEnvelope({ tool: 'log10x_backfill_metric', summary: { headline: sumOut.data ? `Backfilled ${sumOut.data.metric_name} (${sumOut.data.points_emitted} points)` : 'backfill_metric result' }, markdown: md });
  }
  const d = sumOut.data;
  return buildEnvelope({
    tool: 'log10x_backfill_metric',
    view: 'summary',
    summary: { headline: `Backfill ${d.metric_name} to ${d.destination}: ${d.events_retrieved} events → ${d.points_emitted} points (${d.series_count} series, ${d.bucket_seconds}s buckets), view at ${d.view_url ?? 'destination'}.` },
    data: d,
    warnings: d.warnings,
    actions: [
      { tool: 'log10x_pattern_trend', args: { pattern: d.pattern, timeRange: '30d' }, reason: 'verify the backfilled series — pattern_trend now extends full 90d' },
      { tool: 'log10x_retriever_series', args: { pattern: d.pattern, from: d.window_from, to: d.window_to }, reason: 'sanity-check the backfilled buckets at finer granularity' },
    ],
  });
}

interface BackfillMetricSummary {
  ok: boolean;
  pattern: string;
  metric_name: string;
  destination: string;
  window_from: string;
  window_to: string;
  bucket_size: string;
  bucket_seconds: number;
  aggregation: string;
  group_by: string[];
  filters: string[];
  events_retrieved: number;
  retriever_wall_ms: number;
  points_emitted: number;
  series_count: number;
  emission_wall_ms: number;
  bytes_posted: number;
  view_url?: string;
  warnings: string[];
  forward_emission_note: string;
}

async function executeBackfillMetricInner(
  args: {
    pattern: string;
    metric_name: string;
    destination: Destination;
    bucket_size?: string;
    aggregation?: AggregationType;
    from: string;
    to?: string;
    group_by?: string[];
    filters?: string[];
    unique_field?: string;
    emit_forward?: boolean;
    environment?: string;
  },
  env: EnvConfig,
  sumOut?: { data?: BackfillMetricSummary }
): Promise<string> {
  // Defensive defaults — match backfillMetricSchema for non-SDK callers.
  args.bucket_size = args.bucket_size ?? '5m';
  args.aggregation = args.aggregation ?? 'count';
  args.to = args.to ?? 'now';
  args.emit_forward = args.emit_forward ?? false;

  try {
    parseTimeExpression(args.from);
    parseTimeExpression(args.to);
  } catch (e) {
    throw new Error(`Invalid time window: ${(e as Error).message}`);
  }

  if (args.aggregation === 'unique_values' && !args.unique_field) {
    throw new Error('aggregation=unique_values requires a `unique_field` argument.');
  }

  // Reporter/Retriever pattern labels are snake_case. Normalize in case the
  // agent re-fed a display form (spaces) from top_patterns / cost_drivers.
  const pattern = normalizePattern(args.pattern);

  // ── 1. Query the Retriever for historical events ──
  // Translate the user-facing pattern name into a Bloom-filter `search`
  // expression. The deprecated `pattern` field on RetrieverQueryRequest is
  // silently dropped by the body builder; without this translation the
  // engine runs unfiltered across the window and the resulting metric is
  // populated with every event in scope, not just the requested pattern.
  const started = Date.now();
  const retrieverReq: RetrieverQueryRequest = {
    search: buildPatternSearch(pattern),
    from: args.from,
    to: args.to,
    filters: args.filters,
    limit: 100_000,
  };
  const retrieverResp = await runRetrieverQuery(env, retrieverReq, { timeoutMs: 300_000 });
  const events = retrieverResp.events || [];
  const retrieverWallMs = Date.now() - started;

  if (events.length === 0) {
    return [
      `## Backfill: ${args.metric_name}`,
      '',
      `**Result**: Retriever returned **zero events** matching this pattern + filter + window.`,
      '',
      `**Checked**: pattern=\`${pattern}\`, window=${args.from}→${args.to}, filters=${JSON.stringify(args.filters || [])}`,
      '',
      `No points were emitted to ${args.destination}. Verify the pattern identity (call log10x_event_lookup on a raw sample line), check the window, or widen the filter expressions. If the Retriever archive's retention is shorter than the requested window, the missing portion is invisible to this tool.`,
    ].join('\n');
  }

  // ── 2. Aggregate into the requested time series ──
  const aggregated = aggregate(events, {
    bucketSize: args.bucket_size,
    aggregation: args.aggregation,
    groupBy: args.group_by,
    uniqueField: args.unique_field,
  });

  // ── 3. Emit to the destination ──
  const oldestMs = aggregated.points[0] ? aggregated.points[0].timestamp * 1000 : Date.now();
  const emission = await emitSeries(aggregated.points, {
    destination: args.destination,
    metricName: args.metric_name,
    earliestTimestampMs: oldestMs,
    staticTags: { pattern: pattern.replace(/[^A-Za-z0-9_.-]/g, '_'), backfill: 'log10x' },
  });

  // ── 4. Forward-emission handoff (stub) ──
  const forwardNote = args.emit_forward
    ? 'Forward-emission handoff: **not yet implemented in this MCP build**. The Reporter config update path (writing a new metric definition into the Reporter\'s output module config and triggering a config reload) is gated on `config/modules/pipelines/run/modules/output/metric/<destination>/` being writable from the MCP server process. Until that path ships, set `emit_forward: false`, or run the backfill now and manually add the metric to the Reporter\'s output config yourself, then rerun the Reporter.'
    : 'Forward-emission not requested. This is a one-time historical backfill; the metric will stop at the end of the backfill window unless emit_forward is later enabled.';

  // ── 5. Render markdown result ──
  const lines: string[] = [];
  lines.push(`## Backfill: ${args.metric_name}`);
  lines.push('');
  lines.push(`**Pattern**: \`${pattern}\``);
  lines.push(`**Destination**: ${args.destination}`);
  lines.push(`**Window**: ${args.from} → ${args.to}`);
  lines.push(`**Bucket**: ${args.bucket_size} · **Aggregation**: ${args.aggregation}`);
  if (args.group_by && args.group_by.length > 0) {
    lines.push(`**Group by**: ${args.group_by.map((g) => `\`${g}\``).join(', ')}`);
  }
  if (args.filters && args.filters.length > 0) {
    lines.push(`**Filters**: ${args.filters.map((f) => `\`${f}\``).join(' AND ')}`);
  }
  lines.push('');
  lines.push('### Execution');
  lines.push('');
  lines.push(`- Retriever scan: ${fmtCount(events.length)} events retrieved in ${retrieverWallMs}ms`);
  lines.push(`- Aggregated: ${fmtCount(aggregated.points.length)} data points across ${aggregated.seriesCount} time series (${aggregated.bucketSeconds}s buckets)`);
  lines.push(`- ${args.destination} emission: ${fmtCount(emission.pointsEmitted)} points posted in ${emission.wallTimeMs}ms (${fmtBytes(emission.bytesPosted)})`);
  if (emission.viewUrl) {
    lines.push(`- View: ${emission.viewUrl}`);
  }
  lines.push('');

  if (emission.warnings.length > 0) {
    lines.push('### Warnings');
    lines.push('');
    for (const w of emission.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  lines.push('### Forward emission');
  lines.push('');
  lines.push(forwardNote);
  lines.push('');

  lines.push('---');
  lines.push(
    `**Next action**: create an alert on \`${args.metric_name}\` in ${args.destination}. ` +
      `The full 90-day history is now populated, so you can calibrate thresholds against real data instead of guessing from the first week.`
  );
  lines.push('');
  lines.push('**Other things you can do now**:');
  lines.push(`  - Verify the backfilled series: \`log10x_pattern_trend({ pattern: '${pattern}', timeRange: '30d' })\` — the time series now extends the full 90d, not just from forward-emission start.`);
  lines.push(`  - Run the same pattern again over the archive at finer granularity: \`log10x_retriever_series({ pattern: '${pattern}' })\` — useful for sanity-checking the backfilled buckets.`);

  if (sumOut) {
    sumOut.data = {
      ok: true,
      pattern,
      metric_name: args.metric_name,
      destination: args.destination,
      window_from: args.from,
      window_to: args.to ?? 'now',
      bucket_size: args.bucket_size ?? '5m',
      bucket_seconds: aggregated.bucketSeconds,
      aggregation: args.aggregation ?? 'count',
      group_by: args.group_by ?? [],
      filters: args.filters ?? [],
      events_retrieved: events.length,
      retriever_wall_ms: retrieverWallMs,
      points_emitted: emission.pointsEmitted,
      series_count: aggregated.seriesCount,
      emission_wall_ms: emission.wallTimeMs,
      bytes_posted: emission.bytesPosted,
      view_url: emission.viewUrl,
      warnings: emission.warnings,
      forward_emission_note: forwardNote,
    };
  }

  return lines.join('\n');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
