/**
 * A retriever query that matches nothing must come back in seconds, and must
 * not blame the index for a miss.
 *
 * Measured on the demo Lambda retriever (2026-09-28): `severity_level=="ERROR"`
 * over the last hour returned 0 events after 186-189 s, every time. The worker
 * log said `reason=bloom-miss` (the sample holds no ERROR lines), but no
 * marker is written when nothing matches, and the stability wait only settled
 * on a non-empty set, so it ran out the 180 s budget. Without
 * LOG10X_RETRIEVER_LOG_GROUP the reply also said "No index blobs were found
 * for the queried time window": a 20 s probe window, on an index written
 * every 30 minutes, found no blobs and was reported as the verdict for the
 * whole hour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markerSetSettled, probeVerdictLocalizes } from '../src/lib/retriever-api.js';

test('an empty marker set settles after the empty quiet window', () => {
  assert.equal(markerSetSettled([], [], 44_000, 12_000, 45_000), false);
  assert.equal(markerSetSettled([], [], 45_000, 12_000, 45_000), true);
});

test('a non-empty marker set still settles on the shorter window', () => {
  assert.equal(markerSetSettled(['a', 'b'], ['a', 'b'], 12_000, 12_000, 45_000), true);
  assert.equal(markerSetSettled(['a', 'b'], ['a', 'b'], 11_999, 12_000, 45_000), false);
});

test('a marker set that changed has not settled', () => {
  assert.equal(markerSetSettled(['a'], [], 60_000, 12_000, 45_000), false);
  assert.equal(markerSetSettled(['a', 'b'], ['a'], 60_000, 12_000, 45_000), false);
});

test('an empty probe window is not a verdict on the whole range', () => {
  assert.equal(probeVerdictLocalizes('EMPTY_RANGE'), false);
  assert.equal(probeVerdictLocalizes('DISPATCHED_BLIND'), false);
  assert.equal(probeVerdictLocalizes('NO_MARKER'), false);
  assert.equal(probeVerdictLocalizes(undefined), false);
  assert.equal(probeVerdictLocalizes('BLOOM_REJECTED_ALL'), true);
});
