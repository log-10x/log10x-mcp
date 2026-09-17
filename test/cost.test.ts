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
 *   - small-event degradation: avg 50B against a 0.26 band → ~0.63.
 *   - degradation clamped to ≤ 1.0.
 *   - ClickHouse compute term: the measured curve, whole-unit stepping with a
 *     floor, and the modeled flag on every ClickHouse dollar.
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
  resolveTierDownTier,
  getAllowedActionsForDestination,
  degradeRatioForSmallEvents,
  annualizeDollars,
  percentReduction,
  projectSavings,
  cpuFractionForRowsKept,
  projectComputeSaving,
  HOURS_PER_MONTH,
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

test('COST_MODEL_BY_DESTINATION has all ten SIEMs', () => {
  const keys = Object.keys(COST_MODEL_BY_DESTINATION).sort();
  assert.deepEqual(keys, [
    'azure-monitor',
    'clickhouse',
    'cloudwatch',
    'coralogix',
    'datadog',
    'elastic-serverless',
    'elasticsearch',
    'gcp-logging',
    'splunk',
    'sumo',
  ]);
});

// Coralogix is the third destination with a modeled cheap tier (after CW IA and
// Datadog Flex). Guards the specific reason estimate_savings returned nothing
// for Coralogix: no entry at all, so no tier_down delta to compute.
test('coralogix models Monitoring as the tier_down target', () => {
  const m = COST_MODEL_BY_DESTINATION.coralogix;
  assert.equal(m.ingest_per_gb, 1.15, 'Frequent Search is the billed baseline');
  const tier = m.tier_down_target_tier;
  assert.ok(tier, 'tier_down_target_tier must be present or tier_down is a no-op');
  assert.equal(tier.ingest_rate_usd_per_gb, 0.5, 'Monitoring rate');
  // The delta is what tier_down actually saves per GB.
  assert.equal(
    Number((m.ingest_per_gb - tier.ingest_rate_usd_per_gb).toFixed(2)),
    0.65,
  );
});

