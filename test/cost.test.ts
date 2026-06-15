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
  percentReduction,
  projectSavings,
} from '../src/lib/cost.js';

// GB = 10^9 bytes (decimal), matching src/lib/cost.ts. This is the unit
// CloudWatch / Datadog / Splunk / Azure / GCP / Sumo all bill in, so the
// $/GB dollar math lines up with the customer invoice. (Was 2^30; the
// source moved to 1e9 in commit 824d13a, math-lens workflow wui9vouej.)
const GB = 1_000_000_000;

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
  assert.ok(Math.abs(p.ingest_dollars! - 6) < 1e-9);
  assert.ok(Math.abs(p.storage_dollars! - 0.1) < 1e-9);
  assert.ok(Math.abs(p.total_dollars! - 6.1) < 1e-9);
  assert.equal(p.basis, 'uncompressed-ingest');
  // NEW: percent_reduction + rate_source land in v1 contract.
  assert.equal(p.percent_reduction, 0);
  assert.equal(p.rate_source.ingest, 'list');
  assert.equal(p.rate_source.storage, 'list');
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
  assert.ok(Math.abs(p.ingest_dollars! - 0.69) < 0.01, `ingest_dollars=${p.ingest_dollars}`);
  assert.ok(Math.abs(p.total_dollars! - 0.7015) < 0.02, `total_dollars=${p.total_dollars}`);
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

test('projectAction offload sends zero bytes downstream, total_dollars is the netted S3 residual', () => {
  const p = projectAction({
    action: 'offload',
    bytes_in: GB,
    destination: 'splunk',
  });
  // All bytes leave the SIEM.
  assert.equal(p.bytes_out, 0);
  // But total_dollars is no longer 0: it is the customer's residual S3 cost
  // (1 GB at S3 Standard $0.023/GB-mo for 1 month), surfaced separately too.
  assert.ok(Math.abs((p.total_dollars ?? -1) - 0.023) < 1e-6, `total=${p.total_dollars}`);
  assert.ok(Math.abs((p.s3_storage_dollars ?? -1) - 0.023) < 1e-6, `s3=${p.s3_storage_dollars}`);
  assert.ok(p.notes && p.notes.some((n) => /S3/.test(n)));
});

test('offload savings are netted: baseline minus S3, not gross', () => {
  // On splunk ($6/GB ingest + $0.10/GB-mo storage), 1 GB baseline (pass) costs
  // ~$6.10/mo. Offloading it removes that from the SIEM but adds ~$0.023 S3, so
  // the net saving is ~$6.077, NOT the gross $6.10.
  const baseline = projectAction({ action: 'pass', bytes_in: GB, destination: 'splunk' });
  const off = projectAction({ action: 'offload', bytes_in: GB, destination: 'splunk' });
  const netSaving = (baseline.total_dollars ?? 0) - (off.total_dollars ?? 0);
  const grossSaving = baseline.total_dollars ?? 0;
  assert.ok(netSaving < grossSaving, 'net must be below gross');
  assert.ok(Math.abs(grossSaving - netSaving - 0.023) < 1e-6, `S3 delta=${grossSaving - netSaving}`);
});

test('offload S3 rate is overridable (cheaper tier)', () => {
  const standard = projectAction({ action: 'offload', bytes_in: GB, destination: 'splunk' });
  const glacier = projectAction({
    action: 'offload', bytes_in: GB, destination: 'splunk',
    customer_rate: { s3_per_gb_month_override: 0.004 },
  });
  assert.ok((glacier.total_dollars ?? 1) < (standard.total_dollars ?? 0));
  assert.ok(Math.abs((glacier.s3_storage_dollars ?? -1) - 0.004) < 1e-6);
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
  assert.ok(Math.abs(p.storage_dollars! - 0.26 * 0.023) < 1e-6);
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
  assert.ok(Math.abs(six.storage_dollars! - 6 * one.storage_dollars!) < 1e-9);
  // ingest is one-time, unaffected
  assert.ok(Math.abs(six.ingest_dollars! - one.ingest_dollars!) < 1e-9);
});

test('annualizeDollars scales window spend to a year', () => {
  assert.ok(Math.abs(annualizeDollars(7, 7) - 365) < 1e-9);
  assert.ok(Math.abs(annualizeDollars(30, 30) - 365) < 1e-9);
  assert.equal(annualizeDollars(100, 0), 0);
  assert.equal(annualizeDollars(100, -1), 0);
});

// ---------------------------------------------------------------------------
// percent-first contract (v1: percentReduction, projectSavings, rate_source)
// ---------------------------------------------------------------------------

test('(a) percentReduction scalar (1000, 250) yields 75 across all axes', () => {
  const pct = percentReduction(1000, 250);
  assert.equal(pct.low, 75);
  assert.equal(pct.expected, 75);
  assert.equal(pct.high, 75);
});

