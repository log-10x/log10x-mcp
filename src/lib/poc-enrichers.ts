/**
 * POC-side pattern enrichers.
 *
 * Lift insights from existing engine/templater data into the POC report
 * without changing how the data is sourced. Each enricher takes the
 * already-enriched pattern list (cost + severity + action computed in
 * `poc-report-renderer.ts:enrichPatterns`) and decorates it in-place
 * with additional fields the summary/full views can render.
 *
 * Honest gaps:
 *   - `first_seen` from engine history is only available when the
 *     caller has an engine env configured AND the pattern has a
 *     `tenxHash`. The POC's primary path (paste SIEM creds, no engine)
 *     gets `null`. The badge degrades to `(unknown)` rather than
 *     showing a wrong number.
 *   - Trajectory (constant vs bursty within the window) needs per-event
 *     timestamps. `ExtractedPattern` discards them after templating, so
 *     we skip this for POC and surface a planned-gap comment. Adding it
 *     means threading event timestamps through the templater output.
 *   - Redundancy detection works from counts alone — no timestamps
 *     needed — so it's implemented in full here.
 */

import type { IncidentCluster } from './detectors/incident-cluster.js';
import { detectIncidents } from './detectors/incident-cluster.js';

/** Subset of EnrichedPattern that this module reads. Avoids a circular import. */
export interface EnrichableForPoc {
  identity: string;
  service?: string;
  severity?: string;
  template: string;
  symbolMessage?: string;
  count: number;
  bytes: number;
  costPerWindow: number;
  costPerWeek: number;
  variables: Record<string, string[]>;
  /**
   * Per-slot TRUE distinct counts from the templater. When present,
   * this is the source of truth for cardinality — `variables[k].length`
   * is the sample size (capped at 20), not the distinct count.
   */
  slotDistinctCounts?: Record<string, number>;
  /**
   * The renderer's lossless lever for this pattern. We never emit
   * mute/drop/sample as an auto-recommendation. `'mute'`/`'sample'` remain
   * in the union only for back-compat with older callers + the envelope
   * fixtures; the PoC renderer produces only compact/offload/tier_down/keep.
   */
  recommendedAction: 'compact' | 'offload' | 'tier_down' | 'keep' | 'mute' | 'sample';
  sampleRate: number;
  reasoning: string;
  /** Per-event timestamps from the SIEM pull, used for first-seen + growth signals. */
  firstSeenMs?: number;
  lastSeenMs?: number;
  eventsByHour?: Record<number, number>;
}

/**
 * Pattern emergence shape, derived from `firstSeenMs / lastSeenMs /
 * eventsByHour` against the pulled window boundaries.
 */
export interface PatternEmergence {
  /** ms since the pattern's first occurrence in the pulled window. */
  ageInWindowMs: number;
  /** ms span from first to last occurrence in the pulled window. */
  durationMs: number;
  /**
   * Category derived from emergence + duration:
   *   - `new` — appeared within the last 24h of the window
   *   - `growing` — events/hr in last 24h ≥ 2x the window's average events/hr
   *   - `stable` — fired throughout the window, no recent surge
   *   - `recent_burst` — entire pattern fits in <40% of the window
   *   - `unknown` — no timestamps available
   */
  category: 'new' | 'growing' | 'stable' | 'recent_burst' | 'unknown';
  /** Ratio of events/hr in last 24h vs the window's average events/hr. */
  accelerationRatio: number;
}

/** Slot with the highest distinct-value count for a pattern. */
export interface TopSlot {
  slot: string;
  distinctCount: number;
  /** Fraction of events showing distinct slot values; high values = unbounded variable. */
  distinctOverCount: number;
}

/** Single redundancy pair: two patterns whose counts move together. */
export interface RedundancyPair {
  identityA: string;
  identityB: string;
  /** count(A) / count(B) — closeness to 1 indicates 1:1 firing. */
  ratio: number;
  /** Minimum absolute count in the pair (filters low-confidence pairs). */
  minCount: number;
}

