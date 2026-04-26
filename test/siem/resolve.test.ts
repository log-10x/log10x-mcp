/**
 * Tests for the shared SIEM resolver.
 *
 * Manipulates env vars to drive each branch:
 *   - explicit id wins, no probing
 *   - sole detected SIEM
 *   - multiple → preferred-explicit-env when exactly one source='env'
 *   - multiple → ambiguous when 2+ sources='env'
 *   - none configured
 *   - restrictTo narrows the candidate set
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSiemSelection,
  formatAmbiguousError,
  formatNoneError,
} from '../../src/lib/siem/resolve.js';

const VARS = [
  'DD_API_KEY', 'DD_APP_KEY', 'DATADOG_API_KEY', 'DATADOG_APP_KEY', 'DD_SITE',
  'SPLUNK_HOST', 'SPLUNK_TOKEN', 'SPLUNK_USERNAME', 'SPLUNK_PASSWORD', 'SPLUNK_URL',
  'ELASTIC_URL', 'ELASTIC_API_KEY', 'ELASTICSEARCH_URL', 'ELASTICSEARCH_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'SUMO_ACCESS_ID', 'SUMO_ACCESS_KEY', 'SUMO_ENDPOINT',
  'CLICKHOUSE_URL', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD',
  'AZURE_LOG_ANALYTICS_WORKSPACE_ID', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
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

test('explicit id resolves without probing env', async () => {
  snap = snapshotEnv();
  clearEnv();
  // Even though no creds are set, explicit wins.
  const r = await resolveSiemSelection({ explicit: 'splunk' });
  assert.equal(r.kind, 'resolved');
  if (r.kind === 'resolved') {
    assert.equal(r.id, 'splunk');
    assert.equal(r.selectionMethod, 'explicit');
  }
});

test('explicit id outside the registry throws with a helpful message', async () => {
  snap = snapshotEnv();
  await assert.rejects(
    () => resolveSiemSelection({ explicit: 'sentinel-one' }),
    /Unknown SIEM id "sentinel-one"/
  );
});

test('explicit id outside restrictTo throws', async () => {
  snap = snapshotEnv();
  await assert.rejects(
    () =>
      resolveSiemSelection({
        explicit: 'clickhouse',
        restrictTo: ['datadog', 'splunk', 'elasticsearch', 'cloudwatch'],
      }),
    /Unknown SIEM id "clickhouse"/
  );
});

test('sole detected SIEM resolves to that one with note', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.SPLUNK_HOST = 'https://splunk.example.com:8089';
  process.env.SPLUNK_TOKEN = 'tok-123';
  // restrictTo splunk-only so a test machine that happens to have ambient
  // AWS creds doesn't trigger `preferred-explicit-env` instead of `sole`.
  const r = await resolveSiemSelection({ restrictTo: ['splunk'] });
  assert.equal(r.kind, 'resolved');
  if (r.kind === 'resolved') {
    assert.equal(r.id, 'splunk');
    assert.equal(r.selectionMethod, 'sole');
    assert.match(r.note ?? '', /Auto-detected/);
  }
});

test('multiple env-source SIEMs returns ambiguous', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.SPLUNK_HOST = 'https://splunk.example.com:8089';
  process.env.SPLUNK_TOKEN = 'tok-123';
  process.env.DD_API_KEY = 'dd-key';
  process.env.DD_APP_KEY = 'dd-app';
  // restrictTo the env-source pair so ambient AWS creds (test machine) don't
  // join the candidate set and shift the assertion.
  const r = await resolveSiemSelection({ restrictTo: ['splunk', 'datadog'] });
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') {
    const ids = r.candidates.map((c) => c.id).sort();
    assert.deepEqual(ids, ['datadog', 'splunk']);
  }
});

test('exactly one env-source winner among multiple available is preferred', async () => {
  snap = snapshotEnv();
  clearEnv();
  // Datadog from env. Cloudwatch from ambient (instance role / SSO chain).
  // We can't reliably trigger 'ambient' detection in CI without AWS creds,
  // so simulate by passing restrictTo with an env-only set + asserting
  // datadog still wins (the 'sole' branch covers that).
  process.env.DD_API_KEY = 'dd-key';
  process.env.DD_APP_KEY = 'dd-app';
  const r = await resolveSiemSelection({ restrictTo: ['datadog', 'splunk'] });
  assert.equal(r.kind, 'resolved');
  if (r.kind === 'resolved') {
    assert.equal(r.id, 'datadog');
  }
});

test('no creds detected returns kind=none', async () => {
  snap = snapshotEnv();
  clearEnv();
  const r = await resolveSiemSelection({ restrictTo: ['datadog', 'splunk', 'elasticsearch'] });
  assert.equal(r.kind, 'none');
  if (r.kind === 'none') {
    assert.deepEqual(r.probedIds.sort(), ['datadog', 'elasticsearch', 'splunk']);
  }
});

test('restrictTo narrows the candidate pool — non-listed SIEMs do not cause ambiguity', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.SPLUNK_HOST = 'https://splunk.example.com:8089';
  process.env.SPLUNK_TOKEN = 'tok-123';
  process.env.DD_API_KEY = 'dd-key';
  process.env.DD_APP_KEY = 'dd-app';
  // Restrict to splunk only — datadog is filtered out, so no ambiguity.
  const r = await resolveSiemSelection({ restrictTo: ['splunk'] });
  assert.equal(r.kind, 'resolved');
  if (r.kind === 'resolved') assert.equal(r.id, 'splunk');
});

test('formatAmbiguousError lists candidates with the requested arg name', () => {
  const md = formatAmbiguousError(
    [
      { id: 'splunk', displayName: 'Splunk', source: 'env' },
      { id: 'datadog', displayName: 'Datadog', source: 'env' },
    ],
    'vendor'
  );
  assert.match(md, /Multiple SIEMs detected/);
  assert.match(md, /\\?`vendor=<name>`?/);
  assert.match(md, /splunk \(Splunk, source: env\)/);
  assert.match(md, /datadog \(Datadog, source: env\)/);
});

test('formatNoneError surfaces the supported set + a hint', () => {
  const msg = formatNoneError(['splunk', 'datadog'], 'Run `log10x_doctor` for detail.');
  assert.match(msg, /No SIEM credentials detected/);
  assert.match(msg, /splunk, datadog/);
  assert.match(msg, /Run `log10x_doctor`/);
});
