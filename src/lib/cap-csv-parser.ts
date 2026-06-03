/**
 * Rate cap-CSV parser — pulls per-pattern action attribution out of the
 * `<container>,<bytes>::<reason>:<action>` rows that
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
 *   container,cap                                  ← header
 *   payment-service,2048::MCP default:compact      ← container default
 *   pat:abc123def,4096::keep audit floor:pass      ← per-pattern override
 *   pat:def456abc,128::tier_down dataset:tier_down
 *
 * Value grammar: `<bytes>::<reason>:<action>`
 *   - bytes  — integer cap_bytes_per_window (>=0)
 *   - reason — free-text label (commas already replaced with `;` upstream)
 *   - action — one of pass | sample | compact | tier_down | offload | drop
 *
 * Two row shapes:
 *   - `pat:<hash>` rows — per-pattern overrides; the `key` field of
 *     CapCsvRow is the bare `<hash>` (the `pat:` prefix is stripped).
 *   - `<container>` rows — container-level defaults; the `key` field is
 *     the container name and `isContainerDefault=true`.
 *
 * Used by `runEstimateVerify` to attribute `isDropped="true"` bytes to
 * one of the four engine actions WITHOUT requiring the engine to emit a
 * second label. See cost-cutting-product-shape.md "Engine architecture
 * corrections" §6: action attribution is MCP-side via cap-CSV join.
 */

import type { Action } from './cost.js';

const VALID_ACTIONS: ReadonlySet<Action> = new Set<Action>([
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
   * The action the engine takes when this row's cap engages. Falls back
   * to `'drop'` when the suffix is missing or unrecognized — matches the
   * legacy interpretation of an unsuffixed cap (the rate receiver dropped
   * over-cap bytes before the action grammar shipped).
   */
  action: Action;
  /** True when the action suffix was missing or unparseable. */
  action_suffix_missing: boolean;
}

export interface ParseCapCsvResult {
  rows: CapCsvRow[];
  /**
   * Pattern-hash → action lookup, populated only for `pat:<hash>` rows.
   * Container-default rows are NOT inserted here — callers that want a
   * per-pattern → action mapping with container fallback should use
   * `buildPatternActionLookup` which threads the container default in
   * via a separate (pattern_hash, container) → action map.
   */
  by_pattern: Map<string, CapCsvRow>;
  /**
   * Container → action lookup for the container-default rows. The
   * `runEstimateVerify` join uses this as the fallback action when a
   * dropped pattern_hash has no `pat:<hash>` override.
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
      action: parsed.action,
      action_suffix_missing: parsed.action_suffix_missing,
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
  action: Action;
  action_suffix_missing: boolean;
}

/**
 * Parse the value column of a cap-CSV row.
 *   `<bytes>::<reason>:<action>`
 *
 * Returns null when `bytes` does not parse — that signals a malformed
 * row to the caller. Action suffix is optional; when absent we mark
 * `action_suffix_missing=true` and default the action to 'drop' (the
 * legacy interpretation of an unsuffixed cap).
 */
function parseCapValue(value: string): ParsedValue | null {
  const sepIdx = value.indexOf('::');
  if (sepIdx < 0) {
    // Treat the whole value as bytes.
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return {
      bytes_cap: Math.max(0, Math.round(n)),
      reason: '',
      action: 'drop',
      action_suffix_missing: true,
    };
  }
  const bytesStr = value.substring(0, sepIdx);
  const rest = value.substring(sepIdx + 2);
  const bytesNum = Number(bytesStr);
  if (!Number.isFinite(bytesNum) || bytesNum < 0) return null;
  const bytes_cap = Math.max(0, Math.round(bytesNum));

  // Action is whatever follows the LAST colon in `rest`, IF it parses as a
  // known Action. configure-engine writes `<reason>:<action>` and replaces
  // any inner commas with `;`, so reasons with embedded colons would still
  // round-trip correctly here.
  const lastColon = rest.lastIndexOf(':');
  if (lastColon < 0) {
    return {
      bytes_cap,
      reason: rest,
      action: 'drop',
      action_suffix_missing: true,
    };
  }
  const candidate = rest.substring(lastColon + 1).trim();
  if (VALID_ACTIONS.has(candidate as Action)) {
    return {
      bytes_cap,
      reason: rest.substring(0, lastColon),
      action: candidate as Action,
      action_suffix_missing: false,
    };
  }
  return {
    bytes_cap,
    reason: rest,
    action: 'drop',
    action_suffix_missing: true,
  };
}

/**
 * Build a pattern_hash → Action lookup with container-default fallback.
 *
 * Resolution order, per cost-cutting-product-shape.md §6:
 *   1. `pat:<hash>` row in the CSV → that row's action
 *   2. The pattern's container (passed in by the caller) → container default
 *   3. `'drop'` — legacy fallback for caps without an action suffix
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
    if (patRow) {
      out.set(hash, patRow.action);
      continue;
    }
    const containerRow = parsed.by_container.get(container);
    if (containerRow) {
      out.set(hash, containerRow.action);
      continue;
    }
    // No CSV row at all — leave the hash out of the map; callers treat
    // the absence as "unattributed" rather than defaulting to drop.
  }
  return out;
}

/**
 * Action bucket totals — the canonical shape consumed by VerifyResult's
 * `per_action_breakdown`. The `unattributed` field holds bytes for
 * pattern_hashes that had isDropped="true" volume but no matching
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
