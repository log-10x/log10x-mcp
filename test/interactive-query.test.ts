/**
 * interactive-query + boundedFanout — proves the GA deadline primitives bound a
 * slow backend instead of inheriting the 30s default, and degrade to null.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

// Shrink backoff so any internal retry path is fast.
process.env.LOG10X_RETRY_BASE_MS = '1';

const { createMetricsBackend } = await import('../src/lib/metrics-backend.js');
const { iQueryInstant } = await import('../src/lib/interactive-query.js');
const { boundedFanout, withTimeout } = await import('../src/lib/concurrency.js');

type EnvLike = Parameters<typeof iQueryInstant>[0];

async function startServer(
  handler: (req: unknown, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b?: string) => void }) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub failed to bind');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function promEnv(url: string): EnvLike {
  const metricsBackend = createMetricsBackend({ kind: 'prometheus', url, auth: { type: 'none' } });
  return { metricsBackend } as unknown as EnvLike;
}

test('iQueryInstant returns the response on a healthy backend', async () => {
  const body = { status: 'success', data: { resultType: 'vector', result: [] } };
  const stub = await startServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  });
  try {
    const res = await iQueryInstant(promEnv(stub.url), 'up', 4000);
    assert.ok(res, 'expected a response, got null');
    assert.equal(res?.status, 'success');
  } finally {
    await stub.close();
  }
});

test('iQueryInstant resolves null fast when the backend hangs (no 30s wait)', async () => {
  // Server accepts the connection but never responds.
  const stub = await startServer(() => {
    /* hang */
  });
  try {
    const t0 = Date.now();
    const res = await iQueryInstant(promEnv(stub.url), 'up', 150);
    const elapsed = Date.now() - t0;
    assert.equal(res, null, 'a hung backend must degrade to null');
    // Threaded abort fires at ~150ms, client race at ~650ms; both are far under
    // the 30s default. Generous ceiling to avoid CI flake.
    assert.ok(elapsed < 3000, `expected fast degrade, took ${elapsed}ms`);
  } finally {
    await stub.close();
  }
});

test('withTimeout resolves null when the inner promise outlives the deadline', async () => {
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 1000));
  const r = await withTimeout(slow, 50);
  assert.equal(r, null);
});

test('boundedFanout caps a slow leg to null while the rest resolve', async () => {
  const items = [1, 2, 3, 99];
  const out = await boundedFanout(
    items,
    (n) => new Promise<number>((resolve) => setTimeout(() => resolve(n * 10), n === 99 ? 2000 : 5)),
    { concurrency: 2, timeoutMs: 200 }
  );
  assert.deepEqual(out, [10, 20, 30, null]);
});

test('boundedFanout preserves order and never exceeds the concurrency cap', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await boundedFanout(
    items,
    async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return n;
    },
    { concurrency: 3, timeoutMs: 5000 }
  );
  assert.deepEqual(out, items);
  assert.ok(peak <= 3, `concurrency cap exceeded: peak ${peak}`);
});
