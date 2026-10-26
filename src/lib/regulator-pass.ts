/**
 * What the Receiver's regulator passes of a service that a run writes a total
 * for (config pipelines/run/receive/rate/rate-object-cap.js 226-283, commit
 * 63d77a7): lines under the per-statement limit and each statement's first
 * `baselineCount` lines fill the total; past it the service still passes at
 * most BASELINE_MAX_OVER_TOTAL_DEFAULT sample lines, and then
 * KEEP_MAX_OVER_TOTAL_DEFAULT keep-count lines of its error statements, per
 * node per window. A sample line past its bound takes the keep count next.
 *
 * The run writes the lines under the limit as the total, so a service keeps
 * its total plus the floor past it.
 */

import { ALWAYS_PASS_LINES } from './report/user-units.js';
import { BASELINE_MAX_OVER_TOTAL_DEFAULT, KEEP_MAX_OVER_TOTAL_DEFAULT } from './fleet-default-install.js';

/** One statement of a service, summed over its nodes: units an hour (bytes or lines) and lines an hour. */
export interface PassStatement {
  rate: number;
  lines: number;
  error: boolean;
}

/**
 * Each ask's share of at most `max`: every ask in full when they fit or `max`
 * is 0 (no bound), else shared evenly with no ask given more than it asked.
 */
export function sharePastTotal(asks: readonly number[], max: number): number[] {
  const a = asks.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  if (!(max > 0) || a.reduce((s, x) => s + x, 0) <= max) return a;
  const out = a.map(() => 0);
  let left = max;
  let n = a.length;
  for (const i of a.map((_, j) => j).sort((x, y) => a[x] - a[y])) {
    out[i] = Math.min(a[i], left / n);
    left -= out[i];
    n--;
  }
  return out;
}

/**
 * One service at the per-statement limit `level` (units an hour, all nodes):
 * the total the run writes and what the service keeps, in units an hour.
 */
export function servicePass(
  sts: readonly PassStatement[],
  level: number,
  o: { windowsPerHour: number; nodes: number; keepCount: number },
): { total: number; kept: number } {
  const per = o.windowsPerHour * Math.max(1, o.nodes);
  const unit = sts.map((x) => (x.lines > 0 ? x.rate / x.lines : 0));
  const under = sts.map((x) => Math.min(x.rate, Math.max(0, level)));
  // lines a window a node
  const lines = sts.map((x) => x.lines / per);
  const underLines = under.map((u, i) => (unit[i] > 0 ? u / unit[i] / per : 0));
  const sample = sharePastTotal(lines.map((l, i) => Math.min(l, ALWAYS_PASS_LINES) - underLines[i]), BASELINE_MAX_OVER_TOTAL_DEFAULT);
  const keep = sharePastTotal(
    sts.map((x, i) => (x.error ? Math.min(o.keepCount, lines[i] - underLines[i] - sample[i]) : 0)),
    KEEP_MAX_OVER_TOTAL_DEFAULT,
  );
  const total = under.reduce((a, u) => a + u, 0);
  const past = sts.reduce((a, _, i) => a + (sample[i] + keep[i]) * per * unit[i], 0);
  return { total, kept: total + past };
}

/** The level at which `keptAt` (non-decreasing) equals the allowance; undefined when keptAt(0) exceeds it. */
export function levelFor(keptAt: (level: number) => number, allowance: number, hi: number): number | undefined {
  if (keptAt(0) > allowance) return undefined;
  let lo = 0;
  let top = Math.max(0, hi);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + top) / 2;
    if (keptAt(mid) > allowance) top = mid;
    else lo = mid;
  }
  return lo;
}

/** The floor past a service's total, in words, for the run reports. */
export function pastTotalWords(keepCount: number): string {
  return (
    `${ALWAYS_PASS_LINES} lines a statement a window on every node and ${keepCount} more for an error statement over its limit, ` +
    `at most ${BASELINE_MAX_OVER_TOTAL_DEFAULT} sample lines and ${KEEP_MAX_OVER_TOTAL_DEFAULT} error lines a service past its total`
  );
}
