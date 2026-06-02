/**
 * Unit tests for log10x_cost_options.
 *
 * Asserts:
 *   1. Envelope shape: 7 modes, must_render_verbatim, must_ask_user, forbidden_next_actions.
 *   2. Gating: compact gated on unsupported SIEM; tier_down gated on wrong SIEM; offload gated.
 *   3. forbidden_next_actions contains the four required tools.
 *   4. siemSupportsCompact helper returns correct values.
 *   5. executeLog10xStart routes option 1 to log10x_cost_options (not estimate_savings).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _internals,
  type CostOptionsEnvelope,
  type CostOptionItem,
} from '../src/tools/cost-options.js';
import { isStructuredOutput, StructuredOutputSchema } from '../src/lib/output-types.js';
import { executeCostOptions } from '../src/tools/cost-options.js';
import { _internals as startInternals, type CapabilitySummary } from '../src/tools/log10x-start.js';

const { buildCapabilities, buildModes, renderVerbatim, buildCostOptionsForbidden, siemSupportsCompact } = _internals;

// ── Helper: full capabilities (receiver + retriever + siem) ────────────────────

function fullCaps(): CapabilitySummary {
  return buildCapabilities({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: true,
    receiverUncertain: false,
    retrieverOk: true,
    siemDetected: 'splunk',
  });
}

function devCaps(): CapabilitySummary {
  return buildCapabilities({
    gatewayOk: false,
    reporterTier: null,
    receiverInPath: false,
    receiverUncertain: true,
    retrieverOk: false,
    siemDetected: null,
  });
}

// ── Envelope shape tests ────────────────────────────────────────────────────────

test('executeCostOptions returns a schema-valid StructuredOutput', async () => {
  const result = await executeCostOptions({});
  assert.ok(isStructuredOutput(result), 'expected a StructuredOutput envelope');
  StructuredOutputSchema.parse(result);
  assert.equal(result.tool, 'log10x_cost_options');
  assert.equal(result.view, 'summary');
  assert.ok(result.summary.headline.length > 0);
});

test('envelope.data has exactly 7 modes', async () => {
  const result = await executeCostOptions({});
  const data = result.data as CostOptionsEnvelope;
  assert.ok(Array.isArray(data.modes), 'modes must be an array');
  assert.equal(data.modes.length, 7, 'must have exactly 7 modes');
});

test('mode ids are the expected 7 values in order', async () => {
  const result = await executeCostOptions({});
  const data = result.data as CostOptionsEnvelope;
  const ids = data.modes.map((m) => m.id);
  assert.deepEqual(ids, ['drop', 'sample', 'compact', 'tier_down', 'offload', 'manual', 'pass']);
});

test('must_render_verbatim contains the header and 7 numbered entries', async () => {
  const result = await executeCostOptions({});
  const data = result.data as CostOptionsEnvelope;
  assert.match(data.must_render_verbatim, /How do you want to handle the cost/);
  for (let i = 1; i <= 7; i++) {
    assert.match(data.must_render_verbatim, new RegExp(`${i}\\.`), `entry ${i} must render`);
  }
});

test('must_ask_user has a question and 7 options', async () => {
  const result = await executeCostOptions({});
  const data = result.data as CostOptionsEnvelope;
  assert.ok(typeof data.must_ask_user.question === 'string' && data.must_ask_user.question.length > 0);
  assert.equal(data.must_ask_user.options.length, 7);
});

test('forbidden_next_actions contains the 4 required tools', async () => {
  const result = await executeCostOptions({});
  const data = result.data as CostOptionsEnvelope;
  const required = [
    'log10x_estimate_savings',
    'log10x_configure_engine',
    'log10x_pattern_mitigate',
    'log10x_manual_options',
  ];
  for (const tool of required) {
    assert.ok(
      data.forbidden_next_actions.includes(tool),
      `forbidden_next_actions must include ${tool}`
    );
  }
});

// ── Gating tests ────────────────────────────────────────────────────────────────

test('compact is applicable when SIEM is splunk and receiver is in-path', () => {
  const caps = fullCaps();
  const modes = buildModes(caps, 'splunk', {});
  const compact = modes.find((m) => m.id === 'compact')!;
  assert.equal(compact.applicable, true);
});

test('compact is gated when SIEM is datadog (no-op destination)', () => {
  const caps = buildCapabilities({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: true,
    receiverUncertain: false,
    retrieverOk: false,
    siemDetected: 'datadog',
  });
  const modes = buildModes(caps, 'datadog', {});
  const compact = modes.find((m) => m.id === 'compact')!;
  assert.equal(compact.applicable, false);
  assert.ok(compact.gated_reason && compact.gated_reason.length > 0, 'gated_reason must be set');
});

test('compact is gated when receiver not installed (dev tier)', () => {
  const caps = devCaps();
  const modes = buildModes(caps, 'splunk', {});
  const compact = modes.find((m) => m.id === 'compact')!;
  assert.equal(compact.applicable, false);
  assert.match(compact.gated_reason ?? '', /Receiver/i);
});

test('tier_down is applicable when SIEM is datadog and receiver is in-path', () => {
  const caps = buildCapabilities({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: true,
    receiverUncertain: false,
    retrieverOk: false,
    siemDetected: 'datadog',
  });
  const modes = buildModes(caps, 'datadog', {});
  const tierDown = modes.find((m) => m.id === 'tier_down')!;
  assert.equal(tierDown.applicable, true);
});

test('tier_down is gated when SIEM is splunk', () => {
  const caps = buildCapabilities({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: true,
    receiverUncertain: false,
    retrieverOk: false,
    siemDetected: 'splunk',
  });
  const modes = buildModes(caps, 'splunk', {});
  const tierDown = modes.find((m) => m.id === 'tier_down')!;
  assert.equal(tierDown.applicable, false);
  assert.ok(tierDown.gated_reason && tierDown.gated_reason.length > 0);
});

test('offload is applicable only when both retriever and receiver are present', () => {
  const fullCapsVal = fullCaps(); // retriever + receiver
  const modesWithBoth = buildModes(fullCapsVal, 'splunk', {});
  const offloadWithBoth = modesWithBoth.find((m) => m.id === 'offload')!;
  assert.equal(offloadWithBoth.applicable, true);

  const capsNoReceiver = buildCapabilities({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: false,
    receiverUncertain: true,
    retrieverOk: true,
    siemDetected: 'splunk',
  });
  const modesNoReceiver = buildModes(capsNoReceiver, 'splunk', {});
  const offloadNoReceiver = modesNoReceiver.find((m) => m.id === 'offload')!;
  assert.equal(offloadNoReceiver.applicable, false);
});

test('drop and pass are always applicable regardless of tier', () => {
  const caps = devCaps();
  const modes = buildModes(caps, null, {});
  const drop = modes.find((m) => m.id === 'drop')!;
  const pass = modes.find((m) => m.id === 'pass')!;
  assert.equal(drop.applicable, true);
  assert.equal(pass.applicable, true);
});

test('manual is always applicable', () => {
  const caps = devCaps();
  const modes = buildModes(caps, null, {});
  const manual = modes.find((m) => m.id === 'manual')!;
  assert.equal(manual.applicable, true);
});

// ── siemSupportsCompact helper ─────────────────────────────────────────────────

test('siemSupportsCompact returns true for splunk and elasticsearch', () => {
  assert.equal(siemSupportsCompact('splunk'), true);
  assert.equal(siemSupportsCompact('elasticsearch'), true);
  assert.equal(siemSupportsCompact('clickhouse'), true);
  assert.equal(siemSupportsCompact('azure-monitor'), true);
  assert.equal(siemSupportsCompact('gcp-logging'), true);
  assert.equal(siemSupportsCompact('sumo'), true);
});

test('siemSupportsCompact returns false for datadog and cloudwatch', () => {
  assert.equal(siemSupportsCompact('datadog'), false);
  assert.equal(siemSupportsCompact('cloudwatch'), false);
});

test('siemSupportsCompact returns true for unknown SIEM (null)', () => {
  assert.equal(siemSupportsCompact(null), true);
});

// ── routes_to shape ────────────────────────────────────────────────────────────

test('manual mode routes to log10x_manual_options', () => {
  const caps = fullCaps();
  const modes = buildModes(caps, 'splunk', { target_percent: 30, service: 'payments' });
  const manual = modes.find((m) => m.id === 'manual')!;
  assert.equal(manual.routes_to.tool, 'log10x_manual_options');
});

test('drop mode routes to log10x_estimate_savings with default_action=drop', () => {
  const caps = fullCaps();
  const modes = buildModes(caps, 'splunk', { target_percent: 40 });
  const drop = modes.find((m) => m.id === 'drop')!;
  assert.equal(drop.routes_to.tool, 'log10x_estimate_savings');
  assert.equal(drop.routes_to.args.default_action, 'drop');
  assert.equal(drop.routes_to.args.target_percent, 40);
});

test('target_percent and service are forwarded to estimate_savings routes', () => {
  const caps = fullCaps();
  const modes = buildModes(caps, 'splunk', { target_percent: 50, service: 'checkout' });
  for (const id of ['drop', 'sample', 'compact', 'pass'] as const) {
    const mode = modes.find((m) => m.id === id)!;
    assert.equal(mode.routes_to.args.target_percent, 50, `${id} should carry target_percent`);
    assert.equal(mode.routes_to.args.service, 'checkout', `${id} should carry service`);
  }
});

// ── log10x_start action menu routes to log10x_cost_options ────────────────────

test('log10x_start action menu option 1 routes to log10x_cost_options', () => {
  const caps: CapabilitySummary = {
    cost_attribution_available: true,
    compact_installable: true,
    tier_down_available: true,
    forensic_query_available: true,
    offload_ready: true,
    siem_query_available: true,
    receiver_discrimination_uncertain: false,
  };
  const menu = startInternals.buildActionMenu(caps, 'retriever');
  const savingsItem = menu.find((m) => m.action === 'estimate_savings');
  assert.ok(savingsItem, 'estimate_savings action must exist in menu');
  assert.equal(
    savingsItem!.routes_to,
    'log10x_cost_options',
    'option 1 must route to log10x_cost_options, not log10x_estimate_savings'
  );
});

// ── buildCostOptionsForbidden ──────────────────────────────────────────────────

test('buildCostOptionsForbidden returns exactly 4 entries', () => {
  const forbidden = buildCostOptionsForbidden();
  assert.equal(forbidden.length, 4);
  assert.ok(forbidden.includes('log10x_estimate_savings'));
  assert.ok(forbidden.includes('log10x_configure_engine'));
  assert.ok(forbidden.includes('log10x_pattern_mitigate'));
  assert.ok(forbidden.includes('log10x_manual_options'));
});
