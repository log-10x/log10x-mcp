import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Set retry base to 1 ms BEFORE importing api.ts so the module picks it up
// at load time. Tests take ~10 ms each instead of ~2 s each.
process.env.LOG10X_RETRY_BASE_MS = '1';

const { fetchWithRetry } = await import('../src/lib/api.js');

const ORIGINAL_FETCH = global.fetch;

interface MockFetchCall {
  url: string;
  init?: RequestInit;
}

function setupMockFetch(responses: Array<Response | Error>) {
  const calls: MockFetchCall[] = [];
  let i = 0;
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i];
    i += 1;
    if (r instanceof Error) throw r;
    if (!r) throw new Error('mock fetch: out of responses');
    return r;
  }) as typeof fetch;
  return { calls };
}

function makeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  // each test installs its own mock
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

test('4xx (other than 429) surfaces immediately without retry', async () => {
  const { calls } = setupMockFetch([makeResponse(404, 'not found')]);
  const res = await fetchWithRetry('https://x', {}, 'test');
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
});

test('429 triggers retry', async () => {
  const { calls } = setupMockFetch([makeResponse(429, 'rate limited'), makeResponse(200, 'ok')]);
  const res = await fetchWithRetry('https://x', {}, 'test');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test('5xx retries and eventually succeeds', async () => {
  const { calls } = setupMockFetch([
    makeResponse(503, 'first'),
    makeResponse(502, 'second'),
    makeResponse(200, 'ok'),
  ]);
  const res = await fetchWithRetry('https://x', {}, 'test');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
});

test('5xx exhausts retry budget and throws', async () => {
  const { calls } = setupMockFetch([
    makeResponse(503, 'a'),
    makeResponse(503, 'b'),
    makeResponse(503, 'c'),
  ]);
  await assert.rejects(() => fetchWithRetry('https://x', {}, 'test'), /HTTP 503/);
  assert.equal(calls.length, 3);
});

test('network error retries and eventually succeeds', async () => {
  const { calls } = setupMockFetch([new Error('ECONNRESET'), makeResponse(200, 'ok')]);
  const res = await fetchWithRetry('https://x', {}, 'test');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test('network error exhausts retry budget and throws', async () => {
  const { calls } = setupMockFetch([
    new Error('timeout'),
    new Error('timeout'),
    new Error('timeout'),
  ]);
  await assert.rejects(() => fetchWithRetry('https://x', {}, 'test'), /timeout/);
  assert.equal(calls.length, 3);
});

test('first-attempt 200 returns immediately, no retry', async () => {
  const { calls } = setupMockFetch([makeResponse(200, 'instant')]);
  const res = await fetchWithRetry('https://x', {}, 'test');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test('401 surfaces immediately (auth errors never retry)', async () => {
  const { calls } = setupMockFetch([makeResponse(401, 'unauthorized')]);
  const res = await fetchWithRetry('https://x', {}, 'test');
  assert.equal(res.status, 401);
  assert.equal(calls.length, 1);
});

test('403 surfaces immediately', async () => {
  const { calls } = setupMockFetch([makeResponse(403, 'forbidden')]);
  const res = await fetchWithRetry('https://x', {}, 'test');
  assert.equal(res.status, 403);
  assert.equal(calls.length, 1);
});

test('mixed 5xx → 4xx → success: 5xx retries, 4xx surfaces at retry #2', async () => {
  const { calls } = setupMockFetch([
    makeResponse(503, 'first'),
    makeResponse(404, 'second'), // 4xx on attempt 2 should surface, not retry
  ]);
  const res = await fetchWithRetry('https://x', {}, 'test');
  assert.equal(res.status, 404);
  assert.equal(calls.length, 2);
});
