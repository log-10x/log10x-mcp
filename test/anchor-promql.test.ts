/**
 * Hash-aware anchor PromQL helper — unit tests.
 *
 * These lock in the catalog-breaking defect fix for the cross-pillar
 * primitives (`metrics_that_moved`, `rank_by_shape_similarity`): when
 * a chain forwards `pattern_hash` (not `symbol_message`) as the anchor,
 * the tools must select on `LABELS.hash`, not `LABELS.pattern`. The
 * shape detector is the bridge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikePatternHash,
  buildPatternAnchorRateQuery,
  PATTERN_HASH_REGEX,
} from '../src/lib/anchor-promql.js';
import { tenxHash } from '../src/lib/pattern-hash.js';
import { LABELS } from '../src/lib/promql.js';

test('PATTERN_HASH_REGEX accepts any 11-char base64url string', () => {
  // Every output of tenxHash() is 11 base64url chars by construction.
  for (const sample of ['hello', 'world', 'a', 'aa', '', 'GET /api/v1/things']) {
    const h = tenxHash(sample);
    assert.equal(h.length, 11, `tenxHash("${sample}") length`);
    assert.match(h, PATTERN_HASH_REGEX, `tenxHash("${sample}") shape`);
    assert.equal(looksLikePatternHash(h), true);
  }
});

test('looksLikePatternHash rejects non-hash shapes', () => {
  // Pattern Symbol Message names — typical anchor inputs.
  assert.equal(looksLikePatternHash('GET /api/v1/users <ID>'), false);
  assert.equal(looksLikePatternHash('order_processed'), false);
  // Wrong length.
  assert.equal(looksLikePatternHash('abc'), false);
  assert.equal(looksLikePatternHash('abcdefghij'), false); // 10
  assert.equal(looksLikePatternHash('abcdefghijkl'), false); // 12
  // Right length, wrong alphabet (`=` is base64 std, not base64url body).
  assert.equal(looksLikePatternHash('abcdefghij='), false);
  assert.equal(looksLikePatternHash('abcdefghij/'), false);
  assert.equal(looksLikePatternHash('abcdefghij+'), false);
  assert.equal(looksLikePatternHash('abcdefghij '), false);
});

test('buildPatternAnchorRateQuery selects message_pattern for a NAME anchor', () => {
  const q = buildPatternAnchorRateQuery('order_processed', 'prod', 180);
  assert.match(q, /sum\(rate\(all_events_summaryBytes_total\{/);
  assert.ok(q.includes(`${LABELS.pattern}="order_processed"`), `expected message_pattern selector, got: ${q}`);
  assert.ok(!q.includes(`${LABELS.hash}="`), `unexpected hash selector in name-anchor query: ${q}`);
  assert.ok(q.includes(`${LABELS.env}="prod"`));
  assert.ok(q.endsWith('}[180s]))'));
});

test('buildPatternAnchorRateQuery selects tenx_hash for an 11-char hash anchor', () => {
  const h = tenxHash('order_processed');
  const q = buildPatternAnchorRateQuery(h, 'prod', 180);
  assert.match(q, /sum\(rate\(all_events_summaryBytes_total\{/);
  assert.ok(q.includes(`${LABELS.hash}="${h}"`), `expected hash selector, got: ${q}`);
  assert.ok(!q.includes(`${LABELS.pattern}="`), `unexpected pattern selector in hash-anchor query: ${q}`);
  assert.ok(q.includes(`${LABELS.env}="prod"`));
});

test('buildPatternAnchorRateQuery escapes embedded quotes in NAME anchors', () => {
  const q = buildPatternAnchorRateQuery('she said "hi"', 'prod', 180);
  assert.ok(q.includes('she said \\"hi\\"'), `expected escaped quotes, got: ${q}`);
});
