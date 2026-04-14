/**
 * Log10x Storage Streamer REST client.
 *
 * The Streamer's query API is not yet a public endpoint — it ships with
 * the customer's own Streamer deployment. This client is written against
 * the contract documented in:
 *   config/comsite/tools/mcp/log10x-mcp-streamer-tools-build-spec.md
 *   config/modules/pipelines/run/modules/input/objectStorage/query/
 *
 * Configure with the LOG10X_STREAMER_URL env var. When not set, every
 * call throws a `StreamerNotConfiguredError` which the higher-level tools
 * catch and turn into a graceful "Streamer not configured" message.
 *
 * Authentication piggybacks on the same X-10X-Auth header the Prometheus
 * gateway uses (apiKey/envId), matching the pattern from
 * backend/lambdas/prometheus-proxy. If the Streamer deployment uses a
 * different auth scheme (IAM, mTLS), set LOG10X_STREAMER_AUTH_HEADER to
 * override the header name and LOG10X_STREAMER_AUTH_VALUE to override
 * the value.
 */

import type { EnvConfig } from './environments.js';

export class StreamerNotConfiguredError extends Error {
  constructor() {
    super(
      'Streamer endpoint not configured. Set LOG10X_STREAMER_URL to enable archive queries. ' +
      'Without it, log10x_streamer_query, log10x_backfill_metric, and the Phase 6 Streamer ' +
      'fallback inside log10x_investigate will degrade gracefully.'
    );
    this.name = 'StreamerNotConfiguredError';
  }
}

export interface StreamerQueryRequest {
  /** Template hash (`~xxx`) or symbolMessage to scope the query. */
  pattern: string;
  /** Absolute ISO8601 timestamp or relative (`now-90d`). */
  from: string;
  /** Absolute ISO8601 or relative (`now`). */
  to: string;
  /** Optional search expression on enriched fields. */
  search?: string;
  /** Optional JavaScript filter expressions over parsed event payloads. */
  filters?: string[];
  /** Optional target service/app scope. */
  target?: string;
  /** Max events to return. Default 10000. */
  limit?: number;
  /** `events` (raw), `count` (summary only), `aggregated` (bucketed counts). */
  format?: 'events' | 'count' | 'aggregated';
  /** Bucket size when format=aggregated. Default "5m". */
  bucketSize?: string;
}

export interface StreamerEvent {
  timestamp: string;
  service?: string;
  severity?: string;
  templateHash: string;
  text: string;
  enrichedFields?: Record<string, string>;
  /** Variable values extracted from the event in slot order. */
  values?: string[];
}

export interface StreamerBucket {
  timestamp: string;
  count: number;
  labels?: Record<string, string>;
}

export interface StreamerQueryResponse {
  queryId: string;
  pattern: string;
  from: string;
  to: string;
  execution: {
    wallTimeMs: number;
    bytesScanned?: string;
    eventsMatched: number;
    scanWorkersUsed?: number;
    streamWorkersUsed?: number;
    truncated?: boolean;
  };
  format: 'events' | 'count' | 'aggregated';
  events?: StreamerEvent[];
  buckets?: StreamerBucket[];
  countSummary?: {
    total: number;
    byDay?: Record<string, number>;
    byService?: Record<string, number>;
    bySeverity?: Record<string, number>;
  };
}

export function isStreamerConfigured(): boolean {
  return Boolean(process.env.LOG10X_STREAMER_URL);
}

function getStreamerUrl(): string {
  const url = process.env.LOG10X_STREAMER_URL;
  if (!url) throw new StreamerNotConfiguredError();
  return url.replace(/\/+$/, '');
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

/** Build the Streamer request body per the documented contract. */
export function buildQueryBody(req: StreamerQueryRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: req.from,
    to: req.to,
    pattern: req.pattern,
    limit: req.limit ?? 10000,
    format: req.format ?? 'events',
  };
  if (req.search) body.search = req.search;
  if (req.filters && req.filters.length > 0) body.filters = req.filters;
  if (req.target) body.target = req.target;
  if (req.format === 'aggregated') body.bucketSize = req.bucketSize ?? '5m';
  return body;
}

