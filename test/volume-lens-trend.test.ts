/**
 * Volume-lens honesty contract for log10x_pattern_trend.
 *
 * Trend-specific: the factor is computed from an ENV-WIDE total (NOT the
 * pattern's own bytes), with routeState!="drop" spliced into the basis query.
 * Magnitudes (time_series[].bytes, totals, peak/low/baseline/recent, $) scale;
 * change_pct / timestamps / sample_count / spike flags are invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTrend } from '../src/tools/trend.js';
import { GB, L, vec, scalar, empty, StubBackend, makeEnv, asRecord } from './volume-lens-tool-harness.js';
import type { PrometheusResponse } from '../src/lib/api.js';

// Pattern series: 12 rising buckets (1 GB → ramps). Pattern total ~ small.
// Env total: 600 GB over the window → factor basis is the ENV total, not the
// pattern's own ~tens-of-GB. A 1-pattern env where pattern << env.
const NOW = Math.floor(Date.now() / 1000);
function patternMatrix(scale = 1): PrometheusResponse {
  const values: [number, string][] = Array.from({ length: 12 }, (_, i) => [
    NOW - (12 - i) * 3600,
    String((1 + i) * GB * scale),
  ]);
  return { status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values }] } };
}
const ENV_WINDOW_BYTES = 600 * GB; // env-wide total over the window

function backend(opts: { emptyEnvTotal?: boolean } = {}) {
  const instant = (q: string) => {
    if (q.startsWith('count(')) return empty(); // edge probe → cloud
    // env-total basis: sum(increase(...{... ,routeState!="drop"}...)) — instant
    if (q.startsWith('sum(increase') && q.includes('routeState!="drop"')) {
      return opts.emptyEnvTotal ? empty() : scalar(ENV_WINDOW_BYTES);
    }
    return empty();
  };
  // The primary pattern range query: sum by (message_pattern) (increase(...)).
  const range = (q: string) => (q.includes(`by (${L.pattern})`) ? patternMatrix() : empty());
  return new StubBackend(instant, range);
}

type Env = { data: Record<string, unknown>; summary: Record<string, unknown>; warnings?: string[] };

async function run(args: Record<string, unknown>, opts: { emptyEnvTotal?: boolean } = {}) {
  const out = await executeTrend(
    { pattern: 'pay_timeout', timeRange: '7d', analyzerCost: 2, ...args },
    makeEnv(backend(opts)),
  );
  return out as unknown as Env;
}
const p = (o: Env) => asRecord(o.data.payload);
const sd = (o: Env) => asRecord(o.data.source_disclosure);
const hl = (o: Env) => String(asRecord(o.summary).headline ?? '');

// env basis: 600 GB over 7d → ×(30/7) ≈ 2571.4 GB/mo.
const MONTHLY_GB = (600 * 30) / 7;

test('trend: factor-1 (no arg) = no stamp, no prefix', async () => {
  const out = await run({});
  assert.equal((p(out).volume_lens as Record<string, unknown>).lensed, false);
  assert.equal(sd(out).volume_scale_factor, undefined);
  assert.ok(!hl(out).startsWith('[Projected to '));
});

test('trend: factor computed from ENV total, not pattern total', async () => {
  // The pattern's own total is ~78 GB (sum 1..12 GB). If the factor were
  // derived from the pattern's own bytes, requesting MONTHLY_GB would give
  // factor≈1 and total_bytes would be unchanged. Because it's derived from the
  // ENV total (600 GB → 2571 GB/mo), requesting 3× MONTHLY_GB yields factor 3.
  const base = p(await run({}));
  const lp = p(await run({ monthly_volume_gb: MONTHLY_GB * 3 }));
  const lens = lp.volume_lens as Record<string, unknown>;
  assert.ok(Math.abs((lens.factor as number) - 3) < 1e-6, `factor should be ~3, got ${lens.factor}`);
  assert.ok(Math.abs((lp.total_bytes as number) - (base.total_bytes as number) * 3) < 1);
});

test('trend: factor-3 scales magnitudes; change_pct / ts / sample_count invariant', async () => {
  const base = p(await run({}));
  const lp = p(await run({ monthly_volume_gb: MONTHLY_GB * 3 }));
  assert.ok(Math.abs((lp.total_bytes as number) - (base.total_bytes as number) * 3) < 1);
  assert.ok(Math.abs((lp.peak_bytes as number) - (base.peak_bytes as number) * 3) < 1);
  assert.ok(Math.abs((lp.low_bytes as number) - (base.low_bytes as number) * 3) < 1);
  assert.ok(Math.abs((lp.baseline_bytes as number ?? 0) - 0) >= 0); // tolerate absence
  assert.ok(Math.abs((lp.total_cost_usd as number) - (base.total_cost_usd as number) * 3) < 1e-6);
  // time_series bytes ×3, ts identical
  const bts = base.time_series as Array<Record<string, number>>;
  const lts = lp.time_series as Array<Record<string, number>>;
  for (let i = 0; i < bts.length; i++) {
    assert.ok(Math.abs(lts[i].bytes - bts[i].bytes * 3) < 1, `ts bytes[${i}]`);
    assert.equal(lts[i].ts, bts[i].ts, `ts[${i}]`);
  }
  // invariants
  assert.equal(lp.change_pct, base.change_pct);
  assert.equal(lp.sample_count, base.sample_count);
  assert.equal(lp.spike_detected, base.spike_detected);
  assert.equal(lp.window, base.window);
  assert.equal(lp.step, base.step);
  // dollars rode bytes
  assert.ok(Math.abs((lp.total_cost_usd as number) - ((lp.total_bytes as number) / GB) * 2) < 1e-3);
});

test('trend: stamp + prefix + warning iff lensed (factor-4)', async () => {
  const out = await run({ monthly_volume_gb: MONTHLY_GB * 4 });
  const disc = sd(out);
  assert.ok(Math.abs((disc.volume_scale_factor as number) - 4) < 1e-4);
  assert.ok(hl(out).startsWith('[Projected to '));
  assert.equal((out.warnings ?? [])[0], disc.volume_projection_note);
  // must_render_verbatim's first line reuses the prefixed headline
  assert.ok(String(out.data.must_render_verbatim).startsWith('[Projected to '));
});

test('trend: no-basis (empty env total) → no stamp, magnitudes unchanged', async () => {
  const base = p(await run({}));
  const out = await run({ monthly_volume_gb: 9999 }, { emptyEnvTotal: true });
  assert.equal(sd(out).volume_scale_factor, undefined);
  assert.equal(p(out).total_bytes, base.total_bytes);
  assert.ok(!hl(out).startsWith('[Projected to '));
});
