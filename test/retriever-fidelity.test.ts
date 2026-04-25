import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFidelityArg,
  subWindowCount,
  fallbackByWindow,
  extractPatternName,
  timeExprToMs,
  decideFidelity,
  DEFAULT_K,
  MAX_SUB_WINDOWS,
  FULL_MODE_EVENT_THRESHOLD,
  REFUSAL_EVENT_THRESHOLD,
} from '../src/lib/retriever-fidelity.js';
import type { EnvConfig } from '../src/lib/environments.js';

const fakeEnv: EnvConfig = {
  apiKey: 'test-key',
  envId: 'test-env',
  nickname: 'test',
} as EnvConfig;

// ─── parseFidelityArg ────────────────────────────────────────────────

test('parseFidelityArg defaults to auto with K=1000', () => {
  assert.deepEqual(parseFidelityArg(undefined), { forced: undefined, k: DEFAULT_K });
  assert.deepEqual(parseFidelityArg('auto'), { forced: undefined, k: DEFAULT_K });
});

test('parseFidelityArg forces full mode', () => {
  assert.deepEqual(parseFidelityArg('full'), { forced: 'full', k: DEFAULT_K });
});

test('parseFidelityArg forces sampled mode with default K', () => {
  assert.deepEqual(parseFidelityArg('per_window_sampled'), {
    forced: 'per_window_sampled',
    k: DEFAULT_K,
  });
});

test('parseFidelityArg forces sampled mode with explicit K', () => {
  assert.deepEqual(parseFidelityArg('per_window_sampled:500'), {
    forced: 'per_window_sampled',
    k: 500,
  });
});

test('parseFidelityArg rejects invalid values', () => {
  assert.throws(() => parseFidelityArg('garbage'));
  assert.throws(() => parseFidelityArg('per_window_sampled:0'));
  assert.throws(() => parseFidelityArg('per_window_sampled:-5'));
});

// ─── subWindowCount ──────────────────────────────────────────────────

test('subWindowCount: 30d window splits per-day', () => {
  const ms = 30 * 86_400_000;
  assert.equal(subWindowCount(ms), 30);
});

test('subWindowCount: 7d window splits per-day', () => {
  const ms = 7 * 86_400_000;
  assert.equal(subWindowCount(ms), 7);
});

test('subWindowCount: 24h window splits per-hour', () => {
  const ms = 24 * 3_600_000;
  assert.equal(subWindowCount(ms), 24);
});

test('subWindowCount: 1h window splits per-15min', () => {
  const ms = 60 * 60_000;
  assert.equal(subWindowCount(ms), 4);
});

test('subWindowCount: capped at MAX_SUB_WINDOWS', () => {
  const ms = 365 * 86_400_000; // 1 year
  assert.equal(subWindowCount(ms), MAX_SUB_WINDOWS);
});

test('subWindowCount: tiny window still returns 1', () => {
  assert.equal(subWindowCount(60_000), 1);
});

// ─── fallbackByWindow ────────────────────────────────────────────────

test('fallbackByWindow: ≤4h is full', () => {
  assert.equal(fallbackByWindow(4 * 3_600_000).mode, 'full');
  assert.equal(fallbackByWindow(60 * 60_000).mode, 'full');
});

test('fallbackByWindow: >4h is sampled (no Reporter signal → conservative)', () => {
  assert.equal(fallbackByWindow(6 * 3_600_000).mode, 'per_window_sampled');
  assert.equal(fallbackByWindow(24 * 3_600_000).mode, 'per_window_sampled');
  assert.equal(fallbackByWindow(7 * 86_400_000).mode, 'per_window_sampled');
});

// ─── extractPatternName ──────────────────────────────────────────────

test('extractPatternName: pulls value from equality', () => {
  assert.equal(
    extractPatternName('tenx_user_pattern == "PaymentRetry"'),
    'PaymentRetry'
  );
  assert.equal(
    extractPatternName('tenx_user_pattern=="X"'),
    'X'
  );
});

test('extractPatternName: AND combinations still find pattern', () => {
  assert.equal(
    extractPatternName('severity_level=="ERROR" && tenx_user_pattern == "DBTimeout"'),
    'DBTimeout'
  );
});

