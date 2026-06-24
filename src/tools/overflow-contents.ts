/**
 * log10x_overflow_contents — the contents view of the customer's S3
 * offload bucket.
 *
 * The offload bucket is the OVERFLOW QUEUE, not a search target. The
 * customer wants to REVIEW what's accumulating, not query it.
 *
 * What this tool does:
 *   - Queries `all_events_summaryBytes_total{routeState="drop"}` grouped
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
import { type PrometheusResponse } from '../lib/api.js';
import { iQueryInstant, QUERY_BUDGET } from '../lib/interactive-query.js';
import { LABELS } from '../lib/promql.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { parseTimeframe, fmtBytes } from '../lib/format.js';
import { type NextAction } from '../lib/next-actions.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { newChassisTelemetry, buildChassisEnvelope } from '../lib/chassis-envelope.js';
import { fetchCapCsvTagged, buildCapCsvStatus, type CapCsvStatus } from '../lib/cap-csv-fetch.js';
import { parseCapCsv, buildPatternActionLookup } from '../lib/cap-csv-parser.js';
import type { Action } from '../lib/cost.js';
import { normalizeTimeRange } from '../lib/time-range.js';
import { getRetrieverState, type RetrieverStateSource } from '../lib/retriever-state.js';
import {
  resolveClusterConfig,
  pickActiveOffload,
  detectStaleOffloadEnvVar,
} from '../lib/env-config/resolve-cluster-config.js';

const BYTES_METRIC = 'all_events_summaryBytes_total';
const VOLUME_METRIC = 'all_events_summaryVolume_total';

export const overflowContentsSchema = {
  timeRange: z
    .enum(['15m', '1h', '6h', '24h', '1d', '7d', '30d'])
    .default('30d')
    .describe("Window over which to compute overflow contents. 30d matches the maintenance-loop cadence; sub-30d windows for incident-window probes. '24h' and '1d' are equivalent."),
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
  /**
   * Human-readable pattern name (the engine's symbol-message label).
   * THIS is what renderers lead with — never the hash (hashes are for
   * joins and tool args). Falls back to the hash when the TSDB series
   * lacks the pattern label.
   */
  pattern: string;
  service: string;
  container: string;
  bytes_in_window: number;
  event_count_in_window: number;
  time_window_first: string | null;
  time_window_last: string | null;
  /**
   * How to read time_window_first / time_window_last.
   *   computed        — both are distinct timestamps from the TSDB window.
   *   single_sample   — only one sample point; first and last are the same.
   *   insufficient_samples — no TSDB data was returned for the hash; both null.
   */
  time_window_basis: 'computed' | 'single_sample' | 'insufficient_samples';
  /**
   * Percent change from the first half to the second half of the window.
   * Null when the baseline is too small to produce a meaningful rate.
   */
  growth_rate_pct: number | null;
  /**
   * Describes why growth_rate_pct is null or should be read with caution.
   *   computed            — normal half-window comparison, value is reliable.
   *   new_pattern         — no first-half bytes at all; pattern appeared in the second half.
   *   insufficient_baseline — first-half bytes below the minimum floor; value suppressed.
   */
  growth_rate_basis: 'computed' | 'new_pattern' | 'insufficient_baseline';
  /** Cap-CSV-derived action.
   *
   * This field used to be hardcoded to `'offload'` on every row
   * regardless of cap_csv_status, while the headline simultaneously hedged
   * "offload action split could not be verified". Structured rows lied
   * while the prose hedged. Now:
   *   - When `cap_csv_status.kind === 'loaded'`, the row carries the
   *     action looked up from action-intent.json (canonical) or the
   *     legacy cap-CSV suffix as a fallback.
   *   - Otherwise, action is `null`: the tool cannot prove the row's
   *     disposition. Caller must surface this as unverified.
   * `action_source` names where the action came from so consumers can
   * gate on verification quality.
   */
  action: Action | null;
  action_source: 'action_intent' | 'legacy_cap_csv' | 'unverified';
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
   * Structured status for the cap-CSV / action-intent fetch.
   * kind: 'loaded' means the action-split is applied.
   * Other kinds mean every dropped pattern surfaces with a caveat.
   */
  cap_csv_status: CapCsvStatus;
  patterns: OverflowPattern[];
}

