/**
 * Unit tests for log10x_explain_mode — L2 orientation surface.
 *
 * Asserts:
 *   1. Envelope shape: StructuredOutput compliant, correct tool name/view.
 *   2. data fields: service, mode, destination, must_render_verbatim,
 *      must_ask_user, forbidden_next_actions, routes_to.
 *   3. must_render_verbatim: three labelled sections, NO pattern_hash anywhere.
 *   4. Dollar math: "X GB times $Y/GB = $Z" formula appears when rate is set.
 *   5. must_ask_user.options: Apply branch + Preview branch present (except observe_only).
 *   6. forbidden_next_actions: all four required tools blocked.
 *   7. routes_to: apply routes to log10x_configure_engine for all non-observe modes;
 *      observe_only has routes_to.apply === null.
 *      preview always routes to log10x_preview_filter.
 *   8. actions[]: branches emitted with role='alternative'.
 *   9. No pattern_hash in verbatim across all 6 modes.
 *  10. All non-observe modes route apply to log10x_configure_engine.
 *  11. observe_only has no apply route.
 *  12. New mode enum: drop/sample/compact/tier_down/offload/observe_only (6 entries).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeExplainMode,
  EXPLAIN_MODES,
  type ExplainModeEnvelope,
  type ExplainMode,
} from '../src/tools/explain-mode.js';
import { isStructuredOutput, StructuredOutputSchema } from '../src/lib/output-types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Call the tool and flatten the ChassisEnvelope back to the ExplainMode shape
 * the assertions read.
 *
 * The tool was migrated to buildChassisEnvelope, which nests the tool-specific
 * rows (service, mode, destination, routes_to, service_bytes_per_month,
 * service_cost_per_month_usd) under `data.payload.*`, while lifting the
 * orientation fields (must_render_verbatim, must_ask_user,
 * forbidden_next_actions, human_summary) to `data.*` top-level. We merge both
 * levels so `data.service` / `data.routes_to` and `data.must_render_verbatim`
 * all resolve. There is no key collision between the two levels.
 *
 * A per-mode compatible destination (compatDestFor) is passed so the call does
 * not auto-detect one from the public demo backend, and so each mode renders its
 * APPLY shape rather than the 4-option "choose an alternative" branch. compact
 * runs only on compaction-capable stacks (splunk / self-hosted ES / clickhouse)
 * and tier_down only on cheap-tier stacks (azure-monitor / cloudwatch / datadog);
 * those two sets are disjoint, so there is no single all-modes destination.
 * Passing it also short-circuits the auto-detect round-trip, keeping runs
 * deterministic.
 */
const COMPAT_DEST: Partial<Record<ExplainMode, string>> = {
  compact: 'splunk', // a compaction-capable stack
  tier_down: 'azure-monitor', // a cheap-tier stack
};
// Compatible destination for `mode`; defaults to azure-monitor for the
// destination-agnostic modes (drop / sample / offload / observe_only).
const compatDestFor = (mode: ExplainMode): string => COMPAT_DEST[mode] ?? 'azure-monitor';

async function runMode(
  mode: ExplainMode,
  service = 'payments',
  destination = compatDestFor(mode),
): Promise<{
  result: Awaited<ReturnType<typeof executeExplainMode>>;
  data: ExplainModeEnvelope;
}> {
  const result = await executeExplainMode({ service, mode, destination });
  const out = result.data as { payload?: Partial<ExplainModeEnvelope> } & Partial<ExplainModeEnvelope>;
  const data = { ...(out.payload ?? {}), ...out } as ExplainModeEnvelope;
  return { result, data };
}

// ── New enum shape ────────────────────────────────────────────────────────────────

test('EXPLAIN_MODES has exactly 6 entries matching the outcome-first shape', () => {
  assert.deepEqual(
    [...EXPLAIN_MODES],
    ['compact', 'offload', 'tier_down', 'sample', 'drop', 'observe_only'],
    'EXPLAIN_MODES must match the 6-mode outcome-first enum (keep-everything levers first)',
  );
});

// ── Schema compliance ────────────────────────────────────────────────────────────

test('executeExplainMode returns a schema-valid StructuredOutput', async () => {
  const { result } = await runMode('drop');
  assert.ok(isStructuredOutput(result), 'expected a StructuredOutput envelope');
  StructuredOutputSchema.parse(result);
  assert.equal(result.tool, 'log10x_explain_mode');
  assert.equal(result.view, 'summary');
  assert.ok(result.summary.headline.length > 0, 'headline must be non-empty');
});

// ── Envelope data fields ─────────────────────────────────────────────────────────

