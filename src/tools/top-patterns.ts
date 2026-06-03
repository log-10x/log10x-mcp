/**
 * log10x_top_patterns — v2 layout.
 *
 * Hero MCP tool: "show me what's expensive and help me decide what to
 * drop, mute, or compact." Three pillars over the legacy implementation:
 *   1. Identity-first table + per-pattern cards
 *   2. Inline cost trend chart (24h) for the top-3 + NEW rows
 *   3. Field-variation block from real SIEM events (not slot-cardinality
 *      heuristics) — answers "what does this hash actually group?"
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant, queryRange } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS, includeToSelector, type FilterValue } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue, buildDisclosedDollarValue, type DisclosedDollarValue } from '../lib/cost.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { parseTimeframe, fmtDisclosedDollar, fmtBytes as fmtBytesShared } from '../lib/format.js';
import { type NextAction } from '../lib/next-actions.js';
import { fetchEventsByHashes } from '../lib/siem/sample.js';
import { tenxHash } from '../lib/pattern-hash.js';
import { fetchFirstSeenBatch } from '../lib/first-seen.js';
import { fieldVariation } from '../lib/field-variation.js';
import { type TopPatternRow } from '../lib/top-patterns-render.js';
import { detectIncidents, type IncidentInput } from '../lib/detectors/incident-cluster.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import type { ForwarderId } from '../lib/forwarder-snippets.js';
import { resolveSiemSelection } from '../lib/siem/resolve.js';
import {
  classifyBadge,
  classifyStateFromDelta,
  fetchBaselineBytes,
  fetchServiceBreadth,
  fetchDepsPerHash,
  datadogAnalyzerQuery,
  healthBanner,
} from '../lib/top-patterns-extras.js';
import { computeTrendDelta, glyphForState } from '../lib/trend-delta.js';

export const topPatternsSchema = {
  service: z.string().optional().describe('Service name to scope the result. Omit for all services.'),
  severity: z.string().optional().describe('Severity level to scope the result (e.g., `ERROR`, `CRITICAL`, `DEBUG`).'),
  timeRange: z.string().regex(/^\d+[mhd]$/).default('1h').describe('Time range to aggregate over. Default 1h.'),
  limit: z.number().min(1).max(50).default(10).describe('Number of patterns to return. Default 10.'),
  offset: z.number().min(0).default(0).describe('Skip the first N patterns of the ranked result (for pagination). Default 0.'),
  analyzerCost: z.number().optional().describe('DEPRECATED — use effective_ingest_per_gb. SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  effective_ingest_per_gb: z.number().optional().describe('Customer-supplied $/GB rate used for the dollar overlay. When set, headline tags `rate_source=customer_supplied`. When absent, falls back to the profile list rate (`rate_source=list_price`) or omits dollars entirely (`rate_source=unset`).'),
  siemScope: z.string().optional().describe('SIEM scope for the verbatim sample line on the top rows.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
  verbose: z
    .boolean()
    .default(false)
    .describe(
      'When true, every card carries the full forwarder snippet inline, every CTA renders unconditionally, ' +
      'and the volume-trend chart shows on every top-3 card. Default: compact mode (snippet templated once at top, ' +
      'CTAs gated to where they earn their line, chart only on ACUTE/NEW patterns).'
    ),
  view: z
    .literal('summary')
    .default('summary')
    .optional()
    .describe(
      'Output format. Always "summary" — the structured JSON envelope with patterns, incidents, totals, and chained-tool action hints. Field retained for backward-compat with callers that still pass `view: "summary"`.'
    ),
  // PL-12a — three-way engine-decision cohort filter. Replaces the
  // earlier boolean `isDropped` swap (which could only express
  // kept-OR-dropped, not the union). Default 'kept' preserves pre-PL-12
  // behavior. The `kept` path uses an absence-tolerant `isDropped!="true"`
  // selector (see promql.includeToSelector) so series emitted before the
  // receiver started stamping the `isDropped` label still match.
  include: z
    .enum(['kept', 'dropped', 'both'])
    .default('kept')
    .describe(
      'Which engine-decision cohort to scope to. ' +
      '`kept` (default) = events the engine forwarded as-is (isDropped!="true") — the pre-PL-12 behavior. ' +
      '`dropped` = events tagged isDropped="true" by the engine (the offload/down-tier cohort). ' +
      '`both` = the pre-decision union; per-row output adds kept_bytes / dropped_bytes / dropped_share_pct. ' +
      'Use `dropped` to verify post-deploy realised savings or to answer "which patterns are we offloading right now". ' +
      'Use `both` to compute the offload share denominator in a single call.'
    ),
  include_chart: z
    .boolean()
    .default(false)
    .describe(
      'Set include_chart=true to embed the rendered chart inline (large; default false to avoid response truncation).'
    ),
};

/** Normalize the env's forwarder enum to the ForwarderId type the
 * renderer expects. */
function normalizeForwarder(
  v: EnvConfig['forwarder']
): ForwarderId | null {
  if (!v || v === 'unknown') return null;
  if (v === 'fluentbit') return 'fluent-bit';
  return v;
}

