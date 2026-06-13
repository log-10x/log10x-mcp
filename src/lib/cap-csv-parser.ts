/**
 * Rate cap-CSV parser — reads the engine-only safety-floor file that
 * `log10x_configure_engine` writes to the customer gitops repo.
 *
 * THIS PARSER IS FOR THE RATE CAP CSV ONLY:
 *   File: `pipelines/run/receive/rate/caps.csv`
 *   Header: `container,cap`
 *   Format: numeric bytes-per-window, container-keyed (with optional
 *           `pat:<hash>` per-pattern overrides)
 *
 * For the compact CSV (`pipelines/run/receive/compact/compact-cap.csv`),
 * which uses a boolean per-pattern format, use `compact-csv-parser.ts`.
 *
 * Row format (set by configure-engine.ts):
 *   container,cap                              ← header
 *   payment-service,2048::MCP default          ← container default
 *   pat:abc123def,4096::keep audit floor       ← per-pattern override
 *   pat:def456abc,128::tier_down dataset
 *
 * Value grammar: `<bytes>::<reason>`
 *   - bytes  — integer cap_bytes_per_window (>=0)
 *   - reason — free-text label (commas already replaced with `;` upstream)
 *
 * NOTE: The `:action` suffix that earlier versions of configure_engine
 * appended to this file has been REMOVED. Action intent is now stored
 * separately in `data/action-intent.json` (see action-intent-writer.ts
 * and action-intent-parser.ts). Callers that need a pattern→action
 * lookup must read action-intent.json, not this file. Legacy rows that
 * still carry a `:action` suffix are parsed tolerantly — the suffix is
 * ignored and `legacy_action_suffix` is set on the row for diagnostics.
 *
 * Two row shapes:
 *   - `pat:<hash>` rows — per-pattern overrides; the `key` field of
 *     CapCsvRow is the bare `<hash>` (the `pat:` prefix is stripped).
 *   - `<container>` rows — container-level defaults; the `key` field is
 *     the container name and `isContainerDefault=true`.
 */

import type { Action } from './cost.js';

// Legacy action values recognised when stripping an old-format suffix.
// Used only to detect and discard the suffix — NOT for action routing.
const LEGACY_ACTIONS: ReadonlySet<string> = new Set<string>([
  'pass',
  'sample',
  'compact',
  'tier_down',
  'offload',
  'drop',
]);

export interface CapCsvRow {
  /**
   * For `pat:<hash>` rows this is the bare pattern_hash (`pat:` prefix
   * stripped). For container rows this is the container name.
   */
  key: string;
  /** True when the row's CSV key did NOT start with `pat:`. */
  isContainerDefault: boolean;
  /** Parsed cap in bytes per 4-minute reset window. NaN-safe (clamped to 0). */
  bytes_cap: number;
  /** Free-text reason label (commas already substituted to `;` upstream). */
  reason: string;
  /**
   * When a legacy `:action` suffix was present on this row (written by an
   * older version of configure_engine), the stripped suffix value is
   * preserved here for diagnostics. NOT used for action routing — see
   * `data/action-intent.json` for the canonical action plan.
   *
   * @deprecated Action routing has moved to action-intent.json.
   */
  legacy_action_suffix?: Action;
}

export interface ParseCapCsvResult {
  rows: CapCsvRow[];
  /**
   * Pattern-hash → CapCsvRow lookup, populated only for `pat:<hash>` rows.
   * Container-default rows are NOT inserted here — callers that want a
   * per-pattern → bytes_cap mapping with container fallback should use
   * `by_container` together with the pattern's container label.
   *
   * NOTE: This lookup no longer provides action attribution. For
   * pattern → action, read `data/action-intent.json` via
   * `fetchAndParseActionIntent` in `action-intent-parser.ts`.
   */
  by_pattern: Map<string, CapCsvRow>;
  /**
   * Container → CapCsvRow lookup for the container-default rows. Used
   * to resolve per-container byte caps when a pattern has no explicit
   * `pat:<hash>` override row.
   */
  by_container: Map<string, CapCsvRow>;
  /**
   * Lines that could not be parsed (preserved verbatim for caveat
   * surfacing). Empty when the CSV is well-formed.
   */
  malformed_lines: string[];
}

