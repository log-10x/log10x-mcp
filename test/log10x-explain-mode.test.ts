/**
 * Unit tests for log10x_explain_mode — L2 orientation surface.
 *
 * Asserts:
 *   1. Envelope shape: StructuredOutput compliant, correct tool name/view.
 *   2. data fields: service, mode, destination, must_render_verbatim,
 *      must_ask_user, forbidden_next_actions, routes_to.
 *   3. must_render_verbatim: three labelled sections, NO pattern_hash anywhere.
 *   4. Dollar math: "X GB times $Y/GB = $Z" formula appears when rate is set.
 *   5. must_ask_user.options: Apply branch + Preview branch present.
 *   6. forbidden_next_actions: all four required tools blocked.
 *   7. routes_to: apply routes to correct tool per mode group; preview always
 *      routes to log10x_preview_filter.
 *   8. actions[]: both branches emitted with role='alternative'.
 *   9. No pattern_hash in verbatim across all 7 modes.
 *  10. Engine modes route apply to log10x_configure_engine.
 *  11. siem_filter / forwarder_filter route apply to log10x_pattern_mitigate.
 *  12. engine_route_s3 routes apply to log10x_advise_retriever.
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

/** Call the tool with no env configured (offline / no TSDB) */
async function runMode(mode: ExplainMode, service = 'payments'): Promise<{
  result: Awaited<ReturnType<typeof executeExplainMode>>;
  data: ExplainModeEnvelope;
}> {
  const result = await executeExplainMode({ service, mode });
  const data = result.data as ExplainModeEnvelope;
  return { result, data };
}

// ── Schema compliance ────────────────────────────────────────────────────────────

test('executeExplainMode returns a schema-valid StructuredOutput', async () => {
  const { result } = await runMode('engine_in_path_drop');
  assert.ok(isStructuredOutput(result), 'expected a StructuredOutput envelope');
  StructuredOutputSchema.parse(result);
  assert.equal(result.tool, 'log10x_explain_mode');
  assert.equal(result.view, 'summary');
  assert.ok(result.summary.headline.length > 0, 'headline must be non-empty');
});

// ── Envelope data fields ─────────────────────────────────────────────────────────

test('data carries all required ExplainModeEnvelope fields', async () => {
  const { data } = await runMode('siem_filter', 'auth-service');
  assert.equal(data.service, 'auth-service');
  assert.equal(data.mode, 'siem_filter');
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
  const { data } = await runMode('engine_in_path_sample', 'api-gateway');
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
  // And when the spec formula appears in the text, it conforms to the expected pattern.
  const { data } = await runMode('engine_in_path_drop');
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

test('must_ask_user has a question and exactly 2 options (Apply + Preview)', async () => {
  const { data } = await runMode('siem_tier_down');
  assert.ok(
    typeof data.must_ask_user.question === 'string' && data.must_ask_user.question.length > 0,
    'must_ask_user.question must be non-empty',
  );
  assert.equal(
    data.must_ask_user.options.length,
    2,
    'must_ask_user must have exactly 2 options',
  );
  const opts = data.must_ask_user.options;
  assert.ok(opts.some((o) => o.toLowerCase().includes('apply')), 'option 1 must be Apply');
  assert.ok(
    opts.some((o) => o.includes('log10x_preview_filter')),
    'option 2 must reference log10x_preview_filter',
  );
});

// ── forbidden_next_actions ────────────────────────────────────────────────────────

test('forbidden_next_actions blocks all four required tools', async () => {
  const { data } = await runMode('engine_in_path_sample');
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

// ── routes_to routing per mode group ─────────────────────────────────────────────

test('engine_* modes route apply to log10x_configure_engine', async () => {
  const engineModes: ExplainMode[] = [
    'engine_in_path_drop',
    'engine_in_path_sample',
    'siem_tier_down',
  ];
  for (const mode of engineModes) {
    const { data } = await runMode(mode);
    assert.equal(
      data.routes_to.apply.tool,
      'log10x_configure_engine',
      `mode ${mode} apply must route to log10x_configure_engine`,
    );
  }
});

test('siem_filter and forwarder_filter route apply to log10x_pattern_mitigate', async () => {
  for (const mode of ['siem_filter', 'forwarder_filter'] as ExplainMode[]) {
    const { data } = await runMode(mode);
    assert.equal(
      data.routes_to.apply.tool,
      'log10x_pattern_mitigate',
      `mode ${mode} apply must route to log10x_pattern_mitigate`,
    );
  }
});

test('engine_route_s3 routes apply to log10x_advise_retriever', async () => {
  const { data } = await runMode('engine_route_s3');
  assert.equal(
    data.routes_to.apply.tool,
    'log10x_advise_retriever',
    'engine_route_s3 apply must route to log10x_advise_retriever',
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

test('actions[] contains both apply and preview branches as alternatives', async () => {
  const result = await executeExplainMode({ service: 'payments', mode: 'engine_in_path_drop' });
  assert.ok(Array.isArray(result.actions), 'actions must be an array');
  assert.equal(result.actions.length, 2, 'exactly 2 actions (apply + preview)');
  for (const action of result.actions) {
    assert.equal(action.role, 'alternative', 'every action must have role="alternative"');
    assert.ok(action.tool && action.tool.length > 0, 'every action must have a tool name');
  }
  const tools = result.actions.map((a) => a.tool);
  // Apply branch present
  assert.ok(tools.includes('log10x_configure_engine'), 'apply action must be in actions[]');
  // Preview branch present
  assert.ok(tools.includes('log10x_preview_filter'), 'preview action must be in actions[]');
});

// ── All 7 modes produce valid envelopes ───────────────────────────────────────────

test('all 7 EXPLAIN_MODES produce a valid StructuredOutput with all required fields', async () => {
  for (const mode of EXPLAIN_MODES) {
    const result = await executeExplainMode({ service: 'orders', mode });
    assert.ok(isStructuredOutput(result), `mode ${mode}: expected StructuredOutput`);
    StructuredOutputSchema.parse(result);
    const data = result.data as ExplainModeEnvelope;
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
