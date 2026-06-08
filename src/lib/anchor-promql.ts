/**
 * Hash-aware anchor PromQL builder for the cross-pillar primitives
 * (`metrics_that_moved`, `rank_by_shape_similarity`).
 *
 * Both tools accept a pattern anchor as either its Symbol Message NAME
 * (used as the `message_pattern` PromQL label value) OR its 11-char
 * `pattern_hash` / `tenx_hash`. Chains driven by `top_patterns` /
 * `pattern_detail` typically carry the hash forward, NOT the name —
 * so if these tools only knew how to select on `message_pattern`, the
 * anchor query would return zero series and the chain would error
 * with `anchor_not_found`.
 *
 * The detection is shape-only: 11 chars, base64url alphabet (RFC 4648,
 * matching `tenxHash()` output in `pattern-hash.ts`). When it matches
 * we select on `LABELS.hash`; otherwise we select on `LABELS.pattern`.
 */

import { LABELS } from './promql.js';

/**
 * Canonical regex for a `tenx_hash` value. Mirrors the output shape of
 * `tenxHash()` in `pattern-hash.ts`: base64url-encoded 8-byte xxHash64
 * is always exactly 11 characters from the base64url alphabet
 * (`A-Z a-z 0-9 - _`). No padding.
 */
export const PATTERN_HASH_REGEX = /^[A-Za-z0-9_-]{11}$/;

/** Returns true when `s` looks like a `pattern_hash` (11-char base64url). */
export function looksLikePatternHash(s: string): boolean {
  return PATTERN_HASH_REGEX.test(s);
}

/**
 * Build the anchor `sum(rate(...))` PromQL for a `log10x_pattern`-typed
 * anchor. Detects hash-shape input and switches the selector label
 * (`LABELS.hash` vs `LABELS.pattern`) accordingly.
 *
 * @param anchor      Anchor identity — symbol_message name OR pattern_hash.
 * @param metricsEnv  Environment label value (from `resolveMetricsEnv`).
 * @param rangeSec    Rate window in seconds (already widened by caller).
 */
export function buildPatternAnchorRateQuery(
  anchor: string,
  metricsEnv: string,
  rangeSec: number,
): string {
  const escaped = anchor.replace(/"/g, '\\"');
  const selectorLabel = looksLikePatternHash(anchor) ? LABELS.hash : LABELS.pattern;
  return (
    `sum(rate(all_events_summaryBytes_total{` +
    `${selectorLabel}="${escaped}",${LABELS.env}="${metricsEnv}"}[${rangeSec}s]))`
  );
}
