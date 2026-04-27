/**
 * Elasticsearch / Elastic Cloud connector.
 *
 * Uses `@elastic/elasticsearch` with `search_after` pagination (cheaper
 * and deeper than the deprecated `scroll` API). Supports both API key auth
 * and basic auth.
 */

import { Client } from '@elastic/elasticsearch';

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

interface Conn {
  url: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

function getConn(): Conn | null {
  const url = process.env.ELASTIC_URL || process.env.ELASTICSEARCH_URL;
  if (!url) return null;
  const apiKey = process.env.ELASTIC_API_KEY || process.env.ELASTICSEARCH_API_KEY;
  if (apiKey) return { url, apiKey };
  const username = process.env.ELASTIC_USERNAME || process.env.ELASTICSEARCH_USERNAME;
  const password = process.env.ELASTIC_PASSWORD || process.env.ELASTICSEARCH_PASSWORD;
  if (username && password) return { url, username, password };
  // No auth configured — valid for dev/self-hosted ES with xpack.security.enabled=false.
  // The SDK will hit the cluster without auth headers; the cluster will reject if it
  // actually requires auth, and the pullEvents error path surfaces that cleanly.
  return { url };
}

async function discoverCredentials(): Promise<CredentialDiscovery> {
  const conn = getConn();
  if (!conn) return { available: false, source: 'none' };
  const authKind = conn.apiKey ? 'api_key' : conn.username ? 'basic' : 'none';
  return {
    available: true,
    source: 'env',
    details: {
      url: conn.url,
      auth: authKind,
    },
  };
}

async function pullEvents(opts: PullEventsOptions): Promise<PullEventsResult> {
  const conn = getConn();
  if (!conn) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: '',
        reasonStopped: 'error',
        notes: [
          'Set ELASTIC_URL (optionally with ELASTIC_API_KEY, or ELASTIC_USERNAME+ELASTIC_PASSWORD). ' +
            'URL-only is valid for dev clusters with xpack.security.enabled=false.',
        ],
      },
    };
  }

  const client = new Client({
    node: conn.url,
    // Only pass auth when configured; xpack.security.enabled=false clusters
    // reject requests with auth headers. Leaving auth undefined is safe.
    ...(conn.apiKey
      ? { auth: { apiKey: conn.apiKey } }
      : conn.username && conn.password
      ? { auth: { username: conn.username, password: conn.password } }
      : {}),
  });

  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const toMs = Date.now();
  const fromMs = toMs - windowMs;
  const indexPattern = opts.scope || 'logs-*';

  const events: unknown[] = [];
  const notes: string[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';

  // Stratified random sampling: 24 child sub-windows scattered across
  // the parent window with per-run RNG. Each bucket is its own
  // search_after pagination scope, capped at perBucketCap.
  const BUCKET_COUNT = 24;
  const buckets = randomTimeBuckets(fromMs, toMs, BUCKET_COUNT);
  const bucketCap = perBucketCap(opts.targetEventCount, BUCKET_COUNT);
  const pageSize = 1000;

  bucketLoop: for (const bucket of buckets) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }

    const mustClauses: Record<string, unknown>[] = [
      {
        range: {
          '@timestamp': {
            gte: new Date(bucket.fromMs).toISOString(),
            lte: new Date(bucket.toMs).toISOString(),
          },
        },
      },
    ];
    if (opts.query) {
      mustClauses.push({ query_string: { query: opts.query } });
    }

    let searchAfter: unknown[] | undefined;
    let bucketEvents = 0;
    while (bucketEvents < bucketCap) {
      if (shouldStop(deadline, events.length, opts.targetEventCount)) {
        reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
        break bucketLoop;
      }
      try {
        // Sort by @timestamp only. ES 9 disallows sorting on `_id`
        // (indices.id_field_data.enabled=false by default), and `_shard_doc`
        // requires an open point-in-time (PIT) context. Without PIT, relying
        // on @timestamp alone is the simplest cross-version-safe option. For
        // POC triage the rare duplicate/skip at identical timestamps is
        // acceptable; customers who need strict dedup should open a PIT
        // themselves and pass the PIT id via a future arg.
        const remaining = bucketCap - bucketEvents;
        const size = Math.min(pageSize, remaining);
        const searchBody: Record<string, unknown> = {
          query: { bool: { must: mustClauses } },
          size,
          sort: [{ '@timestamp': 'asc' }],
          track_total_hits: false,
        };
        if (searchAfter) searchBody.search_after = searchAfter;
        const resp = await retryWithBackoff(() =>
          client.search({
            index: indexPattern,
            ...searchBody,
          })
        );
        const hits =
          ((resp as unknown as { hits: { hits: Array<{ _source: unknown; sort?: unknown[] }> } })
            .hits?.hits) || [];
        if (hits.length === 0) break; // bucket exhausted
        for (const h of hits) {
          if (bucketEvents >= bucketCap) break;
          events.push(h._source);
          bucketEvents++;
        }
        const last = hits[hits.length - 1];
        searchAfter = last.sort;
        opts.onProgress({
          step: `elasticsearch bucket ${bucket.index + 1}/${BUCKET_COUNT} (${bucketEvents}/${bucketCap})`,
          pct: Math.min(
            50,
            Math.round(((bucket.index + bucketEvents / bucketCap) / BUCKET_COUNT) * 50)
          ),
          eventsFetched: events.length,
        });
        if (hits.length < size) break; // bucket exhausted
      } catch (e) {
        notes.push(`elastic_bucket_${bucket.index}_error: ${(e as Error).message.slice(0, 200)}`);
        // Per-bucket failure is non-fatal.
        break;
      }
    }
  }

  try {
    await client.close();
  } catch {
    // cleanup — non-fatal
  }

  const truncated = reasonStopped !== 'source_exhausted' && events.length < opts.targetEventCount;
  return {
    events,
    metadata: {
      actualCount: events.length,
      truncated,
      queryUsed: `${indexPattern}${opts.query ? ` | ${opts.query}` : ''}`,
      reasonStopped,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

/**
 * Detect ES daily ingest volume via `_stats` on the scope's index
 * pattern. Combines `indices.<name>.primaries.docs.count` and
 * `primaries.store.size_in_bytes` over the indices in scope; divides by
 * the span of `@timestamp` values (first vs last doc) to estimate daily.
 *
 * Simpler alternative we don't use: `GET /_cat/indices?bytes=b` — doesn't
 * give us time-range info. Using stats + a range aggregation is more
 * accurate though costs one extra call.
 */
async function detectDailyVolumeGb(opts: VolumeDetectionOptions): Promise<VolumeDetectionResult> {
  const conn = getConn();
  if (!conn) return { errorNote: 'Elasticsearch: ELASTIC_URL not set' };
  const client = new Client({
    node: conn.url,
    ...(conn.apiKey
      ? { auth: { apiKey: conn.apiKey } }
      : conn.username && conn.password
      ? { auth: { username: conn.username, password: conn.password } }
      : {}),
  });
  const indexPattern = opts.scope || 'logs-*';
  try {
    const statsResp = (await client.indices.stats({
      index: indexPattern,
      metric: 'store,docs',
    } as unknown as Parameters<typeof client.indices.stats>[0])) as unknown as {
      _all?: { primaries?: { store?: { size_in_bytes?: number }; docs?: { count?: number } } };
    };
    const bytes = statsResp._all?.primaries?.store?.size_in_bytes ?? 0;
    const docs = statsResp._all?.primaries?.docs?.count ?? 0;
    if (bytes === 0 || docs === 0) {
      return { errorNote: `Elasticsearch index pattern "${indexPattern}" has no primary docs/bytes` };
    }
    // Span of @timestamp: min/max aggregation.
    const spanResp = (await client.search({
      index: indexPattern,
      size: 0,
      aggs: {
        min_ts: { min: { field: '@timestamp' } },
        max_ts: { max: { field: '@timestamp' } },
      },
    } as unknown as Parameters<typeof client.search>[0])) as unknown as {
      aggregations?: {
        min_ts?: { value?: number | null };
        max_ts?: { value?: number | null };
      };
    };
    const minTs = spanResp.aggregations?.min_ts?.value;
    const maxTs = spanResp.aggregations?.max_ts?.value;
    let days: number;
    let spanNote = '';
    if (minTs && maxTs && maxTs > minTs) {
      days = Math.max(1, (maxTs - minTs) / 86_400_000);
      spanNote = `${Math.round(days)}d observed span`;
    } else {
      // No @timestamp aggregation available — assume 7 days.
      days = 7;
      spanNote = '@timestamp unavailable, assumed 7d';
    }
    const dailyGb = bytes / (1024 ** 3) / days;
    await client.close().catch(() => undefined);
    return {
      dailyGb,
      source: `Elasticsearch _stats on "${indexPattern}" (${spanNote})`,
    };
  } catch (e) {
    await client.close().catch(() => undefined);
    return { errorNote: `Elasticsearch volume detection failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

export const elasticsearchConnector: SiemConnector = {
  id: 'elasticsearch',
  displayName: 'Elasticsearch',
  discoverCredentials,
  pullEvents,
  detectDailyVolumeGb,
};
