/**
 * interactive-query — per-call deadline wrappers for user-facing tools.
 *
 * The MCP's tools were written for a fast local dev TSDB and inherited a fetch
 * layer tuned for batch reliability (30s timeout). Against a real, possibly
 * slow/remote customer backend a single slow query stalls the whole tool. The
 * GA bar: an interactive tool must never stall the agent on a wedged backend —
 * it returns what resolved in time and marks the rest unavailable.
 *
 * Two layers of defense, because they cover different backends:
 *   1. The threaded `timeoutMs` reaches `backend-fetch` and aborts the in-flight
 *      request via AbortController (frees the connection) — for the prom-shaped
 *      backends (log10x, prometheus/mimir/cortex, grafana_cloud_prom, demo).
 *   2. A client-side race (`withTimeout`) bounds the wait even for backends that
 *      bypass `backend-fetch` (Datadog, GCP, Elastic/OpenSearch, CloudWatch).
 * The client race deadline is slightly longer than the threaded one so the
 * cleaner backend-level abort fires first whenever it can.
 *
 * On timeout or any error the wrappers resolve to `null`; callers map `null` to
 * their existing no_signal / no_data / partial-result path.
 *
 * Budgets are Tal's GA decision (split, not uniform):
 *   - cheap: env probes, count(), hash→name, light instant reads (~3-4s)
 *   - heavy: increase[7d]/[30d] magnitude legs that surface EXACT bytes/$ to the
 *            user (~15-20s) — these legitimately need longer on a cold backend,
 *            and the alternative is dropping the headline number.
 * Override via env for ops tuning.
 */

import type { EnvConfig } from './environments.js';
import { queryInstant, queryRange, type PrometheusResponse } from './api.js';
import { withTimeout } from './concurrency.js';

const CHEAP_MS = parseInt(process.env.LOG10X_INTERACTIVE_TIMEOUT_MS || '4000', 10) || 4000;
const HEAVY_MS = parseInt(process.env.LOG10X_INTERACTIVE_HEAVY_TIMEOUT_MS || '18000', 10) || 18000;

/** Interactive per-call query budgets. Pick the tier by query cost. */
export const QUERY_BUDGET = { cheap: CHEAP_MS, heavy: HEAVY_MS } as const;

/** Grace added to the client-side race so the backend-level abort wins the tie. */
const GRACE_MS = 500;

/**
 * Bounded instant query. Resolves to the response, or `null` if it does not
 * complete within `timeoutMs` (or errors). Pick `timeoutMs` from QUERY_BUDGET.
 */
export function iQueryInstant(
  env: EnvConfig,
  promql: string,
  timeoutMs: number
): Promise<PrometheusResponse | null> {
  return withTimeout(queryInstant(env, promql, timeoutMs).catch(() => null), timeoutMs + GRACE_MS);
}

/**
 * Bounded range query. Resolves to the response, or `null` on timeout/error.
 */
export function iQueryRange(
  env: EnvConfig,
  promql: string,
  startSec: number,
  endSec: number,
  stepSec: number,
  timeoutMs: number
): Promise<PrometheusResponse | null> {
  return withTimeout(
    queryRange(env, promql, startSec, endSec, stepSec, timeoutMs).catch(() => null),
    timeoutMs + GRACE_MS
  );
}
