import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeExpression, buildQueryBody, isStreamerConfigured } from '../src/lib/streamer-api.js';

test('parseTimeExpression handles `now`', () => {
  const reference = new Date('2026-04-13T12:00:00Z');
  const d = parseTimeExpression('now', reference);
  assert.equal(d.getTime(), reference.getTime());
});

test('parseTimeExpression handles relative expressions', () => {
  const reference = new Date('2026-04-13T12:00:00Z');
  assert.equal(parseTimeExpression('now-1h', reference).getTime(), reference.getTime() - 3_600_000);
  assert.equal(parseTimeExpression('now-90d', reference).getTime(), reference.getTime() - 90 * 86_400_000);
  assert.equal(parseTimeExpression('now+15m', reference).getTime(), reference.getTime() + 15 * 60_000);
});

test('parseTimeExpression handles ISO timestamps', () => {
  const d = parseTimeExpression('2026-01-15T00:00:00Z');
  assert.equal(d.toISOString(), '2026-01-15T00:00:00.000Z');
});

test('parseTimeExpression rejects malformed input', () => {
  assert.throws(() => parseTimeExpression(''));
  assert.throws(() => parseTimeExpression('garbage'));
});

test('buildQueryBody copies required + optional fields', () => {
  const body = buildQueryBody({
    pattern: '~abc',
    from: 'now-1h',
    to: 'now',
    search: 'severity == "ERROR"',
    filters: ['event.customer_id === "acme"'],
    limit: 500,
    format: 'aggregated',
    bucketSize: '1h',
  });
  assert.equal(body.pattern, '~abc');
  assert.equal(body.from, 'now-1h');
  assert.equal(body.to, 'now');
  assert.equal(body.search, 'severity == "ERROR"');
  assert.deepEqual(body.filters, ['event.customer_id === "acme"']);
  assert.equal(body.limit, 500);
  assert.equal(body.format, 'aggregated');
  assert.equal(body.bucketSize, '1h');
});

test('buildQueryBody defaults limit and format', () => {
  const body = buildQueryBody({ pattern: '~abc', from: 'now-1h', to: 'now' });
  assert.equal(body.limit, 10000);
  assert.equal(body.format, 'events');
  // bucketSize only applied when format=aggregated
  assert.equal(body.bucketSize, undefined);
});

test('isStreamerConfigured reflects LOG10X_STREAMER_URL', () => {
  const original = process.env.LOG10X_STREAMER_URL;
  try {
    delete process.env.LOG10X_STREAMER_URL;
    assert.equal(isStreamerConfigured(), false);
    process.env.LOG10X_STREAMER_URL = 'https://example.test';
    assert.equal(isStreamerConfigured(), true);
  } finally {
    if (original === undefined) delete process.env.LOG10X_STREAMER_URL;
    else process.env.LOG10X_STREAMER_URL = original;
  }
});
