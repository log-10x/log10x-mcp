/**
 * Tests for the shared offload-status helper (`src/lib/offload-status.ts`).
 *
 * Three happy-path cases per the spec:
 *   1. Kept-only series → is_offloaded=false.
 *   2. Both cohorts present, 30% dropped → dropped_share_pct ≈ 30.
 *   3. Timeout → ok=false.
 *
 * The helper calls `queryInstant(env, promql)` which delegates to
 * `env.metricsBackend.queryInstant`. The tests stub the backend in-place
 * with a tiny fake that returns canned scalar responses keyed by which
 * cohort the query is asking for (kept = `isDropped!="true"`, dropped =
 * `isDropped="true"`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getOffloadStatus } from '../src/lib/offload-status.js';
import { DEFAULT_LABELS } from '../src/lib/promql.js';
import type { PrometheusResponse } from '../src/lib/api.js';
import type { EnvConfig } from '../src/lib/environments.js';

function scalarResp(value: number): PrometheusResponse {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: [{ metric: {}, value: [Math.floor(Date.now() / 1000), String(value)] }],
    },
  };
}

function emptyResp(): PrometheusResponse {
  return { status: 'success', data: { resultType: 'vector', result: [] } };
}

interface StubOpts {
  /** Bytes for the `isDropped!="true"` (kept) cohort. */
  kept: number;
  /** Bytes for the `isDropped="true"` (dropped) cohort. */
  dropped: number;
  /** When true, `queryInstant` never resolves (forces timeout in the helper). */
  hang?: boolean;
  /** When true, only the kept-cohort query hangs (dropped + timestamp resolve). */
  hangKept?: boolean;
}

function makeEnv(opts: StubOpts): EnvConfig {
  const backend = {
    kind: 'log10x' as const,
    endpoint: 'stub://offload-test',
    async queryInstant(promql: string): Promise<PrometheusResponse> {
      if (opts.hang) return await new Promise<PrometheusResponse>(() => {});
      // Selective hang: only the kept-cohort scan stalls. Reproduces
      // the heavy-pattern tail-latency mode the demo hit on
      // AQwRuueOWbQ — dropped cohort comes back fast, kept does not.
      if (opts.hangKept && promql.includes('isDropped!="true"')) {
        return await new Promise<PrometheusResponse>(() => {});
      }
      // Discriminate by which `isDropped` filter the query carries.
      // `timestamp(max(...))` queries go through the dropped branch too.
      if (promql.includes('isDropped="true"')) {
        if (promql.startsWith('timestamp(')) {
          // Last-seen timestamp piggyback — return a recent epoch seconds.
          return opts.dropped > 0 ? scalarResp(Math.floor(Date.now() / 1000)) : emptyResp();
        }
        return opts.dropped > 0 ? scalarResp(opts.dropped) : emptyResp();
      }
      if (promql.includes('isDropped!="true"')) {
        return opts.kept > 0 ? scalarResp(opts.kept) : emptyResp();
      }
      return emptyResp();
    },
    async queryRange(): Promise<PrometheusResponse> {
      return emptyResp();
    },
    async listLabels(): Promise<string[]> {
      return [];
    },
    async listLabelValues(): Promise<string[]> {
      return [];
    },
  };
  return {
    nickname: 'offload-test',
    metricsBackend: backend,
    labels: DEFAULT_LABELS,
    apiKey: 'stub',
    envId: 'stub',
  };
}

test('getOffloadStatus: kept-only series → is_offloaded=false', async () => {
  const env = makeEnv({ kept: 1000, dropped: 0 });
  const s = await getOffloadStatus(env, {
    patternHash: 'abc123',
    metricsEnv: 'edge',
    timeoutMs: 200,
  });
  assert.equal(s.ok, true);
  assert.equal(s.is_offloaded, false);
  assert.equal(s.dropped_bytes_in_window, 0);
  assert.equal(s.dropped_share_pct, 0);
  assert.equal(s.kept_bytes_in_window, 1000);
  assert.equal(s.last_seen_dropped_ts, null);
});

