/**
 * The plan in user units: lines a day per statement and dollars a month on
 * every surface a person reads, with the engine's own units left to the CSV
 * rows, and each row's reason the service's sentence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  csvReason,
  fleetSentence,
  flexAddedSentence,
  fmtAboutUsd,
  linesPerDayFromCap,
  serviceLimitSentence,
  serviceLimitsFromPatterns,
  statementsUsdMonthly,
} from '../src/lib/report/user-units.js';
import {
  renderActionsCsv,
  renderCsvDiff,
  serviceLimitsFromRows,
  type PerPatternRow,
} from '../src/tools/configure-engine.js';

test('a service line reads in lines a day and dollars a month, by destination', () => {
  const l = { service: 'checkout', action: 'tier_down' as const, limitLinesPerDay: 120_000, movedStatements: 3, movedUsdMonthly: 41.2 };
  assert.equal(
    serviceLimitSentence(l, 'datadog'),
    'checkout: any statement above 120,000 lines a day goes to Flex. Today that is these 3 statements, about $41 a month.',
  );
  assert.equal(
    serviceLimitSentence(l, 'cloudwatch'),
    'checkout: any statement above 120,000 lines a day goes to Infrequent Access. Today that is these 3 statements, about $41 a month.',
  );
  assert.equal(
    serviceLimitSentence({ ...l, action: 'offload', limitLinesPerDay: null, movedStatements: 1 }, 'datadog'),
    'checkout: every statement goes to the offload bucket. Today that is this one statement, about $41 a month.',
  );
  assert.equal(
    serviceLimitSentence({ ...l, movedUsdMonthly: undefined }, 'datadog'),
    'checkout: any statement above 120,000 lines a day goes to Flex. Today that is these 3 statements.',
  );
  assert.equal(
    serviceLimitSentence({ ...l, movedStatements: 0 }, 'datadog'),
    'checkout: any statement above 120,000 lines a day goes to Flex. Today no statement is above it.',
  );
  assert.equal(serviceLimitSentence({ service: 'web', action: 'pass', movedStatements: 0 }, 'datadog'), 'web: every statement stays in Standard.');
});

test('the fleet line names the default when there is one, and the always-pass sample', () => {
  assert.equal(
    fleetSentence('datadog'),
    'Any service not listed keeps every statement in Standard. The first 5 lines of every statement always reach Standard.',
  );
  assert.equal(
    fleetSentence('datadog', { limitLinesPerDay: 250_000, action: 'tier_down' }),
    'Any service not listed: a statement above 250,000 lines a day goes to Flex. The first 5 lines of every statement always reach Standard.',
  );
  assert.equal(
    fleetSentence('splunk'),
    'Any service not listed keeps every statement in the ingest path. The first 5 lines of every statement always reach the ingest path.',
  );
});

test('no engine units in any user line', () => {
  for (const siem of ['datadog', 'cloudwatch', 'splunk', 'elasticsearch', null]) {
    for (const action of ['tier_down', 'offload', 'compact', 'sample', 'drop', 'pass'] as const) {
      for (const limit of [10, null, undefined]) {
        const t =
          serviceLimitSentence({ service: 's', action, limitLinesPerDay: limit, movedStatements: 2, movedUsdMonthly: 3 }, siem) +
          ' ' +
          fleetSentence(siem);
        assert.ok(!/240|regulator|floor|bytes per window|per window/i.test(t), t);
      }
    }
  }
});

test('the CSV reason is the sentence without commas or colons', () => {
  assert.equal(
    csvReason('checkout: any statement above 120,000 lines a day goes to Flex. Today that is these 3 statements, about $41 a month.'),
    'checkout any statement above 120000 lines a day goes to Flex. Today that is these 3 statements about $41 a month.',
  );
});

test('about-dollars rounds for reading and drops trailing zeros', () => {
  assert.equal(fmtAboutUsd(1234.5), '$1,235');
  assert.equal(fmtAboutUsd(41.2), '$41');
  assert.equal(fmtAboutUsd(2.04), '$2');
  assert.equal(fmtAboutUsd(0.5), '$0.5');
});

test('statements are priced at a month: the Standard indexing line on Datadog, ingest and storage elsewhere', () => {
  // 10 million events a month on Datadog: $17 of Standard indexing at $1.70 per million.
  assert.equal(statementsUsdMonthly('datadog', 10e9, 10e6), 17);
  // With no count the event size is the pricing's assumed 1,000 bytes.
  assert.equal(statementsUsdMonthly('datadog', 10e9), 17);
  const cw = statementsUsdMonthly('cloudwatch', 1e9, 1e6)!;
  assert.ok(cw > 0.4 && cw < 0.7, String(cw));
  assert.equal(statementsUsdMonthly(null, 1e9), undefined);
  assert.equal(statementsUsdMonthly('datadog', 0), undefined);
});

test('the Flex add-on line names the tier the plan volume lands in', () => {
  // 10 million events a month, held 3 months at Flex Starter: $18.
  assert.equal(
    flexAddedSentence('datadog', 10e9, 10e6),
    'The dollar figures are the Standard indexing line at list. Flex Starter adds about $18 a month for all of them, compute included, held 3 months.',
  );
  // 4 billion events a month, held 3 months, is above the 10 billion stored
  // Datadog recommends Starter below: scalable storage, compute on request.
  assert.equal(
    flexAddedSentence('datadog', 4000e9, 4e9),
    'The dollar figures are the Standard indexing line at list. Flex storage adds about $200 a month for all of them, compute priced by Datadog on request, held 30 days.',
  );
  assert.equal(flexAddedSentence('cloudwatch', 10e9, 10e6), undefined);
});

test('lines a day from a per-node cap: windows a day times nodes over the line size', () => {
  // 1,000 bytes per window on each of 3 nodes, 100-byte lines: 1,000 x 360 x 3 / 100.
  assert.equal(linesPerDayFromCap(1000, 3, 100), 10_800);
});

test('service limits from a window: the largest kept statement sets the limit; moved statements are counted and priced', () => {
  const patterns = [
    { hash: 'a', service: 'api', bytes: 6_000_000, count: 6000, moved: true },
    { hash: 'b', service: 'api', bytes: 2_000_000, count: 1000, moved: false },
    { hash: 'c', service: 'api', bytes: 1_000_000, count: 3000, moved: false },
    { hash: 'd', service: 'ad', bytes: 500_000, count: 500, moved: true },
  ];
  const { limits, movedBytesMonthly, movedEventsMonthly } = serviceLimitsFromPatterns(
    { api: { action: 'tier_down' }, ad: { action: 'offload' } },
    patterns,
    (p) => p.moved,
    3600,
    'datadog',
  );
  // api keeps b (2 MB, 1,000 lines an hour) and c; the limit is b, 24,000 lines a day.
  assert.deepEqual(
    limits.map((l) => [l.service, l.action, l.limitLinesPerDay, l.movedStatements]),
    [
      ['ad', 'offload', null, 1],
      ['api', 'tier_down', 24_000, 1],
    ],
  );
  // a: 6,000 events an hour is 4.32 million a month, $7.34 of Standard indexing.
  assert.equal(Math.round(limits[1].movedUsdMonthly! * 100) / 100, 7.34);
  assert.equal(movedEventsMonthly, (6000 + 500) * 720);
  assert.equal(movedBytesMonthly, (6_000_000 + 500_000) * 720);

  // The plan names the kept statement; a cap of zero bytes moves the whole container.
  const named = serviceLimitsFromPatterns(
    { api: { action: 'tier_down', capBytesMonthly: 1, keptMaxPattern: 'c' } },
    patterns.map((p) => ({ ...p, name: p.hash })),
    (p) => p.moved,
    3600,
    'datadog',
    (p) => p.name,
  );
  assert.equal(named.limits[0].limitLinesPerDay, 72_000);
  const whole = serviceLimitsFromPatterns(
    { api: { action: 'tier_down', capBytesMonthly: 0 } },
    patterns,
    (p) => p.moved,
    3600,
    'datadog',
  );
  assert.deepEqual([whole.limits[0].limitLinesPerDay, whole.limits[0].movedStatements], [null, 3]);
});

test('configure_engine: a tier_down limit is the largest pass row in lines a day, and its sentence is the CSV reason', () => {
  const row = (o: Partial<PerPatternRow>): PerPatternRow => ({
    pattern_hash: 'h', pattern: 'p', container: 'api', current_bytes_30d: 0, cap_bytes_per_window: 0, action: 'pass',
    saved_bytes_monthly: 0, saved_dollars_monthly: 0, projected_monthly_usd_low: 0, projected_monthly_usd_expected: 0,
    projected_monthly_usd_high: 0, reason: 'r', ...o,
  });
  const rows = [
    row({ pattern_hash: 'kept', cap_bytes_per_window: 9000, events_monthly: 300_000, action: 'pass' }),
    row({ pattern_hash: 'moved', cap_bytes_per_window: 50_000, current_bytes_30d: 10e9, events_monthly: 10e6, action: 'tier_down' }),
  ];
  const actions = new Map([['api', 'tier_down' as const]]);
  const limits = serviceLimitsFromRows(['api'], rows, actions, 'tier_down', 'datadog');
  assert.deepEqual(limits, [{ service: 'api', action: 'tier_down', limitLinesPerDay: 10_000, movedStatements: 1, movedUsdMonthly: 17 }]);
  const sentence = serviceLimitSentence(limits[0], 'datadog');
  assert.equal(sentence, 'api: any statement above 10,000 lines a day goes to Flex. Today that is this one statement, about $17 a month.');
  const reasons = new Map([['api', csvReason(sentence)]]);
  const diff = renderCsvDiff(['api'], undefined, rows, 'tier_down', actions, 'hard', undefined, undefined, reasons);
  assert.match(diff, /^\+api,9000::api any statement above 10000 lines a day goes to Flex\. Today that is this one statement about \$17 a month\.$/m);
  const actionsCsv = renderActionsCsv(['api'], actions, 'tier_down', undefined, 'hard', reasons);
  assert.match(actionsCsv, /^api,tier_down::api any statement above 10000 lines a day goes to Flex\. Today that is this one statement about \$17 a month\.$/m);

  // compact: the container's cap is a sum, stated at its average line size.
  // 150 bytes per window, 100-byte lines: 150 x 360 / 100 = 540 lines a day.
  const web = serviceLimitsFromRows(
    ['web'],
    [row({ container: 'web', cap_bytes_per_window: 150, current_bytes_30d: 10_800_000, events_monthly: 108_000, action: 'compact' })],
    new Map([['web', 'compact' as const]]),
    'compact',
    'cloudwatch',
  );
  assert.equal(web[0].limitLinesPerDay, 540);
});
