/**
 * anti-jargon-prose — pure helpers that strip / rewrite agent-internal
 * vocabulary out of user-visible prose fields on chassis envelopes.
 *
 * WHY THIS EXISTS
 *
 * The chassis serves two audiences:
 *   1. The agent (LLM doing tool selection + branching) — needs
 *      structured fields like `decisions.threshold_basis`, raw PromQL
 *      refs, `phase_gap`, `n_anchor_buckets`, etc.
 *   2. The user (reads what the agent surfaces) — needs plain English.
 *
 * Today the chassis fields meant for the user (`headline`,
 * `human_summary`, `must_render_verbatim`) routinely leak agent-internal
 * vocabulary verbatim. The arc-rendering review (notes 9-13, 16-18)
 * catalogued the banned phrases and called out raw PromQL bleeding into
 * markdown the user reads.
 *
 * This module gives every chassis-emitting tool a pure
 * `sanitizeUserProse()` it can run on a string before serialization.
 * It is intentionally a string-in / string-out function with no
 * side effects, so it can be applied at envelope-build time
 * (`buildChassisEnvelope`) without needing per-tool plumbing.
 *
 * RULES ENFORCED
 *
 *   - CLAUDE.md anti-data-science rule (BURNED in memory):
 *       ban "candidate", "anchor", "co-mover", "phase_gap",
 *       "noise floor", "clean-chain threshold", "Pearson", "@lag",
 *       "unvalidated_default" (as user-facing string),
 *       "evaluated" / "could not be evaluated",
 *       "env total" / "env patterns" / "env-scoped".
 *   - Note 3 — "SIEM" → "source".
 *   - Note 10 — raw PromQL → descriptor.
 *   - Note 13 — "sentinel" → "placeholder marker",
 *     "dispatched" → "ran", "asserts" → "checks",
 *     "e2e probe" → "end-to-end check".
 *   - Note 18 — pattern_hash (11-char base64url) stripped from
 *     user-visible prose via `stripHashFromVisible`.
 *
 * DEFERRED
 *
 *   - Note 19 fuzzy-match + session-cache layer for pattern references
 *     (rank / free-text) — separate module
 *     (`pattern-reference-resolver.ts`).
 *   - Per-tool prose rewrites (chassis-prose contract migration) — done
 *     incrementally in each tool's executor; this module is the
 *     foundational filter, not a replacement for plain-English authoring.
 */

import { PATTERN_HASH_REGEX } from './anchor-promql.js';

// ── Banned-phrase replacements ────────────────────────────────────────────────

/**
 * Static map of agent-vocabulary phrases to their user-facing equivalents.
 *
 * Each entry is `[regex, replacement]`. Regexes are case-insensitive and
 * use word boundaries where the term is a standalone word (so "anchored"
 * is NOT rewritten to "what-we-looked-ated").
 *
 * Order matters: longer phrases come first so they win against shorter
 * substrings (e.g. "could not be evaluated" before "evaluated").
 */
const BANNED_PHRASE_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // Longer compound phrases first (Note 10, 12).
  [/\bcould not be evaluated\b/gi, "couldn't check"],
  [/\bclean-chain threshold\b/gi, 'match threshold'],
  [/\bnoise floor\b/gi, 'minimum threshold'],
  [/\bphase[_ ]gap\b/gi, 'time offset'],
  [/\bunvalidated[_ ]default\b/gi, 'default (not yet tuned for your data)'],
  [/\b\|?Pearson@lag\|?\b/gi, 'shape match score'],
  [/\bPearson\b/gi, 'shape match score'],
  [/\b@lag\b/gi, ''],

  // Audience-mismatch tokens (Note 1 — env, Note 3 — SIEM).
  [/\benv total\b/gi, 'total'],
  [/\benv patterns\b/gi, 'patterns'],
  [/\benv-scoped\b/gi, 'scoped'],
  [/\bSIEM\b/g, 'source'],

  // Engineering verbs / artefacts (Note 13).
  [/\be2e probe\b/gi, 'end-to-end check'],
  [/\bsentinel\b/gi, 'placeholder marker'],
  [/\basserts?\b/gi, 'checks'],
  [/\bdispatched\b/gi, 'ran'],

  // Lone agent-vocabulary nouns (Note 10, 11, 12). Use word boundaries
  // so we don't rewrite "anchored" / "candidates_failed".
  [/\bco-movers?\b/gi, 'related metrics'],
  [/\bcandidates?\b/gi, 'metrics'],
  [/\banchor\b/gi, 'what we looked at'],
  [/\bevaluated\b/gi, 'checked'],
];

// ── Raw-PromQL detection ──────────────────────────────────────────────────────

/**
 * Heuristic: does this string contain a raw PromQL expression a user
 * would not understand? Matches the common shapes from Notes 11 and 12:
 *
 *   - `sum(rate(...))` aggregations
 *   - `{tenx_hash="..."}` label selectors
 *   - `{...[Ns]}` rate windows
 *   - `histogram_quantile(...)`
 *
 * Conservative — we only flag fragments that look unambiguously like
 * PromQL. A user-prose string mentioning "rate of change" should NOT
 * trigger.
 */
