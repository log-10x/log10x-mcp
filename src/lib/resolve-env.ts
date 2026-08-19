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
  } catch (e) {
    // The 7d probe can be REJECTED (not "no data") by a backend that caps the
    // query range — the public demo gateway returns HTTP 400 for any range >3h.
    // That threw here and silently fell to 'cloud', emptying every downstream
    // query against a live edge deployment. Retry once at 3h (inside the demo
    // cap) before giving up: a real customer's 7d probe never hits this path,
    // and a range-capped backend gets a second, valid chance to answer 'edge'.
    if (/\b400\b|range|limited/i.test(String(e))) {
      try {
        const retry = await queryInstant(env, pql.edgeProbe(undefined, '3h'), timeoutMs);
        if (retry.status === 'success' && retry.data.result.length > 0) {
          return 'edge';
        }
      } catch {
        // retry also failed — fall through to the historic cloud default.
      }
    }
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
