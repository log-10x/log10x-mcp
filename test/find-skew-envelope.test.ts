/**
 * Integration tests for log10x_find_skew's GA-track chassis envelope.
 *
 * Covers the agent-facing contract introduced in the find_skew audit:
 *   - status field branching (success / no_signal / insufficient_data / error)
 *   - threshold_basis (unvalidated_default vs caller_override)
 *   - threshold_audit (floor + observed dominant_pct distribution)
 *   - input_ref echo
 *   - structured PrimitiveError for paste-mode failures
 *   - human_summary present + honest for every non-error status
 *
 * SHAPE: find_skew returns a ChassisEnvelope (buildChassisEnvelope). The
 * tool-specific summary lives at `out.data.payload.*`; only the chassis
 * meta (status, decisions, source_disclosure, scope, payload, human_summary)
 * sits directly on `out.data`. These tests read the payload accordingly.
 *
 * DETERMINISM: executeFindSkew runs the local templater (extractPatterns),
 * which routes events through the paste Lambda (network) or a local tenx
 * CLI — neither is available in CI/offline, and the paste templater treats
 * literal tokens like `get`/`post` as fixed template text (no `verb` slot),
 * so a hand-crafted event string cannot model intra-pattern slot skew.
 * Instead we inject a synthetic ExtractedPatterns via the `_setExtractPatterns`
 * seam (mirrors commitment-report's `_setVerifyRunner`) and drive the
 * detector with a pattern carrying a genuine variable slot. The detector
 * math itself is covered by test/skew-detector.test.ts.
 *
 * Slot-share math note: aggregateSlotsBySymbolMessage derives the dominant
 * fraction from the COUNT of captured distinct values via a harmonic
 * weight (1/(i+1)); see slot-aggregation.ts countValueOccurrences. Two
 * distinct values → dominant ≈ 0.667 (above the 0.6 floor, distinctCount 2);
 * many distinct values → dominant well below the floor (no_signal).
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeFindSkew, _setExtractPatterns } from '../src/tools/find-skew.js';
import type { ExtractedPattern, ExtractedPatterns } from '../src/lib/pattern-extraction.js';

// ── Chassis-envelope read helper ──────────────────────────────────────
// find_skew returns buildChassisEnvelope(): the tool summary lives at
// out.data.payload.*; chassis meta (status, error, human_summary) sits on
// out.data. `out.data` is typed `unknown` on StructuredOutput, so we cast
// to the chassis read-shape here, once.
type ChassisRead = {
  status: string;
  human_summary: string;
  error?: { error_type: string; retryable: boolean; suggested_backoff_ms: number | null; hint: string };
  payload: Record<string, unknown>;
};
function asChassis(out: { data?: unknown }): ChassisRead {
  return out.data as ChassisRead;
}

// ── Synthetic templater fixtures ──────────────────────────────────────

/**
 * Build a synthetic ExtractedPatterns with one symbol-message pattern whose
 * named slot `verb` carries `distinctValues` captured values. Two values
 * → dominant ≈ 0.667 (above the 0.6 floor); use a positional name to model
 * "no real slot" only when needed (not used here).
 *
 * `count` controls whether the pattern clears min_events.
 */
function syntheticPatterns(opts: {
  slotName: string;
  distinctValues: string[];
  count: number;
}): ExtractedPatterns {
  const pattern: ExtractedPattern = {
    hash: 'tplhash-audit-1',
    symbolMessage: 'audit verb=$ path=$ status=$',
    template: 'audit verb=$ path=$ status=$',
    service: 'audit-service',
    severity: 'INFO',
    count: opts.count,
    bytes: opts.count * 64,
    sampleEvent: 'audit verb=get path=/api/v1/0 status=200',
    variables: { [opts.slotName]: opts.distinctValues },
    slotDistinctCounts: { [opts.slotName]: opts.distinctValues.length },
  };
  return {
    patterns: [pattern],
    totalEvents: opts.count,
    totalBytes: opts.count * 64,
    inputLineCount: opts.count,
    templaterWallTimeMs: 0,
    executionMode: 'paste_lambda',
  };
}

