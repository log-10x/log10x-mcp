/**
 * Trend-delta computation for log10x_top_patterns envelope.
 *
 * Produces a compact, pre-rendered TrendDelta per pattern row, driven
 * entirely from the existing state field + the 24h trend array already
 * fetched in Phase 2. No new Prometheus queries.
 *
 * Design contract (defect 13):
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