/** Decoration applied to each pattern by these enrichers. */
export interface PocEnrichment {
  /** Cluster id (0-based index into the returned clusters array), or null. */
  incidentClusterId: number | null;
  /** Top variable slot by distinct value count, or null when no slots. */
  topSlot: TopSlot | null;
  /** Identities this pattern fires 1:1 with (within the sample). */
  redundantWith: string[];
  /** Pattern's first-seen age in seconds when engine history is available. */
  firstSeenAgeSeconds: number | null;
  /**
   * Action category after dependency-check fold-in. Carries the renderer's
   * lossless lever (compact / offload / tier_down / keep) plus two
   * refinements: `fix` (ERROR-severity patterns are not noise, the right
   * action is upstream) and `blocked` (dep-check found refs, do not
   * auto-act). `mute`/`sample` remain for back-compat with older callers.
   */
  refinedAction: 'fix' | 'compact' | 'offload' | 'tier_down' | 'keep' | 'blocked' | 'mute' | 'sample';
  /** Number of dependencies (monitors/dashboards/saved-searches) found, when checked. */
  dependencyCount: number | null;
  /** Source of the dep-check result (or `null` when not run for this pattern). */
  dependencyChecked: boolean;
  /**
   * Emergence shape computed from per-event timestamps within the pulled
   * window — `new` / `growing` / `stable` / `recent_burst` / `unknown`.
   * Together with `accelerationRatio` this is the longitudinal signal
   * that an unaided agent can't compute from a small sample.
   */
  emergence: PatternEmergence | null;
}

/**
 * Top slot by distinct-value count. A slot with `distinctOverCount`
 * approaching 1.0 is effectively unbounded (every event carries a fresh
 * value — driver of analyzer cardinality cost).
 */
/**
 * Slot names that carry the event's own clock value (timestamp,
 * @timestamp, ts, etc.). These are trivially unique per event — every
 * log line gets a fresh timestamp by construction — and ranking them
 * as "the unbounded slot" leads the host agent to recommend fixes
 * like "pull the timestamp into a structured field", which is
 * meaningless: the timestamp IS the field. Excluding them produces
 * a top_slot that points at an actual variable (request_id, user_id,
 * URL path, etc.) the customer can act on.
 *
 * The set is lowercase-matched so engine-emitted casing variants
 * (`Timestamp`, `TS`, `@Timestamp`) all hit.
 */
const TIME_SLOT_NAMES = new Set([
  'timestamp', '@timestamp', 'ts', 'time', 'datetime', 'date',
  'event_time', 'eventtime', 'occurred_at', 'created_at', 'logged_at',
  'iso8601', 'unixtime', 'epoch_ms', 'epoch_seconds', 'epoch',
  'time_iso', 'time_ms', 'time_s',
]);

export function computeTopSlot(
  variables: Record<string, string[]>,
  count: number,
  slotDistinctCounts?: Record<string, number>,
): TopSlot | null {
  const entries = Object.entries(variables);
  if (entries.length === 0) return null;
  let best: TopSlot | null = null;
  for (const [slot, values] of entries) {
    // Time-keyed slots are unique-by-construction and tell the agent
    // nothing actionable. Skip them entirely so the ranking falls to
    // a real variable.
    if (TIME_SLOT_NAMES.has(slot.toLowerCase())) continue;
    // Prefer the true distinct count when the templater provided it.
    // Fall back to the sample length (capped at 20) only when the
    // upstream extractor didn't carry the cardinality measurement.
    const distinct = slotDistinctCounts?.[slot] ?? values.length;
    if (distinct === 0) continue;
    const score = distinct;
    if (best === null || score > best.distinctCount) {
      best = {
        slot,
        distinctCount: distinct,
        distinctOverCount: count > 0 ? Math.min(1, distinct / count) : 0,
      };
    }
  }
  return best;
}

/**
 * Detect redundancy pairs: patterns whose event counts are close enough
 * to be the same event logged twice (request-received + transaction-
 * complete, http-in + http-out, etc.). Pair-wise check across the top N
 * patterns to keep cost O(N^2) bounded.
 *
 * Heuristic:
 *   - Both patterns must have count >= `minCount` (default 50). Low-count
 *     pairs are noise from sample variance.
 *   - Ratio = max(a,b) / min(a,b) must be within [1, `maxRatio`] (default
 *     1.15). Tighter than 0.85 < count_a/count_b < 1.15 gives a 15%
 *     tolerance window.
 *   - Patterns must share a service (different services with matching
 *     counts are coincidence, not redundancy).
 *
 * Returns sorted-by-count pairs (highest first). One pattern may appear
 * in multiple pairs; downstream renderer decides whether to dedup.
 */
