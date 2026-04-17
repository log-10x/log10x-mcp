/**
 * Log10x Storage Streamer REST client + S3 results poller.
 *
 * The Streamer's query API is two-phase:
 *
 *   1. POST /streamer/query with a body shaped like QueryRequest.java accepts.
 *      The body carries a client-generated `id` field which the engine uses
 *      as the canonical queryId and echoes back in the response.
 *
 *   2. The engine dispatches stream workers that buffer matched events to
 *      disk and upload them to S3 under {basePath}/tenx/{target}/qr/{queryId}/
 *      as JSONL files. The client polls that prefix via the AWS CLI until
 *      every expected worker has written its marker (at the sibling
 *      {basePath}/tenx/{target}/q/{queryId}/ backstop prefix) and the results
 *      prefix is stable.
 *
 * Configure with:
 *   - LOG10X_STREAMER_URL: base URL of the query handler (e.g., the NLB).
 *   - LOG10X_STREAMER_BUCKET: S3 bucket holding the streamer index/results.
 *   - LOG10X_STREAMER_TARGET: default target app prefix (e.g., "app" for
 *     the otek demo env). Overridable per query.
 *   - LOG10X_STREAMER_POLL_MS: poll interval, default 1500 ms.
 *   - LOG10X_STREAMER_TIMEOUT_MS: total poll budget, default 90_000 ms.
 *
 * Authentication piggybacks on the same X-10X-Auth header the Prometheus
 * gateway uses (apiKey/envId). Override via LOG10X_STREAMER_AUTH_HEADER /
 * LOG10X_STREAMER_AUTH_VALUE if the deployment uses a different scheme.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { EnvConfig } from './environments.js';

const execFileP = promisify(execFile);

export class StreamerNotConfiguredError extends Error {
  constructor() {
    super(
      'Storage Streamer endpoint not configured for this MCP install. ' +
        'log10x_streamer_query and log10x_backfill_metric cannot reach the S3 archive in this session.\n\n' +
        'Two possible causes:\n' +
        '  1. Streamer IS deployed but MCP env vars are unset. Fix: set LOG10X_STREAMER_URL ' +
        'to the streamer query handler URL (e.g., the NLB) and LOG10X_STREAMER_BUCKET to the ' +
        'archive bucket, then restart the MCP client.\n' +
        '  2. Streamer is NOT deployed for this customer. Fix: deploy per ' +
        'https://doc.log10x.com/apps/cloud/streamer/\n\n' +
        'Workaround for the current request: if the events you need are inside SIEM hot retention ' +
        '(typically <7 days for Datadog/Splunk/Elastic), tell the user to query the SIEM directly ' +
        'with the relevant service + time filter — that is the fastest path. For events outside ' +
        'SIEM retention, the only path is enabling the streamer.'
    );
    this.name = 'StreamerNotConfiguredError';
  }
}

export interface StreamerQueryRequest {
  /** Absolute ISO8601, epoch millis, or relative `now("-1h")`. */
  from: string;
  /** Absolute ISO8601, epoch millis, or relative `now()`. */
  to: string;
  /** Optional Bloom-filter search expression (TenX subset: ==, ||, &&, includes). */
  search?: string;
  /** Optional in-memory JS filters applied after the Bloom-scoped fetch. */
  filters?: string[];
  /** Target app prefix to scope the index scan. Defaults to LOG10X_STREAMER_TARGET. */
  target?: string;
  /** Logical query name (appears in PERF metrics). */
  name?: string;
  /** Hard cap on total events returned after merging per-worker results. */
  limit?: number;
  /** Max milliseconds the engine has to produce results. */
  processingTimeMs?: number;
  /** Max bytes the engine will ship before terminating. */
  resultSizeBytes?: number;

  // ── Legacy fields kept for call-site compatibility. The engine contract
  //    no longer uses `pattern` (the Bloom filter uses `search`), and
  //    `format`/`bucketSize` are now client-side rollups over the events
  //    stream. These are accepted but ignored by the new client.
  /** @deprecated use `search` instead */
  pattern?: string;
  /** @deprecated format is now a client-side rollup */
  format?: 'events' | 'count' | 'aggregated';
  /** @deprecated bucket_size is now a client-side rollup */
  bucketSize?: string;
}

export interface StreamerEvent {
  timestamp?: string;
  text?: string;
  severity_level?: string;
  tenx_user_service?: string;
  k8s_namespace?: string;
  k8s_pod?: string;
  k8s_container?: string;
  http_code?: string;

  // Legacy fields kept for aggregator/backfill compatibility. Populated
  // from the canonical enrichment fields inside runStreamerQuery.
  service?: string;
  severity?: string;
  templateHash?: string;
  enrichedFields?: Record<string, string>;
  values?: string[];