export async function executeOverflowContents(
  args: { timeRange?: string; service?: string; limit?: number; view?: 'summary' },
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  const telemetry = newChassisTelemetry();
  // Fix 83: resolve Retriever state once so the headline accurately reflects
  // whether patterns are "routed to S3" (installed) vs "soft-dropped" (not
  // installed). The source is surfaced in source_disclosure for audit.
  const retrieverState = await getRetrieverState(null);
  const retrieverStateSource: RetrieverStateSource = retrieverState.source;

  // Fix 84 (env-config bridge): resolve the active offload bucket from the
  // cluster env-config doc (k8s ConfigMap → AWS SSM → GCP Secret Manager →
  // Azure App Config → local file). Mirrors retriever-probe / advise-retriever /
  // doctor — without this walk the tool sees a bucket only when the legacy
  // LOG10X_OFFLOAD_BUCKET / LOG10X_STREAMER_BUCKET env vars are set, and
  // wrongly tells users to "install the Retriever" when the bucket IS in fact
  // configured (just declared via env-config rather than env vars).
  const envConfigWarnings: string[] = [];
  let offloadBucket: string | undefined;
  try {
    const resolved = await resolveClusterConfig();
    if (resolved.ok) {
      const active = pickActiveOffload(resolved.config);
      if (active?.bucket) {
        offloadBucket = active.bucket;
        const stale = detectStaleOffloadEnvVar(active.bucket);
        if (stale) envConfigWarnings.push(stale);
      }
      for (const w of resolved.stale_env_var_warnings) {
        if (!envConfigWarnings.includes(w)) envConfigWarnings.push(w);
      }
    }
  } catch {
    // env-config walk threw — degrade silently to env-var fallback below.
  }
  if (!offloadBucket) {
    offloadBucket =
      process.env.LOG10X_OFFLOAD_BUCKET || process.env.LOG10X_STREAMER_BUCKET;
  }

  // Normalise '1d' legacy alias → '24h'.
  const timeRange = normalizeTimeRange(args.timeRange ?? '30d');
  const tf = parseTimeframe(timeRange);
  const metricsEnv = await resolveMetricsEnv(env, QUERY_BUDGET.cheap);
  const limit = args.limit ?? 50;
  const serviceFilter = args.service?.trim() || null;

  // Build the dropped-pattern selector with optional service filter.
  const baseFilters = [`${LABELS.env}="${metricsEnv}"`, `routeState="drop"`];
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
  // Half of the full window, in seconds, always strictly < the full range
  // regardless of unit (m/h/d). PromQL accepts `s` durations. The old
  // string-based halver left minute ranges and 1h unchanged, so the
  // "first half" slice silently became the PRIOR full window.
  const halfSeconds = Math.max(1, Math.floor((tf.days * 86400) / 2));
  const halfLabel = `${halfSeconds}s`;
  const bytesByPatternQ = `sum by (${LABELS.hash}, ${LABELS.pattern}, ${LABELS.service}, ${containerLabel}) (increase(${BYTES_METRIC}{${baseSelector}}[${tf.range}]))`;
  const eventsByPatternQ = `sum by (${LABELS.hash}, ${LABELS.service}) (increase(${VOLUME_METRIC}{${baseSelector}}[${tf.range}]))`;
  const firstHalfBytesQ = `sum by (${LABELS.hash}) (increase(${BYTES_METRIC}{${baseSelector}}[${halfLabel}] offset ${halfLabel}))`;
  // Time-window bookends: evaluate timestamp(metric) at steps across
  // [now-range, now] via a subquery and reduce with min/max_over_time, so
  // we pick the earliest/latest step where each hash's series actually has
  // a sample. This recovers true window bookends; a plain instant
  // timestamp() would collapse to ~eval-time for every series.
  const firstSeenQ = `min by (${LABELS.hash}) (min_over_time(timestamp(${BYTES_METRIC}{${baseSelector}})[${tf.range}:]))`;
  const lastSeenQ = `max by (${LABELS.hash}) (max_over_time(timestamp(${BYTES_METRIC}{${baseSelector}})[${tf.range}:]))`;

  // Each query gets its OWN interactive deadline via iQueryInstant and runs
  // concurrently, so the expensive [tf.range] timestamp subqueries (firstSeen/
  // lastSeen) no longer eat the shared budget and starve the bytes legs. All
  // five are increase()/over-time legs over [tf.range] whose values reach the
  // user (bytes, events, growth baseline, window bookends) → heavy budget.
  // iQuery* swallow timeout/error to null; the existing `&& res.status===...`
  // guards below already map null to the same no-data degradation, so the
  // per-leg .catch wrappers are removed. The cap-CSV fetch is NOT a metrics
  // query — it keeps its own fallback .catch unchanged.
  const [bytesRes, eventsRes, firstHalfRes, firstSeenRes, lastSeenRes, taggedFetch] =
    await Promise.all([
      iQueryInstant(env, bytesByPatternQ, QUERY_BUDGET.heavy),
      iQueryInstant(env, eventsByPatternQ, QUERY_BUDGET.heavy),
      iQueryInstant(env, firstHalfBytesQ, QUERY_BUDGET.heavy),
      iQueryInstant(env, firstSeenQ, QUERY_BUDGET.heavy),
      iQueryInstant(env, lastSeenQ, QUERY_BUDGET.heavy),
      fetchCapCsvTagged(env).catch(() => ({
        csvContent: undefined,
        actionIntent: undefined,
        attempted: !!env.gitops?.repo,
        succeeded: false,
      })),
    ]);

  // action-intent.json is the canonical source for pattern→action.
  // Fall back to legacy cap-CSV action suffixes when action-intent is absent.
  const capCsvContent = taggedFetch.csvContent;
  const actionIntent = taggedFetch.actionIntent;
  const actionIntentLookup: Map<string, Action> = actionIntent?.by_pattern ?? new Map();
  const parsedCsv = capCsvContent ? parseCapCsv(capCsvContent) : null;
  // Whether we have a usable action source for offload filtering.
  const hasActionSource = actionIntentLookup.size > 0 || (parsedCsv !== null && parsedCsv.rows.length > 0);
  const capCsvStatus: CapCsvStatus = buildCapCsvStatus(
    env.gitops?.repo,
    taggedFetch.attempted,
    taggedFetch.succeeded,
    hasActionSource,
  );

  interface Aggr {
    pattern_hash: string;
    pattern: string;
    service: string;
    container: string;
    bytes_in_window: number;
    event_count_in_window: number;
    first_half_bytes: number;
    time_window_first: number | null;
    time_window_last: number | null;
    /** Computed after the timestamp merge. */
    time_window_basis?: 'computed' | 'single_sample' | 'insufficient_samples';
  }
  const byHash = new Map<string, Aggr>();
  const hashContainer = new Map<string, string>();

  if (bytesRes && bytesRes.status === 'success') {
    for (const r of bytesRes.data.result) {
      const hash = r.metric[LABELS.hash] ?? '';
      const patternName = r.metric[LABELS.pattern] ?? '';
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
          pattern: patternName || hash,
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
  // Build hash→timestamp maps first, then apply in a single O(n) pass.
  // The previous O(n*m) nested-loop only set time_window_first on the
  // first matching aggr for each hash; later (service, container) rows
  // for the same hash kept null. Using a map and iterating byHash once
  // sets every row that shares the hash.
  const firstSeenByHash = new Map<string, number>();
  const lastSeenByHash = new Map<string, number>();
  if (firstSeenRes && firstSeenRes.status === 'success') {
    for (const r of firstSeenRes.data.result) {
      const hash = r.metric[LABELS.hash] ?? '';
      const v = parseValue(r);
      if (!hash || v <= 0) continue;
      firstSeenByHash.set(hash, v * 1000);
    }
  }
  if (lastSeenRes && lastSeenRes.status === 'success') {
    for (const r of lastSeenRes.data.result) {
      const hash = r.metric[LABELS.hash] ?? '';
      const v = parseValue(r);
      if (!hash || v <= 0) continue;
      lastSeenByHash.set(hash, v * 1000);
    }
  }
  for (const aggr of byHash.values()) {
    const first = firstSeenByHash.get(aggr.pattern_hash) ?? null;
    const last = lastSeenByHash.get(aggr.pattern_hash) ?? null;
    aggr.time_window_first = first;
    aggr.time_window_last = last;
  }

  // Build the action lookup: action-intent.json first, legacy cap-CSV suffix fallback.
  // Rebuild with the full hashContainer map now that it's populated.
  const legacyActionLookup: Map<string, Action> = parsedCsv
    ? buildPatternActionLookup(parsedCsv, hashContainer)
    : new Map<string, Action>();

  // Filter to the offload action. When no action source: all dropped
  // bytes pass through with `action='offload'` flagged as a caveat in
  // cap_csv_status.
  const filtered: Aggr[] = [];
  for (const aggr of byHash.values()) {
    if (capCsvStatus.kind === 'loaded') {
      // Resolution order: action-intent.json (canonical) → legacy cap-CSV suffix.
      const action =
        actionIntentLookup.get(aggr.pattern_hash) ??
        legacyActionLookup.get(aggr.pattern_hash);
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

  // Output shape is the typed chassis envelope (data.patterns[] + totals).
  // The headline + nextActions below are the only user-visible artefacts;
  // any markdown the agent wants to render is computed downstream from
  // `data`. Tool no longer builds a parallel markdown string.
  const filterLabel = serviceFilter ? ` · service=${serviceFilter}` : '';

  const nextActions: NextAction[] = [];
  if (top[0]) {
    const t = top[0];
    nextActions.push({
      tool: 'log10x_retriever_query',
      args: {
        pattern_hash: t.pattern_hash,
        target: t.service,
        from: `now-${tf.range}`,
        to: 'now',
      },
      reason: `Read the offloaded events for the top pattern from the overflow bucket to inspect what 10x has been holding back.`,
    });
    nextActions.push({
      tool: 'log10x_pattern_trend',
      args: { pattern_hash: t.pattern_hash, include: 'dropped' },
      reason: `Trend the top offload pattern's volume to spot growth or burst behaviour over a longer window.`,
    });
  }

  const data: OverflowContentsSummary = {
    bucket: offloadBucket ?? null,
    time_range: tf.label,
    service_filter: serviceFilter,
    total_bytes_in_window,
    total_event_count_in_window,
    pattern_count: filtered.length,
    truncated,
    cap_csv_status: capCsvStatus,
    patterns: top.map((p) => {
      // time_window_basis: distinguish computed / single_sample / no-data.
      let time_window_basis: OverflowPattern['time_window_basis'];
      if (p.time_window_first === null && p.time_window_last === null) {
        time_window_basis = 'insufficient_samples';
      } else if (p.time_window_first !== null && p.time_window_last !== null &&
                 p.time_window_first === p.time_window_last) {
        time_window_basis = 'single_sample';
      } else {
        time_window_basis = 'computed';
      }

      // growth_rate_basis: suppress artifact values. growthPctWithBasis used
      // to return basis='new_pattern' whenever firstHalfBytes<=0, which fires
      // for pre-existing patterns whose volume was zero in the first half of
      // the window (data-availability artifact, not identity-age signal). When
      // time_window_basis flags degraded coverage, we now override basis to
      // 'insufficient_window_data' instead of confidently asserting identity novelty.
      let { pct: growth_rate_pct, basis: growth_rate_basis } =
        growthPctWithBasis(p.first_half_bytes, p.bytes_in_window);
      if (
        (time_window_basis === 'single_sample' ||
          time_window_basis === 'insufficient_samples') &&
        growth_rate_basis === 'new_pattern'
      ) {
        growth_rate_basis = 'insufficient_baseline';
        growth_rate_pct = null;
      }

      // action used to be hardcoded `'offload' as Action` on every row
      // regardless of cap_csv_status. When status != 'loaded', the row label
      // was unverified but we stamped it anyway, contradicting the headline
      // hedge. Now: only stamp action when cap_csv_status.kind === 'loaded'
      // and the lookup returned a real action; otherwise action=null with
      // action_source='unverified' so consumers can render the unverified state.
      let action: Action | null = null;
      let action_source: 'action_intent' | 'legacy_cap_csv' | 'unverified' = 'unverified';
      if (capCsvStatus.kind === 'loaded') {
        const intentAction = actionIntentLookup.get(p.pattern_hash);
        const legacyAction = legacyActionLookup.get(p.pattern_hash);
        if (intentAction) {
          action = intentAction;
          action_source = 'action_intent';
        } else if (legacyAction) {
          action = legacyAction;
          action_source = 'legacy_cap_csv';
        }
      }

      return {
        pattern_hash: p.pattern_hash,
        pattern: p.pattern,
        service: p.service,
        container: p.container,
        bytes_in_window: p.bytes_in_window,
        event_count_in_window: p.event_count_in_window,
        time_window_first: p.time_window_first ? new Date(p.time_window_first).toISOString() : null,
        time_window_last: p.time_window_last ? new Date(p.time_window_last).toISOString() : null,
        time_window_basis,
        growth_rate_pct,
        growth_rate_basis,
        action,
        action_source,
      };
    }),
  };

  // Headline reflects actual state. The S3 offload bucket is now resolved
  // from the env-config doc (see env-config bridge block above), NOT from
  // env.gitops?.repo (which points at the cap-CSV gitops repo, a different
  // concern). The "no bucket configured → install the Retriever" branch
  // only fires when the env-config walk AND the env-var fallback both came
  // back empty.
  let headline: string;
  if (top.length === 0) {
    headline = `Overflow queue empty over ${tf.label}${filterLabel}.`;
  } else if (capCsvStatus.kind === 'loaded' && retrieverState.installed) {
    // Cap-CSV confirms offload action AND Retriever is reachable — patterns ARE in S3.
    headline = `${filtered.length} overflow pattern${filtered.length !== 1 ? 's' : ''} over ${tf.label}: ${fmtBytes(total_bytes_in_window)} routed to S3${filterLabel}.`;
  } else if (capCsvStatus.kind === 'loaded' && !retrieverState.installed) {
    // Cap-CSV says offload, but Retriever not detected — patterns are configured
    // for offload but the archive may not be receiving them yet.
    headline = `${filtered.length} overflow pattern${filtered.length !== 1 ? 's' : ''} over ${tf.label}: ${fmtBytes(total_bytes_in_window)} configured for S3 offload but Retriever not detected${filterLabel}. Deploy the Retriever to start archiving.`;
  } else if (!offloadBucket) {
    // No cap-CSV AND no offload bucket anywhere (env-config or env vars) —
    // bytes are dropped with no archive to land in.
    headline = `${filtered.length} overflow-eligible pattern${filtered.length !== 1 ? 's' : ''} over ${tf.label}: ${fmtBytes(total_bytes_in_window)} currently soft-dropped — no S3 offload bucket is configured${filterLabel}. Install the Retriever to start archiving these patterns.`;
  } else {
    // Bucket IS configured (via env-config or env-var) but cap-CSV split
    // couldn't be loaded — bytes likely route to S3 but the offload-vs-
    // hard-drop split is unverified.
    headline = `${filtered.length} overflow-eligible pattern${filtered.length !== 1 ? 's' : ''} over ${tf.label}: ${fmtBytes(total_bytes_in_window)} routing configured to ${offloadBucket} but offload action split could not be verified — check log10x_doctor${filterLabel}.`;
  }

  // Window-coverage caveat. When most or all surfaced rows have degraded
  // time_window_basis (single_sample or insufficient_samples on a multi-day
  // window), the headline numbers imply more confidence than the underlying
  // samples justify. Surface this as a structured warning so the CFO/agent
  // doesn't treat bytes_in_window as a stable 30d estimate when it's actually
  // built from a one-time integration over very sparse points.
  const allWarnings = [...envConfigWarnings];
  const totalUsable = data.patterns.length;
  if (totalUsable > 0) {
    const singleSample = data.patterns.filter(
      (p) => p.time_window_basis === 'single_sample'
    ).length;
    const insufficient = data.patterns.filter(
      (p) => p.time_window_basis === 'insufficient_samples'
    ).length;
    const computed = totalUsable - singleSample - insufficient;
    if (computed === 0 && (singleSample + insufficient) > 0) {
      allWarnings.push(
        `Window coverage degraded: 0 of ${totalUsable} surfaced patterns have multi-sample basis on ${tf.label} (${singleSample} single_sample + ${insufficient} insufficient_samples). bytes_in_window and growth_rate_pct are derived from sparse points; treat the headline total as an upper bound, not a stable estimate.`
      );
    } else if (computed / totalUsable < 0.5) {
      allWarnings.push(
        `Window coverage partial: only ${computed} of ${totalUsable} surfaced patterns have multi-sample basis on ${tf.label} (${singleSample} single_sample + ${insufficient} insufficient_samples). Patterns with degraded basis carry their data-availability flag on time_window_basis.`
      );
    }
  }

  return buildChassisEnvelope({
    tool: 'log10x_overflow_contents',
    view: 'summary',
    headline,
    status: top.length > 0 ? 'success' : 'no_signal',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {
      bytes_source: 'tsdb',
      retriever_state_source: retrieverStateSource,
    },
    scope: {
      window: tf.label,
      window_basis: 'explicit',
      candidates_count: filtered.length,
      candidates_usable: top.length,
    },
    payload: data,
    human_summary: headline,
    actions: nextActions.map((a) => ({ tool: a.tool, args: a.args, reason: a.reason })),
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    telemetry,
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
/**
 * Minimum first-half byte floor below which the growth rate is unreliable.
 * Near-zero baselines produce huge percentage blowups from tiny absolute
 * changes. Floor at 1 KB — anything below that is rounding noise, not signal.
 */
const GROWTH_RATE_MIN_BASELINE_BYTES = 1024;

interface GrowthResult {
  pct: number | null;
  basis: OverflowPattern['growth_rate_basis'];
}

function growthPctWithBasis(firstHalfBytes: number, fullBytes: number): GrowthResult {
  if (firstHalfBytes <= 0 && fullBytes <= 0) {
    return { pct: null, basis: 'insufficient_baseline' };
  }
  const secondHalfBytes = Math.max(0, fullBytes - firstHalfBytes);
  if (firstHalfBytes <= 0) {
    // Brand-new pattern — appeared in the second half only.
    return { pct: null, basis: 'new_pattern' };
  }
  if (firstHalfBytes < GROWTH_RATE_MIN_BASELINE_BYTES) {
    // Near-zero baseline produces misleading large percentages from tiny changes.
    return { pct: null, basis: 'insufficient_baseline' };
  }
  const computed = ((secondHalfBytes - firstHalfBytes) / firstHalfBytes) * 100;
  return { pct: Math.round(computed * 10) / 10, basis: 'computed' };
}

void ({} as PrometheusResponse);
