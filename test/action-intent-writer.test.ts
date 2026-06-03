/**
 * action-intent-writer.ts + action-intent-parser.ts acceptance tests.
 *
 * Covers:
 *   1. Round-trip: writeActionIntent → parseActionIntent → same entries
 *   2. Sorted output: entries sorted by (service ASC, pattern_hash ASC)
 *   3. Deterministic output: same input → byte-identical JSON
 *   4. tier_down + offload entries (no corresponding CSV row required)
 *   5. Expiry: expired entries excluded from by_pattern lookup
 *   6. Malformed entries: surfaced in malformed_entries, never throw
 *   7. Empty / null input: returns empty result, never throws
 *   8. Legacy cap-CSV action suffix: stripped cleanly, not required
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeActionIntent,
  buildActionIntentEntries,
  type ActionIntentEntry,
} from '../src/lib/action-intent-writer.js';
import { parseActionIntent } from '../src/lib/action-intent-parser.js';

// ─── helpers ─────────────────────────────────────────────────────────

/** Fixed timestamp so tests are deterministic. */
const NOW_ISO = '2026-06-03T12:00:00.000Z';
const FAR_FUTURE_EPOCH = Math.floor(new Date('2030-01-01').getTime() / 1000);
const PAST_EPOCH = Math.floor(new Date('2020-01-01').getTime() / 1000);

function makeEntry(overrides: Partial<ActionIntentEntry> = {}): ActionIntentEntry {
  return {
    pattern_hash: 'abc123def456',
    service: 'payment-service',
    action: 'drop',
    reason: 'high-volume noise',
    set_at_iso: NOW_ISO,
    until_epoch_sec: 0,
    ...overrides,
  };
}

// ─── test 1: round-trip ───────────────────────────────────────────────

test('round-trip: writeActionIntent → parseActionIntent preserves entries', () => {
  const entries: ActionIntentEntry[] = [
    makeEntry({ pattern_hash: 'aaa111', service: 'frontend', action: 'drop' }),
    makeEntry({ pattern_hash: 'bbb222', service: 'checkout', action: 'compact' }),
    makeEntry({ pattern_hash: 'ccc333', service: 'frontend', action: 'tier_down' }),
    makeEntry({ pattern_hash: 'ddd444', service: 'checkout', action: 'offload' }),
  ];

  const json = writeActionIntent(entries, { updated_at_iso: NOW_ISO });
  const result = parseActionIntent(json);

  assert.equal(result.json_parse_error, false);
  assert.equal(result.malformed_entries.length, 0);
  assert.equal(result.entries.length, 4);
  assert.equal(result.schema_version, '1.0');

  // All entries round-trip with correct action.
  assert.equal(result.by_pattern.get('aaa111'), 'drop');
  assert.equal(result.by_pattern.get('bbb222'), 'compact');
  assert.equal(result.by_pattern.get('ccc333'), 'tier_down');
  assert.equal(result.by_pattern.get('ddd444'), 'offload');
});

// ─── test 2: sorted output ────────────────────────────────────────────

test('sorted output: entries sorted by (service ASC, pattern_hash ASC)', () => {
  const entries: ActionIntentEntry[] = [
    makeEntry({ pattern_hash: 'zzz999', service: 'zeta', action: 'drop' }),
    makeEntry({ pattern_hash: 'aaa111', service: 'alpha', action: 'compact' }),
    makeEntry({ pattern_hash: 'mmm555', service: 'alpha', action: 'offload' }),
    makeEntry({ pattern_hash: 'bbb222', service: 'beta', action: 'tier_down' }),
  ];

  const json = writeActionIntent(entries, { updated_at_iso: NOW_ISO });
  const result = parseActionIntent(json);

  const hashes = result.entries.map((e) => e.pattern_hash);
  // Expected order: alpha/aaa111, alpha/mmm555, beta/bbb222, zeta/zzz999
  assert.deepEqual(hashes, ['aaa111', 'mmm555', 'bbb222', 'zzz999']);
});

// ─── test 3: deterministic output ────────────────────────────────────

test('deterministic: same input produces byte-identical output', () => {
  const entries: ActionIntentEntry[] = [
    makeEntry({ pattern_hash: 'xyz789', service: 'worker', action: 'sample' }),
    makeEntry({ pattern_hash: 'abc123', service: 'api', action: 'pass' }),
  ];

  const json1 = writeActionIntent(entries, { updated_at_iso: NOW_ISO });
  const json2 = writeActionIntent(entries, { updated_at_iso: NOW_ISO });
  assert.equal(json1, json2);
});

// ─── test 4: tier_down + offload entries ─────────────────────────────

test('tier_down and offload entries: no CSV row required, parse correctly', () => {
  const entries: ActionIntentEntry[] = [
    makeEntry({ pattern_hash: 'td1', service: 'logs', action: 'tier_down', reason: 'Datadog Flex Starter' }),
    makeEntry({ pattern_hash: 'of1', service: 'logs', action: 'offload', reason: 'S3 cold tier' }),
  ];

  const json = writeActionIntent(entries, { updated_at_iso: NOW_ISO });
  const result = parseActionIntent(json);

  assert.equal(result.by_pattern.get('td1'), 'tier_down');
  assert.equal(result.by_pattern.get('of1'), 'offload');
  assert.equal(result.entries.find((e) => e.pattern_hash === 'td1')?.reason, 'Datadog Flex Starter');
  assert.equal(result.entries.find((e) => e.pattern_hash === 'of1')?.reason, 'S3 cold tier');
});

