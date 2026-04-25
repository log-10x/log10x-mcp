/**
 * Mode selection for retriever_series.
 *
 * Two strategies:
 *   - "full":               one retriever query covering the whole window,
 *                           client-side bucketing + group-by aggregation.
 *                           Exact counts. Bounded by Lambda budget.
 *   - "per_window_sampled": split the window into N sub-windows and run K
 *                           events per sub-window in parallel. Time
 *                           distribution preserved; within-sub-window bucket
 *                           density preserved; tail group-by values may be
 *                           absent in any sub-window's sample.
 *
 * Selection is volume-driven when Reporter has data for the pattern, and
 * window-length-driven as a fallback when it does not. The heuristic lives
 * in this module (NOT in tool descriptions or LLM prompts) so it produces
 * the same decision across calls.
 */
import type { EnvConfig } from './environments.js';
import { queryInstant } from './api.js';

export type FidelityMode = 'full' | 'per_window_sampled';

export type ModeReason =
  | 'estimated_events_under_threshold'
  | 'estimated_events_exceeded_threshold'
  | 'estimated_bytes_exceeded_threshold'
  | 'window_length_short_fallback'
  | 'window_length_long_fallback'
  | 'pattern_volume_unknown_fallback'
  | 'forced_full'
  | 'forced_per_window_sampled';

export type RefusalReason = 'estimated_events_exceed_safe_budget' | 'estimated_bytes_exceed_safe_budget';

/**
 * Tunables. Constants because they're load-bearing for the safety contract;
 * exposing them per-deployment via env vars would let ops accidentally
 * widen the refusal threshold past what Lambda can actually serve. The
 * `fidelity` arg on the tool gives the caller per-call override of mode +
 * K when they want it.
 */
export const FULL_MODE_EVENT_THRESHOLD = 50_000_000;
export const FULL_MODE_BYTE_THRESHOLD = 10 * 1024 * 1024 * 1024; // 10 GB
export const REFUSAL_EVENT_THRESHOLD = 10_000_000_000;
export const REFUSAL_BYTE_THRESHOLD = 100 * 1024 * 1024 * 1024; // 100 GB
export const DEFAULT_K = 1000;
/** Upper cap on N (parallel sub-windows). Keeps fan-out under reasonable Lambda concurrency. */
export const MAX_SUB_WINDOWS = 60;

export interface FidelityDecision {
  mode: FidelityMode;
  reason: ModeReason;
  /** Best-effort estimate of total matching events in the window. Undefined if Reporter had no signal. */
  estimatedEvents?: number;
  /** Best-effort estimate of bytes that would be fetched. Undefined if either count or avg-size is unknown. */
  estimatedBytes?: number;
  /** When mode === "per_window_sampled". */
  subWindows?: number;
  eventsPerSubWindow?: number;
  /** Diagnostic — what we asked Reporter and got back. */
  reporter?: {
    pattern?: string;
    rateQuery?: string;
    bytesQuery?: string;
    rateEventsPerMinute?: number;
    bytesPerEvent?: number;
    note?: string;
  };
}

export interface RefusalDecision {
  mode: 'refused';
  reason: RefusalReason;
  estimatedEvents?: number;
  estimatedBytes?: number;
  recommendation: string;
}

/** Parse the user's `fidelity` arg. */
export function parseFidelityArg(arg: string | undefined): {
  forced: FidelityMode | undefined;
  k: number;
} {
  if (!arg || arg === 'auto') return { forced: undefined, k: DEFAULT_K };
  if (arg === 'full') return { forced: 'full', k: DEFAULT_K };
  const m = arg.match(/^per_window_sampled(?::(\d+))?$/);
  if (m) {
    const k = m[1] ? parseInt(m[1], 10) : DEFAULT_K;
    if (k <= 0) throw new Error(`fidelity K must be > 0, got ${k}`);
    return { forced: 'per_window_sampled', k };
  }
  throw new Error(
    `Invalid fidelity: "${arg}". Use "auto", "full", or "per_window_sampled[:K]" (e.g. "per_window_sampled:500").`
  );
}

/** Compute sub-window count from window length, capped at MAX_SUB_WINDOWS. */
export function subWindowCount(windowMs: number): number {
  const SEVEN_DAYS_MS = 7 * 86_400_000;
  const ONE_DAY_MS = 86_400_000;

  let n: number;
  if (windowMs >= SEVEN_DAYS_MS) {
    // Per-day for windows ≥ 7d
    n = Math.ceil(windowMs / ONE_DAY_MS);
  } else if (windowMs >= ONE_DAY_MS) {
    // Per-hour for windows 1d–7d
    n = Math.ceil(windowMs / 3_600_000);
  } else {
    // Per-15min for sub-day windows
    n = Math.ceil(windowMs / (15 * 60_000));
  }
  return Math.max(1, Math.min(MAX_SUB_WINDOWS, n));
}

