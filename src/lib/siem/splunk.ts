/**
 * Splunk connector.
 *
 * Thin REST wrapper over the Splunk search-job API. The official Node SDK
 * is sparsely maintained, so we use fetch directly:
 *   1. POST /services/search/jobs         → search job sid
 *   2. GET  /services/search/jobs/{sid}   → poll `isDone`
 *   3. GET  /services/search/jobs/{sid}/results?offset=N&count=1000 → paginate
 *
 * Auth: `SPLUNK_HOST` + `SPLUNK_TOKEN` (bearer). Also honors `~/.splunkrc`
 * which users of the Splunk CLI often have set up.
 */

import type {
  SiemConnector,
  CredentialDiscovery,
  PullEventsOptions,
  PullEventsResult,
  PullStopReason,
} from './index.js';

import { retryWithBackoff, shouldStop, sleep, parseWindowMs } from './_retry.js';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface Conn {
  host: string; // normalized base URL
  token?: string;
  username?: string;
  password?: string;
  source: 'env' | 'cli_config';
}

function getConn(): Conn | null {
  const envHost = process.env.SPLUNK_HOST;
  const envToken = process.env.SPLUNK_TOKEN;
  if (envHost && envToken) {
    return { host: normalizeHost(envHost), token: envToken, source: 'env' };
  }
  // ~/.splunkrc — simple key=value file the Splunk CLI writes
  const rc = join(homedir(), '.splunkrc');
  if (existsSync(rc)) {
    try {
      const text = readFileSync(rc, 'utf8');
      const kv: Record<string, string> = {};
      for (const line of text.split('\n')) {
        const match = line.match(/^\s*([a-zA-Z_]+)\s*=\s*(.+?)\s*$/);
        if (match) kv[match[1].toLowerCase()] = match[2];
      }
      const host = kv['host'] ? `https://${kv['host']}:${kv['port'] || 8089}` : undefined;
      if (host && kv['username'] && kv['password']) {
        return { host: normalizeHost(host), username: kv['username'], password: kv['password'], source: 'cli_config' };
      }
    } catch {
      // unreadable rc file — skip silently
    }
  }
  return null;
}

