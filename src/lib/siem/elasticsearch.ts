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
} from './index.js';

import { retryWithBackoff, shouldStop, parseWindowMs } from './_retry.js';

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
  return null;
}

async function discoverCredentials(): Promise<CredentialDiscovery> {
  const conn = getConn();
  if (!conn) return { available: false, source: 'none' };
  return {
    available: true,
    source: 'env',
    details: {
      url: conn.url,
      auth: conn.apiKey ? 'api_key' : 'basic',
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
        notes: ['Set ELASTIC_URL + (ELASTIC_API_KEY OR ELASTIC_USERNAME+ELASTIC_PASSWORD).'],
      },
    };
  }

  const client = new Client({
    node: conn.url,
    auth: conn.apiKey
      ? { apiKey: conn.apiKey }
      : { username: conn.username!, password: conn.password! },
  });

  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const since = new Date(Date.now() - windowMs).toISOString();
  const indexPattern = opts.scope || 'logs-*';

  // Build Elasticsearch query. If user passed a KQL-style `query`, pass it as
  // a query_string (Elasticsearch's KQL superset). Always AND with timestamp.
  const mustClauses: Record<string, unknown>[] = [
    { range: { '@timestamp': { gte: since } } },
  ];
  if (opts.query) {
    mustClauses.push({ query_string: { query: opts.query } });
  }

  const events: unknown[] = [];
  const notes: string[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';
  let searchAfter: unknown[] | undefined;

  while (true) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    try {
      const searchBody: Record<string, unknown> = {
        query: { bool: { must: mustClauses } },
        size: 1000,
        sort: [{ '@timestamp': 'asc' }, { _id: 'asc' }],
      };
      if (searchAfter) searchBody.search_after = searchAfter;
      const resp = await retryWithBackoff(() =>
        client.search({
          index: indexPattern,
          ...searchBody,
        })
      );
      const hits = ((resp as unknown as { hits: { hits: Array<{ _source: unknown; sort?: unknown[] }> } })
        .hits?.hits) || [];
      if (hits.length === 0) {
        reasonStopped = 'source_exhausted';
        break;
      }
      for (const h of hits) {
        events.push(h._source);
      }
      const last = hits[hits.length - 1];
      searchAfter = last.sort;
      opts.onProgress({
        step: `elasticsearch search_after (${events.length} total)`,
        pct: Math.min(50, Math.round((events.length / opts.targetEventCount) * 50)),
        eventsFetched: events.length,
      });
      if (hits.length < 1000) {
        reasonStopped = 'source_exhausted';
        break;
      }
    } catch (e) {
      notes.push(`elastic_page_error: ${(e as Error).message.slice(0, 200)}`);
      reasonStopped = 'error';
      break;
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

export const elasticsearchConnector: SiemConnector = {
  id: 'elasticsearch',
  displayName: 'Elasticsearch',
  discoverCredentials,
  pullEvents,
};