  /** Any additional fields returned by the engine. */
  [key: string]: unknown;
}

export interface StreamerBucket {
  timestamp: string;
  count: number;
  labels?: Record<string, string>;
}

/**
 * Execution diagnostics for a streamer query, built from CloudWatch Logs events.
 *
 * Field guide (how to diagnose a 0-event result):
 *   - queryPlan missing        → query submission failed or CW events not visible yet
 *   - emptyReason present      → search expression produced no parseable tokens
 *   - scanStats missing        → no sub-queries reported scan completion (likely no
 *                                index data for the time range, i.e. stale indexer)
 *   - scanStats.matched === 0  → Bloom filter rejected every index object
 *   - scanStats.matched > 0 but
 *     workerStats.totalResultEvents === 0
 *                              → Bloom false positives OR workers timed out
 *   - workerStats.complete < started
 *                              → some workers still running when MCP polled
 *   - pollingError present     → CW polling failed; diagnostics are incomplete
 *   - partialResults === true  → MCP poll timeout hit; server query may still be running
 */
export interface StreamerQueryDiagnostics {
  /** Coordinator's query plan. Present if the main query log stream was readable. */
  queryPlan?: {
    templateHashes: number;
    vars: number;
    timeslice: number;
    dispatch: 'local' | 'remote' | 'unknown';
  };
  /** Populated when isEmptyQuery() returned true — no parseable search tokens. */
  emptyReason?: string;
  /** Aggregated Bloom filter scan stats across all sub-queries. */
  scanStats?: {
    scanned: number;
    matched: number;
    skippedSearch: number;
    skippedTemplate: number;
    skippedDuplicate: number;
  };
  /**
   * Coordinator's view of stream dispatch. Represents SQS send() calls, NOT
   * worker completion. Use workerStats for actual worker execution.
   */
  streamDispatch?: {
    requests: number;
    objects: number;
    blobs: number;
  };
  /**
   * Stream worker execution. `started` and `complete` are counted from CW events,
   * so they reflect CW visibility, not necessarily ground truth if CW buffer hasn't
   * flushed. If complete < started, some workers were still running when polled.
   */
  workerStats?: {
    started: number;
    complete: number;
    totalFetchedBytes: number;
    totalResultEvents: number;
  };
  /** Main coordinator pipeline elapsed time (NOT full query wall time). */
  coordinatorElapsedMs?: number;
  /** ERROR-level CW events from any pipeline component. */
  errors?: string[];
  /**
   * True when the MCP's S3 marker poll timed out before the server query finished.
   * The server query may still be running and writing more results. Call
   * log10x_streamer_query_status with this queryId for an updated snapshot.
   */
  partialResults?: boolean;
  /**
   * If CW polling itself failed (AWS CLI missing, access denied, log group wrong),
   * the reason is reported here. Diagnostics are incomplete when set.
   */
  pollingError?: string;
}

export interface StreamerQueryResponse {
  queryId: string;
  target: string;
  from: string;
  to: string;
  execution: {
    wallTimeMs: number;
    eventsMatched: number;
    workerFiles: number;
    truncated: boolean;
  };
  diagnostics?: StreamerQueryDiagnostics;
  events: StreamerEvent[];

  // Legacy-compatible fields populated client-side from `events` so that
  // callers written against the old Streamer contract (investigate, backfill)
  // keep working without a rewrite.
  format?: 'events' | 'count' | 'aggregated';
  buckets?: StreamerBucket[];
  countSummary?: {
    total: number;
    byService?: Record<string, number>;
    bySeverity?: Record<string, number>;
    byDay?: Record<string, number>;
  };
}

export function isStreamerConfigured(): boolean {
  return Boolean(process.env.LOG10X_STREAMER_URL && process.env.LOG10X_STREAMER_BUCKET);
}

function getStreamerUrl(): string {
  const url = process.env.LOG10X_STREAMER_URL;
  if (!url) throw new StreamerNotConfiguredError();
  return url.replace(/\/+$/, '');
}

function getStreamerBucket(): string {
  const bucket = process.env.LOG10X_STREAMER_BUCKET;
  if (!bucket) throw new StreamerNotConfiguredError();
  return bucket;
}

function getDefaultTarget(): string {
  return process.env.LOG10X_STREAMER_TARGET || 'app';
}

