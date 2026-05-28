/**
 * Unit tests for the three GA-track helpers:
 *   - computeAnchorDispersion / hasPhaseSeparation
 *   - canonicalMetricRef
 *   - wrapBackendError
 *
 * Each helper is pure (no I/O, no env), so fixtures pin behavior exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAnchorDispersion,
  hasPhaseSeparation,
  ANCHOR_DISPERSION_FLOOR,
} from '../src/lib/anchor-dispersion.js';
import { canonicalMetricRef } from '../src/lib/metric-ref.js';
import { wrapBackendError } from '../src/lib/primitive-errors.js';

// ── computeAnchorDispersion ──────────────────────────────────────────

test('computeAnchorDispersion: empty input → 0 (no separation)', () => {
  assert.equal(computeAnchorDispersion([]), 0);
});

test('computeAnchorDispersion: single value → 0 (no spread)', () => {
  assert.equal(computeAnchorDispersion([5]), 0);
});

test('computeAnchorDispersion: all-zero series → 0 (degenerate)', () => {
  // median = 0 → guard returns 0 to avoid div-by-zero.
  assert.equal(computeAnchorDispersion([0, 0, 0, 0]), 0);
});

test('computeAnchorDispersion: flat non-zero series → 0', () => {
  assert.equal(computeAnchorDispersion([5, 5, 5, 5, 5]), 0);
});

test('computeAnchorDispersion: 50/50 bimodal series → high dispersion (well above floor)', () => {
  // Half at 1, half at 10. Median = 10 (upper-half pick), abs-deviations
  // = [9,9,9,9,9, 0,0,0,0,0], median of those = 9, so MAD/median = 0.9.
  // A clean step function correctly registers as having strong phase
  // separation — exactly what the anchor-dispersion guard is supposed
  // to let through.
  const v = [1, 1, 1, 1, 1, 10, 10, 10, 10, 10];
  const d = computeAnchorDispersion(v);
  assert.ok(d > 0.5, `expected high dispersion on bimodal series, got ${d}`);
});

test('computeAnchorDispersion: realistic chaos-shape series → comfortably above floor', () => {
  // Slow ramp from quiet to busy and back. Median sits in the middle;
  // most points deviate from it. MAD/median is high.
  const v = [2, 2, 5, 10, 20, 32, 32, 30, 18, 8, 3, 2];
  const d = computeAnchorDispersion(v);
  assert.ok(d > ANCHOR_DISPERSION_FLOOR, `expected dispersion > ${ANCHOR_DISPERSION_FLOOR}, got ${d}`);
});

test('hasPhaseSeparation: borderline cases pinned at the 0.15 floor', () => {
  // Hand-crafted: median = 10, abs-deviations sorted = [..., 1, 1, 1, 1, 2, 2, 2, 2].
  // We just need a series where MAD/median crosses ~0.15.
  const justAbove = [8, 9, 10, 10, 11, 12, 13, 14]; // median=10, MAD~2/10=0.20
  assert.equal(hasPhaseSeparation(justAbove), true);
  const justBelow = [10, 10, 10, 10, 11, 11, 11, 11]; // median=10, MAD~0.5/10=0.05
  assert.equal(hasPhaseSeparation(justBelow), false);
});

// ── canonicalMetricRef ───────────────────────────────────────────────

test('canonicalMetricRef: idempotent', () => {
  const expr = 'rate(http_requests_total{job="api"}[5m])';
  const once = canonicalMetricRef(expr);
  const twice = canonicalMetricRef(once);
  assert.equal(once, twice);
});

test('canonicalMetricRef: collapses whitespace runs', () => {
  const messy = '  rate( http_requests_total{job="api"}   [5m] )  ';
  const clean = canonicalMetricRef(messy);
  assert.equal(clean, 'rate( http_requests_total{job="api"} [5m] )');
});

test('canonicalMetricRef: preserves label order inside braces', () => {
  // We DO NOT sort labels — backend echoes affect order, sorting would
  // break round-trips. Same input order → same output order.
  const a = '{a="1",b="2",c="3"}';
  const b = '{c="3",b="2",a="1"}';
  assert.notEqual(canonicalMetricRef(a), canonicalMetricRef(b));
  assert.equal(canonicalMetricRef(a), '{a="1",b="2",c="3"}');
});

test('canonicalMetricRef: distinguishes equality matchers from regex matchers', () => {
  // up{job="x"} and up{job=~"x"} are semantically different in PromQL
  // (the latter is a regex match). They must produce different refs.
  const eq = canonicalMetricRef('up{job="x"}');
  const re = canonicalMetricRef('up{job=~"x"}');
  assert.notEqual(eq, re);
});

test('canonicalMetricRef: empty string passes through', () => {
  assert.equal(canonicalMetricRef(''), '');
});

// ── wrapBackendError ─────────────────────────────────────────────────

test('wrapBackendError: HTTP 503 → backend_unavailable, retryable, 2s backoff', () => {
  const err = new Error('generic_prom HTTP 503: Service Unavailable');
  const wrapped = wrapBackendError(err);
  assert.equal(wrapped.error_type, 'backend_unavailable');
  assert.equal(wrapped.retryable, true);
  assert.equal(wrapped.suggested_backoff_ms, 2000);
});

test('wrapBackendError: HTTP 502 + 504 also map to backend_unavailable', () => {
  for (const code of [502, 504]) {
    const wrapped = wrapBackendError(new Error(`HTTP ${code}: gateway`));
    assert.equal(wrapped.error_type, 'backend_unavailable');
    assert.equal(wrapped.retryable, true);
  }
});

test('wrapBackendError: HTTP 429 → backend_timeout, longer backoff than 408', () => {
  const rate = wrapBackendError(new Error('HTTP 429: too many requests'));
  const tout = wrapBackendError(new Error('HTTP 408: request timeout'));
  assert.equal(rate.error_type, 'backend_timeout');
  assert.equal(tout.error_type, 'backend_timeout');
  assert.ok(
    (rate.suggested_backoff_ms ?? 0) > (tout.suggested_backoff_ms ?? 0),
    'rate-limit backoff should exceed simple-timeout backoff',
  );
});

test('wrapBackendError: HTTP 400/422 → schema_invalid, NOT retryable', () => {
  for (const code of [400, 422]) {
    const wrapped = wrapBackendError(new Error(`HTTP ${code}: bad request`));
    assert.equal(wrapped.error_type, 'schema_invalid');
    assert.equal(wrapped.retryable, false);
    assert.equal(wrapped.suggested_backoff_ms, null);
  }
});

test('wrapBackendError: HTTP 404 → anchor_not_found, NOT retryable', () => {
  const wrapped = wrapBackendError(new Error('HTTP 404: not found'));
  assert.equal(wrapped.error_type, 'anchor_not_found');
  assert.equal(wrapped.retryable, false);
});

test('wrapBackendError: network-level failure → backend_unavailable, retryable', () => {
  for (const msg of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND host.example', 'fetch failed']) {
    const wrapped = wrapBackendError(new Error(msg));
    assert.equal(wrapped.error_type, 'backend_unavailable');
    assert.equal(wrapped.retryable, true);
  }
});

test('wrapBackendError: unrecognized error → unknown, NOT retryable', () => {
  const wrapped = wrapBackendError(new Error('something went wrong'));
  assert.equal(wrapped.error_type, 'unknown');
  assert.equal(wrapped.retryable, false);
  assert.equal(wrapped.suggested_backoff_ms, null);
});

test('wrapBackendError: accepts a thrown string, not just an Error', () => {
  // GenericPromBackend.fetchJson throws `new Error(...)`, but defensive
  // wrapping handles the bare-string case too.
  const wrapped = wrapBackendError('HTTP 503: unavailable');
  assert.equal(wrapped.error_type, 'backend_unavailable');
});