// CloudWatch IA saves on INGEST ONLY. AWS's log classes page states it
// outright: "the Standard and Infrequent Access log classes differ in
// ingestion costs only. Storage charges and CloudWatch Logs Insights charges
// are the same in each log class." A cheaper storage rate here is not a
// tuning choice, it is a saving the platform does not sell, and it inflates
// every CloudWatch tier_down projection in proportion to retention_months.
test('cloudwatch IA discounts ingest and leaves storage at the Standard rate', () => {
  const m = COST_MODEL_BY_DESTINATION.cloudwatch;
  const tier = m.tier_down_target_tier;
  assert.ok(tier, 'tier_down_target_tier must be present or tier_down is a no-op');
  assert.equal(tier.ingest_rate_usd_per_gb, 0.25, 'IA ingest is half of Standard');
  assert.equal(
    tier.storage_rate_usd_per_gb_month,
    m.storage_per_gb_month,
    'IA storage must equal Standard storage: AWS bills the two classes the same on storage',
  );
  // The override path scales a customer-supplied storage rate by
  // tier/standard. Equal rates make that factor exactly 1, so a customer who
  // supplies an accurate rate is not silently handed a discount.
  assert.equal(tier.storage_rate_usd_per_gb_month / m.storage_per_gb_month, 1);
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

test('tier_down prices the caller-selected plan: azure Auxiliary bills below Basic', () => {
  const model = getDestinationCostModel('azure-monitor');
  // resolver: no selector -> default target tier (Basic); "auxiliary" -> Auxiliary.
  assert.match(resolveTierDownTier(model)!.name, /Basic/i);
  assert.match(resolveTierDownTier(model, 'auxiliary')!.name, /Auxiliary/i);
  assert.match(resolveTierDownTier(model, 'AUX')!.name, /Auxiliary/i); // case-insensitive substring
  // unknown selector falls back to the default target tier, never undefined.
  assert.match(resolveTierDownTier(model, 'nonesuch')!.name, /Basic/i);

  const basic = projectAction({ action: 'tier_down', bytes_in: GB, destination: 'azure-monitor' });
  const aux = projectAction({
    action: 'tier_down',
    bytes_in: GB,
    destination: 'azure-monitor',
    tier_down_plan: 'auxiliary',
  });

  // tier_down is a rate move, not a byte move — bytes unchanged on either plan.
  assert.equal(basic.bytes_out, GB);
  assert.equal(aux.bytes_out, GB);
  // Basic ingest ~ $0.50/GB, Auxiliary ~ $0.05/GB -> Auxiliary bills strictly less.
  assert.ok(aux.ingest_dollars! < basic.ingest_dollars!);
  assert.ok(aux.total_dollars! < basic.total_dollars!);
  // Each projection's caveat names the plan it priced.
  assert.ok(basic.notes!.some((n) => /Basic/i.test(n)));
  assert.ok(aux.notes!.some((n) => /Auxiliary/i.test(n)));
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

test('compact on clickhouse is a no-op: bytes unchanged, storage priced at full', () => {
  // ClickHouse left the compacting set on a measurement: the column codecs and
  // the text index already take what compaction would take, which put it at
  // about 7% of table bytes. ingest_per_gb=0 and storage 0.023/GB-month both
  // stay because both are true; neither is the bill.
  const p = projectAction({
    action: 'compact',
    bytes_in: GB,
    destination: 'clickhouse',
    retention_months: 1,
  });
  assert.equal(p.basis, 'stored-month');
  assert.equal(p.ingest_dollars, 0);
  assert.equal(p.bytes_out, GB);
  assert.ok(Math.abs(p.storage_dollars! - 0.023) < 1e-6);
  assert.ok(p.notes!.some((n) => /compact not supported on clickhouse/.test(n)));
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
  // Splunk, not ClickHouse: the small-event floor only bites where compaction
  // is a lever at all.
  const big = projectAction({
    action: 'compact',
    bytes_in: GB,
    avg_event_size_bytes: 500,
    destination: 'splunk',
  });
  const small = projectAction({
    action: 'compact',
    bytes_in: GB,
    avg_event_size_bytes: 50,
    destination: 'splunk',
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

test('compact_ratio_override is ignored on a non-envelope destination (elasticsearch keeps its band)', () => {
  // Elasticsearch compacts in index-pruned mode; the wire ratio diverges from
  // the billed _source footprint, so the measured override must NOT drive the
  // projection.
  const withOverride = projectActionRange({
    action: 'compact', bytes_in: GB, destination: 'elasticsearch', compact_ratio_override: 0.5,
  });
  const withoutOverride = projectActionRange({
    action: 'compact', bytes_in: GB, destination: 'elasticsearch',
  });
  assert.equal(withOverride.expected.bytes_out, withoutOverride.expected.bytes_out);
});

test('compact_ratio_override is ignored on clickhouse, where compact is a no-op', () => {
  const withOverride = projectActionRange({
    action: 'compact', bytes_in: GB, destination: 'clickhouse', compact_ratio_override: 0.5,
  });
  assert.equal(withOverride.expected.bytes_out, GB);
});

// ---------------------------------------------------------------------------
// Azure Monitor tier_down (Basic default, Auxiliary alt)
// ---------------------------------------------------------------------------

test('azure-monitor cost model carries Basic (default) + Auxiliary (alt) tiers', () => {
  const m = COST_MODEL_BY_DESTINATION['azure-monitor'];
  // default target = Basic ($0.50/GB ingest vs $2.30 Analytics)
  assert.equal(m.tier_down_target_tier?.name, 'Azure Monitor Basic Logs');
  assert.equal(m.tier_down_target_tier?.ingest_rate_usd_per_gb, 0.5);
  // Auxiliary carried as the aggressive alternative ($0.05/GB ingest)
  assert.equal(m.tier_down_alt_tiers?.length, 1);
  assert.equal(m.tier_down_alt_tiers?.[0]?.name, 'Azure Monitor Auxiliary Logs');
  assert.equal(m.tier_down_alt_tiers?.[0]?.ingest_rate_usd_per_gb, 0.05);
});

test('azure-monitor default action leads with tier_down', () => {
  assert.deepEqual(getAllowedActionsForDestination('azure-monitor'), [
    'tier_down',
    'offload',
  ]);
});

test('projectAction tier_down on azure-monitor bills the Basic tier rate, not Analytics', () => {
  const std = projectAction({ action: 'pass', bytes_in: GB, destination: 'azure-monitor' });
  const p = projectAction({ action: 'tier_down', bytes_in: GB, destination: 'azure-monitor' });
  // events still reach the stack — byte axis unchanged
  assert.equal(p.bytes_out, GB);
  // ingest billed at Basic ($0.50/GB), not the $2.30 Analytics rate
  assert.ok(Math.abs(p.ingest_dollars! - 0.5) < 1e-9, `expected 0.50, got ${p.ingest_dollars}`);
  assert.ok(Math.abs(std.ingest_dollars! - 2.3) < 1e-9, `expected 2.30, got ${std.ingest_dollars}`);
  // tier_down is strictly cheaper than standard ingest
  assert.ok(p.total_dollars! < std.total_dollars!);
  // the routing caveat names the Basic tier
  assert.ok(p.notes && p.notes.some((n) => /Azure Monitor Basic Logs/.test(n)));
});

// ---------------------------------------------------------------------------
// ClickHouse compute term
//
// The curve is the `bypattern` arm of the compute-vs-rows run (benchmarks
// clickhouse-clickstack, 2026-09-13): whole message types removed, insert CPU
// from system.query_log and merge CPU from system.part_log, fastest of three
// passes. Rows 72.85% cost 83% of the CPU, 49.32% cost 35%, 23.88% cost 15%.
// ---------------------------------------------------------------------------

const CH_COMPUTE = COST_MODEL_BY_DESTINATION.clickhouse.compute!;

test('the compute curve returns the measured points exactly', () => {
  assert.equal(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.7285), 0.83);
  assert.equal(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.4932), 0.35);
  assert.equal(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.2388), 0.15);
  assert.equal(cpuFractionForRowsKept(CH_COMPUTE.curve, 1), 1);
  assert.equal(cpuFractionForRowsKept(CH_COMPUTE.curve, 0), 0);
});

test('the compute curve interpolates linearly between measured points', () => {
  // Midway between (0.4932, 0.35) and (0.7285, 0.83).
  const kept = (0.4932 + 0.7285) / 2;
  const expected = (0.35 + 0.83) / 2;
  assert.ok(Math.abs(cpuFractionForRowsKept(CH_COMPUTE.curve, kept) - expected) < 1e-9);
  // A point inside the lowest segment, (0, 0) to (0.2388, 0.15).
  const low = cpuFractionForRowsKept(CH_COMPUTE.curve, 0.1194);
  assert.ok(Math.abs(low - 0.075) < 1e-9, `got ${low}`);
});

test('the compute curve clamps outside 0..1 rather than extrapolating', () => {
  assert.equal(cpuFractionForRowsKept(CH_COMPUTE.curve, 1.5), 1);
  assert.equal(cpuFractionForRowsKept(CH_COMPUTE.curve, -0.2), 0);
});

test('below the crossover, removing rows saves more than proportionally', () => {
  // Half the rows cost well under half the CPU. If this ever inverts, the
  // reason to remove rows on ClickHouse is gone.
  assert.ok(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.5) < 0.5);
  assert.ok(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.25) < 0.25);
});

test('above the crossover the curve is conservative, and that is deliberate', () => {
  // The 0.7285 arm measured 83% of the CPU for 73% of the rows, so between
  // roughly 0.63 rows-kept and 1.0 the model says a small cut saves LESS than
  // its share of compute. Pinning it stops anyone "fixing" the curve into a
  // uniformly more-than-proportional shape it was not measured to have.
  assert.ok(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.7285) > 0.7285);
  assert.ok(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.8) > 0.8);
  // The crossover sits at about 0.63.
  assert.ok(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.6) < 0.6);
  assert.ok(cpuFractionForRowsKept(CH_COMPUTE.curve, 0.66) > 0.66);
});