function authHeaders(env: EnvConfig): Record<string, string> {
  const customHeader = process.env.LOG10X_STREAMER_AUTH_HEADER;
  const customValue = process.env.LOG10X_STREAMER_AUTH_VALUE;
  if (customHeader && customValue) {
    return { [customHeader]: customValue, 'Content-Type': 'application/json' };
  }
  return {
    'X-10X-Auth': `${env.apiKey}/${env.envId}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Convert the MCP-level `from`/`to` expressions to a form the streamer engine
 * reliably parses.
 *
 * Empirical behavior of the streamer server (tested 2026-04-15 against the
 * demo env deployment):
 *   - `now("-1h")` / `now()`    → accepted, matches events
 *   - epoch millis as a string  → accepted, matches events
 *   - ISO8601 like `2026-04-15T11:00:00Z` → accepted (HTTP 200), runs the
 *     query, returns ZERO events even when the wall-clock range should match
 *     — the server-side TenXDate parser mishandles ISO8601 and silently
 *     produces a non-matching range.
 *
 * To make ISO8601 inputs work reliably, this function converts them to epoch
 * millis strings before they leave the MCP. `now(...)` expressions are
 * preserved verbatim (they require server-side evaluation).
 *
 * Filed upstream as a streamer engine bug. The client-side conversion below
 * is the workaround, not the fix.
 */
export function normalizeTimeExpression(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error('Empty time expression');

  // The engine expects runtime-evaluated JS expressions prefixed with `$=`
  // (the template-language marker). Without the prefix, the engine treats
  // the string as a literal and fails to parse. Verified live on the
  // otel-demo env: CronJob-dispatched query bodies use `$=now("-5m")` /
  // `$=now()` and run correctly; the same bodies without the prefix get
  // silently dropped. GAPS G12 root cause (client-side half).
  if (trimmed === 'now') return '$=now()';

  const rel = trimmed.match(/^now\s*([+-])\s*(\d+)\s*([smhdwMy])$/);
  if (rel) {
    return `$=now("${rel[1]}${rel[2]}${rel[3]}")`;
  }

  // Already in now("-1h") form — prepend the eval prefix.
  if (/^now\s*\(/.test(trimmed)) return `$=${trimmed}`;

  // Already in $=now(...) form — pass through.
  if (/^\$=now\s*\(/.test(trimmed)) return trimmed;

  // Pure digit string — already epoch millis, pass through as a literal
  // (no $= prefix — the engine treats plain millis as a value, not JS).
  if (/^\d+$/.test(trimmed)) return trimmed;

  // ISO8601 or any other string JavaScript's Date.parse() understands.
  // Convert to epoch millis as a literal string.
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return String(parsed);
  }

  // Unknown format — pass through and let the server reject it loudly.
  return trimmed;
}

/** Expose for validation at the tool layer. */
export function parseTimeExpression(expr: string): string {
  return normalizeTimeExpression(expr);
}

interface SubmitResponse {
  queryId: string;
}

async function submitQuery(
  env: EnvConfig,
  body: Record<string, unknown>
): Promise<SubmitResponse> {
  const base = getStreamerUrl();
  const resp = await fetch(`${base}/streamer/query`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Streamer POST /streamer/query HTTP ${resp.status}: ${errText.slice(0, 500)}`);
  }

  const parsed = (await resp.json()) as SubmitResponse;
  if (!parsed.queryId) {
    throw new Error('Streamer response missing queryId');
  }
  return parsed;
}

interface S3ListEntry {
  Key: string;
  Size: number;
}

async function s3List(bucket: string, prefix: string): Promise<S3ListEntry[]> {
  try {
    const { stdout } = await execFileP('aws', [
      's3api',
      'list-objects-v2',
      '--bucket',
      bucket,
      '--prefix',
      prefix,
      '--output',
      'json',
    ], { maxBuffer: 32 * 1024 * 1024 });

    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as { Contents?: S3ListEntry[] };
    return parsed.Contents || [];
  } catch (e) {
    // list-objects-v2 returns empty stdout when the prefix has no keys;
    // only real failures raise.
    const err = e as { stderr?: string; message?: string };
    const stderr = err.stderr || err.message || '';
    if (stderr.includes('NoSuchBucket')) {
      throw new Error(`Streamer bucket does not exist: ${bucket}`);
    }
    throw new Error(`aws s3api list-objects-v2 failed: ${stderr.slice(0, 400)}`);
  }
}

