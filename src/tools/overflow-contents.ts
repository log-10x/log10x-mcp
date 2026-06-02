/**
 * log10x_overflow_contents — the contents view of the customer's S3
 * offload bucket.
 *
 * The cost-cutting-product-shape.md "Phase 5: Maintain" section calls
 * for a parity workflow with Datadog "Logs Without Limits" and CloudWatch
 * Logs IA: the cheap tier is the OVERFLOW QUEUE, not a search target.
 * The customer wants to REVIEW what's accumulating, not query it.
 *
 * What this tool does:
 *   - Queries `all_events_summaryBytes_total{isDropped="true"}` grouped
 *     by (pattern_hash, service, k8s_container) over the requested
 *     time window.
 *   - Joins the result to the cap-CSV the MCP wrote (via
 *     `log10x_configure_engine`) so ONLY patterns whose action is
 *     `offload` surface. Patterns whose action is `drop` are NOT in S3
 *     and don't belong in the contents view; `compact` and `tier_down`
 *     are routed in-engine / to the SIEM cheap tier and also aren't in
 *     the offload bucket.
 *   - Computes growth rate per pattern as the percent change between
 *     the FIRST half and the SECOND half of the window (simple,
 *     deterministic; matches the shape doc's
 *     `growth_rate_pct_per_week` field when window=30d).
 *
 * What this tool does NOT do:
 *   - Scan S3. The contents view is a TSDB query, not a bloom-index
 *     scan — see metric_surface_owns_overflow_visibility.md.
 *     `log10x_retriever_query` is the only tool that touches the
 *     archive; this one points to it as the rehydration path.
 *   - Estimate dollars. The whole point of offload is that overflow
 *     bytes have negligible storage cost; the dollar number is
 *     misleading if framed as "savings" without the SIEM-tier
 *     comparison `log10x_savings` does.
 *
 * When no cap-CSV is fetchable: the tool degrades to "all dropped
 * bytes" with a caveat — the agent sees `cap_csv_status` and can warn
 * the user that the offload-vs-drop split is unverified.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant, type PrometheusResponse } from '../lib/api.js';
import { LABELS } from '../lib/promql.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { parseTimeframe, fmtBytes } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import { fetchCapCsvForEnv } from '../lib/cap-csv-fetch.js';
import { parseCapCsv, buildPatternActionLookup } from '../lib/cap-csv-parser.js';
import type { Action } from '../lib/cost.js';

const BYTES_METRIC = 'all_events_summaryBytes_total';
const VOLUME_METRIC = 'all_events_summaryVolume_total';

export const overflowContentsSchema = {
  timeRange: z
    .enum(['1d', '7d', '30d'])
    .default('30d')
    .describe('Window over which to compute overflow contents. 30d matches the maintenance-loop cadence; sub-30d windows for incident-window probes.'),
  service: z
    .string()
    .optional()
    .describe('Filter to a single service. Omit for the full overflow queue across every service that routes to S3.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .optional()
    .describe('Cap on the number of per-pattern rows returned. Total bytes always reflect the full overflow, even when rows are truncated.'),
  environment: z.string().optional().describe('Environment nickname'),
  view: z
    .literal('summary')
    .default('summary')
    .optional()
    .describe('Output format. Always "summary" — the typed envelope (data.patterns[], data.totals).'),
};

interface OverflowPattern {
  pattern_hash: string;
  service: string;
  container: string;
  bytes_in_window: number;
  event_count_in_window: number;
  time_window_first: string | null;
  time_window_last: string | null;
  growth_rate_pct: number;
  /** Cap-CSV-derived action. Always `offload` in the returned list (filter); included for envelope-uniformity. */
  action: Action;
}

