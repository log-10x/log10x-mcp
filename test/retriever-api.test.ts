/**
 * Unit tests for retriever-api public helpers.
 *
 * parseTimeExpression converts user-friendly time expressions into the
 * engine-compatible form — the engine expects JS-eval-prefixed `$=now(...)`
 * for relative expressions and raw epoch millis for absolute times.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseTimeExpression, normalizeTimeExpression, isRetrieverConfiguredSync, eventTimestampMs, buildPatternSearch, UNRESOLVABLE_PATTERN_PREFIX } from '../src/lib/retriever-api.js';

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

test('isRetrieverConfiguredSync requires both __SAVE_LOG10X_RETRIEVER_URL__ and __SAVE_LOG10X_RETRIEVER_BUCKET__', () => {
  // isRetrieverConfigured() became async on 2026-06-04 (Fix 83a/83b helm-probe
  // cascade) and now resolves to true via the kubectl/helm probe even with no
  // env vars set. isRetrieverConfiguredSync() is the env-only fast-path helper
  // kept for exactly this back-compat contract, so the deterministic
  // both-env-vars-required assertion targets it.
  const savedUrl = process.env.__SAVE_LOG10X_RETRIEVER_URL__;
  const savedBucket = process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__;
  try {
    delete process.env.__SAVE_LOG10X_RETRIEVER_URL__;
    delete process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__;
    assert.equal(isRetrieverConfiguredSync(), false);

    process.env.__SAVE_LOG10X_RETRIEVER_URL__ = 'http://example.com';
    assert.equal(isRetrieverConfiguredSync(), false); // still missing bucket

    process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ = 'my-bucket';
    assert.equal(isRetrieverConfiguredSync(), true);
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
// These four tests previously asserted that buildPatternSearch produces
// `tenx_user_pattern == "<name>"`, and one of them verified that it round-trips
// against retriever-fidelity's extractor regex.
//
// THAT FIELD DOES NOT EXIST. Zero occurrences across the engine, the modules tree
// and pipeline-extensions; the live metrics backend reports 22 labels and it is
// not among them (the real pattern identity is `message_pattern`, whose hash is
// `tenx_hash`); and the archive read path registers five enrichment names, none of
// which is a pattern identity.
//
// So the old suite locked in a fabrication, and the round-trip test made it worse
// by proving two fabrications were mutually consistent — the extractor regex in
// retriever-fidelity.ts searches for the same non-existent field, alongside two
// metrics (`log10x_event_count_total`, `log10x_event_bytes_total`) that appear in
// that one file and nowhere else. Every name-scoped archive query therefore
// returned BLOOM_REJECTED_ALL: a confident, authoritative empty answer.
//
// A pattern NAME is unsatisfiable against the archive by construction, not merely
// mis-named. A Symbol Message is DERIVED from the event, so it is never a token in
// the archived bytes, and the Bloom index holds only text tokens plus template
// hashes. Measured: `message_pattern == "info_cart_..."` also returns
// BLOOM_REJECTED_ALL, 0 of 40 blobs. The identity that works is the metrics-side
// pattern_hash matched as a text token, via buildArchiveHashSearch.
//
// buildPatternSearch now throws with that remedy. Erroring beats a silent empty.

test('buildPatternSearch: refuses a pattern name instead of inventing a field', () => {
  assert.throws(
    () => buildPatternSearch('Payment_Gateway_Timeout'),
    (err: Error) => {
      assert.ok(err.message.startsWith(UNRESOLVABLE_PATTERN_PREFIX));
      return true;
    }
  );
});

test('buildPatternSearch: never emits the non-existent tenx_user_pattern field', () => {
  for (const name of ['Payment_Gateway_Timeout', '  Auth_Failed  ', 'Bad"Pattern']) {
    let emitted: string | undefined;
    try {
      emitted = buildPatternSearch(name);
    } catch {
      continue; // refusing is the correct behaviour
    }
    assert.fail(`buildPatternSearch returned a predicate instead of refusing: ${emitted}`);
  }
});

test('buildPatternSearch: the remedy names pattern_hash and where to get it', () => {
  try {
    buildPatternSearch('Payment_Gateway_Timeout');
    assert.fail('expected a throw');
  } catch (err) {
    const msg = (err as Error).message;
    assert.ok(msg.includes('pattern_hash'), 'must name the identity that works');
    assert.ok(
      msg.includes('top_patterns') || msg.includes('event_lookup'),
      'must say where a caller obtains it'
    );
  }
});

test('buildPatternSearch: quotes in the rejected name do not escape the message', () => {
  try {
    buildPatternSearch('Bad"Pattern');
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(!(err as Error).message.includes('Bad"Pattern'), 'quote should be stripped');
    assert.ok((err as Error).message.includes('BadPattern'));
  }
});