async function s3Get(bucket: string, key: string): Promise<string> {
  const { stdout } = await execFileP('aws', [
    's3',
    'cp',
    `s3://${bucket}/${key}`,
    '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function parseJsonl(content: string): StreamerEvent[] {
  const events: StreamerEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      let parsed: unknown = JSON.parse(trimmed);
      // Defend against double-encoded events: if the JSONL line parses to
      // a STRING (not an object), the upstream writer serialized an event
      // to JSON, then wrapped the result in another string literal. Re-parse
      // once to recover the real object. Seen in the otel-k8s sample where
      // events are captured as JSON strings embedded in a fluent-bit
      // tenx_tag field. Without this guard, downstream code that treats
      // ev as an object throws `Cannot create property 'enrichedFields' on
      // string '{...}'`.
      if (typeof parsed === 'string') {
        try {
          const reparsed = JSON.parse(parsed);
          if (reparsed && typeof reparsed === 'object') {
            parsed = reparsed;
          } else {
            continue; // still not an object — skip this line
          }
        } catch {
          continue; // double-encoded-but-not-valid-JSON; skip
        }
      }
      if (!parsed || typeof parsed !== 'object') continue;
      // Shape guard: discard records that don't look like real streamer
      // events. The upstream writer on the demo env has a bug where `text`
      // field values contain literal unescaped newlines, so our
      // split(/\r?\n/) breaks real event records into fragments. Some
      // fragments happen to be valid JSON themselves (e.g. the fluentd
      // stream/log/docker/kubernetes/tenx_tag shape embedded inside the
      // `text` field). Without a guard, those get pushed as "events" with
      // bogus shapes and pollute downstream rollups ("unknown: 9" in the
      // count summary).
      //
      // Real streamer events always have at least one of:
      //   - `timestamp` (as scalar or [scalar])
      //   - `text` (the raw content field)
      //   - `tenx_user_service` or `tenx_user_process` (enrichment labels)
      //   - `LevelTemplate.severity_level` or `MessageTemplate.message_pattern`
      // Fluentd-wrapped fragments have NONE of these — they have
      // `stream`, `log`, `docker`, `kubernetes`, `tenx_tag` instead.
      const obj = parsed as Record<string, unknown>;
      const hasRealEventShape =
        'timestamp' in obj ||
        'text' in obj ||
        'tenx_user_service' in obj ||
        'tenx_user_process' in obj ||
        'LevelTemplate.severity_level' in obj ||
        'MessageTemplate.message_pattern' in obj;
      if (!hasRealEventShape) continue;
      events.push(parsed as StreamerEvent);
    } catch {
      // Skip unparseable lines — the worker may have written a partial
      // record on the way down; the next poll will pick up the retry.
    }
  }
  return events;
}

function eventTimestampMs(ev: StreamerEvent): number {
  let ts: unknown = ev.timestamp;
  // Streamer encodes the TenXObject timestamp as `[<epoch-nanos>]`.
  if (Array.isArray(ts) && ts.length > 0) {
    ts = ts[0];
  }
  if (typeof ts === 'number') {
    // Heuristic: >1e15 → nanos, >1e12 → micros, >1e10 → millis, else seconds.
    if (ts > 1e15) return Math.floor(ts / 1_000_000);
    if (ts > 1e12) return Math.floor(ts / 1_000);
    if (ts > 1e10) return ts;
    return ts * 1000;
  }
  if (typeof ts === 'string') {
    const asNum = Number(ts);
    if (Number.isFinite(asNum)) {
      if (asNum > 1e15) return Math.floor(asNum / 1_000_000);
      if (asNum > 1e12) return Math.floor(asNum / 1_000);
      if (asNum > 1e10) return asNum;
      return asNum * 1000;
    }
    const asDate = Date.parse(ts);
    if (Number.isFinite(asDate)) return asDate;
  }
  return 0;
}

interface MarkerPollResult {
  entries: S3ListEntry[];
  timedOut: boolean;
}

/**
 * Poll the marker prefix until the same set of markers is observed twice in
 * a row (stability = no new workers landing). Returns the stable list of
 * marker keys along with whether the poll timed out before reaching stability.
 */
async function waitForMarkerStability(
  bucket: string,
  markerPrefix: string,
  pollMs: number,
  timeoutMs: number
): Promise<MarkerPollResult> {
  const started = Date.now();
  let previous: string[] = [];
  let stableCount = 0;

  while (Date.now() - started < timeoutMs) {
    const entries = await s3List(bucket, markerPrefix);
    const keys = entries.map((e) => e.Key).sort();

    if (keys.length > 0 && keys.length === previous.length && keys.every((k, i) => k === previous[i])) {
      stableCount++;
      if (stableCount >= 2) {
        return { entries, timedOut: false };
      }
    } else {
      stableCount = keys.length > 0 ? 1 : 0;
    }
    previous = keys;
    await sleep(pollMs);
  }

  // Timed out — return whatever we saw last so the caller can surface a
  // partial result rather than a hard failure.
  return {
    entries: previous.map((key) => ({ Key: key, Size: 0 })),
    timedOut: true,
  };
}

