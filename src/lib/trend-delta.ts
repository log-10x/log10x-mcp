/**
 * Trend-delta computation for log10x_top_patterns envelope.
 *
 * Produces a compact, pre-rendered TrendDelta per pattern row, driven
 * entirely from the existing state field + the 24h trend array already
 * fetched in Phase 2. No new Prometheus queries.
 *
 * Design contract:
 *   GROWING   → glyph ↗, scope 'wow', pct change from first half vs second half of trend array
 *   SHRINKING → glyph ↘, scope 'wow', signed negative pct
 *   STABLE    → glyph ─, scope 'wow', small pct near 0
 *   ACUTE     → glyph 🔥, scope 'h1', last 6 buckets vs prior 6 buckets
 *   NEW       → glyph 🆕, scope 'age', floor(firstSeenAgeSeconds / 86400) days
 *
 * Edge cases:
 *   - empty or single-point trend array  → value: 0, label: '—'
 *   - null firstSeenAgeSeconds for NEW   → value: 0, label: '—'
 */

import type { Badge } from './top-patterns-extras.js';

export type TrendDelta = {
  glyph: '↗' | '↘' | '─' | '🔥' | '🆕';
  value: number;
  unit: 'pct' | 'days';
  scope: 'wow' | 'h1' | 'age';
  /** Pre-rendered short label, e.g. '+45% WoW', '+220% 1h', '3d'. */
  label: string;
};

/**
 * How the age was sourced for a NEW pattern's display string.
 *   'engine_metric'          — firstSeenAgeSeconds came from the first-seen TSDB query
 *   'derived_from_trend_window' — age derived from trend array length × step seconds
 *   'unknown'                — neither source was available
 */
export type FirstSeenAgeSource = 'engine_metric' | 'derived_from_trend_window' | 'unknown';

/**
 * Build the pre-composed display string for a TrendDelta row.
 *
 * For GROWING/SHRINKING/STABLE/ACUTE: "${glyph} ${label}"
 * For NEW with known engine age: "🆕 Xh ago" / "🆕 Xd ago"
 * For NEW with unknown engine age but trend window available:
 *   derives max age from trendLength × stepSec and emits "🆕 <Nh ago" / "🆕 ~Nmin ago"
 * For NEW with no information: "🆕 (age unknown)"
 *
 * @param td             - The TrendDelta struct already computed by computeTrendDelta.
 * @param ageSeconds     - firstSeenAgeSeconds from the engine metric, or null.
 * @param trendLength    - Number of samples in the trend array (used for derivation).
 * @param stepSec        - Seconds per trend sample (e.g. 600 for 10-min buckets).
 */
export function fmtTrendDelta(
  td: TrendDelta,
  ageSeconds: number | null,
  trendLength: number,
  stepSec: number
): { display: string; ageSource: FirstSeenAgeSource } {
  if (td.scope !== 'age') {
    // GROWING / SHRINKING / STABLE / ACUTE — simple concatenation.
    return {
      display: `${td.glyph} ${td.label}`,
      ageSource: 'unknown',
    };
  }

  // NEW — build a human age string.
  if (ageSeconds !== null && ageSeconds >= 0) {
    const display = _ageDisplay(ageSeconds, '🆕', false);
    return { display, ageSource: 'engine_metric' };
  }

  // Derive from trend window when engine age is unavailable.
  if (trendLength > 1 && stepSec > 0) {
    const maxAgeSeconds = trendLength * stepSec;
    const display = _ageDisplay(maxAgeSeconds, '🆕', true);
    return { display, ageSource: 'derived_from_trend_window' };
  }

  return { display: '🆕 (age unknown)', ageSource: 'unknown' };
}

/** Format a seconds-age as a readable suffix like "22h ago" or "3d ago". */
function _ageDisplay(seconds: number, glyph: string, approximate: boolean): string {
  const prefix = approximate ? '<' : '';
  if (seconds < 60) return `${glyph} ${prefix}1min ago`;
  if (seconds < 3600) {
    const mins = Math.round(seconds / 60);
    return `${glyph} ${prefix}${mins}min ago`;
  }
  if (seconds < 86400) {
    const hours = Math.round(seconds / 3600);
    return `${glyph} ${prefix}${hours}h ago`;
  }
  const days = Math.floor(seconds / 86400);
  return `${glyph} ${prefix}${days}d ago`;
}

