/**
 * Catalog-wide envelope conformance test.
 *
 * Pins that every analytical tool's success-path response carries the
 * shared envelope fields (status, query_count, total_latency_ms,
 * backend_pressure_hint, human_summary). Where a tool wraps its
 * existing `status` field with tool-specific semantics
 * (discover-join's 'joined' / 'no_join_available'), we test the
 * presence of the other unified fields.
 *
 * NOT covered: tools that require a live backend AND aren't paste-mode
 * (top_patterns, top_volume, pattern_trend, event_lookup,
 * pattern_examples, discover_env, discover_labels, customer_metrics_query,
 * dependency_check, services, savings, trend, discover_join, investigate).
 * For these, the build pinning the field's presence is what enforces
 * the contract — the field-name itself is in the source.
 *
 * Tests here cover the paste-mode tools that can run synchronously
 * without backend setup: resolve_batch + extract_templates.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeResolveBatch } from '../src/tools/resolve-batch.js';
import { executeExtractTemplates } from '../src/tools/extract-templates.js';

const UNIFIED_FIELDS = [
  'status',
  'query_count',
  'total_latency_ms',
  'backend_pressure_hint',
  'human_summary',
] as const;

/**
 * Resolve a unified field across both envelope shapes.
 *
 * Chassis-envelope tools (resolve_batch, extract_templates) put the three
 * performance fields (query_count / total_latency_ms / backend_pressure_hint)
 * on the envelope TOP LEVEL under `out.performance`, while status and
 * human_summary live on `out.data`. The legacy buildUnifiedFields tools
 * (poc_from_siem_*) spread all five fields flat onto `out.data` and carry
 * no top-level `performance`. Looking up data-first then performance covers
 * both: status/human_summary resolve from data in both shapes, and the perf
 * fields fall through to out.performance for chassis envelopes.
 */
function unifiedField(out: { data?: unknown; performance?: unknown }, f: string): unknown {
  const data = out.data as Record<string, unknown> | undefined;
  if (data && f in data) return data[f];
  const perf = out.performance as Record<string, unknown> | undefined;
  if (perf && f in perf) return perf[f];
  return undefined;
}

function unifiedFieldPresent(out: { data?: unknown; performance?: unknown }, f: string): boolean {
  const data = out.data as Record<string, unknown> | undefined;
  if (data && f in data) return true;
  const perf = out.performance as Record<string, unknown> | undefined;
  return !!(perf && f in perf);
}

function assertUnifiedFields(out: { data?: unknown; performance?: unknown }, tool: string) {
  for (const f of UNIFIED_FIELDS) {
    assert.ok(unifiedFieldPresent(out, f), `${tool}: missing field "${f}" — envelope conformance broken`);
  }
  const status = unifiedField(out, 'status');
  assert.ok(
    ['success', 'no_signal', 'insufficient_data', 'error'].includes(status as string),
    `${tool}: invalid status value ${String(status)}`,
  );
  assert.equal(typeof unifiedField(out, 'query_count'), 'number');
  const latency = unifiedField(out, 'total_latency_ms');
  assert.equal(typeof latency, 'number');
  assert.ok((latency as number) >= 0);
  const pressure = unifiedField(out, 'backend_pressure_hint');
  assert.ok(
    pressure === null ||
      ['ok', 'slow', 'throttled'].includes(pressure as string),
    `${tool}: invalid backend_pressure_hint ${String(pressure)}`,
  );
  const humanSummary = unifiedField(out, 'human_summary');
  assert.equal(typeof humanSummary, 'string');
  assert.ok((humanSummary as string).length > 0);
}

test('envelope conformance: resolve_batch carries the unified fields on success', async () => {
  const events = [
    'GET /api/users 200',
    'GET /api/users 200',
    'POST /api/orders 201',
    'POST /api/orders 201',
    'GET /api/users 200',
  ];
  const out = await executeResolveBatch({ source: 'events', events, top_n_patterns: 10, include_next_actions: false, privacy_mode: false });
  if (typeof out === 'string') throw new Error('expected envelope');
  assertUnifiedFields(out, 'resolve_batch');
});

test('envelope conformance: extract_templates carries the unified fields on success', async () => {
  const events = [
    'user 123 logged in from 192.168.1.1',
    'user 456 logged in from 192.168.1.2',
    'user 789 logged in from 192.168.1.3',
  ];
  const out = await executeExtractTemplates({ source: 'events', events, top_n: 10 });
  if (typeof out === 'string') throw new Error('expected envelope');
  const d = out.data as Record<string, unknown>;
  // extract_templates ALWAYS runs the local tenx pipeline; with no tenx on the
  // box (e.g. CI) it returns a well-formed not_configured envelope instead of a
  // success one. Accept that graceful-degradation envelope as conformant, and
  // only assert the unified fields on the success path (when tenx is present).
  // The not_configured marker is a chassis envelope: the `not_configured`
  // string + the precondition live under data.payload (data.status itself is
  // the chassis 'error' status). Detect via the payload.
  const payload = d.payload as Record<string, unknown> | undefined;
  if (payload?.status === 'not_configured') {
    assert.equal(typeof payload.precondition, 'string');
  } else {
    assertUnifiedFields(out, 'extract_templates');
  }
});

// ── POC tools ────────────────────────────────────────────────────────

test('envelope conformance: poc_from_siem_status returns structured error on unknown snapshot_id', async () => {
  const { executePocStatus } = await import('../src/tools/poc-from-siem.js');
  const out = await executePocStatus({ snapshot_id: 'nonexistent-id-' + Date.now() });
  if (typeof out === 'string') throw new Error('expected envelope');
  const d = out.data as Record<string, unknown>;
  assertUnifiedFields(out, 'poc_from_siem_status (unknown snapshot)');
  assert.equal(d.status, 'error');
  const err = d.error as { error_type: string; retryable: boolean };
  assert.equal(err.error_type, 'input_invalid');
  assert.equal(err.retryable, false);
});

test('envelope conformance: poc_from_siem_submit returns structured error when SIEM cannot be resolved', async () => {
  const { executePocSubmit } = await import('../src/tools/poc-from-siem.js');
  // No credentials in env, no siem arg → resolveSiemSelection returns 'none' → structured error.
  // We can't reliably test this in CI because the test runner may have credentials configured.
  // We can however pin the SHAPE: if status is 'error', the envelope must carry the unified fields.
  const out = await executePocSubmit({
    siem: 'datadog' as never, // valid SIEM but credentials likely missing in test env
    window: '5m',
    target_event_count: 100,
    max_pull_minutes: 1,
  } as never);
  if (typeof out === 'string') throw new Error('expected envelope');
  const d = out.data as Record<string, unknown>;
  // Either status is 'success' (test env has datadog creds, kicks off pipeline) or 'error'.
  // Both paths must carry the unified field set.
  assertUnifiedFields(out, 'poc_from_siem_submit');
  assert.ok(['success', 'error'].includes(d.status as string));
});
