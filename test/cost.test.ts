/**
 * Tests for the per-destination cost projection layer in lib/cost.ts.
 *
 * Covers back-compat (bytesToCost / bytesToGb / parsePrometheusValue),
 * the destination-model lookup with ES-pruned override, action projection
 * (pass / drop / sample / tier_down / offload / compact), the
 * low/expected/high band, the small-event degradation curve, and
 * annualization.
 *
 * Acceptance gates from the spec:
 *   - compact on splunk: ~88.5% savings on $6/GB → ~$0.69 for 1GB.
 *   - compact on datadog: bytes_out === bytes_in + 'not supported' note.
 *   - small-event degradation: avg 50B against CH 0.26 → ~0.63.
 *   - degradation clamped to ≤ 1.0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToCost,
  bytesToGb,
  parsePrometheusValue,
  COST_MODEL_BY_DESTINATION,
  getDestinationCostModel,
  projectAction,
  projectActionRange,
  degradeRatioForSmallEvents,
  annualizeDollars,
} from '../src/lib/cost.js';

const GB = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// back-compat surface
// ---------------------------------------------------------------------------

test('bytesToCost converts bytes to dollars at $/GB', () => {
  assert.equal(bytesToCost(GB, 6), 6);
  assert.equal(bytesToCost(GB / 2, 6), 3);
  assert.equal(bytesToCost(0, 6), 0);
});

test('bytesToGb converts bytes to GB', () => {
  assert.equal(bytesToGb(GB), 1);
  assert.equal(bytesToGb(0), 0);
});

test('parsePrometheusValue handles strings, NaN, and missing values', () => {
  assert.equal(parsePrometheusValue({ value: [0, '42.5'] }), 42.5);
  assert.equal(parsePrometheusValue({ value: [0, 'NaN'] }), 0);
  assert.equal(parsePrometheusValue({}), 0);
});

// ---------------------------------------------------------------------------
// destination model lookup
// ---------------------------------------------------------------------------

test('COST_MODEL_BY_DESTINATION has all eight SIEMs', () => {
  const keys = Object.keys(COST_MODEL_BY_DESTINATION).sort();
  assert.deepEqual(keys, [
    'azure-monitor',
    'clickhouse',
    'cloudwatch',
    'datadog',
    'elasticsearch',
    'gcp-logging',
    'splunk',
    'sumo',
  ]);
});

test('getDestinationCostModel returns the default ES model when pruned', () => {
  const m = getDestinationCostModel('elasticsearch', { esPruned: true });
  assert.equal(m.compact_mode, 'index-pruned');
  assert.equal(m.compact_ratio_low, 0.3);
  assert.equal(m.compact_ratio_high, 0.4);
});

test('getDestinationCostModel switches to unpruned ES band when esPruned=false', () => {
  const m = getDestinationCostModel('elasticsearch', { esPruned: false });
  assert.equal(m.compact_mode, 'index-unpruned');
  assert.equal(m.compact_ratio_low, 0.45);
  assert.equal(m.compact_ratio_high, 0.55);
});

test('getDestinationCostModel ignores esPruned for non-ES destinations', () => {
  const m = getDestinationCostModel('splunk', { esPruned: false });
  assert.equal(m.compact_mode, 'envelope');
  assert.equal(m.compact_ratio_low, 0.08);
});

// ---------------------------------------------------------------------------
// projectAction
// ---------------------------------------------------------------------------

test('projectAction pass returns bytes_in unchanged with full cost', () => {
  const p = projectAction({
    action: 'pass',
    bytes_in: GB,
    destination: 'splunk',
  });
  assert.equal(p.bytes_out, GB);
  // ingest only at $6/GB; splunk storage band is 0.10 -> +$0.10 with default 1-month retention.
  assert.ok(Math.abs(p.ingest_dollars - 6) < 1e-9);
  assert.ok(Math.abs(p.storage_dollars - 0.1) < 1e-9);
  assert.ok(Math.abs(p.total_dollars - 6.1) < 1e-9);
  assert.equal(p.basis, 'uncompressed-ingest');
});

test('projectAction drop yields zero bytes and zero dollars', () => {
  const p = projectAction({
    action: 'drop',
    bytes_in: GB,
    destination: 'datadog',
  });
  assert.equal(p.bytes_out, 0);
  assert.equal(p.total_dollars, 0);
});

test('projectAction sample divides by sample_n', () => {
  const p = projectAction({
    action: 'sample',
    bytes_in: GB,
    sample_n: 10,
    destination: 'splunk',
  });
  assert.ok(Math.abs(p.bytes_out - GB / 10) < 1e-6);
});

test('projectAction sample defaults to 1:10 when sample_n omitted', () => {
  const p = projectAction({
    action: 'sample',
    bytes_in: GB,
    destination: 'splunk',
  });
  assert.ok(Math.abs(p.bytes_out - GB / 10) < 1e-6);
});

test('projectAction compact on splunk produces ~88% savings ($0.70 on 1GB)', () => {
  // mid-band = (0.08+0.15)/2 = 0.115; 1GB * 6 * 0.115 = 0.69; + 0.115 * 0.10 storage = ~0.7015
  const p = projectAction({
    action: 'compact',
    bytes_in: GB,
    destination: 'splunk',
  });
  assert.ok(p.bytes_out > 0 && p.bytes_out < GB);
  assert.ok(Math.abs(p.ingest_dollars - 0.69) < 0.01, `ingest_dollars=${p.ingest_dollars}`);
  assert.ok(Math.abs(p.total_dollars - 0.7015) < 0.02, `total_dollars=${p.total_dollars}`);
});

test('projectAction compact on datadog is a no-op with caveat note', () => {
  const p = projectAction({
    action: 'compact',
    bytes_in: GB,
    destination: 'datadog',
  });
  assert.equal(p.bytes_out, GB);
  assert.ok(p.notes && p.notes.some((n) => /not supported on datadog/.test(n)));
});

test('projectAction tier_down keeps bytes and emits routing caveat', () => {
  const p = projectAction({
    action: 'tier_down',
    bytes_in: GB,
    destination: 'splunk',
  });
  assert.equal(p.bytes_out, GB);
  assert.ok(p.notes && p.notes.some((n) => /tier_down/.test(n)));
});

test('projectAction offload sends zero bytes downstream with S3 caveat', () => {
  const p = projectAction({
    action: 'offload',
    bytes_in: GB,
    destination: 'splunk',
  });
  assert.equal(p.bytes_out, 0);
  assert.equal(p.total_dollars, 0);
  assert.ok(p.notes && p.notes.some((n) => /S3/.test(n)));
});

test('projectAction compact on clickhouse uses dict-udf-view band and stored-month basis', () => {
  // mid = (0.22+0.30)/2 = 0.26. ingest_per_gb=0 (CH self-hosted), storage 0.023/GB-month.
  const p = projectAction({
    action: 'compact',
    bytes_in: GB,
    destination: 'clickhouse',
    retention_months: 1,
  });
  assert.equal(p.basis, 'stored-month');
  assert.equal(p.ingest_dollars, 0);
  assert.ok(Math.abs(p.storage_dollars - 0.26 * 0.023) < 1e-6);
});

// ---------------------------------------------------------------------------
// small-event degradation
// ---------------------------------------------------------------------------

test('degradeRatioForSmallEvents passes through above the floor', () => {
  assert.equal(degradeRatioForSmallEvents(0.26, 200, 100), 0.26);
  assert.equal(degradeRatioForSmallEvents(0.26, 100, 100), 0.26);
});

test('degradeRatioForSmallEvents degrades 50B against CH 0.26 toward ~0.63', () => {
  // penalty = (100-50)/100 = 0.5 → 0.26 + (1-0.26)*0.5 = 0.26 + 0.37 = 0.63
  const r = degradeRatioForSmallEvents(0.26, 50, 100);
  assert.ok(Math.abs(r - 0.63) < 1e-9, `got ${r}`);
});

test('degradeRatioForSmallEvents clamps at 1.0 as avg size approaches 0', () => {
  const r = degradeRatioForSmallEvents(0.26, 1, 100);
  assert.ok(r <= 1);
  assert.ok(r > 0.9);
});

test('degradeRatioForSmallEvents returns base when avgSize is 0 or undefined', () => {
  assert.equal(degradeRatioForSmallEvents(0.26, undefined, 100), 0.26);
  // explicit 0 is treated as "missing" rather than "infinitely small"
  assert.equal(degradeRatioForSmallEvents(0.26, 0, 100), 0.26);
});

test('projectAction compact with small avg event size shrinks savings', () => {
  const big = projectAction({
    action: 'compact',
    bytes_in: GB,
    avg_event_size_bytes: 500,
    destination: 'clickhouse',
  });
  const small = projectAction({
    action: 'compact',
    bytes_in: GB,
    avg_event_size_bytes: 50,
    destination: 'clickhouse',
  });
  assert.ok(small.bytes_out > big.bytes_out);
  assert.ok(small.notes && small.notes.some((n) => /below floor/.test(n)));
});

// ---------------------------------------------------------------------------
// projectActionRange
// ---------------------------------------------------------------------------

test('projectActionRange compact on splunk orders low/expected/high by dollars saved', () => {
  const r = projectActionRange({
    action: 'compact',
    bytes_in: GB,
    destination: 'splunk',
  });
  // high savings = fewest bytes out; low savings = most bytes out
  assert.ok(r.high.bytes_out < r.expected.bytes_out);
  assert.ok(r.expected.bytes_out < r.low.bytes_out);
  assert.equal(r.low.confidence, 'low');
  assert.equal(r.expected.confidence, 'expected');
  assert.equal(r.high.confidence, 'high');
});

test('projectActionRange compact on datadog returns identical no-op triplet', () => {
  const r = projectActionRange({
    action: 'compact',
    bytes_in: GB,
    destination: 'datadog',
  });
  assert.equal(r.low.bytes_out, GB);
  assert.equal(r.expected.bytes_out, GB);
  assert.equal(r.high.bytes_out, GB);
});

// ---------------------------------------------------------------------------
// retention multiplier + annualization
// ---------------------------------------------------------------------------

test('projectAction retention_months scales storage_dollars linearly', () => {
  const one = projectAction({
    action: 'pass',
    bytes_in: GB,
    destination: 'elasticsearch',
    retention_months: 1,
  });
  const six = projectAction({
    action: 'pass',
    bytes_in: GB,
    destination: 'elasticsearch',
    retention_months: 6,
  });
  assert.ok(Math.abs(six.storage_dollars - 6 * one.storage_dollars) < 1e-9);
  // ingest is one-time, unaffected
  assert.ok(Math.abs(six.ingest_dollars - one.ingest_dollars) < 1e-9);
});

test('annualizeDollars scales window spend to a year', () => {
  assert.ok(Math.abs(annualizeDollars(7, 7) - 365) < 1e-9);
  assert.ok(Math.abs(annualizeDollars(30, 30) - 365) < 1e-9);
  assert.equal(annualizeDollars(100, 0), 0);
  assert.equal(annualizeDollars(100, -1), 0);
});
