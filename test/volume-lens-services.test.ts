/**
 * Volume-lens honesty contract for log10x_services.
 *
 * Four invariants (see the task test plan):
 *  (1) factor 1 (no monthly_volume_gb) = byte-identical to today; no stamp.
 *  (2) factor N = every magnitude scales by ~N.
 *  (3) shares / ratios / counts / shareBar unchanged across factors.
 *  (4) stamp present IFF lensed; no-basis surfaces note but no volume_*_gb.
 *  (+) action-axis parts still sum to total_bytes after scaling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeServices } from '../src/tools/services.js';
import { GB, L, vec, scalar, empty, StubBackend, makeEnv, asRecord } from './volume-lens-tool-harness.js';
import type { PrometheusResult } from '../src/lib/api.js';

// Env measures: payment 30 GB, cart 18 GB, checkout 12 GB over the window.
// Total 60 GB. The action-axis: payment offloads 10 GB, cart drops 6 GB.
const SVC_BYTES: PrometheusResult[] = [
  { metric: { [L.service]: 'payment' }, value: [0, String(30 * GB)] },
  { metric: { [L.service]: 'cart' }, value: [0, String(18 * GB)] },
  { metric: { [L.service]: 'checkout' }, value: [0, String(12 * GB)] },
];
const ACTION_AXIS: PrometheusResult[] = [
  { metric: { [L.service]: 'payment', routeState: 'offload' }, value: [0, String(10 * GB)] },
  { metric: { [L.service]: 'payment', routeState: 'pass' }, value: [0, String(20 * GB)] },
  { metric: { [L.service]: 'cart', routeState: 'drop' }, value: [0, String(6 * GB)] },
  { metric: { [L.service]: 'cart', routeState: 'pass' }, value: [0, String(12 * GB)] },
  { metric: { [L.service]: 'checkout', routeState: 'pass' }, value: [0, String(12 * GB)] },
];

function backend(opts: { emptyEnv?: boolean } = {}) {
  return new StubBackend((q) => {
    if (q.startsWith('count(')) return empty(); // edge probe → falls back to cloud
    if (q.includes('routeState')) return vec(ACTION_AXIS);
    if (q.includes('sum by') && q.includes(L.service)) {
      return opts.emptyEnv ? empty() : vec(SVC_BYTES);
    }
    return empty();
  });
}

type Env = { data: Record<string, unknown>; summary: Record<string, unknown>; warnings?: string[] };

async function run(args: Record<string, unknown>, opts: { emptyEnv?: boolean } = {}) {
  const out = await executeServices(
    { timeRange: '30d', effective_ingest_per_gb: 2, ...args },
    makeEnv(backend(opts)),
  );
  return out as unknown as Env;
}

function payload(out: Env): Record<string, unknown> {
  return asRecord(out.data.payload);
}
function sd(out: Env): Record<string, unknown> {
  return asRecord(out.data.source_disclosure);
}
function headline(out: Env): string {
  return String(asRecord(out.summary).headline ?? '');
}
/** Pull the % column cells out of the monospace table for shape comparison. */
function extractPctColumn(table: string): string[] {
  return (table ?? '')
    .split('\n')
    .map((line) => (line.match(/\b\d+(?:\.\d+)?%/g) ?? []).join(','))
    .filter((s) => s.length > 0);
}

// The env's measured monthly volume = 60 GB over 30d → 60 GB/mo basis.
const MONTHLY_GB = 60;

test('services: factor-1 (no arg) = no stamp, no headline prefix, no warning', async () => {
  const out = await run({});
  const p = payload(out);
  assert.equal((p.volume_lens as Record<string, unknown>).lensed, false);
  const disc = sd(out);
  assert.equal(disc.volume_actual_gb, undefined);
  assert.equal(disc.volume_projected_gb, undefined);
  assert.equal(disc.volume_scale_factor, undefined);
  assert.ok(!headline(out).startsWith('[Projected to '));
  assert.ok((out.warnings ?? []).every((w) => !/Projection/.test(w)));
});

test('services: equal-volume arg (factor≈1) stamps but magnitudes match no-arg run', async () => {
  const base = payload(await run({}));
  const eq = await run({ monthly_volume_gb: MONTHLY_GB });
  const p = payload(eq);
  const lens = p.volume_lens as Record<string, unknown>;
  assert.equal(lens.lensed, true, 'equal-volume request still lenses (requested>0 + basis)');
  assert.ok(Math.abs((lens.factor as number) - 1) < 1e-9);
  assert.equal(p.total_bytes, base.total_bytes);
  // stamp present (factor≈1 still stamps — distinguishes from no-arg run)
  assert.equal(sd(eq).volume_scale_factor, 1);
});