test('data carries all required ExplainModeEnvelope fields', async () => {
  const { data } = await runMode('sample', 'auth-service');
  assert.equal(data.service, 'auth-service');
  assert.equal(data.mode, 'sample');
  assert.ok('destination' in data, 'destination field must exist');
  assert.ok('service_bytes_per_month' in data, 'service_bytes_per_month must exist');
  assert.ok('service_cost_per_month_usd' in data, 'service_cost_per_month_usd must exist');
  assert.ok(typeof data.must_render_verbatim === 'string', 'must_render_verbatim must be string');
  assert.ok(data.must_render_verbatim.length > 0, 'must_render_verbatim must be non-empty');
  assert.ok(typeof data.must_ask_user === 'object', 'must_ask_user must be object');
  assert.ok(Array.isArray(data.forbidden_next_actions), 'forbidden_next_actions must be array');
  assert.ok(typeof data.routes_to === 'object', 'routes_to must be object');
  assert.ok('apply' in data.routes_to, 'routes_to.apply must exist');
  assert.ok('preview' in data.routes_to, 'routes_to.preview must exist');
});

// ── must_render_verbatim — three sections, NO pattern_hash ────────────────────────

test('must_render_verbatim contains all three labelled sections', async () => {
  const { data } = await runMode('sample', 'api-gateway');
  const v = data.must_render_verbatim;
  assert.match(v, /What it does/i, 'section 1: "What it does" must appear');
  assert.match(v, /What you need/i, 'section 2: "What you need" must appear');
  assert.match(v, /What it would mean for api-gateway/i, 'section 3: service name must appear');
});

test('must_render_verbatim contains no pattern_hash references', async () => {
  for (const mode of EXPLAIN_MODES) {
    const { data } = await runMode(mode, 'test-service');
    const v = data.must_render_verbatim;
    assert.ok(
      !v.includes('pattern_hash') && !v.includes('tenx_hash'),
      `mode ${mode}: verbatim must not reference pattern_hash or tenx_hash`,
    );
  }
});

