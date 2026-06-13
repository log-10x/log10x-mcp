/**
 * PromQL query builders.
 *
 * Generates the PromQL queries used by each tool.
 *
 * Phase 2 of the CUSTOMER-PROM-BACKEND design: every builder now accepts
 * an optional `labels: LabelNameMap` parameter so per-env label renames
 * (the engine's `metricFieldNames` setting) can flow through to the
 * MCP's queries. Missing parameter defaults to `DEFAULT_LABELS`, which
 * is what every tool uses today — no behavior change until phase 4
 * threads the env's label map through.
 */

const BYTES_METRIC = 'all_events_summaryBytes_total';
const VOLUME_METRIC = 'all_events_summaryVolume_total';
const EMITTED_METRIC = 'emitted_events_summaryBytes_total';
const EMITTED_OPT_METRIC = 'emitted_events_optimized_size_total';
const INDEXED_METRIC = 'indexed_events_summaryBytes_total';
const STREAMED_METRIC = 'streamed_events_summaryBytes_total';

/**
 * Per-env metric label name map. The 10x engine's
 * `pipelines/run/output/metric/{backend}/config.yaml` has a
 * `metricFieldNames` setting that lets a customer rename
 * `tenx_user_service` to `service`, `message_pattern` to
 * `pattern_hash`, etc. The MCP must build queries with the same names
 * the engine writes; this type is the customer-facing knob.
 */
export interface LabelNameMap {
  pattern: string;
  service: string;
  severity: string;
  env: string;
  /** Stable pattern-identity hash label (engine `symbolMessageHashField`). */
  hash: string;
}

/**
 * Default label names — what the engine writes when no
 * `metricFieldNames` override is configured. Existing tools call
 * builders without passing a `labels` argument; this preserves their
 * current behavior.
 */
export const DEFAULT_LABELS: LabelNameMap = {
  pattern: 'message_pattern',
  service: 'tenx_user_service',
  severity: 'severity_level',
  env: 'tenx_env',
  hash: 'tenx_hash',
};

/**
 * Legacy alias of `DEFAULT_LABELS` exported for tool code that still
 * references label names directly when building filter records
 * (e.g., `filters[LABELS.service] = args.service`). Phase 4 will swap
 * these references to `env.labels` so per-env renames take effect.
 */
export const LABELS = DEFAULT_LABELS;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Filter value: either a plain string (default exact-match `=`) or an
 * object form `{op, val}` that lets callers emit `!=` selectors: the
 * `kept` cohort needs absence-tolerant `routeState!="drop"` to include
 * legacy series that pre-date the receiver's `routeState` label stamping.
 */
export type FilterValue = string | { op: '=' | '!='; val: string };

function buildSelector(
  filters: Record<string, FilterValue>,
  env: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string') {
      parts.push(`${key}="${escapeLabel(value)}"`);
    } else {
      parts.push(`${key}${value.op}"${escapeLabel(value.val)}"`);
    }
  }
  parts.push(`${labels.env}="${env}"`);
  return parts.join(',');
}

/**
 * Engine route-state action names. Mirrors `Action` in lib/cost.ts but is
 * declared locally so promql.ts stays dependency-free of the cost layer.
 * Per the per-service action-routing feature the receiver now stamps
 * `routeState="<action>"` (drop | offload | tier_down | compact | sample |
 * pass) instead of only `drop`/`pass`.
 */
export type RouteStateAction =
  | 'pass'
  | 'sample'
  | 'compact'
  | 'tier_down'
  | 'offload'
  | 'drop';

/**
 * The cohort a caller wants to scope to. The three legacy tokens keep their
 * exact original semantics; any single `RouteStateAction` selects that
 * action's stamped cohort directly.
 *
 * `kept`    → `routeState!="drop"` (absence-tolerant; matches series with
 *             no `routeState` label AND any non-drop route state).
 * `dropped` → `routeState="drop"` (exact). Alias of passing `'drop'`.
 * `both`    → no selector; caller runs a dual query to recover the
 *             dropped slice for the `dropped_*` envelope fields.
 * `<action>`→ `routeState="<action>"` (exact) for any other action name, so
 *             a caller can scope to e.g. the `offload` or `tier_down` cohort.
 */
export type IncludeCohort = 'kept' | 'dropped' | 'both' | RouteStateAction;

const ROUTE_STATE_ACTIONS: ReadonlySet<string> = new Set<RouteStateAction>([
  'pass',
  'sample',
  'compact',
  'tier_down',
  'offload',
  'drop',
]);

