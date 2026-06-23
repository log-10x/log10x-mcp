/**
 * Shared offload-status lookup helper.
 *
 * The receiver stamps `routeState="drop"` on every event it routes to the
 * customer-owned offload bucket (per `project_offload_loop_handoff.md`).
 * That stamp is visible on the metric surface
 * (`all_events_summaryBytes_total{routeState="drop"}`) — so any tool that
 * has resolved a `pattern_hash` can ask "is this pattern currently being
 * offloaded?" with a single PromQL instant query.
 *
 * This module is the one canonical place that question gets asked.
 * `retriever_query`, `event_lookup`, and `investigate` each call into
 * here so the offload-detection logic (and its tolerances — thresholds,
 * timeout, defaults) lives in exactly one spot.
 *
 * Design split (preserved from `metric_surface_owns_overflow_visibility.md`):
 * the offload lookup is a TSDB query on the metric surface, NOT a
 * retriever-archive scan. The helper does not touch S3 / the bloom index;
 * it issues at most two Prometheus instant queries per call, each wrapped
 * in its OWN 2s timeout. Heavy-cohort tail-latency note: a slow kept-side
 * scan no longer poisons a fast dropped-side answer — see the
 * partial-result contract on `OffloadStatus`. `ok: false` is now reserved
 * for the case where BOTH cohorts timed out.
 *
 * Why not co-located with promql.ts: `promql.ts` is a pure query-builder
 * module (returns strings, no env / no executor). This helper needs both
 * the builder (`includeToSelector`) AND the executor
 * (`queryInstant`), so it sits one layer up.
 */

import type { EnvConfig } from './environments.js';
import { queryInstant, type PrometheusResponse } from './api.js';
import {
  DEFAULT_LABELS,
  includeToSelector,
  type LabelNameMap,
} from './promql.js';

const BYTES_METRIC = 'all_events_summaryBytes_total';
const DEFAULT_RANGE = '24h';
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Resolved offload status for a single `pattern_hash`.
 *
 * `ok=false` signals neither cohort returned data within the timeout —
 * callers should treat the other fields as undefined and suppress any
 * offload-related UI/markdown.
 *
 * Partial-result contract (heavy-cohort tail-latency fix): when the
 * dropped side resolves with bytes > 0 but the kept side times out, the
 * envelope still surfaces `ok: true, is_offloaded: true,
 * dropped_bytes_in_window: <value>` with `kept_bytes_in_window: null`,
 * `dropped_share_pct: null`, and `kept_timed_out: true`. The agent still
 * gets the actionable signal (this pattern IS offloaded → use
 * retriever_query); the share math is omitted. Symmetric flag
 * `dropped_timed_out` covers the inverse case (kept resolves, dropped
 * times out) — in that branch we cannot claim offload, so `is_offloaded`
 * is forced false and `dropped_bytes_in_window` is null.
 */
export interface OffloadStatus {
  /**
   * True when the drop/offload cohort (`routeState="drop"`) has bytes in the
   * window. NOTE: today `routeState="drop"` does NOT distinguish
   * offload-to-S3 (fetchable via retriever_query) from hard-drop (gone,
   * never offloaded). So `is_offloaded` means "in the engine's drop/offload
   * cohort", NOT "confirmed offloaded/fetchable". Consumers must not promise
   * fetchability from this alone — a true distinction needs the dedicated
   * `routeState="offload"` setter (D1b). Until then, gate fetch-back claims
   * on a found result / retriever-configured, not on this flag.
   */
  is_offloaded: boolean;
  dropped_bytes_in_window: number | null;
  dropped_share_pct: number | null;
  kept_bytes_in_window: number | null;
  sample_count: number;
  /** Unix-ms of the latest dropped sample bucket; null when no dropped series exists. */
  last_seen_dropped_ts: number | null;
  /** True when at least one cohort returned data; false only when BOTH timed out. */
  ok: boolean;
  /** True when the kept-cohort PromQL scan timed out (share math suppressed). */
  kept_timed_out?: boolean;
  /** True when the dropped-cohort PromQL scan timed out (is_offloaded forced false). */
  dropped_timed_out?: boolean;
}

