/**
 * Shared cap-CSV fetch helper — pulls the per-pattern action plan that
 * `log10x_configure_engine` last committed to the env's gitops repo.
 *
 * Used by:
 *   - `_setVerifyRunner` (commitment_report weekly aggregate)
 *   - `log10x_services` (per-service action-axis columns)
 *   - `log10x_overflow_contents` (filtering dropped patterns to the
 *     offload subset, not the drop subset)
 *
 * Best-effort: returns `undefined` on any failure (no `gh` available, no
 * gitops repo configured, file not found, decode error). Callers MUST
 * treat undefined as "no CSV available — fall back to the unattributed
 * path" rather than throwing.
 *
 * The CSV is base64-decoded from the GitHub Contents API response. We
 * deliberately do NOT cache here — the freshness of the action attribution
 * matters more than the round-trip latency, and the gh request is sub-second
 * on any reasonable gitops repo.
 */

import type { EnvConfig } from './environments.js';

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
