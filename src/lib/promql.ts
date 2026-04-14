/**
 * PromQL query builders.
 *
 * Generates the PromQL queries used by each tool, matching the patterns
 * in SlackPatternService.java.
 */

const BYTES_METRIC = 'all_events_summaryBytes_total';
const VOLUME_METRIC = 'all_events_summaryVolume_total';
const EMITTED_METRIC = 'emitted_events_summaryBytes_total';
const EMITTED_OPT_METRIC = 'emitted_events_summaryOptimizedBytes_total';
const INDEXED_METRIC = 'indexed_events_summaryBytes_total';
const STREAMED_METRIC = 'streamed_events_summaryBytes_total';

export const LABELS = {
  pattern: 'message_pattern',
  service: 'tenx_user_service',
  severity: 'severity_level',
  env: 'tenx_env',
} as const;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildSelector(filters: Record<string, string>, env: string): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filters)) {
    parts.push(`${key}="${escapeLabel(value)}"`);
  }
  parts.push(`${LABELS.env}="${env}"`);
  return parts.join(',');
}

/** Bytes per pattern for a time window, with optional offset in days. */
export function bytesPerPattern(
  filters: Record<string, string>,
  env: string,
  range: string,
  offsetDays?: number
): string {
  const offset = offsetDays ? ` offset ${offsetDays}d` : '';
  const selector = buildSelector(filters, env);
  return `sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (increase(${BYTES_METRIC}{${selector}}[${range}]${offset}))`;
}

/** Event count per pattern for a time window. */
export function eventsPerPattern(
  filters: Record<string, string>,
  env: string,
  range: string
): string {
  const selector = buildSelector(filters, env);
  return `sum by (${LABELS.pattern}) (increase(${VOLUME_METRIC}{${selector}}[${range}]))`;
}

/** Event count per service for a specific pattern. */
export function eventsPerServiceForPattern(
  pattern: string,
  env: string,
  range: string
): string {
  return `sum by (${LABELS.service}) (increase(${VOLUME_METRIC}{${LABELS.pattern}="${escapeLabel(pattern)}",${LABELS.env}="${env}"}[${range}]))`;
}

/** Top N patterns by bytes across all services. */
export function topPatterns(env: string, range: string, limit: number): string {
  return `topk(${limit}, sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (increase(${BYTES_METRIC}{${LABELS.env}="${env}"}[${range}])))`;
}

/** Bytes per service for a specific pattern. */
export function patternAcrossServices(
  pattern: string,
  env: string,
  range: string,
  offsetDays?: number
): string {
  const offset = offsetDays ? ` offset ${offsetDays}d` : '';
  return `sum by (${LABELS.service}, ${LABELS.severity}) (increase(${BYTES_METRIC}{${LABELS.pattern}="${escapeLabel(pattern)}",${LABELS.env}="${env}"}[${range}]${offset}))`;
}

/** Total bytes for a time window. */
export function totalBytes(env: string, range: string): string {
  return `sum(increase(${BYTES_METRIC}{${LABELS.env}="${env}"}[${range}]))`;
}

/** Bytes per service. */
export function bytesPerService(env: string, range: string): string {
  return `sort_desc(sum by (${LABELS.service}) (increase(${BYTES_METRIC}{${LABELS.env}="${env}"}[${range}])))`;
}

/** Bytes per severity. */
export function bytesPerSeverity(env: string, range: string): string {
  return `sum by (${LABELS.severity}) (increase(${BYTES_METRIC}{${LABELS.env}="${env}"}[${range}]))`;
}

/** Pattern bytes over time (for range queries / trends). */
export function patternBytesOverTime(
  pattern: string,
  env: string,
  step: string
): string {
  return `sum by (${LABELS.pattern}) (increase(${BYTES_METRIC}{${LABELS.env}="${env}",${LABELS.pattern}="${escapeLabel(pattern)}"}[${step}]))`;
}

/** Probe: does edge env have data? */
export function edgeProbe(): string {
  return `count(increase(${BYTES_METRIC}{${LABELS.env}="edge"}[7d]) > 0)`;
}

/** Probe: does edge env have data for specific filters? */
export function edgeProbeFiltered(filters: Record<string, string>): string {
  const selector = buildSelector(filters, 'edge');
  return `count(increase(${BYTES_METRIC}{${selector}}[7d]) > 0)`;
}

/** Pipeline instance count. */
export function pipelineUp(): string {
  return 'count(tenx_pipeline_up)';
}

/** Distinct services with data. */
export function distinctServices(range: string): string {
  return `count(count by (${LABELS.service}) (increase(${BYTES_METRIC}[${range}]) > 0))`;
}

// ── Savings queries — port of Grafana ROI analytics dashboard ──
// See backend/grafana/dashboards/roi_analytics.json. Metric names MATTER.

/** Bytes entering the edge pipeline (reporter + regulator + optimizer input). */
export function edgeInputBytes(range: string): string {
  return `sum(increase(${BYTES_METRIC}{tenx_app=~"reporter|regulator|optimizer",${LABELS.env}="edge"}[${range}]))`;
}

/** Bytes emitted from the edge pipeline — regulator output + optimizer compact output. */
export function edgeEmittedBytes(range: string): string {
  return `(sum(increase(${EMITTED_OPT_METRIC}{tenx_app="optimizer",${LABELS.env}="edge"}[${range}])) or vector(0)) + (sum(increase(${EMITTED_METRIC}{tenx_app="regulator",${LABELS.env}="edge"}[${range}])) or vector(0))`;
}

/** Bytes indexed into the customer's S3 by the Storage Streamer. */
export function streamerIndexedBytes(range: string): string {
  return `sum(increase(${INDEXED_METRIC}{tenx_app="streamer",${LABELS.env}="cloud"}[${range}]))`;
}

/** Bytes actually streamed back out (i.e., served to a SIEM or dashboard). */
export function streamerStreamedBytes(range: string): string {
  return `sum(increase(${STREAMED_METRIC}{tenx_app="streamer",${LABELS.env}="cloud"}[${range}]))`;
}

// ── Top patterns + list-by-label ──

/** Top N patterns by bytes with service + severity labels retained. */
export function topPatternsFull(
  filters: Record<string, string>,
  env: string,
  range: string,
  limit: number
): string {
  const selector = buildSelector(filters, env);
  return `topk(${limit}, sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (increase(${BYTES_METRIC}{${selector}}[${range}])))`;
}

/** Bytes grouped by an arbitrary label, ranked. */
export function bytesByLabel(
  label: string,
  filters: Record<string, string>,
  env: string,
  range: string
): string {
  const selector = buildSelector(filters, env);
  return `sort_desc(sum by (${label}) (increase(${BYTES_METRIC}{${selector}}[${range}])))`;
}
