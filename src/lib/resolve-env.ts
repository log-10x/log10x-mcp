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

/**
 * Resolve whether to use edge or cloud metrics for specific filters.
 *
 * `timeoutMs` is accepted for API parity with resolveMetricsEnv but defaults to
 * the shared 30s backend-fetch budget on purpose: this is an edge/cloud
 * CLASSIFICATION probe, and a too-tight deadline that times out on a slow-but-
 * working backend would misclassify edge→cloud and silently empty the caller's
 * results. Correctness over a few seconds for a probe that is milliseconds on a
 * healthy backend.
 */
export async function resolveMetricsEnvFiltered(
  env: EnvConfig,
  filters: Record<string, string>,
  timeoutMs?: number
): Promise<'edge' | 'cloud'> {
  try {
    const res = await queryInstant(env, pql.edgeProbeFiltered(filters), timeoutMs);
    if (res.status === 'success' && res.data.result.length > 0) {
      return 'edge';
    }
  } catch {
    // fall through to cloud
  }
  return 'cloud';
}
