import { test } from 'node:test';
import assert from 'node:assert/strict';

import { retryWithBackoff, backoffMs, shouldStop, sleep } from '../../src/lib/siem/_retry.js';

test('backoffMs grows exponentially within cap', () => {
  // Multiple samples because of jitter; check within bounds.
  for (let attempt = 0; attempt < 6; attempt++) {
    const base = 500;
    const cap = 20_000;
    const samples = Array.from({ length: 10 }, () => backoffMs(attempt, base, cap));
    const mean = samples.reduce((s, n) => s + n, 0) / samples.length;
    const expected = Math.min(cap, base * Math.pow(2, attempt));
    // Jitter is +/-20%; allow a wide tolerance.
    assert.ok(mean >= expected * 0.6, `attempt=${attempt} mean=${mean} expected>=${expected * 0.6}`);
    assert.ok(mean <= expected * 1.5, `attempt=${attempt} mean=${mean} expected<=${expected * 1.5}`);
  }
});

test('shouldStop stops when target reached', () => {
  assert.equal(shouldStop(Date.now() + 60_000, 100, 100), true);
  assert.equal(shouldStop(Date.now() + 60_000, 99, 100), false);
});

test('shouldStop stops when deadline elapsed', () => {
  assert.equal(shouldStop(Date.now() - 1, 0, 100), true);
});

test('retryWithBackoff returns success on first success', async () => {
  let attempts = 0;
  const out = await retryWithBackoff(async () => {
    attempts += 1;
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(attempts, 1);
});

test('retryWithBackoff retries on retryable error then succeeds', async () => {
  let attempts = 0;
  const out = await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 2) {
        const err = new Error('ThrottlingException: slow down');
        (err as unknown as { code: string }).code = 'ThrottlingException';
        throw err;
      }
      return 'ok';
    },
    { baseMs: 5, capMs: 20 }
  );
  assert.equal(out, 'ok');
  assert.equal(attempts, 2);
});

test('retryWithBackoff gives up after maxAttempts', async () => {
  let attempts = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        attempts += 1;
        const err = new Error('503 service unavailable') as Error & { statusCode: number };
        err.statusCode = 503;
        throw err;
      },
      { baseMs: 1, capMs: 5, maxAttempts: 3 }
    )
  );
  assert.equal(attempts, 3);
});

test('retryWithBackoff does NOT retry on non-retryable error', async () => {
  let attempts = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        attempts += 1;
        const err = new Error('bad request') as Error & { statusCode: number };
        err.statusCode = 400;
        throw err;
      },
      { baseMs: 1, capMs: 5 }
    )
  );
  assert.equal(attempts, 1);
});

test('retryWithBackoff extracts Retry-After from fetch-style headers', async () => {
  let attempts = 0;
  const started = Date.now();
  await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 2) {
        const err = new Error('429') as Error & { statusCode: number; headers: Headers };
        err.statusCode = 429;
        err.headers = new Headers({ 'retry-after': '0.1' });
        throw err;
      }
      return 'ok';
    },
    { baseMs: 5_000, capMs: 10_000 } // baseMs large; Retry-After should dominate
  );
  assert.equal(attempts, 2);
  // Retry-After was 0.1s (100ms) — we should have waited close to that, not the base of 5s.
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `elapsed ${elapsed}ms — Retry-After not respected`);
});

test('sleep delays execution by approximately the requested duration', async () => {
  const started = Date.now();
  await sleep(50);
  assert.ok(Date.now() - started >= 45);
});
