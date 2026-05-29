/**
 * Tests for POC enrichers (`src/lib/poc-enrichers.ts`).
 *
 * Coverage:
 *   - computeTopSlot picks the highest-distinct-count slot
 *   - detectRedundancyPairs finds 1:1 firing within tolerance
 *   - refineAction promotes ERROR-class dependency failures to FIX
 *   - refineAction promotes mute → BLOCKED when dep_count > 0
 *   - enrichForPoc end-to-end on a fixture
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTopSlot,
  detectRedundancyPairs,
  refineAction,
  enrichForPoc,
  computeEmergence,
  type EnrichableForPoc,
} from '../src/lib/poc-enrichers.js';

function mkPattern(over: Partial<EnrichableForPoc>): EnrichableForPoc {
  return {
    identity: 'test_pattern',
    service: 'svc',
    severity: 'INFO',
    template: 'template',
    symbolMessage: 'symbol',
    count: 100,
    bytes: 1000,
    costPerWindow: 1,
    costPerWeek: 7,
    variables: {},
    recommendedAction: 'keep',
    sampleRate: 1,
    reasoning: '',
    ...over,
  };
}

test('computeTopSlot returns null for empty variables', () => {
  const out = computeTopSlot({}, 100);
  assert.equal(out, null);
});

test('computeTopSlot picks the slot with highest distinct count', () => {
  const variables = {
    user_id: ['a', 'b', 'c', 'd', 'e'],
    request_id: ['x'],
    status: ['200', '404'],
  };
  const out = computeTopSlot(variables, 50);
  assert.ok(out);
  assert.equal(out!.slot, 'user_id');
  assert.equal(out!.distinctCount, 5);
  assert.equal(out!.distinctOverCount, 5 / 50);
});

test('computeTopSlot caps distinctOverCount at 1.0', () => {
  // pathological: distinct count exceeds total event count (sample
  // skew); clamp to 1.0 so the renderer never shows 1.5×.
  const variables = { trace: ['1', '2', '3', '4', '5', '6'] };
  const out = computeTopSlot(variables, 3);
  assert.ok(out);
  assert.equal(out!.distinctOverCount, 1);
});

test('detectRedundancyPairs finds 1:1 pairs in the same service', () => {
  const patterns: EnrichableForPoc[] = [
    mkPattern({ identity: 'charge_received', count: 1000, service: 'payment' }),
    mkPattern({ identity: 'transaction_complete', count: 1005, service: 'payment' }),
    mkPattern({ identity: 'unrelated', count: 1003, service: 'shipping' }),
  ];
  const pairs = detectRedundancyPairs(patterns);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].identityA, 'charge_received');
  assert.equal(pairs[0].identityB, 'transaction_complete');
});

test('detectRedundancyPairs rejects cross-service matches', () => {
  // Same counts but different services — coincidence, not redundancy.
  const patterns: EnrichableForPoc[] = [
    mkPattern({ identity: 'a', count: 500, service: 'svc1' }),
    mkPattern({ identity: 'b', count: 500, service: 'svc2' }),
  ];
  assert.equal(detectRedundancyPairs(patterns).length, 0);
});

test('detectRedundancyPairs rejects counts below minCount', () => {
  const patterns: EnrichableForPoc[] = [
    mkPattern({ identity: 'a', count: 10, service: 's' }),
    mkPattern({ identity: 'b', count: 10, service: 's' }),
  ];
  assert.equal(detectRedundancyPairs(patterns).length, 0);
});

test('detectRedundancyPairs rejects ratios outside tolerance', () => {
  const patterns: EnrichableForPoc[] = [
    mkPattern({ identity: 'a', count: 1000, service: 's' }),
    mkPattern({ identity: 'b', count: 2000, service: 's' }), // ratio 2.0 > 1.15
  ];
  assert.equal(detectRedundancyPairs(patterns).length, 0);
});

test('refineAction returns FIX for ERROR with dial-failure descriptor', () => {
  const p = mkPattern({
    severity: 'ERROR',
    template: 'dial tcp lookup opensearch no such host',
    recommendedAction: 'keep',
  });
  assert.equal(refineAction(p, null), 'fix');
});

test('refineAction returns FIX for ERROR with timeout descriptor', () => {
  const p = mkPattern({
    severity: 'CRITICAL',
    template: 'request timeout exceeded',
    recommendedAction: 'keep',
  });
  assert.equal(refineAction(p, null), 'fix');
});

test('refineAction promotes mute → blocked when dep_count > 0', () => {
  const p = mkPattern({ severity: 'INFO', recommendedAction: 'mute' });
  assert.equal(refineAction(p, 3), 'blocked');
});

test('refineAction passes through mute when no dependencies', () => {
  const p = mkPattern({ severity: 'INFO', recommendedAction: 'mute' });
  assert.equal(refineAction(p, 0), 'mute');
  assert.equal(refineAction(p, null), 'mute');
});

test('refineAction does not promote sample or keep to blocked', () => {
  const p1 = mkPattern({ severity: 'INFO', recommendedAction: 'sample' });
  assert.equal(refineAction(p1, 5), 'sample');
  const p2 = mkPattern({ severity: 'INFO', recommendedAction: 'keep' });
  assert.equal(refineAction(p2, 5), 'keep');
});

test('enrichForPoc end-to-end on a 5-pattern fixture', () => {
  const patterns: EnrichableForPoc[] = [
    mkPattern({
      identity: 'opensearch_round_trip_error',
      // Real otel-demo symbolMessages share most tokens between the two
      // opensearch failures — the incident detector relies on that.
      symbolMessage: 'opensearch_round_trip_error_dial_tcp_lookup_failed',
      service: 'otel-collector',
      severity: 'ERROR',
      template: 'opensearch dial tcp lookup error',
      count: 1000,
      bytes: 100_000,
      costPerWindow: 100,
      recommendedAction: 'keep',
    }),
    mkPattern({
      identity: 'opensearch_lookup_no_such_host',
      symbolMessage: 'opensearch_round_trip_error_dial_tcp_lookup_no_such_host',
      service: 'otel-collector',
      severity: 'ERROR',
      template: 'opensearch dial tcp lookup no such host error',
      // Count diverges enough (ratio 2.0 > 1.15) that this pair is NOT
      // flagged as redundant. They still cluster as one incident via
      // descriptor token overlap — different join criterion.
      count: 500,
      bytes: 90_000,
      costPerWindow: 90,
      recommendedAction: 'keep',
    }),
    mkPattern({
      identity: 'charge_request_received',
      symbolMessage: 'charge_request_received',
      service: 'payment',
      severity: 'INFO',
      template: 'charge request received',
      count: 500,
      bytes: 50_000,
      costPerWindow: 50,
      recommendedAction: 'mute',
      variables: { user_id: ['a', 'b', 'c', 'd', 'e'] },
    }),
    mkPattern({
      identity: 'transaction_complete',
      symbolMessage: 'transaction_complete',
      service: 'payment',
      severity: 'INFO',
      template: 'transaction complete',
      count: 505,
      bytes: 50_000,
      costPerWindow: 50,
      recommendedAction: 'mute',
    }),
    mkPattern({
      identity: 'low_volume',
      symbolMessage: 'low_volume_noise',
      service: 'frontend',
      severity: 'INFO',
      template: 'low volume noise',
      count: 10,
      bytes: 1_000,
      costPerWindow: 1,
      recommendedAction: 'keep',
    }),
  ];

  const { enrichments, clusters, redundancyPairs } = enrichForPoc(patterns, {
    dependencyByIdentity: new Map([['charge_request_received', 2]]),
  });

  // Two opensearch errors should cluster as one incident.
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
  assert.equal(clusters[0].service, 'otel-collector');

  // Payment pair should be flagged as redundancy.
  assert.equal(redundancyPairs.length, 1);

  // Charge with dep_count=2 + mute action should refine to BLOCKED.
  const chargeEnrichment = enrichments[2];
  assert.equal(chargeEnrichment.refinedAction, 'blocked');
  assert.equal(chargeEnrichment.dependencyChecked, true);
  assert.equal(chargeEnrichment.dependencyCount, 2);
  assert.equal(chargeEnrichment.topSlot?.slot, 'user_id');

  // The two opensearch errors should refine to FIX (dial+no_such_host).
  assert.equal(enrichments[0].refinedAction, 'fix');
  assert.equal(enrichments[1].refinedAction, 'fix');

  // transaction_complete + redundant_with should include charge_request_received.
  assert.ok(enrichments[3].redundantWith.includes('charge_request_received'));
});

// ── Emergence categorization ────────────────────────────────────────

test('computeEmergence returns unknown when timestamps are missing', () => {
  const result = computeEmergence({ count: 100 }, 0, 14 * 86400 * 1000);
  assert.equal(result.category, 'unknown');
  assert.equal(result.ageInWindowMs, 0);
});

test('computeEmergence marks pattern NEW when first-seen is within last 24h', () => {
  const windowEnd = 14 * 86400 * 1000;
  const windowStart = 0;
  const lastHour = windowEnd - 3_600_000;
  const result = computeEmergence(
    { firstSeenMs: lastHour, lastSeenMs: windowEnd, eventsByHour: { [Math.floor(lastHour / 3_600_000)]: 100 }, count: 100 },
    windowStart,
    windowEnd,
  );
  assert.equal(result.category, 'new');
});

test('computeEmergence marks pattern GROWING when last-24h rate is 2x window average', () => {
  const windowEnd = 14 * 86400 * 1000; // 14 days
  const windowStart = 0;
  // 14-day average: 10 events/hr. Last 24h: 100 events/hr (10x acceleration).
  const eventsByHour: Record<number, number> = {};
  for (let h = 0; h < 14 * 24 - 24; h++) eventsByHour[h] = 5; // first 13 days, low rate
  const last24hBucket = Math.floor((windowEnd - 24 * 3_600_000) / 3_600_000);
  for (let h = 0; h < 24; h++) eventsByHour[last24hBucket + h] = 200; // last 24h, high rate
  const totalCount = Object.values(eventsByHour).reduce((s, n) => s + n, 0);
  const result = computeEmergence(
    {
      firstSeenMs: windowStart + 3_600_000, // started early in window, not NEW
      lastSeenMs: windowEnd,
      eventsByHour,
      count: totalCount,
    },
    windowStart,
    windowEnd,
  );
  assert.equal(result.category, 'growing');
  assert.ok(result.accelerationRatio >= 2.0);
});

test('computeEmergence marks pattern STABLE when fires throughout the window', () => {
  const windowEnd = 14 * 86400 * 1000;
  const windowStart = 0;
  const eventsByHour: Record<number, number> = {};
  for (let h = 0; h < 14 * 24; h++) eventsByHour[h] = 10; // steady rate
  const result = computeEmergence(
    {
      firstSeenMs: windowStart + 60_000,
      lastSeenMs: windowEnd - 60_000,
      eventsByHour,
      count: 14 * 24 * 10,
    },
    windowStart,
    windowEnd,
  );
  assert.equal(result.category, 'stable');
});

test('computeEmergence marks pattern RECENT_BURST when activity fits in <40% of window', () => {
  const windowEnd = 14 * 86400 * 1000;
  const windowStart = 0;
  // 24h burst centered ~5 days back. Activity ends well before the
  // last-24h boundary, so last-24h count is 0 (not 'growing') and the
  // first-seen is not within last 24h (not 'new'). Duration ~24h /
  // 14d ~7% of window → category is recent_burst.
  const burstStart = windowEnd - 5 * 86400 * 1000;
  const burstEnd = burstStart + 86400 * 1000;
  const eventsByHour: Record<number, number> = {};
  for (let h = 0; h < 24; h++) {
    eventsByHour[Math.floor(burstStart / 3_600_000) + h] = 20;
  }
  const result = computeEmergence(
    {
      firstSeenMs: burstStart,
      lastSeenMs: burstEnd,
      eventsByHour,
      count: 24 * 20,
    },
    windowStart,
    windowEnd,
  );
  assert.equal(result.category, 'recent_burst');
});
