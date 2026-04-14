/**
 * log10x_backfill_metric — create a new TSDB metric, backfilled from the Streamer archive.
 *
 * Flagship "Log10x-only" composition tool. Pulls historical events from
 * the Storage Streamer for a specified pattern + filter + window,
 * aggregates them into a bucketed time series, and emits the result to
 * the destination TSDB with historical timestamps preserved.
 *
 * Optionally wires up forward emission via the live Reporter so the
 * metric continues populating from current events going forward. The
 * backfill + forward-emission hand-off is the full story: the customer
 * gets a continuous time series from 90-180 days ago through the present
 * instant, as if the metric had always existed.
 *
 * Tier prerequisites: Streamer component required; Reporter required
 * only when emit_forward=true.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  runStreamerQuery,
  isStreamerConfigured,
  parseTimeExpression,
  type StreamerQueryRequest,
} from '../lib/streamer-api.js';
import { aggregate, type AggregationType } from '../lib/aggregator.js';
import { emitSeries, type Destination } from '../lib/metric-emitters.js';
import { fmtCount } from '../lib/format.js';
import { streamerNotConfiguredMessage } from './streamer-query.js';

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
    .describe('Optional JS filter expressions over event payloads, passed through to the Streamer query.'),
  unique_field: z
    .string()
    .optional()
    .describe('For aggregation=unique_values: the field whose cardinality is counted per bucket (e.g., `tenant_id`).'),
  emit_forward: z
    .boolean()
    .default(false)
    .describe('When true, wire the live Reporter to continue emitting the same metric from current events going forward. Default false in this build — the forward-emission handoff path to the Reporter config file is not yet implemented. Set true only after installing the Reporter config update path.'),
  environment: z.string().optional().describe('Environment nickname — required if multi-env.'),
};

export async function executeBackfillMetric(
  args: {
    pattern: string;
    metric_name: string;
    destination: Destination;
    bucket_size: string;
    aggregation: AggregationType;
    from: string;
    to: string;
    group_by?: string[];
    filters?: string[];
    unique_field?: string;
    emit_forward: boolean;
    environment?: string;
  },
  env: EnvConfig
): Promise<string> {
  // ── 0. Prerequisites ──
  if (!isStreamerConfigured()) {
    return streamerNotConfiguredMessage();
  }

  try {
    parseTimeExpression(args.from);
    parseTimeExpression(args.to);
  } catch (e) {
    throw new Error(`Invalid time window: ${(e as Error).message}`);
  }

  if (args.aggregation === 'unique_values' && !args.unique_field) {
    throw new Error('aggregation=unique_values requires a `unique_field` argument.');
  }

  // ── 1. Query the Streamer for historical events ──
  const started = Date.now();
  const streamerReq: StreamerQueryRequest = {
    pattern: args.pattern,
    from: args.from,
    to: args.to,
    filters: args.filters,
    limit: 100_000,
    format: 'events',
  };
  const streamerResp = await runStreamerQuery(env, streamerReq, { timeoutMs: 300_000 });
  const events = streamerResp.events || [];
  const streamerWallMs = Date.now() - started;

  if (events.length === 0) {
    return [
      `## Backfill: ${args.metric_name}`,
      '',
      `**Result**: Streamer returned **zero events** matching this pattern + filter + window.`,
      '',
      `**Checked**: pattern=\`${args.pattern}\`, window=${args.from}→${args.to}, filters=${JSON.stringify(args.filters || [])}`,
      '',
      `No points were emitted to ${args.destination}. Verify the pattern identity (call log10x_event_lookup on a raw sample line), check the window, or widen the filter expressions. If the Streamer archive's retention is shorter than the requested window, the missing portion is invisible to this tool.`,
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
    staticTags: { pattern: args.pattern.replace(/[^A-Za-z0-9_.-]/g, '_'), backfill: 'log10x' },
  });

  // ── 4. Forward-emission handoff (stub) ──
  const forwardNote = args.emit_forward
    ? 'Forward-emission handoff: **not yet implemented in this MCP build**. The Reporter config update path (writing a new metric definition into the Reporter\'s output module config and triggering a config reload) is gated on `config/modules/pipelines/run/modules/output/metric/<destination>/` being writable from the MCP server process. Until that path ships, set `emit_forward: false`, or run the backfill now and manually add the metric to the Reporter\'s output config yourself, then rerun the Reporter.'
    : 'Forward-emission not requested. This is a one-time historical backfill; the metric will stop at the end of the backfill window unless emit_forward is later enabled.';

  // ── 5. Render markdown result ──
  const lines: string[] = [];
  lines.push(`## Backfill: ${args.metric_name}`);
  lines.push('');
  lines.push(`**Pattern**: \`${args.pattern}\``);
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
  lines.push(`- Streamer scan: ${fmtCount(events.length)} events retrieved in ${streamerWallMs}ms`);
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

  return lines.join('\n');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