export async function runStreamerQuery(
  env: EnvConfig,
  req: StreamerQueryRequest,
  // Legacy options kept for call-site compatibility. The poll interval and
  // timeout are now taken from environment variables; this argument is
  // accepted but has no effect.
  _legacy?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<StreamerQueryResponse> {
  const bucket = getStreamerBucket();
  const target = req.target || getDefaultTarget();
  const queryId = randomUUID();
  const pollMs = parseInt(process.env.LOG10X_STREAMER_POLL_MS || '1500', 10);
  const timeoutMs = parseInt(process.env.LOG10X_STREAMER_TIMEOUT_MS || '30000', 10);

  // Minimal body format — matches the shape the engine's query-handler
  // actually expects (verified live on the otel-demo env 2026-04-15).
  // Previously the MCP sent `target`, `readContainer`, `indexContainer`,
  // `objectStorageName`, `processingTime`, `resultSize` fields which the
  // engine silently ignored — but the missing `name` field caused the
  // query-handler to drop the request without any log trace. The `name`
  // field becomes `queryName` in the engine override chain and is used
  // as the input stream handle inside the pipeline. GAPS G12.
  //
  // Fields that belong in the body:
  //   name           — logical query name, used as the stream handle
  //   from / to      — must be `$=now(...)` runtime-eval form or epoch ms
  //   search         — Bloom-filter-level (fast, index-scoped)
  //   filters        — JS-expression post-filter (in-memory after decode)
  //   writeResults   — gates JSONL output to the `qr/{queryId}/` prefix
  //   id             — correlation key the MCP uses to poll S3 markers
  //
  // Fields that MUST NOT be in the body (all defaulted from handler config):
  //   target, readContainer, indexContainer, objectStorageName,
  //   processingTime, resultSize — sending these causes the engine to
  //   reject the query shape and silently drop it.
  const body: Record<string, unknown> = {
    id: queryId,
    name: req.name || `mcp-${queryId.slice(0, 8)}`,
    from: normalizeTimeExpression(req.from),
    to: normalizeTimeExpression(req.to || 'now'),
    search: req.search || '',
    filters: req.filters || [],
    writeResults: true,
    logLevels: 'INFO,PERF,ERROR,DEBUG',
  };

  const started = Date.now();
  await submitQuery(env, body);

  // The engine's indexObjectPath builds `tenx/{target}/q(r)/{queryId}/`
  // under the configured indexContainer. On the otek demo env the
  // indexContainer is `tenx-demo-cloud-streamer-351939435334/indexing-results/`
  // so the full S3 key is `indexing-results/tenx/{target}/...`. The
  // `LOG10X_STREAMER_INDEX_SUBPATH` env var lets deployments configure
  // their own index sub-prefix; default to `indexing-results` to match
  // the otek deploy.
  const indexSubpath = (process.env.LOG10X_STREAMER_INDEX_SUBPATH || 'indexing-results').replace(/^\/+|\/+$/g, '');
  const basePrefix = indexSubpath ? `${indexSubpath}/` : '';
  const markerPrefix = `${basePrefix}tenx/${target}/q/${queryId}/`;
  const resultsPrefix = `${basePrefix}tenx/${target}/qr/${queryId}/`;

  const markerPoll = await waitForMarkerStability(bucket, markerPrefix, pollMs, timeoutMs);

  // The results writer only runs on workers that actually matched events, so
  // the results prefix may have fewer entries than the marker prefix — which
  // is correct. Truncation markers are siblings ending in `.truncated`.
  const resultObjects = await s3List(bucket, resultsPrefix);

  let truncated = false;
  const jsonlKeys: string[] = [];
  for (const obj of resultObjects) {
    if (obj.Key.endsWith('.truncated')) {
      truncated = true;
      continue;
    }
    if (obj.Key.endsWith('.jsonl')) {
      jsonlKeys.push(obj.Key);
    }
  }

  const events: StreamerEvent[] = [];
  for (const key of jsonlKeys) {
    const content = await s3Get(bucket, key);
    events.push(...parseJsonl(content));
  }

  events.sort((a, b) => eventTimestampMs(a) - eventTimestampMs(b));

  // Backfill legacy event fields from canonical enrichment fields so that
  // downstream code written against the old shape (aggregator, backfill)
  // keeps working. This is a shallow rename — we do not clone the event.
  for (const ev of events) {
    // The engine emits severity_level as the template-qualified path
    // `LevelTemplate.severity_level`. Normalize it back to the plain
    // field name the tool layer and aggregator expect.
    const levelTemplated = (ev as Record<string, unknown>)['LevelTemplate.severity_level'];
    if (ev.severity_level == null && typeof levelTemplated === 'string') {
      ev.severity_level = levelTemplated;
    }
    if (ev.service == null && typeof ev.tenx_user_service === 'string') {
      ev.service = ev.tenx_user_service;
    }
    if (ev.severity == null && typeof ev.severity_level === 'string') {
      ev.severity = ev.severity_level;
    }
    if (ev.enrichedFields == null) {
      const enriched: Record<string, string> = {};
      for (const [k, v] of Object.entries(ev)) {
        if (
          v != null &&
          typeof v !== 'object' &&
          k !== 'timestamp' &&
          k !== 'text' &&
          k !== 'service' &&
          k !== 'severity' &&
          k !== 'templateHash' &&
          k !== 'values' &&
          k !== 'enrichedFields'
        ) {
          enriched[k] = String(v);
        }
      }
      ev.enrichedFields = enriched;
    }
  }

  const limit = req.limit ?? 10_000;
  let finalEvents = events;
  if (events.length > limit) {
    finalEvents = events.slice(0, limit);
    truncated = true;
  }

  // Populate legacy aggregation fields from events for old callers.
  const buckets = computeBuckets(finalEvents, req.bucketSize || '5m');
  const countSummary = computeCountSummary(finalEvents);

  const response: StreamerQueryResponse = {
    queryId,
    target,
    from: String(body.from),
    to: String(body.to),
    execution: {
      wallTimeMs: Date.now() - started,
      eventsMatched: events.length,
      workerFiles: jsonlKeys.length,
      truncated,
    },
    events: finalEvents,
    format: req.format || 'events',
    buckets,
    countSummary,
  };

  // Fetch CW diagnostics. Polling errors surface via diagnostics.pollingError.
  await attachDiagnostics(response, started);

  // If the marker poll timed out, the server query may still be running —
  // flag that for the caller.
  if (markerPoll.timedOut) {
    if (!response.diagnostics) response.diagnostics = {};
    response.diagnostics.partialResults = true;
  }

  return response;
}

function computeBuckets(events: StreamerEvent[], bucketSize: string): StreamerBucket[] {
  const m = bucketSize.trim().match(/^(\d+)([smhd])$/);
  let bucketMs = 5 * 60_000;
  if (m) {
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 's':
        bucketMs = n * 1000;
        break;
      case 'm':
        bucketMs = n * 60_000;
        break;
      case 'h':
        bucketMs = n * 3_600_000;
        break;
      case 'd':
        bucketMs = n * 86_400_000;
        break;
    }
  }
  const out = new Map<number, number>();
  for (const ev of events) {
    const ts = eventTimestampMs(ev);
    if (!ts) continue;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return [...out.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, count]) => ({ timestamp: new Date(ts).toISOString(), count }));
}

