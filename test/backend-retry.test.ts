/**
 * backend-retry integration test — proves FIX A's retry+timeout primitive
 * actually retries against a real HTTP server.
 *
 * Stub returns 503 twice then 200. Backend completes successfully. Attempt
 * count is 3. Pattern mirrors test/helpers/stub-prom.ts but with a scripted
 * status sequence so we can assert exact retry behavior, not the
 * deterministic failure-rate path used by the stress tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

// Shrink backoff so the test runs in ~3ms not 750ms.
process.env.LOG10X_RETRY_BASE_MS = '1';

const { GenericPromBackend, Log10xBackend } = await import('../src/lib/customer-metrics.js');
const { backendFetch, backendJsonFetch } = await import('../src/lib/backend-fetch.js');

interface ScriptedStub {
  url: string;
  attempts(): number;
  close(): Promise<void>;
}

/**
 * Start an HTTP server that walks a scripted status-code sequence per
 * request. Counts attempts. Returns a fresh body each call.
 */
async function startScripted(sequence: number[], jsonBody: object): Promise<ScriptedStub> {
  let i = 0;
  const server: Server = createServer((_req, res) => {
    const status = sequence[Math.min(i, sequence.length - 1)] ?? 200;
    i += 1;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    if (status >= 200 && status < 300) {
      res.end(JSON.stringify(jsonBody));
    } else {
      res.end(JSON.stringify({ status: 'error', error: `scripted ${status}` }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('scripted stub failed to bind');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    attempts: () => i,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

test('backendFetch retries on 503 twice then succeeds (attempts = 3)', async () => {
  const stub = await startScripted([503, 503, 200], { status: 'success', data: { resultType: 'vector', result: [] } });
  try {
    const res = await backendFetch(
      `${stub.url}/api/v1/query?query=up`,
      { method: 'GET' },
      { kindLabel: 'test' }
    );
    assert.equal(res.status, 200);
    assert.equal(stub.attempts(), 3);
  } finally {
    await stub.close();
  }
});

test('backendJsonFetch retries on 503 twice then parses JSON', async () => {
  const body = { status: 'success', data: { resultType: 'vector', result: [] } };
  const stub = await startScripted([503, 503, 200], body);
  try {
    const parsed = await backendJsonFetch<typeof body>(
      `${stub.url}/api/v1/query?query=up`,
      { method: 'GET' },
      { kindLabel: 'test' }
    );
    assert.deepEqual(parsed, body);
    assert.equal(stub.attempts(), 3);
  } finally {
    await stub.close();
  }
});

test('GenericPromBackend.queryInstant retries on 503 twice then succeeds', async () => {
  const body = {
    status: 'success',
    data: {
      resultType: 'vector',
      result: [{ metric: { __name__: 'up' }, value: [1700000000, '1'] }],
    },
  };
  const stub = await startScripted([503, 503, 200], body);
  try {
    const backend = new GenericPromBackend({ endpoint: stub.url });
    const res = await backend.queryInstant('up');
    assert.equal(res.status, 'success');
    assert.equal(stub.attempts(), 3);
  } finally {
    await stub.close();
  }
});

test('Log10xBackend.queryInstant retries on 503 twice then succeeds', async () => {
  const body = {
    status: 'success',
    data: { resultType: 'vector', result: [] },
  };
  const stub = await startScripted([503, 503, 200], body);
  try {
    const backend = new Log10xBackend({ endpoint: stub.url, apiKey: 'k', envId: 'e' });
    const res = await backend.queryInstant('up');
    assert.equal(res.status, 'success');
    assert.equal(stub.attempts(), 3);
  } finally {
    await stub.close();
  }
});

test('backendFetch surfaces 404 immediately without retry', async () => {
  const stub = await startScripted([404], {});
  try {
    await assert.rejects(
      () =>
        backendFetch(
          `${stub.url}/api/v1/query?query=up`,
          { method: 'GET' },
          { kindLabel: 'test' }
        ),
      /test HTTP 404/
    );
    assert.equal(stub.attempts(), 1);
  } finally {
    await stub.close();
  }
});

test('backendFetch exhausts 3 attempts on persistent 503 and throws', async () => {
  const stub = await startScripted([503, 503, 503], {});
  try {
    await assert.rejects(
      () =>
        backendFetch(
          `${stub.url}/api/v1/query?query=up`,
          { method: 'GET' },
          { kindLabel: 'test' }
        ),
      /test HTTP 503/
    );
    assert.equal(stub.attempts(), 3);
  } finally {
    await stub.close();
  }
});

test('backendFetch retries on 429 (rate limit)', async () => {
  const body = { status: 'success', data: { resultType: 'vector', result: [] } };
  const stub = await startScripted([429, 200], body);
  try {
    const res = await backendFetch(
      `${stub.url}/api/v1/query?query=up`,
      { method: 'GET' },
      { kindLabel: 'test' }
    );
    assert.equal(res.status, 200);
    assert.equal(stub.attempts(), 2);
  } finally {
    await stub.close();
  }
});

test('backendFetch times out via AbortSignal and surfaces timeout error', async () => {
  // Server that never responds within the timeout window.
  const server: Server = createServer(() => {
    // intentional: leave the request hanging
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('hanging stub failed to bind');
  const url = `http://127.0.0.1:${addr.port}`;
  try {
    await assert.rejects(
      () =>
        backendFetch(
          `${url}/api/v1/query?query=up`,
          { method: 'GET' },
          { kindLabel: 'test', timeoutMs: 50, attempts: 1 }
        ),
      /timed out after 50ms/
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});