/** Install a fixed synthetic templater result for the next call. */
function stubTemplater(result: ExtractedPatterns): void {
  _setExtractPatterns(async () => result);
}

afterEach(() => {
  _setExtractPatterns(); // reset to the real templater
});

// Any non-empty events array — content is ignored because the templater
// is stubbed. We still pass a plausible-length array so input_ref.n_events
// echoes a real number.
function nEvents(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `audit verb=get path=/api/v1/${i} status=200`);
}

// ── status: success ──────────────────────────────────────────────────

test('GA find_skew: success path emits status + threshold_audit + observed distribution', async () => {
  // Named slot `verb` with two captured values → dominant ≈ 0.667 > 0.6 floor.
  stubTemplater(syntheticPatterns({ slotName: 'verb', distinctValues: ['get', 'post'], count: 100 }));
  const events = nEvents(100);
  const out = await executeFindSkew({ events, min_concentration: 0.6, sample_n: 10, min_events: 10 });
  const c = asChassis(out);
  const p = c.payload as {
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
  assert.equal(c.status, 'success');
  assert.equal(p.status, 'success');
  assert.equal(p.threshold_basis, 'unvalidated_default');
  assert.equal(p.threshold_audit.min_concentration.value, 0.6);
  assert.equal(p.threshold_audit.min_concentration.basis, 'unvalidated_default');
  assert.equal(p.threshold_audit.sample_n.value, 10);
  assert.equal(p.query_count, 0);
  assert.equal(p.backend_pressure_hint, null);
  assert.equal(p.input_ref.n_events, events.length);
  assert.ok(p.findings.length >= 1);
  // The top finding's dominant slot must clear the floor.
  assert.ok(p.findings[0].skewedSlots[0].dominantPct >= 0.6);
  // human_summary is honest, plain-English, and routes to the next tool.
  // (Statistics live in threshold_audit, NOT in prose — see find-skew.ts:424.)
  assert.match(p.human_summary, /found skew on field/i);
  assert.match(p.human_summary, /log10x_pattern_mitigate/);
});

test('GA find_skew: caller_override basis when caller passes non-default thresholds', async () => {
  stubTemplater(syntheticPatterns({ slotName: 'verb', distinctValues: ['get', 'post'], count: 100 }));
  const events = nEvents(100);
  const out = await executeFindSkew({ events, min_concentration: 0.75, sample_n: 5, min_events: 10 });
  const p = asChassis(out).payload as { threshold_basis: string; threshold_audit: { min_concentration: { basis: string } } };
  assert.equal(p.threshold_basis, 'caller_override');
  assert.equal(p.threshold_audit.min_concentration.basis, 'caller_override');
});

// ── status: no_signal ────────────────────────────────────────────────

test('GA find_skew: status=no_signal when no slot crosses the floor but candidates were evaluated', async () => {
  // One pattern, one varying slot with 10 distinct values → harmonic
  // dominant share ≈ 0.34, well below the 0.6 floor. distinctCount > 1
  // so the slot is a real candidate (not a filtered singleton).
  const distinct = Array.from({ length: 10 }, (_, i) => `req-${i}`);
  stubTemplater(syntheticPatterns({ slotName: 'request_id', distinctValues: distinct, count: 100 }));
  const out = await executeFindSkew({ events: nEvents(100), min_concentration: 0.6, min_events: 10 });
  const c = asChassis(out);
  const p = c.payload as { status: string; findings: unknown[]; human_summary: string };
  assert.equal(c.status, 'no_signal');
  assert.equal(p.status, 'no_signal');
  assert.equal(p.findings.length, 0);
  // Honest no-skew copy that routes to pattern_mitigate (no floor number in prose).
  assert.match(p.human_summary, /no skew found/i);
  assert.match(p.human_summary, /log10x_pattern_mitigate/);
});

// ── status: insufficient_data ───────────────────────────────────────

test('GA find_skew: status=insufficient_data when too few events per pattern after templating', async () => {
  // The single pattern has count=5 < default min_events=10 → it is filtered
  // before any slot is evaluated → no pattern clears the bar.
  stubTemplater(syntheticPatterns({ slotName: 'verb', distinctValues: ['get'], count: 5 }));
  const out = await executeFindSkew({ events: nEvents(5), min_concentration: 0.6, min_events: 10 });
  const c = asChassis(out);
  const p = c.payload as { status: string; input_ref: { n_patterns_above_min_events: number } };
  assert.equal(c.status, 'insufficient_data');
  assert.equal(p.status, 'insufficient_data');
  assert.equal(p.input_ref.n_patterns_above_min_events, 0);
});

// ── status: error ────────────────────────────────────────────────────

test('GA find_skew: empty events → status=error with input_invalid PrimitiveError', async () => {
  // Empty input is rejected BEFORE the templater runs, so no stub needed.
  const out = await executeFindSkew({ events: [] });
  const c = asChassis(out);
  const p = c.payload as {
    status: string;
    error?: { error_type: string; retryable: boolean; suggested_backoff_ms: number | null; hint: string };
  };
  assert.equal(c.status, 'error');
  assert.equal(p.status, 'error');
  // The structured error is mirrored onto both data.error and payload.error.
  const err = (c.error ?? p.error)!;
  assert.ok(err);
  assert.equal(err.error_type, 'input_invalid');
  assert.equal(err.retryable, false);
  assert.equal(err.suggested_backoff_ms, null);
  assert.match(err.hint, /No events supplied/i);
});

// ── Telemetry fields ────────────────────────────────────────────────

test('GA find_skew: query_count is always 0 (paste-mode tool, no backend queries)', async () => {
  stubTemplater(syntheticPatterns({ slotName: 'verb', distinctValues: ['get', 'post'], count: 60 }));
  const out = await executeFindSkew({ events: nEvents(60) });
  const p = asChassis(out).payload as { query_count: number; backend_pressure_hint: null; total_latency_ms: number };
  // query_count / backend_pressure_hint live on the payload AND on the
  // top-level performance block of the chassis envelope.
  assert.equal(p.query_count, 0);
  assert.equal(p.backend_pressure_hint, null);
  assert.ok(p.total_latency_ms >= 0);
});

// ── human_summary plain-English disclosure pin ──────────────────────

test('GA find_skew: human_summary is present and plain-English for every non-error status', async () => {
  const cases: Array<{ patterns: ExtractedPatterns; expect: string }> = [
    // success: named slot, two values → above floor.
    { patterns: syntheticPatterns({ slotName: 'verb', distinctValues: ['get', 'post'], count: 100 }), expect: 'success' },
    // no_signal: many distinct values → below floor.
    {
      patterns: syntheticPatterns({
        slotName: 'request_id',
        distinctValues: Array.from({ length: 12 }, (_, i) => `r-${i}`),
        count: 100,
      }),
      expect: 'no_signal',
    },
  ];
  for (const c of cases) {
    stubTemplater(c.patterns);
    const out = await executeFindSkew({ events: nEvents(100), min_concentration: 0.6 });
    const p = asChassis(out).payload as { status: string; human_summary: string };
    assert.equal(p.status, c.expect, `expected status ${c.expect}, got ${p.status}`);
    if (p.status === 'success' || p.status === 'no_signal') {
      // The summary always opens with the plain-English concept line and
      // never leaks the raw floor number into prose (numbers → machine fields).
      assert.match(p.human_summary, /^Skew = when one specific value dominates a field/i,
        `human_summary must lead with the concept for status=${p.status}: ${p.human_summary}`);
      assert.doesNotMatch(p.human_summary, /\bconcentration floor\b/i,
        `human_summary must NOT name the floor in prose for status=${p.status}: ${p.human_summary}`);
    }
  }
});
