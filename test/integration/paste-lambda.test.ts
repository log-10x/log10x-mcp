import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitPaste } from '../../src/lib/paste-api.js';
import { parseTemplates, parseEncoded, parseAggregated } from '../../src/lib/cli-output-parser.js';

// Integration tests hit the real Log10x paste Lambda.
// Skipped unless LOG10X_INTEGRATION_TESTS=1 so CI doesn't call production endpoints.
const enabled = process.env.LOG10X_INTEGRATION_TESTS === '1';

test('paste Lambda round-trip: submit 3 events, receive templates/encoded/aggregated', { skip: !enabled }, async () => {
  const text = [
    '2026-04-13T08:12:01Z INFO checkout-svc tenant=acme order=12345 status=success latency_ms=45',
    '2026-04-13T08:12:03Z ERROR checkout-svc tenant=acme order=12347 status=failed reason=gateway_timeout',
    '2026-04-13T08:12:05Z INFO checkout-svc tenant=foo order=12348 status=success latency_ms=52',
  ].join('\n');

  const resp = await submitPaste(text);
  assert.ok(resp['templates.json'], 'expected templates.json in response');
  assert.ok(resp['encoded.log'], 'expected encoded.log in response');
  assert.ok(resp['aggregated.csv'], 'expected aggregated.csv in response');

  const templates = parseTemplates(resp['templates.json']);
  const encoded = parseEncoded(resp['encoded.log']);
  const aggregated = parseAggregated(resp['aggregated.csv']);

  // 3 distinct patterns (one INFO with tenant=acme, one ERROR, one INFO with tenant=foo — or
  // the templater may collapse the two INFO variants into one). Assert the shape, not the count.
  assert.ok(templates.size >= 1, `expected ≥1 templates, got ${templates.size}`);
  assert.equal(encoded.length, 3, 'expected 3 encoded lines for 3 input events');
  assert.ok(aggregated.length >= 1, `expected ≥1 aggregated rows, got ${aggregated.length}`);

  // Every encoded event's hash must exist in the templates map (no orphans).
  for (const e of encoded) {
    assert.ok(templates.has(e.templateHash), `encoded hash ${e.templateHash} not found in templates map`);
  }

  // Every aggregated row must have a severity matching one of the input severities.
  for (const row of aggregated) {
    assert.ok(
      ['INFO', 'ERROR'].includes(row.severity || ''),
      `unexpected severity in aggregated row: ${row.severity}`
    );
  }
});

test('paste Lambda rejects oversized batches', { skip: !enabled }, async () => {
  const oversized = 'x'.repeat(200 * 1024); // 200 KB > 100 KB limit
  await assert.rejects(() => submitPaste(oversized), /too large|100 KB/);
});
