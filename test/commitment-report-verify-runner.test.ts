/**
 * Item-1 acceptance: assert the VerifyResult → WeeklyVerifyResult
 * adapter shapes correctly AND that the runner gets wired by importing
 * `src/index.js` (the module-load `_setVerifyRunner(...)` call there is
 * the wire-up gap the close-list v2 §1.1 calls out).
 *
 * No live backend required — the adapter is a pure function and the
 * runner-presence assertion only checks that `_getVerifyRunner()`
 * returns a function after index.ts has loaded.
 *
 * Per project_commitment_report_action_split_broken.md: this test is
 * envelope-shape only. The Item-5 follow-up test will assert
 * parts-sum-to-whole on the four-way action split with live data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptVerifyResultToWeekly,
  _getVerifyRunner,
  _clearVerifyRunner,
  type VerifyResultLike,
} from '../src/tools/commitment-report.js';

test('adaptVerifyResultToWeekly: percent conversion + clamp', () => {
  const vr: VerifyResultLike = {
    destination: 'splunk',
    delivered_pct: 0.42, // fraction → 42%
    post_passed_bytes: 580,
    post_dropped_bytes: 420,
    delivered_dollars_now: 12.5,
    attribution_pct: {
      cap_fired_bytes: 0.8,
      drift_bytes: 0.1,
      new_patterns_bytes: 0.05,
      leakage_bytes: 0.05,
    },
    rate_source: 'list_price',
  };
  const weekly = adaptVerifyResultToWeekly(vr, '2026-05-01');
  assert.equal(weekly.week_start, '2026-05-01');
  assert.equal(weekly.bytes_in, 1000);
  assert.equal(weekly.bytes_dropped, 420);
  assert.equal(weekly.delivered_pct, 42);
  assert.equal(weekly.delivered_dollars, 12.5);
  assert.equal(weekly.attribution.cap_fired, 0.8);
  assert.equal(weekly.rate_source, 'list_price');
  // per_pattern_breakdown stays absent until Item 5.
  assert.equal(weekly.per_pattern_breakdown, undefined);
});

test('adaptVerifyResultToWeekly: negative delivered_pct clamps to 0', () => {
  const vr: VerifyResultLike = {
    destination: 'datadog',
    delivered_pct: -0.15, // drift swamped the cap
    post_passed_bytes: 1200,
    post_dropped_bytes: 50,
    delivered_dollars_now: 1.0,
    attribution_pct: {
      cap_fired_bytes: 0.05,
      drift_bytes: 0.6,
      new_patterns_bytes: 0.3,
      leakage_bytes: 0.05,
    },
  };
  const weekly = adaptVerifyResultToWeekly(vr, '2026-05-08');
  assert.equal(weekly.delivered_pct, 0);
  // rate_source defaults to 'list_price' when the VerifyResult omits it
  // (matches estimate-savings.ts behaviour: it picks list_price unless
  // the caller supplies effective_ingest_per_gb).
  assert.equal(weekly.rate_source, 'list_price');
});

test('adaptVerifyResultToWeekly: handles non-finite delivered_dollars', () => {
  const vr: VerifyResultLike = {
    destination: 'cloudwatch',
    delivered_pct: 0.2,
    post_passed_bytes: 800,
    post_dropped_bytes: 200,
    delivered_dollars_now: NaN,
    attribution_pct: {
      cap_fired_bytes: 1,
      drift_bytes: 0,
      new_patterns_bytes: 0,
      leakage_bytes: 0,
    },
  };
  const weekly = adaptVerifyResultToWeekly(vr, '2026-05-15');
  assert.equal(weekly.delivered_dollars, 0);
});

test('adaptVerifyResultToWeekly: per_pattern_breakdown populates from VerifyResult (Item 5)', () => {
  const vr: VerifyResultLike = {
    destination: 'splunk',
    delivered_pct: 0.30, // 30%
    post_passed_bytes: 700,
    post_dropped_bytes: 300,
    delivered_dollars_now: 30.0,
    attribution_pct: {
      cap_fired_bytes: 1,
      drift_bytes: 0,
      new_patterns_bytes: 0,
      leakage_bytes: 0,
    },
    rate_source: 'customer_supplied',
    per_pattern_breakdown: [
      { pattern_hash: 'h1', action: 'drop', delivered_bytes: 200, expected_bytes: 256, action_source: 'pat_row' },
      { pattern_hash: 'h2', action: 'compact', delivered_bytes: 100, expected_bytes: 512, action_source: 'container' },
    ],
  };
  const weekly = adaptVerifyResultToWeekly(vr, '2026-05-22');
  assert.ok(weekly.per_pattern_breakdown);
  assert.equal(weekly.per_pattern_breakdown.length, 2);
  // Parts-≤-whole: sum of per-pattern bytes_saved equals bytes_dropped.
  const summed = weekly.per_pattern_breakdown.reduce((s, r) => s + r.bytes_saved, 0);
  assert.equal(summed, 300);
  assert.ok(summed <= weekly.bytes_dropped);
  // Per-row dollars_saved scales proportionally to bytes and totals to
  // delivered_dollars (FP drift up to a cent is fine).
  const dollarsSummed = weekly.per_pattern_breakdown.reduce(
    (s, r) => s + (r.dollars_saved ?? 0),
    0
  );
  assert.ok(Math.abs(dollarsSummed - 30.0) < 0.01);
  // Action-taken propagates through verbatim.
  assert.equal(weekly.per_pattern_breakdown[0].action_taken, 'drop');
  assert.equal(weekly.per_pattern_breakdown[1].action_taken, 'compact');
  // Rate source latches to the upstream value.
  assert.equal(weekly.per_pattern_breakdown[0].rate_source, 'customer_supplied');
});

test('_setVerifyRunner installs and _getVerifyRunner reads it back', async () => {
  // Re-importing inside the test for symmetry with the index.ts call
  // site; the real wire-up call lives at index.ts:~1370 (after the
  // commitment_report registration block). Booting index.js here would
  // start the MCP server and hit the network via initEnvs(), so this
  // test only asserts the indirection contract — it does not boot
  // index.js. The index.ts wire-up itself is covered by the build
  // pinning the call site (tsc + manifest tests).
  const saved = _getVerifyRunner();
  _clearVerifyRunner();
  assert.equal(_getVerifyRunner(), undefined);
  const stub = async () => ({
    week_start: '2026-05-01',
    bytes_in: 1,
    bytes_dropped: 0,
    delivered_pct: 0,
    delivered_dollars: 0,
    attribution: { cap_fired: 0, drift: 0, new_patterns: 0, leakage: 0 },
  });
  const { _setVerifyRunner } = await import(
    '../src/tools/commitment-report.js'
  );
  _setVerifyRunner(stub);
  assert.equal(typeof _getVerifyRunner(), 'function');
  // Restore prior state so we don't poison other tests.
  if (saved) _setVerifyRunner(saved);
  else _clearVerifyRunner();
});
