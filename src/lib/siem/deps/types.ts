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

/**
 * Case-insensitive token-OR match.
 *
 * @deprecated Replaced by `allTokensMatchExact` for the dependency-check
 * tool. The OR substring approach matched any saved search whose body
 * contained one of the pattern tokens, producing dependencies on saved
 * searches that didn't actually reference the pattern semantically.
 * Kept for back-compat with any caller outside the dep-check vendor
 * modules.
 */
export function anyTokenMatches(haystack: string, tokens: string[]): boolean {
  if (!haystack) return false;
  const h = haystack.toLowerCase();
  return tokens.some((t) => t.length > 0 && h.includes(t.toLowerCase()));
}

/**
 * Strict token-AND match using the templater's tokenization rules.
 *
 * The haystack is split on non-alphanumeric runs and lower-cased to
 * produce a token set. The match passes when every supplied pattern
 * token appears as a discrete token in the haystack — not just as a
 * substring. Two consequences:
 *
 *   1. ALL pattern tokens must appear, not just one. A saved search
 *      that incidentally contains the word `payment` won't match
 *      `Payment_Gateway_Timeout` unless `gateway` and `timeout` are
 *      also present in the haystack.
 *   2. Tokens must be discrete. The substring `paymentgatewaytimeout`
 *      stuffed into a single identifier will NOT satisfy a match for
 *      `payment, gateway, timeout` because the haystack tokenizer
 *      doesn't split it. This trades some recall for a major precision
 *      gain — the dep-check tool's old OR-substring matcher delivered
 *      false-positive dependencies on saved searches that just happened
 *      to mention one common word.
 *
 * This is the matcher the dependency-check tool uses on saved-search
 * names, queries, alert messages, and dashboard descriptions. It mirrors
 * the templater's symbol tokenization (split on non-alphanumeric, ≥ 2
 * chars) so a pattern like `Payment_Gateway_Timeout` matches a saved
 * search whose body says `payment gateway timeout` or
 * `Payment.Gateway.Timeout` but not one that just mentions `payment`.
 */
export function allTokensMatchExact(haystack: string, tokens: string[]): boolean {
  if (!haystack || tokens.length === 0) return false;
  const haystackTokens = new Set(
    haystack
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (!haystackTokens.has(t.toLowerCase())) return false;
  }
  return true;
}

/** Pick keyword tokens long enough to be meaningful (>= 4 chars) — falls back to the full pattern. */
export function meaningfulTokens(pattern: string, tokens: string[]): string[] {
  const meaningful = tokens.filter((t) => t.length >= 4);
  if (meaningful.length > 0) return meaningful;
  return [pattern.replace(/_/g, ' ')];
}