interface OverflowContentsSummary {
  bucket: string | null;
  time_range: string;
  service_filter: string | null;
  /** Sum of bytes_in_window across all offload-action patterns (NOT truncated by `limit`). */
  total_bytes_in_window: number;
  /** Sum of event_count_in_window across all offload-action patterns. */
  total_event_count_in_window: number;
  /** Number of distinct (pattern_hash) values in the overflow set. */
  pattern_count: number;
  /** True when the result was truncated by `limit`. */
  truncated: boolean;
  /**
   * Whether the cap-CSV join completed. `applied` — patterns filtered to
   * the offload action. `unavailable` / `not_attempted` — every dropped
   * pattern surfaces as the offload set with a caveat.
   */
  cap_csv_status: 'applied' | 'unavailable' | 'not_attempted';
  patterns: OverflowPattern[];
}

export async function executeOverflowContents(
  args: { timeRange?: string; service?: string; limit?: number; view?: 'summary' },
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  const telemetry = newTelemetry();
  const timeRange = args.timeRange ?? '30d';
  const tf = parseTimeframe(timeRange);
  const metricsEnv = await resolveMetricsEnv(env);
  const limit = args.limit ?? 50;
  const serviceFilter = args.service?.trim() || null;

  // Build the dropped-pattern selector with optional service filter.
  const baseFilters = [`${LABELS.env}="${metricsEnv}"`, `isDropped="true"`];
  if (serviceFilter) {
    baseFilters.push(`${LABELS.service}="${escapeLabel(serviceFilter)}"`);
  }
  const baseSelector = baseFilters.join(',');
  const containerLabel = 'k8s_container';

  // Three queries in parallel:
  //   1. Total bytes per (hash, service, container) over the FULL window.
  //   2. Event count per (hash, service) over the FULL window.
  //   3. Bytes per (hash) over the first half of the window — used as
  //      the growth baseline against the full-window bytes for the
  //      growth_rate_pct calc.
  const halfLabel = halfWindowLabel(tf.range);
  const bytesByPatternQ = `sum by (${LABELS.hash}, ${LABELS.service}, ${containerLabel}) (increase(${BYTES_METRIC}{${baseSelector}}[${tf.range}]))`;
  const eventsByPatternQ = `sum by (${LABELS.hash}, ${LABELS.service}) (increase(${VOLUME_METRIC}{${baseSelector}}[${tf.range}]))`;
  const firstHalfBytesQ = `sum by (${LABELS.hash}) (increase(${BYTES_METRIC}{${baseSelector}}[${halfLabel}] offset ${halfLabel}))`;
  // Time-window bookends use the timestamp() trick on the series' last
  // sample. min/max over the series within the window.
  const firstSeenQ = `min by (${LABELS.hash}) (timestamp(${BYTES_METRIC}{${baseSelector}}))`;
  const lastSeenQ = `max by (${LABELS.hash}) (timestamp(${BYTES_METRIC}{${baseSelector}}))`;

  const [bytesRes, eventsRes, firstHalfRes, firstSeenRes, lastSeenRes, capCsvContent] =
    await Promise.all([
      queryInstant(env, bytesByPatternQ).catch(() => null),
      queryInstant(env, eventsByPatternQ).catch(() => null),
      queryInstant(env, firstHalfBytesQ).catch(() => null),
      queryInstant(env, firstSeenQ).catch(() => null),
      queryInstant(env, lastSeenQ).catch(() => null),
      fetchCapCsvForEnv(env).catch(() => undefined),
    ]);

  const parsedCsv = capCsvContent ? parseCapCsv(capCsvContent) : null;
  const capCsvStatus: OverflowContentsSummary['cap_csv_status'] = !env.gitops?.repo
    ? 'not_attempted'
    : parsedCsv && parsedCsv.rows.length > 0
      ? 'applied'
      : 'unavailable';

  interface Aggr {
    pattern_hash: string;
    service: string;
    container: string;
    bytes_in_window: number;
    event_count_in_window: number;
    first_half_bytes: number;
    time_window_first: number | null;
    time_window_last: number | null;
  }
  const byHash = new Map<string, Aggr>();
  const hashContainer = new Map<string, string>();

  if (bytesRes && bytesRes.status === 'success') {
    for (const r of bytesRes.data.result) {
      const hash = r.metric[LABELS.hash] ?? '';
      const service = r.metric[LABELS.service] ?? '(unknown)';
      const container = r.metric[containerLabel] ?? '';
      const v = parseValue(r);
      if (!hash || v <= 0) continue;
      // A (hash, service, container) triple is the join unit; a pattern
      // that fires in two containers gets two entries. We rank rows
      // independently so the contents view shows where the volume came
      // from, not a single rolled-up pattern.
      const key = `${hash}|${service}|${container}`;
      const existing = byHash.get(key);
      if (existing) {
        existing.bytes_in_window += v;
      } else {
        byHash.set(key, {
          pattern_hash: hash,
          service,
          container,
          bytes_in_window: v,
          event_count_in_window: 0,
          first_half_bytes: 0,
          time_window_first: null,
          time_window_last: null,
        });
      }
      if (container) hashContainer.set(hash, container);
    }
  }
  if (eventsRes && eventsRes.status === 'success') {
    // Events are keyed by (hash, service) — distribute evenly across the
    // matching (hash, service, container) rows when there are multiple
    // containers (rare; events label set differs from bytes label set
    // by container in practice).
    const eventsByHashSvc = new Map<string, number>();
    for (const r of eventsRes.data.result) {
      const hash = r.metric[LABELS.hash] ?? '';
      const service = r.metric[LABELS.service] ?? '(unknown)';
      if (!hash) continue;
      const v = parseValue(r);
      eventsByHashSvc.set(`${hash}|${service}`, (eventsByHashSvc.get(`${hash}|${service}`) ?? 0) + v);
    }
    // For each aggregated row, allocate events by bytes share among the
    // matching containers. Stable and consistent with the bytes split.
    const totalByHashSvc = new Map<string, number>();
    for (const aggr of byHash.values()) {
      const k = `${aggr.pattern_hash}|${aggr.service}`;
      totalByHashSvc.set(k, (totalByHashSvc.get(k) ?? 0) + aggr.bytes_in_window);
    }
    for (const aggr of byHash.values()) {
      const k = `${aggr.pattern_hash}|${aggr.service}`;
      const tot = totalByHashSvc.get(k) ?? 0;
      const evt = eventsByHashSvc.get(k) ?? 0;
      aggr.event_count_in_window = tot > 0 ? Math.round(evt * (aggr.bytes_in_window / tot)) : 0;
    }
  }
  if (firstHalfRes && firstHalfRes.status === 'success') {
    const firstHalfByHash = new Map<string, number>();
    for (const r of firstHalfRes.data.result) {
      const hash = r.metric[LABELS.hash] ?? '';
      if (!hash) continue;
      firstHalfByHash.set(hash, (firstHalfByHash.get(hash) ?? 0) + parseValue(r));
    }
    // Distribute the first-half (hash-keyed) bytes proportionally to
    // each row's share of the full-window bytes for that hash.
    const fullByHash = new Map<string, number>();
    for (const aggr of byHash.values()) {
      fullByHash.set(aggr.pattern_hash, (fullByHash.get(aggr.pattern_hash) ?? 0) + aggr.bytes_in_window);
    }
    for (const aggr of byHash.values()) {
      const full = fullByHash.get(aggr.pattern_hash) ?? 0;
      const firstHalf = firstHalfByHash.get(aggr.pattern_hash) ?? 0;
      aggr.first_half_bytes = full > 0 ? firstHalf * (aggr.bytes_in_window / full) : 0;
    }
  }
  if (firstSeenRes && firstSeenRes.status === 'success') {
    for (const r of firstSeenRes.data.result) {
      const hash = r.metric[LABELS.hash] ?? '';
      const v = parseValue(r);
      if (!hash || v <= 0) continue;
      for (const aggr of byHash.values()) {
        if (aggr.pattern_hash === hash) {
          aggr.time_window_first = v * 1000;
        }
      }
    }
  }
  if (lastSeenRes && lastSeenRes.status === 'success') {
    for (const r of lastSeenRes.data.result) {
      const hash = r.metric[LABELS.hash] ?? '';
      const v = parseValue(r);
      if (!hash || v <= 0) continue;
      for (const aggr of byHash.values()) {
        if (aggr.pattern_hash === hash) {
          aggr.time_window_last = v * 1000;
        }
      }
    }
  }

  // Filter to the offload action via cap-CSV. When no CSV: all dropped
  // bytes pass through with `action='offload'` flagged as a caveat in
  // cap_csv_status.
  const actionLookup = parsedCsv
    ? buildPatternActionLookup(parsedCsv, hashContainer)
    : new Map<string, Action>();
  const filtered: Aggr[] = [];
  for (const aggr of byHash.values()) {
    if (capCsvStatus === 'applied') {
      const action = actionLookup.get(aggr.pattern_hash);
      // Only `offload` patterns surface. `drop` is hard-killed (not in
      // S3). `compact` / `tier_down` route elsewhere. Missing entries
      // are treated as "not offload" — we'd rather under-report than
      // surface a `drop` pattern as offload content.
      if (action !== 'offload') continue;
    }
    filtered.push(aggr);
  }
  filtered.sort((a, b) => b.bytes_in_window - a.bytes_in_window);

  const total_bytes_in_window = filtered.reduce((s, p) => s + p.bytes_in_window, 0);
  const total_event_count_in_window = filtered.reduce((s, p) => s + p.event_count_in_window, 0);
  const truncated = filtered.length > limit;
  const top = filtered.slice(0, limit);

  // Build the user-visible markdown.
  const lines: string[] = [];
  const filterLabel = serviceFilter ? ` · service=${serviceFilter}` : '';
  lines.push(`Overflow contents (${tf.label}${filterLabel})`);
  lines.push('(patterns whose action is `offload` per the cap-CSV — these are in the customer-owned S3 archive, not the SIEM)');
  lines.push('');

  if (top.length === 0) {
    if (capCsvStatus === 'applied') {
      lines.push('  No patterns currently routed to offload over the window.');
    } else if (capCsvStatus === 'unavailable') {
      lines.push('  No dropped patterns observed over the window. (cap-CSV fetch failed — could not filter to offload only.)');
    } else {
      lines.push('  No dropped patterns observed over the window. (No gitops repo configured — could not filter to offload only.)');
    }
  } else {
    for (const p of top) {
      const hashCol = p.pattern_hash.length > 16 ? `${p.pattern_hash.slice(0, 14)}..` : p.pattern_hash.padEnd(16);
      const svc = p.service.padEnd(20).slice(0, 20);
      const ctn = (p.container || '-').padEnd(16).slice(0, 16);
      const bytes = fmtBytes(p.bytes_in_window).padStart(10);
      const evts = String(p.event_count_in_window).padStart(10);
      const growth = renderGrowth(p.first_half_bytes, p.bytes_in_window);
      lines.push(`  ${hashCol}  ${svc}  ${ctn}  ${bytes}  ${evts}  ${growth.padStart(7)}`);
    }
    lines.push('');
    lines.push(
      `  ${filtered.length} pattern${filtered.length !== 1 ? 's' : ''} in overflow · ` +
        `${fmtBytes(total_bytes_in_window)} total · ` +
        `${total_event_count_in_window.toLocaleString()} events`,
    );
    if (truncated) {
      lines.push(`  (truncated to top ${limit}; pass limit=${Math.min(filtered.length, 500)} for the full list)`);
    }
  }

  if (capCsvStatus !== 'applied' && top.length > 0) {
    lines.push('');
    lines.push(
      capCsvStatus === 'unavailable'
        ? '  Caveat: cap-CSV fetch failed; all dropped patterns shown (drop vs offload split unverified).'
        : '  Caveat: no gitops repo configured; all dropped patterns shown (drop vs offload split unverified).',
    );
  }

  const nextActions: NextAction[] = [];
  if (top[0]) {
    const t = top[0];
    nextActions.push({
      tool: 'log10x_retriever_query',
      args: {
        pattern_hash: t.pattern_hash,
        service: t.service,
        time_window: tf.label,
      },
      reason: `Rehydrate the top offload pattern back into the SIEM via the retriever — needed for incident / audit / debug.`,
    });
    nextActions.push({
      tool: 'log10x_pattern_trend',
      args: { pattern_hash: t.pattern_hash, include: 'dropped' },
      reason: `Trend the top offload pattern's volume to spot growth or burst behaviour over a longer window.`,
    });
    lines.push('');
    lines.push(
      agentOnly(
        `Suggested next calls: ` +
          `Rehydrate a specific overflow pattern — log10x_retriever_query({ pattern_hash: '${t.pattern_hash}', service: '${t.service}' }). ` +
          `Trend its volume — log10x_pattern_trend({ pattern_hash: '${t.pattern_hash}', include: 'dropped' }).`,
      ),
    );
  }
  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);

  const data: OverflowContentsSummary = {
    bucket: env.gitops?.repo ?? null,
    time_range: tf.label,
    service_filter: serviceFilter,
    total_bytes_in_window,
    total_event_count_in_window,
    pattern_count: filtered.length,
    truncated,
    cap_csv_status: capCsvStatus,
    patterns: top.map((p) => ({
      pattern_hash: p.pattern_hash,
      service: p.service,
      container: p.container,
      bytes_in_window: p.bytes_in_window,
      event_count_in_window: p.event_count_in_window,
      time_window_first: p.time_window_first ? new Date(p.time_window_first).toISOString() : null,
      time_window_last: p.time_window_last ? new Date(p.time_window_last).toISOString() : null,
      growth_rate_pct: growthPct(p.first_half_bytes, p.bytes_in_window),
      action: 'offload',
    })),
  };

  const headline =
    top.length === 0
      ? `Overflow queue empty over ${tf.label}${filterLabel}.`
      : `${filtered.length} overflow pattern${filtered.length !== 1 ? 's' : ''} over ${tf.label}: ${fmtBytes(total_bytes_in_window)} routed to S3${filterLabel}.`;

  return buildEnvelope({
    tool: 'log10x_overflow_contents',
    view: 'summary',
    summary: { headline },
    data: { ...data, ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }) },
    actions: nextActions.map((a) => ({ tool: a.tool, args: a.args, reason: a.reason })),
  });
}

