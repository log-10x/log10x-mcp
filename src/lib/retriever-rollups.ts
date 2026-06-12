/**
 * Summaries-sourced rollups for retriever query results.
 *
 * The engine writes per-slice pre-aggregated summaries under
 * `qrs/{queryId}/{sliceFrom}_{sliceTo}/{worker}.jsonl` — each row carries
 * `summaryVolume` (event count), `summaryBytes`, and the deployment's named
 * enrichment fields (severity_level, tenx_user_service, ...). Summing those
 * rows yields WHOLE-MATCH rollups at a cost independent of match size,
 * unlike the event-derived rollups which only see the capped download
 * (the >limit-match wart).
 *
 * Honesty rules enforced by the CALLER (retriever-query.ts):
 *   - Summaries are only used when the query had NO filters[] — whether the
 *     engine's summary writer applies filters before aggregating is
 *     unverified, so filtered queries keep event-derived rollups rather
 *     than risk overcounting.
 *   - Per-dimension coverage fallback: a deployment whose enrichmentFields
 *     omit severity/service produces summary rows WITHOUT those keys
 *     (absent, not empty). Such a dimension falls back to event-derived
 *     counts (raw events always carry the fields). `coverage` reports
 *     which dimensions the summaries can actually serve.
 *   - The envelope stamps `rollup_basis` so a receipt reader knows whether
 *     by_* reflects the whole match (qrs_summaries) or the capped download
 *     (events_capped), or a per-dimension mix.
 */

import type { RetrieverSummary } from './retriever-api.js';

export interface SummaryRollups {
  by_severity: Record<string, number>;
  by_service: Record<string, number>;
  by_day: Record<string, number>;
  /** Sum of summaryVolume across all rows = whole-match event count. */
  total_volume: number;
  /** Sum of summaryBytes across all rows. */
  total_bytes: number;
  /**
   * Which dimensions the summary rows can serve: true when at least one
   * row carries the field. False = the deployment's enrichmentFields do
   * not include it — fall back to event-derived counts for that dimension.
   */
  coverage: { severity: boolean; service: boolean };
}

export type RollupBasis = 'qrs_summaries' | 'events_capped' | 'mixed';

/**
 * Multi-dimension reducer over summary rows: each dimension independently
 * sums `summaryVolume`. (Distinct from retriever-series' single-group_by
 * aggregation — this produces the three flat maps the query envelope needs.)
 */
/**
 * Normalize a qrs/ summary dimension value to a single bucket key. The engine
 * emits these fields as arrays (multi-value groups are possible); take the
 * first non-empty element. Empty array / empty string / absent value all map
 * to 'unknown' — matching the event-derived rollups' `|| 'unknown'` convention.
 */
function normalizeDim(v: unknown): string {
  if (Array.isArray(v)) {
    for (const el of v) {
      if (typeof el === 'string' && el.length > 0) return el;
      if (typeof el === 'number') return String(el);
    }
    return 'unknown';
  }
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return 'unknown';
}

export function computeSummaryRollups(summaries: readonly RetrieverSummary[]): SummaryRollups {
  const by_severity: Record<string, number> = {};
  const by_service: Record<string, number> = {};
  const by_day: Record<string, number> = {};
  let total_volume = 0;
  let total_bytes = 0;
  let sawSeverity = false;
  let sawService = false;

  for (const row of summaries) {
    const vol = Number.isFinite(row.summaryVolume) ? row.summaryVolume : 0;
    if (vol <= 0) continue;
    total_volume += vol;
    total_bytes += Number.isFinite(row.summaryBytes) ? row.summaryBytes : 0;

    const rec = row as unknown as Record<string, unknown>;
    // The engine emits enrichment dimensions as ARRAYS in the qrs/ rows
    // (e.g. severity_level:["DEBUG"], tenx_user_service:[]) — verified live
    // on the otel-demo. Coverage = the deployment REGISTERED the dimension
    // (the key is present on the row), independent of whether this group's
    // value is empty; an empty value buckets as 'unknown', exactly as the
    // event-derived path does, so the two bases stay consistent.
    if ('severity_level' in rec) {
      sawSeverity = true;
      const sev = normalizeDim(rec['severity_level']);
      by_severity[sev] = (by_severity[sev] ?? 0) + vol;
    } else {
      by_severity['unknown'] = (by_severity['unknown'] ?? 0) + vol;
    }
    if ('tenx_user_service' in rec) {
      sawService = true;
      const svc = normalizeDim(rec['tenx_user_service']);
      by_service[svc] = (by_service[svc] ?? 0) + vol;
    } else {
      by_service['unknown'] = (by_service['unknown'] ?? 0) + vol;
    }
    // Day attribution from the slice's lower bound. Slices are typically
    // ~1 minute, so midnight-straddling error is negligible at day grain.
    if (Number.isFinite(row.sliceFromMs) && row.sliceFromMs > 0) {
      const day = new Date(row.sliceFromMs).toISOString().slice(0, 10);
      by_day[day] = (by_day[day] ?? 0) + vol;
    }
  }

  return {
    by_severity,
    by_service,
    by_day,
    total_volume,
    total_bytes,
    coverage: { severity: sawSeverity, service: sawService },
  };
}


export interface RollupSelection {
  by_severity: Record<string, number>;
  by_service: Record<string, number>;
  by_day: Record<string, number>;
  rollup_basis: RollupBasis;
}

/**
 * Pick the rollup maps + provenance stamp. Pure so the gating (the part
 * that decides whether the agent sees whole-match or capped counts) is
 * unit-testable without the tool harness.
 *
 * Rules: summaries are never used under filters[] (the engine summary
 * writer's filter behavior is unverified — overcount risk). A dimension
 * the summaries cannot serve falls back to the event-derived map.
 * 'qrs_summaries' is stamped ONLY when all three dimensions came from
 * summaries; any blend stamps 'mixed'.
 */
export function selectRollups(args: {
  eventDerived: { by_severity: Record<string, number>; by_service: Record<string, number>; by_day: Record<string, number> };
  summaries: readonly RetrieverSummary[] | undefined;
  filtersActive: boolean;
}): RollupSelection {
  const ev = args.eventDerived;
  if (args.filtersActive || !args.summaries || args.summaries.length === 0) {
    return { ...ev, rollup_basis: 'events_capped' };
  }
  const sr = computeSummaryRollups(args.summaries);
  const useSev = sr.coverage.severity;
  const useSvc = sr.coverage.service;
  const useDay = Object.keys(sr.by_day).length > 0;
  return {
    by_severity: useSev ? sr.by_severity : ev.by_severity,
    by_service: useSvc ? sr.by_service : ev.by_service,
    by_day: useDay ? sr.by_day : ev.by_day,
    rollup_basis: useSev && useSvc && useDay ? 'qrs_summaries' : 'mixed',
  };
}
