/**
 * Window-scaling utilities for converting between observation windows and
 * receiver reset windows.
 *
 * The rate receiver resets its per-pattern counters every
 * RECEIVER_DEFAULT_RESET_MS (4 minutes by default). Cap CSV rows are
 * denominated in bytes-per-reset-window. Any code path that converts a
 * Prometheus query window (e.g. "24h") or a monthly projection to a per-cap
 * value must go through these helpers so the denominator is explicit and
 * testable.
 *
 * Pure functions; no side effects; no env reads.
 */

// ─── constants ────────────────────────────────────────────────────────────────

/** Default rate-receiver reset interval in milliseconds (4 minutes). */
export const RECEIVER_DEFAULT_RESET_MS = 240_000;

// ─── parseWindowMs ────────────────────────────────────────────────────────────

/**
 * Parse a free-form window string into milliseconds.
 *
 * Accepted formats: `\d+[mhd]`
 *   - `5m`  → 300_000
 *   - `1h`  → 3_600_000
 *   - `24h` → 86_400_000
 *   - `7d`  → 604_800_000
 *
 * Throws TypeError for any other input (e.g. '5sec', '1', 'tomorrow').
 */
export function parseWindowMs(window: string): number {
  const match = /^(\d+)([mhd])$/.exec(window);
  if (!match) {
    throw new TypeError(
      `Invalid window string "${window}". Expected format: <positive-integer>[m|h|d] (e.g. "5m", "1h", "7d").`,
    );
  }
  const value = parseInt(match[1], 10);
  if (value <= 0) {
    throw new TypeError(
      `Window value must be positive, got "${window}".`,
    );
  }
  const unit = match[2];
  switch (unit) {
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default:
      // Unreachable given the regex, but satisfies exhaustiveness.
      throw new TypeError(`Unknown window unit "${unit}" in "${window}".`);
  }
}

// ─── scaleBytes ───────────────────────────────────────────────────────────────

/**
 * Scale a byte count from one time window to another by linear proportion.
 *
 * Returns `bytesInWindow * (toWindowMs / fromWindowMs)`.
 * Returns 0 if bytesInWindow is 0 (avoids NaN propagation).
 * Does not round — caller rounds before writing to CSV.
 *
 * Throws RangeError if either window is non-positive.
 */
export function scaleBytes(
  bytesInWindow: number,
  fromWindowMs: number,
  toWindowMs: number,
): number {
  if (fromWindowMs <= 0) {
    throw new RangeError(`fromWindowMs must be positive, got ${fromWindowMs}.`);
  }
  if (toWindowMs <= 0) {
    throw new RangeError(`toWindowMs must be positive, got ${toWindowMs}.`);
  }
  if (bytesInWindow === 0) return 0;
  return bytesInWindow * (toWindowMs / fromWindowMs);
}

// ─── percentToTargetBytes ─────────────────────────────────────────────────────

/**
 * Convert an observed byte count and a reduction percentage to the
 * post-reduction target byte count.
 *
 * `percentReduction` is clamped to [0, 100].
 * Returns `observedBytes * (1 - percentReduction / 100)`.
 * Returns 0 when percentReduction is 100; returns observedBytes when 0.
 */
export function percentToTargetBytes(
  observedBytes: number,
  percentReduction: number,
): number {
  const clamped = Math.min(100, Math.max(0, percentReduction));
  if (clamped >= 100) return 0;
  if (clamped <= 0) return observedBytes;
  return observedBytes * (1 - clamped / 100);
}

// ─── scaleObservedToReceiverWindow ────────────────────────────────────────────

/**
 * Canonical helper: convert a byte count observed over `observedWindow`
 * (e.g. from a Prometheus `increase()` query) into bytes-per-receiver-reset-
 * window.
 *
 * This is the function configure_engine should call when computing a cap CSV
 * row from Prometheus data.
 *
 * @param observedBytes    Byte count from the observation window.
 * @param observedWindow   Window string matching the Prometheus query range,
 *                         e.g. "24h", "7d".
 * @param receiverResetMs  Reset interval of the rate receiver in ms. Defaults
 *                         to RECEIVER_DEFAULT_RESET_MS (4 minutes).
 */
export function scaleObservedToReceiverWindow(
  observedBytes: number,
  observedWindow: string,
  receiverResetMs: number = RECEIVER_DEFAULT_RESET_MS,
): number {
  const observedWindowMs = parseWindowMs(observedWindow);
  return scaleBytes(observedBytes, observedWindowMs, receiverResetMs);
}

// ─── readableWindow ───────────────────────────────────────────────────────────

/**
 * Convert a millisecond duration back to a human-readable window string.
 * Used for log lines and error messages.
 *
 *   240_000  → '4m'
 *   3_600_000 → '1h'
 *   86_400_000 → '1d'
 *
 * Prefer the largest exact unit. Falls back to minutes (floored) for
 * durations that don't align to a round number of hours or days.
 */
export function readableWindow(ms: number): string {
  const totalMinutes = ms / 60_000;
  const totalHours = ms / 3_600_000;
  const totalDays = ms / 86_400_000;

  if (Number.isInteger(totalDays) && totalDays >= 1) {
    return `${totalDays}d`;
  }
  if (Number.isInteger(totalHours) && totalHours >= 1) {
    return `${totalHours}h`;
  }
  return `${Math.floor(totalMinutes)}m`;
}
