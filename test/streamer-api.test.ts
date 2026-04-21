/**
 * Unit tests for streamer-api public helpers.
 *
 * parseTimeExpression converts user-friendly time expressions into the
 * engine-compatible form — the engine expects JS-eval-prefixed `$=now(...)`
 * for relative expressions and raw epoch millis for absolute times.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseTimeExpression, normalizeTimeExpression, isStreamerConfigured } from '../src/lib/streamer-api.js';

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