export function detectRedundancyPairs(
  patterns: EnrichableForPoc[],
  opts: { minCount?: number; maxRatio?: number } = {},
): RedundancyPair[] {
  const minCount = opts.minCount ?? 50;
  const maxRatio = opts.maxRatio ?? 1.15;
  const out: RedundancyPair[] = [];
  for (let i = 0; i < patterns.length; i++) {
    const a = patterns[i];
    if (a.count < minCount) continue;
    for (let j = i + 1; j < patterns.length; j++) {
      const b = patterns[j];
      if (b.count < minCount) continue;
      if ((a.service || '') !== (b.service || '')) continue;
      const hi = Math.max(a.count, b.count);
      const lo = Math.min(a.count, b.count);
      if (lo === 0) continue;
      const ratio = hi / lo;
      if (ratio <= maxRatio) {
        out.push({
          identityA: a.identity,
          identityB: b.identity,
          ratio,
          minCount: lo,
        });
      }
    }
  }
  out.sort((p, q) => q.minCount - p.minCount);
  return out;
}

/**
 * Compute the pattern's emergence shape inside the pulled window. The
 * window edges come from the caller — the pull layer knows when it
 * started and ended; the per-event timestamps tell us where this
 * pattern fired relative to those edges. Returns `null` when no
 * timestamps are available (paste-Lambda fallback, older SIEM
 * connectors, CloudWatch events without `timestamp` field, etc.).
 *
 * Categories:
 *   - `new`            — first_seen within the last 24h of the window
 *                        (pattern showed up recently — incident signal)
 *   - `growing`        — last-24h rate >= 2x the window's average rate
 *                        (pattern is accelerating)
 *   - `stable`         — fired throughout the window, no recent surge
 *                        (head-of-tail noise, safe sample/mute candidate)
 *   - `recent_burst`   — entire activity fits in <40% of the window
 *                        (transient, not steady-state — check correlation)
 *   - `unknown`        — no timestamps in the pull
 */
export function computeEmergence(
  p: { firstSeenMs?: number; lastSeenMs?: number; eventsByHour?: Record<number, number>; count: number },
  windowStartMs: number,
  windowEndMs: number,
): PatternEmergence {
  if (p.firstSeenMs === undefined || p.lastSeenMs === undefined) {
    return { ageInWindowMs: 0, durationMs: 0, category: 'unknown', accelerationRatio: 0 };
  }
  const ageInWindowMs = windowEndMs - p.firstSeenMs;
  const durationMs = p.lastSeenMs - p.firstSeenMs;
  const windowSpanMs = Math.max(1, windowEndMs - windowStartMs);
  const last24hStart = windowEndMs - 24 * 3_600_000;

  // Last-24h event count from the per-hour buckets.
  let last24hCount = 0;
  if (p.eventsByHour) {
    const last24hBucketStart = Math.floor(last24hStart / 3_600_000);
    for (const [bucket, count] of Object.entries(p.eventsByHour)) {
      if (Number(bucket) >= last24hBucketStart) last24hCount += count;
    }
  }

  const windowAvgPerHour = p.count / (windowSpanMs / 3_600_000);
  const last24hPerHour = last24hCount / 24;
  const accelerationRatio = windowAvgPerHour > 0 ? last24hPerHour / windowAvgPerHour : 0;

  let category: PatternEmergence['category'];
  if (p.firstSeenMs >= last24hStart) {
    category = 'new';
  } else if (accelerationRatio >= 2.0 && last24hCount >= 10) {
    category = 'growing';
  } else if (durationMs < windowSpanMs * 0.4) {
    category = 'recent_burst';
  } else {
    category = 'stable';
  }

  return { ageInWindowMs, durationMs, category, accelerationRatio };
}

/**
 * Refine the recommended action by folding in dependency-check
 * results + severity. The existing renderer logic returns mute / sample
 * / keep purely from cost-tier. This refiner adds:
 *
 *   - `fix`: ERROR-class patterns with a clear upstream root (e.g.,
 *     opensearchexporter dial-tcp failure). The right action is open a
 *     ticket, not mute. Lifted from action label heuristic in
 *     poc-report-renderer.ts:actionLabel.
 *   - `blocked`: dependency_check found refs (monitors / dashboards /
 *     saved searches). Even if the original recommendation was mute,
 *     don't auto-act.
 *
 * `keep` / `sample` / `mute` are passed through when no refinement applies.
 */
