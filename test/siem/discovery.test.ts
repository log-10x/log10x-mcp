/**
 * Per-connector credential discovery tests.
 *
 * Each test manipulates the relevant env vars, calls discoverCredentials(),
 * and asserts available + source. We restore env state after each test.
 *
 * pullEvents() is NOT tested against the real SIEM — the SDKs are widely
 * trusted and the CI has no creds. What matters is that credential
 * detection doesn't false-positive or false-negative.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { datadogConnector } from '../../src/lib/siem/datadog.js';
import { sumoConnector } from '../../src/lib/siem/sumo.js';
import { elasticsearchConnector } from '../../src/lib/siem/elasticsearch.js';
import { splunkConnector } from '../../src/lib/siem/splunk.js';
import { clickhouseConnector } from '../../src/lib/siem/clickhouse.js';
import { azureMonitorConnector } from '../../src/lib/siem/azure-monitor.js';
import { detectSchema } from '../../src/lib/siem/clickhouse.js';

const VARS = [
  'DD_API_KEY', 'DD_APP_KEY', 'DATADOG_API_KEY', 'DATADOG_APP_KEY', 'DD_SITE',
  'SUMO_ACCESS_ID', 'SUMO_ACCESS_KEY', 'SUMO_ENDPOINT',
  'ELASTIC_URL', 'ELASTIC_API_KEY', 'ELASTIC_USERNAME', 'ELASTIC_PASSWORD',
  'ELASTICSEARCH_URL', 'ELASTICSEARCH_API_KEY',
  'SPLUNK_HOST', 'SPLUNK_TOKEN', 'SPLUNK_USERNAME', 'SPLUNK_PASSWORD',
  'CLICKHOUSE_URL', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD', 'CLICKHOUSE_API_KEY', 'CLICKHOUSE_DATABASE',
  'AZURE_LOG_ANALYTICS_WORKSPACE_ID', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET',
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of VARS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of VARS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}
function clearEnv(): void {
  for (const k of VARS) delete process.env[k];
}

let snap: Record<string, string | undefined>;
afterEach(() => restoreEnv(snap));

// ── Datadog ──

test('datadog detects when DD_API_KEY + DD_APP_KEY set', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.DD_API_KEY = 'aaaa-bbbb-cccc-dddd';
  process.env.DD_APP_KEY = 'xxxx-yyyy-zzzz-wwww';
  const d = await datadogConnector.discoverCredentials();
  assert.equal(d.available, true);
  assert.equal(d.source, 'env');
  assert.ok((d.details as Record<string, string>).api_key_masked.startsWith('aaaa'));
});

test('datadog detects via DATADOG_API_KEY variant', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.DATADOG_API_KEY = 'k1';
  process.env.DATADOG_APP_KEY = 'a1';
  const d = await datadogConnector.discoverCredentials();
  assert.equal(d.available, true);
});

test('datadog reports not-configured when only one key set', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.DD_API_KEY = 'only';
  const d = await datadogConnector.discoverCredentials();
  assert.equal(d.available, false);
  assert.equal(d.source, 'none');
});

// ── Sumo ──

test('sumo detects with all three vars set', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.SUMO_ACCESS_ID = 'sumo_id_aaaa';
  process.env.SUMO_ACCESS_KEY = 'sumo_key_bbbb';
  process.env.SUMO_ENDPOINT = 'https://api.us2.sumologic.com';
  const d = await sumoConnector.discoverCredentials();
  assert.equal(d.available, true);
  assert.equal(d.source, 'env');
});

test('sumo not-configured when any var missing', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.SUMO_ACCESS_ID = 'id';
  process.env.SUMO_ACCESS_KEY = 'key';
  // endpoint missing
  const d = await sumoConnector.discoverCredentials();
  assert.equal(d.available, false);
});

// ── Elasticsearch ──

test('elasticsearch detects with url + api key', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.ELASTIC_URL = 'https://es.example.com:9243';
  process.env.ELASTIC_API_KEY = 'apikey';
  const d = await elasticsearchConnector.discoverCredentials();
  assert.equal(d.available, true);
  assert.equal((d.details as Record<string, string>).auth, 'api_key');
});

test('elasticsearch detects with url + basic creds', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.ELASTIC_URL = 'https://es.example.com:9243';
  process.env.ELASTIC_USERNAME = 'elastic';
  process.env.ELASTIC_PASSWORD = 'changeme';
  const d = await elasticsearchConnector.discoverCredentials();
  assert.equal(d.available, true);
  assert.equal((d.details as Record<string, string>).auth, 'basic');
});

test('elasticsearch not-configured without URL', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.ELASTIC_API_KEY = 'x';
  const d = await elasticsearchConnector.discoverCredentials();
  assert.equal(d.available, false);
});

test('elasticsearch accepts URL-only (xpack.security.enabled=false dev cluster)', async () => {
  // Regression test for the bug caught during E2E against a local ES 9.1
  // container with security disabled. Before the fix the connector
  // required ELASTIC_API_KEY or ELASTIC_USERNAME+ELASTIC_PASSWORD.
  snap = snapshotEnv();
  clearEnv();
  process.env.ELASTIC_URL = 'http://localhost:9200';
  const d = await elasticsearchConnector.discoverCredentials();
  assert.equal(d.available, true);
  assert.equal((d.details as Record<string, string>).auth, 'none');
});

// ── Splunk ──

test('splunk detects with host + token', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.SPLUNK_HOST = 'https://splunk.example.com';
  process.env.SPLUNK_TOKEN = 'bearer-token-xyz';
  const d = await splunkConnector.discoverCredentials();
  assert.equal(d.available, true);
  assert.equal(d.source, 'env');
  assert.equal((d.details as Record<string, string>).auth, 'bearer_token');
});

test('splunk detects with host + username + password (env vars)', async () => {
  // Regression test for the gap caught during E2E: SPLUNK_USERNAME +
  // SPLUNK_PASSWORD were not read as env vars (only SPLUNK_TOKEN or
  // ~/.splunkrc were). Dockerized Splunk installs use admin/password auth.
  snap = snapshotEnv();
  clearEnv();
  process.env.SPLUNK_HOST = 'https://localhost:8089';
  process.env.SPLUNK_USERNAME = 'admin';
  process.env.SPLUNK_PASSWORD = 'pw';
  const d = await splunkConnector.discoverCredentials();
  assert.equal(d.available, true);
  assert.equal(d.source, 'env');
  assert.equal((d.details as Record<string, string>).auth, 'basic');
});

test('splunk not-configured without token', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.SPLUNK_HOST = 'https://splunk.example.com';
  const d = await splunkConnector.discoverCredentials();
  assert.equal(d.available, false);
});

// ── ClickHouse ──

test('clickhouse detects with url + api key', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.CLICKHOUSE_URL = 'https://clickhouse.example.com:8443';
  process.env.CLICKHOUSE_API_KEY = 'api-xxx';
  const d = await clickhouseConnector.discoverCredentials();
  assert.equal(d.available, true);
});

test('clickhouse detects with url + basic creds', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.CLICKHOUSE_URL = 'https://clickhouse.example.com:8443';
  process.env.CLICKHOUSE_USER = 'default';
  process.env.CLICKHOUSE_PASSWORD = 'pw';
  const d = await clickhouseConnector.discoverCredentials();
  assert.equal(d.available, true);
});

test('clickhouse not-configured when password missing', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.CLICKHOUSE_URL = 'https://clickhouse.example.com:8443';
  process.env.CLICKHOUSE_USER = 'default';
  const d = await clickhouseConnector.discoverCredentials();
  assert.equal(d.available, false);
});

test('clickhouse detectSchema identifies OpenObserve', async () => {
  const s = await detectSchema(['_timestamp', 'log', 'stream', 'level']);
  assert.equal(s.kind, 'openobserve');
  if (s.kind === 'openobserve') {
    assert.equal(s.mapping.timestamp, '_timestamp');
    assert.equal(s.mapping.message, 'log');
  }
});

test('clickhouse detectSchema identifies SigNoz', async () => {
  const s = await detectSchema([
    'timestamp',
    'body',
    'severity_text',
    'resources_string_key',
    'resources_string_value',
  ]);
  assert.equal(s.kind, 'signoz');
});

test('clickhouse detectSchema honors explicit override', async () => {
  const s = await detectSchema(['ts', 'msg'], {
    timestampColumn: 'ts',
    messageColumn: 'msg',
  });
  assert.equal(s.kind, 'custom');
  if (s.kind === 'custom') {
    assert.equal(s.mapping.timestamp, 'ts');
    assert.equal(s.mapping.message, 'msg');
  }
});

test('clickhouse detectSchema returns unknown for unrecognized columns', async () => {
  const s = await detectSchema(['foo', 'bar', 'baz']);
  assert.equal(s.kind, 'unknown');
});

// ── Azure ──

test('azure detects with workspace + service principal env', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.AZURE_LOG_ANALYTICS_WORKSPACE_ID = 'ws-xyz';
  process.env.AZURE_CLIENT_ID = 'cid';
  process.env.AZURE_TENANT_ID = 'tid';
  process.env.AZURE_CLIENT_SECRET = 'sec';
  const d = await azureMonitorConnector.discoverCredentials();
  assert.equal(d.available, true);
  assert.equal(d.source, 'env');
});

test('azure not-configured without workspace id', async () => {
  snap = snapshotEnv();
  clearEnv();
  const d = await azureMonitorConnector.discoverCredentials();
  assert.equal(d.available, false);
});
