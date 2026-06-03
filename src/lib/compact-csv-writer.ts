/**
 * Compact-CSV writer — emits the per-pattern boolean compact control file
 * that the `compactReceiver` JS reads to decide which patterns to encode.
 *
 * File written: `pipelines/run/receive/compact/compact-cap.csv`
 * Header: `fieldSet,value`
 * Row format: `<pattern_hash>,<true|false>:<untilEpoch>:<reason>`
 *
 * This is DISTINCT from the rate cap CSV (`pipelines/run/receive/rate/caps.csv`)
 * which uses a numeric bytes-per-window format with container-level keys.
 * The compact CSV is per-pattern (keyed by pattern_hash), boolean, and
 * read only by the compact receiver — never by the rate receiver.
 *
 * Compact path:
 *   L1 outcome = compact
 *   → MCP calls emitCompactRows()
 *   → writes compact-cap.csv with `pattern_hash,true:<epoch>:<reason>`
 *   → compact receiver JS reads fieldSet column, matches against
 *     the event's symbolMessage / tenx_hash (per compactReceiverFieldNames),
 *     and routes matching events through the encoding pipeline.
 */

export interface CompactCsvRow {
  /** Stable pattern identity (tenx_hash / symbolMessage depending on receiver config). */
  pattern_hash: string;
  /** true = encode this pattern; false = pass through unencoded. */
  encode: boolean;
  /**
   * Unix epoch seconds at which this row expires. When the engine's
   * compact receiver evaluates the row at or after this timestamp it
   * treats the pattern as if the row were absent (no encode). Omit for
   * a non-expiring entry.
   */
  untilEpoch?: number;
  /** Human-readable label explaining why this pattern is compacted. */
  reason?: string;
}

/**
 * Emit a compact-CSV string from a list of per-pattern compact directives.
 *
 * The output is suitable for writing directly to
 * `pipelines/run/receive/compact/compact-cap.csv` in the customer gitops repo.
 *
 * Value grammar: `<true|false>:<untilEpoch>:<reason>`
 * When `untilEpoch` is absent the value is `<true|false>::<reason>` (double
 * colon preserves the reason position so a parser can still split on `::`).
 * When both are absent the value is just `<true|false>`.
 *
 * Rows are sorted by pattern_hash for deterministic diffs.
 */
export function emitCompactRows(rows: CompactCsvRow[]): string {
  const out: string[] = ['fieldSet,value'];
  const sorted = [...rows].sort((a, b) => a.pattern_hash.localeCompare(b.pattern_hash));
  for (const r of sorted) {
    const encodePart = r.encode ? 'true' : 'false';
    let value: string;
    if (r.untilEpoch !== undefined && r.reason) {
      value = `${encodePart}:${r.untilEpoch}:${r.reason.replace(/,/g, ';')}`;
    } else if (r.untilEpoch !== undefined) {
      value = `${encodePart}:${r.untilEpoch}:`;
    } else if (r.reason) {
      value = `${encodePart}::${r.reason.replace(/,/g, ';')}`;
    } else {
      value = encodePart;
    }
    out.push(`${r.pattern_hash},${value}`);
  }
  return out.join('\n') + '\n';
}
