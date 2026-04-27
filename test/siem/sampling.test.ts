import { test } from 'node:test';
import assert from 'node:assert/strict';

import { randomTimeBuckets, perBucketCap } from '../../src/lib/siem/_sampling.js';

/** Tiny seeded RNG so two runs in this test file are deterministic. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const W_FROM = 1_700_000_000_000;
const W_TO = W_FROM + 7 * 86_400_000; // 7 days

test('randomTimeBuckets returns the requested number of buckets', () => {
  const out = randomTimeBuckets(W_FROM, W_TO, 24, seededRng(1));
  assert.equal(out.length, 24);
  assert.equal(out[0].index, 0);
  assert.equal(out[23].index, 23);
});

test('each bucket sub-window stays inside its parent slot', () => {
  const count = 24;
  const out = randomTimeBuckets(W_FROM, W_TO, count, seededRng(42));
  const parentSpan = (W_TO - W_FROM) / count;
  for (const b of out) {
    const parentStart = W_FROM + b.index * parentSpan;
    const parentEnd = parentStart + parentSpan;
    assert.ok(b.fromMs >= parentStart, `bucket ${b.index} starts before parent`);
    assert.ok(b.toMs <= parentEnd + 1, `bucket ${b.index} ends after parent`);
    assert.ok(b.toMs > b.fromMs, `bucket ${b.index} has non-positive duration`);
  }
});

test('child sub-window is a quarter of the parent slot duration', () => {
  const count = 12;
  const out = randomTimeBuckets(W_FROM, W_TO, count, seededRng(7));
  const parentSpan = (W_TO - W_FROM) / count;
  const expectedChildSpan = parentSpan / 4;
  for (const b of out) {
    const childSpan = b.toMs - b.fromMs;
    // Allow 1ms slack for floor/ceil rounding.
    assert.ok(
      Math.abs(childSpan - expectedChildSpan) <= 2,
      `bucket ${b.index} childSpan=${childSpan} expected≈${expectedChildSpan}`
    );
  }
});

test('buckets across two RNG draws produce near-zero range overlap', () => {
  // Spec: two POC runs against the same window must NOT redraw the same
  // slices. Theoretical expected overlap with the 1:4 child:parent ratio
  // is ~9% (computed: P(|X1-X2| < child) × E[overlap | overlap>0] /
  // childSpan). Average across many seed pairs to flatten RNG variance.
  const seeds = [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010];
  const ratios: number[] = [];
  for (let i = 0; i < seeds.length - 1; i++) {
    const a = randomTimeBuckets(W_FROM, W_TO, 24, seededRng(seeds[i]));
    const b = randomTimeBuckets(W_FROM, W_TO, 24, seededRng(seeds[i + 1]));
    let totalOverlapMs = 0;
    let totalSpanMs = 0;
    for (let j = 0; j < a.length; j++) {
      const overlap = Math.max(
        0,
        Math.min(a[j].toMs, b[j].toMs) - Math.max(a[j].fromMs, b[j].fromMs)
      );
      totalOverlapMs += overlap;
      totalSpanMs += a[j].toMs - a[j].fromMs;
    }
    ratios.push(totalOverlapMs / totalSpanMs);
  }
  const meanRatio = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  // Theoretical mean ≈ 0.09; assert under 0.30 to leave RNG slack across
  // 24-bucket samples.
  assert.ok(
    meanRatio < 0.3,
    `meanRatio=${meanRatio} (expected < 0.3, was 1.0 in pre-fix implementation)`
  );
});

test('randomTimeBuckets rejects an inverted range', () => {
  assert.throws(() => randomTimeBuckets(W_TO, W_FROM, 24), /invalid range/);
});

test('randomTimeBuckets rejects count < 1', () => {
  assert.throws(() => randomTimeBuckets(W_FROM, W_TO, 0), /count must be >= 1/);
});

test('perBucketCap sizes per-bucket draw with 25% slack', () => {
  // 240k events / 24 buckets = 10k base; +25% slack = 12.5k → 12_500.
  assert.equal(perBucketCap(240_000, 24), 12_500);
});

test('perBucketCap returns at least 1 even for tiny targets', () => {
  assert.equal(perBucketCap(1, 24), 1);
});
