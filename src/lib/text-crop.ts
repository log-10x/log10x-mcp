/**
 * Codepoint-safe text cropping primitive (Layer 1 of the pattern-name
 * display work).
 *
 * THE BUG THIS REPLACES: front-crop + trailing ellipsis
 * (`s.slice(0, w - 3) + '...'`) does two wrong things on real pattern
 * names:
 *   1. UTF-16 `.slice()` cuts in the middle of a surrogate pair, producing
 *      mojibake (a lone half of an astral codepoint) on any name carrying
 *      emoji / CJK / astral glyphs.
 *   2. A pure FRONT crop drops the tail — but 10x symbol-message names that
 *      share a long common PREFIX (the OTel boilerplate run) differ only at
 *      the END, so trailing-ellipsis makes them render identically. The
 *      discriminating token (`opensearch`, `batch`, …) is exactly what gets
 *      cut.
 *
 * `midEllipsis` keeps BOTH ends: it iterates by Unicode codepoint (so it
 * never splits a surrogate pair) and elides the middle, preserving the
 * head (where the lead context lives) AND the tail (where the
 * discriminator lives). One '…' (U+2026), never three ASCII dots.
 *
 * Pure + deterministic: no env, no clock, no allocation beyond the
 * codepoint array. The single crop primitive every surface routes raw
 * symbol-message rendering through.
 */

/**
 * Crop `s` to at most `width` display columns, eliding the middle with a
 * single '…' when it would overflow. Returns `s` verbatim when it already
 * fits (counted in codepoints, NOT UTF-16 code units).
 *
 * Split: head = ceil(0.6·(width−1)), tail = floor(0.4·(width−1)); the
 * remaining 1 column is the ellipsis, so head + tail + 1 === width exactly.
 * The 60/40 bias keeps more of the head (lead context) while still showing
 * the tail (discriminator).
 */
export function midEllipsis(s: string, width: number): string {
  // Iterate by codepoint — [...s] yields whole codepoints (astral glyphs
  // counted once), unlike s.length / s.slice which count UTF-16 units and
  // can bisect a surrogate pair.
  const cps = [...s];
  if (cps.length <= width) return s;
  // Degenerate widths: nothing sensible to elide into. Hard-crop the head.
  if (width <= 1) return cps.slice(0, Math.max(0, width)).join('');
  const budget = width - 1; // reserve one column for the ellipsis
  const head = Math.ceil(0.6 * budget);
  const tail = Math.floor(0.4 * budget);
  const headStr = cps.slice(0, head).join('');
  const tailStr = tail > 0 ? cps.slice(cps.length - tail).join('') : '';
  return `${headStr}…${tailStr}`;
}

/**
 * Codepoint-aware length — counts whole Unicode codepoints, the unit
 * `midEllipsis` and the column-budget guards reason in. Use this instead of
 * `s.length` anywhere a width comparison drives cropping, so an astral glyph
 * counts as one column rather than two.
 */
export function codepointLength(s: string): number {
  return [...s].length;
}
