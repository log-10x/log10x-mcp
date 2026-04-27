/**
 * log10x_retriever_query — direct retrieval from the Log10x Retriever archive.
 *
 * Forensic-retrieval entry point. Call when the user needs specific historical
 * events matching a search expression over a window that is outside the SIEM's
 * retention, or filtered on a variable value that is not a faceted dimension
 * in their SIEM, or that the SIEM never received because the edge optimizer
 * dropped it.
 *
 * Engine contract: POST returns a queryId; results land in S3 as JSONL files
 * under {bucket}/tenx/{target}/qr/{queryId}/. The client polls the marker
 * prefix for stability, then reads and merges the JSONL result files.
 *
 * Requires LOG10X_REGULATOR_RETRIEVER_URL and LOG10X_REGULATOR_RETRIEVER_BUCKET to be set. Falls
 * back gracefully with a "not configured" message otherwise.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  runRetrieverQuery,
  isRetrieverConfigured,
  normalizeTimeExpression,
  type RetrieverQueryRequest,
  type RetrieverEvent,
} from '../lib/retriever-api.js';
import {
  explainZeroResults,
  type RetrieverQueryDiagnostics,
} from '../lib/retriever-diagnostics.js';
import { fmtCount } from '../lib/format.js';

export const retrieverQuerySchema = {
  search: z
    .string()
    .optional()
    .describe(
      'Bloom-filter search expression using the TenX subset: `==`, `||`, `&&`, `includes(field, "substr")`. Example: `severity_level=="ERROR" && includes(text, "ECONNREFUSED")`. Selective values are dramatically cheaper than open-ended scans. Omit to scan the full window (bounded by limit/processingTime).'
    ),
  from: z
    .string()
    .describe(
      'Start of the query window. Accepts ISO8601 (`2026-01-15T00:00:00Z`), epoch millis, or relative (`now-1h`, `now-24h`, `now-7d`). Normalized to the engine\'s `now("-1h")` form before dispatch.'
    ),
  to: z
    .string()
    .default('now')
    .describe('End of the query window. Same grammar as `from`. Default `now`.'),
  filters: z
    .array(z.string())
    .optional()
    .describe(
      'JavaScript filter expressions evaluated in-memory against each decoded event after the Bloom-scoped fetch. Full TenX JS API: `this.customer_id === "acme-corp"`, `this.http_code.startsWith("5")`. Filters are AND-combined.'
    ),
  target: z
    .string()
    .optional()
    .describe(
      'Target app/service prefix to scope the index scan. Defaults to LOG10X_REGULATOR_RETRIEVER_TARGET (env var). Required if no default is configured.'
    ),
  limit: z
    .number()
    .min(1)
    .max(10_000)
    .default(500)
    .describe(
      'Hard cap on events returned after merging per-worker result files. Default 500. Typical conversational queries want 10-100; the LLM will render only the first 50.'
    ),
  format: z
    .enum(['events', 'count', 'aggregated', 'ephemeral_series'])
    .default('events')
    .describe(
      '`events` (default: raw events), `count` (total + severity/service rollups, no event bodies), `aggregated` (events bucketed into a time series — use with bucket_size), `ephemeral_series` (bucketed series in Prometheus range-query shape for cross-pillar correlation). All four formats are rolled up client-side from the same events stream.'
    ),
  bucket_size: z
    .string()
    .default('5m')
    .describe('Bucket size when format=aggregated or ephemeral_series. Examples: `1m`, `5m`, `1h`, `1d`.'),
  environment: z.string().optional().describe('Environment nickname — required if multi-env.'),
};

export async function executeRetrieverQuery(
  args: {
    search?: string;
    from: string;
    to: string;
    filters?: string[];
    target?: string;
    limit: number;
    format: 'events' | 'count' | 'aggregated' | 'ephemeral_series';
    bucket_size: string;
    environment?: string;
  },
  env: EnvConfig
): Promise<string> {
  if (!isRetrieverConfigured()) {
    return retrieverNotConfiguredMessage();
  }

  try {
    normalizeTimeExpression(args.from);
    normalizeTimeExpression(args.to);
  } catch (e) {
    throw new Error(`Invalid time window: ${(e as Error).message}`);
  }

  const req: RetrieverQueryRequest = {
    from: args.from,
    to: args.to,
    search: args.search,
    filters: args.filters,
    target: args.target,
    limit: args.limit,
  };

  const resp = await runRetrieverQuery(env, req);

  const lines: string[] = [];
  lines.push(`## Retriever Query`);
  lines.push('');
  lines.push(`**Window**: ${args.from} → ${args.to}`);
  if (args.search) lines.push(`**Search**: \`${args.search}\``);
  if (args.filters && args.filters.length > 0) {
    lines.push(`**Filters**: ${args.filters.map((f) => `\`${f}\``).join(' AND ')}`);
  }
  lines.push(`**Target**: \`${resp.target}\``);
  lines.push(`**Query ID**: \`${resp.queryId}\``);
  lines.push('');
  lines.push(
    `**Execution**: ${fmtCount(resp.execution.eventsMatched)} events matched · ` +
      `${resp.execution.workerFiles} worker result files · ` +
      `${resp.execution.wallTimeMs}ms wall time` +
      (resp.execution.truncated ? ` · _truncated_` : '')
  );
  renderDiagnostics(resp.diagnostics, resp.execution.eventsMatched, lines);
  lines.push('');

  if (args.format === 'count') {
    return renderCount(resp.events, lines).join('\n');
  }

  if (args.format === 'aggregated') {
    return renderAggregated(resp.events, args.bucket_size, lines).join('\n');
  }

  if (args.format === 'ephemeral_series') {
    return renderEphemeralSeries(resp.events, args.bucket_size, args.search, lines).join('\n');
  }

  // events format
  const events = resp.events;
  lines.push(`### Events (${Math.min(events.length, 50)} of ${events.length} shown)`);
  lines.push('');
  for (let i = 0; i < Math.min(events.length, 50); i++) {
    lines.push(formatEvent(events[i]));
  }
  if (events.length > 50) {
    lines.push('');
    lines.push(
      `_${events.length - 50} additional events omitted. Switch to \`format: "aggregated"\` or \`"count"\` for a summary, or narrow the search/filter._`
    );
  }
  if (events.length === 0) {
    lines.push(
      '_Retriever returned zero events. Verify the search expression matches at least one real value, check the window, or widen the filter._'
    );
  }

  if (resp.execution.truncated) {
    lines.push('');
    lines.push(
      '> **Truncated**: one or more stream workers hit the per-worker result cap. Narrow the search expression or add a more selective filter to see the full match set.'
    );
  }

  return lines.join('\n');
}

function renderCount(events: RetrieverEvent[], lines: string[]): string[] {
  lines.push(`### Count summary`);
  lines.push('');
  lines.push(`Total matched: **${fmtCount(events.length)}**`);

  const byService = new Map<string, number>();
  const bySeverity = new Map<string, number>();
  const byDay = new Map<string, number>();

  for (const ev of events) {
    const svc = (ev.tenx_user_service as string) || 'unknown';
    byService.set(svc, (byService.get(svc) || 0) + 1);

    const sev = (ev.severity_level as string) || 'unknown';
    bySeverity.set(sev, (bySeverity.get(sev) || 0) + 1);

    const ts = ev.timestamp;
    if (ts) {
      const d = new Date(typeof ts === 'number' ? ts : String(ts));
      if (!isNaN(d.getTime())) {
        const day = d.toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) || 0) + 1);
      }
    }
  }

  if (bySeverity.size > 0) {
    lines.push('');
    lines.push('By severity:');
    for (const [sev, n] of [...bySeverity.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  - ${sev}: ${fmtCount(n)}`);
    }
  }
  if (byService.size > 0) {
    lines.push('');
    lines.push('By service (top 10):');
    for (const [svc, n] of [...byService.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      lines.push(`  - ${svc}: ${fmtCount(n)}`);
    }
  }
  if (byDay.size > 0) {
    lines.push('');
    lines.push('By day:');
    for (const [day, n] of [...byDay.entries()].sort()) {
      lines.push(`  - ${day}: ${fmtCount(n)}`);
    }
  }
  return lines;
}

function bucketEvents(events: RetrieverEvent[], bucketSize: string): Array<{ timestamp: string; count: number }> {
  const bucketMs = parseBucketSize(bucketSize);
  const buckets = new Map<number, number>();

  for (const ev of events) {
    const ts = ev.timestamp;
    if (!ts) continue;
    const d = new Date(typeof ts === 'number' ? ts : String(ts));
    if (isNaN(d.getTime())) continue;
    const key = Math.floor(d.getTime() / bucketMs) * bucketMs;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, count]) => ({ timestamp: new Date(ts).toISOString(), count }));
}

function parseBucketSize(expr: string): number {
  const m = expr.trim().match(/^(\d+)([smhd])$/);
  if (!m) return 5 * 60 * 1000;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return 5 * 60 * 1000;
  }
}

function renderAggregated(events: RetrieverEvent[], bucketSize: string, lines: string[]): string[] {
  const buckets = bucketEvents(events, bucketSize);
  lines.push(`### Time-bucketed (${bucketSize})`);
  lines.push('');
  if (buckets.length === 0) {
    lines.push('_No events with parseable timestamps in the result set._');
    return lines;
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
  return lines;
}

function renderEphemeralSeries(
  events: RetrieverEvent[],
  bucketSize: string,
  search: string | undefined,
  lines: string[]
): string[] {
  const buckets = bucketEvents(events, bucketSize);
  lines.push(`### Ephemeral series (Prometheus range-query shape)`);
  lines.push('');
  if (buckets.length === 0) {
    lines.push('_No events with parseable timestamps in the result set._');
    return lines;
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
            source: 'retriever_archive',
            search: search || '',
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
    `**${values.length} data points** over the window in Prometheus range-query format.`
  );
  return lines;
}

function formatEvent(ev: RetrieverEvent): string {
  // The retriever returns events in two shapes depending on whether the
  // query-handler pipeline enriched them:
  //
  // 1. **log10x canonical** — `text`, `severity_level`, `tenx_user_service`,
  //    `k8s_*` fields. Present when the archive was written by a Reporter/
  //    Reducer pipeline that had tokenization + enrichment enabled.
  //
  // 2. **raw fluent-bit** — `log`, `stream`, `kubernetes.namespace_name`,
  //    `kubernetes.pod_name`, `kubernetes.container_name`. Present when the
  //    archive holds pre-enrichment events (e.g., a fluent-bit → S3 feed
  //    that bypassed log10x enrichment).
  //
  // Previously this function only handled shape 1, silently rendering
  // empty rows for shape 2. Caught during retriever end-to-end validation
  // on the demo env (2026-04-15). Now handles both shapes explicitly.
  const parts: string[] = [];
  const evRec = ev as unknown as Record<string, unknown>;
  const kube = (evRec.kubernetes ?? {}) as Record<string, unknown>;

  if (ev.timestamp) parts.push(`**${ev.timestamp}**`);
  const service = ev.tenx_user_service
    ?? (kube.labels && (kube.labels as Record<string, unknown>)['app.kubernetes.io/name'])
    ?? kube.container_name;
  if (service) parts.push(`service=${service}`);
  if (ev.severity_level) parts.push(`sev=${ev.severity_level}`);
  else if (evRec.stream) parts.push(`stream=${evRec.stream}`);
  const ns = ev.k8s_namespace ?? kube.namespace_name;
  if (ns) parts.push(`ns=${ns}`);
  const pod = ev.k8s_pod ?? kube.pod_name;
  if (pod) parts.push(`pod=${pod}`);
  if (ev.http_code) parts.push(`http=${ev.http_code}`);

  const meta = parts.join(' · ');
  const rawText = ev.text ?? evRec.log ?? evRec.message ?? '';
  const text = rawText ? String(rawText).replace(/\n/g, ' ').slice(0, 400) : '';
  return `- ${meta}\n  ${text}`;
}

function renderBar(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function retrieverNotConfiguredMessage(): string {
  return [
    '## Retriever not configured',
    '',
    "This MCP server doesn't currently have a Log10x Retriever endpoint configured. The Retriever is what lets this tool query historical events in the customer's S3 archive by Bloom-indexed variable values and template hashes.",
    '',
    "**What's out of reach without the Retriever**:",
    '',
    "- Events beyond the SIEM's hot retention (compliance, legal, audit, post-mortems older than ~30d)",
    '- Events dropped by the forwarder upstream of the SIEM (log10x metrics see them, SIEM does not)',
    '- New metrics backfilled from archive that were never collected live',
    '- Historical baselines older than SIEM retention (WoW/MoM/YoY at long horizons)',
    '- Sample-reversal verification when the SIEM returns sampled results at high volume',
    '',
    '**Options for the agent right now**:',
    '',
    "- (a) Deploy the Log10x Retriever — best long-term answer. Guide: https://doc.log10x.com/apps/cloud/retriever/",
    "- (b) Rehydrate from the SIEM's cold-tier archive — slow, expensive, but preserves the current setup",
    "- (c) Rescope the question to the SIEM's hot retention window and use the SIEM MCP directly",
    '',
    '**To enable the Retriever later**:',
    '',
    '1. Deploy per the guide above',
    '2. Set `LOG10X_REGULATOR_RETRIEVER_URL` to the query handler endpoint (e.g., the NLB for the query-handler service)',
    '3. Set `LOG10X_REGULATOR_RETRIEVER_BUCKET` to the S3 bucket holding the retriever index',
    '4. Optionally set `LOG10X_REGULATOR_RETRIEVER_TARGET` to the default target app prefix (e.g., `app`)',
    '5. Re-run this tool',
  ].join('\n');
}

/**
 * Append execution diagnostics (Bloom scan counts, worker stats, classification
 * reason) to the output. Runs post-response using CloudWatch-sourced events.
 * Renders nothing when diagnostics were unavailable and the query succeeded —
 * noisy lines are only useful when something went wrong.
 */
