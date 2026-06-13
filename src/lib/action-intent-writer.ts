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

// ─── actions.csv — per-SERVICE action routing for the engine ─────────

/**
 * Most-aggressive → least-aggressive ordering, used as the tie-break when
 * a service's patterns split evenly across two or more actions. "Aggressive"
 * = how hard the lever cuts cost: `drop` removes the slice entirely, `offload`
 * relocates it off the SIEM, `tier_down` cheapens its tier, `compact` shrinks
 * it, `sample` thins it, `pass` leaves it. On a tie we pick the more
 * cost-aggressive action so a mixed service never silently defaults to the
 * weaker lever.
 */
const ACTION_AGGRESSION_ORDER: readonly Action[] = [
  'drop',
  'offload',
  'tier_down',
  'compact',
  'sample',
  'pass',
];

/** Rank of an action in ACTION_AGGRESSION_ORDER (0 = most aggressive). */
function actionRank(a: Action): number {
  const idx = ACTION_AGGRESSION_ORDER.indexOf(a);
  // Unknown actions sort last (least aggressive) so they never win a tie.
  return idx === -1 ? ACTION_AGGRESSION_ORDER.length : idx;
}

/**
 * Derive the engine's per-service `actions.csv` body from the same
 * per-pattern action-intent entries that feed `action-intent.json`.
 *
 * The engine's receiver reads this file keyed by k8s container (== the
 * service) and stamps `route(<action>)` on that service's regulator-excess
 * slice. ONE row per service. A service absent from the file defaults to
 * `drop` engine-side, so we only emit services we actually have entries for.
 *
 * File shape:
 *   container,action          ← header
 *   frontend,compact
 *   checkout,drop
 *   payment,offload
 *
 * Per-service action rule:
 *   1. Group entries by `service`.
 *   2. Pick the MODE — the most frequent `action` among that service's
 *      patterns.
 *   3. Tie-break by the MOST AGGRESSIVE action in the order
 *      drop > offload > tier_down > compact > sample > pass.
 *
 * Rows are sorted by service ASC for stable git diffs (same convention as
 * writeActionIntent). Entries with an empty `service` are skipped — the
 * engine keys this file by container and an empty key is meaningless (those
 * patterns still carry their action in action-intent.json).
 */
export function deriveActionsCsv(entries: ActionIntentEntry[]): string {
  // service → (action → count)
  const byService = new Map<string, Map<Action, number>>();
  for (const e of entries) {
    if (!e.service) continue; // engine keys by container; empty key is a no-op
    let counts = byService.get(e.service);
    if (!counts) {
      counts = new Map<Action, number>();
      byService.set(e.service, counts);
    }
    counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
  }

  const services = [...byService.keys()].sort((a, b) => a.localeCompare(b));
  const lines = ['container,action'];
  for (const service of services) {
    const counts = byService.get(service)!;
    let best: Action | undefined;
    let bestCount = -1;
    for (const [action, count] of counts.entries()) {
      if (
        count > bestCount ||
        // Tie on frequency → prefer the more aggressive action.
        (count === bestCount &&
          best !== undefined &&
          actionRank(action) < actionRank(best))
      ) {
        best = action;
        bestCount = count;
      }
    }
    if (best !== undefined) lines.push(`${service},${best}`);
  }
  return lines.join('\n') + '\n';
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