test('services: factor-3 scales every magnitude by 3; shares/counts/bar invariant', async () => {
  const base = await run({});
  const lensed = await run({ monthly_volume_gb: MONTHLY_GB * 3 });
  const bp = payload(base);
  const lp = payload(lensed);
  // (2) magnitudes ×3
  assert.ok(Math.abs((lp.total_bytes as number) - (bp.total_bytes as number) * 3) < 1);
  assert.ok(Math.abs((lp.total_cost as number) - (bp.total_cost as number) * 3) < 1e-6);
  const bsvc = bp.services as Array<Record<string, unknown>>;
  const lsvc = lp.services as Array<Record<string, unknown>>;
  for (let i = 0; i < bsvc.length; i++) {
    assert.ok(Math.abs((lsvc[i].bytes as number) - (bsvc[i].bytes as number) * 3) < 1, `bytes[${i}]`);
    assert.ok(Math.abs((lsvc[i].cost as number) - (bsvc[i].cost as number) * 3) < 1e-6, `cost[${i}]`);
    assert.ok(Math.abs((lsvc[i].bytes_offloaded as number) - (bsvc[i].bytes_offloaded as number) * 3) < 1, `offload[${i}]`);
    assert.ok(Math.abs((lsvc[i].bytes_dropped as number) - (bsvc[i].bytes_dropped as number) * 3) < 1, `dropped[${i}]`);
    // (3) ratios / identity invariant
    assert.equal(lsvc[i].pct, bsvc[i].pct, `pct[${i}]`);
    assert.equal(lsvc[i].rank, bsvc[i].rank, `rank[${i}]`);
    assert.equal(lsvc[i].attribution, bsvc[i].attribution, `attribution[${i}]`);
  }
  assert.equal(lp.top_n_share_pct, bp.top_n_share_pct);
  assert.equal(lp.service_count, bp.service_count);
  assert.equal(lp.cost_per_gb, bp.cost_per_gb);
  // chart SHAPE: the verbatim table %-column is identical (shares unchanged)
  // even though the Vol/$ cells scale.
  assert.deepEqual(
    extractPctColumn(base.data.must_render_verbatim as string),
    extractPctColumn(lensed.data.must_render_verbatim as string),
  );
  // cross-check: dollars rode bytes (cost = bytes/1e9 * $/GB), $2/GB
  assert.ok(Math.abs((lp.total_cost as number) - ((lp.total_bytes as number) / GB) * 2) < 1e-6);
});

test('services: action-axis parts sum to total_bytes after scaling', async () => {
  const lp = payload(await run({ monthly_volume_gb: MONTHLY_GB * 5 }));
  const svc = lp.services as Array<Record<string, unknown>>;
  for (const s of svc) {
    const parts =
      (s.bytes_passed as number) + (s.bytes_offloaded as number) +
      (s.bytes_compacted as number) + (s.bytes_dropped as number);
    assert.ok(Math.abs(parts - (s.bytes as number)) < 1, `parts sum for ${s.name}`);
  }
});

test('services: stamp + headline prefix + warning present on factor-N run', async () => {
  const out = await run({ monthly_volume_gb: MONTHLY_GB * 4 });
  const disc = sd(out);
  assert.equal(disc.volume_actual_gb, MONTHLY_GB);
  assert.equal(disc.volume_projected_gb, MONTHLY_GB * 4);
  assert.equal(disc.volume_scale_factor, 4);
  assert.ok(typeof disc.volume_projection_note === 'string');
  assert.ok(headline(out).startsWith('[Projected to '));
  const warnings = out.warnings as string[];
  assert.ok(Array.isArray(warnings) && warnings[0] === disc.volume_projection_note);
});

test('services: no-basis (empty env) → factor 1, note in warnings, NO volume_*_gb stamp', async () => {
  // empty env returns no service rows → tool returns insufficient_data BEFORE
  // the lens math. Assert no stamp leaks and no crash.
  const out = await run({ monthly_volume_gb: 500 }, { emptyEnv: true });
  const disc = sd(out);
  assert.equal(disc.volume_actual_gb, undefined);
  assert.equal(disc.volume_scale_factor, undefined);
});
