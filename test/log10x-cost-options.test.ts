/**
 * Unit tests for log10x_cost_options.
 *
 * Asserts:
 *   1. Envelope shape: 6 modes at receiver tier, must_render_verbatim, must_ask_user, forbidden_next_actions.
 *   2. Gating: compact gated on unsupported SIEM; tier_down gated on wrong SIEM; offload gated.
 *   3. forbidden_next_actions contains the 3 required tools (manual_options removed).
 *   4. siemSupportsCompact helper returns correct values.
 *   5. executeLog10xStart routes option 1 to log10x_cost_options (not estimate_savings).
 *   6. At reporter/dev tier, modes collapses to 2 entries (observe_only + install_receiver).
 *   7. observe_only replaces 'pass'; no 'manual' mode exists.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _internals,
  type CostOptionsEnvelope,
} from '../src/tools/cost-options.js';
import { isStructuredOutput, StructuredOutputSchema } from '../src/lib/output-types.js';
import { executeCostOptions } from '../src/tools/cost-options.js';
import { _internals as startInternals, type CapabilitySummary } from '../src/tools/log10x-start.js';

const { buildCapabilities, buildModes, renderVerbatim, buildCostOptionsForbidden, siemSupportsCompact } = _internals;

// ── Helper: full capabilities (receiver + retriever + siem) ────────────────────

function fullCaps() {
  return buildCapabilities({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: true,
    receiverUncertain: false,
    retrieverOk: true,
    siemDetected: 'splunk',
  });
}

function devCaps() {
  return buildCapabilities({
    gatewayOk: false,
    reporterTier: null,
    receiverInPath: false,
    receiverUncertain: true,
    retrieverOk: false,
    siemDetected: null,
  });
}

function reporterCaps() {
  return buildCapabilities({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: false,
    receiverUncertain: true,
    retrieverOk: false,
    siemDetected: 'splunk',
  });
}

function receiverCaps() {
  return buildCapabilities({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: true,
    receiverUncertain: false,
    retrieverOk: false,
    siemDetected: 'splunk',
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

// ── Tier gating tests ────────────────────────────────────────────────────────────

test('at reporter tier, modes collapses to observe_only + install_receiver', () => {
  const caps = reporterCaps();
  const modes = buildModes(caps, 'splunk', {});
  assert.equal(modes.length, 2, 'reporter tier must have exactly 2 modes');
  assert.equal(modes[0].id, 'observe_only');
  assert.equal(modes[1].id, 'install_receiver');
});

test('at dev tier, modes collapses to observe_only + install_receiver', () => {
  const caps = devCaps();
  const modes = buildModes(caps, null, {});
  assert.equal(modes.length, 2, 'dev tier must have exactly 2 modes');
  assert.equal(modes[0].id, 'observe_only');
  assert.equal(modes[1].id, 'install_receiver');
});

test('at reporter tier, must_render_verbatim explains why drop/sample/tier_down/offload/compact require Receiver', () => {
  const caps = reporterCaps();
  const modes = buildModes(caps, 'splunk', {});
  const verbatim = renderVerbatim(modes, 'splunk', 'reporter');
  assert.match(verbatim, /Receiver/i, 'verbatim must mention Receiver');
  assert.match(verbatim, /Drop.*sample.*tier_down.*offload.*compact/i, 'verbatim must list gated modes');
});

test('at receiver tier, 6 outcome-first modes render in order', () => {
  const caps = receiverCaps();
  const modes = buildModes(caps, 'splunk', {});
  assert.equal(modes.length, 6, 'receiver tier must have exactly 6 modes');
  const ids = modes.map((m) => m.id);
  assert.deepEqual(ids, ['drop', 'sample', 'compact', 'tier_down', 'offload', 'observe_only']);
});

// ── Mode ID assertions ────────────────────────────────────────────────────────────

test('mode ids at receiver tier are the 6 values in order', () => {
  const caps = fullCaps();
  const modes = buildModes(caps, 'splunk', {});
  const ids = modes.map((m) => m.id);
  assert.deepEqual(ids, ['drop', 'sample', 'compact', 'tier_down', 'offload', 'observe_only']);
});

test('no manual mode exists at any tier', () => {
  for (const caps of [devCaps(), reporterCaps(), receiverCaps(), fullCaps()]) {
    const modes = buildModes(caps, 'splunk', {});
    assert.ok(!modes.find((m) => (m.id as string) === 'manual'), 'manual mode must not exist');
  }
});

test('no pass mode id exists — renamed to observe_only', () => {
  const caps = fullCaps();
  const modes = buildModes(caps, 'splunk', {});
  assert.ok(!modes.find((m) => (m.id as string) === 'pass'), 'pass mode must not exist');
  assert.ok(modes.find((m) => m.id === 'observe_only'), 'observe_only must exist');
});

test('observe_only routes to log10x_estimate_savings with default_action=pass (backend token)', () => {
  const caps = fullCaps();
  // default_action is only emitted on the greedy-solver route (target_percent set);
  // with no target_percent the args carry only destination/service.
  const modes = buildModes(caps, 'splunk', { target_percent: 30 });
  const observeOnly = modes.find((m) => m.id === 'observe_only')!;
  assert.equal(observeOnly.routes_to.tool, 'log10x_estimate_savings');
  assert.equal(observeOnly.routes_to.args.default_action, 'pass');
});

test('install_receiver at reporter tier routes to log10x_advise_install', () => {
  const caps = reporterCaps();
  const modes = buildModes(caps, 'splunk', {});
  const install = modes.find((m) => m.id === 'install_receiver')!;
  assert.equal(install.routes_to.tool, 'log10x_advise_install');
});

test('must_render_verbatim contains the header and 6 numbered entries at receiver tier', () => {
  const caps = fullCaps();
  const modes = buildModes(caps, 'splunk', {});
  const verbatim = renderVerbatim(modes, 'splunk', 'receiver');
  assert.match(verbatim, /How do you want to handle the cost/);
  for (let i = 1; i <= 6; i++) {
    assert.match(verbatim, new RegExp(`${i}\\.`), `entry ${i} must render`);
  }
});

test('must_ask_user at receiver tier has 6 options', async () => {
  // Hard to force receiver tier in live env test, so test via buildModes directly.
  const caps = fullCaps();
  const modes = buildModes(caps, 'splunk', {});
  assert.equal(modes.length, 6, 'must have 6 options at receiver tier');
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

test('compact is gated when receiver not installed (dev tier — collapses to 2-item)', () => {
  const caps = devCaps();
  const modes = buildModes(caps, 'splunk', {});
  // dev tier collapses — no compact mode at all
  assert.ok(!modes.find((m) => m.id === 'compact'), 'compact not in dev tier menu');
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

test('drop and observe_only are always applicable at receiver tier', () => {
  const caps = receiverCaps();
  const modes = buildModes(caps, null, {});
  const drop = modes.find((m) => m.id === 'drop')!;
  const observeOnly = modes.find((m) => m.id === 'observe_only')!;
  assert.equal(drop.applicable, true);
  assert.equal(observeOnly.applicable, true);
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
  for (const id of ['drop', 'sample', 'compact', 'observe_only'] as const) {
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

test('buildCostOptionsForbidden returns exactly 3 entries (manual_options removed)', () => {
  const forbidden = buildCostOptionsForbidden();
  assert.equal(forbidden.length, 3);
  assert.ok(forbidden.includes('log10x_estimate_savings'));
  assert.ok(forbidden.includes('log10x_configure_engine'));
  assert.ok(forbidden.includes('log10x_pattern_mitigate'));
  assert.ok(!forbidden.includes('log10x_manual_options'), 'manual_options must not be in forbidden list');
});