export interface OffloadStatusArgs {
  patternHash: string;
  metricsEnv: string;
  /** Window for the increase() over the bytes metric. Default `24h`. */
  range?: string;
  /** Per-query timeout. Default 2000ms (each cohort runs in parallel). */
  timeoutMs?: number;
  /** Label name map. Default `DEFAULT_LABELS`. */
  labels?: LabelNameMap;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Single-shot timeout wrapper. Resolves to `null` on timeout. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseScalar(resp: PrometheusResponse | null): number {
  if (!resp || resp.status !== 'success') return 0;
  const result = resp.data?.result;
  if (!Array.isArray(result) || result.length === 0) return 0;
  const v = result[0].value;
  if (!v) return 0;
  const n = parseFloat(v[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Total-failure result returned when BOTH cohorts timed out / errored, or
 * when the request shape was invalid (empty hash / env).
 *
 * Distinct from "queried and absent" — that one has `ok: true` with
 * `is_offloaded: false`. Callers that need to suppress UI use `!ok`.
 *
 * Partial-failure cases (one cohort timed out, the other resolved) do
 * NOT route through here — they return `ok: true` plus a `*_timed_out`
 * flag with the resolved cohort's bytes populated. See `getOffloadStatus`.
 */
function failed(): OffloadStatus {
  return {
    is_offloaded: false,
    dropped_bytes_in_window: 0,
    dropped_share_pct: 0,
    kept_bytes_in_window: 0,
    sample_count: 0,
    last_seen_dropped_ts: null,
    ok: false,
  };
}

/**
 * Lookup the offload status for a single `pattern_hash`.
 *
 * Issues two parallel Prometheus instant queries (kept + dropped cohorts)
 * via `includeToSelector('both')`. Both calls share the
 * `timeoutMs` budget (parallel, not sequential). If either cohort times
 * out the result is marked `ok: false`.
 */
export async function getOffloadStatus(
  env: EnvConfig,
  args: OffloadStatusArgs,
): Promise<OffloadStatus> {
  const labels = args.labels ?? env.labels ?? DEFAULT_LABELS;
  const range = args.range ?? DEFAULT_RANGE;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hash = args.patternHash;
  const metricsEnv = args.metricsEnv;
  if (!hash || !metricsEnv) return failed();

  const { droppedFilter } = includeToSelector('both');
  // include='both' returns droppedFilter=null + runBoth=true,
  // meaning the caller (us) is responsible for issuing the two cohort
  // queries. We hand-build the two selectors with the kept/dropped
  // filters that includeToSelector('kept') and 'dropped' would have
  // emitted individually — same definitions, just inlined to keep the
  // two queries side-by-side and easy to read.
  void droppedFilter;
  const keptDropFilter = `${'routeState'}!="drop"`;
  const droppedDropFilter = `${'routeState'}="drop"`;

  const hashSel = `${labels.hash}="${escapeLabel(hash)}"`;
  const envSel = `${labels.env}="${escapeLabel(metricsEnv)}"`;

  const keptQ = `sum(increase(${BYTES_METRIC}{${hashSel},${envSel},${keptDropFilter}}[${range}]))`;
  const droppedQ = `sum(increase(${BYTES_METRIC}{${hashSel},${envSel},${droppedDropFilter}}[${range}]))`;
  const droppedTsQ = `timestamp(max(${BYTES_METRIC}{${hashSel},${envSel},${droppedDropFilter}}))`;

  // Each query is independently timeout-wrapped (null on timeout). Use
  // Promise.allSettled-equivalent behaviour via the per-query withTimeout
  // null sentinel: one slow cohort no longer poisons the other. See the
  // partial-result contract on OffloadStatus.
  const [keptResp, droppedResp, tsResp] = await Promise.all([
    withTimeout(queryInstant(env, keptQ).catch(() => null), timeoutMs),
    withTimeout(queryInstant(env, droppedQ).catch(() => null), timeoutMs),
    withTimeout(queryInstant(env, droppedTsQ).catch(() => null), timeoutMs),
  ]);

  const keptTimedOut = keptResp === null;
  const droppedTimedOut = droppedResp === null;

  // Both cohorts timed out → nothing actionable; preserve the original
  // `ok: false` contract so callers' `!s.ok` gates still suppress UI.
  if (keptTimedOut && droppedTimedOut) return failed();

  // last_seen_dropped_ts: only meaningful when a dropped cohort exists.
  // The `timestamp()` PromQL returns seconds; convert to unix-ms.
  let last_seen_dropped_ts: number | null = null;
  if (!droppedTimedOut && tsResp) {
    const seconds = parseScalar(tsResp);
    if (seconds > 0) last_seen_dropped_ts = Math.round(seconds * 1000);
  }

  // Partial-result: kept side timed out, dropped resolved. The smoke on
  // heavy cohorts (e.g. demo pattern_hash AQwRuueOWbQ at 21.55 GB) hit
  // exactly this: dropped came back in well under 2s, kept did not. We
  // surface `is_offloaded` from the dropped side alone and null out the
  // share math the agent cannot trust. The retriever_query nudge still
  // fires; only the percentage is omitted.
  if (keptTimedOut && !droppedTimedOut) {
    const dropped = parseScalar(droppedResp);
    return {
      is_offloaded: dropped > 0,
      dropped_bytes_in_window: dropped,
      dropped_share_pct: null,
      kept_bytes_in_window: null,
      sample_count: 0,
      last_seen_dropped_ts,
      ok: true,
      kept_timed_out: true,
    };
  }

  // Partial-result: dropped side timed out, kept resolved. We cannot
  // claim is_offloaded without dropped-cohort bytes (false-negative is
  // safer than false-positive — routing the agent to retriever_query
  // when nothing is actually offloaded would be a wrong handoff).
  if (!keptTimedOut && droppedTimedOut) {
    const kept = parseScalar(keptResp);
    return {
      is_offloaded: false,
      dropped_bytes_in_window: null,
      dropped_share_pct: null,
      kept_bytes_in_window: kept,
      sample_count: 0,
      last_seen_dropped_ts: null,
      ok: true,
      dropped_timed_out: true,
    };
  }

  // Both resolved — original happy path.
  const kept = parseScalar(keptResp);
  const dropped = parseScalar(droppedResp);
  const total = kept + dropped;
  const is_offloaded = dropped > 0;
  const dropped_share_pct = total > 0 ? (dropped / total) * 100 : 0;

  return {
    is_offloaded,
    dropped_bytes_in_window: dropped,
    dropped_share_pct,
    kept_bytes_in_window: kept,
    sample_count: 0,
    last_seen_dropped_ts,
    ok: true,
  };
}

/**
 * Batch variant. Used by `retriever_query` and `investigate`, which both
 * already hold a top-N `pattern_hash` list and would otherwise issue N
 * round trips. Drops the per-hash filter, groups `sum by (hash)`, then
 * locally joins back to the input list.
 *
 * Hashes that returned no data are absent from the returned record. The
 * caller's `is_offloaded` default for absent entries is `false` — but
 * the caller decides, not this helper (so "queried and absent" stays
 * distinguishable from "lookup failed", which is a missing entry plus
 * an empty record).
 */
export async function getOffloadStatusBatch(
  env: EnvConfig,
  args: Omit<OffloadStatusArgs, 'patternHash'> & { patternHashes: string[] },
): Promise<Record<string, OffloadStatus>> {
  const labels = args.labels ?? env.labels ?? DEFAULT_LABELS;
  const range = args.range ?? DEFAULT_RANGE;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const metricsEnv = args.metricsEnv;
  const wanted = new Set(args.patternHashes.filter((h) => typeof h === 'string' && h.length > 0));
  if (wanted.size === 0 || !metricsEnv) return {};

  // Constrain the by-hash sum to the wanted set with a regex selector.
  // Keeps the cardinality of the result bounded by the input list — the
  // TSDB doesn't have to materialize the long tail.
  const hashesRe = [...wanted].map((h) => escapeLabel(h).replace(/[.\\+*?()|[\]{}^$]/g, '\\$&')).join('|');
  const hashSel = `${labels.hash}=~"${hashesRe}"`;
  const envSel = `${labels.env}="${escapeLabel(metricsEnv)}"`;
  const keptDropFilter = `routeState!="drop"`;
  const droppedDropFilter = `routeState="drop"`;

  const keptQ = `sum by (${labels.hash}) (increase(${BYTES_METRIC}{${hashSel},${envSel},${keptDropFilter}}[${range}]))`;
  const droppedQ = `sum by (${labels.hash}) (increase(${BYTES_METRIC}{${hashSel},${envSel},${droppedDropFilter}}[${range}]))`;

  const [keptResp, droppedResp] = await Promise.all([
    withTimeout(queryInstant(env, keptQ).catch(() => null), timeoutMs),
    withTimeout(queryInstant(env, droppedQ).catch(() => null), timeoutMs),
  ]);
  const keptTimedOut = keptResp === null;
  const droppedTimedOut = droppedResp === null;

  // Both sides timed out → nothing usable for any hash.
  if (keptTimedOut && droppedTimedOut) return {};

  const keptByHash = new Map<string, number>();
  if (!keptTimedOut) {
    for (const r of keptResp.data?.result ?? []) {
      const h = r.metric?.[labels.hash];
      if (!h || !wanted.has(h)) continue;
      const v = r.value ? parseFloat(r.value[1]) : 0;
      keptByHash.set(h, Number.isFinite(v) ? v : 0);
    }
  }
  const droppedByHash = new Map<string, number>();
  if (!droppedTimedOut) {
    for (const r of droppedResp.data?.result ?? []) {
      const h = r.metric?.[labels.hash];
      if (!h || !wanted.has(h)) continue;
      const v = r.value ? parseFloat(r.value[1]) : 0;
      droppedByHash.set(h, Number.isFinite(v) ? v : 0);
    }
  }

  const out: Record<string, OffloadStatus> = {};
  const seen = new Set<string>([...keptByHash.keys(), ...droppedByHash.keys()]);
  for (const h of seen) {
    if (keptTimedOut) {
      // dropped resolved, kept timed out — emit the same partial-result
      // shape as the single-hash path. Share math is suppressed.
      const dropped = droppedByHash.get(h) ?? 0;
      out[h] = {
        is_offloaded: dropped > 0,
        dropped_bytes_in_window: dropped,
        dropped_share_pct: null,
        kept_bytes_in_window: null,
        sample_count: 0,
        last_seen_dropped_ts: null,
        ok: true,
        kept_timed_out: true,
      };
      continue;
    }
    if (droppedTimedOut) {
      // kept resolved, dropped timed out — cannot claim offload.
      const kept = keptByHash.get(h) ?? 0;
      out[h] = {
        is_offloaded: false,
        dropped_bytes_in_window: null,
        dropped_share_pct: null,
        kept_bytes_in_window: kept,
        sample_count: 0,
        last_seen_dropped_ts: null,
        ok: true,
        dropped_timed_out: true,
      };
      continue;
    }
    const kept = keptByHash.get(h) ?? 0;
    const dropped = droppedByHash.get(h) ?? 0;
    const total = kept + dropped;
    const is_offloaded = dropped > 0;
    const dropped_share_pct = total > 0 ? (dropped / total) * 100 : 0;
    out[h] = {
      is_offloaded,
      dropped_bytes_in_window: dropped,
      dropped_share_pct,
      kept_bytes_in_window: kept,
      sample_count: 0,
      last_seen_dropped_ts: null,
      ok: true,
    };
  }
  return out;
}