test('compute units step whole and never go below the floor', () => {
  // 100 units, half the rows removed. cpu at 0.5 rows kept is just above 0.35.
  const r = projectComputeSaving(CH_COMPUTE, 0.5, { current_units: 100 });
  assert.equal(r.units_before, 100);
  assert.equal(r.units_after, Math.ceil(100 * r.cpu_fraction));
  assert.equal(
    r.saving_usd_month,
    (r.units_before! - r.units_after!) * CH_COMPUTE.unit_usd_per_hour * HOURS_PER_MONTH,
  );
  assert.equal(r.modeled, true);
});

test('a small estate sitting at the floor saves nothing, and says so', () => {
  // Four units is below the ASSUMED floor of 12, so before and after are both
  // the floor and the modeled saving is zero dollars, not a fraction of one.
  const r = projectComputeSaving(CH_COMPUTE, 0.25, { current_units: 4 });
  assert.equal(r.units_before, CH_COMPUTE.min_units);
  assert.equal(r.units_after, CH_COMPUTE.min_units);
  assert.equal(r.saving_usd_month, 0);
  assert.equal(r.saving_fraction, 0);
  assert.match(r.note, /whole units/);
});

test('a monthly compute spend converts to units at the list unit price', () => {
  const monthlyPerUnit = CH_COMPUTE.unit_usd_per_hour * HOURS_PER_MONTH;
  const fromSpend = projectComputeSaving(CH_COMPUTE, 0.5, {
    monthly_spend_usd: monthlyPerUnit * 40,
  });
  const fromUnits = projectComputeSaving(CH_COMPUTE, 0.5, { current_units: 40 });
  assert.equal(fromSpend.units_before, fromUnits.units_before);
  assert.equal(fromSpend.units_after, fromUnits.units_after);
  assert.equal(fromSpend.saving_usd_month, fromUnits.saving_usd_month);
});