test('extractPatternName: returns undefined when absent', () => {
  assert.equal(extractPatternName('severity_level=="ERROR"'), undefined);
  assert.equal(extractPatternName(undefined), undefined);
  assert.equal(extractPatternName(''), undefined);
});

// ─── timeExprToMs ────────────────────────────────────────────────────

test('timeExprToMs: now', () => {
  const now = 1_700_000_000_000;
  assert.equal(timeExprToMs('now', now), now);
});

test('timeExprToMs: relative now-1h', () => {
  const now = 1_700_000_000_000;
  assert.equal(timeExprToMs('now-1h', now), now - 3_600_000);
});

test('timeExprToMs: relative now-30d', () => {
  const now = 1_700_000_000_000;
  assert.equal(timeExprToMs('now-30d', now), now - 30 * 86_400_000);
});

test('timeExprToMs: now("-1h") form', () => {
  const now = 1_700_000_000_000;
  assert.equal(timeExprToMs('now("-1h")', now), now - 3_600_000);
});

test('timeExprToMs: epoch ms passes through', () => {
  assert.equal(timeExprToMs('1700000000000'), 1_700_000_000_000);
});

test('timeExprToMs: ISO8601', () => {
  assert.equal(timeExprToMs('2024-01-01T00:00:00Z'), Date.parse('2024-01-01T00:00:00Z'));
});

test('timeExprToMs: throws on garbage', () => {
  assert.throws(() => timeExprToMs('not-a-date'));
});

// ─── decideFidelity (forced paths — no Reporter call) ────────────────

test('decideFidelity: forced full bypasses heuristic', async () => {
  const d = await decideFidelity(fakeEnv, {
    search: 'tenx_user_pattern == "X"',
    windowMs: 30 * 86_400_000,
    forced: 'full',
    k: DEFAULT_K,
  });
  assert.equal(d.mode, 'full');
  assert.equal(d.reason, 'forced_full');
});

test('decideFidelity: forced sampled gets sub-window plan', async () => {
  const d = await decideFidelity(fakeEnv, {
    search: undefined,
    windowMs: 7 * 86_400_000,
    forced: 'per_window_sampled',
    k: 500,
  });
  assert.equal(d.mode, 'per_window_sampled');
  if (d.mode !== 'per_window_sampled') return;
  assert.equal(d.subWindows, 7);
  assert.equal(d.eventsPerSubWindow, 500);
  assert.equal(d.reason, 'forced_per_window_sampled');
});

// ─── decideFidelity (Reporter-driven, mocked queryInstant) ───────────
// We can't easily mock the Reporter call without dependency injection, but
// the no-Reporter fallback path runs without one (extractPatternName returns
// undefined → fetchReporterPatternStats short-circuits before the HTTP call).

test('decideFidelity: no pattern in search → short-fallback for short window', async () => {
  const d = await decideFidelity(fakeEnv, {
    search: 'severity_level == "ERROR"', // no tenx_user_pattern
    windowMs: 2 * 3_600_000, // 2h
    forced: undefined,
    k: DEFAULT_K,
  });
  assert.equal(d.mode, 'full');
  assert.equal(d.reason, 'window_length_short_fallback');
});

test('decideFidelity: no pattern in search → long-fallback for long window', async () => {
  const d = await decideFidelity(fakeEnv, {
    search: undefined,
    windowMs: 30 * 86_400_000, // 30d
    forced: undefined,
    k: DEFAULT_K,
  });
  assert.equal(d.mode, 'per_window_sampled');
  assert.equal(d.reason, 'window_length_long_fallback');
  if (d.mode !== 'per_window_sampled') return;
  assert.equal(d.subWindows, 30);
  assert.equal(d.eventsPerSubWindow, DEFAULT_K);
});

// ─── Threshold sanity ────────────────────────────────────────────────

test('thresholds: refusal > full-mode event threshold', () => {
  assert.ok(REFUSAL_EVENT_THRESHOLD > FULL_MODE_EVENT_THRESHOLD);
});
