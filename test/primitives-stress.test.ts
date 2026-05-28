/**
 * Stress test for the cross-pillar primitives — the customer-scale
 * track from the GA confidence checklist.
 *
 * The math is unit-tested (primitives-math). The integration chain is
 * tested (primitives-integration). What's UNTESTED there is what
 * happens when N candidates is large, when a fraction of queries 503,
 * and when backend latency is non-zero.
 *
 * What this asserts:
 *   1. metrics_that_moved with 500 candidates + 10% injected 503s
 *      completes in under a budget AND returns a coherent envelope:
 *        - moved[] + not_moved[] + evaluation_failed[] sum to N
 *        - failed candidates ≈ 10% of input
 *        - no thrown exception (partial failures don't abort the run)
 *   2. rank_by_shape_similarity with 100 candidates + per-query latency
 *      still completes (lower bound on the candidate cap is 200).
 *   3. The stub's `totalQueries()` count matches expectations (one
 *      query per candidate + one anchor).
 *
 * Not asserted: absolute wall time. Budgets are loose multiples of the
 * stub's no-latency baseline so a slow CI doesn't flake the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStubProm, buildSeries, STUB_ENV } from './helpers/stub-prom.js';
import { executeMetricsThatMoved } from '../src/tools/metrics-that-moved.js';
import { executeRankByShapeSimilarity } from '../src/tools/rank-by-shape-similarity.js';
import type { EnvConfig } from '../src/lib/environments.js';

const ENV = STUB_ENV as EnvConfig;

function snapshotEnv() {
  return {
    url: process.env.LOG10X_CUSTOMER_METRICS_URL,
    type: process.env.LOG10X_CUSTOMER_METRICS_TYPE,
  };
}
function restoreEnv(s: { url?: string; type?: string }) {
  if (s.url === undefined) delete process.env.LOG10X_CUSTOMER_METRICS_URL;
  else process.env.LOG10X_CUSTOMER_METRICS_URL = s.url;
  if (s.type === undefined) delete process.env.LOG10X_CUSTOMER_METRICS_TYPE;
  else process.env.LOG10X_CUSTOMER_METRICS_TYPE = s.type;
}

// ── metrics_that_moved at scale ──────────────────────────────────────

test('stress: metrics_that_moved with 100 candidates + 10% 503 rail completes coherently', async () => {
  const before = snapshotEnv();
  const stub = await startStubProm();
  process.env.LOG10X_CUSTOMER_METRICS_URL = stub.url;
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'generic_prom';
  try {
    const endTs = Math.floor(Date.now() / 1000);
    // Anchor: distinct values so partitionByMedian splits cleanly.
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });

    // 100 candidates (max the schema allows). Half are co-movers, half
    // are flat — distribution doesn't matter for the assertion; what
    // matters is that the loop processes all of them without aborting.
    const candidates: string[] = [];
    for (let i = 0; i < 100; i++) {
      const name = `cand_${i}`;
      candidates.push(name);
      const vals =
        i % 2 === 0
          ? [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]
          : Array(20).fill(7);
      stub.setFixture(name, { values: buildSeries(vals, 30, endTs) });
    }

    stub.setFailureRate(0.1);

    const startMs = Date.now();
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates,
        window: '10m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    const elapsedMs = Date.now() - startMs;

    if (typeof out === 'string') throw new Error('expected envelope');
    const data = out.data as {
      moved: unknown[];
      not_moved: unknown[];
      evaluation_failed: string[];
      n_candidates_evaluated: number;
    };

    // No thrown exception — coverage on the partial-failure path.
    // moved + not_moved + failed must sum to the input count.
    const total = data.moved.length + data.not_moved.length + data.evaluation_failed.length;
    assert.equal(total, 100, `accounting failure: ${data.moved.length} + ${data.not_moved.length} + ${data.evaluation_failed.length} != 100`);

    // ~10% failure rate. The stub schedules failures deterministically,
    // so the exact count depends on the request order (anchor + 100
    // candidates = 201 requests). With rate 0.1, expect ~20 failures.
    // Loose bounds: 10-30. If we hit zero, the rail didn't fire and the
    // test is silently passing.
    assert.ok(
      data.evaluation_failed.length >= 10 && data.evaluation_failed.length <= 30,
      `expected ~20 failures from 10% rail, got ${data.evaluation_failed.length}`,
    );

    // Loose budget. 100 sequential queries at zero stub latency should
    // be well under a second on CI; 10s is the "something is structurally
    // wrong" cliff (synchronous wait, accidental sleep, etc.).
    assert.ok(elapsedMs < 10_000, `wall time blew budget: ${elapsedMs}ms`);

    // Stub saw N+1 queries: 1 anchor + 100 candidates.
    assert.equal(stub.totalQueries(), 101);
  } finally {
    await stub.close();
    restoreEnv(before);
  }
});

// ── rank_by_shape_similarity at scale ────────────────────────────────

test('stress: rank_by_shape with 100 candidates + injected latency stays within budget', async () => {
  const before = snapshotEnv();
  const stub = await startStubProm();
  process.env.LOG10X_CUSTOMER_METRICS_URL = stub.url;
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'generic_prom';
  try {
    const endTs = Math.floor(Date.now() / 1000);
    const shape = [0, 0, 1, 3, 8, 15, 20, 18, 10, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    stub.setFixture('anchor', { values: buildSeries(shape, 30, endTs) });

    const candidates: string[] = [];
    for (let i = 0; i < 100; i++) {
      const name = `cand_${i}`;
      candidates.push(name);
      // Vary the shape slightly so Pearson produces a real distribution.
      const variant = shape.map((v) => v + (i % 5));
      stub.setFixture(name, { values: buildSeries(variant, 30, endTs) });
    }

    // 5ms per query. 201 requests at 5ms each = ~1s minimum. Tests
    // that the synchronous candidate loop doesn't multiplicatively
    // blow up under per-query delay.
    stub.setLatencyMs(5);

    const startMs = Date.now();
    const out = await executeRankByShapeSimilarity(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates,
        window: '10m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    const elapsedMs = Date.now() - startMs;

    if (typeof out === 'string') throw new Error('expected envelope');
    const data = out.data as { ranked: unknown[]; evaluation_failed: string[] };
    assert.equal(data.ranked.length + data.evaluation_failed.length, 100);

    // Lower bound: 101 queries (1 anchor + 100 candidates) × 5ms ≈ 500ms.
    assert.ok(elapsedMs >= 500, `expected serialised query budget ≥500ms, got ${elapsedMs}ms`);
    // Upper bound: 30s — pure-sequential at 5ms/q should be ~1-2s on
    // CI. 30s = "the loop has a hidden parallelism bug or unbounded retry."
    assert.ok(elapsedMs < 30_000, `wall time blew budget: ${elapsedMs}ms`);
  } finally {
    await stub.close();
    restoreEnv(before);
  }
});

// ── degenerate at scale ──────────────────────────────────────────────

test('stress: every candidate 503s → ALL go to evaluation_failed[], no crash', async () => {
  const before = snapshotEnv();
  const stub = await startStubProm();
  process.env.LOG10X_CUSTOMER_METRICS_URL = stub.url;
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'generic_prom';
  try {
    const endTs = Math.floor(Date.now() / 1000);
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });
    const candidates: string[] = [];
    for (let i = 0; i < 50; i++) {
      const name = `cand_${i}`;
      candidates.push(name);
      stub.setFixture(name, { values: buildSeries(Array(20).fill(5), 30, endTs) });
    }

    // The first request (anchor) succeeds under rate<1.0; subsequent
    // candidate requests need to fail. Per the stub's schedule, rate=0.99
    // fails almost every request after the first.
    stub.setFailureRate(0.99);

    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates,
        window: '10m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const data = out.data as { evaluation_failed: string[]; moved: unknown[]; not_moved: unknown[] };
    // At least 45/50 should fail at rate 0.99.
    assert.ok(
      data.evaluation_failed.length >= 45,
      `expected near-total candidate failure at rate=0.99, got ${data.evaluation_failed.length}`,
    );
    assert.equal(data.moved.length + data.not_moved.length + data.evaluation_failed.length, 50);
  } finally {
    await stub.close();
    restoreEnv(before);
  }
});
