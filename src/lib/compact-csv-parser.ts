/**
 * Compact-CSV parser — reads the per-pattern boolean compact control file
 * that `compactReceiver` JS writes and `commitment_report` reads back to
 * attribute compacted bytes.
 *
 * Counterpart to `compact-csv-writer.ts`. The rate cap CSV uses a different
 * format (numeric bytes::reason:action, container-keyed) and is parsed by
 * `cap-csv-parser.ts`. This parser is for the compact CSV only.
 *
 * Row format: `<pattern_hash>,<true|false>:<untilEpoch>:<reason>`
 * Header: `fieldSet,value`
 *
 * Tolerances:
 *   - Blank lines and CRLF endings are skipped.
 *   - `#` comment lines are skipped.
 *   - Header line (`fieldSet,value`) is skipped.
 *   - Value may be just `true`|`false` (no epoch, no reason).
 *   - Value may be `true::<reason>` (no epoch, reason present).
 *   - Unrecognised boolean token → row pushed to malformed_lines.
 */

export interface CompactCsvRow {
  /** Stable pattern identity (tenx_hash or symbolMessage, depending on receiver config). */
  pattern_hash: string;
  /** true = encode; false = pass through. */
  encode: boolean;
  /**
   * Unix epoch seconds at which this row expires. `undefined` when the
   * row carries no epoch token (non-expiring entry).
   */
  untilEpoch?: number;
  /** Human-readable reason label, or empty string when absent. */
  reason: string;
}

export interface ParseCompactCsvResult {
  rows: CompactCsvRow[];
  /** pattern_hash → CompactCsvRow for fast lookup. */
  by_pattern: Map<string, CompactCsvRow>;
  /** Lines that could not be parsed (preserved verbatim for caveat surfacing). */
  malformed_lines: string[];
}

/**
 * Parse a compact-CSV string into rows + a pattern_hash lookup map.
 *
 * Returns an empty result when `content` is undefined/empty/whitespace.
 * Does not mutate the caller's string.
 */
export function parseCompactCsv(content?: string | null): ParseCompactCsvResult {
  const result: ParseCompactCsvResult = {
    rows: [],
    by_pattern: new Map(),
    malformed_lines: [],
  };
  if (!content || !content.trim()) return result;

  const lines = content.split(/\r?\n/);
  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (!headerSeen && /^fieldSet\s*,\s*value\s*$/i.test(line)) {
      headerSeen = true;
      continue;
    }
    // Also skip legacy header variants (`container,value`) to be
    // forward-compatible with any partial migration state.
    if (!headerSeen && /^container\s*,\s*value\s*$/i.test(line)) {
      headerSeen = true;
      continue;
    }

    const commaIdx = line.indexOf(',');
    if (commaIdx <= 0) {
      result.malformed_lines.push(raw);
      continue;
    }
    const key = line.substring(0, commaIdx).trim();
    const value = line.substring(commaIdx + 1).trim();
    if (!key || !value) {
      result.malformed_lines.push(raw);
      continue;
    }

    const parsed = parseCompactValue(value);
    if (parsed === null) {
      result.malformed_lines.push(raw);
      continue;
    }

    const row: CompactCsvRow = {
      pattern_hash: key,
      encode: parsed.encode,
      untilEpoch: parsed.untilEpoch,
      reason: parsed.reason,
    };
    result.rows.push(row);
    result.by_pattern.set(key, row);
  }
  return result;
}

interface ParsedCompactValue {
  encode: boolean;
  untilEpoch?: number;
  reason: string;
}

/**
 * Parse the value column of a compact-CSV row.
 *
 * Grammar: `<true|false>[:<untilEpoch>[:<reason>]]`
 *   - First token (before first `:`) must be `true` or `false`.
 *   - Second token is the epoch (may be empty → no expiry).
 *   - Remainder is the reason (may contain colons; we split on the FIRST
 *     two colons only, treating the rest as the reason body).
 *
 * Returns null when the boolean token is unrecognised.
 */
function parseCompactValue(value: string): ParsedCompactValue | null {
  const colonIdx = value.indexOf(':');
  if (colonIdx < 0) {
    // Value is just `true` or `false`.
    if (value === 'true') return { encode: true, reason: '' };
    if (value === 'false') return { encode: false, reason: '' };
    return null;
  }

  const boolToken = value.substring(0, colonIdx).trim();
  if (boolToken !== 'true' && boolToken !== 'false') return null;
  const encode = boolToken === 'true';

  const rest = value.substring(colonIdx + 1);
  // rest = `<untilEpoch>:<reason>` OR `:<reason>` (double-colon form)
  // OR just `<untilEpoch>` with no reason.
  const secondColon = rest.indexOf(':');
  if (secondColon < 0) {
    // rest is either an epoch or an empty string.
    const n = Number(rest);
    const untilEpoch = rest.length > 0 && Number.isFinite(n) && n > 0 ? n : undefined;
    return { encode, untilEpoch, reason: '' };
  }

  const epochToken = rest.substring(0, secondColon).trim();
  const reasonToken = rest.substring(secondColon + 1).trim();
  const epochN = Number(epochToken);
  const untilEpoch = epochToken.length > 0 && Number.isFinite(epochN) && epochN > 0 ? epochN : undefined;
  return { encode, untilEpoch, reason: reasonToken };
}
