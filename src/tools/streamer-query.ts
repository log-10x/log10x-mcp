/**
 * log10x_streamer_query — direct retrieval from the Log10x Storage Streamer archive.
 *
 * This is the forensic-retrieval entry point. Call when the user needs
 * specific historical events matching a pattern over a window that is
 * outside the SIEM's retention or filtered on a variable value that is
 * not a faceted dimension in their SIEM.
 *
 * Requires LOG10X_STREAMER_URL to be set. Falls back gracefully with a
 * clear "Streamer not configured" message otherwise.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  runStreamerQuery,
  isStreamerConfigured,
  parseTimeExpression,
  type StreamerQueryRequest,
  type StreamerEvent,
} from '../lib/streamer-api.js';
import { fmtCount } from '../lib/format.js';

export const streamerQuerySchema = {
  pattern: z
    .string()
    .describe('Pattern to query — either a templateHash (e.g., `~3gTMRPTTYm`) or a symbolMessage field-set string. Use log10x_event_lookup first to resolve a raw log line to its canonical identity.'),
  from: z
    .string()
    .describe('Start of the query window — ISO8601 timestamp (`2026-01-15T00:00:00Z`) or relative expression (`now-90d`).'),
  to: z
    .string()
    .default('now')
    .describe('End of the query window — ISO8601 or relative. Default `now`.'),
  search: z
    .string()
    .optional()
    .describe('Optional search expression on enriched fields (severity_level, tenx_user_service, k8s_namespace, http_code, country, etc.).'),
  filters: z
    .array(z.string())
    .optional()
    .describe('Optional JavaScript filter expressions evaluated against each decoded event. Full TenX JS API available: `event.customer_id === "acme-corp-inc"`, `event.http_code.startsWith("5")`, `event.tenant_id in ["a", "b"]`. Filters are AND-combined.'),
  target: z
    .string()
    .optional()
    .describe('Optional service/app prefix to scope the Bloom filter scan (narrows the byte-range fetch). Defaults to the entire archive.'),
  limit: z
    .number()
    .min(1)
    .max(100_000)
    .default(10_000)
    .describe('Max events to return. Default 10000. Queries that exceed the limit surface a truncation flag in the output.'),
  format: z
    .enum(['events', 'count', 'aggregated', 'ephemeral_series'])
    .default('events')
    .describe('`events` (raw events with metadata), `count` (total + distributions only), `aggregated` (events bucketed into a time series — use with bucket_size), `ephemeral_series` (NEW in v1.4: returns the bucketed time series inline in Prometheus range-query shape so downstream cross-pillar correlation tools can treat it as a first-class metric without writing to a TSDB).'),
  bucket_size: z
    .string()
    .default('5m')
    .describe('Bucket size when format=aggregated. Examples: `1m`, `5m`, `1h`, `1d`.'),
  environment: z.string().optional().describe('Environment nickname — required if multi-env.'),
};

export async function executeStreamerQuery(
  args: {
    pattern: string;
    from: string;
    to: string;
    search?: string;
    filters?: string[];
    target?: string;
    limit: number;
    format: 'events' | 'count' | 'aggregated' | 'ephemeral_series';
    bucket_size: string;
    environment?: string;
  },
  env: EnvConfig
): Promise<string> {
  if (!isStreamerConfigured()) {
    return streamerNotConfiguredMessage();
  }

  // Validate window before hitting the API.
  try {
    parseTimeExpression(args.from);
    parseTimeExpression(args.to);
  } catch (e) {
    throw new Error(`Invalid time window: ${(e as Error).message}`);
  }

  // `ephemeral_series` is a v1.4 tool-level mode that maps to the Streamer's
  // `aggregated` format at the API level. The difference is purely in the
  // rendering: aggregated produces a histogram bar chart for humans,
  // ephemeral_series wraps the same buckets into a Prometheus range-query
  // response shape for downstream tool chains.
  const backendFormat =
    args.format === 'ephemeral_series' ? 'aggregated' : args.format;

  const req: StreamerQueryRequest = {
    pattern: args.pattern,
    from: args.from,
    to: args.to,
    search: args.search,
    filters: args.filters,
    target: args.target,
    limit: args.limit,
    format: backendFormat,
    bucketSize: args.bucket_size,
  };

  const resp = await runStreamerQuery(env, req);

  // ── Render markdown report ──
  const lines: string[] = [];
  lines.push(`## Streamer Query · \`${resp.pattern}\``);
  lines.push('');
  lines.push(`**Window**: ${args.from} → ${args.to}`);
  if (args.search) lines.push(`**Search**: \`${args.search}\``);
  if (args.filters && args.filters.length > 0) {
    lines.push(`**Filters**: ${args.filters.map((f) => `\`${f}\``).join(' AND ')}`);
  }
  if (args.target) lines.push(`**Target**: \`${args.target}\``);
  lines.push('');
  lines.push(
    `**Execution**: ${fmtCount(resp.execution.eventsMatched)} events matched · ` +
      `${resp.execution.wallTimeMs}ms wall time` +
      (resp.execution.bytesScanned ? ` · ${resp.execution.bytesScanned} scanned` : '') +
      (resp.execution.truncated ? ` · _truncated_` : '')
  );
  lines.push('');

  if (resp.format === 'count') {
    lines.push(`### Count summary`);
    if (resp.countSummary) {
      lines.push(`Total matched: **${fmtCount(resp.countSummary.total)}**`);
      if (resp.countSummary.byDay) {
        lines.push('');
        lines.push('By day:');
        for (const [day, n] of Object.entries(resp.countSummary.byDay).sort()) {
          lines.push(`  - ${day}: ${fmtCount(n)}`);
        }
      }
      if (resp.countSummary.byService) {
        lines.push('');
        lines.push('By service:');
        const entries = Object.entries(resp.countSummary.byService).sort((a, b) => b[1] - a[1]).slice(0, 10);
        for (const [svc, n] of entries) {
          lines.push(`  - ${svc}: ${fmtCount(n)}`);
        }
      }
      if (resp.countSummary.bySeverity) {
        lines.push('');
        lines.push('By severity:');
        for (const [sev, n] of Object.entries(resp.countSummary.bySeverity)) {
          lines.push(`  - ${sev}: ${fmtCount(n)}`);
        }
      }
    } else {
      lines.push('_No count summary returned by the Streamer — the deployment may not support count-only responses._');
    }
    return lines.join('\n');
  }

  if (args.format === 'ephemeral_series') {
    // Tool-level ephemeral_series mode: wrap the Streamer's aggregated
    // buckets into a Prometheus range-query response shape so downstream
    // correlation tools can treat the result as a first-class metric.
    // No TSDB write, no destination credentials, no backdated-ingestion
    // concerns — the series lives in this response only.
    lines.push(`### Ephemeral series (Prometheus range-query shape)`);
    lines.push('');
    const buckets = resp.buckets || [];
    if (buckets.length === 0) {
      lines.push('_No buckets returned. The anchor pattern may have no events in this window._');
      return lines.join('\n');
    }
    const values: Array<[number, string]> = buckets.map((b) => [
      Math.floor(new Date(b.timestamp).getTime() / 1000),
      String(b.count),
    ]);
    const promResponse = {
      status: 'success' as const,
      data: {
        resultType: 'matrix' as const,
        result: [
          {
            metric: {
              __name__: 'log10x_ephemeral',
              pattern: resp.pattern,
              source: 'streamer_archive',
            },
            values,
          },
        ],
      },
    };
    lines.push('```json');
    lines.push(JSON.stringify(promResponse, null, 2));
    lines.push('```');
    lines.push('');
    lines.push(
      `**${values.length} data points** over the window. The series is addressable as a Prometheus range-query response — pass it into \`log10x_correlate_cross_pillar\` with an anchor that's a customer metric expression, and the correlation tool will treat this ephemeral series as a candidate.`
    );
    return lines.join('\n');
  }

  if (resp.format === 'aggregated') {
    lines.push(`### Time-bucketed (${args.bucket_size})`);
    const buckets = resp.buckets || [];
    if (buckets.length === 0) {
      lines.push('_No buckets returned._');
      return lines.join('\n');
    }
    const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
    for (const b of buckets.slice(0, 80)) {
      const bar = max > 0 ? renderBar(b.count / max, 30) : '';
      lines.push(`  ${b.timestamp}  ${fmtCount(b.count).padStart(8)}  ${bar}`);
    }
    if (buckets.length > 80) {
      lines.push('');
      lines.push(`_${buckets.length - 80} additional buckets omitted from the rendering._`);
    }
    return lines.join('\n');
  }

  // events format
  const events = resp.events || [];
  lines.push(`### Events (${events.length} shown)`);
  lines.push('');
  for (let i = 0; i < Math.min(events.length, 50); i++) {
    lines.push(formatEvent(events[i]));
  }
  if (events.length > 50) {
    lines.push('');
    lines.push(`_${events.length - 50} additional events omitted. Lower the format to \`count\` or \`aggregated\` for a summary view, or narrow the window/filters._`);
  }
  if (events.length === 0) {
    lines.push(
      '_Streamer returned zero events matching this query. ' +
        'Verify the pattern identity (use log10x_event_lookup to resolve a raw line), check the window, or widen the filter expressions._'
    );
  }

  lines.push('');
  lines.push('---');
  lines.push(
    '**Next action**: to turn these historical events into a persistent metric in your TSDB, ' +
      `call \`log10x_backfill_metric({ pattern: '${resp.pattern}', ... })\` with the same window and filters.`
  );

  return lines.join('\n');
}

function formatEvent(ev: StreamerEvent): string {
  const parts: string[] = [];
  parts.push(`**${ev.timestamp}**`);
  if (ev.service) parts.push(`service=${ev.service}`);
  if (ev.severity) parts.push(`sev=${ev.severity}`);
  if (ev.enrichedFields) {
    const extras = Object.entries(ev.enrichedFields)
      .slice(0, 4)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    if (extras) parts.push(extras);
  }
  const meta = parts.join(' · ');
  return `- ${meta}\n  ${ev.text}`;
}

function renderBar(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function streamerNotConfiguredMessage(): string {
  return [
    '## Streamer not configured',
    '',
    "This MCP server doesn't currently have a Log10x Storage Streamer endpoint configured. The Streamer component is what lets this tool query historical events in the customer's S3 archive by templateHash with Bloom-filter narrowing.",
    '',
    '**To enable it**:',
    '',
    '1. Deploy the Log10x Storage Streamer per https://docs.log10x.com/apps/cloud/streamer/',
    '2. Set `LOG10X_STREAMER_URL` in the MCP server environment to the deployed query endpoint.',
    '3. Re-run this tool.',
    '',
    "**Without the Streamer**: for in-retention forensic retrieval, use the customer's SIEM directly (Datadog `dog log search`, Splunk SPL, Elastic `_search`). For long-window retrieval outside SIEM retention, the Streamer is the only supported path.",
  ].join('\n');
}
