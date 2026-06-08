/**
 * Action-intent parser — reads `data/action-intent.json` from the customer
 * gitops repo and returns a pattern_hash → Action lookup.
 *
 * Pair with `action-intent-writer.ts` which writes the file.
 *
 * File location (relative to gitops repo root):
 *   `data/action-intent.json`
 *   (sibling to the cap CSV at `pipelines/run/receive/rate/caps.csv`)
 *
 * Parse contract:
 *   - Unknown schema_version → accepted with a soft warning (forward compat).
 *   - Missing or null entries → treated as empty (no actions).
 *   - Unrecognised action value on an entry → that entry is skipped and
 *     pushed to `malformed_entries` for caveat surfacing.
 *   - All other parse failures → surfaced via `malformed_entries`; partial
 *     results are still returned.
 *   - Entries with `until_epoch_sec > 0` and past the current wall time
 *     are treated as expired and excluded from the lookup (same semantics
 *     as the rate receiver's epoch-expiry on mute/compact rows).
 */

import type { Action } from './cost.js';
import type { ActionIntentEntry, ActionIntentFile } from './action-intent-writer.js';

// ─── VALID_ACTIONS (mirrors cap-csv-parser.ts VALID_ACTIONS) ─────────

const VALID_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'pass',
  'sample',
  'compact',
  'tier_down',
  'offload',
  'drop',
]);

// ─── result type ─────────────────────────────────────────────────────

export interface ActionIntentParseResult {
  /**
   * All well-formed, non-expired entries from the file.
   * Entries with `until_epoch_sec > 0` and in the past are excluded.
   */
  entries: ActionIntentEntry[];

  /**
   * pattern_hash → Action lookup, built from `entries`.
   * This is the primary consumer interface — most callers use this
   * rather than iterating `entries` directly.
   */
  by_pattern: Map<string, Action>;

  /**
   * Entries or raw values that could not be parsed or had an
   * unrecognised action. Exposed for caveat surfacing; never throws.
   */
  malformed_entries: string[];

  /**
   * True when the file could not be parsed as JSON at all (structural
   * failure). When true, `entries` and `by_pattern` are both empty.
   */
  json_parse_error: boolean;

  /**
   * `schema_version` from the file header. Undefined when the file was
   * empty or unparseable.
   */
  schema_version?: string;
}

// ─── parser ──────────────────────────────────────────────────────────

/**
 * Parse an action-intent JSON string.
 *
 * Returns an empty result (no throws) on any input failure. Callers must
 * treat an empty `by_pattern` map as "no action plan available — fall back
 * to the cap-CSV container-default path or the single-bucket drop fallback".
 *
 * @param content Raw JSON string from the gitops repo.
 * @param nowEpochSec Wall time for expiry evaluation. Defaults to `Date.now() / 1000`.
 */
export function parseActionIntent(
  content?: string | null,
  nowEpochSec?: number
): ActionIntentParseResult {
  const empty: ActionIntentParseResult = {
    entries: [],
    by_pattern: new Map(),
    malformed_entries: [],
    json_parse_error: false,
  };

  if (!content || !content.trim()) return empty;

  const now = nowEpochSec ?? Date.now() / 1000;
  const malformed: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      ...empty,
      json_parse_error: true,
      malformed_entries: ['<json_parse_error>'],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ...empty,
      json_parse_error: true,
      malformed_entries: ['<not_an_object>'],
    };
  }

  const file = parsed as Partial<ActionIntentFile>;
  const schemaVersion =
    typeof file.schema_version === 'string' ? file.schema_version : undefined;

  if (!Array.isArray(file.entries)) {
    return {
      ...empty,
      schema_version: schemaVersion,
    };
  }

  const goodEntries: ActionIntentEntry[] = [];
  const byPattern = new Map<string, Action>();

  for (const rawEntry of file.entries) {
    const raw: unknown = rawEntry;
    if (typeof raw !== 'object' || raw === null) {
      malformed.push(JSON.stringify(raw));
      continue;
    }
    const e = raw as Record<string, unknown>;

    const pattern_hash = typeof e['pattern_hash'] === 'string' ? e['pattern_hash'] : '';
    const action = e['action'];
    const service = typeof e['service'] === 'string' ? e['service'] : '';
    const reason = typeof e['reason'] === 'string' ? e['reason'] : '';
    const set_at_iso = typeof e['set_at_iso'] === 'string' ? e['set_at_iso'] : '';
    const until_epoch_sec =
      typeof e['until_epoch_sec'] === 'number' ? e['until_epoch_sec'] : 0;

    if (!pattern_hash) {
      malformed.push(JSON.stringify(raw));
      continue;
    }
    if (!VALID_ACTIONS.has(action as Action)) {
      malformed.push(JSON.stringify(raw));
      continue;
    }

    // Expiry check: skip entries that have expired.
    if (until_epoch_sec > 0 && until_epoch_sec < now) {
      // Expired — do not add to lookup, but don't treat as malformed.
      continue;
    }

    const entry: ActionIntentEntry = {
      pattern_hash,
      service,
      action: action as Action,
      reason,
      set_at_iso,
      until_epoch_sec,
    };
    goodEntries.push(entry);
    byPattern.set(pattern_hash, action as Action);
  }

  return {
    entries: goodEntries,
    by_pattern: byPattern,
    malformed_entries: malformed,
    json_parse_error: false,
    schema_version: schemaVersion,
  };
}

/**
 * Fetch and parse the action-intent.json from the gitops repo using `gh api`.
 *
 * Returns undefined on any failure (no `gh`, no repo, file not found, parse
 * error). Callers MUST treat undefined as "no action plan available".
 *
 * @param repo  `owner/repo` string from env.gitops.repo.
 * @param path  Path within the repo (default: `data/action-intent.json`).
 */
export async function fetchAndParseActionIntent(
  repo: string,
  path = 'data/action-intent.json'
): Promise<ActionIntentParseResult | undefined> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const { stdout } = await exec(
      'gh',
      ['api', `/repos/${repo}/contents/${path}`, '--jq', '.content'],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }
    );
    if (!stdout) return undefined;
    const decoded = Buffer.from(stdout.trim(), 'base64').toString('utf8');
    if (!decoded) return undefined;
    const result = parseActionIntent(decoded);
    if (result.json_parse_error) return undefined;
    return result;
  } catch {
    return undefined;
  }
}