/**
 * Parse a cap-CSV string into rows + lookups.
 *
 * Tolerates:
 *  - missing/extra header lines (we only require the `<key>,<value>` shape)
 *  - missing `::` separator (treats whole value as bytes, action='drop',
 *    suffix_missing=true) — surfaced to callers via the per-row flag
 *  - blank lines and CRLF endings
 *
 * Does NOT mutate caller-owned strings. Returns an empty result when
 * `content` is undefined/empty/whitespace.
 */
export function parseCapCsv(content?: string | null): ParseCapCsvResult {
  const result: ParseCapCsvResult = {
    rows: [],
    by_pattern: new Map(),
    by_container: new Map(),
    malformed_lines: [],
  };
  if (!content || !content.trim()) return result;

  const lines = content.split(/\r?\n/);
  // `# ...` comment lines ahead of the first data row carry refresh-mode
  // commitment metadata (target_percent, baseline_monthly_bytes) written
  // by configure_engine. They must not be treated as malformed rows. The
  // header (`container,cap`) is also skipped — we look for it as the
  // first non-blank non-comment line rather than at a fixed index, since
  // preamble lines push it down.
  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (!headerSeen && /^container\s*,\s*cap\s*$/i.test(line)) {
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

    const parsed = parseCapValue(value);
    if (parsed === null) {
      result.malformed_lines.push(raw);
      continue;
    }

    const isPattern = key.startsWith('pat:');
    const bareKey = isPattern ? key.substring(4) : key;
    if (!bareKey) {
      result.malformed_lines.push(raw);
      continue;
    }

    const row: CapCsvRow = {
      key: bareKey,
      isContainerDefault: !isPattern,
      bytes_cap: parsed.bytes_cap,
      reason: parsed.reason,
      ...(parsed.legacy_action_suffix !== undefined
        ? { legacy_action_suffix: parsed.legacy_action_suffix }
        : {}),
    };
    result.rows.push(row);
    if (isPattern) {
      result.by_pattern.set(bareKey, row);
    } else {
      result.by_container.set(bareKey, row);
    }
  }
  return result;
}

interface ParsedValue {
  bytes_cap: number;
  reason: string;
  /**
   * When the row was written by a legacy version of configure_engine that
   * appended `:<action>` to the reason field, this holds the stripped
   * action value. Undefined for new-format rows. NOT used for routing —
   * action intent lives in `data/action-intent.json`.
   */
  legacy_action_suffix?: Action;
}

/**
 * Parse the value column of a cap-CSV row.
 *
 * New format: `<bytes>::<reason>`
 * Legacy format (old configure_engine): `<bytes>::<reason>:<action>`
 *
 * Returns null when `bytes` does not parse — that signals a malformed
 * row to the caller.
 *
 * When a legacy `:action` suffix is detected (the last colon-segment is
 * a known Action value), it is stripped from the reason and preserved in
 * `legacy_action_suffix` for diagnostics only.
 */
function parseCapValue(value: string): ParsedValue | null {
  const sepIdx = value.indexOf('::');
  if (sepIdx < 0) {
    // Treat the whole value as bytes (no reason, no action).
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return {
      bytes_cap: Math.max(0, Math.round(n)),
      reason: '',
    };
  }
  const bytesStr = value.substring(0, sepIdx);
  const rest = value.substring(sepIdx + 2);
  const bytesNum = Number(bytesStr);
  if (!Number.isFinite(bytesNum) || bytesNum < 0) return null;
  const bytes_cap = Math.max(0, Math.round(bytesNum));

  // Detect and strip a legacy `:action` suffix. If the last colon-segment
  // of `rest` is a known action token, peel it off and record it in
  // `legacy_action_suffix`. This keeps the reason field clean for new
  // code while remaining backward-compatible with existing CSV files.
  const lastColon = rest.lastIndexOf(':');
  if (lastColon >= 0) {
    const candidate = rest.substring(lastColon + 1).trim();
    if (LEGACY_ACTIONS.has(candidate)) {
      return {
        bytes_cap,
        reason: rest.substring(0, lastColon),
        legacy_action_suffix: candidate as Action,
      };
    }
  }

  return {
    bytes_cap,
    reason: rest,
  };
}

