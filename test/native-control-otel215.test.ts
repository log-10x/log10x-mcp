/**
 * The native-filter arm on the OpenTelemetry demo capture of the published
 * datadog-flex-accounting benchmark, against the benchmark's own plans. With
 * service filters only, the rule that benchmark's control used, the arm picks
 * the services it published at 30% and 50%. With the logger.name Datadog's
 * Kafka pipeline parses, `kafka` splits by class, the rule of
 * datadog-service-control, and the selection moves to the services that are
 * now larger than any one Kafka class.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeNativeControl, controlPatterns, type ControlSource } from '../src/lib/datadog-native-control.js';

type Row = [string, string, string | null, 0 | 1, 0 | 1, 0 | 1, number];
const fx = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'otel215-native-control.json'), 'utf8')) as { rows: Row[] };
const column = { 30: 3, 50: 4, 70: 5 } as const;

function arm(target: 30 | 50 | 70, loggerName: boolean) {
  const sources: ControlSource[] = fx.rows.map((r, i) => ({
    identity: `row${i}`,
    template: '',
    sampleEvent: '',
    hash: `row${i}`,
    service: r[0],
    severity: r[1],
    count: r[6],
    bytes: r[6],
    cells: [{ service: r[0], status: r[1], ...(loggerName && r[2] ? { attribute: { name: 'logger.name', value: r[2] } } : {}), count: r[6], bytes: r[6] }],
    recommendedAction: 'keep',
  }));
  const plan = new Map(fx.rows.map((r, i) => [`row${i}`, r[column[target]] ? 'tier_down' : 'keep'] as const));
  const c = computeNativeControl(controlPatterns(sources, plan));
  return {
    filters: c.native.filters.map((f) => (f.attribute ? `${f.service} ${f.attribute.value}` : f.service)),
    plan: c.plan.events,
    native: c.native.events,
    errorsAndWarnings: c.native.errorsAndWarnings,
    keptMoved: c.native.keptPatternEventsMoved,
    left: c.native.leftThatOtherMoves,
  };
}

test('the fixture holds the 9,460 events tied to their envelope', () => {
  assert.equal(fx.rows.reduce((s, r) => s + r[6], 0), 9460);
});

test('30%: one service filter on the collector, as published, equal to the plan, no error or warning moved', () => {
  for (const loggerName of [false, true]) {
    const a = arm(30, loggerName);
    assert.deepEqual(a.filters, ['opentelemetry-collector']);
    assert.equal(a.plan, 4625);
    assert.equal(a.native, 4625);
    assert.equal(a.errorsAndWarnings, 0);
    assert.equal(a.keptMoved, 0);
    assert.equal(a.left, 0);
  }
});

test('50%: service filters pick the collector and kafka, as published; with logger.name kafka splits and cart and grafana come first', () => {
  assert.deepEqual(arm(50, false), { filters: ['opentelemetry-collector', 'kafka'], plan: 6125, native: 6172, errorsAndWarnings: 0, keptMoved: 1547, left: 1500 });
  assert.deepEqual(arm(50, true), { filters: ['opentelemetry-collector', 'cart', 'grafana'], plan: 6125, native: 6644, errorsAndWarnings: 0, keptMoved: 1096, left: 577 });
});

test('70%: service filters pick the published three and grafana; with logger.name four Kafka classes, and the frontend\'s CRITICAL events stay in Standard', () => {
  assert.deepEqual(arm(70, false), { filters: ['opentelemetry-collector', 'kafka', 'cart', 'grafana'], plan: 8001, native: 8191, errorsAndWarnings: 0, keptMoved: 939, left: 749 });
  assert.deepEqual(arm(70, true), {
    filters: [
      'opentelemetry-collector', 'cart', 'grafana', 'ad',
      'kafka org.apache.kafka.storage.internals.log.LogSegment', 'recommendation', 'kafka kafka.log.UnifiedLog', 'kafka kafka.log.LocalLog',
      'kafka org.apache.kafka.storage.internals.log.SnapshotFile',
    ],
    plan: 8001, native: 8091, errorsAndWarnings: 0, keptMoved: 876, left: 786,
  });
  assert.ok(fx.rows.some((r) => r[0] === 'frontend' && r[1] === 'CRITICAL' && r[6] === 135));
});