function computeCountSummary(events: StreamerEvent[]): StreamerQueryResponse['countSummary'] {
  const byService: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byDay: Record<string, number> = {};

  for (const ev of events) {
    const svc = (ev.tenx_user_service as string) || (ev.service as string) || '';
    if (svc) byService[svc] = (byService[svc] || 0) + 1;

    const sev = (ev.severity_level as string) || (ev.severity as string) || '';
    if (sev) bySeverity[sev] = (bySeverity[sev] || 0) + 1;

    const ts = eventTimestampMs(ev);
    if (ts) {
      const day = new Date(ts).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
  }

  return {
    total: events.length,
    byService,
    bySeverity,
    byDay,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CloudWatch Logs diagnostics — polls the query's CW log streams to extract
// structured execution metadata (scan stats, query plan, errors, worker stats)
// ---------------------------------------------------------------------------

interface CWEvent {
  level: string;
  message: string;
  data?: Record<string, number | string>;
  /** CW event timestamp in ms. */
  ts: number;
}

const CW_POLL_CONCURRENCY = 8;
const CW_POLL_MAX_STREAMS = 500;

/**
 * Fetch CloudWatch log events for a given queryId, bounded by an optional
 * time window. Streams are listed by prefix, events fetched in parallel.
 *
 * @throws PollingError when AWS CLI is missing or the log group is inaccessible
 */
async function fetchQueryCWEvents(
  queryId: string,
  logGroup: string,
  startTimeMs?: number,
): Promise<CWEvent[]> {
  // List log streams matching the queryId prefix (fail loud — caller decides fallback)
  const listArgs = [
    'logs', 'describe-log-streams',
    '--log-group-name', logGroup,
    '--log-stream-name-prefix', `${queryId}/`,
    '--no-paginate',
  ];
  const { stdout: listOut } = await execFileP('aws', listArgs, { maxBuffer: 10 * 1024 * 1024 });
  const listed = JSON.parse(listOut);
  const streams: string[] = (listed.logStreams || [])
    .map((s: { logStreamName: string }) => s.logStreamName)
    .slice(0, CW_POLL_MAX_STREAMS);

  if (streams.length === 0) return [];

  // Fetch all streams in bounded parallelism
  const events: CWEvent[] = [];
  const getArgsBase = [
    'logs', 'get-log-events',
    '--log-group-name', logGroup,
    '--no-paginate',
    '--start-from-head',
    ...(startTimeMs ? ['--start-time', String(startTimeMs)] : []),
  ];

  const queue = [...streams];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CW_POLL_CONCURRENCY, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const stream = queue.shift();
        if (!stream) break;
        try {
          const { stdout } = await execFileP(
            'aws',
            [...getArgsBase, '--log-stream-name', stream],
            { maxBuffer: 10 * 1024 * 1024 },
          );
          const parsed = JSON.parse(stdout);
          for (const ev of parsed.events || []) {
            try {
              const body = JSON.parse(ev.message) as Omit<CWEvent, 'ts'>;
              events.push({ ...body, ts: ev.timestamp });
            } catch {
              // skip non-JSON event bodies
            }
          }
        } catch {
          // per-stream failures are tolerated (stream may be empty or mid-write)
        }
      }
    })());
  }
  await Promise.all(workers);

  events.sort((a, b) => a.ts - b.ts);
  return events;
}

