import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/lib/concurrency.js';

test('createLimiter caps concurrency', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
  };
  await Promise.all(Array.from({ length: 10 }, () => limit(task)));
  assert.ok(maxActive <= 2, `expected maxActive <= 2, got ${maxActive}`);
});

test('createLimiter runs tasks and returns their results', async () => {
  const limit = createLimiter(3);
  const results = await Promise.all([limit(async () => 1), limit(async () => 2), limit(async () => 3)]);
  assert.deepEqual(results, [1, 2, 3]);
});

test('softExpire causes new tasks to resolve to undefined', async () => {
  const limit = createLimiter(2);
  limit.softExpire();
  const result = await limit(async () => 'should not run');
  assert.equal(result, undefined);
  assert.ok(limit.isSoftExpired());
});

test('soft deadline fires automatically', async () => {
  const limit = createLimiter(2, 5); // 5 ms deadline
  await new Promise((r) => setTimeout(r, 10));
  const result = await limit(async () => 'x');
  assert.equal(result, undefined);
});

test('limiter propagates task errors', async () => {
  const limit = createLimiter(2);
  await assert.rejects(
    () => limit(async () => {
      throw new Error('boom');
    }),
    /boom/
  );
});