test('must_render_verbatim uses plain text — no markdown syntax', async () => {
  for (const mode of EXPLAIN_MODES) {
    const { data } = await runMode(mode);
    const v = data.must_render_verbatim;
    assert.ok(!v.includes('**'), `mode ${mode}: no bold markdown in verbatim`);
    assert.ok(!v.match(/^#{1,6} /m), `mode ${mode}: no heading markdown in verbatim`);
    assert.ok(!v.includes('`'), `mode ${mode}: no backtick markdown in verbatim`);
  }
});

// ── Dollar math — explicit "X GB times $Y/GB = $Z" ────────────────────────────────

test('dollar math formula uses explicit "GB times $/GB" form when rate is available', async () => {
  // We cannot force TSDB bytes to be non-null in unit tests (no TSDB).
  // So we verify: when bytesPerMonth IS null, no dollar math formula appears.
  const { data } = await runMode('drop');
  const v = data.must_render_verbatim;
  if (v.includes('GB times')) {
    // If dollar math is present, it must show "X GB times $Y/GB = $Z" pattern
    assert.match(
      v,
      /\d+(\.\d+)?\s+GB\s+times\s+\$[\d.]+\/GB\s*=\s*\$[\d,]+/,
      'dollar math must match "X GB times $Y/GB = $Z" format',
    );
  }
  // No dollar math when no rate configured — volume line is a "not available" message
  if (data.service_bytes_per_month === null) {
    assert.ok(
      !v.includes('GB times'),
      'no dollar math when service_bytes_per_month is null',
    );
  }
});

// ── must_ask_user ─────────────────────────────────────────────────────────────────

test('must_ask_user for non-observe modes has a question and exactly 2 options (Apply + Preview)', async () => {
  for (const mode of EXPLAIN_MODES.filter((m) => m !== 'observe_only')) {
    const { data } = await runMode(mode);
    assert.ok(
      typeof data.must_ask_user.question === 'string' && data.must_ask_user.question.length > 0,
      `mode ${mode}: must_ask_user.question must be non-empty`,
    );
    assert.equal(
      data.must_ask_user.options.length,
      2,
      `mode ${mode}: must_ask_user must have exactly 2 options`,
    );
    const opts = data.must_ask_user.options;
    assert.ok(opts.some((o) => o.toLowerCase().includes('apply')), `mode ${mode}: option 1 must be Apply`);
    assert.ok(
      opts.some((o) => o.includes('log10x_preview_filter')),
      `mode ${mode}: option 2 must reference log10x_preview_filter`,
    );
  }
});

test('observe_only has no apply option — must_ask_user has 1 option (Preview only)', async () => {
  const { data } = await runMode('observe_only');
  assert.equal(
    data.must_ask_user.options.length,
    1,
    'observe_only must have exactly 1 option (Preview)',
  );
  assert.ok(
    data.must_ask_user.options[0].includes('log10x_preview_filter'),
    'observe_only option must reference log10x_preview_filter',
  );
});

// ── forbidden_next_actions ────────────────────────────────────────────────────────

test('forbidden_next_actions blocks all four required tools', async () => {
  const { data } = await runMode('sample');
  const required = [
    'log10x_configure_engine',
    'log10x_pattern_mitigate',
    'log10x_advise_retriever',
    'log10x_preview_filter',
  ];
  for (const tool of required) {
    assert.ok(
      data.forbidden_next_actions.includes(tool),
      `forbidden_next_actions must include ${tool}`,
    );
  }
});

// ── routes_to routing per mode ─────────────────────────────────────────────────────

test('all non-observe_only modes route apply to log10x_configure_engine', async () => {
  for (const mode of EXPLAIN_MODES.filter((m) => m !== 'observe_only')) {
    const { data } = await runMode(mode);
    assert.ok(
      data.routes_to.apply !== null,
      `mode ${mode} must have a non-null apply route`,
    );
    assert.equal(
      data.routes_to.apply!.tool,
      'log10x_configure_engine',
      `mode ${mode} apply must route to log10x_configure_engine`,
    );
  }
});

test('observe_only has no apply route (routes_to.apply is null)', async () => {
  const { data } = await runMode('observe_only');
  assert.equal(
    data.routes_to.apply,
    null,
    'observe_only routes_to.apply must be null',
  );
});

test('all modes route preview to log10x_preview_filter with service and mode', async () => {
  for (const mode of EXPLAIN_MODES) {
    const { data } = await runMode(mode, 'checkout');
    assert.equal(
      data.routes_to.preview.tool,
      'log10x_preview_filter',
      `mode ${mode} preview must route to log10x_preview_filter`,
    );
    assert.equal(
      (data.routes_to.preview.args as Record<string, unknown>).service,
      'checkout',
      `mode ${mode} preview args must include service`,
    );
    assert.equal(
      (data.routes_to.preview.args as Record<string, unknown>).mode,
      mode,
      `mode ${mode} preview args must include mode`,
    );
  }
});

// ── actions[] both branches with role='alternative' ──────────────────────────────

test('actions[] contains both apply and preview branches as alternatives (non-observe mode)', async () => {
  const result = await executeExplainMode({ service: 'payments', mode: 'drop' });
  assert.ok(Array.isArray(result.actions), 'actions must be an array');
  assert.equal(result.actions.length, 2, 'exactly 2 actions (apply + preview) for non-observe mode');
  for (const action of result.actions) {
    assert.equal(action.role, 'alternative', 'every action must have role="alternative"');
    assert.ok(action.tool && action.tool.length > 0, 'every action must have a tool name');
  }
  const tools = result.actions.map((a) => a.tool);
  assert.ok(tools.includes('log10x_configure_engine'), 'apply action must be in actions[]');
  assert.ok(tools.includes('log10x_preview_filter'), 'preview action must be in actions[]');
});

test('actions[] for observe_only contains only the preview branch', async () => {
  const result = await executeExplainMode({ service: 'payments', mode: 'observe_only' });
  assert.ok(Array.isArray(result.actions), 'actions must be an array');
  assert.equal(result.actions.length, 1, 'observe_only must have exactly 1 action (preview only)');
  assert.equal(result.actions[0].tool, 'log10x_preview_filter');
  assert.equal(result.actions[0].role, 'alternative');
});

// ── All 6 modes produce valid envelopes ───────────────────────────────────────────

test('all 6 EXPLAIN_MODES produce a valid StructuredOutput with all required fields', async () => {
  for (const mode of EXPLAIN_MODES) {
    const { result, data } = await runMode(mode, 'orders');
    assert.ok(isStructuredOutput(result), `mode ${mode}: expected StructuredOutput`);
    StructuredOutputSchema.parse(result);
    assert.equal(data.mode, mode, `data.mode must equal ${mode}`);
    assert.ok(data.must_render_verbatim.length > 0, `mode ${mode}: verbatim must be non-empty`);
    assert.ok(data.forbidden_next_actions.length >= 4, `mode ${mode}: forbidden_next_actions must have at least 4 entries`);
    assert.ok(
      !data.must_render_verbatim.includes('pattern_hash') &&
      !data.must_render_verbatim.includes('tenx_hash'),
      `mode ${mode}: verbatim must not contain pattern_hash or tenx_hash`,
    );
  }
});
