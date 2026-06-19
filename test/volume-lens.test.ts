import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVolumeLens, volumeLensDisclosure } from '../src/lib/volume-lens.js';

const GB = 1_000_000_000;

test('no request → not lensed, factor 1, no disclosure', () => {
  const r = resolveVolumeLens(undefined, 50 * GB);
  assert.equal(r.lensed, false);
  assert.equal(r.factor, 1);
  assert.equal(r.basis, 'none');
  assert.equal(r.disclosure, null);
  assert.equal(r.actual_monthly_bytes, 50 * GB);
  assert.equal(r.projected_monthly_bytes, null);
});

test('request + real basis → factor scales linearly, lensed, disclosed', () => {
  // env measures 50 GB/mo; caller models 5000 GB/mo → ×100.
  const r = resolveVolumeLens(5000, 50 * GB);
  assert.equal(r.lensed, true);
  assert.equal(r.basis, 'requested');
  assert.equal(r.factor, 100);
  assert.equal(r.projected_monthly_bytes, 5000 * GB);
  assert.equal(r.actual_monthly_bytes, 50 * GB);
  assert.ok(r.disclosure && /Projection/.test(r.disclosure), 'disclosure present');
  // projected / actual must equal the factor (uniform-scale guarantee).
  assert.equal(r.projected_monthly_bytes! / r.actual_monthly_bytes!, r.factor);
});

test('request but no measured basis → not lensed, explains why', () => {
  const r = resolveVolumeLens(5000, 0);
  assert.equal(r.lensed, false);
  assert.equal(r.factor, 1, 'factor must stay 1 so unscaled numbers ship');
  assert.equal(r.basis, 'no_basis');
  assert.ok(r.disclosure && /no measured volume/i.test(r.disclosure));
});

test('non-positive / non-finite request is ignored', () => {
  for (const bad of [0, -100, NaN, Infinity]) {
    const r = resolveVolumeLens(bad, 50 * GB);
    assert.equal(r.lensed, false, `request ${bad} must not lens`);
    assert.equal(r.factor, 1);
  }
});

test('volumeLensDisclosure: stamps actual/projected/factor when lensed, empty otherwise', () => {
  const lensed = resolveVolumeLens(5000, 50 * GB);
  const stamp = volumeLensDisclosure(lensed);
  assert.equal(stamp.volume_actual_gb, 50);
  assert.equal(stamp.volume_projected_gb, 5000);
  assert.equal(stamp.volume_scale_factor, 100);
  assert.ok(typeof stamp.volume_projection_note === 'string');

  const notLensed = resolveVolumeLens(undefined, 50 * GB);
  assert.deepEqual(volumeLensDisclosure(notLensed), {});
});

test('downscale projection works too (real env shrinks in the what-if)', () => {
  // env measures 100 GB/mo; model it at 25 GB/mo → ×0.25.
  const r = resolveVolumeLens(25, 100 * GB);
  assert.equal(r.lensed, true);
  assert.equal(r.factor, 0.25);
});
