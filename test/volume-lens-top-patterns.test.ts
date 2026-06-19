/**
 * Volume-lens honesty contract for log10x_top_patterns.
 *
 * Covers the four invariants + the top_patterns-specific traps:
 *  - 6 raw-ingest chokepoints all scale (rows, events, total denom, trend).
 *  - share_pct / percent_of_total / top_n_percent_of_total invariant.
 *  - trend_delta stays a ratio after trend buckets are scaled uniformly.
 *  - stamp present iff lensed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTopPatterns } from '../src/tools/top-patterns.js';
import { GB, L, vec, scalar, empty, matrix, StubBackend, makeEnv, asRecord } from './volume-lens-tool-harness.js';
import type { PrometheusResult } from '../src/lib/api.js';

// Two patterns: pay 40 GB / 10M events, cart 20 GB / 20M events. Total 60 GB.
const ROWS: PrometheusResult[] = [
  { metric: { [L.pattern]: 'pay_timeout', [L.service]: 'payment', [L.severity]: 'ERROR' }, value: [0, String(40 * GB)] },
  { metric: { [L.pattern]: 'cart_add', [L.service]: 'cart', [L.severity]: 'INFO' }, value: [0, String(20 * GB)] },
];
const EVENTS: PrometheusResult[] = [
  { metric: { [L.pattern]: 'pay_timeout', [L.service]: 'payment', [L.severity]: 'ERROR' }, value: [0, String(10_000_000)] },
  { metric: { [L.pattern]: 'cart_add', [L.service]: 'cart', [L.severity]: 'INFO' }, value: [0, String(20_000_000)] },
];
// Rising trend buckets so trend_delta has a non-zero WoW value to check invariance.
const TREND: [number, string][] = Array.from({ length: 20 }, (_, i) => [i, String(100 + i * 10)] as [number, string]);

// Baseline samples (1d/2d/3d offset queries) for the trajectory-badge path.
// pay_timeout: mean 32 GB vs current 40 GB → ratio 0.25 = GROWING (wow scope).
// cart_add: mean 19 GB vs current 20 GB → ratio 0.053 = GROWING (wow scope).
const BASELINE: PrometheusResult[] = [
  { metric: { [L.pattern]: 'pay_timeout', [L.service]: 'payment', [L.severity]: 'ERROR' }, value: [0, String(32 * GB)] },
  { metric: { [L.pattern]: 'cart_add', [L.service]: 'cart', [L.severity]: 'INFO' }, value: [0, String(19 * GB)] },
];

function backend(opts: { emptyTotal?: boolean; baseline?: boolean } = {}) {
  const instant = (q: string) => {
    // Baseline offset queries (1d/2d/3d) — must be checked first; they are the
    // only per-pattern queries carrying ` offset `.
    if (q.includes('offset')) return opts.baseline ? vec(BASELINE) : empty();
    if (q.startsWith('count(') && !q.includes('count by')) return empty(); // edge probe
    if (q.startsWith('topk')) return vec(ROWS);
    if (q.includes('summaryVolume')) return vec(EVENTS);
    if (q.startsWith('count(count by')) return scalar(2); // distinctPatternCount
    if (q.startsWith('sort_desc(sum by')) return vec(ROWS); // service rollup
    if (q.startsWith('sum(increase') && !q.includes(' by ')) {
      return opts.emptyTotal ? empty() : scalar(60 * GB); // totalBytesInScope
    }
    return empty();
  };
  const range = (q: string) => (q.includes('rate(') ? matrix(TREND) : empty());
  return new StubBackend(instant, range);
}

type Env = { data: Record<string, unknown>; summary: Record<string, unknown>; warnings?: string[] };

async function run(args: Record<string, unknown>, opts: { emptyTotal?: boolean; baseline?: boolean } = {}) {
  const out = await executeTopPatterns(
    { timeRange: '1h', limit: 10, effective_ingest_per_gb: 2, ...args },
    makeEnv(backend(opts)),
  );
  return out as unknown as Env;
}
const p = (o: Env) => asRecord(o.data.payload);
const sd = (o: Env) => asRecord(o.data.source_disclosure);
const hl = (o: Env) => String(asRecord(o.summary).headline ?? '');

// basis: 60 GB over 1h → ×720 → 43200 GB/mo. Use that to make factor 1.
const MONTHLY_GB = 60 * 720;

test('top_patterns: factor-1 (no arg) = no stamp, no prefix', async () => {
  const out = await run({});
  assert.equal((p(out).volume_lens as Record<string, unknown>).lensed, false);
  assert.equal(sd(out).volume_scale_factor, undefined);
  assert.ok(!hl(out).startsWith('[Projected to '));
});

test('top_patterns: factor-3 scales bytes/events/$/trend; shares + trend_delta invariant', async () => {
  const base = p(await run({}));
  const lp = p(await run({ monthly_volume_gb: MONTHLY_GB * 3 }));
  const bpat = base.patterns as Array<Record<string, unknown>>;
  const lpat = lp.patterns as Array<Record<string, unknown>>;
  const btot = asRecord(base.totals);
  const ltot = asRecord(lp.totals);
  // magnitudes ×3
  assert.ok(Math.abs((ltot.bytes_total as number) - (btot.bytes_total as number) * 3) < 1);
  assert.ok(Math.abs((ltot.monthly_usd as number) - (btot.monthly_usd as number) * 3) < 1e-6);
  for (let i = 0; i < bpat.length; i++) {
    assert.ok(Math.abs((lpat[i].bytes as number) - (bpat[i].bytes as number) * 3) < 1, `bytes[${i}]`);
    assert.ok(Math.abs((lpat[i].events as number) - (bpat[i].events as number) * 3) < 1, `events[${i}]`);
    assert.ok(Math.abs((lpat[i].cost_per_month_usd as number) - (bpat[i].cost_per_month_usd as number) * 3) < 1e-6, `cost[${i}]`);
    // trend bytes/sec array ×3
    const bt = bpat[i].trend_bytes_per_sec as number[];
    const lt = lpat[i].trend_bytes_per_sec as number[];
    for (let j = 0; j < bt.length; j++) assert.ok(Math.abs(lt[j] - bt[j] * 3) < 1e-6, `trend[${i}][${j}]`);
    // (3) shares + trend_delta (the WoW ratio) invariant
    assert.equal(lpat[i].share_pct, bpat[i].share_pct, `share_pct[${i}]`);
    assert.equal(lpat[i].percent_of_total_bytes, bpat[i].percent_of_total_bytes, `pct_of_total[${i}]`);
    assert.deepEqual(lpat[i].trend_delta, bpat[i].trend_delta, `trend_delta[${i}]`);
    assert.equal(lpat[i].first_seen_age_seconds, bpat[i].first_seen_age_seconds, `first_seen[${i}]`);
  }
  assert.equal(ltot.top_n_percent_of_total, btot.top_n_percent_of_total);
  assert.equal(lp.pattern_count_total, base.pattern_count_total);
  assert.equal(ltot.pattern_count_shown, btot.pattern_count_shown);
  // dollars rode bytes: total monthly = bytes/1e9 * $2/GB * (720/windowHours)
  // windowHours=1, so monthly = GB * 2 * 720.
  assert.ok(Math.abs((ltot.monthly_usd as number) - ((ltot.bytes_total as number) / GB) * 2 * 720) < 1e-3);
});

test('top_patterns: stamp + prefix + warning iff lensed', async () => {
  const out = await run({ monthly_volume_gb: MONTHLY_GB * 4 });
  const disc = sd(out);
  assert.equal(disc.volume_scale_factor, 4);
  assert.equal(disc.volume_actual_gb, MONTHLY_GB);
  assert.ok(hl(out).startsWith('[Projected to '));
  assert.equal((out.warnings ?? [])[0], disc.volume_projection_note);
});

test('top_patterns: no-basis (empty total) → no volume_*_gb stamp', async () => {
  const out = await run({ monthly_volume_gb: 9999 }, { emptyTotal: true });
  assert.equal(sd(out).volume_scale_factor, undefined);
  assert.ok(!hl(out).startsWith('[Projected to '));
});

test('top_patterns: lens does NOT flip the trajectory badge / trend scope (baseline present)', async () => {
  // The trap: current-window bytes scale by the factor, but the baseline
  // samples classifyBadge compares against must scale too — else the ratio
  // (current-baseline)/baseline is multiplied by the factor and the badge
  // KIND flips (GROWING→ACUTE at factor>1), which changes the reported trend
  // SCOPE (wow→h1) and glyph. Trend shape is a non-scalable signal, so it must
  // be invariant under the lens.
  const base = p(await run({}, { baseline: true }));
  const lp = p(await run({ monthly_volume_gb: MONTHLY_GB * 3 }, { baseline: true }));
  const bpat = base.patterns as Array<Record<string, unknown>>;
  const lpat = lp.patterns as Array<Record<string, unknown>>;
  assert.ok(bpat.length >= 2, 'fixture has both patterns');
  for (let i = 0; i < bpat.length; i++) {
    // trend_delta carries scope ('wow'|'h1'|'age') + glyph + value — all must
    // be byte-identical between a factor-1 and a factor-3 run on the same data.
    assert.deepEqual(lpat[i].trend_delta, bpat[i].trend_delta, `trend_delta[${i}] must be lens-invariant (scope/glyph)`);
    assert.equal(lpat[i].state, bpat[i].state, `state[${i}] must be lens-invariant`);
  }
});
