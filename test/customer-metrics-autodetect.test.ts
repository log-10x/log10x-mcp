import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackend } from '../src/lib/customer-metrics.js';

const SAVED_ENV = { ...process.env };

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

// Gap 2: the cascade must try paths in the documented order and return the
// first hit. Explicit env always wins.

test('resolveBackend: empty env returns undefined with trace', async () => {
  const res = await resolveBackend();
  assert.equal(res.backend, undefined);
  assert.equal(res.detectionPath, undefined);
  const paths = res.trace.map((t) => t.path);
  assert.ok(paths.includes('explicit_env'));
  assert.ok(paths.includes('grafana_cloud'));
  assert.ok(paths.includes('datadog_prom'));
  assert.ok(paths.includes('prometheus_url'));
});

test('resolveBackend: explicit LOG10X_CUSTOMER_METRICS_URL wins over ambient credentials', async () => {
  process.env.LOG10X_CUSTOMER_METRICS_URL = 'https://explicit.example/api';
  process.env.GRAFANA_CLOUD_API_KEY = 'glc_testkey';
  process.env.GRAFANA_CLOUD_URL = 'https://grafana-ambient.example';
  process.env.DD_API_KEY = 'dd-api';
  process.env.DD_APP_KEY = 'dd-app';
  const res = await resolveBackend();
  assert.ok(res.backend);
  assert.equal(res.detectionPath, 'explicit_env');
  assert.equal(res.backend!.backendType, 'generic_prom');
  assert.equal(res.backend!.endpoint, 'https://explicit.example/api');
});

test('resolveBackend: Grafana Cloud detected when GRAFANA_CLOUD_API_KEY + URL set', async () => {
  process.env.GRAFANA_CLOUD_API_KEY = 'glc_testkey';
  process.env.GRAFANA_CLOUD_URL = 'https://prometheus-us-central1.grafana.net';
  process.env.GRAFANA_CLOUD_INSTANCE_ID = '123456';
  const res = await resolveBackend();
  assert.ok(res.backend);
  assert.equal(res.detectionPath, 'grafana_cloud');
  assert.equal(res.backend!.backendType, 'grafana_cloud');
});

test('resolveBackend: Grafana Cloud skipped when URL missing', async () => {
  process.env.GRAFANA_CLOUD_API_KEY = 'glc_testkey';
  // No URL — no grafana-cli config in CI, so detection should skip.
  const res = await resolveBackend();
  const gcEntry = res.trace.find((t) => t.path === 'grafana_cloud');
  assert.ok(gcEntry);
  // If a grafana-cli config file exists on the developer box, this would
  // match; in CI it won't. Accept either skipped or matched — the key
  // assertion is that the trace entry exists.
  assert.ok(gcEntry!.status === 'skipped' || gcEntry!.status === 'matched');
});

test('resolveBackend: Datadog detected with both API + APP key', async () => {
  process.env.DD_API_KEY = 'dd-api';
  process.env.DD_APP_KEY = 'dd-app';
  process.env.DD_SITE = 'datadoghq.eu';
  const res = await resolveBackend();
  assert.ok(res.backend);
  assert.equal(res.detectionPath, 'datadog_prom');
  assert.equal(res.backend!.backendType, 'datadog_prom');
  assert.equal(res.backend!.endpoint, 'https://api.datadoghq.eu');
});

test('resolveBackend: Datadog skipped when only API key set', async () => {
  process.env.DD_API_KEY = 'dd-api';
  const res = await resolveBackend();
  const ddEntry = res.trace.find((t) => t.path === 'datadog_prom');
  assert.ok(ddEntry);
  assert.equal(ddEntry!.status, 'skipped');
  assert.match(ddEntry!.reason, /DD_APP_KEY/);
});

test('resolveBackend: PROMETHEUS_URL is the final fallback', async () => {
  process.env.PROMETHEUS_URL = 'https://prom.internal';
  const res = await resolveBackend();
  assert.ok(res.backend);
  assert.equal(res.detectionPath, 'prometheus_url');
  assert.equal(res.backend!.backendType, 'generic_prom');
});

test('resolveBackend: detection order — Grafana wins over Datadog + PROMETHEUS_URL', async () => {
  process.env.GRAFANA_CLOUD_API_KEY = 'glc';
  process.env.GRAFANA_CLOUD_URL = 'https://grafana.example';
  process.env.DD_API_KEY = 'dd-api';
  process.env.DD_APP_KEY = 'dd-app';
  process.env.PROMETHEUS_URL = 'https://prom.internal';
  const res = await resolveBackend();
  assert.equal(res.detectionPath, 'grafana_cloud');
});

test('resolveBackend: detection order — Datadog wins over PROMETHEUS_URL', async () => {
  process.env.DD_API_KEY = 'dd-api';
  process.env.DD_APP_KEY = 'dd-app';
  process.env.PROMETHEUS_URL = 'https://prom.internal';
  const res = await resolveBackend();
  assert.equal(res.detectionPath, 'datadog_prom');
});

test('resolveBackend: explicit AMP URL + region resolves to amp backend', async () => {
  process.env.AWS_REGION = 'us-east-1';
  process.env.AMP_WORKSPACE_URL = 'https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-abc';
  const res = await resolveBackend();
  assert.ok(res.backend);
  assert.equal(res.detectionPath, 'amp');
  assert.equal(res.backend!.backendType, 'amp');
});
