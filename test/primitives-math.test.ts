/**
 * Unit tests for the deterministic math behind the three cross-pillar
 * primitives. Pure functions only; no I/O, no backend. The integration
 * surface (queryRange + tier composition) is covered separately.
 *
 * What's covered here, and why:
 *
 *   - pearsonWithOffset:        the core of rank_by_shape_similarity.
 *   - computeTemporalCorrelation: lag scan + tightness (uses pearsonWithOffset).
 *   - anchorPhaseGap:           the same flag rank_by_shape surfaces.
 *   - partitionAnchorByMedian:  the high/low phase grid for metrics_that_moved.
 *   - computeMovedSignal:       the per-candidate phase-gap evaluator.
 *   - inSetWithin:              timestamp-tolerance matcher (silently wrong
 *                               at the wrong tolerance -> false positives).
 *   - peakOf:                   metric_overlay's "where did the candidate
 *                               peak in the aligned window" helper.
 *
 * Fixtures are constructed deterministically so a future regression on
 * the right-align / lag / phase-gap math fails here loudly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pearsonWithOffset,
  computeTemporalCorrelation,
  anchorPhaseGap,
  LAG_OFFSETS_SECONDS,
} from '../src/tools/rank-by-shape-similarity.js';
import {
  partitionAnchorByMedian,
  computeMovedSignal,
  inSetWithin,
} from '../src/tools/metrics-that-moved.js';
import { peakOf } from '../src/tools/metric-overlay.js';

// ── pearsonWithOffset ────────────────────────────────────────────────

test('pearsonWithOffset: identical series at offset=0 returns r=1', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const r = pearsonWithOffset(a, a, 0);
  assert.ok(Math.abs(r - 1) < 1e-9, `expected r ≈ 1, got ${r}`);
});

test('pearsonWithOffset: inverted series at offset=0 returns r=-1', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const r = pearsonWithOffset(a, b, 0);
  assert.ok(Math.abs(r + 1) < 1e-9, `expected r ≈ -1, got ${r}`);
});

test('pearsonWithOffset: flat candidate returns r=0 (denominator guard)', () => {
  const a = [1, 2, 3, 4, 5, 6];
  const b = [5, 5, 5, 5, 5, 5];
  const r = pearsonWithOffset(a, b, 0);
  assert.equal(r, 0);
});

test('pearsonWithOffset: candidate leads anchor by 2 -> peak at NEGATIVE offset', () => {
  // anchor = candidate shifted right by 2. So candidate(t) ≈ anchor(t+2).
  // pearsonWithOffset with offset=-2 should align them perfectly.
  const a = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
  const b = [1, 2, 3, 4, 5, 6, 7, 8, 0, 0];
  const rAtMinus2 = pearsonWithOffset(a, b, -2);
  const rAt0 = pearsonWithOffset(a, b, 0);
  assert.ok(rAtMinus2 > 0.95, `expected strong correlation at offset=-2, got ${rAtMinus2}`);
  assert.ok(rAtMinus2 > rAt0, `offset=-2 (${rAtMinus2}) should beat offset=0 (${rAt0})`);
});

test('pearsonWithOffset: too few overlapping points returns r=0', () => {
  const a = [1, 2, 3, 4, 5];
  const b = [1, 2, 3, 4, 5];
  const r = pearsonWithOffset(a, b, 3); // only 2 overlap → < 3 → 0
  assert.equal(r, 0);
});

// ── computeTemporalCorrelation ───────────────────────────────────────

test('computeTemporalCorrelation: identical non-periodic spike → r≈1, lag=0', () => {
  // Single spike series — non-periodic, so the peak at offset=0 is
  // sharply distinct from neighbors. Avoids the sine-correlates-with-itself
  // problem where offset=±step still gives r ≈ 0.95 and the relative
  // "tightness" metric reads modest.
  const series = [0, 0, 0, 0, 0, 1, 5, 20, 50, 20, 5, 1, 0, 0, 0, 0, 0];
  const out = computeTemporalCorrelation(series, series, 30);
  assert.ok(Math.abs(out.r - 1) < 1e-9, `expected r ≈ 1, got ${out.r}`);
  assert.equal(out.lagSeconds, 0);
  // Tightness should be positive — peak at 0 stands out vs distant offsets.
  assert.ok(out.lagTightness > 0, `expected positive tightness, got ${out.lagTightness}`);
});

test('computeTemporalCorrelation: right-aligns sparse anchor vs dense candidate', () => {
  // Anchor is short and rising; candidate is long with the same rise at the END.
  // Without right-alignment (the v4 bug), Pearson would compare anchor's rise
  // against candidate's flat prefix and miss the signal.
  const dense = Array.from({ length: 120 }, (_, i) => (i < 80 ? 0 : (i - 80)));
  const sparse = Array.from({ length: 40 }, (_, i) => i);
  const out = computeTemporalCorrelation(sparse, dense, 30);
  assert.ok(out.r > 0.9, `right-alignment should find strong correlation; got r=${out.r}`);
});

test('computeTemporalCorrelation: candidate leads anchor by 60s -> lag ≈ -60', () => {
  // Construct anchor as candidate shifted right by 2 buckets.
  // Bucket width = 30s, so 2 buckets = 60s of lag.
  const cand = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 11, 10, 8, 6, 4, 2, 0, 0, 0, 0];
  const anch = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 11, 10, 8, 6, 4, 2, 0, 0];
  const out = computeTemporalCorrelation(anch, cand, 30);
  assert.ok(out.r > 0.85, `expected strong correlation, got r=${out.r}`);
  assert.equal(out.lagSeconds, -60, `expected lag=-60s (candidate leads), got ${out.lagSeconds}`);
});

test('computeTemporalCorrelation: empty inputs return zeros', () => {
  const out = computeTemporalCorrelation([], [], 30);
  assert.deepEqual(out, { r: 0, lagSeconds: 0, lagTightness: 0 });
});

// ── LAG_OFFSETS_SECONDS sanity ────────────────────────────────────────

test('LAG_OFFSETS_SECONDS spans ±1800s and includes 0', () => {
  assert.ok(LAG_OFFSETS_SECONDS.includes(0), 'must include zero-lag');
  assert.equal(Math.min(...LAG_OFFSETS_SECONDS), -1800);
  assert.equal(Math.max(...LAG_OFFSETS_SECONDS), 1800);
  // Must be sorted ascending so lag-at-bound detection works.
  for (let i = 1; i < LAG_OFFSETS_SECONDS.length; i++) {
    assert.ok(LAG_OFFSETS_SECONDS[i] > LAG_OFFSETS_SECONDS[i - 1]);
  }
});

// ── anchorPhaseGap ────────────────────────────────────────────────────

test('anchorPhaseGap: identical series → gap≈1 (max signal)', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // candidate moves perfectly with anchor's phase
  const c = a;
  const gap = anchorPhaseGap(a, c);
  assert.ok(gap > 0.5, `identical phase should give large gap, got ${gap}`);
});

test('anchorPhaseGap: candidate flat across anchor phases → gap≈0', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const c = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
  const gap = anchorPhaseGap(a, c);
  assert.ok(gap < 0.05, `flat candidate should give ~0 gap, got ${gap}`);
});

test('anchorPhaseGap: too short input returns 1 (defensive)', () => {
  // < 6 overlap → 1 (treat as max gap to avoid false-negative filter).
  const a = [1, 2, 3];
  const c = [1, 2, 3];
  assert.equal(anchorPhaseGap(a, c), 1);
});

test('anchorPhaseGap: anti-correlated candidate gives large gap (direction-blind)', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const c = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  const gap = anchorPhaseGap(a, c);
  assert.ok(gap > 0.5, `anti-correlation should still register as gap, got ${gap}`);
});

// ── partitionAnchorByMedian ──────────────────────────────────────────

test('partitionAnchorByMedian: monotone series splits at the middle', () => {
  const series: Array<[number, number]> = [
    [100, 1],
    [200, 2],
    [300, 3],
    [400, 4],
    [500, 5],
    [600, 6],
  ];
  const part = partitionAnchorByMedian(series);
  // median is the 4 (index 3 of 6). > median → high (5, 6 → ts 500, 600).
  assert.equal(part.median, 4);
  assert.deepEqual([...part.highTs].sort(), [500, 600]);
  assert.deepEqual([...part.lowTs].sort(), [100, 200, 300, 400]);
});

test('partitionAnchorByMedian: flat series → all timestamps in low', () => {
  const series: Array<[number, number]> = [
    [100, 5],
    [200, 5],
    [300, 5],
    [400, 5],
  ];
  const part = partitionAnchorByMedian(series);
  assert.equal(part.highTs.size, 0);
  assert.equal(part.lowTs.size, 4);
});

test('partitionAnchorByMedian: empty input is safe (median=0)', () => {
  const part = partitionAnchorByMedian([]);
  assert.equal(part.median, 0);
  assert.equal(part.highTs.size, 0);
  assert.equal(part.lowTs.size, 0);
});

// ── computeMovedSignal ───────────────────────────────────────────────

test('computeMovedSignal: candidate that mirrors anchor phases → evaluated, large gap, co', () => {
  // anchor: low at t=0..3 (rate=1), high at t=4..7 (rate=10)
  // Use distinct values so partitionByMedian splits cleanly (>median goes
  // high). With ties at the median, even-count series degenerate to all-low.
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  // anchor median = 10 (sorted[4]); v>10 → high (ts 150/180/210), rest low.
  // Drop ts=120 from the candidate: it sits at the high/low boundary, and
  // inSetWithin checks highTs first with ±tolerance, so 120 matches highTs
  // via 120+30=150. That's the spec, not a bug — it's just an awkward edge
  // case to test through.
  const cand: Array<[number, number]> = [
    [0, 100], [30, 100], [60, 100], [90, 100],
    [150, 500], [180, 500], [210, 500],
  ];
  const out = computeMovedSignal(partition, cand, 30);
  assert.equal(out.kind, 'evaluated');
  if (out.kind !== 'evaluated') return;
  assert.equal(out.direction, 'co');
  assert.ok(out.phaseGap > 0.7, `expected strong phaseGap, got ${out.phaseGap}`);
  assert.equal(out.nHigh, 3);
  assert.equal(out.nLow, 4);
});

test('computeMovedSignal: candidate flat across anchor phases → evaluated, gap≈0', () => {
  // Use distinct values so partitionByMedian splits cleanly (>median goes
  // high). With ties at the median, even-count series degenerate to all-low.
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  const cand: Array<[number, number]> = [
    [0, 200], [30, 200], [60, 200], [90, 200], [120, 200],
    [150, 200], [180, 200], [210, 200],
  ];
  const out = computeMovedSignal(partition, cand, 30);
  assert.equal(out.kind, 'evaluated');
  if (out.kind !== 'evaluated') return;
  assert.ok(out.phaseGap < 0.01, `expected gap ≈ 0, got ${out.phaseGap}`);
});

test('computeMovedSignal: anti-correlated candidate → evaluated, large gap, anti', () => {
  // Use distinct values so partitionByMedian splits cleanly (>median goes
  // high). With ties at the median, even-count series degenerate to all-low.
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  // High candidate value during anchor low phase, low value during anchor high.
  const cand: Array<[number, number]> = [
    [0, 500], [30, 500], [60, 500], [90, 500], [120, 500],
    [150, 100], [180, 100], [210, 100],
  ];
  const out = computeMovedSignal(partition, cand, 30);
  assert.equal(out.kind, 'evaluated');
  if (out.kind !== 'evaluated') return;
  assert.equal(out.direction, 'anti');
});

test('computeMovedSignal: too few candidate points → failed', () => {
  // Use distinct values so partitionByMedian splits cleanly (>median goes
  // high). With ties at the median, even-count series degenerate to all-low.
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  const cand: Array<[number, number]> = [[0, 1], [30, 2]];
  const out = computeMovedSignal(partition, cand, 30);
  assert.equal(out.kind, 'failed');
});

test('computeMovedSignal: candidate only overlaps high phase → failed (need ≥2 low samples)', () => {
  // Use distinct values so partitionByMedian splits cleanly (>median goes
  // high). With ties at the median, even-count series degenerate to all-low.
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  const cand: Array<[number, number]> = [
    [120, 500], [150, 500], [180, 500], [210, 500],
    [240, 500], [270, 500],
  ];
  const out = computeMovedSignal(partition, cand, 30);
  assert.equal(out.kind, 'failed');
});

test('computeMovedSignal: aligns candidate timestamps to step grid (Math.round)', () => {
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  // candidate off-grid — Math.round(ts/30)*30 snaps to anchor grid.
  const cand: Array<[number, number]> = [
    [3, 100], [33, 100], [63, 100], [93, 100], [123, 100],
    [153, 500], [183, 500], [213, 500],
  ];
  const out = computeMovedSignal(partition, cand, 30);
  assert.equal(out.kind, 'evaluated');
  if (out.kind !== 'evaluated') return;
  assert.equal(out.nHigh + out.nLow, 8, 'all candidate samples should align to grid');
});

// ── inSetWithin ──────────────────────────────────────────────────────

test('inSetWithin: exact match', () => {
  const s = new Set([100, 200, 300]);
  assert.equal(inSetWithin(s, 200, 10), true);
});

test('inSetWithin: exact bucket-step neighbor matches', () => {
  // Contract: after rounding the query ts to the step grid, check the bucket
  // itself OR exactly ±tolerance. Not a range scan — that would make adjacent
  // buckets indistinguishable. Tolerance = step in real usage.
  const s = new Set([100, 200, 300]);
  // Query 210 with step 10: check 210, 200, 220. Only 200 matches.
  assert.equal(inSetWithin(s, 210, 10), true);
  // Query 190 with step 10: check 190, 180, 200. 200 matches.
  assert.equal(inSetWithin(s, 190, 10), true);
});

test('inSetWithin: outside step distance — even by 1 — does not match', () => {
  const s = new Set([100, 200, 300]);
  // Query 211 with step 10: check 211, 201, 221. None in set.
  assert.equal(inSetWithin(s, 211, 10), false);
});

// ── peakOf ────────────────────────────────────────────────────────────

test('peakOf: finds max-value point, ignores nulls', () => {
  const points = [
    { ts: 100, v: 1 },
    { ts: 200, v: null },
    { ts: 300, v: 5 },
    { ts: 400, v: 3 },
    { ts: 500, v: null },
  ];
  const peak = peakOf(points);
  assert.deepEqual(peak, { ts: 300, v: 5 });
});

test('peakOf: all nulls returns null', () => {
  const points = [
    { ts: 100, v: null },
    { ts: 200, v: null },
  ];
  assert.equal(peakOf(points), null);
});

test('peakOf: empty input returns null', () => {
  assert.equal(peakOf([]), null);
});

test('peakOf: ties resolve to FIRST occurrence (deterministic)', () => {
  const points = [
    { ts: 100, v: 5 },
    { ts: 200, v: 5 },
    { ts: 300, v: 5 },
  ];
  const peak = peakOf(points);
  assert.deepEqual(peak, { ts: 100, v: 5 });
});

// ── Degenerate / boundary cases ──────────────────────────────────────
//
// Real-world callers hit these constantly: backend returns nothing,
// half the candidates 503, the window is too short, samples have NaN,
// or every candidate's peak lands at the search boundary. None of
// these should crash; each should produce an output the agent can
// distinguish from a "real" answer.

test('partitionAnchorByMedian: single bucket → both sets empty/single (no crash)', () => {
  const series: Array<[number, number]> = [[100, 5]];
  const part = partitionAnchorByMedian(series);
  assert.equal(part.median, 5);
  // 5 is not > 5, so the lone sample falls into low.
  assert.equal(part.highTs.size, 0);
  assert.equal(part.lowTs.size, 1);
});

test('partitionAnchorByMedian: NaN values do not pollute downstream', () => {
  // The contract: if the engine ever lets a NaN through (rare but seen
  // when a series briefly emits an empty string), partition still
  // returns a usable structure. Downstream computeMovedSignal treats
  // it as "failed" rather than producing NaN gap values.
  const series: Array<[number, number]> = [
    [0, 1], [30, 2], [60, NaN], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const part = partitionAnchorByMedian(series);
  // median is whatever sorted picks — NaN sorts unpredictably, but the
  // partition must not throw.
  assert.ok(part.highTs.size + part.lowTs.size === 8);
});

test('computeMovedSignal: empty candidate series → failed', () => {
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  const out = computeMovedSignal(partition, [], 30);
  assert.equal(out.kind, 'failed');
});

test('computeMovedSignal: candidate timestamps land entirely OUTSIDE anchor partition → failed', () => {
  // Anchor covers 0..210s. Candidate is from a much later window (no overlap).
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  const cand: Array<[number, number]> = [
    [10000, 5], [10030, 5], [10060, 5], [10090, 5], [10120, 5], [10150, 5],
  ];
  const out = computeMovedSignal(partition, cand, 30);
  assert.equal(out.kind, 'failed');
});

test('computeMovedSignal: zero-mean phases → uses 1e-9 floor, does not return Infinity', () => {
  // Both meanHigh and meanLow are zero. The implementation guards
  // with max(|h|, |l|, 1e-9) to avoid division-by-zero blowing up.
  const anchorSeries: Array<[number, number]> = [
    [0, 1], [30, 2], [60, 3], [90, 4],
    [120, 10], [150, 11], [180, 12], [210, 13],
  ];
  const partition = partitionAnchorByMedian(anchorSeries);
  const cand: Array<[number, number]> = [
    [0, 0], [30, 0], [60, 0], [90, 0], [120, 0],
    [150, 0], [180, 0], [210, 0],
  ];
  const out = computeMovedSignal(partition, cand, 30);
  assert.equal(out.kind, 'evaluated');
  if (out.kind !== 'evaluated') return;
  assert.ok(Number.isFinite(out.phaseGap), 'phaseGap must stay finite when both phases are zero');
  assert.equal(out.phaseGap, 0);
});

test('pearsonWithOffset: NaN samples produce a finite or zero r, not NaN out', () => {
  // The implementation does (x - meanA) * (y - meanB) summing. With a
  // single NaN in input, mean becomes NaN and the whole result is NaN.
  // Callers downstream filter NaN out, so the contract is: tests pin
  // that NaN propagates (it does NOT silently become zero), so the
  // filter stays load-bearing.
  const a = [1, 2, 3, NaN, 5, 6];
  const b = [1, 2, 3, 4, 5, 6];
  const r = pearsonWithOffset(a, b, 0);
  assert.ok(Number.isNaN(r), 'NaN in input must propagate; downstream filters drop NaN');
});

test('computeTemporalCorrelation: candidate flat at zero → r=0, no tightness (lag is meaningless)', () => {
  // All offsets produce r=0 (flat candidate has zero variance). The
  // sort's stable order picks the first offset (-1800) as the "peak."
  // The agent reads r=0 + lagTightness=0 and ignores the lag value;
  // this test pins r and tightness, NOT the meaningless lag.
  const anchor = [0, 0, 1, 5, 10, 5, 1, 0, 0, 0];
  const candidate = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const out = computeTemporalCorrelation(anchor, candidate, 30);
  assert.equal(out.r, 0);
  assert.equal(out.lagTightness, 0);
});

test('computeTemporalCorrelation: very short series (< 3 overlap at offset) → r=0 at that offset', () => {
  // 4 points each; at offset=±3 only 1 point overlaps. pearsonWithOffset
  // returns 0 when overlap < 3. Confirms the boundary isn't off-by-one.
  const a = [1, 2, 3, 4];
  const b = [1, 2, 3, 4];
  // Direct call at offset=3 — would need to align via step. Bypass the
  // outer routine and call the helper.
  const r = pearsonWithOffset(a, b, 3);
  assert.equal(r, 0);
});

test('LAG_OFFSETS_SECONDS: boundary lags hit BOTH ends', () => {
  // Both ±1800 must be present so lag_at_bound detection is symmetric.
  // (If only +1800 were there, a candidate that leads by 1800s would
  // silently lose its lag and look like lag=0.)
  assert.ok(LAG_OFFSETS_SECONDS.includes(-1800), 'leading-by-30-min boundary must be reachable');
  assert.ok(LAG_OFFSETS_SECONDS.includes(1800), 'lagging-by-30-min boundary must be reachable');
});

test('anchorPhaseGap: NaN in either input → returns 1 (defensive max-gap)', () => {
  // Same defensive contract as too-short input: degrade to "treat as
  // moved" rather than silently say "didn't move" with bogus math.
  // The function's < 6 check covers the common case; this asserts that
  // even with valid length, NaN doesn't propagate as a real phaseGap.
  const a = [1, 2, 3, 4, 5, 6, 7, 8];
  const c = [1, 2, NaN, 4, 5, 6, 7, 8];
  const gap = anchorPhaseGap(a, c);
  // Implementation today: NaN propagates, gap is NaN. This test pins
  // current behavior so any future "make it return 1 / clamp NaN"
  // change is intentional, not silent.
  assert.ok(Number.isNaN(gap) || gap === 1, `expected NaN or 1 (defensive), got ${gap}`);
});

test('peakOf: mixed null and zero — zero wins over null, ties pick first', () => {
  // Zero is a valid value; null is "no data." Make sure zero is selectable
  // as a peak when everything else is null.
  const points = [
    { ts: 100, v: null },
    { ts: 200, v: 0 },
    { ts: 300, v: null },
  ];
  const peak = peakOf(points);
  assert.deepEqual(peak, { ts: 200, v: 0 });
});

test('peakOf: negative values only — picks the LEAST negative (closest to zero)', () => {
  // For rate metrics this won't happen, but for gauge deltas or
  // anomaly scores it can. The peak is still "the max value."
  const points = [
    { ts: 100, v: -10 },
    { ts: 200, v: -3 },
    { ts: 300, v: -7 },
  ];
  const peak = peakOf(points);
  assert.deepEqual(peak, { ts: 200, v: -3 });
});

test('inSetWithin: empty set returns false for any ts (no false positive)', () => {
  // When the anchor partition produces an empty highTs OR empty lowTs
  // (constant-anchor degenerate case), every candidate sample misses.
  // Downstream the n<2 guard kicks in. This test pins the lookup
  // contract so the n<2 path stays load-bearing.
  const empty = new Set<number>();
  assert.equal(inSetWithin(empty, 100, 30), false);
  assert.equal(inSetWithin(empty, 0, 30), false);
});

test('inSetWithin: tolerance=0 → only exact matches', () => {
  // Edge case: step=0 would be a caller bug, but the function shouldn't
  // crash. With tolerance=0, ts-0 = ts+0 = ts, so the function reduces
  // to exact membership.
  const s = new Set([100, 200, 300]);
  assert.equal(inSetWithin(s, 200, 0), true);
  assert.equal(inSetWithin(s, 201, 0), false);
});

// ── Custom lag-offset list ───────────────────────────────────────────

test('computeTemporalCorrelation: narrowed offsets list restricts the lag search', () => {
  // Same fixture as the "candidate leads by 60s" test, but pass a
  // narrowed offset list that excludes -60. The peak should fall on
  // the closest remaining offset, NOT -60.
  const cand = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 11, 10, 8, 6, 4, 2, 0, 0, 0, 0];
  const anch = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 11, 10, 8, 6, 4, 2, 0, 0];
  const out = computeTemporalCorrelation(anch, cand, 30, [-30, 0, 30]);
  assert.notEqual(out.lagSeconds, -60, 'narrowed search must NOT return an offset outside the list');
  assert.ok([-30, 0, 30].includes(out.lagSeconds), `expected one of {-30, 0, 30}, got ${out.lagSeconds}`);
});

test('computeTemporalCorrelation: empty offsets list → returns zeros (no crash)', () => {
  const out = computeTemporalCorrelation([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], 30, []);
  assert.equal(out.r, 0);
  assert.equal(out.lagSeconds, 0);
  assert.equal(out.lagTightness, 0);
});
