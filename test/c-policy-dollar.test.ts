/**
 * C-policy: dollars grounded in truth.
 *
 * Lead with volume (GB / %, always exact); present a dollar only when it is
 * grounded in the customer's real (contracted) rate. When the dollar came from
 * the SIEM vendor LIST rate, the chassis attaches a calibration callout so no
 * envelope ever quotes a list-price dollar as the customer's real number.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundedDollar } from '../src/lib/format.js';
import { buildChassisEnvelope } from '../src/lib/chassis-envelope.js';

// ─── groundedDollar primitive ────────────────────────────────────────

test('groundedDollar: shows the dollar only for a real rate (customer_supplied / snapshot)', () => {
  assert.equal(groundedDollar(1234, 'customer_supplied'), '$1.2K');
  assert.equal(groundedDollar(1234, 'snapshot'), '$1.2K');
  assert.equal(groundedDollar(1234, 'list_price'), null);
  assert.equal(groundedDollar(1234, 'none'), null);
  assert.equal(groundedDollar(1234, undefined), null);
});

// ─── chassis list-price callout ──────────────────────────────────────

function envelope(rate_source: 'customer_supplied' | 'list_price' | 'none') {
  return buildChassisEnvelope({
    tool: 'log10x_top_patterns',
    view: 'summary',
    headline: '168 GB/mo, 30% above floor.',
    status: 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: { bytes_source: 'tsdb', rate_source, siem_vendor: 'splunk' },
    scope: { window: '1h', window_basis: 'explicit' },
    payload: {},
    human_summary: 'volume-led summary',
    actions: [],
    warnings: [],
  });
}

test('chassis: a list_price rate_source attaches a list-rate calibration callout', () => {
  const json = JSON.stringify(envelope('list_price'));
  assert.ok(/list rate/i.test(json), 'expected a list-rate callout in the envelope');
  assert.ok(/effective_ingest_per_gb/.test(json), 'expected the set-your-rate hint');
});

test('chassis: a customer_supplied rate_source attaches NO list-rate callout', () => {
  const json = JSON.stringify(envelope('customer_supplied'));
  assert.ok(!/list rate/i.test(json), 'a grounded (customer) rate must not carry the list-rate callout');
});

test('chassis: rate_source=none (no dollars) attaches NO list-rate callout', () => {
  const json = JSON.stringify(envelope('none'));
  assert.ok(!/list rate/i.test(json));
});
