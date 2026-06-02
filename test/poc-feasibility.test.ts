/**
 * Tests for the POC envelope's feasibility verdict + commitment artifact
 * stub (Item 3 of the cost-cutting close list).
 *
 * The envelope builder is hit directly with a synthetic enriched-pattern
 * list so we don't have to spin up a SIEM connector or the templater.
 * Covers four cases:
 *   1. No target → no feasibility, no commitment_artifact.
 *   2. Target supplied → feasibility populated; commitment_artifact carries
 *      the per-action breakdown.
 *   3. Exception services pin matching patterns to action=pass on the
 *      pattern outputs AND remove their bytes from the achievable pool.
 *   4. Datadog (level-1 = tier_down) and ClickHouse (level-1 = compact)
 *      route the same pattern set through different action coefficients.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPocEnvelopeV2 } from '../src/lib/poc-envelope-v2.js';
import type { RenderInput } from '../src/lib/poc-report-renderer.js';
import type { SiemId } from '../src/lib/siem/pricing.js';

// ── Synthetic enriched-pattern fixture ──
// Three patterns: one ERROR (kept), one big INFO (muted), one MEDIUM INFO
// (sampled). Bytes/costs are sized so the math is easy to spot-check.
type EnrichedFixture = Parameters<typeof buildPocEnvelopeV2>[1][number];

function fixturePattern(over: Partial<EnrichedFixture> & {
  identity: string;
  service: string;
  severity: string;
  bytes: number;
  count: number;
  recommendedAction: 'mute' | 'sample' | 'keep';
  refinedAction?: 'mute' | 'sample' | 'keep' | 'fix' | 'blocked';
  costPerWindow: number;
}): EnrichedFixture {
  const refined = over.refinedAction ?? over.recommendedAction;
  return {
    hash: over.identity,
    symbolMessage: over.identity,
    tenxHash: 'h' + over.identity,
    template: over.identity.replace(/_/g, ' '),
    severity: over.severity,
    service: over.service,
    count: over.count,
    bytes: over.bytes,
    encodedBytes: 0,
    sampleEvent: over.identity,
    variables: {},
    firstSeenMs: undefined,
    lastSeenMs: undefined,
    eventsByHour: undefined,
    costPerWindow: over.costPerWindow,
    costPerWeek: over.costPerWindow * 7,
    pctOfTotal: 0.33,
    poc: {
      incidentClusterId: null,
      topSlot: null,
      redundantWith: [],
      firstSeenAgeSeconds: null,
      refinedAction: refined,
      dependencyCount: null,
      dependencyChecked: false,
      emergence: null,
    },
    identity: over.identity,
    recommendedAction: over.recommendedAction,
    sampleRate: over.recommendedAction === 'sample' ? 10 : 1,
  } as EnrichedFixture;
}

function makeRenderInput(siem: SiemId): RenderInput {
  const now = Date.now();
  return {
    siem,
    window: '24h',
    extraction: {
      patterns: [],
      totalEvents: 30_000,
      totalBytes: 30_000_000,
      inputLineCount: 30_000,
      templaterWallTimeMs: 100,
      executionMode: 'local_cli',
    },
    targetEventCount: 100_000,
    pullWallTimeMs: 1000,
    templateWallTimeMs: 100,
    reasonStopped: 'target_reached',
    queryUsed: 'test',
    windowHours: 24,
    analyzerCostPerGb: 2.5,
    snapshotId: 'test-snapshot',
    startedAt: new Date(now - 3_600_000).toISOString(),
    finishedAt: new Date(now).toISOString(),
    mcpVersion: 'test',
    windowStartMs: now - 86_400_000,
    windowEndMs: now,
  };
}

function makePatterns(): EnrichedFixture[] {
  return [
    fixturePattern({
      identity: 'noisy_info_hot_loop',
      service: 'payments',
      severity: 'INFO',
      bytes: 20_000_000,
      count: 20_000,
      costPerWindow: 0.50,
      recommendedAction: 'mute',
      refinedAction: 'mute',
    }),
    fixturePattern({
      identity: 'medium_debug',
      service: 'auth',
      severity: 'INFO',
      bytes: 8_000_000,
      count: 8_000,
      costPerWindow: 0.20,
      recommendedAction: 'sample',
      refinedAction: 'sample',
    }),
    fixturePattern({
      identity: 'error_keepalive',
      service: 'orders',
      severity: 'ERROR',
      bytes: 2_000_000,
      count: 2_000,
      costPerWindow: 0.05,
      recommendedAction: 'keep',
      refinedAction: 'keep',
    }),
  ];
}

test('no target_percent_reduction → no feasibility / commitment_artifact', () => {
  const input = makeRenderInput('splunk');
  const patterns = makePatterns();
  const envelope = buildPocEnvelopeV2(input, patterns, [], [], 10);
  assert.equal(envelope.output.feasibility, undefined);
  assert.equal(envelope.output.commitment_artifact, undefined);
});

test('target_percent_reduction → feasibility + commitment artifact emitted', () => {
  const input = makeRenderInput('splunk');
  const patterns = makePatterns();
  const envelope = buildPocEnvelopeV2(input, patterns, [], [], 10, {
    targetPercentReduction: 50,
  });
  const f = envelope.output.feasibility;
  assert.ok(f, 'feasibility populated when target supplied');
  assert.equal(f.target_percent_reduction, 50);
  assert.ok(f.max_achievable_percent > 0, 'achievable > 0 when noisy_info dominates pool');
  assert.equal(typeof f.feasible, 'boolean');
  assert.ok(Array.isArray(f.achievable_by_action));
  assert.ok(f.achievable_by_action.length > 0);
  assert.deepEqual(f.exception_services, []);
  assert.equal(f.exception_monthly_cost_usd, 0);

  const a = envelope.output.commitment_artifact;
  assert.ok(a, 'commitment_artifact populated when target supplied');
  assert.match(a.markdown, /Projected commitment/);
  assert.match(a.markdown, /Target reduction.*50%/);
  assert.match(a.markdown, /Next step/);
  // Recommended next step is always one of the two install/configure tools.
  assert.ok(
    a.next_step.tool === 'log10x_advise_install' ||
      a.next_step.tool === 'log10x_configure_engine',
  );
});

test('exception_services pin patterns to action=pass and subtract from pool', () => {
  const input = makeRenderInput('splunk');
  const patterns = makePatterns();
  // Pin the dominant 'payments' service. With its bytes removed from the
  // achievable pool, max_achievable should collapse dramatically.
  const envelope = buildPocEnvelopeV2(input, patterns, [], [], 10, {
    targetPercentReduction: 50,
    exceptionServices: ['payments'],
  });
  const f = envelope.output.feasibility!;
  assert.ok(f.exception_services.includes('payments'));
  assert.ok(f.exception_monthly_cost_usd > 0, 'exception monthly cost > 0');

  // The payments pattern in the top-N output should be pinned to
  // recommended_action='pass' with the exception-list reason.
  const paymentsRow = envelope.output.patterns.find((p) => p.service === 'payments');
  assert.ok(paymentsRow, 'payments pattern present in output');
  assert.equal(paymentsRow.actions.recommended_action, 'pass');
  assert.equal(paymentsRow.actions.reason, 'service_pinned_by_exception_list');
  assert.equal(paymentsRow.actions.expected_savings_usd_per_month, 0);
  assert.equal(paymentsRow.actions.sample_n, null);

  // Same target → without the exception list the verdict should differ.
  const withoutException = buildPocEnvelopeV2(input, makePatterns(), [], [], 10, {
    targetPercentReduction: 50,
  });
  assert.ok(
    withoutException.output.feasibility!.max_achievable_percent >
      f.max_achievable_percent,
    'achievable shrinks when exceptions added',
  );

  // Commitment artifact should mark the exception in the consequence table.
  // (Per the consequence-led envelope migration: legacy "### Exception services"
  // section was replaced with "_(exception)_" tags on the per-service rows.)
  assert.match(envelope.output.commitment_artifact!.markdown, /_\(exception\)_/);
  assert.match(envelope.output.commitment_artifact!.markdown, /payments/);
});

test('destination level-1 action shifts the feasibility math', () => {
  const input = makeRenderInput('datadog');
  const ddEnvelope = buildPocEnvelopeV2(input, makePatterns(), [], [], 10, {
    targetPercentReduction: 50,
  });

  const chInput = makeRenderInput('clickhouse');
  const chEnvelope = buildPocEnvelopeV2(chInput, makePatterns(), [], [], 10, {
    targetPercentReduction: 50,
  });

  // Datadog's level-1 is tier_down (coefficient 0.6); ClickHouse's is
  // compact (coefficient 0.7). On the same pattern set, ClickHouse
  // should yield a larger achievable percent than Datadog.
  assert.ok(
    chEnvelope.output.feasibility!.max_achievable_percent >
      ddEnvelope.output.feasibility!.max_achievable_percent,
    `ClickHouse achievable (${chEnvelope.output.feasibility!.max_achievable_percent}) ` +
      `should exceed Datadog (${ddEnvelope.output.feasibility!.max_achievable_percent}) ` +
      'because compact (0.7) > tier_down (0.6) coefficient',
  );

  // Reason strings should mention the level-1 action.
  assert.match(ddEnvelope.output.feasibility!.reason, /tier_down/);
  assert.match(chEnvelope.output.feasibility!.reason, /compact/);
});

test('cap_csv emitted in 6-action vocab and parses back via cap-csv-parser', async () => {
  // Item 4 acceptance: POC envelope produces a cap_csv string that
  // matches the same row format configure_engine writes, and the
  // shared parser round-trips it without malformed_lines.
  const { parseCapCsv } = await import('../src/lib/cap-csv-parser.js');
  const input = makeRenderInput('splunk');
  const envelope = buildPocEnvelopeV2(input, makePatterns(), [], [], 10, {
    targetPercentReduction: 30,
    exceptionServices: ['orders'],
  });
  const capCsv = envelope.output.cap_csv;
  assert.ok(capCsv, 'cap_csv emitted when target_percent_reduction set');
  assert.match(capCsv, /^container,cap\n/, 'header row present');

  const parsed = parseCapCsv(capCsv);
  assert.equal(parsed.malformed_lines.length, 0, 'every row parses cleanly');
  // Container-level rows for each observed service.
  assert.ok(parsed.by_container.size >= 1, 'at least one container default row');
  // The exception service (orders) should be a `pass` container row.
  const orders = parsed.by_container.get('orders');
  assert.ok(orders, 'orders container row present (exception service)');
  assert.equal(orders.action, 'pass');
  // Action set across all rows is a subset of the 6-action vocab.
  const allowed = new Set(['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop']);
  for (const r of parsed.rows) {
    assert.ok(allowed.has(r.action), `row action ${r.action} not in 6-action vocab`);
  }
});

test('no cap_csv when target_percent_reduction absent', () => {
  // Symmetric to the no-feasibility path: recommendation-only mode
  // produces no commitment artifact AND no cap_csv.
  const input = makeRenderInput('splunk');
  const envelope = buildPocEnvelopeV2(input, makePatterns(), [], [], 10);
  assert.equal(envelope.output.cap_csv, undefined);
});