test('with no unit count the compute saving is a fraction and asks for the input', () => {
  const r = projectComputeSaving(CH_COMPUTE, 0.5);
  assert.equal(r.units_before, undefined);
  assert.equal(r.saving_usd_month, undefined);
  assert.ok(Math.abs(r.saving_fraction - (1 - r.cpu_fraction)) < 1e-12);
  assert.equal(r.modeled, true);
  assert.match(r.note, /supply current compute units or monthly compute spend to get dollars/);
});

test('offload on clickhouse reports a modeled compute saving alongside the storage one', () => {
  const p = projectAction({
    action: 'offload',
    bytes_in: GB,
    destination: 'clickhouse',
    rows_kept_fraction: 0.5,
    current_compute_units: 100,
  });
  assert.equal(p.modeled, true);
  assert.ok(p.compute_saving);
  assert.equal(p.compute_saving!.basis, 'rows-inserted');
  assert.equal(p.compute_saving!.rows_kept_fraction, 0.5);
  assert.ok(p.compute_saving!.saving_usd_month! > 0);
  // The storage side is untouched by the compute term: offloaded bytes still
  // cost S3 and no longer cost ClickHouse storage.
  assert.ok((p.s3_storage_dollars ?? 0) > 0);
});

test('sample and drop on clickhouse also carry a compute saving', () => {
  for (const action of ['sample', 'drop'] as const) {
    const p = projectAction({
      action,
      bytes_in: GB,
      destination: 'clickhouse',
      current_compute_units: 100,
    });
    assert.ok(p.compute_saving, `${action} should carry a compute saving`);
    assert.equal(p.compute_saving!.modeled, true);
  }
});