export async function executeTopPatterns(
  args: {
    service?: string;
    severity?: string;
    timeRange: string;
    limit: number;
    offset?: number;
    analyzerCost?: number;
    effective_ingest_per_gb?: number;
    siemScope?: string;
    verbose?: boolean;
    view?: 'summary';
    // PL-12a — three-way cohort filter. See schema comment above.
    include?: 'kept' | 'dropped' | 'both';
    include_chart?: boolean;
  },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  if (!args.timeRange) (args as Record<string, unknown>).timeRange = '1h';
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    (args as Record<string, unknown>).limit = 10;
  }
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const tf = parseTimeframe(args.timeRange);
  // Cost normalization. r.bytes / totalBytes are volumes over the WHOLE
  // window (tf), so the per-hour rate is window-cost / window-hours. The old
  // code assigned the window cost straight to costPerHour and ×720 for
  // monthly — correct ONLY for the 1h default; a 24h/7d window over-stated
  // $/h and $/mo by the window-hours factor (24×, 168×). Caught by the
  // top_patterns-vs-SRE contest: a 24h run reported "$5323/mo" that was ~24×
  // too high. windowHours from tf.days (fractional for sub-day windows).
  const windowHours = tf.days * 24;
  // Rate resolution: customer-supplied > caller-supplied analyzerCost (treated
  // as customer_supplied since it's an explicit arg) > profile list rate >
  // unset. NEVER fall back to a fictitious $1/GB — when no rate is known,
  // `costPerGb` is null and every dollar surface either nulls out or renders
  // "—". Headline / PNG / per-row gating below all read `rate_source`.
  const rate_source: 'list_price' | 'customer_supplied' | 'unset' =
    args.effective_ingest_per_gb != null
      ? 'customer_supplied'
      : args.analyzerCost != null
        ? 'customer_supplied'
        : 'unset';
  const costPerGb: number | null =
    args.effective_ingest_per_gb ?? args.analyzerCost ?? null;

  // PL-12a — resolve include mode and the `isDropped` selector once.
  // `kept` (default) uses an absence-tolerant `!=` selector so series
  // without the `isDropped` label still match. `dropped` exact-matches
  // the engine-stamped cohort. `both` adds no selector here and triggers
  // the dual-query path below (a second `isDropped="true"` pass is run
  // in parallel and joined into the `dropped_*` envelope fields).
  const include = args.include ?? 'kept';
  const { droppedFilter, runBoth } = includeToSelector(include);

  const filters: Record<string, FilterValue> = {};
  if (args.service) filters[LABELS.service] = args.service;
  if (args.severity) filters[LABELS.severity] = args.severity;
  // Inject the include filter into the shared filters map. Flows
  // through buildSelector() so every PromQL call below (top, events,
  // total, count, service rollup, baseline, service breadth) picks up
  // the cohort selector with zero call-site changes. The standalone
  // trend range query further below does NOT use buildSelector — it
  // gets the inline suffix.
  if (droppedFilter != null) filters['isDropped'] = droppedFilter;
  // Inline selector tail for the trend-range query. Mirrors the same
  // exact/negated semantics buildSelector emits.
  const isDroppedSelector =
    droppedFilter == null
      ? ''
      : typeof droppedFilter === 'string'
        ? `,isDropped="${droppedFilter}"`
        : `,isDropped${droppedFilter.op}"${droppedFilter.val}"`;

  // PL-12a — the 24h trend-range sparkline must read `all_events` for the
  // dropped/both cohorts: dropped events are NOT in `emitted_events`, so
  // `emitted_events{isDropped="true"}` is empty and the sparkline reads
  // near-zero. `kept` == emitted, so emitted_events is correct there.
  const trendMetric =
    include === 'kept' ? 'emitted_events_summaryBytes_total' : 'all_events_summaryBytes_total';

  // resolveMetricsEnvFiltered still takes plain string filters (it
  // only probes label presence). Project the filters map down for it.
  const probeFilters: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (typeof v === 'string') probeFilters[k] = v;
  }
  const metricsEnv = Object.keys(probeFilters).length > 0
    ? await resolveMetricsEnvFiltered(env, probeFilters)
    : await resolveMetricsEnv(env);

  // PL-12a — `include='both'` needs a parallel pass with
  // `isDropped="true"` to recover the dropped slice per (pattern,
  // service, severity). The kept slice is `union - dropped`. When
  // include is `kept` or `dropped`, the main query already scopes to
  // the right cohort and we skip the dual query.
  const droppedSliceFilters: Record<string, FilterValue> = { ...filters };
  if (runBoth) droppedSliceFilters['isDropped'] = { op: '=', val: 'true' };

  // --- Phase 1: PromQL — ranking, event counts, total-in-scope, distinct,
  //              cost-by-service rollup ---
  const [res, eventsRes, totalRes, countRes, serviceRollupRes, droppedSliceRes, droppedTotalRes] = await Promise.all([
    queryInstant(env, pql.topPatternsFull(filters, metricsEnv, tf.range, args.limit)),
    queryInstant(env, pql.eventsByPatternFull(filters, metricsEnv, tf.range)).catch(() => null),
    queryInstant(env, pql.totalBytesInScope(filters, metricsEnv, tf.range)).catch(() => null),
    queryInstant(env, pql.distinctPatternCount(filters, metricsEnv, tf.range)).catch(() => null),
    // Cost-by-service rollup — the "where is the money" headline. One
    // grouped query; answers the question a vanilla-SIEM SRE has to
    // hand-roll (stats by container_name) and which the per-pattern
    // list buries under fragmentation.
    queryInstant(env, pql.bytesPerServiceScoped(filters, metricsEnv, tf.range)).catch(() => null),
    // PL-12a `both` dual-query: per-(pattern, service, severity) bytes
    // for the dropped cohort, so we can carry kept/dropped/share_pct
    // on every row. Skipped when include != 'both'.
    runBoth
      ? queryInstant(env, pql.bytesPerPattern(droppedSliceFilters, metricsEnv, tf.range)).catch(() => null)
      : Promise.resolve(null),
    // PL-12a `both` totals: env-wide dropped bytes so the totals block
    // and headline can report `dropped_share_pct` against the union.
    runBoth
      ? queryInstant(env, pql.totalBytesInScope(droppedSliceFilters, metricsEnv, tf.range)).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (res.status !== 'success' || res.data.result.length === 0) {
    return 'No pattern data available. Patterns appear after the first 24h of data collection.';
  }

  // Build event-count lookup (pattern, service, severity) -> events
  const key = (p: string, s: string, sv: string) => `${p}\x00${s}\x00${sv}`;
  const eventsByKey = new Map<string, number>();
  if (eventsRes && eventsRes.status === 'success') {
    for (const r of eventsRes.data.result) {
      const k = key(
        r.metric[LABELS.pattern] || '',
        r.metric[LABELS.service] || '',
        r.metric[LABELS.severity] || ''
      );
      const v = parsePrometheusValue(r);
      if (Number.isFinite(v) && v > 0) eventsByKey.set(k, v);
    }
  }

  // PL-12a `both` — per-(pattern, service, severity) dropped bytes
  // lookup. Joined into the row assembly so each row carries
  // kept_bytes / dropped_bytes / dropped_share_pct. Empty map when
  // include != 'both' or the dropped-slice query failed.
  const droppedBytesByKey = new Map<string, number>();
  if (runBoth && droppedSliceRes && droppedSliceRes.status === 'success') {
    for (const r of droppedSliceRes.data.result) {
      const k = key(
        r.metric[LABELS.pattern] || '',
        r.metric[LABELS.service] || '',
        r.metric[LABELS.severity] || ''
      );
      const v = parsePrometheusValue(r);
      if (Number.isFinite(v) && v > 0) droppedBytesByKey.set(k, v);
    }
  }
  // Env-wide dropped total — used by the totals block + headline when
  // include='both'. When include='dropped' this is just totalBytes
  // (the main query already scopes to the dropped cohort). When
  // include='kept' this is null.
  const droppedTotalBytes: number | null = runBoth
    ? droppedTotalRes && droppedTotalRes.status === 'success' && droppedTotalRes.data.result.length > 0
      ? parsePrometheusValue(droppedTotalRes.data.result[0])
      : 0
    : null;

  // Build initial row list (sorted by cost desc)
  interface RawRow {
    pattern: string;
    service: string;
    severity: string;
    bytes: number;
    events: number;
    hash: string;
  }
  const rawRows: RawRow[] = res.data.result.map((r): RawRow => {
    const p = r.metric[LABELS.pattern] || '';
    const s = r.metric[LABELS.service] || '';
    const sv = r.metric[LABELS.severity] || '';
    const b = parsePrometheusValue(r);
    return {
      pattern: p,
      service: s,
      severity: sv,
      bytes: b,
      events: eventsByKey.get(key(p, s, sv)) ?? 0,
      // Derive tenx_hash locally from the pattern (conformance-proven
      // byte-identical to engine output, snapshot-independent).
      hash: p ? tenxHash(p) : '',
    };
  });
  rawRows.sort((a, b) => b.bytes - a.bytes);

  // FIX 7 — apply offset before Phase 2 so all subsequent fetches only run
  // for the rows the caller will see. The total count (patternCountTotal)
  // is fetched separately via a Prometheus count query and is unaffected.
  const rawRowsAll = rawRows.slice(); // full sorted list kept for heuristic fallback
  if (offset > 0) rawRows.splice(0, offset);

  // --- Phase 2: first_seen + 24h trend + SIEM events + baseline bytes +
  //              services breadth + per-hash deps + analyzer detection
  //              (all parallel) ---
  const hashes = rawRows.map(r => r.hash).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  const trendWindowSec = 24 * 3600;
  const trendStepSec = 600;
  const trendStart = now - trendWindowSec;

  // Detect analyzer up-front (best-effort) so we can decide whether to
  // run dep_check + emit Datadog inline snippet. resolveSiemSelection
  // is cheap (no network); doing it here in parallel with the heavy
  // Phase-2 fetches saves a round-trip.
  let analyzer: string | null = null;
  // siemLabel — display-name form for the disclosure tail rendered by
  // fmtDisclosedDollar (e.g. "Splunk", "Datadog"). Falls through to null
  // when no analyzer is detected; buildDisclosedDollarValue then renders
  // a generic "SIEM" prefix.
  let siemLabel: string | null = null;
  try {
    const sel = await resolveSiemSelection({});
    if (sel.kind === 'resolved') {
      analyzer = sel.id;
      siemLabel = sel.displayName;
    }
  } catch {
    /* leave null */
  }

  const [
    firstSeenByHash,
    eventsByHash,
    baselineByKey,
    serviceBreadthByHash,
    depsByHash,
    ...trendResults
  ] = await Promise.all([
    fetchFirstSeenBatch(env, hashes),
    fetchEventsByHashes(
      rawRows.map(r => ({ hash: r.hash, service: r.service, severity: r.severity })),
      { scope: args.siemScope, perHash: 250, window: args.timeRange }
    ),
    // Baseline bytes at 7d/14d/21d offsets — drives the trajectory
    // badge (NEW / ACUTE / GROWING / STABLE / SHRINKING). Mirrors
    // cost_drivers' 3-window baseline so the badge tells the same
    // story log10x_cost_drivers would for the same hash.
    fetchBaselineBytes(env, filters, metricsEnv, tf.range),
    // Distinct services emitting each hash — single grouped query,
    // post-processed locally. Gates the "service breakdown" CTA.
    fetchServiceBreadth(env, metricsEnv, tf.range, hashes),
    // Per-hash dependency check — token-AND match against the
    // detected analyzer's saved searches / alerts / dashboards.
    // Returns null when no supported analyzer is detected.
    fetchDepsPerHash(
      analyzer,
      rawRows.map(r => ({ hash: r.hash, service: r.service, severity: r.severity }))
    ).catch(() => null),
    // 24h trend per hash, sum'd across all series with that hash. One query
    // per hash, parallel; cheap to spawn. trendResults[i] aligns with
    // hashes[i] (skipping empties).
    ...rawRows.map(r =>
      r.hash
        ? queryRange(
            env,
            `sum by (${LABELS.hash}) (rate(${trendMetric}{${LABELS.hash}="${r.hash}"${isDroppedSelector}}[5m]))`,
            trendStart,
            now,
            trendStepSec
          ).catch(() => null)
        : Promise.resolve(null)
    ),
  ]);

  // --- Phase 3: Assemble TopPatternRow[] ---
  // Parallel to renderRows: the *honest* per-row dollar values (null when the
  // rate is unset). renderRows itself stores 0-coerced numbers because the
  // existing renderer signature requires a number; this side-array keeps
  // nulls intact so the structured envelope below can carry them through.
  const honestCostPerHour: Array<number | null> = [];
  const honestCostPerMonth: Array<number | null> = [];
  const renderRows: TopPatternRow[] = rawRows.map((r, idx): TopPatternRow => {
    const trendRes = trendResults[idx];
    let trendVals: number[] = [];
    if (trendRes && trendRes.status === 'success' && Array.isArray(trendRes.data.result) && trendRes.data.result[0]?.values) {
      trendVals = (trendRes.data.result[0].values as [number, string][]).map(([, v]) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      });
    }
    const events = eventsByHash.get(r.hash) ?? [];
    const fv = events.length > 0 ? fieldVariation(events) : undefined;
    const fsRes = firstSeenByHash.get(r.hash);
    // When rate is unset, every per-row dollar field collapses to null. The
    // renderer + envelope below gate every $ surface on rate_source so the
    // null propagates as "—", never as `$null` or a 0-dollar lie.
    const cost = costPerGb != null ? bytesToCost(r.bytes, costPerGb) : null;
    const costPerHour =
      cost == null ? null : windowHours > 0 ? cost / windowHours : cost;
    const costPerMonth = costPerHour == null ? null : costPerHour * 720;
    honestCostPerHour.push(costPerHour);
    honestCostPerMonth.push(costPerMonth);
    // Badge = trajectory classification. Key the baseline lookup by
    // the same (pattern, service, severity) triple `topPatternsFull`
    // and `bytesPerPattern` both group on. Cross-check NEW against
    // first-seen so unstable-pattern-name envs (where every pattern
    // looks "new" on the baseline horizon) don't render misleading
    // NEW badges for established patterns.
    const baselineKey = `${r.pattern}|${r.service}|${r.severity}`;
    const baselineSamples = baselineByKey.get(baselineKey) ?? [];
    const firstSeenSec = fsRes?.ageSeconds ?? null;
    const badgeInfo = classifyBadge(r.bytes, baselineSamples, firstSeenSec);
    const trendDelta = computeTrendDelta(badgeInfo.kind, trendVals, firstSeenSec);
    // state is now strictly derived from trend_delta.value (defect 14).
    // classifyBadge() drives the intermediate trendDelta computation;
    // the envelope's `state` field is then re-derived from the WoW pct
    // so the two fields are always consistent.
    const state = classifyStateFromDelta(trendDelta.value, firstSeenSec);
    // Defect 14.1: glyph must match state, not badgeInfo.kind. Re-derive
    // after state is settled so they can never contradict.
    trendDelta.glyph = glyphForState(state);
    const serviceCount = serviceBreadthByHash.get(r.hash);
    const deps = depsByHash?.get(r.hash);
    // Datadog inline snippet — only when the env's analyzer is
    // datadog. Other analyzers get a CTA (splunk) or omitted (cloudwatch).
    const datadogQuery = analyzer === 'datadog'
      ? datadogAnalyzerQuery(r.hash, r.service, r.severity)
      : undefined;
    // Pass 0 to the renderer when the rate is unset — the renderer
    // (top-patterns-render.ts) does naive `${fmtDollar(...)}/h` interpolation
    // today. Coercing to 0 here would render "$0/h" which is itself a lie, so
    // step 12a (separate PR) gates the dollar strings on `rateSource`. Until
    // then the markdown view shows 0; the structured envelope (returned for
    // view='summary') carries the honest nulls. The pre-coerced values feed
    // ONLY the renderer; envelope assembly below uses costPerHour/costPerMonth
    // directly so nulls survive.
    return {
      rank: idx + 1,
      hash: r.hash,
      pattern: r.pattern,
      service: r.service,
      severity: r.severity,
      bytes: r.bytes,
      costPerHour: costPerHour ?? 0,
      costPerMonth: costPerMonth ?? 0,
      events: r.events,
      firstSeenAgeSeconds: fsRes?.ageSeconds ?? null,
      trendBytesPerSec: trendVals,
      sample: events[0],
      fieldVar: fv,
      state,
      badgeInfo,
      trendDelta,
      serviceCount,
      deps,
      datadogAnalyzerQuery: datadogQuery,
    };
  });

  // Totals + analyzer detection
  const totalBytes = totalRes && totalRes.status === 'success' && totalRes.data.result.length > 0
    ? parsePrometheusValue(totalRes.data.result[0])
    : renderRows.reduce((s, r) => s + r.bytes, 0);
  // Total cost nulls out when the rate is unset (no honest dollar to display).
  // Renderer falls back to a 0-coerced version below so the existing markdown
  // path keeps compiling; the structured envelope carries the null verbatim.
  const totalCostPerHour: number | null =
    costPerGb == null
      ? null
      : windowHours > 0
        ? bytesToCost(totalBytes, costPerGb) / windowHours
        : bytesToCost(totalBytes, costPerGb);
  const totalCostMonthly: number | null =
    totalCostPerHour == null ? null : totalCostPerHour * 720;
  // Disclosed-value mirror of the totals dollar. Null when the rate is
  // unset (matches the existing "rate unset" headline gate below). When
  // populated, fmtDisclosedDollar carries the SIEM list-price caveat /
  // customer-supplied tag verbatim, so headline + envelope drop the
  // inline `at ${rateTag}` suffix.
  const totalCostMonthlyDisclosed: DisclosedDollarValue | null =
    totalCostMonthly != null
      ? buildDisclosedDollarValue(totalCostMonthly, rate_source, siemLabel, costPerGb)
      : null;

  let patternCountTotal: number | undefined;
  if (countRes && countRes.status === 'success' && countRes.data.result.length > 0) {
    const n = parsePrometheusValue(countRes.data.result[0]);
    if (Number.isFinite(n) && n > 0) patternCountTotal = Math.round(n);
  }

  // Cost-by-service rollup — "where is the money". Parse the grouped
  // query, compute each service's share of total, sort desc. This is
  // the headline a vanilla-SIEM SRE has to hand-roll; surfacing it up
  // front is the differentiator the per-pattern list alone misses.
  const serviceRollup: Array<{ service: string; bytes: number; pct: number }> = [];
  if (serviceRollupRes && serviceRollupRes.status === 'success' && totalBytes > 0) {
    for (const r of serviceRollupRes.data.result) {
      const svc = r.metric[LABELS.service] || '(unattributed)';
      const b = parsePrometheusValue(r);
      if (Number.isFinite(b) && b > 0) {
        serviceRollup.push({ service: svc, bytes: b, pct: b / totalBytes });
      }
    }
    serviceRollup.sort((a, b) => b.bytes - a.bytes);
  }

  // Analyzer is already resolved up-front in Phase 2 (so dep_check
  // could be dispatched in parallel). No second call needed here.
  // Forwarder from env config (set in env profile / envs.json)
  const forwarder = normalizeForwarder(env.forwarder);

  // Lightweight degraded-state banner — surfaces the cases top_patterns
  // can already see (empty bytes, missing events metric) without
  // running a full log10x_doctor pass on every invocation.
  const banner = healthBanner({
    totalBytes,
    patternCountTotal,
    eventsAvailable: eventsRes !== null && eventsRes.status === 'success',
  });

  // Next-action hints — pre-filled so a downstream agent with poor
  // context can EXECUTE the differentiated follow-ups instead of having
  // to compose the right call. Every arg is verified against the target
  // tool's schema (investigate=starting_point, correlate=anchor+
  // anchor_type, savings/cost_drivers=timeRange; tf.range is the PromQL
  // form, e.g. "1h"). Ordered by differentiated value.
  const nextActions: NextAction[] = [];
  const topActive = renderRows.find(r => r.hash);
  const errSev = (s: string) => ['ERROR', 'WARN', 'CRITICAL'].includes((s || '').toUpperCase());

  // Root-cause the top error loop (the "investigation" route). Anchor on
  // the highest-cost error-severity pattern with sustained volume.
  // Use a >= 24h window for the "why did this start / what co-moves"
  // routes: the 1h cost-scan window is too narrow to show a pattern's
  // emergence or to give Pearson enough points. tf.range is fine when
  // the scan was already wide.
  const rcaWindow = /^(\d+)(s|m|h)$/.test(tf.range) && !/d|w|y/.test(tf.range) ? '24h' : tf.range;
  const topErrorLoop = renderRows.find(r => r.hash && errSev(r.severity) && r.events >= 100);
  if (topErrorLoop) {
    nextActions.push({
      tool: 'log10x_investigate',
      args: { starting_point: topErrorLoop.pattern, window: rcaWindow },
      reason: 'root-cause the top error loop before suppressing it (surfaces log-only signals: DNS, connection-pool, dependency failures)',
    });
  }

  // Cross-pillar: find k8s/metric signals co-moving with the top spike.
  const topSpiking = renderRows.find(r => r.hash && (r.state === 'NEW' || r.state === 'ACUTE'));
  if (topSpiking) {
    nextActions.push({
      tool: 'log10x_metrics_that_moved',
      args: { anchor: topSpiking.pattern, anchor_type: 'log10x_pattern', timeRange: rcaWindow },
      reason: 'find k8s/metric signals (deploys, pod restarts, OOM) that moved with the top spike. Compose with log10x_rank_by_shape_similarity + log10x_metric_overlay for direction',
    });
  }

  if (topActive) {
    nextActions.push({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: topActive.pattern },
      reason: 'env-gated mitigation options + exact configs for this pattern',
    });
  }

  // Env-level projections (always available, no per-pattern arg).
  nextActions.push({
    tool: 'log10x_savings',
    args: { timeRange: tf.range },
    reason: 'projected savings across the env if you act — drop vs compact vs sample',
  });
  nextActions.push({
    tool: 'log10x_cost_drivers',
    args: { timeRange: '7d' },
    reason: 'growth/delta ranking over 7d — what is rising, vs the current-cost ranking shown here',
  });

  if (topActive) {
    nextActions.push({
      tool: 'log10x_pattern_examples',
      args: { pattern: topActive.pattern },
      reason: 'deeper sample retrieval + slot distribution for the top pattern',
    });
  }

  const telemetry = newTelemetry();

  // Build the structured-summary envelope from the same rows the
  // renderer used. This is the agent-default path; the markdown
  // path is the deliverable / human-consumable opt-in.
  const incidentInputs: IncidentInput[] = renderRows
    .filter((r) => r.hash)
    .map((r) => ({
      identity: r.hash!,
      service: r.service,
      descriptor: r.pattern ?? r.hash!,
      costPerMonthUsd: r.costPerMonth,
      trendBytesPerSec: r.trendBytesPerSec,
    }));
  const incidents = detectIncidents(incidentInputs);

  // Per-row envelope. `share_pct` is the new percent-first ranking signal
  // (bytes share of in-scope total) — answers "how big is this slice" without
  // requiring a dollar rate. `cost_per_*_usd` are nullable: null when
  // rate_source==='unset'. Renderer-side gating lives in step 12a.
  //
  // PL-12a — `kept_bytes`, `dropped_bytes`, `dropped_share_pct` carry the
  // engine-decision split. Their meaning depends on `include`:
  //   - include='kept'    → kept_bytes=bytes (the cohort), dropped_bytes=null,
  //                          dropped_share_pct=0
  //   - include='dropped' → kept_bytes=null, dropped_bytes=bytes (the cohort),
  //                          dropped_share_pct=100
  //   - include='both'    → kept_bytes = bytes - dropped_bytes (joined from
  //                          the parallel `isDropped="true"` query on
  //                          (pattern, service, severity)),
  //                          dropped_share_pct = dropped / union * 100
  // `dropped_bytes_monthly` / `dropped_events_monthly` are derived from the
  // dropped slice (windowHours → 720h). `dropped_cost_per_month_usd` gates
  // on rate_source — null when the rate is unset.
  const dataPatterns = renderRows.map((r, idx) => {
    const rawRow = rawRows[idx];
    const k = key(rawRow.pattern, rawRow.service, rawRow.severity);
    // Compute the kept/dropped split per the include semantics above.
    let keptBytes: number | null;
    let droppedBytes: number | null;
    if (include === 'kept') {
      keptBytes = r.bytes;
      droppedBytes = null;
    } else if (include === 'dropped') {
      keptBytes = null;
      droppedBytes = r.bytes;
    } else {
      // 'both' — r.bytes is the union; subtract the dropped slice for kept.
      droppedBytes = droppedBytesByKey.get(k) ?? 0;
      keptBytes = Math.max(0, r.bytes - droppedBytes);
    }
    const droppedSharePct =
      include === 'kept'
        ? 0
        : include === 'dropped'
          ? 100
          : r.bytes > 0
            ? ((droppedBytes ?? 0) / r.bytes) * 100
            : 0;
    // Monthly projections from the dropped slice. windowHours==0 (sub-second
    // window) would NaN, so guard.
    const monthlyScale = windowHours > 0 ? 720 / windowHours : 0;
    const droppedBytesMonthly =
      droppedBytes == null ? null : droppedBytes * monthlyScale;
    // Events monthly: the events count is for the cohort `include` selected
    // already. For include='dropped' the events count == dropped events; for
    // 'kept' it's the kept events (dropped events not separately known
    // without a third query). For 'both' we don't have a per-row dropped
    // event count, so leave null.
    const droppedEventsMonthly =
      include === 'dropped' ? r.events * monthlyScale : null;
    const droppedCostPerMonth =
      droppedBytesMonthly == null || costPerGb == null
        ? null
        : bytesToCost(droppedBytesMonthly, costPerGb);
    // Disclosed-value mirrors for every per-row $ field. Null when the
    // rate is unset (honest pass-through of the existing null). JSON
    // consumers reading data.patterns[] see the disclosure tail too;
    // they MUST NOT re-format the bare cost_per_*_usd number without
    // pairing it with the disclosed mirror.
    const costPerHourRaw = honestCostPerHour[idx];
    const costPerMonthRaw = honestCostPerMonth[idx];
    const costPerHourDisclosed: DisclosedDollarValue | null =
      costPerHourRaw != null
        ? buildDisclosedDollarValue(costPerHourRaw, rate_source, siemLabel, costPerGb)
        : null;
    const costPerMonthDisclosed: DisclosedDollarValue | null =
      costPerMonthRaw != null
        ? buildDisclosedDollarValue(costPerMonthRaw, rate_source, siemLabel, costPerGb)
        : null;
    const droppedCostPerMonthDisclosed: DisclosedDollarValue | null =
      droppedCostPerMonth != null
        ? buildDisclosedDollarValue(droppedCostPerMonth, rate_source, siemLabel, costPerGb)
        : null;
    return {
      rank: r.rank,
      identity: r.pattern ?? r.hash ?? '',
      // pattern_hash = tenx_hash (hash of the representing-token subset), the
      // user-facing stable identity. NOT template_hash (the engine-internal
      // field-set join key) — many templates collapse to one pattern_hash.
      pattern_hash: r.hash ?? '',
      service: r.service,
      severity: r.severity,
      cost_per_hour_usd: costPerHourRaw,
      cost_per_month_usd: costPerMonthRaw,
      cost_per_hour_usd_disclosed: costPerHourDisclosed,
      cost_per_month_usd_disclosed: costPerMonthDisclosed,
      bytes: r.bytes,
      percent_of_total_bytes:
        totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0,
      share_pct: totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0,
      events: r.events,
      first_seen_age_seconds: r.firstSeenAgeSeconds,
      state: r.state,
      trend_delta: r.trendDelta,
      descriptor: r.pattern ?? r.hash ?? '',
      trend_bytes_per_sec: r.trendBytesPerSec,
      // PL-12a additions.
      kept_bytes: keptBytes,
      dropped_bytes: droppedBytes,
      dropped_share_pct: droppedSharePct,
      dropped_bytes_monthly: droppedBytesMonthly,
      dropped_events_monthly: droppedEventsMonthly,
      dropped_cost_per_month_usd: droppedCostPerMonth,
      dropped_cost_per_month_usd_disclosed: droppedCostPerMonthDisclosed,
    };
  });

  // Aggregate share — the % of in-scope bytes the shown rows cover.
  const shownBytes = renderRows.reduce((s, r) => s + r.bytes, 0);
  const top_n_percent_of_total =
    totalBytes > 0 ? (shownBytes / totalBytes) * 100 : 0;

  // PL-12a — totals block dropped fields. Sums the per-row `dropped_bytes`
  // across the SHOWN rows (not env-wide); the env-wide `dropped_share_pct`
  // when include='both' uses the parallel `totalBytesInScope(isDropped=true)`
  // query against the union from `totalBytes`. When include='kept', all
  // three are null. When include='dropped', the cohort IS the dropped
  // slice, so `dropped_bytes_total = shownBytes` and share=100.
  let droppedBytesTotalShown: number | null;
  let droppedShareTotalPct: number | null;
  let droppedMonthlyUsd: number | null;
  if (include === 'kept') {
    droppedBytesTotalShown = null;
    droppedShareTotalPct = null;
    droppedMonthlyUsd = null;
  } else if (include === 'dropped') {
    droppedBytesTotalShown = shownBytes;
    droppedShareTotalPct = 100;
    droppedMonthlyUsd = totalCostMonthly;
  } else {
    droppedBytesTotalShown = dataPatterns.reduce(
      (s, p) => s + (p.dropped_bytes ?? 0),
      0
    );
    const denom = totalBytes;
    droppedShareTotalPct =
      denom > 0 && droppedTotalBytes != null
        ? (droppedTotalBytes / denom) * 100
        : 0;
    const droppedMonthlyScale = windowHours > 0 ? 720 / windowHours : 0;
    droppedMonthlyUsd =
      costPerGb != null && droppedTotalBytes != null
        ? bytesToCost(droppedTotalBytes * droppedMonthlyScale, costPerGb)
        : null;
  }

  // Disclosed mirror for the totals dropped-cohort $. Null when the
  // rate is unset; otherwise carries the same SIEM/list-price caveat
  // as the headline tail.
  const droppedMonthlyUsdDisclosed: DisclosedDollarValue | null =
    droppedMonthlyUsd != null
      ? buildDisclosedDollarValue(droppedMonthlyUsd, rate_source, siemLabel, costPerGb)
      : null;

  const totals = {
    monthly_usd: totalCostMonthly,
    monthly_usd_disclosed: totalCostMonthlyDisclosed,
    bytes_per_sec: totalBytes / Math.max(1, windowHours * 3600),
    bytes_total: totalBytes,
    top_n_percent_of_total,
    pattern_count_shown: renderRows.length,
    pattern_count_total: patternCountTotal,
    // PL-12a additions.
    dropped_bytes_total: droppedBytesTotalShown,
    dropped_share_pct: droppedShareTotalPct,
    dropped_monthly_usd: droppedMonthlyUsd,
    dropped_monthly_usd_disclosed: droppedMonthlyUsdDisclosed,
  };

  // Headline: percent-of-bytes + byte volume first. Dollar clause appended
  // only when a rate is known; "(rate unset)" tag otherwise so agents can
  // route to estimate_savings with `effective_ingest_per_gb`.
  //
  // PL-12a — include-aware. `kept` keeps the pre-PL-12 headline. `dropped`
  // pivots to "Top N OFFLOADED patterns ... flagged for drop/down-tier".
  // `both` reports the union plus the currently-offloaded share.
  let headline: string;
  if (renderRows.length === 0) {
    headline = `No patterns in scope over ${tf.label}.`;
  } else {
    const sharePctLabel = `${Math.round(top_n_percent_of_total)}%`;
    const bytesLabel = fmtBytesShared(shownBytes);
    const incidentTail =
      incidents.length > 0
        ? ` ${incidents.length} incident cluster${incidents.length === 1 ? '' : 's'} detected.`
        : '';
    const rateUnsetTail =
      ' Dollar overlay omitted (rate unset); pass effective_ingest_per_gb to project savings.';
    // Dollar tail rendered once. fmtDisclosedDollar carries the
    // SIEM/list-price caveat (or customer_supplied tag) inline, so the
    // pre-migration `at ${rateTag}` suffix is dropped — the disclosure
    // covers source attribution.
    const dollarTail = `${fmtDisclosedDollar(totalCostMonthlyDisclosed)}/mo`;
    if (include === 'dropped') {
      if (totalCostMonthlyDisclosed != null) {
        headline = `Top ${renderRows.length} OFFLOADED patterns over ${tf.label}: ${bytesLabel} flagged for drop/down-tier (${sharePctLabel} of scanned bytes in scope), ~${dollarTail}.${incidentTail}`;
      } else {
        headline = `Top ${renderRows.length} OFFLOADED patterns over ${tf.label}: ${bytesLabel} flagged for drop/down-tier (${sharePctLabel} of scanned bytes in scope).${rateUnsetTail}${incidentTail}`;
      }
    } else if (include === 'both') {
      const offloadShareLabel =
        droppedShareTotalPct != null
          ? `${Math.round(droppedShareTotalPct)}%`
          : '0%';
      if (totalCostMonthlyDisclosed != null) {
        headline = `Top ${renderRows.length} patterns over ${tf.label}: ${bytesLabel} union (${offloadShareLabel} currently offloaded), ~${dollarTail} total.${incidentTail}`;
      } else {
        headline = `Top ${renderRows.length} patterns over ${tf.label}: ${bytesLabel} union (${offloadShareLabel} currently offloaded).${rateUnsetTail}${incidentTail}`;
      }
    } else {
      // kept (default) — preserves pre-PL-12 headline byte-for-byte
      // aside from the disclosure-tail swap.
      if (totalCostMonthlyDisclosed != null) {
        headline = `Top ${renderRows.length} patterns over ${tf.label} cover ${sharePctLabel} of scanned bytes (${bytesLabel}), ~${dollarTail}.${incidentTail}`;
      } else {
        headline = `Top ${renderRows.length} patterns over ${tf.label} cover ${sharePctLabel} of scanned bytes (${bytesLabel}).${rateUnsetTail}${incidentTail}`;
      }
    }
  }

  const callout =
    incidents.length > 0
      ? `These look like ${incidents.length === 1 ? 'one incident' : `${incidents.length} incidents`}: ` +
        incidents
          .slice(0, 2)
          .map((c) => `${c.members.length} patterns in \`${c.service}\` share \`${c.representativeLabel.slice(0, 50)}\``)
          .join('; ')
      : undefined;

  // FIX 7 — Truncation signal and pagination.
  // totalAvailable: prefer the Prometheus count query; fall back to the full
  // pre-offset rowset size as a conservative lower bound.
  const totalAvailable = patternCountTotal ?? (rawRowsAll.length > offset + renderRows.length ? rawRowsAll.length : offset + renderRows.length);
  const truncated = totalAvailable > offset + renderRows.length;
  // Pagination footer for must_render_verbatim — only when there are more results.
  const paginationFooter = truncated
    ? `\nShowing patterns ${offset + 1}–${offset + renderRows.length} of ${patternCountTotal ?? '?'}. Reply 'more' to see the next ${args.limit}.`
    : '';

  // FIX 1 — Gate chart PNG behind include_chart opt-in (default false) to
  // avoid consuming a large fraction of the 25K response-token budget on
  // every call. Hosts that render image content can pass include_chart=true.
  let images: import('../lib/output-types.js').InlineImage[] | undefined;
  if (args.include_chart !== false && args.include_chart === true) {
    try {
      const { renderHorizontalBar } = await import('../lib/chart-renderer.js');
      if (dataPatterns.length > 0) {
        const useDollars = rate_source !== 'unset';
        const rateTag =
          rate_source === 'customer_supplied' ? 'customer_supplied' : 'list_price';
        const bars = dataPatterns
          .slice()
          .sort((a, b) =>
            useDollars
              ? (b.cost_per_month_usd ?? 0) - (a.cost_per_month_usd ?? 0)
              : b.bytes - a.bytes
          )
          .map((p, i) => ({
            label: `#${i + 1} ${p.identity}`,
            value: useDollars ? (p.cost_per_month_usd ?? 0) : p.bytes,
          }));
        // PL-12a — chart title pivots when scoped to the offload cohort.
        const cohortLabel =
          include === 'dropped'
            ? 'offloaded patterns'
            : include === 'both'
              ? 'patterns (union, kept + offloaded)'
              : 'patterns';
        const title = useDollars
          ? `Top ${dataPatterns.length} ${cohortLabel} by $/mo (${tf.label}) (at ${rateTag})`
          : `Top ${dataPatterns.length} ${cohortLabel} by bytes/mo (${tf.label})`;
        const xLabel = useDollars ? '$/mo' : 'bytes/mo';
        const png = await renderHorizontalBar(bars, { title, xLabel });
        if (png) {
          const altSubject = useDollars ? 'monthly cost' : 'byte volume';
          images = [{ data: png.base64, mimeType: png.mimeType, alt: `Top ${dataPatterns.length} patterns by ${altSubject} over ${tf.label}` }];
        }
      }
    } catch (_e) {
      /* best-effort; never block */
    }
  }

  // Incident cluster combined-bytes share — the percent-first equivalent of
  // `combined_monthly_usd`, available even when the rate is unset. Derived
  // from the per-row `bytes` of each cluster member by joining on identity.
  const bytesByIdentity = new Map<string, number>();
  for (const p of dataPatterns) {
    if (p.pattern_hash) bytesByIdentity.set(p.pattern_hash, p.bytes);
  }

  return buildEnvelope({
    tool: 'log10x_top_patterns',
    view: 'summary',
    summary: { headline: headline + paginationFooter, callout },
    data: {
      rate_source,
      // PL-12a — echo the resolved cohort so the agent can route follow-up
      // calls (e.g. `include='dropped'` from a `'both'` audit) without
      // re-deriving from the per-row fields.
      include,
      patterns: dataPatterns,
      incidents: incidents.map((c) => {
        const combinedBytes = c.members.reduce(
          (s, m) => s + (bytesByIdentity.get(m.identity) ?? 0),
          0
        );
        return {
          members: c.members.map((m) => ({
            identity: m.identity,
            cost_per_month_usd: m.costPerMonthUsd,
            descriptor: m.descriptor,
          })),
          representative_label: c.representativeLabel,
          service: c.service,
          combined_monthly_usd: c.combinedMonthlyUsd,
          combined_percent_of_total:
            totalBytes > 0 ? (combinedBytes / totalBytes) * 100 : 0,
          join_signal: c.joinSignal,
          confidence: c.confidence,
        };
      }),
      totals,
      window: tf.label,
      pattern_count_shown: renderRows.length,
      pattern_count_total: patternCountTotal,
      offset,
      ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }),
    },
    actions: [
      ...nextActions.map((a) => ({ tool: a.tool, args: a.args, reason: a.reason })),
      // FIX 7 — next_page continuation action when results are truncated.
      ...(truncated
        ? [{
            tool: 'log10x_top_patterns',
            args: {
              ...(args.service ? { service: args.service } : {}),
              ...(args.severity ? { severity: args.severity } : {}),
              timeRange: args.timeRange,
              limit: args.limit,
              offset: offset + renderRows.length,
              ...(args.effective_ingest_per_gb != null ? { effective_ingest_per_gb: args.effective_ingest_per_gb } : {}),
              ...(args.siemScope ? { siemScope: args.siemScope } : {}),
              include: include,
            },
            reason: `Continue to patterns ${offset + renderRows.length + 1}–${offset + renderRows.length + args.limit} of ${patternCountTotal ?? '?'}`,
            role: 'optional-followup' as const,
          }]
        : []),
    ],
    // render_hint axis tracks the chart axis — bytes when rate unset, $/mo
    // when known. Keeps downstream agents/UI from defaulting to a dollar
    // overlay on data that has none.
    render_hint:
      rate_source === 'unset'
        ? { chart: 'timeseries', units: 'bytes/mo' }
        : { chart: 'timeseries', units: '$/mo' },
    truncated,
    images,
  });
}
