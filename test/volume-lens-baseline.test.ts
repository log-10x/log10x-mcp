/**
 * Volume-lens honesty contract for log10x_baseline.
 *
 * Invariants + the baseline-specific leak traps:
 *  - avg_event_size_bytes (bytes/event) MUST NOT move across factors.
 *  - coverage_pct computed on UNSCALED observed volume.
 *  - top_contributors[].share_pct invariant; their monthly_usd scales.
 *  - bytes_window / p50 / p90 / monthly_usd / 90d projection scale by N.
 *  - growth_pct family invariant.
 *  - stamp present iff lensed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeBaseline } from '../src/tools/baseline.js';
import { GB, L, vec, scalar, empty, matrix, StubBackend, makeEnv, asRecord } from './volume-lens-tool-harness.js';
import type { PrometheusResult } from '../src/lib/api.js';

// 30 flat days @ 2 GB/day → total 60 GB, mean 2 GB/day, monthly basis 60 GB.
const DAILY: [number, string][] = Array.from({ length: 30 }, (_, i) => [i, String(2 * GB)] as [number, string]);

// Reporter age: oldest sample ~40 days ago (passes the 7d gate).
const OLDEST_UNIX = Math.floor(Date.now() / 1000) - 40 * 86400;

// Top contributors: payment 36 GB / 12M events (3 KB/event), cart 24 GB / 24M (1 KB/event).
const CONTRIB_BYTES: PrometheusResult[] = [
  { metric: { [L.pattern]: 'pay_timeout', [L.service]: 'payment', [L.severity]: 'ERROR', [L.hash]: 'h_pay' }, value: [0, String(36 * GB)] },
  { metric: { [L.pattern]: 'cart_add', [L.service]: 'cart', [L.severity]: 'INFO', [L.hash]: 'h_cart' }, value: [0, String(24 * GB)] },
];
const CONTRIB_EVENTS: PrometheusResult[] = [
  { metric: { [L.pattern]: 'pay_timeout', [L.service]: 'payment', [L.severity]: 'ERROR', [L.hash]: 'h_pay' }, value: [0, String(12_000_000)] },
  { metric: { [L.pattern]: 'cart_add', [L.service]: 'cart', [L.severity]: 'INFO', [L.hash]: 'h_cart' }, value: [0, String(24_000_000)] },
];

function backend(opts: { emptyDaily?: boolean } = {}) {
  const instant = (q: string) => {
    if (q.startsWith('count(')) return empty(); // edge probe → cloud
    if (q.includes('min_over_time') && q.includes('timestamp')) return scalar(OLDEST_UNIX);
    if (q.startsWith('topk')) return vec(CONTRIB_BYTES);
    if (q.includes('summaryVolume_total')) return vec(CONTRIB_EVENTS);
    return empty();
  };
  const range = (_q: string) =>
    opts.emptyDaily ? empty() : matrix(DAILY);
  return new StubBackend(instant, range);
}

type Env = { data: Record<string, unknown>; summary: Record<string, unknown>; warnings?: string[] };

async function run(args: Record<string, unknown>, opts: { emptyDaily?: boolean } = {}) {
  const out = await executeBaseline(
    { horizon: '30d', destination: 'splunk', effectiveIngestPerGb: 2, ...args },
    makeEnv(backend(opts)),
  );
  return out as unknown as Env;
}
const p = (o: Env) => asRecord(o.data.payload);
const sd = (o: Env) => asRecord(o.data.source_disclosure);
const hl = (o: Env) => String(asRecord(o.summary).headline ?? '');

const MONTHLY_GB = 60;

test('baseline: factor-1 (no arg) = no stamp, no prefix, status ready', async () => {
  const out = await run({});
  assert.equal(p(out).status, 'ready');
  assert.equal((p(out).volume_lens as Record<string, unknown>).lensed, false);
  assert.equal(sd(out).volume_scale_factor, undefined);
  assert.ok(!hl(out).startsWith('[Projected to '));
});

test('baseline: factor-3 scales magnitudes; ratios + avg_event_size invariant', async () => {
  const base = p(await run({}));
  const lp = p(await run({ monthly_volume_gb: MONTHLY_GB * 3 }));
  const bc = asRecord(base.current);
  const lc = asRecord(lp.current);
  // magnitudes ×3
  assert.ok(Math.abs((lc.bytes_window as number) - (bc.bytes_window as number) * 3) < 1);
  assert.ok(Math.abs((lc.bytes_per_day_p50 as number) - (bc.bytes_per_day_p50 as number) * 3) < 1);
  assert.ok(Math.abs((lc.bytes_per_day_p90 as number) - (bc.bytes_per_day_p90 as number) * 3) < 1);
  assert.ok(Math.abs((lc.monthly_usd as number) - (bc.monthly_usd as number) * 3) < 1e-6);
  const bproj = asRecord(base.projection_no_action_90d);
  const lproj = asRecord(lp.projection_no_action_90d);
  assert.ok(Math.abs((lproj.monthly_usd_in_90d as number) - (bproj.monthly_usd_in_90d as number) * 3) < 1e-6);
  // growth family invariant
  assert.equal(lproj.growth_pct, bproj.growth_pct);
  assert.equal(lproj.monthly_compound_growth_percent, bproj.monthly_compound_growth_percent);
  assert.equal(lproj.horizon_total_growth_pct, bproj.horizon_total_growth_pct);
  // coverage invariant (no statedDailyGb → 100 both)
  assert.equal(lp.coverage_pct, base.coverage_pct);
  // top contributors: monthly_usd scales, share + avg_event_size invariant
  const bt = base.top_contributors as Array<Record<string, unknown>>;
  const lt = lp.top_contributors as Array<Record<string, unknown>>;
  assert.ok(bt.length > 0);
  for (let i = 0; i < bt.length; i++) {
    assert.equal(lt[i].share_pct, bt[i].share_pct, `share_pct[${i}]`);
    assert.equal(lt[i].avg_event_size_bytes, bt[i].avg_event_size_bytes, `avg_event_size_bytes[${i}] (leak trap)`);
    assert.equal(lt[i].compactable, bt[i].compactable, `compactable[${i}]`);
    assert.ok(Math.abs((lt[i].monthly_usd as number) - (bt[i].monthly_usd as number) * 3) < 1e-6, `monthly_usd[${i}]`);
  }
  // recommendation band (depends on compactable shares) invariant
  assert.deepEqual(lp.recommended_target_range, base.recommended_target_range);
});

test('baseline: stamp + prefix + warning iff lensed (factor-4)', async () => {
  const out = await run({ monthly_volume_gb: MONTHLY_GB * 4 });
  const disc = sd(out);
  assert.equal(disc.volume_actual_gb, MONTHLY_GB);
  assert.equal(disc.volume_projected_gb, MONTHLY_GB * 4);
  assert.equal(disc.volume_scale_factor, 4);
  assert.ok(hl(out).startsWith('[Projected to '));
  assert.equal((out.warnings ?? [])[0], disc.volume_projection_note);
});

test('baseline: avg_event_size_bytes equals raw bytes/events (3 KB and 1 KB), unchanged at factor 10', async () => {
  const lp = p(await run({ monthly_volume_gb: MONTHLY_GB * 10 }));
  const lt = lp.top_contributors as Array<Record<string, unknown>>;
  const pay = lt.find((t) => t.service === 'payment')!;
  const cart = lt.find((t) => t.service === 'cart')!;
  assert.ok(Math.abs((pay.avg_event_size_bytes as number) - 3000) < 1);
  assert.ok(Math.abs((cart.avg_event_size_bytes as number) - 1000) < 1);
});