/**
 * Window-only fallback used when Reporter has no volume signal for the
 * pattern (new pattern, sparse, no Reporter deployed, or query without a
 * bound `search` filter that would map to a Reporter pattern series).
 *
 * Threshold is conservative: without volume data we can't tell a
 * 100-event/sec pattern from a 100K-event/sec pattern. Anything past 4h
 * is sampled by default. The spec's "≤48h start full + abort if it
 * explodes" path was attractive but the retriever doesn't expose mid-query
 * progress, so an abort would land as a hard timeout — defeating the
 * purpose of the fidelity contract.
 */
export function fallbackByWindow(windowMs: number): { mode: FidelityMode; reason: ModeReason } {
  const FOUR_HOURS = 4 * 3_600_000;
  if (windowMs <= FOUR_HOURS) return { mode: 'full', reason: 'window_length_short_fallback' };
  return { mode: 'per_window_sampled', reason: 'window_length_long_fallback' };
}

/**
 * Best-effort pattern-rate fetch from Reporter.
 *
 * We extract a `tenx_user_pattern` value from the search expression
 * (matches what `event-lookup` does) and ask Reporter for that pattern's
 * event rate over the last 5 minutes plus its bytes/event ratio. Both are
 * Prometheus-side computations — single instant query each, cheap.
 *
 * Returns `undefined` for any field Reporter does not have a value for.
 */
export async function fetchReporterPatternStats(
  env: EnvConfig,
  search: string | undefined
): Promise<{
  pattern?: string;
  rateQuery?: string;
  bytesQuery?: string;
  rateEventsPerMinute?: number;
  bytesPerEvent?: number;
  note?: string;
}> {
  const pattern = extractPatternName(search);
  if (!pattern) {
    return { note: 'no tenx_user_pattern equality in search expression' };
  }

  // Rate of events per minute over the last 5m for this pattern.
  // log10x_event_count_total is the per-pattern event counter the Reporter
  // emits. It may not exist on all deployments — earlier Reporter builds
  // emitted bytes_total but not count_total. Fall back to bytes/avg-size if
  // count is missing (caller guards on the returned `rateEventsPerMinute`
  // being undefined).
  const rateQuery = `sum(rate(log10x_event_count_total{tenx_user_pattern="${pattern}"}[5m])) * 60`;
  const bytesRateQuery = `sum(rate(log10x_event_bytes_total{tenx_user_pattern="${pattern}"}[5m]))`;
  const countRateForBytes = `sum(rate(log10x_event_count_total{tenx_user_pattern="${pattern}"}[5m]))`;

  let rateEventsPerMinute: number | undefined;
  let bytesPerEvent: number | undefined;

  try {
    const resp = await queryInstant(env, rateQuery);
    const v = scalarValue(resp);
    if (v !== undefined && v >= 0) rateEventsPerMinute = v;
  } catch {
    // Reporter unavailable or query failed — leave undefined; caller falls
    // back to window-length heuristic.
  }

  try {
    const num = scalarValue(await queryInstant(env, bytesRateQuery));
    const den = scalarValue(await queryInstant(env, countRateForBytes));
    if (num !== undefined && den !== undefined && den > 0) {
      bytesPerEvent = num / den;
    }
  } catch {
    // Same — leave undefined.
  }

  return {
    pattern,
    rateQuery,
    bytesQuery: bytesRateQuery,
    rateEventsPerMinute,
    bytesPerEvent,
    note:
      rateEventsPerMinute === undefined
        ? 'log10x_event_count_total returned no series for this pattern'
        : undefined,
  };
}

/**
 * Single entry point — combine Reporter signal + thresholds + window-length
 * fallback to produce the mode decision (or a structured refusal).
 */
