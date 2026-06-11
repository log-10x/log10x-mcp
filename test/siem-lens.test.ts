/**
 * Unit tests for the SIEM pricing/applicability lens (lib/siem/lens.ts) and
 * its honesty contract in resolveRate.
 *
 * Asserts:
 *   1. resolveSiemLens: detected / requested / requested-equals-actual /
 *      invalid / alias normalization.
 *   2. lensDisclosure stamps the envelope fragment correctly in every mode.
 *   3. resolveRate under a lens: env-configured rates (rungs 2/3) are
 *      SKIPPED so the lens lands on the lens destination's list price;
 *      an explicit caller rate (rung 1) still wins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSiemLens, lensDisclosure, toSiemId, SIEM_LENS_IDS } from '../src/lib/siem/lens.js';
import { resolveRate } from '../src/lib/rate-resolution.js';
import { DEFAULT_ANALYZER_COST_PER_GB } from '../src/lib/siem/pricing.js';
import type { EnvConfig } from '../src/lib/environments.js';

test('toSiemId normalizes aliases and rejects unknowns', () => {
  assert.equal(toSiemId('Splunk'), 'splunk');
  assert.equal(toSiemId('AWS CloudWatch'), 'cloudwatch');
  assert.equal(toSiemId('elastic'), 'elasticsearch');
  assert.equal(toSiemId('azure'), 'azure-monitor');
  assert.equal(toSiemId('dynatrace'), null); // not priceable
  assert.equal(toSiemId(undefined), null);
  assert.equal(toSiemId(''), null);
});

test('resolveSiemLens: no request -> detected basis, not lensed', () => {
  const r = resolveSiemLens(undefined, 'cloudwatch');
  assert.equal(r.lensed, false);
  assert.equal(r.basis, 'detected');
  assert.equal(r.actual, 'cloudwatch');
  assert.equal(r.effective, 'cloudwatch');
  assert.equal(r.disclosure, null);
});

test('resolveSiemLens: requested differs -> lensed, disclosure present', () => {
  const r = resolveSiemLens('splunk', 'cloudwatch');
  assert.equal(r.lensed, true);
  assert.equal(r.basis, 'requested');
  assert.equal(r.actual, 'cloudwatch');
  assert.equal(r.effective, 'splunk');
  assert.ok(r.disclosure && r.disclosure.includes('Splunk'));
  assert.ok(r.disclosure.includes('CloudWatch') || r.disclosure.includes('Amazon CloudWatch Logs'));
});

test('resolveSiemLens: requested equals actual -> not a what-if', () => {
  const r = resolveSiemLens('cloudwatch', 'cloudwatch');
  assert.equal(r.lensed, false);
  assert.equal(r.basis, 'requested');
  assert.equal(r.disclosure, null);
});

test('resolveSiemLens: unknown env analyzer -> lens still resolves, actual null', () => {
  const r = resolveSiemLens('datadog', undefined);
  assert.equal(r.lensed, true);
  assert.equal(r.actual, null);
  assert.equal(r.effective, 'datadog');
});

test('resolveSiemLens: invalid requested value throws with valid list', () => {
  assert.throws(() => resolveSiemLens('grafana', 'cloudwatch'), /not a priceable destination/);
});

test('lensDisclosure stamps actual + lens + basis', () => {
  const lensed = lensDisclosure(resolveSiemLens('splunk', 'cloudwatch'));
  assert.equal(lensed.siem_actual, 'cloudwatch');
  assert.equal(lensed.siem_lens, 'splunk');
  assert.equal(lensed.siem_lens_basis, 'requested');

  const plain = lensDisclosure(resolveSiemLens(undefined, 'cloudwatch'));
  assert.equal(plain.siem_actual, 'cloudwatch');
  assert.equal(plain.siem_lens, undefined);
  assert.equal(plain.siem_lens_basis, 'detected');
});

test('every SIEM_LENS_ID has a list price', () => {
  for (const id of SIEM_LENS_IDS) {
    assert.ok(Number.isFinite(DEFAULT_ANALYZER_COST_PER_GB[id]), id);
  }
});

test('resolveRate under lens: env-configured rate is skipped, lens list price wins', () => {
  const env = { analyzerCost: 1.5 } as unknown as EnvConfig;
  // Not lensed: env rate (rung 2) wins.
  const plain = resolveRate(undefined, env, 'cloudwatch');
  assert.equal(plain.source, 'customer_supplied');
  assert.equal(plain.rate_per_gb, 1.5);
  // Lensed to splunk: rung 2 skipped, splunk list price (rung 4).
  const lensed = resolveRate(undefined, env, 'splunk', { lensed: true });
  assert.equal(lensed.source, 'list_price');
  assert.equal(lensed.rate_per_gb, DEFAULT_ANALYZER_COST_PER_GB.splunk);
  assert.ok(lensed.disclosure && lensed.disclosure.includes('list price'));
});

test('resolveRate under lens: explicit caller rate still wins (rung 1)', () => {
  const env = { analyzerCost: 1.5 } as unknown as EnvConfig;
  const r = resolveRate({ effective_ingest_per_gb: 4.25 }, env, 'splunk', { lensed: true });
  assert.equal(r.source, 'customer_supplied');
  assert.equal(r.rate_per_gb, 4.25);
});

test('resolveRate under lens: LOG10X_ANALYZER_COST env var is skipped', () => {
  const prev = process.env.LOG10X_ANALYZER_COST;
  process.env.LOG10X_ANALYZER_COST = '2.75';
  try {
    const lensed = resolveRate(undefined, undefined, 'datadog', { lensed: true });
    assert.equal(lensed.source, 'list_price');
    assert.equal(lensed.rate_per_gb, DEFAULT_ANALYZER_COST_PER_GB.datadog);
    const plain = resolveRate(undefined, undefined, 'datadog');
    assert.equal(plain.source, 'customer_supplied');
    assert.equal(plain.rate_per_gb, 2.75);
  } finally {
    if (prev === undefined) delete process.env.LOG10X_ANALYZER_COST;
    else process.env.LOG10X_ANALYZER_COST = prev;
  }
});

test('toSiemId is case-insensitive incl. ids with no alias branch', () => {
  assert.equal(toSiemId('ClickHouse'), 'clickhouse');
  assert.equal(toSiemId('CLICKHOUSE'), 'clickhouse');
  assert.equal(toSiemId('GCP-Logging'), 'gcp-logging');
  assert.equal(toSiemId('"splunk"'), 'splunk'); // model-mangled quoting
});

test('cost_options gates compact by the cost model under a lens (no-op set)', async () => {
  const { _internals } = await import('../src/tools/cost-options.js');
  // siemSupportsCompact is internal; assert through the public surface if
  // exported, else via the cost model directly.
  const { COST_MODEL_BY_DESTINATION } = await import('../src/lib/cost.js');
  for (const dest of ['azure-monitor', 'gcp-logging', 'sumo', 'datadog', 'cloudwatch'] as const) {
    assert.equal(COST_MODEL_BY_DESTINATION[dest].compact_mode, 'no-op', dest);
  }
  for (const dest of ['splunk', 'elasticsearch', 'clickhouse'] as const) {
    assert.notEqual(COST_MODEL_BY_DESTINATION[dest].compact_mode, 'no-op', dest);
  }
  void _internals;
});
