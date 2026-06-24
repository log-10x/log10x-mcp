/**
 * pattern_detail slow-backend proof — the original hang was the METRIC query
 * layer (resolveMetricsEnv 3x + the per-leg increase queries + the df-context),
 * none of which had a per-call deadline. This test points the bounded metric
 * helpers at a stub Prometheus that takes 3s to answer EVERY query and asserts
 * each helper returns in well under that — every leg is aborted at its
 * interactive budget before the backend would respond even once — and degrades
 * to its empty fallback instead of throwing or hanging.
 *
 * We test the helpers directly (not executePatternDetail) so the proof isolates
 * the metric layer we fixed, not the shared env-load path (loadEnvironments /
 * alias-bridge), which has its own latency characteristics and is not the
 * reported hang. The threaded timeoutMs aborts the in-flight fetch, so these
 * exit cleanly (no orphaned 3s request).
 *
 * Budgets are shrunk via env so the test is fast; they are read at module load,
 * so they must be set before importing interactive-query (via pattern-detail).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { StubProm } from './helpers/stub-prom.js';

process.env.LOG10X_INTERACTIVE_TIMEOUT_MS = '200'; // cheap tier
process.env.LOG10X_INTERACTIVE_HEAVY_TIMEOUT_MS = '400'; // heavy tier
process.env.LOG10X_RETRY_BASE_MS = '1';

const { startStubProm } = await import('./helpers/stub-prom.js');
const { createMetricsBackend } = await import('../src/lib/metrics-backend.js');
const { __testables } = await import('../src/tools/pattern-detail.js');

type EnvLike = Parameters<typeof __testables.fetchServiceBreakdown>[0];

let stub: StubProm;

function slowEnv(): EnvLike {
  const metricsBackend = createMetricsBackend({ kind: 'prometheus', url: stub.url, auth: { type: 'none' } });
  return { metricsBackend } as unknown as EnvLike;
}

before(async () => {
  stub = await startStubProm();
  stub.setLatencyMs(3000); // 3s per response, longer than any single round trip
});

after(async () => {
  await stub.close();
});

test('fetchServiceBreakdown (heavy [30d] leg) bounds + degrades to [] on a slow backend', async () => {
  const t0 = Date.now();
  const rows = await __testables.fetchServiceBreakdown(slowEnv(), 'deadbeef0000', 'cloud');
  const elapsed = Date.now() - t0;
  // heavy budget 400ms + client-race grace 500ms — far under the 3000ms backend
  // latency, proving the leg aborts instead of waiting (the old hang).
  assert.ok(elapsed < 1500, `expected bounded < 1500ms, took ${elapsed}ms`);
  assert.deepEqual(rows, []);
});

test('resolvePatternName (cheap leg) bounds + degrades to null on a slow backend', async () => {
  const t0 = Date.now();
  const name = await __testables.resolvePatternName(slowEnv(), 'deadbeef0000', 'cloud');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1200, `expected bounded < 1200ms, took ${elapsed}ms`); // cheap 200 + grace 500
  assert.equal(name, null);
});

test('fetchTrend (cheap range leg) bounds + degrades to [] on a slow backend', async () => {
  const t0 = Date.now();
  const series = await __testables.fetchTrend(slowEnv(), 'deadbeef0000', '7d');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1200, `expected bounded < 1200ms, took ${elapsed}ms`);
  assert.deepEqual(series, []);
});

test('fetchEnvMonthlyBytes (heavy leg) bounds + degrades to 0 on a slow backend', async () => {
  const t0 = Date.now();
  const bytes = await __testables.fetchEnvMonthlyBytes(slowEnv(), 'cloud');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `expected bounded < 1500ms, took ${elapsed}ms`);
  assert.equal(bytes, 0);
});
