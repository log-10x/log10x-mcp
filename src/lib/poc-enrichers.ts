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
  recommendedAction: 'mute' | 'sample' | 'keep';
  sampleRate: number;
  reasoning: string;
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
   * Action category after dependency-check fold-in. Same possible values
   * as the existing recommendedAction with the addition of `fix` —
   * ERROR-severity patterns are not noise, the right action is upstream.
   */
  refinedAction: 'fix' | 'mute' | 'sample' | 'keep' | 'blocked';
  /** Number of dependencies (monitors/dashboards/saved-searches) found, when checked. */
  dependencyCount: number | null;
  /** Source of the dep-check result (or `null` when not run for this pattern). */
  dependencyChecked: boolean;
}

/**
 * Top slot by distinct-value count. A slot with `distinctOverCount`
 * approaching 1.0 is effectively unbounded (every event carries a fresh
 * value — driver of analyzer cardinality cost).
 */
export function computeTopSlot(
  variables: Record<string, string[]>,
  count: number,
): TopSlot | null {
  const entries = Object.entries(variables);
  if (entries.length === 0) return null;
  let best: TopSlot | null = null;
  for (const [slot, values] of entries) {
    const distinct = values.length;
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
  if (dependencyCount !== null && dependencyCount > 0 && p.recommendedAction === 'mute') {
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
    const topSlot = computeTopSlot(p.variables, p.count);
    const dependencyCount = opts.dependencyByIdentity?.get(p.identity) ?? null;
    const dependencyChecked = opts.dependencyByIdentity?.has(p.identity) ?? false;
    return {
      incidentClusterId: identityToCluster.get(p.identity) ?? null,
      topSlot,
      redundantWith: identityToRedundant.get(p.identity) ?? [],
      firstSeenAgeSeconds: opts.firstSeenByIdentity?.get(p.identity) ?? null,
      refinedAction: refineAction(p, dependencyCount),
      dependencyCount,
      dependencyChecked,
    };
  });

  return { enrichments, clusters, redundancyPairs };
}
