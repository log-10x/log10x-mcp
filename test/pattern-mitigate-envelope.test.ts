/**
 * Integration tests for log10x_pattern_mitigate's GA-track envelope.
 *
 * Covers the agent-facing contract for the action-shaped tool:
 *   - status (success / no_signal / insufficient_data / error)
 *   - recommendation_basis (env_config / snapshot / env_vars_only / unknown)
 *   - recommendation_audit (per-capability sources + snapshot age)
 *   - pattern_ref echo
 *   - input_invalid PrimitiveError on empty pattern
 *   - human_summary always references basis + enabled count
 *
 * Doesn't exercise: actual GitOps PR generation, dependency_check
 * routing, or sub-tool dispatch. Those live in the wrappee tools.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePatternMitigate } from '../src/tools/pattern-mitigate.js';

// Each test snapshots the relevant env vars + envs.json side-effects so
// concurrent test runs don't poison each other.
const LOG10X_KEYS_TO_CLEAR = [
  'LOG10X_GH_REPO',
  'LOG10X_FORWARDER',
  'LOG10X_ANALYZER',
  'LOG10X_METRICS_BACKEND_KIND',
  'LOG10X_METRICS_URL',
  'LOG10X_CUSTOMER_METRICS_URL',
  'LOG10X_CUSTOMER_METRICS_TYPE',
  'LOG10X_API_KEY',
  'LOG10X_ENV_ID',
];
function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = { HOME: process.env.HOME };
  for (const k of LOG10X_KEYS_TO_CLEAR) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(s: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function clearAllLog10xEnv() {
  for (const k of LOG10X_KEYS_TO_CLEAR) delete process.env[k];
}

// ── status: error (input_invalid) ────────────────────────────────────

test('GA pattern_mitigate: empty pattern → status=error with input_invalid PrimitiveError', async () => {
  const out = await executePatternMitigate({ pattern: '' });
  if (typeof out === 'string') throw new Error('expected envelope');
  // Error path emits a chassis-native error envelope: status + error live
  // flat on data; there is no payload body (no recommendation_basis / pattern_ref).
  const d = out.data as {
    status: string;
    error?: { error_type: string; retryable: boolean; suggested_backoff_ms: number | null; hint: string };
  };
  assert.equal(d.status, 'error');
  assert.ok(d.error);
  if (!d.error) return;
  assert.equal(d.error.error_type, 'input_invalid');
  assert.equal(d.error.retryable, false);
  assert.equal(d.error.suggested_backoff_ms, null);
  assert.match(d.error.hint, /pattern argument required/i);
});

test('GA pattern_mitigate: whitespace-only pattern → status=error', async () => {
  const out = await executePatternMitigate({ pattern: '   ' });
  if (typeof out === 'string') throw new Error('expected envelope');
  const d = out.data as { status: string; error?: { error_type: string } };
  assert.equal(d.status, 'error');
  assert.equal(d.error?.error_type, 'input_invalid');
});

// ── status: no_signal (no env config, no env vars, no snapshot) ──────

test('GA pattern_mitigate: envelope shape — recommendation_audit + status valid for any env state', async () => {
  // We can't reliably isolate from the local ~/.log10x/credentials +
  // envs.json that loadEnvironments() reads, so we pin SHAPE (every
  // envelope must have status/basis/audit/sources) not specific values.
  const out = await executePatternMitigate({ pattern: 'payment_gateway_timeout' });
  if (typeof out === 'string') throw new Error('expected envelope');
  // status lives flat on data (chassis); the result body lives under data.payload.
  const top = out.data as { status: string };
  const d = (out.data as { payload: unknown }).payload as {
    recommendation_basis: string;
    recommendation_audit: {
      basis: string;
      n_options_enabled: number;
      n_options_dimmed: number;
      capability_sources: { gitops: string; forwarder: string; analyzer: string; receiver: string; retriever: string; receiver_in_path: string };
      snapshot_age_seconds: number | null;
    };
  };
  assert.ok(['success', 'no_signal', 'insufficient_data', 'error'].includes(top.status));
  assert.ok(
    ['env_config', 'env_config_plus_snapshot', 'snapshot', 'env_vars_only', 'unknown'].includes(d.recommendation_basis),
  );
  assert.equal(d.recommendation_audit.n_options_enabled + d.recommendation_audit.n_options_dimmed, 4);
  for (const key of ['gitops', 'forwarder', 'analyzer'] as const) {
    assert.ok(
      ['envs_json', 'env_var', 'snapshot', 'siem_probe', 'absent'].includes(d.recommendation_audit.capability_sources[key]),
    );
  }
  for (const key of ['receiver', 'retriever', 'receiver_in_path'] as const) {
    assert.ok(['snapshot', 'siem_probe', 'absent'].includes(d.recommendation_audit.capability_sources[key]));
  }
});

// ── Receiver-gating tests ────────────────────────────────────────────

test('GA pattern_mitigate: drop options are gated on the resolved receiver_in_path evidence', async () => {
  const before = snapshotEnv();
  clearAllLog10xEnv();
  // No snapshot_id and no env evidence. receiver_in_path is then resolved
  // by the SIEM-probe path (Fix A): a live tenx_hash hit in recent events
  // confirms the Receiver is in-path even without a snapshot. So the drop
  // options are gated on the resolved evidence, not on snapshot presence.
  process.env.LOG10X_GH_REPO = 'acme/config';
  try {
    const out = await executePatternMitigate({ pattern: 'payment_gateway_timeout' });
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = (out.data as { payload: unknown }).payload as {
      options: Array<{ id: string; enabled: boolean; disabled_reason?: string }>;
      recommendation_audit: { capability_sources: { receiver_in_path: string } };
    };
    const receiverSource = d.recommendation_audit.capability_sources.receiver_in_path;
    const opt1 = d.options.find((o) => o.id === 'drop_at_analyzer')!;
    const opt2 = d.options.find((o) => o.id === 'drop_at_forwarder')!;
    if (receiverSource === 'absent') {
      // No Receiver evidence from snapshot or probe → both drop tiers dimmed,
      // and the disabled_reason must name the missing Receiver capability.
      assert.equal(opt1.enabled, false, 'drop_at_analyzer must be dimmed without Receiver');
      assert.equal(opt2.enabled, false, 'drop_at_forwarder must be dimmed without Receiver');
      assert.ok(opt1.disabled_reason?.includes('Receiver'), 'disabled_reason must mention Receiver');
      assert.ok(opt2.disabled_reason?.includes('Receiver'), 'disabled_reason must mention Receiver');
    } else {
      // Receiver confirmed in-path (snapshot or siem_probe). drop_at_analyzer
      // is reachable; if drop_at_forwarder is still dimmed it must be because
      // the forwarder (not the Receiver) was not detected.
      assert.ok(['snapshot', 'siem_probe'].includes(receiverSource), 'receiver_in_path resolved from evidence');
      assert.equal(opt1.enabled, true, 'drop_at_analyzer must be reachable when Receiver is in-path');
      if (!opt2.enabled) {
        assert.ok(opt2.disabled_reason?.toLowerCase().includes('forwarder'), 'dimmed forwarder option must cite the forwarder');
      }
    }
  } finally {
    restoreEnv(before);
  }
});

test('GA pattern_mitigate: CapabilitySources includes receiver_in_path field', async () => {
  const out = await executePatternMitigate({ pattern: 'some_pattern' });
  if (typeof out === 'string') throw new Error('expected envelope');
  const d = (out.data as { payload: unknown }).payload as {
    recommendation_audit: { capability_sources: { receiver_in_path: string } };
  };
  assert.ok(
    ['snapshot', 'siem_probe', 'absent'].includes(d.recommendation_audit.capability_sources.receiver_in_path),
    'receiver_in_path must be snapshot, siem_probe, or absent',
  );
});

// ── status: success via env_vars_only ────────────────────────────────

test('GA pattern_mitigate: when LOG10X_GH_REPO is set, mute + compact options are enabled and gitops source is reported', async () => {
  const before = snapshotEnv();
  process.env.LOG10X_GH_REPO = 'acme-corp/log-config-' + Date.now();
  try {
    const out = await executePatternMitigate({ pattern: 'payment_gateway_timeout' });
    if (typeof out === 'string') throw new Error('expected envelope');
    // status + human_summary live flat on data (chassis); the body is under data.payload.
    const top = out.data as { status: string; human_summary: string };
    const d = (out.data as { payload: unknown }).payload as {
      env_capabilities: { can_mute: boolean; can_compact: boolean };
      recommendation_audit: { capability_sources: { gitops: string } };
      options: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(top.status, 'success');
    assert.equal(d.env_capabilities.can_mute, true);
    assert.equal(d.env_capabilities.can_compact, true);
    // gitops source is either env_var (if no envs.json) or envs_json (if user has one).
    assert.ok(['env_var', 'envs_json'].includes(d.recommendation_audit.capability_sources.gitops));
    assert.match(top.human_summary, /Agent SHOULD wait/i);
  } finally {
    restoreEnv(before);
  }
});

// ── pattern_ref echo + telemetry fields ──────────────────────────────

test('GA pattern_mitigate: pattern_ref echoes the input, telemetry fields populated', async () => {
  const before = snapshotEnv();
  process.env.LOG10X_GH_REPO = 'a/b';
  try {
    const out = await executePatternMitigate({ pattern: 'cart_cartstore_ValkeyCartStore' });
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = (out.data as { payload: unknown }).payload as {
      pattern_ref: string;
      query_count: number;
      backend_pressure_hint: null;
      total_latency_ms: number;
    };
    assert.equal(d.pattern_ref, 'cart_cartstore_ValkeyCartStore');
    assert.equal(d.query_count, 0);
    assert.equal(d.backend_pressure_hint, null);
    assert.ok(d.total_latency_ms >= 0);
  } finally {
    restoreEnv(before);
  }
});

// ── options shape preserved ─────────────────────────────────────────

test('GA pattern_mitigate: options[] still surfaces id + enabled + label for each of the 4 paths', async () => {
  const before = snapshotEnv();
  process.env.LOG10X_GH_REPO = 'a/b';
  process.env.LOG10X_ANALYZER = 'datadog';
  try {
    const out = await executePatternMitigate({ pattern: 'p' });
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = (out.data as { payload: unknown }).payload as {
      options: Array<{ id: string; enabled: boolean; label: string }>;
    };
    assert.equal(d.options.length, 4);
    const ids = d.options.map((o) => o.id).sort();
    assert.deepEqual(ids, ['compact_at_10x', 'drop_at_analyzer', 'drop_at_forwarder', 'mute_at_10x']);
  } finally {
    restoreEnv(before);
  }
});
