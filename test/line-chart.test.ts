/**
 * line-chart.ts — span-adaptive axes.
 *
 * X-axis rolls up minutes -> hours -> days so a 30-day window reads
 * "-30d / -15d / now" not "-720h / -360h". Y-axis renders volume per-period
 * (per-day once multi-day) so the chart unit agrees with the per-day prose
 * the tools narrate at month scale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineChart } from '../src/lib/line-chart.js';

const DAY = 86400;
const HOUR = 3600;
const ramp = (n: number, peak: number) => Array.from({ length: n }, (_, i) => (peak * i) / (n - 1));

test('x-axis: 30-day span reads in days, not 720 hours', () => {
  const out = lineChart(ramp(60, 1e6), { spanSeconds: 30 * DAY })!;
  const axis = out.split('\n').find((l) => l.includes('now'))!;
  assert.match(axis, /-30d/);
  assert.match(axis, /-15d/);
  assert.doesNotMatch(axis, /-720h/);
  assert.doesNotMatch(axis, /\dh\b/); // no hour ticks at all
});

test('x-axis: 7-day span uses days with one decimal for the midpoint', () => {
  const out = lineChart(ramp(40, 1e6), { spanSeconds: 7 * DAY })!;
  const axis = out.split('\n').find((l) => l.includes('now'))!;
  assert.match(axis, /-7d/);
  assert.match(axis, /-3\.5d/);
});

test('x-axis: day-scale windows (<48h) stay in hours', () => {
  const out = lineChart(ramp(24, 1e6), { spanSeconds: 24 * HOUR })!;
  const axis = out.split('\n').find((l) => l.includes('now'))!;
  assert.match(axis, /-24h/);
  assert.match(axis, /-12h/);
  assert.doesNotMatch(axis, /d\b/);
});

test('x-axis: sub-hour windows stay in minutes', () => {
  const out = lineChart(ramp(15, 1e6), { spanSeconds: 15 * 60 })!;
  const axis = out.split('\n').find((l) => l.includes('now'))!;
  assert.match(axis, /-15m/);
  assert.match(axis, /-7\.5m/);
});

test('y-axis: multi-day span renders per-day, agreeing with the prose', () => {
  // Peak ~852,893 B/s == 3069 MB/h == 73.7 GB/day — the reported scenario.
  // 30 buckets (≈ the real chart width) so the x-axis labels don't collide.
  const peak = (73.7e9) / DAY;
  const vals = Array.from({ length: 30 }, (_, i) => (i >= 28 ? peak * (i - 27) * 0.5 : peak * 0.002));
  const out = lineChart(vals, { spanSeconds: 30 * DAY })!;
  const peakLine = out.split('\n')[0];
  assert.match(peakLine, /73\.7 GB\/day/);
  assert.doesNotMatch(out, /MB\/h/); // not the old hour unit
  assert.match(out, /-30d/);          // and the x-axis agrees
});

test('y-axis: hour-scale span keeps per-hour', () => {
  // 1e5 B/s == 360 MB/h (below the 1 GB/h roll-up).
  const out = lineChart(ramp(24, 1e5), { spanSeconds: 6 * HOUR })!;
  assert.match(out, /MB\/h/);
  assert.doesNotMatch(out, /\/day/);
});

test('y-axis: low-volume multi-day span degrades to KB/day, not a row of zeros', () => {
  // ~50 MB/day peak -> per-day MB is small; KB/day keeps resolution.
  const peak = (50e6) / DAY;
  const out = lineChart(ramp(30, peak), { spanSeconds: 7 * DAY })!;
  assert.match(out, /\/day/);
  assert.ok(/KB\/day|MB\/day/.test(out));
});

test('still returns null on empty / all-zero input', () => {
  assert.equal(lineChart([], { spanSeconds: DAY }), null);
  assert.equal(lineChart([0, 0, 0], { spanSeconds: DAY }), null);
});
