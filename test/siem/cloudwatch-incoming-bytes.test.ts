import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomingBytesDailyAverage } from '../../src/lib/siem/cloudwatch.js';

// Billed CloudWatch ingest comes from IncomingBytes, not from storedBytes
// (compressed). The helper sums groups per day and averages the days with data.
test('IncomingBytes: per-day sum across groups, averaged over days with data', async () => {
  const fake = { send: async () => ({ MetricDataResults: [ { Values: [100, 200, 0] }, { Values: [50, 0, 0] } ] }) };
  const r = await incomingBytesDailyAverage(['/a', '/b'], 'us-east-1', Date.UTC(2026, 8, 28), fake as any);
  assert.deepEqual(r, { dailyBytes: (150 + 200) / 2, days: 2 });
});

test('IncomingBytes: an unreadable metric returns null so the caller falls back', async () => {
  const fake = { send: async () => { throw new Error('AccessDenied'); } };
  assert.equal(await incomingBytesDailyAverage(['/a'], 'us-east-1', Date.now(), fake as any), null);
});

test('IncomingBytes: no data returns null', async () => {
  const fake = { send: async () => ({ MetricDataResults: [ { Values: [] } ] }) };
  assert.equal(await incomingBytesDailyAverage(['/a'], 'us-east-1', Date.now(), fake as any), null);
});
