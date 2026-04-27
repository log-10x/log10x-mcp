/**
 * Datadog Logs connector.
 *
 * Uses the Logs API `searchLogs` (v2) endpoint with cursor pagination.
 * `DD_SITE` (or `DATADOG_SITE`) routes between US/EU/… endpoints; we
 * rely on the SDK's built-in site configuration so US1/EU1/US3/US5/AP1
 * all work without code changes.
 *
 * Credential discovery: `DD_API_KEY` + `DD_APP_KEY` (also accepts
 * `DATADOG_*` variants) — both are required by the Logs API.
 */

import { client, v2 } from '@datadog/datadog-api-client';

import type {
  SiemConnector,
  CredentialDiscovery,
  PullEventsOptions,
  PullEventsResult,
  PullStopReason,
  VolumeDetectionOptions,
  VolumeDetectionResult,
} from './index.js';

import { retryWithBackoff, shouldStop, parseWindowMs } from './_retry.js';
import { randomTimeBuckets, perBucketCap } from './_sampling.js';

function getKeys(): { apiKey?: string; appKey?: string; site?: string } {
  return {
    apiKey: process.env.DD_API_KEY || process.env.DATADOG_API_KEY,
    appKey: process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY,
    site: process.env.DD_SITE || process.env.DATADOG_SITE,
  };
}

async function discoverCredentials(): Promise<CredentialDiscovery> {
  const { apiKey, appKey, site } = getKeys();
  if (apiKey && appKey) {
    return {
      available: true,
      source: 'env',
      details: {
        site: site || 'datadoghq.com (default US1)',
        api_key_masked: `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`,
      },
    };
  }
  return { available: false, source: 'none' };
}

