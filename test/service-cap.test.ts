/**
 * A per-service cap sits between the largest statement the plan keeps and
 * the smallest it moves, at their geometric mean, so each side has the same
 * ratio of margin; when the two do not separate, the cap stays at the
 * largest kept statement and the plan says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtMargin, marginSentence, placeServiceCap } from '../src/lib/service-cap.js';

test('the geometric mean gives both sides the same ratio', () => {
  const p = placeServiceCap(1000, 2560);
  assert.equal(p.separated, true);
  assert.equal(p.cap, 1600);
  assert.equal(p.margin, 1.6);
  assert.equal(p.cap / p.keptMax, p.movedMin! / p.cap);
});

test('no separation: the cap stays at the largest kept statement', () => {
  assert.deepEqual(placeServiceCap(1000, 800), { cap: 1000, keptMax: 1000, movedMin: 800, separated: false });
  assert.deepEqual(placeServiceCap(1000, 1000), { cap: 1000, keptMax: 1000, movedMin: 1000, separated: false });
});

test('nothing kept or nothing moved: the cap is the largest kept statement', () => {
  assert.deepEqual(placeServiceCap(0, 500), { cap: 0, keptMax: 0, movedMin: 500, separated: false });
  assert.deepEqual(placeServiceCap(700, undefined), { cap: 700, keptMax: 700, separated: false });
});

test('the margin in the reader\'s terms', () => {
  assert.equal(fmtMargin(1.6), '1.6x');
  assert.equal(fmtMargin(2), '2x');
  assert.equal(fmtMargin(13.416), '13.4x');
  assert.equal(
    marginSentence('checkout', placeServiceCap(1000, 2560), 'Standard'),
    'checkout: the largest kept statement can grow 1.6x before it is held; the smallest moved one is 1.6x above the limit.',
  );
  assert.equal(
    marginSentence('otelcol', placeServiceCap(1000, 800), 'Standard'),
    'otelcol: no limit separates the statements, because the smallest one moved is no busier than the largest one kept; the limit stays at the largest kept statement, and a moved statement under it stays in Standard.',
  );
  assert.equal(marginSentence('cart', placeServiceCap(0, 500), 'Standard'), undefined);
  assert.equal(marginSentence('api', placeServiceCap(700, undefined), 'Standard'), undefined);
  for (const s of [marginSentence('a', placeServiceCap(1, 4), 'Standard')!, marginSentence('b', placeServiceCap(4, 1), 'Standard')!]) {
    assert.ok(!s.includes('\u2014'));
  }
});
