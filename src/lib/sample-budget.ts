/**
 * Per-hash SIEM fetch budget computation.
 *
 * The SIEM query budget (race timeout + maxPullMinutes) is tuned to the
 * requested scan window. A 1h probe can return in 2.5s; a 7d scan needs
 * more time because the SIEM must scan more index shards / log-group
 * partitions before finding a hit for a low-volume pattern.
 *
 * Piecewise constants (not sqrt) — simpler to reason about and tune
 * per-tier than a continuous formula.
 *
 * Single-sample budget (fetchSamplesByHashes, one event per hash):
 *   <= 1h   → 2500ms
 *   <= 6h   → 4000ms
 *   <= 24h  → 6000ms
 *   <= 72h  → 10000ms
 *   > 72h   → 15000ms (hard ceiling)
 *
 * Batch budget (fetchEventsByHashes, N events per hash) uses the same
 * tiers but always returns the batch ceiling (MIN_BATCH_MS floor) because
 * fetching 50-250 events per hash is inherently heavier than 1.
 */

import { parseWindowMs } from './window-scaling.js';

// ─── Single-sample budget ──────────────────────────────────────────────────────

const BUDGET_TIERS: Array<{ maxHours: number; budgetMs: number }> = [
  { maxHours: 1,   budgetMs:  2500 },
  { maxHours: 6,   budgetMs:  4000 },
  { maxHours: 24,  budgetMs:  6000 },
  { maxHours: 72,  budgetMs: 10000 },
  { maxHours: Infinity, budgetMs: 15000 },
];

/** Default single-sample budget (matches the historic hardcoded 2500ms). */
export const DEFAULT_PER_HASH_MS = 2500;

/** Hard ceiling for single-sample and batch budgets (ms). */
export const MAX_PER_HASH_MS = 15000;

/**
 * Compute the per-hash race-timeout budget (ms) for a single-sample fetch,
 * scaled to the requested SIEM scan window.
 *
 * If window is missing or unparseable, returns DEFAULT_PER_HASH_MS (2500ms)
 * so the fallback behaviour is identical to the pre-defect-12 constant.
 */
export function computePerHashBudgetMs(window: string | undefined): number {
  if (!window) return DEFAULT_PER_HASH_MS;
  let ms: number;
  try {
    ms = parseWindowMs(window);
  } catch {
    return DEFAULT_PER_HASH_MS;
  }
  const hours = ms / 3_600_000;
  for (const tier of BUDGET_TIERS) {
    if (hours <= tier.maxHours) return tier.budgetMs;
  }
  // Unreachable (Infinity tier always matches), but TypeScript needs a return.
  return MAX_PER_HASH_MS;
}

// ─── maxPullMinutes scaling ────────────────────────────────────────────────────

/**
 * Compute a scaled maxPullMinutes cap for the SIEM-side pull budget.
 * pullEvents uses this to limit how many API calls / scan rounds it makes.
 *
 * A 1h scan is satisfied quickly (0.25 min); a 7d scan over many CW
 * partitions needs a larger budget or it times out before finding events.
 *
 * Piecewise, capped at 1.0 (60s) to avoid runaway SIEM queries:
 *   <= 1h   → 0.25 min
 *   <= 6h   → 0.33 min
 *   <= 24h  → 0.5  min
 *   <= 72h  → 0.75 min
 *   > 72h   → 1.0  min
 */
const PULL_MINUTES_TIERS: Array<{ maxHours: number; pullMinutes: number }> = [
  { maxHours: 1,        pullMinutes: 0.25 },
  { maxHours: 6,        pullMinutes: 0.33 },
  { maxHours: 24,       pullMinutes: 0.5  },
  { maxHours: 72,       pullMinutes: 0.75 },
  { maxHours: Infinity, pullMinutes: 1.0  },
];

/** Default maxPullMinutes when window is missing/unparseable (historic value). */
export const DEFAULT_MAX_PULL_MINUTES = 0.25;

/**
 * Compute a scaled maxPullMinutes for pullEvents, given the scan window.
 * Returns DEFAULT_MAX_PULL_MINUTES (0.25) if window is missing or unparseable.
 */
export function computeMaxPullMinutes(window: string | undefined): number {
  if (!window) return DEFAULT_MAX_PULL_MINUTES;
  let ms: number;
  try {
    ms = parseWindowMs(window);
  } catch {
    return DEFAULT_MAX_PULL_MINUTES;
  }
  const hours = ms / 3_600_000;
  for (const tier of PULL_MINUTES_TIERS) {
    if (hours <= tier.maxHours) return tier.pullMinutes;
  }
  return 1.0;
}
