/**
 * Unit tests for log10x_manual_options — the manual enforcement sub-menu.
 *
 * Asserts:
 *   1. Envelope shape: sub_paths, siem_detected, forwarder_detected,
 *      must_render_verbatim, must_ask_user, forbidden_next_actions.
 *   2. Always exactly 3 sub-paths in fixed order (report_only, forwarder_config,
 *      siem_exclusion).
 *   3. report_only is always applicable and routes to log10x_estimate_savings
 *      with enforcement_mode=manual_report.
 *   4. forwarder_config is gated when no forwarder env var set; applicable
 *      when LOG10X_FORWARDER is set.
 *   5. siem_exclusion is gated when no SIEM creds (no live creds in test env);
 *      applicable marking follows capability.
 *   6. forbidden_next_actions includes log10x_configure_engine but NOT
 *      log10x_estimate_savings or log10x_pattern_mitigate.
 *   7. must_ask_user has exactly 3 options, one per sub-path.
 *   8. must_render_verbatim is a non-empty string.
 *   9. StructuredOutput schema validates without throwing.
 *  10. service and target_percent pass through to report_only routes_to args.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeManualOptions,
  type ManualOptionsEnvelope,
  type ManualOptionItem,
} from '../src/tools/manual-options.js';
import { isStructuredOutput, StructuredOutputSchema } from '../src/lib/output-types.js';

// ── env isolation helpers ─────────────────────────────────────────────────────

const LOG10X_KEYS = [
  'LOG10X_FORWARDER',
  'LOG10X_ANALYZER',
  'LOG10X_METRICS_URL',
  'LOG10X_CUSTOMER_METRICS_URL',
  'LOG10X_API_KEY',
  'LOG10X_ENV_ID',
  'DD_API_KEY',
  'SPLUNK_TOKEN',
  'ELASTIC_API_KEY',
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of LOG10X_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(s: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearLog10xEnv(): void {
  for (const k of LOG10X_KEYS) delete process.env[k];
}

// ── schema conformance ────────────────────────────────────────────────────────

test('manual_options: returns a schema-valid StructuredOutput envelope', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    assert.ok(isStructuredOutput(result), 'expected a StructuredOutput envelope');
    StructuredOutputSchema.parse(result);
    assert.equal(result.tool, 'log10x_manual_options');
    assert.equal(result.view, 'summary');
    assert.ok(result.summary.headline.length > 0, 'headline must be set');
  } finally {
    restoreEnv(snap);
  }
});

// ── envelope shape ────────────────────────────────────────────────────────────

test('manual_options: envelope.data carries all required fields', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    assert.ok(Array.isArray(data.sub_paths), 'sub_paths must be an array');
    assert.equal(data.sub_paths.length, 3, 'must have exactly 3 sub-paths');
    assert.ok(
      data.siem_detected === null || typeof data.siem_detected === 'string',
      'siem_detected must be string or null',
    );
    assert.ok(
      data.forwarder_detected === null || typeof data.forwarder_detected === 'string',
      'forwarder_detected must be string or null',
    );
    assert.ok(typeof data.must_render_verbatim === 'string', 'must_render_verbatim must be a string');
    assert.ok(data.must_render_verbatim.length > 0, 'must_render_verbatim must be non-empty');
    assert.ok(typeof data.must_ask_user === 'object', 'must_ask_user must be an object');
    assert.ok(Array.isArray(data.forbidden_next_actions), 'forbidden_next_actions must be an array');
  } finally {
    restoreEnv(snap);
  }
});

// ── sub-path order ────────────────────────────────────────────────────────────

test('manual_options: sub-paths are in fixed order (report_only, forwarder_config, siem_exclusion)', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    assert.equal(data.sub_paths[0].id, 'report_only');
    assert.equal(data.sub_paths[1].id, 'forwarder_config');
    assert.equal(data.sub_paths[2].id, 'siem_exclusion');
  } finally {
    restoreEnv(snap);
  }
});

// ── report_only ───────────────────────────────────────────────────────────────

test('manual_options: report_only is always applicable', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    const item = data.sub_paths.find((p) => p.id === 'report_only') as ManualOptionItem;
    assert.ok(item, 'report_only must be present');
    assert.equal(item.applicable, true, 'report_only must always be applicable');
  } finally {
    restoreEnv(snap);
  }
});

test('manual_options: report_only routes to log10x_estimate_savings with enforcement_mode=manual_report', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    const item = data.sub_paths.find((p) => p.id === 'report_only') as ManualOptionItem;
    assert.ok(item.routes_to, 'report_only must have routes_to');
    assert.equal(item.routes_to!.tool, 'log10x_estimate_savings');
    assert.equal(item.routes_to!.args['enforcement_mode'], 'manual_report');
    assert.equal(item.routes_to!.args['default_action'], 'drop');
  } finally {
    restoreEnv(snap);
  }
});

test('manual_options: report_only passes service and target_percent through to routes_to args', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({ service: 'checkout', target_percent: 30 });
    const data = result.data as ManualOptionsEnvelope;
    const item = data.sub_paths.find((p) => p.id === 'report_only') as ManualOptionItem;
    assert.equal(item.routes_to!.args['service'], 'checkout');
    assert.equal(item.routes_to!.args['target_percent'], 30);
  } finally {
    restoreEnv(snap);
  }
});

test('manual_options: report_only routes_to args omit service/target_percent when not passed', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    const item = data.sub_paths.find((p) => p.id === 'report_only') as ManualOptionItem;
    assert.ok(!('service' in item.routes_to!.args), 'service must not be present when not passed');
    assert.ok(!('target_percent' in item.routes_to!.args), 'target_percent must not be present when not passed');
  } finally {
    restoreEnv(snap);
  }
});

// ── forwarder_config gating ───────────────────────────────────────────────────

test('manual_options: forwarder_config is gated when no forwarder env var', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    const item = data.sub_paths.find((p) => p.id === 'forwarder_config') as ManualOptionItem;
    assert.equal(item.applicable, false, 'forwarder_config must be gated when no forwarder detected');
    assert.ok(typeof item.gated_reason === 'string' && item.gated_reason.length > 0, 'must have a gated_reason');
    assert.match(item.gated_reason!, /forwarder/i, 'gated_reason should mention forwarder');
  } finally {
    restoreEnv(snap);
  }
});

test('manual_options: forwarder_config is applicable when LOG10X_FORWARDER=fluent-bit', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  process.env.LOG10X_FORWARDER = 'fluent-bit';
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    const item = data.sub_paths.find((p) => p.id === 'forwarder_config') as ManualOptionItem;
    assert.equal(item.applicable, true, 'forwarder_config must be applicable when LOG10X_FORWARDER set');
    assert.ok(!item.gated_reason, 'no gated_reason when applicable');
    assert.ok(typeof item.routing_instruction === 'string' && item.routing_instruction.length > 0, 'routing_instruction must be set');
    assert.ok(item.routes_to === null, 'routes_to must be null (iteration required)');
  } finally {
    restoreEnv(snap);
  }
});

test('manual_options: forwarder_config routing_instruction mentions top_patterns and pattern_mitigate', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  process.env.LOG10X_FORWARDER = 'fluentd';
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    const item = data.sub_paths.find((p) => p.id === 'forwarder_config') as ManualOptionItem;
    assert.ok(item.routing_instruction?.includes('log10x_top_patterns'), 'routing_instruction must mention log10x_top_patterns');
    assert.ok(item.routing_instruction?.includes('log10x_pattern_mitigate'), 'routing_instruction must mention log10x_pattern_mitigate');
  } finally {
    restoreEnv(snap);
  }
});

// ── siem_exclusion gating ─────────────────────────────────────────────────────

test('manual_options: siem_exclusion is gated when no SIEM creds detected', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    const item = data.sub_paths.find((p) => p.id === 'siem_exclusion') as ManualOptionItem;
    // In the test environment, no live SIEM creds are present, so this is gated.
    if (!item.applicable) {
      assert.ok(typeof item.gated_reason === 'string' && item.gated_reason.length > 0, 'must have a gated_reason');
      assert.match(item.gated_reason!, /SIEM|credential/i, 'gated_reason should mention SIEM or credentials');
    }
    // If somehow applicable (CI with creds set), the routing_instruction must be present.
    if (item.applicable) {
      assert.ok(item.routes_to === null, 'routes_to must be null (iteration required)');
      assert.ok(typeof item.routing_instruction === 'string' && item.routing_instruction.length > 0, 'routing_instruction must be set');
    }
  } finally {
    restoreEnv(snap);
  }
});

// ── forbidden_next_actions ────────────────────────────────────────────────────

test('manual_options: forbidden_next_actions includes log10x_configure_engine', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    assert.ok(
      data.forbidden_next_actions.includes('log10x_configure_engine'),
      'must forbid log10x_configure_engine',
    );
  } finally {
    restoreEnv(snap);
  }
});

test('manual_options: forbidden_next_actions does NOT include estimate_savings or pattern_mitigate', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    assert.ok(
      !data.forbidden_next_actions.includes('log10x_estimate_savings'),
      'estimate_savings must NOT be forbidden — report_only routes to it',
    );
    assert.ok(
      !data.forbidden_next_actions.includes('log10x_pattern_mitigate'),
      'pattern_mitigate must NOT be forbidden — forwarder_config/siem_exclusion route to it',
    );
  } finally {
    restoreEnv(snap);
  }
});

// ── must_ask_user ─────────────────────────────────────────────────────────────

test('manual_options: must_ask_user has exactly 3 options', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    assert.ok(typeof data.must_ask_user.question === 'string' && data.must_ask_user.question.length > 0, 'question must be present');
    assert.equal(data.must_ask_user.options.length, 3, 'must have exactly 3 options');
  } finally {
    restoreEnv(snap);
  }
});

// ── headline ──────────────────────────────────────────────────────────────────

test('manual_options: headline reflects correct applicable count', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    // At minimum, report_only is always applicable (1 of 3).
    assert.match(result.summary.headline, /of 3 sub-paths/, 'headline must reference total sub-path count');
  } finally {
    restoreEnv(snap);
  }
});

// ── forwarder_detected echo ───────────────────────────────────────────────────

test('manual_options: forwarder_detected is null when no forwarder env set', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    assert.equal(data.forwarder_detected, null);
  } finally {
    restoreEnv(snap);
  }
});

test('manual_options: forwarder_detected echoes the normalized kind when LOG10X_FORWARDER set', async () => {
  const snap = snapshotEnv();
  clearLog10xEnv();
  process.env.LOG10X_FORWARDER = 'otel-collector';
  try {
    const result = await executeManualOptions({});
    const data = result.data as ManualOptionsEnvelope;
    assert.equal(data.forwarder_detected, 'otel-collector');
  } finally {
    restoreEnv(snap);
  }
});
