/**
 * Mute-CSV writer — emits the per-pattern sample-rate control file
 * that the rate receiver reads to decide how aggressively to shed each
 * pattern's volume.
 *
 * File written: `pipelines/run/receive/rate/caps.csv`
 * (same file as the rate cap CSV, but the MUTE section uses pattern-keyed
 * `fieldSet,value` rows instead of container-keyed `container,cap` rows)
 *
 * Row format: `<pattern_hash>,<sample_rate>:<untilEpoch>:<reason>`
 *   - sample_rate = 0   → full drop (no events pass)
 *   - sample_rate = 0.1 → keep 10% (sample)
 *   - sample_rate = 1.0 → pass all (no-op, generally omitted)
 *
 * This writer is used by the L1 outcome multiplexer for `drop` and `sample`
 * outcomes. The compact outcome uses `compact-csv-writer.ts` instead —
 * compact is boolean + writes a SEPARATE file.
 *
 * For the rate cap CSV (per-container bytes cap), callers use the
 * existing `renderCsv` / `renderCsvDiff` functions in `configure-engine.ts`.
 */

export interface MuteCsvRow {
  /** Stable pattern identity (tenx_hash). */
  pattern_hash: string;
  /**
   * Fraction of events to forward (0..1).
   *   0   = full mute / drop
   *   0.1 = sample at 10%
   *   1.0 = pass (no reduction — generally omit this row)
   */
  sample_rate: number;
  /**
   * Unix epoch seconds at which this row expires. When the receiver
   * evaluates the row at or after this timestamp it treats the pattern
   * as if the row were absent. Omit for a non-expiring entry.
   */
  untilEpoch?: number;
  /** Human-readable label explaining the mute decision. */
  reason?: string;
}

/**
 * Emit a mute-CSV section from a list of per-pattern mute directives.
 *
 * Returns CSV text with header `fieldSet,value` and one row per pattern.
 * Rows are sorted by pattern_hash for deterministic diffs.
 *
 * Value grammar: `<sample_rate>:<untilEpoch>:<reason>`
 *   When `untilEpoch` is absent: `<sample_rate>::<reason>` (double colon).
 *   When both absent: `<sample_rate>`.
 *
 * sample_rate is emitted as a decimal fraction with up to 6 significant
 * digits (e.g. `0`, `0.1`, `0.05`). Leading zeros are preserved.
 */
export function emitMuteRows(rows: MuteCsvRow[]): string {
  const out: string[] = ['fieldSet,value'];
  const sorted = [...rows].sort((a, b) => a.pattern_hash.localeCompare(b.pattern_hash));
  for (const r of sorted) {
    const ratePart = formatSampleRate(r.sample_rate);
    let value: string;
    if (r.untilEpoch !== undefined && r.reason) {
      value = `${ratePart}:${r.untilEpoch}:${r.reason.replace(/,/g, ';')}`;
    } else if (r.untilEpoch !== undefined) {
      value = `${ratePart}:${r.untilEpoch}:`;
    } else if (r.reason) {
      value = `${ratePart}::${r.reason.replace(/,/g, ';')}`;
    } else {
      value = ratePart;
    }
    out.push(`${r.pattern_hash},${value}`);
  }
  return out.join('\n') + '\n';
}

/**
 * Format a sample_rate fraction for CSV emission.
 * - 0 → '0'
 * - 1 → '1'
 * - 0.1 → '0.1'
 * - 0.333333... → '0.333333'
 * Clamps to [0, 1].
 */
function formatSampleRate(rate: number): string {
  const clamped = Math.max(0, Math.min(1, rate));
  if (clamped === 0) return '0';
  if (clamped === 1) return '1';
  // Up to 6 significant digits, strip trailing zeros.
  return parseFloat(clamped.toPrecision(6)).toString();
}
