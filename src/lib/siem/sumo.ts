/**
 * Sumo Logic connector.
 *
 * Uses the Search Job API v1: POST /api/v1/search/jobs to create a job,
 * GET /api/v1/search/jobs/{id} to poll state, GET …/messages?offset=…&limit=…
 * to paginate results.
 *
 * Auth: HTTP Basic with `SUMO_ACCESS_ID:SUMO_ACCESS_KEY`.
 *
 * `SUMO_ENDPOINT` is the full API base URL (e.g.,
 * https://api.us2.sumologic.com). The user must specify it — Sumo Logic
 * does not offer a single global endpoint.
 */

import type {
  SiemConnector,
  CredentialDiscovery,
  PullEventsOptions,
  PullEventsResult,
  PullStopReason,
} from './index.js';

import { retryWithBackoff, shouldStop, sleep, parseWindowMs } from './_retry.js';

function getKeys() {
  return {
    accessId: process.env.SUMO_ACCESS_ID,
    accessKey: process.env.SUMO_ACCESS_KEY,
    endpoint: (process.env.SUMO_ENDPOINT || '').replace(/\/+$/, ''),
  };
}

async function discoverCredentials(): Promise<CredentialDiscovery> {
  const { accessId, accessKey, endpoint } = getKeys();
  if (accessId && accessKey && endpoint) {
    return {
      available: true,
      source: 'env',
      details: {
        endpoint,
        access_id_masked: `${accessId.slice(0, 4)}…${accessId.slice(-2)}`,
      },
    };
  }
  return { available: false, source: 'none' };
}

function authHeader(accessId: string, accessKey: string): string {
  return 'Basic ' + Buffer.from(`${accessId}:${accessKey}`).toString('base64');
}

