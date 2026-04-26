import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_CONNECTORS,
  getConnector,
  discoverAvailable,
  parseWindowMs,
} from '../../src/lib/siem/index.js';

test('ALL_CONNECTORS registers exactly the 8 supported SIEMs', () => {
  const ids = ALL_CONNECTORS.map((c) => c.id).sort();
  assert.deepEqual(ids, [
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

test('every connector exposes a displayName and the expected methods', () => {
  for (const c of ALL_CONNECTORS) {
    assert.ok(c.displayName.length > 0, `${c.id} missing displayName`);
    assert.equal(typeof c.discoverCredentials, 'function');
    assert.equal(typeof c.pullEvents, 'function');
  }
});

test('getConnector throws for unknown id with actionable message', () => {
  assert.throws(() => getConnector('sentinel-one'), /Valid ids:/);
});

test('getConnector resolves each known id', () => {
  const ids = [
    'cloudwatch',
    'datadog',
    'sumo',
    'gcp-logging',
    'elasticsearch',
    'azure-monitor',
    'splunk',
    'clickhouse',
  ] as const;
  for (const id of ids) {
    assert.equal(getConnector(id).id, id);
  }
});

test('parseWindowMs accepts common formats', () => {
  assert.equal(parseWindowMs('1h'), 3_600_000);
  assert.equal(parseWindowMs('24h'), 86_400_000);
  assert.equal(parseWindowMs('7d'), 7 * 86_400_000);
  assert.equal(parseWindowMs('30d'), 30 * 86_400_000);
  assert.equal(parseWindowMs('15m'), 15 * 60_000);
});

test('parseWindowMs rejects invalid input', () => {
  assert.throws(() => parseWindowMs('bogus'));
  assert.throws(() => parseWindowMs('5'));
  assert.throws(() => parseWindowMs('5y'));
});

test('discoverAvailable returns a result for every connector without throwing', async () => {
  // Isolate the probes from any local env so the test is deterministic.
  // We don't clear AWS_* because the AWS SDK might still resolve via IMDS.
  const results = await discoverAvailable();
  assert.equal(results.length, ALL_CONNECTORS.length);
  for (const r of results) {
    assert.ok(typeof r.detection.available === 'boolean');
    assert.ok(
      ['env', 'cli_config', 'ambient', 'none'].includes(r.detection.source),
      `unexpected source ${r.detection.source} for ${r.id}`
    );
  }
});
