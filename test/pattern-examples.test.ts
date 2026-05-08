/**
 * Unit tests for pattern_examples pure helpers.
 *
 * The full tool requires a live SIEM and tenx CLI; those paths are
 * covered by integration tests under `test/integration/` (when run with
 * LOG10X_INTEGRATION_TESTS=1). The tests here cover the pure functions:
 *
 *   - buildVendorQuery: per-vendor query string construction
 *   - contentTokens: JSON envelope strip + alphanumeric tokenization
 *   - jaccardSimilarity: pure Jaccard math
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { __testables } from '../src/tools/pattern-examples.js';

const { buildVendorQuery, contentTokens, jaccardSimilarity } = __testables;

// ── buildVendorQuery ───────────────────────────────────────────────────

test('buildVendorQuery splunk: phrases AND-joined, service/severity as fields', () => {
  const q = buildVendorQuery('splunk', ['Payment', 'Gateway', 'Timeout'], 'payments-svc', 'ERROR');
  assert.equal(q, '"Payment" "Gateway" "Timeout" tenx_user_service="payments-svc" severity_level="ERROR"');
});

test('buildVendorQuery splunk: no service / no severity', () => {
  const q = buildVendorQuery('splunk', ['Foo', 'Bar'], undefined, undefined);
  assert.equal(q, '"Foo" "Bar"');
});

test('buildVendorQuery datadog: phrases space-joined, service:/status:', () => {
  const q = buildVendorQuery('datadog', ['Payment', 'Gateway', 'Timeout'], 'payments-svc', 'ERROR');
  assert.equal(q, '"Payment" "Gateway" "Timeout" service:payments-svc status:error');
});

test('buildVendorQuery elasticsearch: bare phrases AND-joined', () => {
  // Bare phrases (no `message:` qualifier) so the query searches all
  // text fields. The earlier `message:` prefix missed `log`-field events
  // (the OTel/k8s/fluent-bit shape) — verified live and changed in the
  // dependent commit.
  const q = buildVendorQuery('elasticsearch', ['Payment', 'Gateway'], 'payments-svc', 'ERROR');
  assert.equal(q, '"Payment" AND "Gateway" AND service: "payments-svc" AND severity: "ERROR"');
});

test('buildVendorQuery elasticsearch: bare phrases without service / severity', () => {
  const q = buildVendorQuery('elasticsearch', ['Foo', 'Bar'], undefined, undefined);
  assert.equal(q, '"Foo" AND "Bar"');
});

test('buildVendorQuery cloudwatch: filter @message like /escaped/ AND', () => {
  // CloudWatch Insights uses regex; tokens get regex-escaped.
  const q = buildVendorQuery('cloudwatch', ['Payment.Gateway', 'Timeout'], undefined, undefined);
  // The . is escaped to \. inside the regex.
  assert.match(q, /@message like \/Payment\\\.Gateway\//);
  assert.match(q, /@message like \/Timeout\//);
  assert.match(q, / and /);
});

test('buildVendorQuery: tokens with embedded quotes get escaped', () => {
  const q = buildVendorQuery('splunk', ['has"quote'], undefined, undefined);
  // Embedded quote is backslash-escaped.
  assert.equal(q, '"has\\"quote"');
});

// ── contentTokens ──────────────────────────────────────────────────────

test('contentTokens: bare string tokenized on non-alphanumeric', () => {
  const tokens = contentTokens('Payment Gateway Timeout abc123');
  assert.ok(tokens.has('payment'));
  assert.ok(tokens.has('gateway'));
  assert.ok(tokens.has('timeout'));
  assert.ok(tokens.has('abc123'));
});

test('contentTokens: short tokens (< 2 chars) excluded', () => {
  const tokens = contentTokens('a Payment 5 ms');
  assert.ok(!tokens.has('a'));
  assert.ok(!tokens.has('5'));
  assert.ok(tokens.has('ms'));
  assert.ok(tokens.has('payment'));
});

test('contentTokens: JSON envelope stripped, inner log content tokenized', () => {
  const body = JSON.stringify({
    stream: 'stdout',
    log: 'Error syncing pod abc123',
    kubernetes: { container_name: 'fluentd-10x', namespace_name: 'default' },
  });
  const tokens = contentTokens(body);
  assert.ok(tokens.has('error'));
  assert.ok(tokens.has('syncing'));
  assert.ok(tokens.has('pod'));
  assert.ok(tokens.has('abc123'));
  // envelope keys should NOT be in the token set since we extracted .log
  assert.ok(!tokens.has('stream'));
  assert.ok(!tokens.has('kubernetes'));
});

test('contentTokens: malformed JSON falls back to whole-body tokenization', () => {
  const tokens = contentTokens('{ unclosed json with "Payment Gateway"');
  // Falls through — tokenizes the whole string.
  assert.ok(tokens.has('payment'));
  assert.ok(tokens.has('gateway'));
});

test('contentTokens: empty input returns empty set', () => {
  assert.equal(contentTokens('').size, 0);
});

// ── jaccardSimilarity ──────────────────────────────────────────────────

test('jaccardSimilarity: identical sets return 1', () => {
  const a = new Set(['payment', 'gateway', 'timeout']);
  const b = new Set(['payment', 'gateway', 'timeout']);
  assert.equal(jaccardSimilarity(a, b), 1);
});

test('jaccardSimilarity: disjoint sets return 0', () => {
  const a = new Set(['payment', 'gateway']);
  const b = new Set(['order', 'fulfilled']);
  assert.equal(jaccardSimilarity(a, b), 0);
});

test('jaccardSimilarity: one extra token in B drops score by 1/4 in 3-token base', () => {
  const a = new Set(['payment', 'gateway', 'timeout']);
  const b = new Set(['payment', 'gateway', 'timeout', 'extra']);
  // |intersection|=3, |union|=4 → 0.75
  assert.equal(jaccardSimilarity(a, b), 0.75);
});

test('jaccardSimilarity: array-length variation produces 1.0 (slot count change does not affect template body tokens)', () => {
  // Same template tokens — array length variation only adds more $ slots.
  const a = new Set(['payment', 'gateway', 'timeout']);
  const b = new Set(['payment', 'gateway', 'timeout']);
  assert.equal(jaccardSimilarity(a, b), 1);
});

test('jaccardSimilarity: 0.85 threshold case — 30-token template with 1 token diff', () => {
  // 29 of 30 tokens overlap → 29/30 ≈ 0.97
  const a = new Set(Array.from({ length: 30 }, (_, i) => `tok${i}`));
  const b = new Set(Array.from({ length: 30 }, (_, i) => (i === 29 ? 'extra' : `tok${i}`)));
  // |intersection|=29, |union|=31 → 29/31 ≈ 0.935
  const sim = jaccardSimilarity(a, b);
  assert.ok(sim > 0.85, `expected sim > 0.85, got ${sim}`);
});

test('jaccardSimilarity: both empty sets return 1', () => {
  assert.equal(jaccardSimilarity(new Set(), new Set()), 1);
});

test('jaccardSimilarity: one empty set returns 0', () => {
  assert.equal(jaccardSimilarity(new Set(['a']), new Set()), 0);
});