/**
 * Map the user-facing cohort selector to a single `routeState`
 * filter-value (or null for the pre-decision union).
 *
 * Back-compat: `kept` / `dropped` / `both` behave EXACTLY as before. The
 * generalization is that any other single action name yields an exact
 * `routeState="<action>"` selector (run alone, no dual query).
 *
 * `runBoth` tells the executor whether to issue the second
 * `routeState="drop"` query in parallel (only `both` does).
 */
export function includeToSelector(include: IncludeCohort): {
  droppedFilter: FilterValue | null;
  runBoth: boolean;
} {
  if (include === 'kept')
    return { droppedFilter: { op: '!=', val: 'drop' }, runBoth: false };
  if (include === 'dropped')
    return { droppedFilter: { op: '=', val: 'drop' }, runBoth: false };
  if (include === 'both') return { droppedFilter: null, runBoth: true };
  // Any other action name → that action's exact cohort. `drop` already
  // returned above via the `dropped` alias path is unreachable here, but the
  // exact `=` form below is identical for it anyway.
  if (ROUTE_STATE_ACTIONS.has(include))
    return { droppedFilter: { op: '=', val: include }, runBoth: false };
  // Unknown token: fall back to the historical `both` union (no selector,
  // dual query) so a stray value never silently filters everything out.
  return { droppedFilter: null, runBoth: true };
}

/**
 * Convert a (possibly fractional) day offset into a valid Prometheus duration
 * literal of the form `\d+[smhdwy]`. Prometheus rejects fractional units with
 * HTTP 400 — see pattern_diff's 1h window case where offsetDays = 1/24 was
 * being emitted as `offset 0.04166...d`.
 *
 * Picks the LARGEST integer-and-unit representation that exactly represents
 * the value: days when seconds % 86400 === 0, else hours when % 3600 === 0,
 * else minutes when % 60 === 0, else seconds. Returns a leading-space-prefixed
 * ` offset <duration>` string suitable for direct interpolation into a PromQL
 * vector selector, or an empty string when offsetDays is falsy/zero.
 *
 * Throws if the derived expression somehow fails the duration grammar — a
 * defensive guardrail against future arithmetic regressions.
 */
export function formatPromOffset(offsetDays?: number): string {
  if (!offsetDays) return '';
  const offsetSeconds = Math.round(offsetDays * 86400);
  if (offsetSeconds <= 0) return '';
  let offsetExpr: string;
  if (offsetSeconds % 86400 === 0) {
    offsetExpr = `${offsetSeconds / 86400}d`;
  } else if (offsetSeconds % 3600 === 0) {
    offsetExpr = `${offsetSeconds / 3600}h`;
  } else if (offsetSeconds % 60 === 0) {
    offsetExpr = `${offsetSeconds / 60}m`;
  } else {
    offsetExpr = `${offsetSeconds}s`;
  }
  if (!/^\d+[smhdwy]$/.test(offsetExpr)) {
    throw new Error(`Invalid Prometheus offset expression derived: "${offsetExpr}" (from offsetDays=${offsetDays})`);
  }
  return ` offset ${offsetExpr}`;
}

/**
 * Auto-pick a query_range step for a given window so the resulting
 * series carries ~12–30 buckets — enough resolution to see shape, not
 * so many that the renderer chokes or the agent loses signal in noise.
 *
 * Decision table (from /tmp/arc-prose-notes.md Note 5):
 *   - `15m`  → `1m`   (15 buckets)
 *   - `1h`   → `5m`   (12 buckets)
 *   - `6h`   → `15m`  (24 buckets)
 *   - `24h`  → `1h`   (24 buckets)
 *   - `1d`   → `1h`   (24 buckets, alias of 24h)
 *   - `7d`   → `6h`   (28 buckets)
 *   - `30d`  → `1d`   (30 buckets)
 *
 * Unknown windows fall through to `1h` — the historical default that
 * existed before this helper was introduced, so callers that pass
 * something we don't model never see worse behaviour than the prior code.
 *
 * Returned strings are valid `step` values for `trendSchema`'s enum
 * (`'1m' | '5m' | '15m' | '1h' | '6h' | '1d'`) and parseable by
 * `parseStep()` in trend.ts.
 */
export function autoStepForWindow(window: string): '1m' | '5m' | '15m' | '1h' | '6h' | '1d' {
  switch (window) {
    case '15m':
      return '1m';
    case '1h':
      return '5m';
    case '6h':
      return '15m';
    case '24h':
    case '1d':
      return '1h';
    case '7d':
      return '6h';
    case '30d':
      return '1d';
    default:
      return '1h';
  }
}

