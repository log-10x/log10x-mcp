/**
 * Unit tests for log10x_start — the orientation tool.
 *
 * Asserts:
 *   1. The envelope shape (tier, capability_summary, action_menu, journey_phases,
 *      must_render_verbatim, must_ask_user, forbidden_next_actions).
 *   2. must_ask_user.options is non-empty and matches action_menu length.
 *   3. forbidden_next_actions includes the four tools the routing rule names.
 *   4. The internal helpers correctly gate the action menu by tier.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeLog10xStart,
  _internals,
  type Log10xStartEnvelope,
  type CapabilitySummary,
} from '../src/tools/log10x-start.js';
import { isStructuredOutput, StructuredOutputSchema } from '../src/lib/output-types.js';

test('executeLog10xStart returns a schema-valid StructuredOutput envelope', async () => {
  const result = await executeLog10xStart({});
  assert.ok(isStructuredOutput(result), 'expected a StructuredOutput envelope');
  // Schema validates without throwing.
  StructuredOutputSchema.parse(result);
  assert.equal(result.tool, 'log10x_start');
  assert.equal(result.view, 'summary');
  assert.ok(result.summary.headline.length > 0, 'headline must be set');
});

test('executeLog10xStart envelope.data carries all required orientation fields', async () => {
  const result = await executeLog10xStart({});
  const data = result.data as Log10xStartEnvelope;
  assert.ok(['dev', 'reporter', 'receiver', 'retriever'].includes(data.tier), `tier must be one of the four ladder rungs, got ${data.tier}`);
  assert.ok(data.siem_detected === null || typeof data.siem_detected === 'string', 'siem_detected must be string or null');
  assert.ok(typeof data.capability_summary === 'object' && data.capability_summary !== null, 'capability_summary must be an object');
  assert.ok(Array.isArray(data.action_menu), 'action_menu must be an array');
  assert.ok(data.action_menu.length > 0, 'action_menu must be non-empty');
  assert.ok(Array.isArray(data.journey_phases), 'journey_phases must be an array');
  assert.equal(data.journey_phases.length, 5, 'journey_phases must have exactly 5 phases');
  assert.ok(typeof data.must_render_verbatim === 'string', 'must_render_verbatim must be a string');
  assert.ok(data.must_render_verbatim.length > 0, 'must_render_verbatim must be non-empty');
  assert.ok(typeof data.must_ask_user === 'object' && data.must_ask_user !== null, 'must_ask_user must be an object');
  assert.ok(Array.isArray(data.forbidden_next_actions), 'forbidden_next_actions must be an array');
});

test('must_ask_user has a non-empty question and one option per action_menu entry', async () => {
  const result = await executeLog10xStart({});
  const data = result.data as Log10xStartEnvelope;
  assert.ok(typeof data.must_ask_user.question === 'string' && data.must_ask_user.question.length > 0, 'question must be present');
  assert.ok(Array.isArray(data.must_ask_user.options), 'options must be an array');
  assert.equal(
    data.must_ask_user.options.length,
    data.action_menu.length,
    'one option per action_menu entry',
  );
});

test('forbidden_next_actions includes the four tools the routing rule names', async () => {
  const result = await executeLog10xStart({});
  const data = result.data as Log10xStartEnvelope;
  const required = ['log10x_estimate_savings', 'log10x_configure_engine', 'log10x_pattern_mitigate', 'log10x_services'];
  for (const tool of required) {
    assert.ok(
      data.forbidden_next_actions.includes(tool),
      `forbidden_next_actions must include ${tool}`,
    );
  }
});

test('journey_phases are exactly the five ladder phases in order', async () => {
  const result = await executeLog10xStart({});
  const data = result.data as Log10xStartEnvelope;
  const names = data.journey_phases.map((p) => p.name);
  assert.deepEqual(names, ['Visibility', 'Attribution', 'Mitigation', 'Overflow', 'Commitment']);
  for (let i = 0; i < data.journey_phases.length; i++) {
    assert.equal(data.journey_phases[i].phase, i + 1, `phase ordinal at index ${i}`);
  }
});

test('intent_hint defaults to "orient" when not passed', async () => {
  const result = await executeLog10xStart({});
  const data = result.data as Log10xStartEnvelope;
  assert.equal(data.intent_hint, 'orient');
});

test('intent_hint is preserved when explicitly passed', async () => {
  const result = await executeLog10xStart({ intent_hint: 'cost' });
  const data = result.data as Log10xStartEnvelope;
  assert.equal(data.intent_hint, 'cost');
});

// ── _internals tests (pure helpers, no env required) ──

test('_internals.resolveTier promotes to "retriever" when Retriever is reachable', () => {
  const tier = _internals.resolveTier({
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: true,
    retrieverOk: true,
  });
  assert.equal(tier, 'retriever');
});

test('_internals.resolveTier falls back to "dev" when nothing is detected', () => {
  const tier = _internals.resolveTier({
    gatewayOk: false,
    reporterTier: null,
    receiverInPath: false,
    retrieverOk: false,
  });
  assert.equal(tier, 'dev');
});

test('_internals.resolveTier returns "reporter" with gateway + reporter only', () => {
  const tier = _internals.resolveTier({
    gatewayOk: true,
    reporterTier: 'cloud',
    receiverInPath: false,
    retrieverOk: false,
  });
  assert.equal(tier, 'reporter');
});

test('_internals.buildActionMenu gates install_receiver to reporter-tier customers only', () => {
  const caps: CapabilitySummary = {
    cost_attribution_available: true,
    compact_installable: true,
    tier_down_available: false,
    forensic_query_available: false,
    offload_ready: false,
    siem_query_available: false,
    receiver_discrimination_uncertain: false,
  };
  const reporterMenu = _internals.buildActionMenu(caps, 'reporter');
  const receiverInstall = reporterMenu.find((m) => m.action === 'install_receiver');
  assert.ok(receiverInstall);
  assert.equal(receiverInstall!.applicable, true);

  const devMenu = _internals.buildActionMenu(caps, 'dev');
  const devReceiverInstall = devMenu.find((m) => m.action === 'install_receiver');
  assert.ok(devReceiverInstall);
  assert.equal(devReceiverInstall!.applicable, false);
  assert.match(devReceiverInstall!.gated_reason ?? '', /Reporter first/i);
});

test('_internals.buildCapabilities marks offload_ready only when both retriever AND receiver are present', () => {
  const caps = _internals.buildCapabilities({
    tier: 'retriever',
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: true,
    receiverUncertain: false,
    retrieverOk: true,
    siemDetected: null,
  });
  assert.equal(caps.offload_ready, true);

  const capsNoReceiver = _internals.buildCapabilities({
    tier: 'reporter',
    gatewayOk: true,
    reporterTier: 'edge',
    receiverInPath: false,
    receiverUncertain: true,
    retrieverOk: true,
    siemDetected: null,
  });
  assert.equal(capsNoReceiver.offload_ready, false);
});

test('_internals.renderVerbatim contains the orientation header and a numbered menu', () => {
  const caps: CapabilitySummary = {
    cost_attribution_available: false,
    compact_installable: false,
    tier_down_available: false,
    forensic_query_available: false,
    offload_ready: false,
    siem_query_available: false,
    receiver_discrimination_uncertain: false,
  };
  const menu = _internals.buildActionMenu(caps, 'dev');
  const phases = _internals.buildJourneyPhases('dev', caps);
  const md = _internals.renderVerbatim({
    tier: 'dev',
    siemDetected: null,
    caps,
    menu,
    phases,
    intent: 'orient',
  });
  assert.match(md, /Log10x orientation/);
  assert.match(md, /Tier:/);
  assert.match(md, /Journey:/);
  assert.match(md, /Pick a number/);
  // Every menu entry should appear with its numbered prefix.
  for (let i = 0; i < menu.length; i++) {
    assert.match(md, new RegExp(`${i + 1}\\. `), `menu entry ${i + 1} must render`);
  }
});

test('_internals.buildForbiddenNextActions returns the four routing-rule-named tools', () => {
  const forbidden = _internals.buildForbiddenNextActions();
  assert.deepEqual(
    forbidden.sort(),
    [
      'log10x_configure_engine',
      'log10x_estimate_savings',
      'log10x_pattern_mitigate',
      'log10x_services',
    ].sort(),
  );
});