/** Map a Badge/State to its canonical glyph so glyph always matches state. */
export function glyphForState(state: Badge): TrendDelta['glyph'] {
  switch (state) {
    case 'GROWING':   return '↗';
    case 'SHRINKING': return '↘';
    case 'STABLE':    return '─';
    case 'ACUTE':     return '🔥';
    case 'NEW':       return '🆕';
  }
}

/** Number of 10-min buckets in 1 hour. */
const H1_BUCKETS = 6;

/** Compute a signed integer percent: Math.round((b/a - 1) * 100).
 * Returns null when `a` is zero (division undefined). */
function pctChange(a: number, b: number): number | null {
  if (a <= 0) return null;
  return Math.round(((b - a) / a) * 100);
}

/** Mean of an array slice, or 0 when empty. */
function mean(arr: number[], start: number, end: number): number {
  const slice = arr.slice(start, end);
  if (slice.length === 0) return 0;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/**
 * Compute the trend delta for one pattern row.
 *
 * @param state        - The Badge/State already classified for this row.
 * @param trendArray   - Byte-rate values from the 24h trend query (up to 144 pts).
 * @param firstSeenAgeSeconds - Age in seconds, or null when unknown (used for NEW).
 */
export function computeTrendDelta(
  state: Badge,
  trendArray: number[],
  firstSeenAgeSeconds: number | null
): TrendDelta {
  const fallback = (glyph: TrendDelta['glyph']): TrendDelta => ({
    glyph,
    value: 0,
    unit: 'pct',
    scope: state === 'NEW' ? 'age' : state === 'ACUTE' ? 'h1' : 'wow',
    label: '—',
  });

  if (state === 'NEW') {
    if (firstSeenAgeSeconds === null || firstSeenAgeSeconds < 0) {
      return { glyph: '🆕', value: 0, unit: 'days', scope: 'age', label: '—' };
    }
    const days = Math.floor(firstSeenAgeSeconds / 86400);
    return {
      glyph: '🆕',
      value: days,
      unit: 'days',
      scope: 'age',
      label: `${days}d`,
    };
  }

  if (state === 'ACUTE') {
    if (trendArray.length < 2) return fallback('🔥');
    const len = trendArray.length;
    // Last H1_BUCKETS vs the H1_BUCKETS immediately before them.
    const tail = mean(trendArray, Math.max(0, len - H1_BUCKETS), len);
    const prior = mean(trendArray, Math.max(0, len - 2 * H1_BUCKETS), Math.max(0, len - H1_BUCKETS));
    const pct = pctChange(prior, tail);
    if (pct === null) return fallback('🔥');
    const sign = pct >= 0 ? '+' : '';
    return {
      glyph: '🔥',
      value: pct,
      unit: 'pct',
      scope: 'h1',
      label: `${sign}${pct}% 1h`,
    };
  }

  // GROWING / SHRINKING / STABLE — all use first-half vs second-half WoW.
  if (trendArray.length < 2) {
    const glyph = state === 'GROWING' ? '↗' : state === 'SHRINKING' ? '↘' : '─';
    return fallback(glyph);
  }
  const mid = Math.floor(trendArray.length / 2);
  const firstHalf = mean(trendArray, 0, mid);
  const secondHalf = mean(trendArray, mid, trendArray.length);
  const pct = pctChange(firstHalf, secondHalf);
  const glyph: TrendDelta['glyph'] = state === 'GROWING' ? '↗' : state === 'SHRINKING' ? '↘' : '─';
  if (pct === null) return fallback(glyph);
  const sign = pct > 0 ? '+' : pct < 0 ? '' : '±';
  const absStr = pct === 0 ? '0' : Math.abs(pct).toString();
  const label = state === 'STABLE' ? `±${absStr}% WoW` : `${sign}${pct}% WoW`;
  return {
    glyph,
    value: pct,
    unit: 'pct',
    scope: 'wow',
    label,
  };
}