async function apiFetch(
  endpoint: string,
  auth: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = `${endpoint}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: auth,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 429 || res.status >= 500) {
    const body = await res.text().catch(() => '');
    const err = new Error(`sumo ${res.status}: ${body.slice(0, 200)}`) as Error & { statusCode: number; headers: Headers };
    err.statusCode = res.status;
    err.headers = res.headers;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sumo ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

async function pullEvents(opts: PullEventsOptions): Promise<PullEventsResult> {
  const { accessId, accessKey, endpoint } = getKeys();
  if (!accessId || !accessKey || !endpoint) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: '',
        reasonStopped: 'error',
        notes: ['Set SUMO_ACCESS_ID, SUMO_ACCESS_KEY, and SUMO_ENDPOINT.'],
      },
    };
  }
  const auth = authHeader(accessId, accessKey);
  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const to = new Date();
  const from = new Date(Date.now() - windowMs);

  // Compose the query. scope = _sourceCategory; query = additional filter.
  const queryParts: string[] = [];
  if (opts.scope) queryParts.push(`_sourceCategory=${jsonSafe(opts.scope)}`);
  if (opts.query) queryParts.push(opts.query);
  const searchQuery = queryParts.length > 0 ? queryParts.join(' ') : '*';

  const notes: string[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';
  const events: unknown[] = [];

  // Step 1: create search job.
  let jobId: string;
  try {
    const createResp = await retryWithBackoff(() =>
      apiFetch(endpoint, auth, '/api/v1/search/jobs', {
        method: 'POST',
        body: JSON.stringify({
          query: searchQuery,
          // Sumo's Search Job API expects ISO 8601 WITHOUT timezone
          // suffix and WITHOUT milliseconds, e.g. "2017-07-16T00:00:00".
          // Supplying `2025-01-01T00:00:00.000Z` (Date.toISOString's
          // default) returns HTTP 400 searchjob.invalid.timestamp.from.
          // We strip `.sss` and `Z`, and rely on the explicit timeZone
          // field below to anchor the value to UTC.
          from: from.toISOString().replace(/\.\d{3}Z$/, ''),
          to: to.toISOString().replace(/\.\d{3}Z$/, ''),
          timeZone: 'UTC',
        }),
      })
    );
    const job = (await createResp.json()) as { id?: string };
    if (!job.id) throw new Error('Sumo did not return a job id');
    jobId = job.id;
  } catch (e) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: searchQuery,
        reasonStopped: 'error',
        notes: [`job_create_failed: ${(e as Error).message}`],
      },
    };
  }

  opts.onProgress({ step: `sumo job ${jobId} created`, pct: 10, eventsFetched: 0 });

  // Step 2: poll for DONE GATHERING RESULTS.
  let messageCount = 0;
  while (true) {
    if (Date.now() >= deadline) {
      reasonStopped = 'time_exhausted';
      break;
    }
    try {
      const statusResp = await retryWithBackoff(() =>
        apiFetch(endpoint, auth, `/api/v1/search/jobs/${jobId}`)
      );
      const st = (await statusResp.json()) as {
        state?: string;
        messageCount?: number;
        recordCount?: number;
      };
      messageCount = st.messageCount ?? st.recordCount ?? 0;
      if (st.state === 'DONE GATHERING RESULTS' || st.state === 'FORCE PAUSED') break;
      if (st.state === 'CANCELLED') {
        reasonStopped = 'error';
        notes.push('sumo job cancelled');
        break;
      }
      // Sumo polling cadence recommendation: 1-3s.
      await sleep(2000);
    } catch (e) {
      notes.push(`poll_error: ${(e as Error).message}`);
      reasonStopped = 'error';
      break;
    }
  }

  if (reasonStopped === 'error') {
    await cancelJob(endpoint, auth, jobId).catch(() => undefined);
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: searchQuery,
        reasonStopped,
        notes,
      },
    };
  }

  // Step 3: paginate messages.
  const pageLimit = 1000;
  let offset = 0;
  while (offset < messageCount) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    try {
      const page = await retryWithBackoff(() =>
        apiFetch(endpoint, auth, `/api/v1/search/jobs/${jobId}/messages?offset=${offset}&limit=${pageLimit}`)
      );
      const body = (await page.json()) as { messages?: Array<{ map?: Record<string, string> }> };
      const messages = body.messages || [];
      if (messages.length === 0) break;
      for (const m of messages) {
        const map = m.map || {};
        events.push({
          timestamp: map._messagetime || map._timestamp || map._receipttime,
          message: map._raw || map._rawblob || '',
          service: map._sourcecategory,
          severity: map._severity,
          host: map._sourcehost,
          sourceCategory: map._sourcecategory,
        });
      }
      offset += messages.length;
      opts.onProgress({
        step: `sumo offset ${offset}/${messageCount}`,
        pct: Math.min(50, Math.round((events.length / opts.targetEventCount) * 50)),
        eventsFetched: events.length,
      });
      if (messages.length < pageLimit) break;
    } catch (e) {
      notes.push(`page_error offset=${offset}: ${(e as Error).message.slice(0, 200)}`);
      reasonStopped = 'error';
      break;
    }
  }

  if (reasonStopped === 'source_exhausted' && events.length < opts.targetEventCount && offset >= messageCount) {
    reasonStopped = 'source_exhausted';
  }

  // Clean up the search job so we don't leave it running on Sumo's side.
  await cancelJob(endpoint, auth, jobId).catch(() => undefined);

  const truncated = reasonStopped !== 'source_exhausted' && events.length < opts.targetEventCount;
  return {
    events,
    metadata: {
      actualCount: events.length,
      truncated,
      queryUsed: searchQuery,
      reasonStopped,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

async function cancelJob(endpoint: string, auth: string, jobId: string): Promise<void> {
  await fetch(`${endpoint}/api/v1/search/jobs/${jobId}`, {
    method: 'DELETE',
    headers: { Authorization: auth, Accept: 'application/json' },
  }).catch(() => undefined);
}

function jsonSafe(s: string): string {
  // Sumo queries accept quoted values; escape quotes and backslashes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const sumoConnector: SiemConnector = {
  id: 'sumo',
  displayName: 'Sumo Logic',
  discoverCredentials,
  pullEvents,
};
