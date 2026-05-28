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

function assertUnifiedFields(d: Record<string, unknown>, tool: string) {
  for (const f of UNIFIED_FIELDS) {
    assert.ok(f in d, `${tool}: missing field "${f}" — envelope conformance broken`);
  }
  assert.ok(
    ['success', 'no_signal', 'insufficient_data', 'error'].includes(d.status as string),
    `${tool}: invalid status value ${String(d.status)}`,
  );
  assert.equal(typeof d.query_count, 'number');
  assert.equal(typeof d.total_latency_ms, 'number');
  assert.ok((d.total_latency_ms as number) >= 0);
  assert.ok(
    d.backend_pressure_hint === null ||
      ['ok', 'slow', 'throttled'].includes(d.backend_pressure_hint as string),
    `${tool}: invalid backend_pressure_hint ${String(d.backend_pressure_hint)}`,
  );
  assert.equal(typeof d.human_summary, 'string');
  assert.ok((d.human_summary as string).length > 0);
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
  const d = out.data as Record<string, unknown>;
  assertUnifiedFields(d, 'resolve_batch');
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
  assertUnifiedFields(d, 'extract_templates');
});

// ── POC tools ────────────────────────────────────────────────────────

test('envelope conformance: poc_from_siem_status returns structured error on unknown snapshot_id', async () => {
  const { executePocStatus } = await import('../src/tools/poc-from-siem.js');
  const out = await executePocStatus({ snapshot_id: 'nonexistent-id-' + Date.now() });
  if (typeof out === 'string') throw new Error('expected envelope');
  const d = out.data as Record<string, unknown>;
  assertUnifiedFields(d, 'poc_from_siem_status (unknown snapshot)');
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
  assertUnifiedFields(d, 'poc_from_siem_submit');
  assert.ok(['success', 'error'].includes(d.status as string));
});