const PROMQL_FRAGMENTS: ReadonlyArray<RegExp> = [
  /\bsum\(rate\(/i,
  /\bavg\(rate\(/i,
  /\bmax\(rate\(/i,
  /\{tenx_hash\s*=/,
  /\{tenx_env\s*=/,
  /\{message_pattern\s*=/,
  /\bhistogram_quantile\(/i,
  /\[\d+s\]\)/,
];

/**
 * If a fenced or backtick-quoted PromQL fragment is detected anywhere in
 * the string, rewrite the WHOLE backtick-bounded fragment to a
 * descriptor placeholder. We don't try to extract structure from
 * the PromQL — the user just needs to know "we measured the volume of
 * this pattern" instead of seeing the raw query.
 *
 * Strategy:
 *   1. Replace any inline-code or fenced-code block that contains
 *      PromQL with the descriptor "(volume of the pattern over the
 *      window)".
 *   2. After the code blocks are gone, if any bare PromQL fragment
 *      remains (no backticks), replace it with the same descriptor.
 */
function replaceRawPromQL(text: string): string {
  // First pass: backtick-quoted inline code (single or triple).
  let out = text.replace(/`{3}[\s\S]*?`{3}|`[^`\n]+`/g, (match) => {
    if (PROMQL_FRAGMENTS.some((re) => re.test(match))) {
      return '(volume of the pattern over the window)';
    }
    return match;
  });

  // Second pass: bare PromQL fragments not wrapped in backticks. We use
  // a relatively narrow regex so we only strip what is clearly PromQL.
  // `sum(rate(...))` or a `{tenx_hash="..."}` selector with brackets.
  out = out.replace(
    /\b(?:sum|avg|max)\(rate\([^)]*\)[^)]*\)/gi,
    '(volume of the pattern over the window)',
  );
  out = out.replace(
    /\{(?:tenx_hash|tenx_env|message_pattern)[^}]*\}/g,
    '(pattern selector)',
  );

  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Strip / rewrite banned agent-vocabulary out of user-visible prose.
 *
 * Pure function. Input string in, sanitized string out. No side effects.
 * Empty / null-ish input returns the input unchanged.
 *
 * Apply this to `headline`, `human_summary`, `must_render_verbatim`,
 * and any other user-eye-facing string before envelope serialization.
 * Apply BEFORE `stripHashFromVisible` if both are needed — banned-phrase
 * rewrites can introduce or reveal hash-like substrings only in
 * pathological cases, but the deterministic order keeps results
 * predictable.
 *
 * @param text The raw user-prose string a tool authored.
 * @returns The cleaned string, ready for serialization.
 */
export function sanitizeUserProse(text: string): string {
  if (!text) return text;
  let out = text;

  // Pass 1: raw PromQL detection and replacement. Done first because
  // banned-phrase rules below can collide with PromQL keywords ("rate",
  // "sum") that are safe in prose but not in code.
  out = replaceRawPromQL(out);

  // Pass 2: phrase rewrites. Each entry is run independently; order is
  // defined by BANNED_PHRASE_REWRITES (longer phrases first).
  for (const [re, rep] of BANNED_PHRASE_REWRITES) {
    out = out.replace(re, rep);
  }

  // Pass 3: normalize whitespace introduced by deletions like `@lag`.
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/ \./g, '.');
  out = out.replace(/ ,/g, ',');

  return out;
}

/**
 * Strip 11-char base64url tokens (pattern hashes) from a user-visible
 * string. Mirrors Note 18 and the BURNED memory rule:
 *   "Never put pattern_hash in user-facing headlines — hashes confuse
 *    users; lead with pattern name + service + state."
 *
 * The default regex is `PATTERN_HASH_REGEX` from `anchor-promql.ts`
 * (the canonical 10x pattern-hash shape). Callers can pass a different
 * regex to strip a related identifier shape (e.g. a 16-hex template
 * hash) — but the default covers the common case.
 *
 * Strategy:
 *   - Inline-code wrapped (`abc12345678`) hashes → removed including the
 *     backticks (otherwise we'd leave empty `` `` `` artefacts).
 *   - Bare 11-char tokens flanked by word boundaries → removed.
 *   - Trailing whitespace and punctuation orphans from the removal are
 *     normalized in a final pass.
 *
 * Pure function; no side effects.
 *
 * @param text       The raw user-prose string.
 * @param hashRegex  Optional override. Must include a single token
 *                   pattern; defaults to PATTERN_HASH_REGEX.
 * @returns The string with hashes stripped.
 */
export function stripHashFromVisible(
  text: string,
  hashRegex: RegExp = PATTERN_HASH_REGEX,
): string {
  if (!text) return text;

  // Build a /g variant of the supplied regex without anchors so we can
  // find tokens anywhere in the string. We unwrap leading `^` / trailing
  // `$` if present so the pattern body matches at any position.
  const body = hashRegex.source.replace(/^\^/, '').replace(/\$$/, '');
  const flags = hashRegex.flags.includes('g') ? hashRegex.flags : hashRegex.flags + 'g';
  const tokenRe = new RegExp(body, flags);

  // Pass 1: strip backtick-wrapped hashes including their backticks.
  // Use a tightly-scoped regex: backtick, then exactly the hash shape,
  // then backtick.
  const wrappedRe = new RegExp('`' + body + '`', flags);
  let out = text.replace(wrappedRe, '');

  // Pass 2: bare tokens. Word-boundaries protect against accidentally
  // shaving longer identifiers that happen to end in 11 base64url chars.
  out = out.replace(tokenRe, (match) => {
    // Skip if the match is part of a longer identifier (e.g. "abc..._xy"
    // where the surrounding chars are also word chars). We only strip
    // when the token stands alone.
    return '';
  });

  // Pass 3: tidy artefacts — empty parens, double spaces, leading
  // punctuation orphans, dangling colons before nothing.
  out = out.replace(/\(\s*\)/g, '');
  out = out.replace(/\[\s*\]/g, '');
  out = out.replace(/`\s*`/g, '');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/ \./g, '.');
  out = out.replace(/ ,/g, ',');
  out = out.replace(/:\s*([.,;)])/g, '$1');
  out = out.replace(/"\s*"/g, '');

  return out.trim();
}
