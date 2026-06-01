/**
 * Shared offload-status lookup helper.
 *
 * The receiver stamps `isDropped="true"` on every event it routes to the
 * customer-owned offload bucket (per `project_offload_loop_handoff.md`).
 * That stamp is visible on the metric surface
 * (`all_events_summaryBytes_total{isDropped="true"}`) — so any tool that
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
 * in a 2s timeout. On timeout / error the helper returns `ok: false` with
 * zeroed fields; callers gate on `ok` before surfacing anything.
 *
 * Why not co-located with promql.ts: `promql.ts` is a pure query-builder
 * module (returns strings, no env / no executor). This helper needs both
 * the builder (for `includeToSelector` from PL-12) AND the executor
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
 * `ok=false` signals the metric backend did not return data within the
 * timeout — callers should treat the other fields as undefined and
 * suppress any offload-related UI/markdown.
 */
export interface OffloadStatus {
  is_offloaded: boolean;
  dropped_bytes_in_window: number;
  dropped_share_pct: number;
  kept_bytes_in_window: number;
  sample_count: number;
  /** Unix-ms of the latest dropped sample bucket; null when no dropped series exists. */
  last_seen_dropped_ts: number | null;
  /** True when the metric backend returned data; false on timeout/error. */
  ok: boolean;
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
 * Failure-mode result returned on timeout / backend error / missing env.
 * Distinct from "queried and absent" — that one has `ok: true` with
 * `is_offloaded: false`. Callers that need to suppress UI use `!ok`.
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
 * via `includeToSelector('both')` from PL-12. Both calls share the
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
  // PL-12 contract: include='both' returns droppedFilter=null + runBoth=true,
  // meaning the caller (us) is responsible for issuing the two cohort
  // queries. We hand-build the two selectors with the kept/dropped
  // filters that includeToSelector('kept') and 'dropped' would have
  // emitted individually — same definitions, just inlined to keep the
  // two queries side-by-side and easy to read.
  void droppedFilter;
  const keptDropFilter = `${'isDropped'}!="true"`;
  const droppedDropFilter = `${'isDropped'}="true"`;

  const hashSel = `${labels.hash}="${escapeLabel(hash)}"`;
  const envSel = `${labels.env}="${escapeLabel(metricsEnv)}"`;

  const keptQ = `sum(increase(${BYTES_METRIC}{${hashSel},${envSel},${keptDropFilter}}[${range}]))`;
  const droppedQ = `sum(increase(${BYTES_METRIC}{${hashSel},${envSel},${droppedDropFilter}}[${range}]))`;
  const droppedTsQ = `timestamp(max(${BYTES_METRIC}{${hashSel},${envSel},${droppedDropFilter}}))`;

  const [keptResp, droppedResp, tsResp] = await Promise.all([
    withTimeout(queryInstant(env, keptQ).catch(() => null), timeoutMs),
    withTimeout(queryInstant(env, droppedQ).catch(() => null), timeoutMs),
    withTimeout(queryInstant(env, droppedTsQ).catch(() => null), timeoutMs),
  ]);

  // A timeout on either cohort poisons the result — we cannot compute
  // a credible share without both sides.
  if (keptResp === null || droppedResp === null) return failed();

  const kept = parseScalar(keptResp);
  const dropped = parseScalar(droppedResp);
  const total = kept + dropped;
  const is_offloaded = dropped > 0;
  const dropped_share_pct = total > 0 ? (dropped / total) * 100 : 0;

  // last_seen_dropped_ts: only meaningful when a dropped cohort exists.
  // The `timestamp()` PromQL returns seconds; convert to unix-ms.
  let last_seen_dropped_ts: number | null = null;
  if (is_offloaded && tsResp) {
    const seconds = parseScalar(tsResp);
    if (seconds > 0) last_seen_dropped_ts = Math.round(seconds * 1000);
  }

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
  const keptDropFilter = `isDropped!="true"`;
  const droppedDropFilter = `isDropped="true"`;

  const keptQ = `sum by (${labels.hash}) (increase(${BYTES_METRIC}{${hashSel},${envSel},${keptDropFilter}}[${range}]))`;
  const droppedQ = `sum by (${labels.hash}) (increase(${BYTES_METRIC}{${hashSel},${envSel},${droppedDropFilter}}[${range}]))`;

  const [keptResp, droppedResp] = await Promise.all([
    withTimeout(queryInstant(env, keptQ).catch(() => null), timeoutMs),
    withTimeout(queryInstant(env, droppedQ).catch(() => null), timeoutMs),
  ]);
  if (keptResp === null || droppedResp === null) return {};

  const keptByHash = new Map<string, number>();
  for (const r of keptResp.data?.result ?? []) {
    const h = r.metric?.[labels.hash];
    if (!h || !wanted.has(h)) continue;
    const v = r.value ? parseFloat(r.value[1]) : 0;
    keptByHash.set(h, Number.isFinite(v) ? v : 0);
  }
  const droppedByHash = new Map<string, number>();
  for (const r of droppedResp.data?.result ?? []) {
    const h = r.metric?.[labels.hash];
    if (!h || !wanted.has(h)) continue;
    const v = r.value ? parseFloat(r.value[1]) : 0;
    droppedByHash.set(h, Number.isFinite(v) ? v : 0);
  }

  const out: Record<string, OffloadStatus> = {};
  const seen = new Set<string>([...keptByHash.keys(), ...droppedByHash.keys()]);
  for (const h of seen) {
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
