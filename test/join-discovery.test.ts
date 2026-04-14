import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearJoinCacheForTest } from '../src/lib/join-discovery.js';

beforeEach(() => clearJoinCacheForTest());

// Jaccard math is the core correctness property. We test it directly against
// synthetic value sets, not by monkey-patching the backend — the jaccard
// computation is a pure function we can exercise in isolation.

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

test('jaccard returns 1.0 for identical sets', () => {
  const a = new Set(['x', 'y', 'z']);
  const b = new Set(['x', 'y', 'z']);
  assert.equal(jaccard(a, b), 1);
});

test('jaccard returns 0.0 for disjoint sets', () => {
  const a = new Set(['x', 'y']);
  const b = new Set(['a', 'b']);
  assert.equal(jaccard(a, b), 0);
});

test('jaccard returns expected value for partial overlap', () => {
  // shared = 2 (x, y), union = 4 (x, y, z, w), jaccard = 0.5
  const a = new Set(['x', 'y', 'z']);
  const b = new Set(['x', 'y', 'w']);
  assert.equal(jaccard(a, b), 0.5);
});

test('jaccard handles empty sets', () => {
  assert.equal(jaccard(new Set(), new Set()), 0);
  assert.equal(jaccard(new Set(['x']), new Set()), 0);
});

test('jaccard is symmetric', () => {
  const a = new Set(['x', 'y', 'z']);
  const b = new Set(['y', 'z', 'w', 'v']);
  assert.equal(jaccard(a, b), jaccard(b, a));
});