/**
 * Build diagnostics from CW events. Deterministic: each event contributes
 * to exactly one field so aggregation is idempotent across re-polls.
 */
export function buildDiagnostics(cwEvents: CWEvent[]): StreamerQueryDiagnostics {
  const diag: StreamerQueryDiagnostics = {};
  const errors: string[] = [];

  let workersStarted = 0;
  let workersComplete = 0;
  let totalFetchedBytes = 0;
  let totalResultEvents = 0;

  for (const ev of cwEvents) {
    const msg = ev.message;
    const data = ev.data || {};

    if (msg.startsWith('query plan:')) {
      const dispatch = data.dispatch as string;
      diag.queryPlan = {
        templateHashes: (data.templateHashes as number) ?? 0,
        vars: (data.vars as number) ?? 0,
        timeslice: (data.timeslice as number) ?? 0,
        dispatch: (dispatch === 'local' || dispatch === 'remote') ? dispatch : 'unknown',
      };
    } else if (msg.startsWith('query empty:')) {
      diag.emptyReason = (data.reason as string) || 'no_template_hashes_or_vars';
    } else if (msg.startsWith('scan complete:')) {
      if (!diag.scanStats) {
        diag.scanStats = { scanned: 0, matched: 0, skippedSearch: 0, skippedTemplate: 0, skippedDuplicate: 0 };
      }
      diag.scanStats.scanned += (data.scanned as number) || 0;
      diag.scanStats.matched += (data.matched as number) || 0;
      diag.scanStats.skippedSearch += (data.skippedSearch as number) || 0;
      diag.scanStats.skippedTemplate += (data.skippedTemplate as number) || 0;
      diag.scanStats.skippedDuplicate += (data.skippedDuplicate as number) || 0;
    } else if (msg.startsWith('stream dispatch:')) {
      if (!diag.streamDispatch) {
        diag.streamDispatch = { requests: 0, objects: 0, blobs: 0 };
      }
      diag.streamDispatch.requests += (data.requests as number) || 0;
      diag.streamDispatch.objects += (data.objects as number) || 0;
      diag.streamDispatch.blobs += (data.blobs as number) || 0;
    } else if (msg.startsWith('query complete:') && data.elapsedMs !== undefined) {
      // Only record the FIRST (main coordinator) "query complete" we see.
      // Sub-queries also emit this but with shorter elapsed values.
      if (diag.coordinatorElapsedMs === undefined) {
        diag.coordinatorElapsedMs = data.elapsedMs as number;
      }
    } else if (msg.startsWith('stream worker started:')) {
      workersStarted++;
    } else if (msg.startsWith('stream worker complete:')) {
      workersComplete++;
      totalFetchedBytes += (data.fetchedBytes as number) || 0;
    } else if (msg.startsWith('results writer complete:')) {
      totalResultEvents += (data.resultEvents as number) || 0;
    }

    if (ev.level === 'ERROR') {
      errors.push(msg);
    }
  }

  if (workersStarted > 0 || workersComplete > 0) {
    diag.workerStats = { started: workersStarted, complete: workersComplete, totalFetchedBytes, totalResultEvents };
  }

  if (errors.length > 0) {
    diag.errors = errors;
  }

  return diag;
}