// ── helpers ──────────────────────────────────────────────────────────

function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseValue(r: { value?: [number, string] }): number {
  if (!r.value) return 0;
  const n = parseFloat(r.value[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Half-window label for the growth-rate calculation.
 *
 *   30d  → 15d (`offset 15d` covers the first-half slice)
 *   7d   → 84h  (≈ 3.5d expressed in hours; PromQL accepts h)
 *   1d   → 12h
 */
function halfWindowLabel(range: string): string {
  const m = range.match(/^(\d+)([dh])$/);
  if (!m) return range;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === 'd') {
    return n >= 2 ? `${Math.floor(n / 2)}d` : `${Math.round((n * 24) / 2)}h`;
  }
  return `${Math.max(1, Math.round(n / 2))}h`;
}

function growthPct(firstHalfBytes: number, fullBytes: number): number {
  if (firstHalfBytes <= 0 && fullBytes <= 0) return 0;
  const secondHalfBytes = Math.max(0, fullBytes - firstHalfBytes);
  if (firstHalfBytes <= 0) {
    // Brand-new pattern (zero first-half) — surface a sentinel rather
    // than divide-by-zero. +Infinity is misleading; we cap at 999 so
    // the column stays sortable and the agent can still flag "new" via
    // the time_window_first field.
    return secondHalfBytes > 0 ? 999 : 0;
  }
  return ((secondHalfBytes - firstHalfBytes) / firstHalfBytes) * 100;
}

function renderGrowth(firstHalfBytes: number, fullBytes: number): string {
  const pct = growthPct(firstHalfBytes, fullBytes);
  if (!Number.isFinite(pct)) return '-';
  if (pct >= 999) return 'NEW';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Math.round(pct)}%`;
}

void ({} as PrometheusResponse);