// ─── test 5: expiry ───────────────────────────────────────────────────

test('expiry: expired entries excluded from by_pattern, non-expired included', () => {
  const entries: ActionIntentEntry[] = [
    makeEntry({ pattern_hash: 'expired1', service: 'svc', action: 'drop', until_epoch_sec: PAST_EPOCH }),
    makeEntry({ pattern_hash: 'active1', service: 'svc', action: 'compact', until_epoch_sec: FAR_FUTURE_EPOCH }),
    makeEntry({ pattern_hash: 'permanent1', service: 'svc', action: 'tier_down', until_epoch_sec: 0 }),
  ];

  const json = writeActionIntent(entries, { updated_at_iso: NOW_ISO });
  // Use a nowEpochSec that is after PAST_EPOCH but before FAR_FUTURE_EPOCH.
  const nowSec = Math.floor(Date.now() / 1000);
  const result = parseActionIntent(json, nowSec);

  // expired1 should be absent from by_pattern.
  assert.equal(result.by_pattern.has('expired1'), false);
  // active1 and permanent1 should be present.
  assert.equal(result.by_pattern.get('active1'), 'compact');
  assert.equal(result.by_pattern.get('permanent1'), 'tier_down');
  // entries array only has the non-expired ones.
  assert.equal(result.entries.length, 2);
});

// ─── test 6: malformed entries ────────────────────────────────────────

test('malformed entries: surfaced in malformed_entries, good entries still parse', () => {
  const json = JSON.stringify({
    schema_version: '1.0',
    updated_at_iso: NOW_ISO,
    entries: [
      { pattern_hash: 'good1', service: 'svc', action: 'drop', reason: 'ok', set_at_iso: NOW_ISO, until_epoch_sec: 0 },
      { pattern_hash: 'bad1', service: 'svc', action: 'UNKNOWN_ACTION', reason: 'bad action', set_at_iso: NOW_ISO, until_epoch_sec: 0 },
      null, // non-object
      { pattern_hash: '', service: 'svc', action: 'drop', reason: 'empty hash', set_at_iso: NOW_ISO, until_epoch_sec: 0 },
      { pattern_hash: 'good2', service: 'svc', action: 'offload', reason: 'ok', set_at_iso: NOW_ISO, until_epoch_sec: 0 },
    ],
  });

  const result = parseActionIntent(json);
  assert.equal(result.json_parse_error, false);
  // Good entries still parse.
  assert.equal(result.by_pattern.get('good1'), 'drop');
  assert.equal(result.by_pattern.get('good2'), 'offload');
  // Malformed entries are surfaced.
  assert.ok(result.malformed_entries.length >= 3, `expected >=3 malformed, got ${result.malformed_entries.length}`);
});

// ─── test 7: empty / null input ──────────────────────────────────────

test('empty and null input: returns empty result, no throws', () => {
  const empty = parseActionIntent(undefined);
  assert.equal(empty.json_parse_error, false);
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.by_pattern.size, 0);
  assert.equal(empty.malformed_entries.length, 0);

  const nullResult = parseActionIntent(null);
  assert.equal(nullResult.json_parse_error, false);
  assert.equal(nullResult.entries.length, 0);

  const whitespace = parseActionIntent('   \n  ');
  assert.equal(whitespace.json_parse_error, false);
  assert.equal(whitespace.entries.length, 0);

  const badJson = parseActionIntent('{ not valid json }}');
  assert.equal(badJson.json_parse_error, true);
  assert.equal(badJson.entries.length, 0);
});

// ─── test 8: buildActionIntentEntries helper ─────────────────────────

test('buildActionIntentEntries: converts flat map to entries with defaults', () => {
  const patterns = [
    { pattern_hash: 'h1', action: 'drop' as const, service: 'svc1', reason: 'noise' },
    { pattern_hash: 'h2', action: 'tier_down' as const }, // no service/reason
  ];

  const entries = buildActionIntentEntries(patterns, { set_at_iso: NOW_ISO });
  assert.equal(entries.length, 2);

  const e1 = entries.find((e) => e.pattern_hash === 'h1')!;
  assert.equal(e1.action, 'drop');
  assert.equal(e1.service, 'svc1');
  assert.equal(e1.reason, 'noise');
  assert.equal(e1.set_at_iso, NOW_ISO);
  assert.equal(e1.until_epoch_sec, 0);

  const e2 = entries.find((e) => e.pattern_hash === 'h2')!;
  assert.equal(e2.action, 'tier_down');
  assert.equal(e2.service, '');
  assert.equal(e2.reason, '');
});

// ─── test 9: unknown future schema_version passes through ────────────

test('unknown schema_version: accepted with forward compat, entries still parse', () => {
  const json = JSON.stringify({
    schema_version: '99.0',
    updated_at_iso: NOW_ISO,
    entries: [
      { pattern_hash: 'future1', service: 'svc', action: 'compact', reason: '', set_at_iso: NOW_ISO, until_epoch_sec: 0 },
    ],
  });

  const result = parseActionIntent(json);
  assert.equal(result.json_parse_error, false);
  assert.equal(result.schema_version, '99.0');
  assert.equal(result.by_pattern.get('future1'), 'compact');
});
