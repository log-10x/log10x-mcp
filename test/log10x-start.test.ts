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
import { toolUnavailableReason } from '../src/lib/tool-availability.js';
import type { Environments } from '../src/lib/environments.js';

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

// ── The menu must not offer a door the gate holds shut ────────────────
//
// Measured before the fix: on a keyless boot the demo dataset answers the
// tier probes, so cost_attribution_available came back true and the menu
// shipped investigate_spike with applicable: true, routing to
// log10x_top_patterns — which the demo gate then refuses with
// not_configured (metrics_backend).

test('applyToolGates demotes an item whose routed tool the demo gate would refuse', () => {
  const caps: CapabilitySummary = {
    cost_attribution_available: true,
    compact_installable: true,
    tier_down_available: false,
    forensic_query_available: false,
    offload_ready: false,
    siem_query_available: false,
    receiver_discrimination_uncertain: false,
  };
  // Pure demo state: nothing configured, silently landed on the demo backend.
  const demoEnvs = { isDemoMode: true, demoFallbackReason: undefined } as unknown as Environments;

  const ungated = _internals.buildTierMenu(caps, 'reporter');
  const spikeBefore = ungated.find((m) => m.action === 'investigate_spike');
  assert.ok(spikeBefore, 'investigate_spike must be in the tier menu');
  assert.equal(spikeBefore!.applicable, true, 'tier capability alone says applicable');
  assert.equal(spikeBefore!.routes_to, 'log10x_top_patterns');

  const gated = _internals.applyToolGates(ungated, demoEnvs);
  const spikeAfter = gated.find((m) => m.action === 'investigate_spike');
  assert.equal(spikeAfter!.applicable, false, 'the demo gate refuses log10x_top_patterns, so the menu must not offer it');
  assert.match(spikeAfter!.gated_reason ?? '', /log10x_signin_start/, 'gated_reason must name a tool that IS callable here');
});

test('no applicable menu item routes to a tool the same gates would refuse', () => {
  const caps: CapabilitySummary = {
    cost_attribution_available: true,
    compact_installable: true,
    tier_down_available: true,
    forensic_query_available: true,
    offload_ready: true,
    siem_query_available: true,
    receiver_discrimination_uncertain: false,
  };
  const demoEnvs = { isDemoMode: true, demoFallbackReason: undefined } as unknown as Environments;
  for (const tier of ['dev', 'reporter', 'receiver', 'retriever'] as const) {
    const menu = _internals.buildActionMenu(caps, tier, demoEnvs);
    for (const item of menu) {
      if (!item.applicable) continue;
      assert.equal(
        toolUnavailableReason(item.routes_to, demoEnvs),
        null,
        `tier ${tier}: menu offers ${item.action} -> ${item.routes_to}, which would refuse`,
      );
    }
  }
});

test('a configured environment leaves the menu ungated', () => {
  const caps: CapabilitySummary = {
    cost_attribution_available: true,
    compact_installable: true,
    tier_down_available: false,
    forensic_query_available: false,
    offload_ready: false,
    siem_query_available: false,
    receiver_discrimination_uncertain: false,
  };
  const realEnvs = { isDemoMode: false, demoFallbackReason: undefined } as unknown as Environments;
  const menu = _internals.buildActionMenu(caps, 'reporter', realEnvs);
  const spike = menu.find((m) => m.action === 'investigate_spike');
  assert.equal(spike!.applicable, true, 'nothing is gated when the user has their own env');
});

// ── The prospect's first item ────────────────────────────────────────────
//
// On a POC or keyless demo-fallback boot the person on the other end has
// installed nothing. The menu's first offer must be the sentence the
// homepage teaches — run a cost POC on their own logs — routed to the tool
// that actually does it, and stating the property that earns the click.
// The lane question is answered by the SAME gate that decides registration
// (peekBootMode + shouldRegisterTool), so menu and registration cannot
// drift. On a real deployed boot the item is absent; a running environment
// is not a prospect.

import { recordBootMode } from '../src/lib/tool-availability.js';
import type { ModeResolution } from '../src/lib/mode-detect.js';

async function menuWithBoot(boot: Partial<ModeResolution> | undefined) {
  recordBootMode(
    boot
      ? ({ trace: [], reason: 'test', probeDurationMs: 0, ...boot } as ModeResolution)
      : undefined
  );
  try {
    const result = await executeLog10xStart({});
    return (result.data as Log10xStartEnvelope).action_menu;
  } finally {
    recordBootMode(undefined);
  }
}

test('a POC boot leads the menu with the run-a-POC item, routed to poc_from_local', async () => {
  const menu = await menuWithBoot({ mode: 'poc' });
  assert.ok(menu.length > 0, 'menu renders');
  const first = menu[0];
  assert.equal(first.routes_to, 'log10x_poc_from_local', 'the first offer routes to the POC');
  assert.equal(first.applicable, true, 'the POC item is never gated');
  assert.match(first.label, /POC/i, 'the label says what it is');
  assert.match(first.label, /own logs/i, 'the label says whose logs');
  assert.match(first.label, /locally|leaves|sent out/i, 'the label states the no-data-out property');
});

test('a keyless demo-fallback boot also leads with the POC item', async () => {
  const menu = await menuWithBoot({ mode: 'analysis', demoFallback: true });
  assert.equal(menu[0]?.routes_to, 'log10x_poc_from_local');
});

test('a real deployed boot shows no POC item', async () => {
  const menu = await menuWithBoot({ mode: 'analysis' });
  assert.ok(
    menu.every((m) => m.routes_to !== 'log10x_poc_from_local'),
    'a deployed customer is not offered a prospect POC'
  );
});

test('an unbooted unit-test process shows no POC item either', async () => {
  const menu = await menuWithBoot(undefined);
  assert.ok(menu.every((m) => m.routes_to !== 'log10x_poc_from_local'));
});

// ── The menu must carry the routing the instructions promise ──────────────
//
// The instructions tell the agent: "match it to the corresponding
// action_menu item and call that item's routes_to tool." The rendered
// verbatim block carried labels and gating reasons but not tool names, so an
// agent obeying that instruction had to guess. A blind agent given only the
// shipped artifacts guessed wrong on two of seven items.
test('the rendered menu names the tool each number routes to', async () => {
  const result = await executeLog10xStart({});
  const data = result.data as Log10xStartEnvelope;
  for (const item of data.action_menu) {
    assert.ok(
      data.must_render_verbatim.includes(item.routes_to),
      `the menu renders "${item.label.slice(0, 40)}" without naming ${item.routes_to}, ` +
        `so an agent following the routes_to instruction has to guess`
    );
  }
});