function normalizeHost(host: string): string {
  let h = host.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
  // Default API port is 8089 when none given.
  if (!/:\d+$/.test(h.replace(/^https?:\/\//, ''))) h += ':8089';
  return h;
}

async function discoverCredentials(): Promise<CredentialDiscovery> {
  const conn = getConn();
  if (!conn) return { available: false, source: 'none' };
  return {
    available: true,
    source: conn.source,
    details: {
      host: conn.host,
      auth: conn.token ? 'bearer_token' : 'basic',
    },
  };
}

function authHeader(conn: Conn): string {
  if (conn.token) return `Bearer ${conn.token}`;
  return 'Basic ' + Buffer.from(`${conn.username}:${conn.password}`).toString('base64');
}

async function splunkFetch(conn: Conn, path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${conn.host}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: authHeader(conn),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 429 || res.status >= 500) {
    const body = await res.text().catch(() => '');
    const err = new Error(`splunk ${res.status}: ${body.slice(0, 200)}`) as Error & { statusCode: number; headers: Headers };
    err.statusCode = res.status;
    err.headers = res.headers;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`splunk ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
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
        notes: ['Set SPLUNK_HOST + SPLUNK_TOKEN, or populate ~/.splunkrc.'],
      },
    };
  }

  const deadline = Date.now() + opts.maxPullMinutes * 60_000;
  const windowMs = parseWindowMs(opts.window);
  const earliest = new Date(Date.now() - windowMs).toISOString();
  const latest = new Date().toISOString();

  // Build SPL. scope = index name. Every Splunk search must start with "search".
  const searchParts: string[] = ['search'];
  if (opts.scope) searchParts.push(`index=${opts.scope}`);
  if (opts.query) searchParts.push(opts.query);
  const spl = searchParts.join(' ');

  const events: unknown[] = [];
  const notes: string[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';

  // Step 1: create search job.
  const body = new URLSearchParams({
    search: spl,
    earliest_time: earliest,
    latest_time: latest,
    output_mode: 'json',
    exec_mode: 'normal',
  });

  let sid: string;
  try {
    const createResp = await retryWithBackoff(() =>
      splunkFetch(conn, '/services/search/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
    );
    const job = (await createResp.json()) as { sid?: string };
    if (!job.sid) throw new Error('splunk did not return a sid');
    sid = job.sid;
  } catch (e) {
    return {
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: spl,
        reasonStopped: 'error',
        notes: [`job_create_failed: ${(e as Error).message}`],
      },
    };
  }

  opts.onProgress({ step: `splunk job ${sid.slice(0, 12)} created`, pct: 10, eventsFetched: 0 });

  // Step 2: poll for completion.
  let eventsAvailable = 0;
  let pollAttempts = 0;
  while (true) {
    if (Date.now() >= deadline) {
      reasonStopped = 'time_exhausted';
      break;
    }
    try {
      const resp = await retryWithBackoff(() =>
        splunkFetch(conn, `/services/search/jobs/${sid}?output_mode=json`)
      );
      const data = (await resp.json()) as { entry?: Array<{ content?: { isDone?: boolean; eventCount?: number; resultCount?: number; dispatchState?: string; doneProgress?: number } }> };
      const content = data.entry?.[0]?.content;
      const progress = content?.doneProgress ?? 0;
      eventsAvailable = content?.resultCount ?? content?.eventCount ?? 0;
      if (content?.isDone) break;
      if (content?.dispatchState === 'FAILED') {
        reasonStopped = 'error';
        notes.push('splunk dispatchState=FAILED');
        break;
      }
      // Exponential: 1s, 1s, 2s, 2s, 3s, 3s, … capped at 5s.
      const wait = Math.min(5000, 1000 + 500 * Math.floor(pollAttempts / 2));
      pollAttempts++;
      opts.onProgress({
        step: `splunk job ${sid.slice(0, 12)} polling (${Math.round(progress * 100)}%)`,
        pct: 10 + Math.round(progress * 10),
        eventsFetched: 0,
      });
      await sleep(wait);
    } catch (e) {
      notes.push(`poll_error: ${(e as Error).message}`);
      reasonStopped = 'error';
      break;
    }
  }

  if (reasonStopped === 'error') {
    await cancelJob(conn, sid).catch(() => undefined);
    return {
      events: [],
      metadata: { actualCount: 0, truncated: false, queryUsed: spl, reasonStopped, notes },
    };
  }

  // Step 3: paginate results.
  const pageSize = 1000;
  let offset = 0;
  while (offset < eventsAvailable) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }
    try {
      const resp = await retryWithBackoff(() =>
        splunkFetch(
          conn,
          `/services/search/jobs/${sid}/results?offset=${offset}&count=${pageSize}&output_mode=json`
        )
      );
      const data = (await resp.json()) as { results?: Array<Record<string, unknown>> };
      const results = data.results || [];
      if (results.length === 0) break;
      for (const r of results) {
        events.push({
          timestamp: r._time,
          message: r._raw,
          host: r.host,
          source: r.source,
          sourcetype: r.sourcetype,
          index: r.index,
          raw: r,
        });
      }
      offset += results.length;
      opts.onProgress({
        step: `splunk results offset=${offset}/${eventsAvailable}`,
        pct: Math.min(50, 20 + Math.round((events.length / opts.targetEventCount) * 30)),
        eventsFetched: events.length,
      });
      if (results.length < pageSize) break;
    } catch (e) {
      notes.push(`page_error offset=${offset}: ${(e as Error).message.slice(0, 200)}`);
      reasonStopped = 'error';
      break;
    }
  }

  if (reasonStopped === 'source_exhausted' && events.length < opts.targetEventCount && offset >= eventsAvailable) {
    reasonStopped = 'source_exhausted';
  }

  // Clean up — avoid leaving orphan jobs on the search head.
  await cancelJob(conn, sid).catch(() => undefined);

  const truncated = reasonStopped !== 'source_exhausted' && events.length < opts.targetEventCount;
  return {
    events,
    metadata: {
      actualCount: events.length,
      truncated,
      queryUsed: spl,
      reasonStopped,
      notes: notes.length > 0 ? notes : undefined,
    },
  };
}

async function cancelJob(conn: Conn, sid: string): Promise<void> {
  await fetch(`${conn.host}/services/search/jobs/${sid}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader(conn), Accept: 'application/json' },
  }).catch(() => undefined);
}

export const splunkConnector: SiemConnector = {
  id: 'splunk',
  displayName: 'Splunk',
  discoverCredentials,
  pullEvents,
};