/**
 * Submit a query to the Streamer and return the parsed response.
 *
 * The Streamer API is async: POST returns a queryId, and the client polls
 * GET /streamer/query/{id} until the query finishes or the timeout is
 * reached. For the MVP, we call POST and, if the response is synchronous
 * (results in-body), return directly; otherwise we poll once at 500ms and
 * every subsequent second up to the configured timeout.
 */
export async function runStreamerQuery(
  env: EnvConfig,
  req: StreamerQueryRequest,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<StreamerQueryResponse> {
  const base = getStreamerUrl();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  const started = Date.now();
  const body = buildQueryBody(req);

  const submit = await fetch(`${base}/streamer/query`, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify(body),
  });

  if (!submit.ok) {
    const errText = await submit.text().catch(() => '');
    throw new Error(`Streamer /streamer/query HTTP ${submit.status}: ${errText.slice(0, 500)}`);
  }

  const first = (await submit.json()) as StreamerQueryResponse & { status?: string };

  // Synchronous path: results already in-body.
  if (first.events || first.buckets || first.countSummary) {
    return normalize(first, req, Date.now() - started);
  }

  // Async path: poll by queryId.
  const queryId = first.queryId;
  if (!queryId) {
    throw new Error('Streamer response missing queryId and no inline results.');
  }

  while (Date.now() - started < timeoutMs) {
    await sleep(pollIntervalMs);
    const poll = await fetch(`${base}/streamer/query/${encodeURIComponent(queryId)}`, {
      method: 'GET',
      headers: authHeaders(env),
    });
    if (!poll.ok) {
      const errText = await poll.text().catch(() => '');
      throw new Error(`Streamer poll HTTP ${poll.status}: ${errText.slice(0, 500)}`);
    }
    const state = (await poll.json()) as StreamerQueryResponse & { status?: string; done?: boolean };
    if (state.done || state.status === 'done' || state.events || state.buckets || state.countSummary) {
      return normalize(state, req, Date.now() - started);
    }
  }

  throw new Error(`Streamer query timed out after ${timeoutMs}ms (queryId=${queryId}).`);
}

function normalize(
  resp: StreamerQueryResponse & { status?: string },
  req: StreamerQueryRequest,
  wallTimeMs: number
): StreamerQueryResponse {
  return {
    queryId: resp.queryId || 'inline',
    pattern: resp.pattern || req.pattern,
    from: resp.from || req.from,
    to: resp.to || req.to,
    execution: {
      wallTimeMs: resp.execution?.wallTimeMs ?? wallTimeMs,
      bytesScanned: resp.execution?.bytesScanned,
      eventsMatched:
        resp.execution?.eventsMatched ??
        (resp.events?.length ?? resp.buckets?.reduce((s, b) => s + b.count, 0) ?? 0),
      scanWorkersUsed: resp.execution?.scanWorkersUsed,
      streamWorkersUsed: resp.execution?.streamWorkersUsed,
      truncated: resp.execution?.truncated,
    },
    format: resp.format || req.format || 'events',
    events: resp.events,
    buckets: resp.buckets,
    countSummary: resp.countSummary,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Relative-time parsing ──

/**
 * Parse a time expression like `now`, `now-15d`, `2026-01-15T00:00:00Z`
 * into a JavaScript Date. Used by the higher-level tools to build the
 * Streamer query window.
 */
export function parseTimeExpression(expr: string, reference: Date = new Date()): Date {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error('Empty time expression');
  if (trimmed === 'now') return new Date(reference.getTime());

  const rel = trimmed.match(/^now\s*([+-])\s*(\d+)\s*([smhdwMy])$/);
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const amount = parseInt(rel[2], 10);
    const unit = rel[3];
    const ms = sign * amount * unitToMs(unit);
    return new Date(reference.getTime() + ms);
  }

  const d = new Date(trimmed);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid time expression: "${expr}"`);
  }
  return d;
}

function unitToMs(unit: string): number {
  switch (unit) {
    case 's':
      return 1000;
    case 'm':
      return 60_000;
    case 'h':
      return 3_600_000;
    case 'd':
      return 86_400_000;
    case 'w':
      return 7 * 86_400_000;
    case 'M':
      return 30 * 86_400_000;
    case 'y':
      return 365 * 86_400_000;
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}