test('(b) percentReduction triplet propagates per-axis', () => {
  const pct = percentReduction(1000, { low: 500, expected: 250, high: 100 });
  assert.equal(pct.low, 50);
  assert.equal(pct.expected, 75);
  assert.equal(pct.high, 90);
});

test('percentReduction clamps negatives and pass-bytes==0', () => {
  // bytes_out > bytes_in (envelope overhead worst case) → clamp at 0.
  assert.equal(percentReduction(100, 200).expected, 0);
  // no input → no reduction to claim.
  assert.equal(percentReduction(0, 0).expected, 0);
});

test('(c) projectSavings on datadog with no override → list_price', () => {
  // Datadog has a vendor list rate, so absent any override the headline
  // is tagged list_price.
  const h = projectSavings({
    destination: 'datadog',
    bytes_in: 1e9,
    action: 'compact',
  });
  assert.equal(h.rate_source, 'list_price');
  assert.ok(h.dollars, 'list_price headline should include dollar overlay');
  assert.ok(h.dollars!.list_expected !== undefined);
});

test('(e) projectSavings with effective_ingest_per_gb → customer_supplied', () => {
  const h = projectSavings({
    destination: 'splunk',
    bytes_in: 1e9,
    action: 'compact',
    effective_ingest_per_gb: 0.4,
  });
  assert.equal(h.rate_source, 'customer_supplied');
  assert.ok(h.dollars?.customer_expected !== undefined);
  // Storage axis still on list → both list_* and customer_* present.
  assert.ok(h.dollars?.list_expected !== undefined);
});

test('(f) projectActionRange ingest_per_gb_override flips only ingest axis', () => {
  const range = projectActionRange({
    destination: 'splunk',
    bytes_in: 1e9,
    action: 'compact',
    customer_rate: { ingest_per_gb_override: 0.4 },
  });
  assert.equal(range.rate_source.ingest, 'customer_supplied');
  assert.equal(range.rate_source.storage, 'list');
  // percent_reduction triplet populated and bounded.
  assert.ok(range.percent_reduction_expected > 0);
  assert.ok(range.percent_reduction_expected <= 100);
  assert.ok(range.percent_reduction_low <= range.percent_reduction_expected);
  assert.ok(range.percent_reduction_expected <= range.percent_reduction_high);
});

test('projectActionRange surfaces percent_reduction triplet for plain compact', () => {
  // Splunk mid-ratio ~0.115 → expected reduction ~88.5%.
  const range = projectActionRange({
    destination: 'splunk',
    bytes_in: 1e9,
    action: 'compact',
  });
  assert.ok(Math.abs(range.percent_reduction_expected - 88.5) < 1.5);
  // Low-savings axis (high ratio = 0.15) → 85% reduction.
  assert.ok(Math.abs(range.percent_reduction_low - 85) < 0.5);
  // High-savings axis (low ratio = 0.08) → 92% reduction.
  assert.ok(Math.abs(range.percent_reduction_high - 92) < 0.5);
});

test('projectActionRange hoists rate_source from expected to top level', () => {
  const range = projectActionRange({
    destination: 'datadog',
    bytes_in: 1e9,
    action: 'pass',
  });
  assert.equal(range.rate_source.ingest, 'list');
  // Datadog has $0 list storage — still 'list', not 'unset'.
  assert.equal(range.rate_source.storage, 'list');
});

// ─── Phase 2: measured compact_ratio_override ────────────────────────

test('compact_ratio_override on splunk uses the measured ratio across the whole band', () => {
  // Measured 0.5 (half the input survives) overrides the static 0.08-0.15
  // band. Splunk is envelope mode, where the on-wire size IS the billed size.
  const r = projectActionRange({
    action: 'compact',
    bytes_in: GB,
    destination: 'splunk',
    compact_ratio_override: 0.5,
  });
  // The band collapses to the single measured ratio: bytes_out = 0.5 * GB.
  assert.ok(Math.abs(r.expected.bytes_out - 0.5 * GB) < 1, `bytes_out=${r.expected.bytes_out}`);
  assert.equal(r.low.bytes_out, r.expected.bytes_out);
  assert.equal(r.high.bytes_out, r.expected.bytes_out);
  // ~50% reduction, not the ~88% the static band would have given.
  assert.ok(Math.abs(r.percent_reduction_expected - 50) < 1, `pct=${r.percent_reduction_expected}`);
  assert.ok(r.expected.notes!.some((n) => /measured/.test(n)), r.expected.notes?.join('|'));
});

test('compact_ratio_override is ignored on a non-envelope destination (clickhouse keeps its band)', () => {
  // ClickHouse compacts in dict-udf-view mode; the wire ratio diverges from
  // the stored size, so the measured override must NOT drive the projection.
  const withOverride = projectActionRange({
    action: 'compact', bytes_in: GB, destination: 'clickhouse', compact_ratio_override: 0.5,
  });
  const withoutOverride = projectActionRange({
    action: 'compact', bytes_in: GB, destination: 'clickhouse',
  });
  assert.equal(withOverride.expected.bytes_out, withoutOverride.expected.bytes_out);
});
