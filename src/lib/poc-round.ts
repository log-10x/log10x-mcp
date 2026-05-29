/**
 * Rounding helpers for the v2 POC envelope.
 *
 * Floating-point arithmetic produces values like
 * `0.013631055065031563` for `$/mo`. Emitting those as-is is offensive
 * noise: it implies precision the calculation does not have, and it
 * causes downstream LLM readers to either fixate on the digits or to
 * truncate inconsistently.
 *
 * Conventions used at the envelope's emission sites:
 *
 *   dollars(x)   → cents ($0.01). Costs, savings, dollar-denominated
 *                  thresholds.
 *   ratio(x)     → 3 decimal places. Anything in [0, 1] expressed as
 *                  a fraction (share_of_total, head_concentration,
 *                  by_severity, by_service).
 *   bps(x)       → 2 decimal places. Bytes/sec rates (current_p95,
 *                  proposed_cap, approx_bytes_per_sec).
 *   days(x)      → 2 decimal places. Age, duration, etc.
 *   count_ratio(x) → 3 decimal places. Redundancy pair ratios.
 */

export function dollars(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

export function ratio(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}

export function bps(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

export function days(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

export function countRatio(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}
