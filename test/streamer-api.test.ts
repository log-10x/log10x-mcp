/**
 * Unit tests for streamer-api public helpers.
 *
 * parseTimeExpression converts user-friendly time expressions into the
 * engine-compatible form — the engine expects JS-eval-prefixed `$=now(...)`
 * for relative expressions and raw epoch millis for absolute times.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseTimeExpression, normalizeTimeExpression, isStreamerConfigured, eventTimestampMs } from '../src/lib/streamer-api.js';

test('normalizeTimeExpression: bare `now` becomes $=now()', () => {
  assert.equal(normalizeTimeExpression('now'), '$=now()');
});

test('normalizeTimeExpression: relative expressions get $=now("offset") form', () => {
  assert.equal(normalizeTimeExpression('now-1h'), '$=now("-1h")');
  assert.equal(normalizeTimeExpression('now-90d'), '$=now("-90d")');
  assert.equal(normalizeTimeExpression('now+15m'), '$=now("+15m")');
});

test('normalizeTimeExpression: already-prefixed forms pass through', () => {
  assert.equal(normalizeTimeExpression('now(-1h)'), '$=now(-1h)');
  assert.equal(normalizeTimeExpression('$=now("-1h")'), '$=now("-1h")');
});

test('normalizeTimeExpression: epoch millis pass through as literal', () => {
  assert.equal(normalizeTimeExpression('1776400000000'), '1776400000000');
});

test('normalizeTimeExpression: ISO8601 converts to epoch millis string', () => {
  const out = normalizeTimeExpression('2026-01-15T00:00:00Z');
  assert.equal(out, String(Date.parse('2026-01-15T00:00:00Z')));
});

test('normalizeTimeExpression: unknown format passes through (server rejects loudly)', () => {
  assert.equal(normalizeTimeExpression('garbage'), 'garbage');
});

test('normalizeTimeExpression: empty string throws', () => {
  assert.throws(() => normalizeTimeExpression(''), /Empty time expression/);
});

test('parseTimeExpression is an alias for normalizeTimeExpression', () => {
  assert.equal(parseTimeExpression('now'), normalizeTimeExpression('now'));
  assert.equal(parseTimeExpression('now-1h'), normalizeTimeExpression('now-1h'));
});

test('isStreamerConfigured requires both LOG10X_STREAMER_URL and LOG10X_STREAMER_BUCKET', () => {
  const savedUrl = process.env.LOG10X_STREAMER_URL;
  const savedBucket = process.env.LOG10X_STREAMER_BUCKET;
  try {
    delete process.env.LOG10X_STREAMER_URL;
    delete process.env.LOG10X_STREAMER_BUCKET;
    assert.equal(isStreamerConfigured(), false);

    process.env.LOG10X_STREAMER_URL = 'http://example.com';
    assert.equal(isStreamerConfigured(), false); // still missing bucket

    process.env.LOG10X_STREAMER_BUCKET = 'my-bucket';
    assert.equal(isStreamerConfigured(), true);
  } finally {
    if (savedUrl === undefined) delete process.env.LOG10X_STREAMER_URL;
    else process.env.LOG10X_STREAMER_URL = savedUrl;
    if (savedBucket === undefined) delete process.env.LOG10X_STREAMER_BUCKET;
    else process.env.LOG10X_STREAMER_BUCKET = savedBucket;
  }
});

// ─── eventTimestampMs ──────────────────────────────────────────────────
//
// Magnitude-based unit detection. Modern epochs:
//   seconds  ~1.77e9  → s × 1000
//   millis   ~1.77e12 → as-is
//   micros   ~1.77e15 → / 1000
//   nanos    ~1.77e18 → / 1_000_000

test('eventTimestampMs: 13-digit millis stays as millis (regression test)', () => {
  // 1776851170107 is 2026-04-22T09:46:10.107Z — was previously misclassified
  // as micros due to the > 1e12 boundary, dividing by 1000 and aliasing
  // to 1970-01-21T13:00:00.
  assert.equal(eventTimestampMs({ timestamp: 1_776_851_170_107 } as any), 1_776_851_170_107);
});

test('eventTimestampMs: array-wrapped millis extracted', () => {
  assert.equal(eventTimestampMs({ timestamp: [1_776_851_170_107] } as any), 1_776_851_170_107);
});

test('eventTimestampMs: 16-digit micros divided by 1000', () => {
  // 1776851170107000 → 1776851170107 ms
  assert.equal(eventTimestampMs({ timestamp: 1_776_851_170_107_000 } as any), 1_776_851_170_107);
});

test('eventTimestampMs: 19-digit nanos divided by 1e6', () => {
  // 1776851170107000000 → 1776851170107 ms
  assert.equal(eventTimestampMs({ timestamp: 1_776_851_170_107_000_000 } as any), 1_776_851_170_107);
});

test('eventTimestampMs: 10-digit seconds multiplied by 1000', () => {
  // 1776851170 → 1776851170000 ms
  assert.equal(eventTimestampMs({ timestamp: 1_776_851_170 } as any), 1_776_851_170_000);
});

test('eventTimestampMs: ISO8601 string parses', () => {
  const ms = eventTimestampMs({ timestamp: '2026-04-22T09:46:10.107Z' } as any);
  assert.equal(ms, Date.parse('2026-04-22T09:46:10.107Z'));
});

test('eventTimestampMs: missing timestamp returns 0', () => {
  assert.equal(eventTimestampMs({} as any), 0);
});

test('eventTimestampMs: numeric string in millis stays as millis', () => {
  assert.equal(eventTimestampMs({ timestamp: '1776851170107' } as any), 1_776_851_170_107);
});
