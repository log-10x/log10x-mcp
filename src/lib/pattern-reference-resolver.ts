/**
 * pattern-reference-resolver — accept the way USERS refer to patterns
 * (rank number, free text, hash) at the input layer of any tool that
 * takes a `pattern` / `pattern_hash` arg.
 *
 * WHY THIS EXISTS
 *
 * Note 19 from the arc-rendering review: real user behavior when the
 * agent surfaces a top_patterns / whats_new / whats_changing list is:
 *
 *   - A rank number — "1", "the first one", "pattern 1", "top one"
 *   - Free text — "the payment one", "the OTEL collector ERROR",
 *     "Accounting Consumer Order"
 *
 * Users will NEVER type the 11-char `4Kjc7PHLWqY` hash or the
 * 100+ char descriptor verbatim.
 *
 * SCOPE OF THIS PR (LIGHT VERSION)
 *
 *   - `looksLikeRank(input)` — pure helper. True when the input looks
 *     like a small positive integer in the typical top-N range (1-50).
 *   - `PATTERN_HASH_REGEX` — re-exported from `anchor-promql.ts` for
 *     visibility, so executors can write
 *     `import { looksLikeRank, PATTERN_HASH_REGEX } from
 *      '../lib/pattern-reference-resolver.js'`
 *     without separately importing from anchor-promql.
 *
 * FUTURE WORK — DEFERRED
 *
 *   - A session-scoped "last surfaced patterns" cache, keyed by env_id
 *     plus tool-call sequence. The chassis renderer would feed the cache
 *     after every list-returning tool (top_patterns, whats_new,
 *     whats_changing, pattern_diff). Subsequent tools that take a
 *     `pattern` arg call `resolvePatternReference()` which checks:
 *       1. Number → rank lookup from the cache.
 *       2. Hash-shape (PATTERN_HASH_REGEX) → use as-is.
 *       3. Free text → fuzzy match (token-overlap, case-insensitive)
 *          against the cache. Exactly-one match → use it. Ambiguous →
 *          return a chassis envelope with status='ambiguous_reference'
 *          plus the candidate matches for the agent to disambiguate.
 *
 *   - The session cache itself probably lives in `src/lib/session-cache.ts`
 *     (new file) with backing storage in `~/.log10x/session/` so the
 *     state survives across MCP process restarts within one client
 *     session.
 *
 *   - The chassis `actions[]` emitter changes to produce
 *     "Reply `1` (or the pattern name) to drill into the OTEL collector
 *     ERROR" instead of "log10x_pattern_examples({pattern_hash:
 *     '4Kjc7PHLWqY'})". That requires the cache to be populated AND a
 *     rendering-side contract change, both larger than this PR.
 *
 *   These pieces are intentionally NOT in this PR. Note 19 calls them
 *   out as a separate workstream.
 */

import { PATTERN_HASH_REGEX } from './anchor-promql.js';

// Re-export for visibility — tools that take a pattern arg should
// be able to import the canonical hash regex from one place.
export { PATTERN_HASH_REGEX };

/**
 * True when the input looks like a small positive integer in the
 * typical top-N range (1 through 50 inclusive).
 *
 * Accepts both `number` and `string` inputs because tool args come in
 * as JSON-deserialized values and the user might pass `1` or `"1"`.
 *
 * The 50 cap is a heuristic: top_patterns currently defaults to 10 and
 * can go to 25/50 via "more" continuations (Note 4). A rank above 50
 * is more likely a typo (or someone passing a pattern hash whose first
 * 2 chars happen to be digits) than a legitimate rank reference, so
 * we conservatively reject it and let the executor surface an
 * "out-of-range rank" hint.
 *
 * Returns false for:
 *   - non-integers (1.5)
 *   - negatives or zero
 *   - strings that don't parse cleanly as integers ("1abc", "1.0")
 *   - integers > 50
 *
 * @param input The candidate user reference — either a number or a
 *              string fragment.
 * @returns True when the input is a 1-50 rank reference.
 */
export function looksLikeRank(input: string | number): boolean {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input >= 1 && input <= 50;
  }
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (trimmed.length === 0) return false;
  // Strict integer match — no leading +, no decimal, no scientific.
  if (!/^[0-9]+$/.test(trimmed)) return false;
  const n = parseInt(trimmed, 10);
  return n >= 1 && n <= 50;
}
