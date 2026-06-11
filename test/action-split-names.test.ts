/**
 * Action-split arithmetic + pattern-name join (the tracker's standing
 * smoke requirement: parts must sum to the whole AND every emitted
 * per-pattern row must carry a human name, never bare hashes).
 *
 * Covers:
 *   1. computeActionSplit: buckets partition post_dropped_bytes exactly
 *      (parts + unattributed == whole), offload clamp engages on
 *      overshoot, and rows carry `pattern` (joined name, hash fallback).
 *   2. adaptVerifyResultToWeekly: passes `pattern` through to the
 *      WeeklyVerifyResult rows the commitment-report aggregator merges.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeActionSplit } from '../src/tools/estimate-savings.js';
import {
  adaptVerifyResultToWeekly,
  type VerifyResultLike,
} from '../src/tools/commitment-report.js';
import type { Action } from '../src/lib/cost.js';

test('computeActionSplit: parts sum to whole, names joined, hash fallback', () => {
  const postDroppedByHash = { aaa: 600, bbb: 300, ccc: 100 };
  const intent = new Map<string, Action>([
    ['aaa', 'offload'],
    ['bbb', 'drop'],
    // ccc intentionally unattributed
  ]);
  const names = new Map([
    ['aaa', 'ERROR_export_failed_opensearch'],
    ['bbb', 'INFO_health_check_ok'],
    // ccc has no name -> falls back to the hash
  ]);
  const { buckets, rows, clamped } = computeActionSplit({
    postDroppedByHash,
    hashToPattern: names,
    actionIntentLookup: intent,
    patternToContainer: new Map(),
    postDroppedBytes: 1000,
  });
  assert.equal(clamped, false);
  assert.equal(buckets.offload, 600);
  assert.equal(buckets.drop, 300);
  assert.equal(buckets.unattributed, 100);
  const attributed =
    buckets.drop + buckets.compact + buckets.offload + buckets.tier_down +
    buckets.sample + buckets.pass + buckets.unattributed;
  assert.equal(attributed, 1000); // parts == whole
  const byHash = new Map(rows.map((r) => [r.pattern_hash, r]));
  assert.equal(byHash.get('aaa')?.pattern, 'ERROR_export_failed_opensearch');
  assert.equal(byHash.get('bbb')?.pattern, 'INFO_health_check_ok');
  assert.equal(byHash.get('ccc')?.pattern, 'ccc'); // hash fallback
});

test('computeActionSplit: offload clamp trims overshoot to keep parts <= whole', () => {
  // Sum of per-hash bytes (1100) exceeds the reported whole (1000):
  // the offload bucket absorbs the trim.
  const { buckets, clamped } = computeActionSplit({
    postDroppedByHash: { aaa: 700, bbb: 400 },
    hashToPattern: new Map(),
    actionIntentLookup: new Map<string, Action>([
      ['aaa', 'offload'],
      ['bbb', 'drop'],
    ]),
    patternToContainer: new Map(),
    postDroppedBytes: 1000,
  });
  assert.equal(clamped, true);
  assert.equal(buckets.drop, 400);
  assert.equal(buckets.offload, 600); // 700 - 100 overshoot
  assert.equal(buckets.drop + buckets.offload, 1000);
});

test('adaptVerifyResultToWeekly: pattern names ride into the weekly rows', () => {
  const vr: VerifyResultLike = {
    destination: 'splunk',
    delivered_pct: 0.5,
    post_passed_bytes: 500,
    post_dropped_bytes: 500,
    delivered_dollars_now: 10,
    attribution_pct: {
      cap_fired_bytes: 1,
      drift_bytes: 0,
      new_patterns_bytes: 0,
      leakage_bytes: 0,
    },
    rate_source: 'list_price',
    per_pattern_breakdown: [
      {
        pattern_hash: 'aaa',
        pattern: 'ERROR_export_failed_opensearch',
        action: 'offload',
        delivered_bytes: 500,
        expected_bytes: null,
        action_source: 'pat_row',
      },
    ],
  };
  const weekly = adaptVerifyResultToWeekly(vr, '2026-06-08');
  assert.equal(weekly.per_pattern_breakdown?.length, 1);
  assert.equal(weekly.per_pattern_breakdown?.[0].pattern, 'ERROR_export_failed_opensearch');
  assert.equal(weekly.per_pattern_breakdown?.[0].action_taken, 'offload');
  // Bucket-feeding fields intact.
  assert.equal(weekly.per_pattern_breakdown?.[0].bytes_saved, 500);
});
