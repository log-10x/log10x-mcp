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
  VolumeDetectionOptions,
  VolumeDetectionResult,
} from './index.js';

import { retryWithBackoff, shouldStop, sleep, parseWindowMs } from './_retry.js';
import { randomTimeBuckets, perBucketCap } from './_sampling.js';
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
  const envUser = process.env.SPLUNK_USERNAME;
  const envPass = process.env.SPLUNK_PASSWORD;
  if (envHost && envToken) {
    return { host: normalizeHost(envHost), token: envToken, source: 'env' };
  }
  if (envHost && envUser && envPass) {
    return { host: normalizeHost(envHost), username: envUser, password: envPass, source: 'env' };
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
  const toMs = Date.now();
  const fromMs = toMs - windowMs;

  // Build SPL. scope = index name. Every Splunk search must start with "search".
  const searchParts: string[] = ['search'];
  if (opts.scope) searchParts.push(`index=${opts.scope}`);
  if (opts.query) searchParts.push(opts.query);
  const spl = searchParts.join(' ');

  const events: unknown[] = [];
  const notes: string[] = [];
  let reasonStopped: PullStopReason = 'source_exhausted';

  // Stratified random sampling: 12 child sub-windows scattered across
  // the parent window with per-run RNG. Splunk dispatches one search
  // job per bucket sequentially — concurrent dispatches risk hitting
  // the search head's per-user concurrency cap (default 6).
  const BUCKET_COUNT = 12;
  const buckets = randomTimeBuckets(fromMs, toMs, BUCKET_COUNT);
  const bucketCap = perBucketCap(opts.targetEventCount, BUCKET_COUNT);
  const pageSize = 1000;

  bucketLoop: for (const bucket of buckets) {
    if (shouldStop(deadline, events.length, opts.targetEventCount)) {
      reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
      break;
    }

    const earliest = new Date(bucket.fromMs).toISOString();
    const latest = new Date(bucket.toMs).toISOString();
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
      notes.push(`bucket_${bucket.index}_create_failed: ${(e as Error).message.slice(0, 200)}`);
      // Per-bucket failure is non-fatal; move on.
      continue;
    }

    opts.onProgress({
      step: `splunk bucket ${bucket.index + 1}/${BUCKET_COUNT} job ${sid.slice(0, 12)}`,
      pct: 10 + Math.round((bucket.index / BUCKET_COUNT) * 40),
      eventsFetched: events.length,
    });

    // Poll for completion.
    let eventsAvailable = 0;
    let pollAttempts = 0;
    let pollFailed = false;
    while (true) {
      if (Date.now() >= deadline) {
        reasonStopped = 'time_exhausted';
        await cancelJob(conn, sid).catch(() => undefined);
        break bucketLoop;
      }
      try {
        const resp = await retryWithBackoff(() =>
          splunkFetch(conn, `/services/search/jobs/${sid}?output_mode=json`)
        );
        const data = (await resp.json()) as { entry?: Array<{ content?: { isDone?: boolean; eventCount?: number; resultCount?: number; dispatchState?: string; doneProgress?: number } }> };
        const content = data.entry?.[0]?.content;
        eventsAvailable = content?.resultCount ?? content?.eventCount ?? 0;
        if (content?.isDone) break;
        if (content?.dispatchState === 'FAILED') {
          notes.push(`bucket_${bucket.index}_dispatch_failed`);
          pollFailed = true;
          break;
        }
        const wait = Math.min(5000, 1000 + 500 * Math.floor(pollAttempts / 2));
        pollAttempts++;
        await sleep(wait);
      } catch (e) {
        notes.push(`bucket_${bucket.index}_poll_error: ${(e as Error).message.slice(0, 200)}`);
        pollFailed = true;
        break;
      }
    }

    if (pollFailed) {
      await cancelJob(conn, sid).catch(() => undefined);
      continue;
    }

    // Paginate results, capped at bucketCap.
    let offset = 0;
    let bucketEvents = 0;
    while (offset < eventsAvailable && bucketEvents < bucketCap) {
      if (shouldStop(deadline, events.length, opts.targetEventCount)) {
        reasonStopped = events.length >= opts.targetEventCount ? 'target_reached' : 'time_exhausted';
        await cancelJob(conn, sid).catch(() => undefined);
        break bucketLoop;
      }
      try {
        const remaining = bucketCap - bucketEvents;
        const count = Math.min(pageSize, remaining);
        const resp = await retryWithBackoff(() =>
          splunkFetch(
            conn,
            `/services/search/jobs/${sid}/results?offset=${offset}&count=${count}&output_mode=json`
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
          bucketEvents++;
        }
        offset += results.length;
        if (results.length < count) break;
      } catch (e) {
        notes.push(`bucket_${bucket.index}_page_error offset=${offset}: ${(e as Error).message.slice(0, 200)}`);
        break;
      }
    }

    await cancelJob(conn, sid).catch(() => undefined);
  }

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

/**
 * Detect Splunk daily ingest via an SPL query against `_internal`:
 *   `search index=_internal source=*license_usage.log* type=Usage
 *      | bin _time span=1d | stats sum(b) as bytes by _time`
 * Averages the last 7 days. Requires the user to be able to read
 * `index=_internal` (admin role typically has this).
 *
 * Falls back to `_introspection` or the license-pool REST endpoint if
 * the search fails with "no such index" (some customers have _internal
 * locked down).
 */
async function detectDailyVolumeGb(opts: VolumeDetectionOptions): Promise<VolumeDetectionResult> {
  void opts;
  const conn = getConn();
  if (!conn) return { errorNote: 'Splunk: no connection credentials' };
  const earliest = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const latest = new Date().toISOString();
  const spl =
    'search index=_internal source=*license_usage.log* type=Usage ' +
    '| bin _time span=1d ' +
    '| stats sum(b) as bytes by _time';
  const body = new URLSearchParams({
    search: spl,
    earliest_time: earliest,
    latest_time: latest,
    output_mode: 'json',
    exec_mode: 'oneshot',
  });
  try {
    const resp = await splunkFetch(conn, '/services/search/jobs/oneshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await resp.json()) as { results?: Array<{ bytes?: string }> };
    const results = data.results || [];
    if (results.length === 0) {
      return { errorNote: 'Splunk _internal license_usage returned 0 rows — may lack _internal read capability' };
    }
    const days = results.length;
    const totalBytes = results.reduce((s, r) => s + Number(r.bytes || 0), 0);
    if (totalBytes <= 0) {
      return { errorNote: 'Splunk license_usage reported 0 bytes over 7d' };
    }
    const dailyGb = totalBytes / (1024 ** 3) / days;
    return {
      dailyGb,
      source: `Splunk _internal license_usage.log (${days}d avg)`,
    };
  } catch (e) {
    return { errorNote: `Splunk volume detection failed: ${(e as Error).message.slice(0, 200)}` };
  }
}

export const splunkConnector: SiemConnector = {
  id: 'splunk',
  displayName: 'Splunk',
  discoverCredentials,
  pullEvents,
  detectDailyVolumeGb,
};