function renderDiagnostics(
  diag: RetrieverQueryDiagnostics | undefined,
  eventsMatched: number,
  lines: string[],
): void {
  if (!diag) return;

  if (diag.pollingError) {
    lines.push(`**Diagnostics**: _unavailable — ${diag.pollingError}_`);
    return;
  }

  const parts: string[] = [];
  if (diag.scanStats) {
    parts.push(
      `scanned=${diag.scanStats.scanned} matched=${diag.scanStats.matched} ` +
        `skippedSearch=${diag.scanStats.skippedSearch} skippedTemplate=${diag.scanStats.skippedTemplate}`,
    );
  }
  if (diag.streamDispatch) {
    parts.push(
      `streamRequests=${diag.streamDispatch.requests} streamObjects=${diag.streamDispatch.objects} streamBlobs=${diag.streamDispatch.blobs}`,
    );
  }
  if (diag.workerStats) {
    parts.push(
      `workers=${diag.workerStats.complete}/${diag.workerStats.started} workerEvents=${diag.workerStats.totalResultEvents}`,
    );
  }
  if (diag.partialResults) parts.push('partialResults=true');

  if (parts.length > 0) {
    lines.push(`**Diagnostics**: ${parts.join(' · ')}`);
  }

  // On zero-result queries, add a classification sentence derived from the
  // diagnostics — this is the whole point: distinguish bloom-miss from
  // stale-indexer from field-not-indexed.
  if (eventsMatched === 0) {
    const reason = explainZeroResults(diag);
    if (reason) {
      lines.push(`**Why zero events**: ${reason}`);
    }
  }

  if (diag.errors && diag.errors.length > 0) {
    lines.push(`**Errors**: ${diag.errors.length} logged — first: ${diag.errors[0]}`);
  }
}
