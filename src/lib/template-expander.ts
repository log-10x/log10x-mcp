/**
 * Template expander: substitute positional slot values into a template body.
 *
 * The engine marks variable slots with `$` (bare) or `$(format-spec)` in the
 * template body. `encoded.log` lines carry the slot values in the same order
 * the slots appear left-to-right in the template. To recover the original
 * text we substitute each `$` (and each `$(...)`) with the corresponding
 * value from the `values[]` array.
 *
 * This is the inverse of the engine's templating pass. It is NOT lossless
 * for timestamp slots (the engine emits the epoch epoch value as a formatted
 * string; we reverse the slot marker with the raw value from `values[]`). For
 * compaction measurement that is fine: we care about byte lengths, not exact
 * round-trip fidelity.
 *
 * Unit-testable: `expandTemplate(template, values)` is a pure function.
 */

/**
 * Expand a template body by substituting `$` slot markers with positional
 * values.
 *
 * Slot markers in the template:
 *   - Bare `$`               — consume the next value from `values[]`
 *   - `$(format-spec)`       — consume the next value; the spec is dropped
 *
 * Values beyond the slot count are ignored. Slots without a corresponding
 * value are left as the empty string (best-effort: a missing trailing slot
 * should not abort the expansion).
 *
 * @param template  Template body string from `templates.json`
 * @param values    Slot values in positional order from the `encoded.log` line
 * @returns         Reconstructed original log text
 */
export function expandTemplate(template: string, values: string[]): string {
  let result = '';
  let i = 0;
  let slotIdx = 0;

  while (i < template.length) {
    const c = template[i];
    if (c === '$') {
      const next = template[i + 1];
      if (next === '(') {
        // Typed format-spec slot: `$(yyyy-MM-dd'T'HH:mm:ss'Z')`.
        // Find the matching `)` and skip the spec entirely.
        const end = template.indexOf(')', i + 2);
        if (end === -1) {
          // Malformed spec — treat rest as literal.
          result += template.slice(i);
          break;
        }
        const value = slotIdx < values.length ? values[slotIdx] : '';
        result += value;
        slotIdx += 1;
        i = end + 1;
        continue;
      }
      // Bare `$` — untyped slot.
      const value = slotIdx < values.length ? values[slotIdx] : '';
      result += value;
      slotIdx += 1;
      i += 1;
      continue;
    }
    result += c;
    i += 1;
  }

  return result;
}

/**
 * Measure the UTF-8 byte length of the original log line reconstructed
 * from a template + values. Convenience wrapper for compaction measurement.
 */
export function expandedByteLength(template: string, values: string[]): number {
  const expanded = expandTemplate(template, values);
  return Buffer.byteLength(expanded, 'utf8');
}