/** Bytes per pattern for a time window, with optional offset in days. */
export function bytesPerPattern(
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  offsetDays?: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const offset = formatPromOffset(offsetDays);
  const selector = buildSelector(filters, env, labels);
  return `sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (increase(${BYTES_METRIC}{${selector}}[${range}]${offset}))`;
}

/** Scope-total bytes for a time window — no grouping. Used by coverage probes. */
export function totalBytesInScope(
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sum(increase(${BYTES_METRIC}{${selector}}[${range}]))`;
}

/** Event count per pattern for a time window. */
export function eventsPerPattern(
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sum by (${labels.pattern}) (increase(${VOLUME_METRIC}{${selector}}[${range}]))`;
}

/** Event count per service for a specific pattern. */
export function eventsPerServiceForPattern(
  pattern: string,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `sum by (${labels.service}) (increase(${VOLUME_METRIC}{${labels.pattern}="${escapeLabel(pattern)}",${labels.env}="${env}"}[${range}]))`;
}

/** Top N patterns by bytes across all services. */
export function topPatterns(
  env: string,
  range: string,
  limit: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `topk(${limit}, sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (increase(${BYTES_METRIC}{${labels.env}="${env}"}[${range}])))`;
}

/** Bytes per service for a specific pattern. */
export function patternAcrossServices(
  pattern: string,
  env: string,
  range: string,
  offsetDays?: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const offset = formatPromOffset(offsetDays);
  return `sum by (${labels.service}, ${labels.severity}) (increase(${BYTES_METRIC}{${labels.pattern}="${escapeLabel(pattern)}",${labels.env}="${env}"}[${range}]${offset}))`;
}

/** Total bytes for a time window. */
export function totalBytes(
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `sum(increase(${BYTES_METRIC}{${labels.env}="${env}"}[${range}]))`;
}

/** Bytes per service. */
export function bytesPerService(
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `sort_desc(sum by (${labels.service}) (increase(${BYTES_METRIC}{${labels.env}="${env}"}[${range}])))`;
}

/** Bytes per service, honoring the same filter scope as the main query
 * (so a service/severity-filtered top_patterns run shows a rollup over
 * the same subset, not the whole env). Used by the cost-center rollup
 * in log10x_top_patterns — the "where is the money" headline. */
