/**
 * Shared types for read-only dependency-check API calls per SIEM.
 *
 * Each vendor module under `src/lib/siem/deps/` exports an async
 * `check<Vendor>Deps(opts)` returning a normalized `DepCheckResult`.
 * The dependency-check tool dispatches by vendor id, executes when
 * creds are present, and renders the result as markdown.
 */

import type { SiemId } from '../pricing.js';

export type DepMatchType = 'dashboard' | 'alert' | 'saved-search' | 'monitor' | 'metric-filter';

export type DepMatchedIn = 'name' | 'query' | 'definition';

export interface DepMatch {
  type: DepMatchType;
  name: string;
  url?: string;
  /** Where the pattern's keyword tokens hit — name, query body, dashboard definition, etc. */
  matchedIn: DepMatchedIn[];
}

export interface DepCheckResult {
  vendor: SiemId;
  scannedAt: string;
  pattern: string;
  matches: DepMatch[];
  /** Counts per type — convenient for the markdown summary line. */
  byType: {
    dashboards: number;
    alerts: number;
    savedSearches: number;
    monitors: number;
    metricFilters: number;
  };
  /** Non-fatal warnings collected during the scan (per-endpoint failures, partial coverage notes). */
  notes: string[];
  /** Set when the scan couldn't run at all — caller falls back to bash. */
  error?: string;
}

export interface DepCheckOptions {
  /** Normalized pattern name (snake_case identity). */
  pattern: string;
  /** Pre-tokenized keywords (already split + filtered). The checker decides its own length cutoff. */
  tokens: string[];
  /** Optional service-name scope. */
  service?: string;
  /** Optional severity scope. */
  severity?: string;
}

/** Empty-result helper — every vendor returns the same shape. */
export function emptyResult(vendor: SiemId, pattern: string): DepCheckResult {
  return {
    vendor,
    scannedAt: new Date().toISOString(),
    pattern,
    matches: [],
    byType: { dashboards: 0, alerts: 0, savedSearches: 0, monitors: 0, metricFilters: 0 },
    notes: [],
  };
}

/** Case-insensitive token-OR match. */
export function anyTokenMatches(haystack: string, tokens: string[]): boolean {
  if (!haystack) return false;
  const h = haystack.toLowerCase();
  return tokens.some((t) => t.length > 0 && h.includes(t.toLowerCase()));
}

/** Pick keyword tokens long enough to be meaningful (>= 4 chars) — falls back to the full pattern. */
export function meaningfulTokens(pattern: string, tokens: string[]): string[] {
  const meaningful = tokens.filter((t) => t.length >= 4);
  if (meaningful.length > 0) return meaningful;
  return [pattern.replace(/_/g, ' ')];
}
