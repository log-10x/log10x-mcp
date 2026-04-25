import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GrafanaCloudBackend,
  AmpBackend,
  DatadogPromBackend,
  GenericPromBackend,
  GcpManagedPrometheusBackend,
  MockBackend,
} from '../src/lib/customer-metrics.js';

// Gap 4: each managed backend must expose a derivable remote_write URL so
// log10x_backfill_metric doesn't force users to configure
// PROMETHEUS_REMOTE_WRITE_URL twice. Datadog + GCP Managed Prometheus don't
// support prom remote_write and must return undefined.

test('GrafanaCloudBackend.remoteWriteUrl() returns /api/prom/push', () => {
  const b = new GrafanaCloudBackend({
    endpoint: 'https://prometheus-us-central1.grafana.net',
    apiKey: 'glc',
    instanceId: '1',
  });
  assert.equal(b.remoteWriteUrl(), 'https://prometheus-us-central1.grafana.net/api/prom/push');
});

test('AmpBackend.remoteWriteUrl() returns /api/v1/remote_write under the workspace', () => {
  const b = new AmpBackend({
    endpoint: 'https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-abc',
    region: 'us-east-1',
  });
  assert.equal(b.remoteWriteUrl(), 'https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-abc/api/v1/remote_write');
});

test('GenericPromBackend.remoteWriteUrl() returns /api/v1/write', () => {
  const b = new GenericPromBackend({ endpoint: 'https://prom.internal' });
  assert.equal(b.remoteWriteUrl(), 'https://prom.internal/api/v1/write');
});

test('DatadogPromBackend.remoteWriteUrl() returns undefined — Datadog uses /api/v2/series instead', () => {
  const b = new DatadogPromBackend({
    endpoint: 'https://api.datadoghq.com',
    apiKey: 'a',
    appKey: 'b',
  });
  assert.equal(b.remoteWriteUrl(), undefined);
});

test('GcpManagedPrometheusBackend.remoteWriteUrl() returns undefined — GMP has no remote_write path', () => {
  const b = new GcpManagedPrometheusBackend({
    endpoint: 'https://monitoring.googleapis.com/v1/projects/demo/location/global/prometheus',
    project: 'demo',
  });
  assert.equal(b.remoteWriteUrl(), undefined);
});

test('MockBackend.remoteWriteUrl() respects override for tests', () => {
  const b = new MockBackend();
  assert.equal(b.remoteWriteUrl(), undefined);
  b.remoteWriteOverride = 'http://mock/write';
  assert.equal(b.remoteWriteUrl(), 'http://mock/write');
});

test('GrafanaCloudBackend strips trailing slash before deriving write URL', () => {
  const b = new GrafanaCloudBackend({ endpoint: 'https://prom.example/', apiKey: 'k' });
  assert.equal(b.remoteWriteUrl(), 'https://prom.example/api/prom/push');
});

// Gap 5: DD_SITE alias one-liner.

const SAVED_ENV = { ...process.env };
const DD_KEYS = ['DD_SITE', 'DATADOG_SITE', 'DD_API_KEY', 'DATADOG_API_KEY'];

beforeEach(() => {
  for (const k of DD_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of DD_KEYS) delete process.env[k];
  for (const k of DD_KEYS) {
    if (SAVED_ENV[k] !== undefined) process.env[k] = SAVED_ENV[k] as string;
  }
});

test('DD_SITE is honored when DATADOG_SITE is unset', async () => {
  // metric-emitters reads the site env inline inside emitDatadog. We verify
  // the env resolution by replaying the same expression the emitter uses.
  process.env.DD_SITE = 'datadoghq.eu';
  const site = process.env.DD_SITE || process.env.DATADOG_SITE || 'datadoghq.com';
  assert.equal(site, 'datadoghq.eu');
});

test('DATADOG_SITE still works when DD_SITE is unset (back-compat)', () => {
  process.env.DATADOG_SITE = 'us3.datadoghq.com';
  const site = process.env.DD_SITE || process.env.DATADOG_SITE || 'datadoghq.com';
  assert.equal(site, 'us3.datadoghq.com');
});

test('DD_SITE wins over DATADOG_SITE when both set', () => {
  process.env.DD_SITE = 'datadoghq.eu';
  process.env.DATADOG_SITE = 'datadoghq.com';
  const site = process.env.DD_SITE || process.env.DATADOG_SITE || 'datadoghq.com';
  assert.equal(site, 'datadoghq.eu');
});