export function refineAction(
  p: EnrichableForPoc,
  dependencyCount: number | null,
): PocEnrichment['refinedAction'] {
  const sev = (p.severity || '').toUpperCase();
  const isError = /ERROR|CRIT|FATAL/.test(sev);
  // ERROR-class patterns with `dial`/`timeout`/`no_such_host`/`refused`
  // descriptors are dependency failures — fix upstream, don't mute.
  const desc = `${p.symbolMessage || ''} ${p.template}`.toLowerCase();
  const isDependencyFailure =
    isError &&
    /\b(dial|timeout|no.such.host|refused|unreachable|deadline|connection.reset|broken.pipe)\b/.test(
      desc,
    );
  if (isDependencyFailure) return 'fix';
  // Any pattern that gets a reducing lever (lossless compact/offload/tier_down
  // OR the legacy mute) is gated when a dependency reference exists, so the
  // host agent confirms before changing it. `keep` patterns are never blocked.
  const isReducing =
    p.recommendedAction === 'compact' ||
    p.recommendedAction === 'offload' ||
    p.recommendedAction === 'tier_down' ||
    p.recommendedAction === 'mute' ||
    p.recommendedAction === 'sample';
  if (dependencyCount !== null && dependencyCount > 0 && isReducing) {
    return 'blocked';
  }
  return p.recommendedAction;
}

/**
 * Apply all enrichers in one pass. Returns a parallel array (same
 * order, same length) of decorations. The renderer joins them by index.
 *
 * `dependencyByIdentity` is the map produced by the optional pre-warm
 * pass in the POC submit pipeline. Missing entries fall back to
 * `null` (unchecked) without inflating false confidence.
 */
export function enrichForPoc(
  patterns: EnrichableForPoc[],
  opts: {
    /** Limit incident-clustering to the top N patterns (cost-ranked). */
    incidentTopN?: number;
    /** Per-identity dependency counts, when pre-computed. */
    dependencyByIdentity?: Map<string, number>;
    /** Per-identity first-seen ages from engine, when pre-computed. */
    firstSeenByIdentity?: Map<string, number>;
    /**
     * Window boundaries of the SIEM pull, in epoch ms. When set, each
     * pattern's `emergence` field is computed against these bounds. When
     * omitted, emergence falls back to `unknown`.
     */
    windowStartMs?: number;
    windowEndMs?: number;
  } = {},
): { enrichments: PocEnrichment[]; clusters: IncidentCluster[]; redundancyPairs: RedundancyPair[] } {
  const incidentTopN = opts.incidentTopN ?? 20;
  const topByCost = patterns.slice(0, incidentTopN);

  const clusters = detectIncidents(
    topByCost.map((p) => ({
      identity: p.identity,
      service: p.service,
      descriptor: p.symbolMessage || p.template,
      costPerMonthUsd: (p.costPerWeek * 52) / 12,
      trendBytesPerSec: undefined,
    })),
  );

  const identityToCluster = new Map<string, number>();
  for (let ci = 0; ci < clusters.length; ci++) {
    for (const m of clusters[ci].members) identityToCluster.set(m.identity, ci);
  }

  const redundancyPairs = detectRedundancyPairs(topByCost);
  const identityToRedundant = new Map<string, string[]>();
  for (const pair of redundancyPairs) {
    const a = identityToRedundant.get(pair.identityA) ?? [];
    a.push(pair.identityB);
    identityToRedundant.set(pair.identityA, a);
    const b = identityToRedundant.get(pair.identityB) ?? [];
    b.push(pair.identityA);
    identityToRedundant.set(pair.identityB, b);
  }

  const enrichments: PocEnrichment[] = patterns.map((p) => {
    const topSlot = computeTopSlot(p.variables, p.count, p.slotDistinctCounts);
    const dependencyCount = opts.dependencyByIdentity?.get(p.identity) ?? null;
    const dependencyChecked = opts.dependencyByIdentity?.has(p.identity) ?? false;
    const emergence =
      opts.windowStartMs !== undefined && opts.windowEndMs !== undefined
        ? computeEmergence(
            { firstSeenMs: p.firstSeenMs, lastSeenMs: p.lastSeenMs, eventsByHour: p.eventsByHour, count: p.count },
            opts.windowStartMs,
            opts.windowEndMs,
          )
        : null;
    return {
      incidentClusterId: identityToCluster.get(p.identity) ?? null,
      topSlot,
      redundantWith: identityToRedundant.get(p.identity) ?? [],
      firstSeenAgeSeconds:
        opts.firstSeenByIdentity?.get(p.identity) ??
        (emergence && emergence.ageInWindowMs > 0 ? Math.floor(emergence.ageInWindowMs / 1000) : null),
      refinedAction: refineAction(p, dependencyCount),
      dependencyCount,
      dependencyChecked,
      emergence,
    };
  });

  return { enrichments, clusters, redundancyPairs };
}
