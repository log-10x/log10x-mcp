import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend, loadBackendFromEnv, CustomerMetricsNotConfiguredError } from '../src/lib/customer-metrics.js';

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.LOG10X_CUSTOMER_METRICS_URL;
  delete process.env.LOG10X_CUSTOMER_METRICS_TYPE;
  delete process.env.LOG10X_CUSTOMER_METRICS_AUTH;
  delete process.env.LOG10X_CUSTOMER_METRICS_INSTANCE_ID;
});

afterEach(() => {
  for (const k of Object.keys(SAVED_ENV)) {
    process.env[k] = SAVED_ENV[k] as string;
  }
});

test('loadBackendFromEnv returns undefined when URL not set', () => {
  assert.equal(loadBackendFromEnv(), undefined);
});

test('loadBackendFromEnv rejects grafana_cloud without auth', () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://example.test';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'grafana_cloud';
  assert.throws(() => loadBackendFromEnv(), /LOG10X_CUSTOMER_METRICS_AUTH/);
});

test('loadBackendFromEnv builds grafana_cloud with API key', () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://prometheus-us-central1.grafana.net';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'grafana_cloud';
  process.env.LOG10X_CUSTOMER_METRICS_AUTH = 'glc_testkey';
  const backend = loadBackendFromEnv();
  assert.ok(backend);
  assert.equal(backend!.backendType, 'grafana_cloud');
});

test('loadBackendFromEnv builds grafana_cloud with instance ID', () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://prometheus-us-central1.grafana.net';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'grafana_cloud';
  process.env.LOG10X_CUSTOMER_METRICS_AUTH = 'glc_testkey';
  process.env.LOG10X_CUSTOMER_METRICS_INSTANCE_ID = '123456';
  const backend = loadBackendFromEnv();
  assert.ok(backend);
  assert.equal(backend!.backendType, 'grafana_cloud');
});

test('loadBackendFromEnv defaults to generic_prom', () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://prom.internal/api/v1';
  const backend = loadBackendFromEnv();
  assert.ok(backend);
  assert.equal(backend!.backendType, 'generic_prom');
});

test('loadBackendFromEnv rejects amp (not yet implemented)', () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://aps.amazonaws.com';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'amp';
  assert.throws(() => loadBackendFromEnv(), /not yet implemented/);
});

test('loadBackendFromEnv rejects unknown backend type', () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://example';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'bogus';
  assert.throws(() => loadBackendFromEnv(), /Unknown/);
});

test('MockBackend returns empty results for unknown queries', async () => {
  const mock = new MockBackend();
  const res = await mock.queryInstant('up');
  assert.equal(res.status, 'success');
  assert.equal(res.data.result.length, 0);
});

test('MockBackend returns seeded responses', async () => {
  const mock = new MockBackend();
  mock.instantResponses['up'] = {
    status: 'success',
    data: {
      resultType: 'vector',
      result: [{ metric: { __name__: 'up' }, value: [1, '1'] }],
    },
  };
  const res = await mock.queryInstant('up');
  assert.equal(res.data.result.length, 1);
  assert.equal(res.data.result[0].metric.__name__, 'up');
});

test('MockBackend listLabels returns seeded list', async () => {
  const mock = new MockBackend();
  mock.labels = ['service', 'pod', 'instance'];
  const labels = await mock.listLabels();
  assert.deepEqual(labels.sort(), ['instance', 'pod', 'service']);
});

test('CustomerMetricsNotConfiguredError has helpful message', () => {
  const err = new CustomerMetricsNotConfiguredError();
  assert.match(err.message, /LOG10X_CUSTOMER_METRICS_URL/);
  assert.match(err.message, /cross-pillar/);
  assert.equal(err.name, 'CustomerMetricsNotConfiguredError');
});