test('rows kept defaults to the byte reduction when the caller does not state it', () => {
  // sample_n = 4 keeps a quarter of the bytes, so a quarter of the rows.
  const p = projectAction({
    action: 'sample',
    bytes_in: GB,
    sample_n: 4,
    destination: 'clickhouse',
  });
  assert.ok(Math.abs(p.compute_saving!.rows_kept_fraction - 0.25) < 1e-9);
});

test('every clickhouse projection carries modeled:true and the word modeled', () => {
  for (const action of ['pass', 'compact', 'offload', 'drop', 'sample', 'tier_down'] as const) {
    const p = projectAction({ action, bytes_in: GB, destination: 'clickhouse' });
    assert.equal(p.modeled, true, `${action} lost the modeled flag`);
    assert.ok(
      p.notes!.some((n) => /modeled/i.test(n)),
      `${action} prints ClickHouse dollars with no note saying they are modeled`,
    );
  }
});

test('no destination other than clickhouse carries a compute term', () => {
  for (const [dest, model] of Object.entries(COST_MODEL_BY_DESTINATION)) {
    if (dest === 'clickhouse') {
      assert.ok(model.compute, 'clickhouse must carry the compute term');
      continue;
    }
    assert.equal(model.compute, undefined, `${dest} must not carry a compute term`);
    const p = projectAction({ action: 'offload', bytes_in: GB, destination: model.destination });
    assert.equal(p.compute_saving, undefined, `${dest} projected a compute saving`);
    assert.equal(p.modeled, undefined, `${dest} was marked modeled`);
  }
});

test('clickhouse offers offload, never compact', () => {
  const levers = getAllowedActionsForDestination('clickhouse');
  assert.deepEqual(levers, ['offload']);
  assert.equal(COST_MODEL_BY_DESTINATION.clickhouse.compact_mode, 'no-op');
});

test('projectComputeSaving is the only place a compute dollar can come from', () => {
  // The estate-level entry point. If a caller reads rows kept off one pattern
  // instead of the whole insert stream, an offload row alone resolves to 0
  // rows kept and claims the entire compute bill. estimate_savings aggregates
  // before calling this for exactly that reason; the test pins the shape that
  // makes the mistake visible.
  const wholeEstate = projectComputeSaving(CH_COMPUTE, 0.5, { current_units: 100 });
  const onePatternOffloaded = projectComputeSaving(CH_COMPUTE, 0, { current_units: 100 });
  assert.ok(onePatternOffloaded.saving_fraction > wholeEstate.saving_fraction);
  assert.equal(onePatternOffloaded.units_after, CH_COMPUTE.min_units);
});

test('a fraction derived from bytes is labelled as the proxy it is', () => {
  // No rows_kept_fraction supplied, so the projection reads rows kept off the
  // byte reduction. The curve is indexed on rows, so the result has to say
  // which it got, and the note has to carry the skew.
  const p = projectAction({ action: 'offload', bytes_in: GB, destination: 'clickhouse' });
  assert.equal(p.compute_saving!.basis, 'bytes-removed-as-rows-proxy');
  assert.match(p.compute_saving!.note, /derived from bytes removed, not from a row count/);
  assert.match(p.compute_saving!.note, /average event size/);
});

test('a stated rows-kept fraction is taken as a row count and says so', () => {
  const p = projectAction({
    action: 'offload',
    bytes_in: GB,
    destination: 'clickhouse',
    rows_kept_fraction: 0.5,
  });
  assert.equal(p.compute_saving!.basis, 'rows-inserted');
  assert.ok(!/derived from bytes removed/.test(p.compute_saving!.note));
});