/**
 * Populate diagnostics into the response object. CW polling failures surface
 * as `diagnostics.pollingError`, not silent undefined.
 */
async function attachDiagnostics(
  resp: StreamerQueryResponse,
  queryStartTimeMs: number,
): Promise<void> {
  const logGroup = process.env.LOG10X_STREAMER_LOG_GROUP;
  if (!logGroup) {
    resp.diagnostics = { pollingError: 'LOG10X_STREAMER_LOG_GROUP not set; diagnostics unavailable.' };
    return;
  }

  try {
    const cwEvents = await fetchQueryCWEvents(resp.queryId, logGroup, queryStartTimeMs);
    resp.diagnostics = buildDiagnostics(cwEvents);
  } catch (e) {
    resp.diagnostics = {
      pollingError: `CW polling failed: ${(e as Error).message.slice(0, 200)}`,
    };
  }
}

/**
 * Look up current execution diagnostics for a previously-submitted queryId.
 * Use this after runStreamerQuery returns `partialResults: true` to check
 * whether the server query has finished.
 *
 * @throws on CW polling failure — caller decides how to handle
 */
export async function getStreamerQueryStatus(
  queryId: string,
  queryStartTimeMs: number,
): Promise<StreamerQueryDiagnostics> {
  const logGroup = process.env.LOG10X_STREAMER_LOG_GROUP;
  if (!logGroup) {
    return { pollingError: 'LOG10X_STREAMER_LOG_GROUP not set; diagnostics unavailable.' };
  }
  try {
    const cwEvents = await fetchQueryCWEvents(queryId, logGroup, queryStartTimeMs);
    return buildDiagnostics(cwEvents);
  } catch (e) {
    return { pollingError: `CW polling failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

/**
 * Generate a human-readable explanation for a zero-result query.
 * Returns null when no specific explanation can be derived — callers should
 * fall back to a generic message.
 */
export function explainZeroResults(diag: StreamerQueryDiagnostics): string | null {
  if (diag.pollingError) {
    return `Diagnostics unavailable: ${diag.pollingError}`;
  }

  if (diag.emptyReason) {
    return 'The search expression produced no Bloom filter tokens (0 template hashes, 0 vars). ' +
      'The field names in the search may not match any indexed enrichment fields or text patterns.';
  }

  if (diag.errors && diag.errors.length > 0) {
    return `Query encountered ${diag.errors.length} error(s): ${diag.errors[0]}`;
  }

  if (diag.scanStats) {
    if (diag.scanStats.scanned === 0) {
      return 'No index objects found for the target/time range. ' +
        'The indexer may not have processed data for this time window yet.';
    }
    if (diag.scanStats.matched === 0) {
      return `The Bloom filter scanned ${diag.scanStats.scanned} index objects and none matched. ` +
        `${diag.scanStats.skippedSearch} skipped by search filter, ${diag.scanStats.skippedTemplate} by template filter. ` +
        'The search tokens do not exist in the archive for this time range.';
    }
    // Bloom matched but no result events — distinguish timeout from false-positive
    if (diag.scanStats.matched > 0 && (!diag.workerStats || diag.workerStats.totalResultEvents === 0)) {
      if (diag.workerStats && diag.workerStats.complete < diag.workerStats.started) {
        return `The Bloom filter matched ${diag.scanStats.matched} index objects and ${diag.workerStats.started} workers were dispatched, ` +
          `but only ${diag.workerStats.complete} completed before the poll timed out. Results may still be arriving — ` +
          'call log10x_streamer_query_status for an updated snapshot.';
      }
      return `The Bloom filter matched ${diag.scanStats.matched} index objects, but stream workers decoded 0 matching events. ` +
        'Most likely cause: Bloom filter false positives — the search tokens exist in the index but the actual events do not match the full search expression.';
    }
  }

  // queryPlan present but no scanStats — sub-queries dispatched but none reported scan completion.
  // Note: this inference is weaker than the direct scanStats.scanned===0 case. Possible causes:
  // no index objects in range, SQS delivery failed, CW buffer not flushed, sub-query crashed.
  if (diag.queryPlan && !diag.scanStats) {
    return 'Query ran but no sub-query reported scan completion. Likely causes (in order of probability): ' +
      '(a) no index objects exist for the time range — try an older window or verify the indexer is running; ' +
      '(b) sub-queries are still executing and CW events have not flushed yet — retry status poll; ' +
      '(c) SQS dispatch failed — check streamer logs.';
  }

  if (diag.partialResults) {
    return 'MCP poll timeout reached before the server query completed. Some results may still be written to S3. ' +
      'Call log10x_streamer_query_status for an updated snapshot.';
  }

  return null;
}
