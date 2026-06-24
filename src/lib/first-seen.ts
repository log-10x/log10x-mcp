/**
 * Per-pattern `first_seen` discovery.
 *
 * For each of the top-N hashes, scan the engine's metric backwards in
 * time to find the earliest non-zero data point. That's the moment the
 * engine started observing the pattern — a load-bearing signal for the
 * Reader's "is this new or stable?" question.
 *
 * Implementation: a single batched PromQL range query per hash, covering
 * 30 days, at 1-hour step. Returns the earliest timestamp where the
 * metric was non-zero. Costs one round-trip per hash; in parallel.
 *
 * Formatting follows the locked rule:
 *   < 60 min     → "47m ago"
 *   60 min – 48h → "21h ago"
 *   ≥ 48h        → "7d ago"
 */

import type { EnvConfig } from './environments.js';
import { iQueryRange, QUERY_BUDGET } from './interactive-query.js';
import { boundedFanout } from './concurrency.js';
import { LABELS } from './promql.js';

/** Max concurrent first-seen range queries in a batch (caps the N+1 fan-out). */
const FIRST_SEEN_CONCURRENCY = 8;

export interface FirstSeenResult {
  /** Seconds since the earliest non-zero timestamp. `null` if no data found. */
  ageSeconds: number | null;
  /** Unix-seconds timestamp of the first event, if found. */
  firstSeenUnix: number | null;
}

/**
 * Format an age (in seconds) per the locked time-bucket rule.
 * Returns "(unknown)" if `ageSeconds` is null.
 */
export function fmtAge(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return '(unknown)';
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 2 * 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86400)}d ago`;
}

/**
 * Find `first_seen` for one hash. Returns `{ageSeconds: null}` on
 * any failure (network, malformed response, no series) — never throws,
 * so callers can safely await N of these in parallel without one
 * failure poisoning the whole batch.
 */
export async function fetchFirstSeen(
  env: EnvConfig,
  hash: string,
  metric = 'emitted_events_summaryBytes_total',
  lookbackSeconds = 30 * 86400
): Promise<FirstSeenResult> {
  if (!hash) return { ageSeconds: null, firstSeenUnix: null };
  const now = Math.floor(Date.now() / 1000);
  const start = now - lookbackSeconds;
  // hourly buckets — sufficient resolution; 30d × 24 = 720 points.
  const step = 3600;

  try {
    const q = `${metric}{${LABELS.hash}="${hash}"}`;
    const res = await iQueryRange(env, q, start, now, step, QUERY_BUDGET.cheap);
    if (!res || res.status !== 'success' || !Array.isArray(res.data.result)) {
      return { ageSeconds: null, firstSeenUnix: null };
    }
    let earliest: number | null = null;
    for (const series of res.data.result as Array<{ values?: [number, string][] }>) {
      if (!series.values) continue;
      for (const [ts, vStr] of series.values) {
        const v = Number(vStr);
        if (Number.isFinite(v) && v > 0) {
          if (earliest === null || ts < earliest) earliest = ts;
          break; // first non-zero in this series; check next series
        }
      }
    }
    if (earliest === null) return { ageSeconds: null, firstSeenUnix: null };
    return {
      ageSeconds: now - earliest,
      firstSeenUnix: earliest,
    };
  } catch {
    return { ageSeconds: null, firstSeenUnix: null };
  }
}

/**
 * Batched parallel lookup — one Prom query per hash. The returned map
 * is keyed by hash. Missing entries (failures, no data) are simply
 * absent from the map; callers should treat absence as "(unknown)".
 */
export async function fetchFirstSeenBatch(
  env: EnvConfig,
  hashes: string[],
  metric?: string,
  lookbackSeconds?: number
): Promise<Map<string, FirstSeenResult>> {
  const out = new Map<string, FirstSeenResult>();
  if (hashes.length === 0) return out;
  // Bounded-concurrency fan-out with a per-leg deadline and a whole-batch soft
  // deadline: a wide top-N against a slow backend degrades to "(unknown)"
  // first-seen for the un-fetched tail instead of firing N unbounded queries.
  const results = await boundedFanout(
    hashes,
    (h) => fetchFirstSeen(env, h, metric, lookbackSeconds),
    { concurrency: FIRST_SEEN_CONCURRENCY, timeoutMs: QUERY_BUDGET.cheap, softDeadlineMs: QUERY_BUDGET.heavy }
  );
  results.forEach((r, i) => {
    if (r && r.ageSeconds !== null) out.set(hashes[i], r);
  });
  return out;
}