test('getOffloadStatus: 30% dropped → dropped_share_pct ≈ 30', async () => {
  const env = makeEnv({ kept: 700, dropped: 300 });
  const s = await getOffloadStatus(env, {
    patternHash: 'abc123',
    metricsEnv: 'edge',
    timeoutMs: 200,
  });
  assert.equal(s.ok, true);
  assert.equal(s.is_offloaded, true);
  assert.equal(s.dropped_bytes_in_window, 300);
  assert.equal(s.kept_bytes_in_window, 700);
  assert.ok(s.dropped_share_pct !== null && Math.abs(s.dropped_share_pct - 30) < 0.001, `expected ~30, got ${s.dropped_share_pct}`);
  assert.ok(s.last_seen_dropped_ts !== null && s.last_seen_dropped_ts > 0);
});

test('getOffloadStatus: timeout → ok=false, zeroed fields', async () => {
  const env = makeEnv({ kept: 0, dropped: 0, hang: true });
  const t0 = Date.now();
  const s = await getOffloadStatus(env, {
    patternHash: 'abc123',
    metricsEnv: 'edge',
    timeoutMs: 50,
  });
  const elapsed = Date.now() - t0;
  assert.equal(s.ok, false);
  assert.equal(s.is_offloaded, false);
  assert.equal(s.dropped_bytes_in_window, 0);
  assert.equal(s.dropped_share_pct, 0);
  assert.equal(s.kept_bytes_in_window, 0);
  assert.equal(s.last_seen_dropped_ts, null);
  // Helper must respect the timeout (parallel queries, single budget).
  assert.ok(elapsed < 500, `expected <500ms, got ${elapsed}ms`);
});

test('getOffloadStatus: full offload (zero kept) → 100% share', async () => {
  const env = makeEnv({ kept: 0, dropped: 500 });
  const s = await getOffloadStatus(env, {
    patternHash: 'abc123',
    metricsEnv: 'edge',
    timeoutMs: 200,
  });
  assert.equal(s.ok, true);
  assert.equal(s.is_offloaded, true);
  assert.equal(s.dropped_share_pct, 100);
});

test('getOffloadStatus: empty hash → ok=false short-circuit', async () => {
  const env = makeEnv({ kept: 1000, dropped: 0 });
  const s = await getOffloadStatus(env, {
    patternHash: '',
    metricsEnv: 'edge',
    timeoutMs: 200,
  });
  assert.equal(s.ok, false);
});

test('getOffloadStatus: kept times out, dropped resolves → partial result with kept_timed_out=true', async () => {
  // Heavy-pattern tail-latency mode. The smoke surfaced this on demo
  // pattern_hash AQwRuueOWbQ (21.55 GB dropped, ~3x next-largest):
  // the dropped cohort returned in well under 2s, the kept-cohort
  // PromQL scan did not. Before the fix the envelope collapsed
  // entirely; after the fix is_offloaded survives, share math nulls out,
  // kept_timed_out flag flips on.
  const env = makeEnv({ kept: 1000, dropped: 500, hangKept: true });
  const t0 = Date.now();
  const s = await getOffloadStatus(env, {
    patternHash: 'abc123',
    metricsEnv: 'edge',
    timeoutMs: 50,
  });
  const elapsed = Date.now() - t0;
  assert.equal(s.ok, true, 'partial result must be ok=true so callers do not suppress UI');
  assert.equal(s.is_offloaded, true, 'dropped cohort > 0 → is_offloaded survives');
  assert.equal(s.dropped_bytes_in_window, 500);
  assert.equal(s.kept_bytes_in_window, null, 'kept bytes nulled when kept query times out');
  assert.equal(s.dropped_share_pct, null, 'share math suppressed without both sides');
  assert.equal(s.kept_timed_out, true);
  assert.equal(s.dropped_timed_out, undefined);
  // last_seen_dropped_ts still populates from the dropped-timestamp query.
  assert.ok(s.last_seen_dropped_ts !== null && s.last_seen_dropped_ts > 0);
  // Bounded by the per-query timeout, not the sum of them.
  assert.ok(elapsed < 500, `expected <500ms, got ${elapsed}ms`);
});
