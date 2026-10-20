import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listLogsPage, DatadogHttpError } from '../../src/lib/siem/datadog.js';

const keys = { apiKey: 'api-k', appKey: 'app-k' };

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { impl, calls };
}

test('one page: the logs list endpoint, its filters, and both keys as headers', async () => {
  const page = { data: [{ attributes: { message: 'hello', timestamp: '2026-10-20T00:00:00Z' } }], meta: { page: { after: 'c2' } } };
  const f = fakeFetch(200, page);
  const res = await listLogsPage('https://api.us5.datadoghq.com', keys,
    { query: 'index:main service:cart', fromMs: Date.UTC(2026, 9, 20), toMs: Date.UTC(2026, 9, 20, 1), cursor: 'c1', limit: 1000 }, f.impl);
  assert.equal(res.data?.[0].attributes?.message, 'hello');
  assert.equal(res.meta?.page?.after, 'c2');
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.us5.datadoghq.com/api/v2/logs/events');
  assert.equal(u.searchParams.get('filter[query]'), 'index:main service:cart');
  assert.equal(u.searchParams.get('filter[from]'), '2026-10-20T00:00:00.000Z');
  assert.equal(u.searchParams.get('filter[to]'), '2026-10-20T01:00:00.000Z');
  assert.equal(u.searchParams.get('page[cursor]'), 'c1');
  assert.equal(u.searchParams.get('page[limit]'), '1000');
  assert.equal(u.searchParams.get('sort'), 'timestamp');
  assert.equal(f.calls[0].headers['DD-API-KEY'], 'api-k');
  assert.equal(f.calls[0].headers['DD-APPLICATION-KEY'], 'app-k');
});

test('no query and no cursor leave those parameters out', async () => {
  const f = fakeFetch(200, { data: [] });
  await listLogsPage('https://api.datadoghq.com', keys, { fromMs: 0, toMs: 1000, limit: 10 }, f.impl);
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.has('filter[query]'), false);
  assert.equal(u.searchParams.has('page[cursor]'), false);
});

test('an HTTP error carries its status and Retry-After', async () => {
  const f = fakeFetch(429, 'slow down', { 'retry-after': '7' });
  await assert.rejects(
    () => listLogsPage('https://api.datadoghq.com', keys, { fromMs: 0, toMs: 1000, limit: 10 }, f.impl),
    (e: unknown) => e instanceof DatadogHttpError && e.status === 429 && e.retryAfterMs === 7000
  );
  const g = fakeFetch(403, '{"errors":["Forbidden"]}');
  await assert.rejects(
    () => listLogsPage('https://api.datadoghq.com', keys, { fromMs: 0, toMs: 1000, limit: 10 }, g.impl),
    (e: unknown) => e instanceof DatadogHttpError && e.status === 403 && /Forbidden/.test(e.message)
  );
});
