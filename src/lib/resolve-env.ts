/**
 * Edge/cloud environment resolution.
 *
 * Prefers edge reporter metrics when available, falls back to cloud.
 */

import type { EnvConfig } from './environments.js';
import { queryInstant } from './api.js';
import * as pql from './promql.js';

/** Resolve whether to use edge or cloud metrics (global). */
export async function resolveMetricsEnv(env: EnvConfig, timeoutMs?: number): Promise<'edge' | 'cloud'> {
  try {
    const res = await queryInstant(env, pql.edgeProbe(), timeoutMs);
    if (res.status === 'success' && res.data.result.length > 0) {
      return 'edge';
    }
  } catch {
    // fall through to cloud
  }
  return 'cloud';
}

/** Resolve whether to use edge or cloud metrics for specific filters. */
export async function resolveMetricsEnvFiltered(
  env: EnvConfig,
  filters: Record<string, string>
): Promise<'edge' | 'cloud'> {
  try {
    const res = await queryInstant(env, pql.edgeProbeFiltered(filters));
    if (res.status === 'success' && res.data.result.length > 0) {
      return 'edge';
    }
  } catch {
    // fall through to cloud
  }
  return 'cloud';
}