export function bytesPerServiceScoped(
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sort_desc(sum by (${labels.service}) (increase(${BYTES_METRIC}{${selector}}[${range}])))`;
}

/** Bytes per severity. */
export function bytesPerSeverity(
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `sum by (${labels.severity}) (increase(${BYTES_METRIC}{${labels.env}="${env}"}[${range}]))`;
}

/** Pattern bytes over time (for range queries / trends). */
export function patternBytesOverTime(
  pattern: string,
  env: string,
  step: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `sum by (${labels.pattern}) (increase(${BYTES_METRIC}{${labels.env}="${env}",${labels.pattern}="${escapeLabel(pattern)}"}[${step}]))`;
}

/** Probe: does edge env have data? */
export function edgeProbe(labels: LabelNameMap = DEFAULT_LABELS): string {
  return `count(increase(${BYTES_METRIC}{${labels.env}="edge"}[7d]) > 0)`;
}

/** Probe: does edge env have data for specific filters? */
export function edgeProbeFiltered(
  filters: Record<string, FilterValue>,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, 'edge', labels);
  return `count(increase(${BYTES_METRIC}{${selector}}[7d]) > 0)`;
}

/** Pipeline instance count. */
export function pipelineUp(): string {
  return 'count(tenx_pipeline_up)';
}

/** Distinct services with data. */
export function distinctServices(
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `count(count by (${labels.service}) (increase(${BYTES_METRIC}[${range}]) > 0))`;
}

// ── Savings queries — port of Grafana ROI analytics dashboard ──
// See backend/grafana/dashboards/roi_analytics.json. Metric names MATTER.
// The engine emits `app:receiver` and `app:reporter` — see
// modules/apps/{receiver,reporter}/config.yaml.

/** Bytes entering the edge pipeline (reporter + receiver input). */
export function edgeInputBytes(
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `sum(increase(${BYTES_METRIC}{tenx_app=~"reporter|receiver",${labels.env}="edge"}[${range}]))`;
}

/** Bytes emitted from the edge pipeline — receiver output (incl. compact). */
export function edgeEmittedBytes(
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `(sum(increase(${EMITTED_OPT_METRIC}{tenx_app="receiver",${labels.env}="edge"}[${range}])) or vector(0)) + (sum(increase(${EMITTED_METRIC}{tenx_app="receiver",${labels.env}="edge"}[${range}])) or vector(0))`;
}

/** Bytes indexed into the customer's S3 by the Retriever. */
export function retrieverIndexedBytes(
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `sum(increase(${INDEXED_METRIC}{tenx_app="retriever",${labels.env}="cloud"}[${range}]))`;
}

/**
 * Single-day `increase()` chunk for the indexed metric with an optional offset.
 * The indexed metric's ~12k active series makes a single 7d `increase()` blow
 * the server's query budget. Summing N × 1d chunks client-side stays per-chunk
 * small enough to complete.
 */
export function retrieverIndexedBytesChunk(
  offsetDays: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const offset = formatPromOffset(offsetDays);
  return `sum(increase(${INDEXED_METRIC}{tenx_app="retriever",${labels.env}="cloud"}[1d]${offset}))`;
}

/** Bytes actually streamed back out (i.e., served to a SIEM or dashboard). */
export function retrieverStreamedBytes(
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  return `sum(increase(${STREAMED_METRIC}{tenx_app="retriever",${labels.env}="cloud"}[${range}]))`;
}

/** Single-day `increase()` chunk for the streamed metric. Same chunking rationale as retrieverIndexedBytesChunk. */
export function retrieverStreamedBytesChunk(
  offsetDays: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const offset = formatPromOffset(offsetDays);
  return `sum(increase(${STREAMED_METRIC}{tenx_app="retriever",${labels.env}="cloud"}[1d]${offset}))`;
}

// ── Top patterns + list-by-label ──

/** Top N patterns by bytes with service + severity labels retained. */
export function topPatternsFull(
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  limit: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  // Group hash-AGNOSTICALLY. The old code grouped by tenx_hash too, on
  // the assumption it is 1:1 with the pattern. During the tenx_hash
  // rollout that is false: a pattern has both a hashed and an unhashed
  // series, so grouping by hash split one pattern into two rows that
  // competed separately in topk and under-reported the pattern's true
  // cost (e.g. ERROR 202 MB shown vs 374 MB actual; it would not
  // reconcile with event_lookup's hash-agnostic per-severity total).
  // The portable hash is derived locally (conformance-proven
  // tenxHash(pattern)) where needed, not read from the metric label.
  return `topk(${limit}, sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (increase(${BYTES_METRIC}{${selector}}[${range}])))`;
}

/**
 * Recent-activity rate per (pattern, service, severity) over a short window
 * (default 1h). Used as a freshness probe: if a top-N row from a longer
 * window has 0 (or missing) recent rate, it's residue from a closed incident,
 * not an active cost driver.
 */
export function recentRateByPattern(
  filters: Record<string, FilterValue>,
  env: string,
  recentRange: string = '1h',
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (rate(${BYTES_METRIC}{${selector}}[${recentRange}]))`;
}

/**
 * Event count per (pattern, service, severity) over the window. Keyed
 * identically to topPatternsFull so the result joins 1:1 with the byte
 * rows (a pattern can appear under several services/severities; keying
 * on the triple avoids over-counting on a pattern-only join).
 */
export function eventsByPatternFull(
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  offsetDays?: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const offset = formatPromOffset(offsetDays);
  const selector = buildSelector(filters, env, labels);
  return `sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (increase(${VOLUME_METRIC}{${selector}}[${range}]${offset}))`;
}

/**
 * Per-(pattern, service, severity) byte series for a query_range call:
 * each evaluation step is the per-bucket increase, so the matrix is a
 * volume-over-time sparkline source. Keyed identically to
 * topPatternsFull so it joins 1:1 with the byte rows. `stepSeconds` is
 * passed as the increase() inner range AND the query_range step.
 */
export function seriesByPatternFull(
  filters: Record<string, FilterValue>,
  env: string,
  stepSeconds: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (increase(${BYTES_METRIC}{${selector}}[${Math.max(60, Math.floor(stepSeconds))}s]))`;
}

/** Count of distinct patterns in scope (for "N of M patterns shown"). */
export function distinctPatternCount(
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `count(count by (${labels.pattern}) (increase(${BYTES_METRIC}{${selector}}[${range}]) > 0))`;
}

/** Bytes per (pattern, service): which services each pattern impacts. */
export function servicesByPatternFull(
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sum by (${labels.pattern}, ${labels.service}) (increase(${BYTES_METRIC}{${selector}}[${range}]))`;
}

/** Bytes grouped by an arbitrary label, ranked. */
export function bytesByLabel(
  label: string,
  filters: Record<string, FilterValue>,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sort_desc(sum by (${label}) (increase(${BYTES_METRIC}{${selector}}[${range}])))`;
}
