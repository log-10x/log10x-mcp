/**
 * Tests for the read-only dep-check rendering + helpers.
 *
 * The actual API calls (Splunk REST, Datadog SDK, CloudWatch SDK, Kibana
 * saved-objects) require live SIEMs and are exercised under
 * `npm run test:integration` only. The unit tests here cover:
 *   - the substring-token match logic
 *   - meaningful-token fallback when no tokens >= 4 chars
 *   - markdown rendering of zero-match, multi-match, error-fallback
 *   - the dep-check tool's vendor-resolution branches via env var setup
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  anyTokenMatches,
  meaningfulTokens,
  emptyResult,
  type DepCheckResult,
} from '../../src/lib/siem/deps/types.js';
import { renderDepCheckResult } from '../../src/lib/siem/deps/index.js';
import { executeDependencyCheck } from '../../src/tools/dependency-check.js';

const VARS = [
  'DD_API_KEY', 'DD_APP_KEY',
  'SPLUNK_HOST', 'SPLUNK_TOKEN',
  'ELASTIC_URL', 'ELASTIC_API_KEY', 'KIBANA_URL', 'KIBANA_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'AWS_REGION',
];
function snapshotEnv(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of VARS) s[k] = process.env[k];
  return s;
}
function restoreEnv(s: Record<string, string | undefined>): void {
  for (const k of VARS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}
function clearEnv(): void {
  for (const k of VARS) delete process.env[k];
}
// Snapshot at module load so tests that don't manipulate env (pure unit
// tests below) still get a defined `snap` for the afterEach restore. Tests
// that DO manipulate env reassign `snap` themselves before clearing.
let snap: Record<string, string | undefined> = snapshotEnv();
afterEach(() => restoreEnv(snap));

test('anyTokenMatches is case-insensitive substring OR', () => {
  assert.equal(anyTokenMatches('Payment Gateway Timeout', ['payment']), true);
  assert.equal(anyTokenMatches('Payment Gateway Timeout', ['PAYMENT']), true);
  assert.equal(anyTokenMatches('Payment Gateway Timeout', ['Payment', 'foo']), true);
  assert.equal(anyTokenMatches('Heartbeat', ['payment', 'gateway']), false);
  assert.equal(anyTokenMatches('', ['x']), false);
});

test('meaningfulTokens prefers tokens >= 4 chars; falls back to pattern-as-phrase', () => {
  assert.deepEqual(meaningfulTokens('a_b_payment', ['a', 'b', 'payment']), ['payment']);
  // All tokens <4 chars → fallback to the pattern with underscores → spaces.
  assert.deepEqual(meaningfulTokens('a_b_c', ['a', 'b', 'c']), ['a b c']);
});

test('renderDepCheckResult: zero matches reports 0 dependencies', () => {
  const r = emptyResult('splunk', 'payment_gateway_timeout');
  const md = renderDepCheckResult(r);
  assert.match(md, /Dependency Check — Splunk \(executed\)/);
  assert.match(md, /Scan complete: 0 dependencies/);
  assert.match(md, /payment_gateway_timeout/);
});

test('renderDepCheckResult: multi-match emits a table with type/name/matchedIn/link', () => {
  const r: DepCheckResult = {
    vendor: 'splunk',
    scannedAt: new Date().toISOString(),
    pattern: 'payment_gateway_timeout',
    matches: [
      { type: 'alert', name: 'Payment timeout > 5 in 5min', url: 'https://splunk.example.com/alert/1', matchedIn: ['name'] },
      { type: 'dashboard', name: 'Payments overview', url: 'https://splunk.example.com/dash/2', matchedIn: ['definition'] },
    ],
    byType: { dashboards: 1, alerts: 1, savedSearches: 0, monitors: 0, metricFilters: 0 },
    notes: ['saved/searches partial — pagination capped'],
  };
  const md = renderDepCheckResult(r);
  assert.match(md, /Found \*\*2\*\* dependencies/);
  assert.match(md, /1 dashboard/);
  assert.match(md, /1 alert/);
  assert.match(md, /\| alert \| Payment timeout > 5 in 5min \| name \| \[open\]\(https:\/\/splunk\.example\.com\/alert\/1\) \|/);
  assert.match(md, /Scan notes:/);
  assert.match(md, /pagination capped/);
});

test('dependency_check: no creds + no vendor → returns "vendor required" message', async (t) => {
  snap = snapshotEnv();
  clearEnv();
  // The CloudWatch connector falls back to the AWS credential provider chain
  // (~/.aws/credentials, SSO cache, instance metadata, etc.) for ambient
  // detection. On a developer machine that's logged into AWS, the chain
  // resolves and CW becomes available — the resolver picks it and the scan
  // executes against the real account. Skip the test in that case so it
  // remains valid in CI (no ambient AWS) and on dev boxes.
  const { cloudwatchConnector } = await import('../../src/lib/siem/cloudwatch.js');
  const cw = await cloudwatchConnector.discoverCredentials();
  if (cw.available) {
    t.skip('ambient AWS credentials detected — "no creds" path cannot be exercised here');
    return;
  }
  const out = await executeDependencyCheck({ pattern: 'Payment_Gateway_Timeout' });
  assert.match(out, /vendor required/);
  assert.match(out, /datadog, splunk, elasticsearch, cloudwatch/);
});

test('dependency_check: explicit vendor with no creds → bash fallback', async () => {
  snap = snapshotEnv();
  clearEnv();
  const out = await executeDependencyCheck({
    pattern: 'Payment_Gateway_Timeout',
    vendor: 'splunk',
  });
  assert.match(out, /paste-ready/);
  assert.match(out, /siem-check-splunk\.py/);
  assert.match(out, /SPLUNK_TOKEN/);
});

test('dependency_check: multiple SIEMs detected → ambiguous error', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.SPLUNK_HOST = 'https://splunk.example.com:8089';
  process.env.SPLUNK_TOKEN = 'tok';
  process.env.DD_API_KEY = 'k';
  process.env.DD_APP_KEY = 'a';
  const out = await executeDependencyCheck({ pattern: 'Payment_Gateway_Timeout' });
  assert.match(out, /Multiple SIEMs detected/);
  assert.match(out, /splunk/);
  assert.match(out, /datadog/);
  assert.match(out, /Pass `vendor=/);
});

test('dependency_check: ES detected but no Kibana → falls back to bash with explanation', async () => {
  snap = snapshotEnv();
  clearEnv();
  process.env.ELASTIC_URL = 'https://es.example.com:9200';
  process.env.ELASTIC_API_KEY = 'ek';
  // No KIBANA_URL — dep-check should fall back.
  const out = await executeDependencyCheck({
    pattern: 'Payment_Gateway_Timeout',
    vendor: 'elasticsearch',
  });
  assert.match(out, /paste-ready/);
  assert.match(out, /Kibana/);
  assert.match(out, /siem-check-elasticsearch\.py/);
});
