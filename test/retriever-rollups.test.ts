/**
 * Summaries-sourced rollups (lib/retriever-rollups.ts): the multi-dimension
 * reducer the query envelope uses for whole-match by_severity/by_service/
 * by_day, plus the per-dimension coverage detection that gates the
 * events-fallback. Also covers mapWithConcurrencySettled (degrade-to-partial
 * download pool).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSummaryRollups, selectRollups } from '../src/lib/retriever-rollups.js';
import { mapWithConcurrencySettled } from '../src/lib/retriever-api.js';
import type { RetrieverSummary } from '../src/lib/retriever-api.js';

const row = (over: Record<string, unknown>): RetrieverSummary =>
  ({
    sliceFromMs: Date.UTC(2026, 5, 10, 12, 0, 0),
    sliceToMs: Date.UTC(2026, 5, 10, 12, 1, 0),
    summaryVolume: 1,
    summaryBytes: 100,
    ...over,
  }) as unknown as RetrieverSummary;

test('multi-dim reducer: each dimension independently sums summaryVolume', () => {
  const r = computeSummaryRollups([
    row({ summaryVolume: 5, severity_level: 'ERROR', tenx_user_service: 'payment' }),
    row({ summaryVolume: 3, severity_level: 'ERROR', tenx_user_service: 'cart' }),
    row({ summaryVolume: 2, severity_level: 'INFO', tenx_user_service: 'payment' }),
  ]);
  assert.deepEqual(r.by_severity, { ERROR: 8, INFO: 2 });
  assert.deepEqual(r.by_service, { payment: 7, cart: 3 });
  assert.equal(r.total_volume, 10);
  assert.equal(r.total_bytes, 300);
  assert.deepEqual(r.coverage, { severity: true, service: true });
});

test('coverage: dimension absent from every row reports uncovered', () => {
  const r = computeSummaryRollups([
    row({ summaryVolume: 4, severity_level: 'WARN' }), // no service field
    row({ summaryVolume: 6, severity_level: 'ERROR' }),
  ]);
  assert.equal(r.coverage.severity, true);
  assert.equal(r.coverage.service, false);
  // Field-absent volume buckets as 'unknown' (maps sum to total_volume);
  // the coverage flag is what gates the events-fallback, not map emptiness.
  assert.deepEqual(r.by_service, { unknown: 10 });
  assert.equal(r.total_volume, 10);
});

test('by_day attributes volume to the slice lower-bound day', () => {
  const r = computeSummaryRollups([
    row({ summaryVolume: 7, sliceFromMs: Date.UTC(2026, 5, 9, 23, 59, 0) }),
    row({ summaryVolume: 3, sliceFromMs: Date.UTC(2026, 5, 10, 0, 1, 0) }),
  ]);
  assert.deepEqual(r.by_day, { '2026-06-09': 7, '2026-06-10': 3 });
});

test('zero/negative/non-finite volumes are skipped entirely', () => {
  const r = computeSummaryRollups([
    row({ summaryVolume: 0, severity_level: 'ERROR' }),
    row({ summaryVolume: -5, severity_level: 'ERROR' }),
    row({ summaryVolume: Number.NaN, severity_level: 'ERROR' }),
    row({ summaryVolume: 2, severity_level: 'ERROR' }),
  ]);
  assert.equal(r.total_volume, 2);
  assert.deepEqual(r.by_severity, { ERROR: 2 });
});

test('empty input: empty maps, zero totals, nothing covered', () => {
  const r = computeSummaryRollups([]);
  assert.equal(r.total_volume, 0);
  assert.deepEqual(r.by_severity, {});
  assert.deepEqual(r.coverage, { severity: false, service: false });
});

// ── mapWithConcurrencySettled (degrade-to-partial pool) ──

test('settled pool: failures collected per-index, successes preserved in order', async () => {
  const { results, failures } = await mapWithConcurrencySettled(
    [1, 2, 3, 4, 5],
    2,
    async (n) => {
      if (n === 3) throw new Error('boom 3');
      return n * 10;
    },
  );
  assert.deepEqual(results, [10, 20, undefined, 40, 50]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].index, 2);
  assert.match(failures[0].error.message, /boom 3/);
});

test('settled pool: all-failures still resolves (never rejects)', async () => {
  const { results, failures } = await mapWithConcurrencySettled([1, 2], 4, async () => {
    throw new Error('down');
  });
  assert.deepEqual(results, [undefined, undefined]);
  assert.equal(failures.length, 2);
});

// ── selectRollups (the basis-selection gating) ──

const EV = {
  by_severity: { ERROR: 3 },
  by_service: { cart: 3 },
  by_day: { '2026-06-10': 3 },
};

test('selectRollups: filters active -> events basis, summaries ignored', () => {
  const sel = selectRollups({
    eventDerived: EV,
    summaries: [row({ summaryVolume: 99, severity_level: 'WARN', tenx_user_service: 'x' })],
    filtersActive: true,
  });
  assert.equal(sel.rollup_basis, 'events_capped');
  assert.deepEqual(sel.by_severity, EV.by_severity);
});

test('selectRollups: no summaries -> events basis', () => {
  const sel = selectRollups({ eventDerived: EV, summaries: [], filtersActive: false });
  assert.equal(sel.rollup_basis, 'events_capped');
});

test('selectRollups: full coverage -> qrs_summaries on all three dimensions', () => {
  const sel = selectRollups({
    eventDerived: EV,
    summaries: [row({ summaryVolume: 10, severity_level: 'WARN', tenx_user_service: 'pay' })],
    filtersActive: false,
  });
  assert.equal(sel.rollup_basis, 'qrs_summaries');
  assert.deepEqual(sel.by_severity, { WARN: 10 });
  assert.deepEqual(sel.by_service, { pay: 10 });
  assert.deepEqual(sel.by_day, { '2026-06-10': 10 });
});

test('selectRollups: service uncovered -> mixed, service stays event-derived', () => {
  const sel = selectRollups({
    eventDerived: EV,
    summaries: [row({ summaryVolume: 10, severity_level: 'WARN' })],
    filtersActive: false,
  });
  assert.equal(sel.rollup_basis, 'mixed');
  assert.deepEqual(sel.by_service, EV.by_service); // event fallback
  assert.deepEqual(sel.by_severity, { WARN: 10 }); // summaries
});

test('selectRollups: by_day unavailable (bad slice bounds) -> mixed, never qrs_summaries', () => {
  const sel = selectRollups({
    eventDerived: EV,
    summaries: [row({ summaryVolume: 10, severity_level: 'WARN', tenx_user_service: 'pay', sliceFromMs: 0 })],
    filtersActive: false,
  });
  assert.equal(sel.rollup_basis, 'mixed');
  assert.deepEqual(sel.by_day, EV.by_day); // event fallback
});

test('unknown bucket: field-absent rows keep maps summing to total_volume', () => {
  const r = computeSummaryRollups([
    row({ summaryVolume: 6, severity_level: 'ERROR', tenx_user_service: 'pay' }),
    row({ summaryVolume: 4, tenx_user_service: 'pay' }), // no severity
  ]);
  assert.deepEqual(r.by_severity, { ERROR: 6, unknown: 4 });
  const sum = Object.values(r.by_severity).reduce((a, b) => a + b, 0);
  assert.equal(sum, r.total_volume);
});
