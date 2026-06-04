/**
 * Shared fetch helpers for MCP-managed gitops files.
 *
 * fetchCapCsvForEnv — pulls the rate cap CSV (engine safety floor):
 *   `pipelines/run/receive/rate/caps.csv`
 *   Used by commitment_report verify, services, and overflow_contents to
 *   supply per-container byte caps for context. The cap CSV no longer
 *   carries `:action` suffixes — action intent is in action-intent.json.
 *
 * fetchActionIntentForEnv — pulls the canonical per-pattern action plan:
 *   `data/action-intent.json`
 *   Used by services, overflow_contents, and estimate-savings to resolve
 *   pattern→action attribution. Takes precedence over any legacy action
 *   suffix that may still be in the cap CSV rows.
 *
 * Both helpers are best-effort: return undefined on any failure (no `gh`
 * available, no gitops repo configured, file not found, decode error).
 * Callers MUST treat undefined as "no data available — fall back to the
 * unattributed path" rather than throwing.
 *
 * Neither helper caches — the freshness of the action attribution matters
 * more than round-trip latency, and gh requests are sub-second on any
 * reasonable gitops repo.
 */

// ── Structured cap_csv_status ────────────────────────────────────────────

/**
 * Structured status for the cap-CSV / action-intent fetch.
 *
 * `kind` values:
 *   not_configured        — no gitops repo set for this env; fetch not attempted.
 *   loaded                — at least one of cap-CSV rows or action-intent entries
 *                           is populated. Action split is trustworthy.
 *   configured_not_loaded — gitops repo is configured but the fetch produced no
 *                           usable data (empty CSV + empty action-intent).
 *   lookup_failed         — gitops repo is configured, fetch was attempted, but
 *                           every attempt threw or returned empty content (gh not
 *                           installed, repo 404, file not found, decode/parse error).
 *
 * `reason` is a plain-English one-liner for human/agent consumption.
 * `source` is where the data would come from (gitops repo path, or absent).
 *
 * Back-compat: callers that still read a flat string can branch on `.kind`.
 * The legacy `applied` / `unavailable` / `not_attempted` strings map as:
 *   applied       → kind: 'loaded'
 *   unavailable   → kind: 'lookup_failed' or 'configured_not_loaded'
 *   not_attempted → kind: 'not_configured'
 */
export interface CapCsvStatus {
  kind: 'not_configured' | 'configured_not_loaded' | 'loaded' | 'lookup_failed';
  reason: string;
  source: string | null;
}

/**
 * Build a CapCsvStatus from the fetch results. Extracted so both
 * overflow_contents and services build the same structured value
 * instead of copy-pasting the ternary.
 *
 * @param repo         — env.gitops?.repo (null/undefined if not configured)
 * @param fetchAttempted — true when at least one gh call was made
 * @param fetchSucceeded — true when at least one call returned non-empty content
 * @param hasActionSource — true when actionIntentLookup.size > 0 OR parsedCsv.rows.length > 0
 */
export function buildCapCsvStatus(
  repo: string | null | undefined,
  fetchAttempted: boolean,
  fetchSucceeded: boolean,
  hasActionSource: boolean,
): CapCsvStatus {
  const source = repo
    ? `${repo} (caps.csv + action-intent.json)`
    : null;

  if (!repo) {
    return {
      kind: 'not_configured',
      reason: 'No gitops repo is configured for this environment. Set gitops.repo in envs.json to enable action-split attribution.',
      source: null,
    };
  }
  if (!fetchAttempted || !fetchSucceeded) {
    return {
      kind: 'lookup_failed',
      reason: `Gitops repo is configured (${repo}) but the fetch failed. Possible causes: gh CLI not installed, repo not found, file missing, or base64 decode error.`,
      source,
    };
  }
  if (!hasActionSource) {
    return {
      kind: 'configured_not_loaded',
      reason: `Gitops repo is configured (${repo}) and was reachable, but no action rows were found (empty CSV and empty action-intent.json).`,
      source,
    };
  }
  return {
    kind: 'loaded',
    reason: `Action-split loaded from ${repo}.`,
    source,
  };
}

import type { EnvConfig } from './environments.js';
import { parseActionIntent, type ActionIntentParseResult } from './action-intent-parser.js';

/** Fetch the rate cap CSV string from the gitops repo. */
export async function fetchCapCsvForEnv(
  env: EnvConfig,
): Promise<string | undefined> {
  const repo = env.gitops?.repo;
  if (!repo) return undefined;
  const lookupPath =
    env.gitops?.lookupPath ?? 'pipelines/run/receive/rate/caps.csv';
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const { stdout } = await exec(
      'gh',
      [
        'api',
        `/repos/${repo}/contents/${lookupPath}`,
        '--jq',
        '.content',
      ],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!stdout) return undefined;
    // GitHub returns base64; decode in-line. Newlines in the b64 string
    // are stripped by Buffer.from.
    const decoded = Buffer.from(stdout.trim(), 'base64').toString('utf8');
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch and parse the action-intent.json from the gitops repo.
 *
 * Returns undefined on any failure. On success, returns the full
 * ActionIntentParseResult so callers can use `by_pattern` directly
 * (the canonical pattern→action Map).
 *
 * Default path: `data/action-intent.json`
 */
export async function fetchActionIntentForEnv(
  env: EnvConfig,
  path = 'data/action-intent.json'
): Promise<ActionIntentParseResult | undefined> {
  const repo = env.gitops?.repo;
  if (!repo) return undefined;
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

// ── Tagged fetch results (for structured cap_csv_status) ────────────────

/** Result of a tagged cap-CSV fetch attempt. */
export interface TaggedFetchResult {
  csvContent: string | undefined;
  actionIntent: ActionIntentParseResult | undefined;
  /** True when a network call was made to the gitops repo (repo was configured). */
  attempted: boolean;
  /** True when at least one of csvContent / actionIntent came back non-empty. */
  succeeded: boolean;
}

/**
 * Fetch both cap-CSV and action-intent in parallel and return a tagged
 * result that lets the caller distinguish "not configured", "fetch failed",
 * "empty", and "loaded" without re-running the ternary logic.
 *
 * Replaces the copy-pasted parallel Promise.all + status ternary in
 * overflow_contents and services.
 */
export async function fetchCapCsvTagged(env: EnvConfig): Promise<TaggedFetchResult> {
  const repo = env.gitops?.repo;
  if (!repo) {
    return { csvContent: undefined, actionIntent: undefined, attempted: false, succeeded: false };
  }
  const [csvContent, actionIntent] = await Promise.all([
    fetchCapCsvForEnv(env).catch(() => undefined),
    fetchActionIntentForEnv(env).catch(() => undefined),
  ]);
  const succeeded = csvContent !== undefined || actionIntent !== undefined;
  return { csvContent, actionIntent, attempted: true, succeeded };
}