export async function decideFidelity(
  env: EnvConfig,
  args: {
    search?: string;
    windowMs: number;
    forced?: FidelityMode;
    k: number;
  }
): Promise<FidelityDecision | RefusalDecision> {
  const { search, windowMs, forced, k } = args;

  if (forced === 'full') {
    return {
      mode: 'full',
      reason: 'forced_full',
    };
  }

  if (forced === 'per_window_sampled') {
    const n = subWindowCount(windowMs);
    return {
      mode: 'per_window_sampled',
      reason: 'forced_per_window_sampled',
      subWindows: n,
      eventsPerSubWindow: k,
    };
  }

  const reporter = await fetchReporterPatternStats(env, search);
  const ratePerMin = reporter.rateEventsPerMinute;
  const bytesPerEvent = reporter.bytesPerEvent;

  if (ratePerMin === undefined) {
    const fb = fallbackByWindow(windowMs);
    if (fb.mode === 'full') {
      return { mode: 'full', reason: fb.reason, reporter };
    }
    return {
      mode: 'per_window_sampled',
      reason: fb.reason,
      subWindows: subWindowCount(windowMs),
      eventsPerSubWindow: k,
      reporter,
    };
  }

  const windowMinutes = windowMs / 60_000;
  const estimatedEvents = ratePerMin * windowMinutes;
  const estimatedBytes = bytesPerEvent !== undefined ? estimatedEvents * bytesPerEvent : undefined;

  if (
    estimatedEvents > REFUSAL_EVENT_THRESHOLD ||
    (estimatedBytes !== undefined && estimatedBytes > REFUSAL_BYTE_THRESHOLD)
  ) {
    const reason: RefusalReason =
      estimatedBytes !== undefined && estimatedBytes > REFUSAL_BYTE_THRESHOLD
        ? 'estimated_bytes_exceed_safe_budget'
        : 'estimated_events_exceed_safe_budget';
    return {
      mode: 'refused',
      reason,
      estimatedEvents: Math.round(estimatedEvents),
      estimatedBytes: estimatedBytes !== undefined ? Math.round(estimatedBytes) : undefined,
      recommendation: refusalRecommendation(estimatedEvents, estimatedBytes, windowMs, !!search),
    };
  }

  const overEvents = estimatedEvents > FULL_MODE_EVENT_THRESHOLD;
  const overBytes = estimatedBytes !== undefined && estimatedBytes > FULL_MODE_BYTE_THRESHOLD;

  if (overEvents || overBytes) {
    return {
      mode: 'per_window_sampled',
      reason: overBytes ? 'estimated_bytes_exceeded_threshold' : 'estimated_events_exceeded_threshold',
      estimatedEvents: Math.round(estimatedEvents),
      estimatedBytes: estimatedBytes !== undefined ? Math.round(estimatedBytes) : undefined,
      subWindows: subWindowCount(windowMs),
      eventsPerSubWindow: k,
      reporter,
    };
  }

  return {
    mode: 'full',
    reason: 'estimated_events_under_threshold',
    estimatedEvents: Math.round(estimatedEvents),
    estimatedBytes: estimatedBytes !== undefined ? Math.round(estimatedBytes) : undefined,
    reporter,
  };
}

function refusalRecommendation(
  estEvents: number,
  estBytes: number | undefined,
  windowMs: number,
  hasSearch: boolean
): string {
  const parts: string[] = [];
  parts.push(
    `Estimated ${formatLargeCount(estEvents)} events` +
      (estBytes ? ` / ${formatLargeBytes(estBytes)}` : '') +
      ` exceed the safe per-query budget.`
  );
  const hours = windowMs / 3_600_000;
  if (hours > 24) {
    parts.push('Narrow the window to ≤24h, or');
  }
  if (!hasSearch) {
    parts.push('add a `search` expression to bind the query to a specific pattern, or');
  } else {
    parts.push('add a more selective `filters` expression, or');
  }
  parts.push('switch to `fidelity: "per_window_sampled"` explicitly to accept sampled fidelity at this scale.');
  return parts.join(' ');
}

function formatLargeCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatLargeBytes(n: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * Pull a pattern name out of a TenX search expression. Matches:
 *   tenx_user_pattern == "Foo"   → "Foo"
 *   tenx_user_pattern=="Foo"     → "Foo"
 * Anything else returns undefined (we don't try to resolve templateHash
 * back to pattern name; that requires a Reporter round-trip we'd rather
 * have the user do explicitly via event_lookup).
 */
export function extractPatternName(search: string | undefined): string | undefined {
  if (!search) return undefined;
  const m = search.match(/tenx_user_pattern\s*==\s*"([^"]+)"/);
  return m ? m[1] : undefined;
}

function scalarValue(resp: unknown): number | undefined {
  // Prometheus instant query result: { data: { resultType: 'vector', result: [{ value: [t, "v"] }] } }
  const r = resp as {
    data?: {
      result?: Array<{ value?: [number, string] }>;
    };
  };
  const first = r?.data?.result?.[0];
  if (!first || !first.value) return undefined;
  const n = parseFloat(first.value[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Convert a relative or absolute time expression to epoch millis. Mirrors
 * the retriever normalizer's interpretation but returns a number we can
 * arithmetic on (for sub-window splitting and window-length math).
 */
export function timeExprToMs(expr: string, nowMs: number = Date.now()): number {
  const trimmed = expr.trim();
  if (trimmed === 'now') return nowMs;
  const rel = trimmed.match(/^now\s*([+-])\s*(\d+)\s*([smhdwMy])$/);
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const n = parseInt(rel[2], 10);
    const unit = rel[3];
    const ms = unitToMs(unit) * n;
    return nowMs + sign * ms;
  }
  const inner = trimmed.match(/^now\s*\(\s*"([+-])(\d+)([smhdwMy])"\s*\)$/);
  if (inner) {
    const sign = inner[1] === '-' ? -1 : 1;
    const n = parseInt(inner[2], 10);
    const unit = inner[3];
    return nowMs + sign * unitToMs(unit) * n;
  }
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Cannot interpret time expression: ${expr}`);
}

function unitToMs(unit: string): number {
  switch (unit) {
    case 's':
      return 1000;
    case 'm':
      return 60_000;
    case 'h':
      return 3_600_000;
    case 'd':
      return 86_400_000;
    case 'w':
      return 7 * 86_400_000;
    case 'M':
      return 30 * 86_400_000;
    case 'y':
      return 365 * 86_400_000;
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}
