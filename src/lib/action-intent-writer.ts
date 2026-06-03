/**
 * Action-intent writer — serialises the MCP's per-pattern action plan to
 * `data/action-intent.json` in the customer gitops repo.
 *
 * The cap CSV is now the engine-only safety-floor file (format:
 * `container,bytes:untilEpoch:reason` — no `:action` suffix). The
 * INTENT of what the engine should do with each pattern lives HERE,
 * separate from the numeric floor that the rate receiver enforces.
 *
 * File shape:
 *   {
 *     "schema_version": "1.0",
 *     "updated_at_iso": "<ISO-8601>",
 *     "entries": [
 *       {
 *         "pattern_hash": "abc123",
 *         "service": "frontend",
 *         "action": "drop",
 *         "reason": "high-volume noise; no audit value",
 *         "set_at_iso": "<ISO-8601>",
 *         "until_epoch_sec": 0
 *       },
 *       ...
 *     ]
 *   }
 *
 * Deterministic field ordering in the serialised JSON keeps git diffs
 * readable. Entries are sorted by (service ASC, pattern_hash ASC) so
 * a refresh PR that adds a single pattern inserts exactly one line.
 *
 * `until_epoch_sec = 0` means "no expiry" (permanent until the next
 * configure_engine run replaces the file). Non-zero values are an ISO
 * epoch in seconds.
 */

import type { Action } from './cost.js';

// ─── types ───────────────────────────────────────────────────────────

export interface ActionIntentEntry {
  /** Stable pattern identity (tenx_hash / symbolMessage hash). */
  pattern_hash: string;
  /**
   * Service name (k8s_service / k8s_container label from TSDB).
   * Used as the primary sort key and for human readability. May be
   * empty string when the engine label is absent.
   */
  service: string;
  /** The intended engine action for this pattern. */
  action: Action;
  /** Human-readable explanation of why this action was chosen. */
  reason: string;
  /** ISO-8601 timestamp when this entry was written by the MCP. */
  set_at_iso: string;
  /**
   * Unix epoch seconds after which the engine should revert to the
   * container-default behaviour. `0` means no expiry.
   */
  until_epoch_sec: number;
}

export interface ActionIntentFile {
  schema_version: '1.0';
  updated_at_iso: string;
  entries: ActionIntentEntry[];
}

// ─── writer ──────────────────────────────────────────────────────────

/**
 * Serialise action-intent entries to a JSON string suitable for writing
 * to `data/action-intent.json`.
 *
 * Guarantees:
 *   - Entries sorted by (service ASC, pattern_hash ASC) for stable diffs.
 *   - Each entry serialised with fields in canonical order so line-level
 *     git diffs are predictable.
 *   - Two-space indentation for readability.
 *   - `updated_at_iso` defaults to current UTC time when not supplied.
 */
export function writeActionIntent(
  entries: ActionIntentEntry[],
  opts?: { updated_at_iso?: string }
): string {
  const updatedAt = opts?.updated_at_iso ?? new Date().toISOString();
  const sorted = [...entries].sort((a, b) => {
    const svcCmp = a.service.localeCompare(b.service);
    if (svcCmp !== 0) return svcCmp;
    return a.pattern_hash.localeCompare(b.pattern_hash);
  });

  const file: ActionIntentFile = {
    schema_version: '1.0',
    updated_at_iso: updatedAt,
    entries: sorted,
  };

  // Canonical serialisation: emit each entry field in a fixed order so
  // a rename of a `reason` field produces a one-line diff rather than a
  // full object re-render (JSON.stringify respects insertion order in V8).
  const serialisedEntries = sorted.map((e) =>
    JSON.stringify(
      {
        pattern_hash: e.pattern_hash,
        service: e.service,
        action: e.action,
        reason: e.reason,
        set_at_iso: e.set_at_iso,
        until_epoch_sec: e.until_epoch_sec,
      },
      null,
      0
    )
  );

  // Build the JSON manually so entries are one-per-line (compact) inside
  // the outer 2-space-indented structure. This keeps diffs minimal: adding
  // a single pattern appends exactly one line between the last entry and `]`.
  const headerLines = [
    '{',
    `  "schema_version": "1.0",`,
    `  "updated_at_iso": ${JSON.stringify(updatedAt)},`,
    `  "entries": [`,
  ];
  const entryLines: string[] = serialisedEntries.map((s, i) => {
    const comma = i < serialisedEntries.length - 1 ? ',' : '';
    return `    ${s}${comma}`;
  });
  const footerLines = ['  ]', '}'];

  return [...headerLines, ...entryLines, ...footerLines].join('\n') + '\n';
}

// ─── helper: build entries from a pattern→action map ─────────────────

/**
 * Convenience builder. Converts a flat map of
 * `pattern_hash → { action, service?, reason?, untilEpoch? }` to a
 * list of `ActionIntentEntry` objects ready for `writeActionIntent`.
 *
 * `set_at_iso` is stamped with the current UTC time unless overridden
 * via the `set_at_iso` field in the per-pattern override object.
 */
export function buildActionIntentEntries(
  patterns: Array<{
    pattern_hash: string;
    action: Action;
    service?: string;
    reason?: string;
    until_epoch_sec?: number;
    set_at_iso?: string;
  }>,
  defaults?: { set_at_iso?: string }
): ActionIntentEntry[] {
  const now = defaults?.set_at_iso ?? new Date().toISOString();
  return patterns.map((p) => ({
    pattern_hash: p.pattern_hash,
    service: p.service ?? '',
    action: p.action,
    reason: p.reason ?? '',
    set_at_iso: p.set_at_iso ?? now,
    until_epoch_sec: p.until_epoch_sec ?? 0,
  }));
}
