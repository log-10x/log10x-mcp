import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, parseBucketSize } from '../src/lib/aggregator.js';
import type { RetrieverEvent } from '../src/lib/retriever-api.js';

function ev(iso: string, service?: string, severity?: string, text = 'x'): RetrieverEvent {
  return { timestamp: iso, service, severity, templateHash: '~t', text, enrichedFields: {} };
}

test('parseBucketSize handles all units', () => {
  assert.equal(parseBucketSize('5m'), 300);
  assert.equal(parseBucketSize('1h'), 3600);
  assert.equal(parseBucketSize('1d'), 86_400);
  assert.equal(parseBucketSize('30s'), 30);
});

test('parseBucketSize rejects invalid input', () => {
  assert.throws(() => parseBucketSize('bogus'));
  assert.throws(() => parseBucketSize('5'));
});

test('aggregate count: events in the same bucket collapse', () => {
  const events: RetrieverEvent[] = [
    ev('2026-01-01T00:00:00Z'),
    ev('2026-01-01T00:02:00Z'),
    ev('2026-01-01T00:04:59Z'),
    ev('2026-01-01T00:05:00Z'),
  ];
  const out = aggregate(events, { bucketSize: '5m', aggregation: 'count' });
  assert.equal(out.points.length, 2);
  assert.equal(out.points[0].value, 3);
  assert.equal(out.points[1].value, 1);
});

test('aggregate with groupBy produces one series per label combination', () => {
  const events: RetrieverEvent[] = [
    ev('2026-01-01T00:00:00Z', 'svc-a'),
    ev('2026-01-01T00:01:00Z', 'svc-a'),
    ev('2026-01-01T00:02:00Z', 'svc-b'),
  ];
  const out = aggregate(events, { bucketSize: '5m', aggregation: 'count', groupBy: ['service'] });
  assert.equal(out.seriesCount, 2);
  const svcA = out.points.find((p) => p.labels.service === 'svc-a');
  const svcB = out.points.find((p) => p.labels.service === 'svc-b');
  assert.equal(svcA!.value, 2);
  assert.equal(svcB!.value, 1);
});

test('aggregate rate_per_second normalizes by bucket seconds', () => {
  const events: RetrieverEvent[] = [
    ev('2026-01-01T00:00:00Z'),
    ev('2026-01-01T00:01:00Z'),
    ev('2026-01-01T00:02:00Z'),
  ];
  const out = aggregate(events, { bucketSize: '5m', aggregation: 'rate_per_second' });
  assert.equal(out.points[0].value, 3 / 300);
});

test('aggregate drops events with unparseable timestamps', () => {
  const events: RetrieverEvent[] = [
    ev('2026-01-01T00:00:00Z'),
    ev('not-a-date'),
  ];
  const out = aggregate(events, { bucketSize: '5m', aggregation: 'count' });
  assert.equal(out.points.length, 1);
  assert.equal(out.points[0].value, 1);
});

test('aggregate unique_values counts cardinality per bucket', () => {
  const events: RetrieverEvent[] = [
    {
      timestamp: '2026-01-01T00:00:00Z',
      templateHash: '~t',
      text: '',
      enrichedFields: { tenant: 'a' },
    },
    {
      timestamp: '2026-01-01T00:01:00Z',
      templateHash: '~t',
      text: '',
      enrichedFields: { tenant: 'a' },
    },
    {
      timestamp: '2026-01-01T00:02:00Z',
      templateHash: '~t',
      text: '',
      enrichedFields: { tenant: 'b' },
    },
  ];
  const out = aggregate(events, { bucketSize: '5m', aggregation: 'unique_values', uniqueField: 'tenant' });
  assert.equal(out.points[0].value, 2);
});
