/**
 * L1 outcome multiplexer — single source of truth for routing a per-pattern
 * action decision to the correct MCP-managed file.
 *
 * L1 outcome routing table:
 *
 *   Outcome       Target file                                    Format
 *   --------------------------------------------------------------------------
 *   drop          mute CSV (rateReceiverLookupFile)              fieldSet,value
 *                                                                pattern_hash,0:untilEpoch:reason
 *   sample        mute CSV (rateReceiverLookupFile)              pattern_hash,0.1:untilEpoch:reason
 *   compact       compact CSV (compactReceiverLookupFile)        pattern_hash,true:untilEpoch:reason
 *   tier_down     engine-side stamp — no MCP CSV write           n/a
 *   offload       engine-side stamp — no MCP CSV write           n/a
 *   observe_only  no write                                       n/a
 *   cap           cap CSV (rateReceiverCapLookupFile)            container,bytes:untilEpoch:reason
 *                 (safety floor, per-container only, separate from L1)
 *
 * KEY RULES:
 *   - compact → compact-cap.csv  BOOLEAN (true|false), pattern-keyed.
 *              configure_engine MUST NOT write compact rows as numeric to compact-cap.csv.
 *   - drop/sample → mute CSV     NUMERIC sample_rate (0 or 0.1), pattern-keyed.
 *   - cap → rate-cap CSV         NUMERIC bytes-per-window, container-keyed.
 *              this is the safety floor; it is separate from the L1 mute decision.
 *   - tier_down / offload        engine-side stamps only; MCP has no CSV to write.
 *   - observe_only               no file change.
 *
 * This module is intentionally pure (no I/O). Callers (configure_engine,
 * pattern_mitigate) receive a FileWriteSet and decide how to persist / diff
 * the output against the existing repo files.
 */

import type { Action } from './cost.js';
import { emitCompactRows, type CompactCsvRow } from './compact-csv-writer.js';
import { emitMuteRows, type MuteCsvRow } from './mute-csv-writer.js';

/** Caller-supplied per-pattern action decision, plus enough metadata to emit the row. */
export interface PatternAction {
  pattern_hash: string;
  action: Action;
  /**
   * For sample: fraction to keep (0..1). Defaults to 0.1 (10%) when absent.
   * Ignored for non-sample actions.
   */
  sample_rate?: number;
  /**
   * Unix epoch seconds at which the row expires. When absent the row
   * is written without an expiry (permanent until the next PR replaces it).
   */
  untilEpoch?: number;
  /** Human-readable reason label. Commas are replaced with `;` on write. */
  reason?: string;
}

/**
 * The set of CSV file contents that should be written to the gitops repo.
 * A `null` field means "no write for this file" — leave the existing
 * file in the repo unchanged.
 *
 * File paths (relative to the gitops repo root):
 *   mute_csv    → pipelines/run/receive/rate/caps.csv  (fieldSet,value header)
 *   compact_csv → pipelines/run/receive/compact/compact-cap.csv
 *   cap_csv     → pipelines/run/receive/rate/caps.csv  (container,cap header)
 *                 NOTE: mute and cap live in the same file; the caller is
 *                 responsible for merging the two sections. The multiplexer
 *                 keeps them separate so the merge logic is explicit.
 */
export interface FileWriteSet {
  /** Per-pattern mute/sample rows (drop=0, sample=0.1). Null if no drop/sample patterns. */
  mute_csv: string | null;
  /** Per-pattern compact rows (boolean true). Null if no compact patterns. */
  compact_csv: string | null;
  /**
   * Per-container bytes cap rows (safety floor). Always null from routeOutcome —
   * the cap floor is a separate call from the L1 multiplexer, handled by
   * configure_engine's renderCsvDiff. Retained in the interface so callers
   * can merge all three sections in one pass.
   */
  cap_csv: string | null;
}

/**
 * Route a list of per-pattern L1 outcome decisions to the correct CSV
 * file contents.
 *
 * Pure function — no side effects, no I/O. The caller decides how to
 * persist the returned strings (git PR, in-place write, or diff output).
 *
 * Patterns whose action is `tier_down`, `offload`, `pass`, or absent are
 * silently skipped — these are engine-side stamps; the MCP does not write
 * a CSV row for them.
 *
 * @param patterns  Per-pattern action decisions from the solver or caller.
 * @returns         FileWriteSet with non-null fields only for files that
 *                  have at least one row to write.
 */
export function routeOutcome(patterns: PatternAction[]): FileWriteSet {
  const muteRows: MuteCsvRow[] = [];
  const compactRows: CompactCsvRow[] = [];

  for (const p of patterns) {
    switch (p.action) {
      case 'drop':
        muteRows.push({
          pattern_hash: p.pattern_hash,
          sample_rate: 0,
          untilEpoch: p.untilEpoch,
          reason: p.reason,
        });
        break;

      case 'sample': {
        const rate = p.sample_rate !== undefined ? p.sample_rate : 0.1;
        muteRows.push({
          pattern_hash: p.pattern_hash,
          sample_rate: rate,
          untilEpoch: p.untilEpoch,
          reason: p.reason,
        });
        break;
      }

      case 'compact':
        compactRows.push({
          pattern_hash: p.pattern_hash,
          encode: true,
          untilEpoch: p.untilEpoch,
          reason: p.reason,
        });
        break;

      // tier_down, offload, pass: engine-side stamps; no MCP CSV.
      case 'tier_down':
      case 'offload':
      case 'pass':
      default:
        break;
    }
  }

  return {
    mute_csv: muteRows.length > 0 ? emitMuteRows(muteRows) : null,
    compact_csv: compactRows.length > 0 ? emitCompactRows(compactRows) : null,
    cap_csv: null, // safety floor is a separate caller concern
  };
}
