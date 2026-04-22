import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend, loadBackendFromEnv, CustomerMetricsNotConfiguredError } from '../src/lib/customer-metrics.js';

const SAVED_ENV = { ...process.env };

// Env keys that can influence resolution — clear them all for a clean baseline
// on every test, otherwise ambient shell state (real DD_API_KEY / AWS_REGION)
// leaks into assertions.
const DETECTION_KEYS = [
  'LOG10X_CUSTOMER_METRICS_URL',
  'LOG10X_CUSTOMER_METRICS_TYPE',
  'LOG10X_CUSTOMER_METRICS_AUTH',
  'LOG10X_CUSTOMER_METRICS_INSTANCE_ID',
  'GRAFANA_CLOUD_API_KEY',
  'GRAFANA_CLOUD_URL',
  'GRAFANA_CLOUD_INSTANCE_ID',
  'GRAFANA_CLOUD_TOKEN',
  'GCLOUD_API_KEY',
  'GCLOUD_PROMETHEUS_URL',
  'GCLOUD_PROMETHEUS_USERNAME',
  'DD_API_KEY',
  'DD_APP_KEY',
  'DD_SITE',
  'DATADOG_API_KEY',
  'DATADOG_APP_KEY',
  'DATADOG_SITE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AMP_WORKSPACE_URL',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'PROMETHEUS_URL',
  'PROMETHEUS_BEARER_TOKEN',
];

beforeEach(() => {
  for (const k of DETECTION_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of DETECTION_KEYS) delete process.env[k];
  for (const k of DETECTION_KEYS) {
    if (SAVED_ENV[k] !== undefined) process.env[k] = SAVED_ENV[k] as string;
  }
});

test('loadBackendFromEnv returns undefined when nothing configured', async () => {
  assert.equal(await loadBackendFromEnv(), undefined);
});

test('loadBackendFromEnv rejects grafana_cloud without auth', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://example.test';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'grafana_cloud';
  await assert.rejects(() => loadBackendFromEnv(), /LOG10X_CUSTOMER_METRICS_AUTH/);
});

test('loadBackendFromEnv builds grafana_cloud with API key', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://prometheus-us-central1.grafana.net';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'grafana_cloud';
  process.env.LOG10X_CUSTOMER_METRICS_AUTH = 'glc_testkey';
  const backend = await loadBackendFromEnv();
  assert.ok(backend);
  assert.equal(backend!.backendType, 'grafana_cloud');
});

test('loadBackendFromEnv builds grafana_cloud with instance ID', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://prometheus-us-central1.grafana.net';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'grafana_cloud';
  process.env.LOG10X_CUSTOMER_METRICS_AUTH = 'glc_testkey';
  process.env.LOG10X_CUSTOMER_METRICS_INSTANCE_ID = '123456';
  const backend = await loadBackendFromEnv();
  assert.ok(backend);
  assert.equal(backend!.backendType, 'grafana_cloud');
});

test('loadBackendFromEnv defaults to generic_prom when LOG10X_CUSTOMER_METRICS_URL set', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://prom.internal/api/v1';
  const backend = await loadBackendFromEnv();
  assert.ok(backend);
  assert.equal(backend!.backendType, 'generic_prom');
});

test('loadBackendFromEnv accepts explicit amp type when AWS_REGION set', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-abc';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'amp';
  process.env.AWS_REGION = 'us-east-1';
  const backend = await loadBackendFromEnv();
  assert.ok(backend);
  assert.equal(backend!.backendType, 'amp');
});

test('loadBackendFromEnv rejects explicit amp without AWS_REGION', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-abc';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'amp';
  await assert.rejects(() => loadBackendFromEnv(), /AWS_REGION/);
});

test('loadBackendFromEnv accepts explicit datadog_prom with both keys', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://api.datadoghq.eu';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'datadog_prom';
  process.env.LOG10X_CUSTOMER_METRICS_AUTH = 'dd-api';
  process.env.DD_APP_KEY = 'dd-app';
  const backend = await loadBackendFromEnv();
  assert.ok(backend);
  assert.equal(backend!.backendType, 'datadog_prom');
});

test('loadBackendFromEnv rejects explicit datadog_prom without DD_APP_KEY', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://api.datadoghq.com';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'datadog_prom';
  process.env.LOG10X_CUSTOMER_METRICS_AUTH = 'dd-api';
  await assert.rejects(() => loadBackendFromEnv(), /DD_APP_KEY/);
});

test('loadBackendFromEnv rejects unknown backend type', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://example';
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'bogus';
  await assert.rejects(() => loadBackendFromEnv(), /Unknown/);
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
  assert.match(err.message, /GRAFANA_CLOUD_API_KEY/);
  assert.equal(err.name, 'CustomerMetricsNotConfiguredError');
});

test('CustomerMetricsNotConfiguredError appends detection trace', () => {
  const err = new CustomerMetricsNotConfiguredError('  - explicit_env: skipped — not set\n  - grafana_cloud: skipped — no key');
  assert.match(err.message, /Detection trace/);
  assert.match(err.message, /explicit_env/);
});
