/**
 * Anchor dispersion guard for cross-pillar primitives.
 *
 * The phase-gap and shape-similarity tools partition an anchor's time
 * buckets into high-phase / low-phase by anchor median. If the anchor
 * itself doesn't have a real busy/quiet split (e.g. a constant-rate
 * pattern), the partition is arbitrary and everything downstream is
 * noise dressed up as signal.
 *
 * `computeAnchorDispersion()` returns coefficient of variation (std/mean)
 * of the anchor values. If the result is below ANCHOR_DISPERSION_FLOOR,
 * the caller MUST refuse with `status: "anchor_no_phase_separation"`.
 *
 * Statistic choice — CV (std/mean), not MAD/median.
 *
 * The Grok+Claude consults (2026-05-28) recommended MAD/median to avoid
 * the well-known "CV blows up near zero mean" failure. That's correct
 * for steady-state metric series with non-zero baselines. But MAD/median
 * has its own pathology: when more than half the anchor values sit at
 * the baseline (sparse-spike incident anchors — common for log patterns
 * that emit only during incidents), median = baseline and MAD = 0, so
 * MAD/median = 0 and the guard refuses anchors that ARE valid signals.
 * Real chaos-shape anchors with zero baselines fall in this trap.
 *
 * CV handles those:
 *   - Sparse-spike (e.g. [0×15, 1, 5, 10, 5, 1]) → mean > 0, std > 0,
 *     CV ≈ 2.3 → passes (correct).
 *   - Flat constant [5×20] → std = 0, CV = 0 → refuses (correct).
 *   - Bimodal [1×5, 10×5] → CV ≈ 0.82 → passes (correct).
 *   - Chaos ramp [2,2,5,10,20,32,...] → CV ≈ 0.88 → passes (correct).
 *
 * The CV-near-zero-mean concern remains, but it's structurally fine:
 * when mean is exactly zero, the guard returns 0 (refuse). When mean
 * is small-but-nonzero AND CV is high, the data DOES have real
 * relative spread, so passing it through is correct behavior.
 */

/**
 * Below this dispersion, the anchor has no real busy/quiet phase and
 * any phase-partition-based analysis is meaningless. Hand-picked from
 * the chaos-test calibration; surfaced in tool output as
 * `unvalidated_default` so callers can override per backend.
 */
export const ANCHOR_DISPERSION_FLOOR = 0.15;

/**
 * Coefficient of variation (std / mean) of a numeric series.
 *
 * Returns 0 for empty input, single-value input, or zero-mean input
 * (degenerate cases). Callers interpret 0 as "no phase separation."
 */
export function computeAnchorDispersion(values: number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  if (mean === 0) return 0;
  let sqDevSum = 0;
  for (const v of values) {
    const d = v - mean;
    sqDevSum += d * d;
  }
  const std = Math.sqrt(sqDevSum / values.length);
  return std / Math.abs(mean);
}

/**
 * Convenience: does this anchor have enough phase separation for the
 * cross-pillar partition math to be meaningful?
 */
export function hasPhaseSeparation(values: number[]): boolean {
  return computeAnchorDispersion(values) >= ANCHOR_DISPERSION_FLOOR;
}
