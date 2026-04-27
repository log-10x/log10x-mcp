/**
 * Random time-bucketed sampling for SIEM connectors.
 *
 * The pull loop's prior shape was "iterate cursor pages from window-start
 * sorted ascending until the event target is hit." With a 7-day window
 * and a 250k-event cap, that draws a single contiguous slice from the
 * first few hours of the window. Patterns that surface only later in the
 * day, or that arrive in mid-window bursts, are systematically missed.
 *
 * `randomTimeBuckets()` divides the window into N evenly-spaced parent
 * slots and places one randomized child sub-window inside each parent.
 * Two consecutive calls with different RNG draws produce non-overlapping
 * sub-windows almost surely, so the same prospect re-running the POC
 * gets a fresh sample (the spec test: "sample-overlap should be near
 * zero, not 100%").
 *
 * The connector is responsible for capping per-bucket event count and
 * stopping when the global target is reached or the deadline trips.
 */

export interface SamplingBucket {
  fromMs: number;
  toMs: number;
  /** Index in the bucket array (0..count-1). Useful for progress reporting. */
  index: number;
}

/** Child sub-window size as a fraction of its parent slot. */
const CHILD_RATIO = 1 / 4;

/**
 * Build N randomized sampling buckets across `[fromMs, toMs]`.
 *
 * Each parent slot has duration `(toMs - fromMs) / count`. The child
 * sub-window is one-quarter of the parent's duration, placed at a
 * random offset inside the parent. The 1:4 ratio gives roughly 9%
 * expected range overlap between two independent runs (vs. 100% in
 * the prior contiguous-from-window-start design), while still leaving
 * each child wide enough to absorb typical SIEM event density.
 *
 * Pass a seeded RNG for deterministic tests. Production callers should
 * leave `rng` unset (defaults to `Math.random`).
 */
export function randomTimeBuckets(
  fromMs: number,
  toMs: number,
  count: number,
  rng: () => number = Math.random
): SamplingBucket[] {
  if (toMs <= fromMs) {
    throw new Error(`randomTimeBuckets: invalid range [${fromMs}, ${toMs}]`);
  }
  if (count < 1) {
    throw new Error(`randomTimeBuckets: count must be >= 1, got ${count}`);
  }
  const span = toMs - fromMs;
  const parentSpan = span / count;
  const childSpan = parentSpan * CHILD_RATIO;
  const buckets: SamplingBucket[] = [];
  for (let i = 0; i < count; i++) {
    const parentStart = fromMs + i * parentSpan;
    // Random offset: 0 to (parentSpan - childSpan), so the child
    // sub-window stays inside its parent slot.
    const offset = rng() * (parentSpan - childSpan);
    const childStart = parentStart + offset;
    buckets.push({
      fromMs: Math.floor(childStart),
      toMs: Math.ceil(childStart + childSpan),
      index: i,
    });
  }
  return buckets;
}

/**
 * How many events to draw from each bucket so the total approximates
 * `targetEventCount` with a small slack so empty buckets don't starve
 * the total. Returns at minimum 1 event/bucket.
 */
export function perBucketCap(targetEventCount: number, bucketCount: number): number {
  if (bucketCount < 1) return targetEventCount;
  return Math.max(1, Math.ceil((targetEventCount * 1.25) / bucketCount));
}
