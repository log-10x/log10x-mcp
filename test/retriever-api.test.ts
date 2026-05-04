/**
 * Unit tests for retriever-api public helpers.
 *
 * parseTimeExpression converts user-friendly time expressions into the
 * engine-compatible form — the engine expects JS-eval-prefixed `$=now(...)`
 * for relative expressions and raw epoch millis for absolute times.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseTimeExpression, normalizeTimeExpression, isRetrieverConfigured, eventTimestampMs, buildPatternSearch } from '../src/lib/retriever-api.js';

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

test('isRetrieverConfigured requires both __SAVE_LOG10X_RETRIEVER_URL__ and __SAVE_LOG10X_RETRIEVER_BUCKET__', () => {
  const savedUrl = process.env.__SAVE_LOG10X_RETRIEVER_URL__;
  const savedBucket = process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__;
  try {
    delete process.env.__SAVE_LOG10X_RETRIEVER_URL__;
    delete process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__;
    assert.equal(isRetrieverConfigured(), false);

    process.env.__SAVE_LOG10X_RETRIEVER_URL__ = 'http://example.com';
    assert.equal(isRetrieverConfigured(), false); // still missing bucket

    process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ = 'my-bucket';
    assert.equal(isRetrieverConfigured(), true);
  } finally {
    if (savedUrl === undefined) delete process.env.__SAVE_LOG10X_RETRIEVER_URL__;
    else process.env.__SAVE_LOG10X_RETRIEVER_URL__ = savedUrl;
    if (savedBucket === undefined) delete process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__;
    else process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ = savedBucket;
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

// ─── buildPatternSearch ─────────────────────────────────────────────────
//
// Translates a Reporter-named pattern (Symbol Message) into a Bloom-filter
// `search` expression. Required because the deprecated `pattern` field on
// RetrieverQueryRequest is silently dropped by the body builder; tools
// passing only `pattern` get an unfiltered scan and wrong-data results.
// Keep the produced format aligned with retriever-fidelity.ts:351's regex
// extractor so the pair is invertible.

test('buildPatternSearch: produces canonical tenx_user_pattern equality', () => {
  assert.equal(buildPatternSearch('Payment_Gateway_Timeout'), 'tenx_user_pattern == "Payment_Gateway_Timeout"');
});

test('buildPatternSearch: round-trips with retriever-fidelity extractor regex', () => {
  // Mirrors retriever-fidelity.ts:351 — keep these in sync.
  const built = buildPatternSearch('Auth_Failed');
  const m = built.match(/tenx_user_pattern\s*==\s*"([^"]+)"/);
  assert.ok(m, 'expected match');
  assert.equal(m![1], 'Auth_Failed');
});

test('buildPatternSearch: trims whitespace', () => {
  assert.equal(buildPatternSearch('  Payment_Gateway_Timeout  '), 'tenx_user_pattern == "Payment_Gateway_Timeout"');
});

test('buildPatternSearch: strips embedded quotes defensively', () => {
  // Symbol Messages from the templater never contain quotes, but defensive
  // stripping prevents an injection-style break of the search expression.
  assert.equal(buildPatternSearch('Bad"Pattern'), 'tenx_user_pattern == "BadPattern"');
});
