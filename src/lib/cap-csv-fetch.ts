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