/**
 * Build a pattern_hash → Action lookup with container-default fallback.
 *
 * @deprecated Action attribution has moved to `data/action-intent.json`.
 *   Use `fetchAndParseActionIntent` from `action-intent-parser.ts` to get
 *   the canonical pattern → action map. This function is retained for
 *   backward compatibility with legacy rows that still carry a
 *   `legacy_action_suffix` field, and for callers that have not yet
 *   migrated to the action-intent path.
 *
 * Resolution order (legacy):
 *   1. `pat:<hash>` row in the CSV that has `legacy_action_suffix` → that value
 *   2. The pattern's container default row `legacy_action_suffix` → that value
 *   3. Absent from the map — callers treat absence as "unattributed"
 *
 * The caller knows which container a pattern_hash belongs to via the
 * TSDB query (the engine emits both `tenx_hash` and `k8s_container` as
 * labels on `all_events_summaryBytes_total`).
 */
export function buildPatternActionLookup(
  parsed: ParseCapCsvResult,
  patternToContainer: Map<string, string>
): Map<string, Action> {
  const out = new Map<string, Action>();
  for (const [hash, container] of patternToContainer.entries()) {
    const patRow = parsed.by_pattern.get(hash);
    if (patRow?.legacy_action_suffix) {
      out.set(hash, patRow.legacy_action_suffix);
      continue;
    }
    const containerRow = parsed.by_container.get(container);
    if (containerRow?.legacy_action_suffix) {
      out.set(hash, containerRow.legacy_action_suffix);
      continue;
    }
    // No legacy suffix — leave the hash out of the map; callers treat
    // the absence as "unattributed" rather than defaulting to drop.
  }
  return out;
}

/**
 * Build a pattern_hash → bytes_cap lookup with container-default fallback.
 *
 * This is the primary non-deprecated function for reading cap CSV data.
 * It returns the bytes cap for each pattern, which is the engine safety
 * floor, not the action intent (action intent is in action-intent.json).
 *
 * Resolution order:
 *   1. `pat:<hash>` row → that row's bytes_cap
 *   2. The pattern's container default row → container bytes_cap
 *   3. Absent from the map — pattern has no known cap
 */
export function buildPatternBytesCapLookup(
  parsed: ParseCapCsvResult,
  patternToContainer: Map<string, string>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [hash, container] of patternToContainer.entries()) {
    const patRow = parsed.by_pattern.get(hash);
    if (patRow) {
      out.set(hash, patRow.bytes_cap);
      continue;
    }
    const containerRow = parsed.by_container.get(container);
    if (containerRow) {
      out.set(hash, containerRow.bytes_cap);
      continue;
    }
  }
  return out;
}

/**
 * Action bucket totals — the canonical shape consumed by VerifyResult's
 * `per_action_breakdown`. The `unattributed` field holds bytes for
 * pattern_hashes that had routeState="drop" volume but no matching
 * cap-CSV row (neither `pat:<hash>` nor a container default). Surfaced
 * separately so the parts-≤-whole guard can subtract it before clamping.
 */
export interface ActionBytesBuckets {
  pass: number;
  sample: number;
  compact: number;
  tier_down: number;
  offload: number;
  drop: number;
  unattributed: number;
}

export function emptyActionBuckets(): ActionBytesBuckets {
  return {
    pass: 0,
    sample: 0,
    compact: 0,
    tier_down: 0,
    offload: 0,
    drop: 0,
    unattributed: 0,
  };
}

/**
 * Sum bucket values into a single bytes total. Excludes `unattributed`
 * by default (it's already part of the whole; the breakdown is what the
 * MCP could attribute).
 */
export function totalAttributedBytes(buckets: ActionBytesBuckets): number {
  return (
    buckets.pass +
    buckets.sample +
    buckets.compact +
    buckets.tier_down +
    buckets.offload +
    buckets.drop
  );
}
