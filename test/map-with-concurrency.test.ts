/**
 * mapWithConcurrency — the bounded-pool primitive behind the Retriever's
 * parallel result download. Correctness contract:
 *   1. output order matches input order (events are sorted after, but the
 *      summaries loop relies on stable order),
 *   2. never more than `concurrency` calls in flight at once,
 *   3. the first rejection propagates AND idle workers stop pulling new
 *      items (so one failed S3 read aborts the fetch, not a partial set).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../src/lib/retriever-api.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('preserves input order regardless of completion order', async () => {
  const items = [0, 1, 2, 3, 4, 5];
  // Reverse the durations so later items finish first.
  const out = await mapWithConcurrency(items, 3, async (n) => {
    await tick((items.length - n) * 5);
    return n * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40, 50]);
});

test('never exceeds the concurrency cap', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapWithConcurrency(items, 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(5);
    inFlight--;
    return n;
  });
  assert.ok(peak <= 4, `peak in-flight ${peak} exceeded cap 4`);
  assert.ok(peak >= 2, `expected real concurrency, peak was ${peak}`);
});

test('first rejection propagates and stops new work', async () => {
  const started: number[] = [];
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
      started.push(n);
      await tick(5);
      if (n === 1) throw new Error('boom on 1');
      return n;
    }),
    /boom on 1/,
  );
  // With cap=2, items 0 and 1 start first; 1 throws and aborts. Only a few
  // items should have started — never the whole list.
  assert.ok(started.length < 8, `aborted run still started all items: ${started.join(',')}`);
});

test('concurrency larger than item count is harmless', async () => {
  const out = await mapWithConcurrency([1, 2], 100, async (n) => n + 1);
  assert.deepEqual(out, [2, 3]);
});

test('empty input returns empty array without spawning workers', async () => {
  let calls = 0;
  const out = await mapWithConcurrency([], 8, async () => {
    calls++;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});
