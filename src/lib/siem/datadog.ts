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
} from './index.js';

import { retryWithBackoff, shouldStop, parseWindowMs } from './_retry.js';

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
  const to = new Date();
  const from = new Date(Date.now() - windowMs);

  // Compose the query. `scope` is treated as an index name (the index
  // facet is `index:<name>`); `query` is the free-text filter.
  const queryParts: string[] = [];
  if (opts.scope) queryParts.push(`index:${opts.scope}`);
  if (opts.query) queryParts.push(opts.query);
  const queryStr = queryParts.join(' ').trim();

  const events: unknown[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';
  const notes: string[] = [];

  let cursor: string | undefined;
  const pageLimit = 1000; // Datadog caps at 5000; 1000 is a good page size.

  while (true) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    try {
      const resp = await retryWithBackoff(() =>
        api.listLogsGet({
          filterQuery: queryStr || undefined,
          filterFrom: from,
          filterTo: to,
          pageCursor: cursor,
          pageLimit,
          sort: 'timestamp',
        })
      );
      const data = resp.data || [];
      for (const ev of data) {
        events.push({
          timestamp: ev.attributes?.timestamp,
          message: ev.attributes?.message,
          service: ev.attributes?.service,
          status: ev.attributes?.status,
          tags: ev.attributes?.tags,
          host: ev.attributes?.host,
          attributes: ev.attributes?.attributes,
        });
      }
      const nextCursor = resp.meta?.page?.after;
      if (!nextCursor) {
        reasonStopped = 'source_exhausted';
        break;
      }
      cursor = nextCursor;
      opts.onProgress({
        step: `datadog page cursor ${cursor.slice(0, 8)}…`,
        pct: Math.min(50, Math.round((events.length / opts.targetEventCount) * 50)),
        eventsFetched: events.length,
      });
    } catch (e) {
      notes.push(`datadog_page_error: ${(e as Error).message.slice(0, 200)}`);
      reasonStopped = 'error';
      break;
    }
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

export const datadogConnector: SiemConnector = {
  id: 'datadog',
  displayName: 'Datadog',
  discoverCredentials,
  pullEvents,
};