async function pullEvents(opts: PullEventsOptions): Promise<PullEventsResult> {
  const { apiKey, appKey, site } = getKeys();
  if (!apiKey || !appKey) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: '',
        reasonStopped: 'error',
        notes: ['DD_API_KEY and DD_APP_KEY must be set.'],
      },
    };
  }

  const configuration = client.createConfiguration({
    authMethods: { apiKeyAuth: apiKey, appKeyAuth: appKey },
  });
  if (site) {
    configuration.setServerVariables({ site });
  }
  const api = new v2.LogsApi(configuration);

  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const toMs = Date.now();
  const fromMs = toMs - windowMs;

  // Compose the query. `scope` is treated as an index name (the index
  // facet is `index:<name>`); `query` is the free-text filter.
  const queryParts: string[] = [];
  if (opts.scope) queryParts.push(`index:${opts.scope}`);
  if (opts.query) queryParts.push(opts.query);
  const queryStr = queryParts.join(' ').trim();

  const events: unknown[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';
  const notes: string[] = [];
  let skippedNoMessage = 0;

  // Stratified random sampling: 24 child sub-windows scattered across
  // the parent window with per-run RNG. Successive POC runs against the
  // same window draw non-overlapping samples (sample-overlap ≈ 0%
  // instead of the prior 100%). Per-bucket event cap keeps any single
  // bucket from monopolizing the global target.
  const BUCKET_COUNT = 24;
  const buckets = randomTimeBuckets(fromMs, toMs, BUCKET_COUNT);
  const bucketCap = perBucketCap(opts.targetEventCount, BUCKET_COUNT);
  const pageLimit = Math.min(1000, bucketCap); // Datadog caps at 5000.

  bucketLoop: for (const bucket of buckets) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    let cursor: string | undefined;
    let bucketEvents = 0;
    while (bucketEvents < bucketCap) {
      if (shouldStop(deadline, events.length, opts.targetEventCount)) {
        reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
        break bucketLoop;
      }
      try {
        const resp = await retryWithBackoff(() =>
          api.listLogsGet({
            filterQuery: queryStr || undefined,
            filterFrom: new Date(bucket.fromMs),
            filterTo: new Date(bucket.toMs),
            pageCursor: cursor,
            pageLimit,
            sort: 'timestamp',
          })
        );
        const data = resp.data || [];
        for (const ev of data) {
          if (bucketEvents >= bucketCap) break;
          const message = extractMessage(ev);
          if (message === null) {
            // Custom-format ingests sometimes have neither
            // attributes.message nor attributes.attributes.* populated.
            // Skip rather than push `undefined` into the event stream;
            // pattern-extraction would otherwise fingerprint a phantom
            // "undefined" template.
            skippedNoMessage++;
            continue;
          }
          events.push({
            timestamp: ev.attributes?.timestamp,
            message,
            service: ev.attributes?.service,
            status: ev.attributes?.status,
            tags: ev.attributes?.tags,
            host: ev.attributes?.host,
            attributes: ev.attributes?.attributes,
          });
          bucketEvents++;
        }
        const nextCursor = resp.meta?.page?.after;
        if (!nextCursor || data.length === 0) break; // bucket exhausted
        cursor = nextCursor;
        opts.onProgress({
          step: `datadog bucket ${bucket.index + 1}/${BUCKET_COUNT} (${bucketEvents}/${bucketCap})`,
          pct: Math.min(50, Math.round(((bucket.index + bucketEvents / bucketCap) / BUCKET_COUNT) * 50)),
          eventsFetched: events.length,
        });
      } catch (e) {
        notes.push(`datadog_bucket_${bucket.index}_error: ${(e as Error).message.slice(0, 200)}`);
        // Per-bucket failures are non-fatal; move to the next bucket.
        break;
      }
    }
  }

  if (skippedNoMessage > 0) {
    notes.push(
      `skipped ${skippedNoMessage} event(s) with no resolvable message body (custom-format ingest with empty attributes.message and attributes.attributes.*)`
    );
  }

  const truncated = reasonStopped !== 'source_exhausted' && events.length < opts.targetEventCount;
  return {
    events,
    metadata: {
      actualCount: events.length,
      truncated,
      queryUsed: queryStr || '(no filter)',
      reasonStopped,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

/**
 * Pull a usable message body off a Datadog log event.
 *
 * The standard shape is `attributes.message` (string). Custom-format
 * ingests can populate `attributes.attributes.<field>` instead, with
 * the original message buried under a customer-chosen key. Fall
 * through:
 *   1. attributes.message — happy path, ~95% of events.
 *   2. attributes.attributes.message — common custom-format aliasing.
 *   3. attributes.attributes.log / .body / .raw — vendor variants.
 *   4. JSON.stringify(attributes.attributes) — last resort, gives the
 *      pattern templater something to fingerprint instead of `undefined`.
 *
 * Returns null when every path is empty, so the caller can skip the
 * event and surface the count in metadata. The prior `?.message`
 * shortcut returned `undefined`, which then became the literal string
 * "undefined" after `events.join('\n')` in pattern-extraction and got
 * fingerprinted as a phantom pattern.
 */
function extractMessage(ev: unknown): string | null {
  const e = ev as { attributes?: Record<string, unknown> };
  const attrs = e?.attributes;
  if (!attrs || typeof attrs !== 'object') return null;
  const direct = attrs.message;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const nested = attrs.attributes as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object') {
    for (const key of ['message', 'log', 'body', 'raw']) {
      const v = nested[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    if (Object.keys(nested).length > 0) return JSON.stringify(nested);
  }
  return null;
}

/**
 * Detect Datadog daily ingest volume.
 *
 * Datadog's usage APIs have churned over the years. We try three
 * endpoints in order:
 *   1. `/api/v1/usage/logs` — classic byte-level endpoint. Still
 *      serves most customers. Deprecated on paper but works.
 *   2. `/api/v1/usage/summary?start_month=…&end_month=…` — monthly
 *      aggregate across products. Returns `ingested_events_bytes_sum`
 *      when the account tier exposes it.
 *   3. `/api/v1/usage/logs_by_index` — event count per index-hour.
 *      Multiply by 500 B/event (conservative average) to estimate
 *      bytes. Lowest fidelity but most widely available.
 *
 * All three need the app key to have `usage_read` scope.
 */
async function detectDailyVolumeGb(opts: VolumeDetectionOptions): Promise<VolumeDetectionResult> {
  void opts;
  const { apiKey, appKey, site } = getKeys();
  if (!apiKey || !appKey) {
    return { errorNote: 'Datadog: DD_API_KEY/DD_APP_KEY missing' };
  }
  const baseHost = site || 'datadoghq.com';
  const baseUrl = `https://api.${baseHost}`;
  const headers = { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey };

  const now = new Date();
  // End at top of current hour; start 7d back.
  const end = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const fmtHr = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;

  // Attempt 1 — /api/v1/usage/logs (byte-level, best fidelity).
  try {
    const url = `${baseUrl}/api/v1/usage/logs?start_hr=${fmtHr(start)}&end_hr=${fmtHr(end)}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = (await res.json()) as {
        usage?: Array<{ billable_ingested_bytes?: number; ingested_events_bytes?: number; logs_ingested_bytes?: number }>;
      };
      const usage = data.usage || [];
      const totalBytes = usage.reduce(
        (s, u) => s + (u.billable_ingested_bytes ?? u.ingested_events_bytes ?? u.logs_ingested_bytes ?? 0),
        0
      );
      if (totalBytes > 0 && usage.length > 0) {
        const days = usage.length / 24;
        return {
          dailyGb: totalBytes / (1024 ** 3) / Math.max(1, days),
          source: `Datadog /api/v1/usage/logs (${Math.round(days)}d, ${baseHost})`,
        };
      }
    }
  } catch {
    // fall through
  }

  // Attempt 2 — /api/v1/usage/summary.ingested_events_bytes_sum.
  try {
    const monthNow = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const url = `${baseUrl}/api/v1/usage/summary?start_month=${monthNow}&end_month=${monthNow}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = (await res.json()) as {
        usage?: Array<{
          orgs?: Array<{ ingested_events_bytes_sum?: number | null }>;
        }>;
      };
      const orgs = data.usage?.[0]?.orgs || [];
      const totalBytes = orgs.reduce((s, o) => s + (o.ingested_events_bytes_sum ?? 0), 0);
      if (totalBytes > 0) {
        const dayOfMonth = now.getUTCDate();
        return {
          dailyGb: totalBytes / (1024 ** 3) / Math.max(1, dayOfMonth),
          source: `Datadog /api/v1/usage/summary (month-to-date avg, ${baseHost})`,
        };
      }
    }
  } catch {
    // fall through
  }

  // Attempt 3 — /api/v1/usage/logs_by_index (events, not bytes).
  try {
    const url = `${baseUrl}/api/v1/usage/logs_by_index?start_hr=${fmtHr(start)}&end_hr=${fmtHr(end)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return { errorNote: `Datadog Usage API HTTP ${res.status} on all 3 endpoints. App key may lack 'usage_read' scope.` };
    }
    const data = (await res.json()) as {
      usage?: Array<{ event_count?: number; live_index_indexed?: number; hour?: string }>;
    };
    const usage = data.usage || [];
    if (usage.length === 0) {
      return { errorNote: 'Datadog usage_api returned empty — account may have <24h of data' };
    }
    const totalEvents = usage.reduce(
      (s, u) => s + (u.event_count ?? u.live_index_indexed ?? 0),
      0
    );
    if (totalEvents === 0) {
      return { errorNote: 'Datadog logs_by_index: 0 events over 7d' };
    }
    // Events → bytes approximation. 500 B/event is the central guess
    // for structured JSON logs; real per-event sizes range 200 B (small
    // structured) to 2 KB (verbose JSON with tags). The rangeMultiplier
    // (0.4× to 4×) propagates that uncertainty to the renderer so the
    // headline cost shows as a range, not a misleading single number.
    // Users who want a precise figure should grant `usage_read` scope
    // (unlocks endpoint 1 above) or pass `total_daily_gb` directly.
    const AVG_BYTES_PER_EVENT = 500;
    const days = usage.reduce((s, u) => s + (u.hour ? 1 : 0), 0) / 24;
    const dailyEvents = totalEvents / Math.max(1, days);
    const dailyGb = (dailyEvents * AVG_BYTES_PER_EVENT) / (1024 ** 3);
    return {
      dailyGb,
      source: `Datadog /api/v1/usage/logs_by_index (events × 500 B/event avg — byte endpoint not available on this tier, ${baseHost})`,
      rangeMultiplier: { low: 0.4, high: 4 },
    };
  } catch (e) {
    return { errorNote: `Datadog volume detection failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

export const datadogConnector: SiemConnector = {
  id: 'datadog',
  displayName: 'Datadog',
  discoverCredentials,
  pullEvents,
  detectDailyVolumeGb,
};

/** Test-only surface; not part of the public connector API. */
export const _internals = { extractMessage };
