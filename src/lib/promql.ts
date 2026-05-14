/**
 * PromQL query builders.
 *
 * Generates the PromQL queries used by each tool, matching the patterns
 * in SlackPatternService.java.
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

function buildSelector(
  filters: Record<string, string>,
  env: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    parts.push(`${key}="${escapeLabel(value)}"`);
  }
  parts.push(`${labels.env}="${env}"`);
  return parts.join(',');
}

/** Bytes per pattern for a time window, with optional offset in days. */
export function bytesPerPattern(
  filters: Record<string, string>,
  env: string,
  range: string,
  offsetDays?: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const offset = offsetDays ? ` offset ${offsetDays}d` : '';
  const selector = buildSelector(filters, env, labels);
  return `sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (increase(${BYTES_METRIC}{${selector}}[${range}]${offset}))`;
}

/** Scope-total bytes for a time window — no grouping. Used by coverage probes. */
export function totalBytesInScope(
  filters: Record<string, string>,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sum(increase(${BYTES_METRIC}{${selector}}[${range}]))`;
}

/** Event count per pattern for a time window. */
export function eventsPerPattern(
  filters: Record<string, string>,
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
  const offset = offsetDays ? ` offset ${offsetDays}d` : '';
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
  filters: Record<string, string>,
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
  const offset = offsetDays > 0 ? ` offset ${offsetDays}d` : '';
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
  const offset = offsetDays > 0 ? ` offset ${offsetDays}d` : '';
  return `sum(increase(${STREAMED_METRIC}{tenx_app="retriever",${labels.env}="cloud"}[1d]${offset}))`;
}

// ── Top patterns + list-by-label ──

/** Top N patterns by bytes with service + severity labels retained. */
export function topPatternsFull(
  filters: Record<string, string>,
  env: string,
  range: string,
  limit: number,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `topk(${limit}, sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (increase(${BYTES_METRIC}{${selector}}[${range}])))`;
}

/**
 * Recent-activity rate per (pattern, service, severity) over a short window
 * (default 1h). Used as a freshness probe: if a top-N row from a longer
 * window has 0 (or missing) recent rate, it's residue from a closed incident,
 * not an active cost driver.
 */
export function recentRateByPattern(
  filters: Record<string, string>,
  env: string,
  recentRange: string = '1h',
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sum by (${labels.pattern}, ${labels.service}, ${labels.severity}) (rate(${BYTES_METRIC}{${selector}}[${recentRange}]))`;
}

/** Bytes grouped by an arbitrary label, ranked. */
export function bytesByLabel(
  label: string,
  filters: Record<string, string>,
  env: string,
  range: string,
  labels: LabelNameMap = DEFAULT_LABELS
): string {
  const selector = buildSelector(filters, env, labels);
  return `sort_desc(sum by (${label}) (increase(${BYTES_METRIC}{${selector}}[${range}])))`;
}
