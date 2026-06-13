/**
 * Phase 2 per-service action resolver (_resolveServiceAction) acceptance tests.
 *
 * The resolver is the new authority for the engine's per-service actions.csv,
 * so its #1 contract is: NEVER emit a destination-illegal or zero-saving action
 * (compact on a no-op destination, tier_down where no cheaper tier is modeled).
 * These tests pin that contract across all eight destinations and cover the
 * compressibility discriminator, keep_queryable, pin rejection, and the
 * byte-identical auto_recommend=false legacy path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _resolveServiceAction } from '../src/tools/configure-engine.js';
import { getDestinationCostModel, type Action } from '../src/lib/cost.js';
import type { SiemId } from '../src/lib/siem/pricing.js';

const ALL: SiemId[] = [
  'splunk', 'datadog', 'elasticsearch', 'clickhouse',
  'cloudwatch', 'azure-monitor', 'gcp-logging', 'sumo',
];

function resolve(
  destination: SiemId,
  overrides: {
    compressibility?: { ratio: number | null; input_bytes: number; optimized_bytes: number };
    policy?: { standard_action?: Action; keep_queryable?: boolean };
    autoRecommend?: boolean;
    globalStandardAction?: Action;
    compactWorthItRatio?: number;
  } = {}
) {
  const warnings: string[] = [];
  const decision = _resolveServiceAction({
    container: 'svc',
    destination,
    model: getDestinationCostModel(destination),
    compressibility: overrides.compressibility,
    policy: overrides.policy,
    autoRecommend: overrides.autoRecommend ?? true,
    globalStandardAction: overrides.globalStandardAction ?? 'compact',
    compactWorthItRatio: overrides.compactWorthItRatio ?? 0.6,
    warnings,
  });
  return { decision, warnings };
}

/** Mirror of the resolver's own legality test, for assertion. */
function isLegal(destination: SiemId, a: Action): boolean {
  const model = getDestinationCostModel(destination);
  if (a === 'pass' || a === 'sample' || a === 'drop') return true;
  if (a === 'compact') return model.compact_mode !== 'no-op';
  if (a === 'tier_down') return !!model.tier_down_target_tier;
  return true; // offload legal everywhere
}

// ─── 1. legality invariant across all destinations ───────────────────

test('auto path never emits a destination-illegal action on any of the 8 destinations', () => {
  for (const d of ALL) {
    const { decision } = resolve(d);
    assert.ok(isLegal(d, decision.action), `${d} -> ${decision.action} is illegal`);
  }
});

// ─── 2. THE regression: datadog auto must be offload, never tier_down ─

test('datadog auto-recommends offload (Flex tier_down is unpriced, so not legal)', () => {
  const { decision } = resolve('datadog');
  assert.equal(decision.action, 'offload');
  assert.equal(decision.source, 'auto');
});

test('cloudwatch auto-recommends tier_down (it has a priced IA tier)', () => {
  const { decision } = resolve('cloudwatch');
  assert.equal(decision.action, 'tier_down');
});

// ─── 3. compact-vs-offload discriminator on a compactable destination ─

test('splunk: modeled band (0.115) is below threshold -> compact', () => {
  const { decision } = resolve('splunk');
  assert.equal(decision.action, 'compact');
  assert.equal(decision.ratio_source, 'static_band');
});

test('splunk: measured-poor compressibility (0.9) -> offload', () => {
  const { decision } = resolve('splunk', {
    compressibility: { ratio: 0.9, input_bytes: 1e9, optimized_bytes: 9e8 },
  });
  assert.equal(decision.action, 'offload');
  assert.equal(decision.ratio_source, 'measured');
  assert.equal(decision.measured_compression_pct, 10); // 1 - 0.9
});

test('splunk: measured-good compressibility (0.1) -> compact with measured override threaded', () => {
  const { decision } = resolve('splunk', {
    compressibility: { ratio: 0.1, input_bytes: 1e9, optimized_bytes: 1e8 },
  });
  assert.equal(decision.action, 'compact');
  assert.equal(decision.compact_ratio_override, 0.1);
});

// ─── 4. keep_queryable forces in-platform compact even on a poor ratio ─

test('keep_queryable forces compact on splunk despite a poor measured ratio', () => {
  const { decision } = resolve('splunk', {
    compressibility: { ratio: 0.9, input_bytes: 1e9, optimized_bytes: 9e8 },
    policy: { keep_queryable: true },
  });
  assert.equal(decision.action, 'compact');
});

// ─── 5. pins: legal honored, illegal rejected with warning + fallback ─

test('a legal pin (offload on splunk) is honored as user_pinned', () => {
  const { decision, warnings } = resolve('splunk', { policy: { standard_action: 'offload' } });
  assert.equal(decision.action, 'offload');
  assert.equal(decision.source, 'user_pinned');
  assert.equal(warnings.length, 0);
});

test('an illegal pin (compact on datadog) is rejected, warns, and falls back to a legal action', () => {
  const { decision, warnings } = resolve('datadog', { policy: { standard_action: 'compact' } });
  assert.notEqual(decision.action, 'compact');
  assert.ok(isLegal('datadog', decision.action));
  assert.equal(decision.action, 'offload'); // datadog auto fallback
  assert.ok(warnings.some((w) => /compact.*no-op on datadog/.test(w)), warnings.join('|'));
});

// ─── 6. legacy parity: auto_recommend=false ──────────────────────────

test('auto_recommend=false: an explicit non-compact action applies uniformly (global_default)', () => {
  const { decision } = resolve('splunk', { autoRecommend: false, globalStandardAction: 'sample' });
  assert.equal(decision.action, 'sample');
  assert.equal(decision.source, 'global_default');
});

test('auto_recommend=false: an explicit illegal non-compact action passes through VERBATIM (Phase-1 parity, not rewritten)', () => {
  // tier_down on splunk has no cheaper tier; Phase 1 applied it verbatim and let
  // the projection note surface zero savings. Phase 2 must NOT silently rewrite it.
  const { decision } = resolve('splunk', { autoRecommend: false, globalStandardAction: 'tier_down' });
  assert.equal(decision.action, 'tier_down');
  assert.equal(decision.source, 'global_default');
});

test('auto_recommend=false: compact on a no-op destination remaps to its first legal lever (matches Phase 1)', () => {
  const { decision } = resolve('datadog', { autoRecommend: false, globalStandardAction: 'compact' });
  assert.equal(decision.action, 'offload');
});

test('auto_recommend=false: compact carries NO measured override even when a ratio exists (legacy dollar-identity)', () => {
  // The measured compact_ratio_override would collapse the cost.ts band to the
  // measured value, diverging from pre-Phase-2 static-band dollars. Under auto
  // off it must NOT thread, so a legacy Splunk run stays dollar-identical.
  const { decision } = resolve('splunk', {
    autoRecommend: false,
    globalStandardAction: 'compact',
    compressibility: { ratio: 0.1, input_bytes: 1e9, optimized_bytes: 1e8 },
  });
  assert.equal(decision.action, 'compact');
  assert.equal(decision.compact_ratio_override, undefined);
});

test('auto_recommend=true: compact threads the measured override (per-service path active)', () => {
  const { decision } = resolve('splunk', {
    compressibility: { ratio: 0.1, input_bytes: 1e9, optimized_bytes: 1e8 },
  });
  assert.equal(decision.action, 'compact');
  assert.equal(decision.compact_ratio_override, 0.1);
});
