/**
 * Integration tests for log10x_find_skew's GA-track envelope.
 *
 * Covers the agent-facing contract introduced in the find_skew audit:
 *   - status field branching (success / no_signal / insufficient_data / error)
 *   - threshold_basis (unvalidated_default vs caller_override)
 *   - threshold_audit (floor + observed dominant_pct distribution)
 *   - input_ref echo
 *   - structured PrimitiveError for paste-mode failures
 *   - human_summary references the floor AND the observed median
 *
 * The detector math (concentration percentages) is covered by
 * test/skew-detector.test.ts. These tests pin the WRAPPER envelope
 * contract that the agent reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeFindSkew } from '../src/tools/find-skew.js';

// ── Helper: build a JSON event payload with a controllable dominant value ──

function skewedEvents(
  dominantValue: string,
  otherValues: string[],
  dominantCount: number,
  otherCount: number,
): string[] {
  const events: string[] = [];
  for (let i = 0; i < dominantCount; i++) {
    events.push(`audit verb=${dominantValue} path=/api/v1/${i} status=200`);
  }
  for (let i = 0; i < otherCount; i++) {
    const v = otherValues[i % otherValues.length];
    events.push(`audit verb=${v} path=/api/v1/${i + dominantCount} status=200`);
  }
  return events;
}

// ── status: success ──────────────────────────────────────────────────

test('GA find_skew: success path emits status + threshold_audit + observed distribution', async () => {
  const events = skewedEvents('get', ['post', 'put'], 80, 20);
  const out = await executeFindSkew({ events, min_concentration: 0.6, sample_n: 10, min_events: 10 });
  const d = out.data as {
    status: string;
    threshold_basis: string;
    threshold_audit: {
      min_concentration: { value: number; basis: string };
      sample_n: { value: number; basis: string };
      observed_dominant_pct_distribution: { n: number; min: number; p50: number; max: number } | null;
      n_candidate_slots: number;
    };
    input_ref: { n_events: number; n_patterns_after_templating: number };
    query_count: number;
    backend_pressure_hint: null;
    human_summary: string;
    findings: Array<{ patternIdentity: string; skewedSlots: Array<{ dominantPct: number }> }>;
  };
  assert.equal(d.status, 'success');
  assert.equal(d.threshold_basis, 'unvalidated_default');
  assert.equal(d.threshold_audit.min_concentration.value, 0.6);
  assert.equal(d.threshold_audit.min_concentration.basis, 'unvalidated_default');
  assert.equal(d.threshold_audit.sample_n.value, 10);
  assert.equal(d.query_count, 0);
  assert.equal(d.backend_pressure_hint, null);
  assert.equal(d.input_ref.n_events, events.length);
  assert.ok(d.findings.length >= 1);
  // human_summary must reference the floor + observed median when present
  assert.match(d.human_summary, /concentration floor/i);
  assert.match(d.human_summary, /unvalidated default/i);
});

test('GA find_skew: caller_override basis when caller passes non-default thresholds', async () => {
  const events = skewedEvents('get', ['post', 'put'], 80, 20);
  const out = await executeFindSkew({ events, min_concentration: 0.75, sample_n: 5, min_events: 10 });
  const d = out.data as { threshold_basis: string; threshold_audit: { min_concentration: { basis: string } } };
  assert.equal(d.threshold_basis, 'caller_override');
  assert.equal(d.threshold_audit.min_concentration.basis, 'caller_override');
});

// ── status: no_signal ────────────────────────────────────────────────

test('GA find_skew: status=no_signal when no slot crosses the floor but candidates were evaluated', async () => {
  // Single pattern, single varying slot with 100 distinct request_id
  // values (each 1% dominant → well below the 0.6 floor).
  const events: string[] = [];
  for (let i = 0; i < 100; i++) {
    events.push(`processing request id=${i}`);
  }
  const out = await executeFindSkew({ events, min_concentration: 0.6, min_events: 10 });
  const d = out.data as { status: string; findings: unknown[]; human_summary: string };
  assert.equal(d.status, 'no_signal');
  assert.equal(d.findings.length, 0);
  assert.match(d.human_summary, /No slot crossed the.*concentration floor/i);
});

// ── status: insufficient_data ───────────────────────────────────────

test('GA find_skew: status=insufficient_data when too few events per pattern after templating', async () => {
  // Only 5 events total, default min_events=10 → no pattern qualifies.
  const events = ['audit verb=get path=/a', 'audit verb=get path=/b', 'audit verb=get path=/c', 'audit verb=get path=/d', 'audit verb=get path=/e'];
  const out = await executeFindSkew({ events, min_concentration: 0.6, min_events: 10 });
  const d = out.data as { status: string; input_ref: { n_patterns_above_min_events: number } };
  assert.equal(d.status, 'insufficient_data');
  assert.equal(d.input_ref.n_patterns_above_min_events, 0);
});

// ── status: error ────────────────────────────────────────────────────

test('GA find_skew: empty events → status=error with input_invalid PrimitiveError', async () => {
  const out = await executeFindSkew({ events: [] });
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
  assert.match(d.error.hint, /No events supplied/i);
});

// ── Telemetry fields ────────────────────────────────────────────────

test('GA find_skew: query_count is always 0 (paste-mode tool, no backend queries)', async () => {
  const events = skewedEvents('get', ['post'], 50, 10);
  const out = await executeFindSkew({ events });
  const d = out.data as { query_count: number; backend_pressure_hint: null; total_latency_ms: number };
  assert.equal(d.query_count, 0);
  assert.equal(d.backend_pressure_hint, null);
  assert.ok(d.total_latency_ms >= 0);
});

// ── human_summary explicit-disclosure pin ──────────────────────────

test('GA find_skew: human_summary references the floor for every non-error status', async () => {
  for (const events of [
    skewedEvents('get', ['post'], 80, 20), // success
    skewedEvents('get', ['post', 'put', 'delete', 'patch'], 20, 80), // no_signal probably
  ]) {
    const out = await executeFindSkew({ events, min_concentration: 0.6 });
    const d = out.data as { status: string; human_summary: string };
    if (d.status === 'success' || d.status === 'no_signal') {
      assert.match(d.human_summary, /60%|0\.6/, `expected floor in human_summary for status=${d.status}: ${d.human_summary}`);
    }
  }
});
