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
import { resolveRate, destinationFromEnvAnalyzer } from '../lib/rate-resolution.js';
import { resolveSiemLens, lensDisclosure, SIEM_LENS_ENUM } from '../lib/siem/lens.js';
import { resolveVolumeLens, volumeLensDisclosure, type VolumeLensResolution } from '../lib/volume-lens.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { parseTimeframe, fmtDisclosedDollar, fmtBytes as fmtBytesShared, fmtPct, fmtDollar } from '../lib/format.js';
import { type NextAction } from '../lib/next-actions.js';
import { fetchEventsByHashes } from '../lib/siem/sample.js';
import { tenxHash } from '../lib/pattern-hash.js';
import { fetchFirstSeenBatch } from '../lib/first-seen.js';
import { fieldVariation } from '../lib/field-variation.js';
import { type TopPatternRow } from '../lib/top-patterns-render.js';
import {
  getEnvDfContext,
  buildDisplayName,
  dedupeVisibleNames,
  DEFAULT_NAME_WIDTH,
  type DfContext,
  type NameableRow,
} from '../lib/pattern-df.js';
import { detectIncidents, type IncidentInput } from '../lib/detectors/incident-cluster.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry } from '../lib/unified-envelope.js';
import {
  buildChassisEnvelope,
  newChassisTelemetry,
  recordQuery,
  type RateSource as ChassisRateSource,
} from '../lib/chassis-envelope.js';
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
import { computeTrendDelta, glyphForState, fmtTrendDelta } from '../lib/trend-delta.js';
import { renderMonospaceTable } from '../lib/render-table.js';
import { sanitizeUserProse, stripHashFromVisible } from '../lib/anti-jargon-prose.js';

export const topPatternsSchema = {
  service: z.string().optional().describe('Service name to scope the result. Omit for all services.'),
  severity: z.string().optional().describe('Severity level to scope the result (e.g., `ERROR`, `CRITICAL`, `DEBUG`).'),
  timeRange: z.string().regex(/^\d+[mhd]$/).default('1h').describe('Time range to aggregate over. Default 1h.'),
  limit: z.number().min(1).max(50).default(10).describe('Number of patterns to return. Default 10.'),
  offset: z.number().min(0).default(0).describe('Skip the first N patterns of the ranked result (for pagination). Default 0.'),
  analyzerCost: z.number().optional().describe('DEPRECATED — use effective_ingest_per_gb. stack ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  effective_ingest_per_gb: z.number().optional().describe('Customer-supplied $/GB rate used for the dollar overlay. When set, headline tags `rate_source=customer_supplied`. When absent, falls back to the profile list rate (`rate_source=list_price`) or omits dollars entirely (`rate_source=unset`).'),
  siemScope: z.string().optional().describe('stack scope for the verbatim sample line on the top rows.'),
  siem_lens: z.enum(SIEM_LENS_ENUM).optional().describe('What-if destination lens: keep the real volumes, price the $/mo columns at this destination\'s list rates (env-configured rates never cross destinations). Envelope stamps siem_actual vs siem_lens.'),
  monthly_volume_gb: z.number().positive().optional().describe(
    'What-if volume lens (forecast mode): model the environment at THIS monthly volume (decimal GB/month) instead of its measured volume. The real per-pattern shares and pattern mix are held fixed; only absolute bytes and dollars scale, by one uniform factor. Use it to project a prospect onto their own scale, or to forecast a real env after growth. Pairs with siem_lens. This is a PROJECTION: the envelope stamps volume_actual_gb vs volume_projected_gb and the scale factor, and the note points at the POC for the caller real patterns.'
  ),
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
  // earlier boolean dropped-flag swap (which could only express
  // kept-OR-dropped, not the union). Default 'kept' preserves pre-PL-12
  // behavior. The `kept` path uses an absence-tolerant `routeState!="drop"`
  // selector (see promql.includeToSelector) so series emitted before the
  // receiver started stamping the `routeState` label still match.
  include: z
    .enum(['kept', 'dropped', 'both'])
    .default('kept')
    .describe(
      'Which engine-decision cohort to scope to. ' +
      '`kept` (default) = events the engine forwarded as-is (routeState!="drop") — the pre-PL-12 behavior. ' +
      '`dropped` = events stamped routeState="drop" by the engine (the offload/down-tier cohort). ' +
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
    siem_lens?: string;
    monthly_volume_gb?: number;
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
  // SHARED rate resolver (lib/rate-resolution.ts). Priority chain (highest
  // wins): caller arg → envs.json analyzerCost → LOG10X_ANALYZER_COST →
  // destination list price → unset. NEVER falls back to a fictitious $1/GB —
  // when no rate is known, costPerGb is null and every dollar surface either
  // nulls out or renders "—". Headline / PNG / per-row gating below all
  // read `rate_source`. services/event_lookup/explain_mode/estimate_savings
  // walk the same chain — so the SAME env/window emits the SAME tag.
  // Resolve the lens ONCE against the best-known actual destination:
  // credentials detection (resolveSiemSelection, cheap/no-network) beats the
  // env profile's declared analyzer when they disagree. The same lens verdict
  // then drives the rate, the dollar labels, the headline marker, and the
  // envelope stamp — so they can never disagree.
  let analyzer: string | null = null;
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
  const lens = resolveSiemLens(args.siem_lens, analyzer ?? env.analyzer);
  const rateResolved = resolveRate(
    { effective_ingest_per_gb: args.effective_ingest_per_gb, analyzerCost: args.analyzerCost },
    env,
    lens.effective ?? destinationFromEnvAnalyzer(env),
    { lensed: lens.lensed },
  );
  // The dollar label must name the destination that PRICED the run.
  if (rateResolved.source === 'list_price' && lens.display) {
    siemLabel = lens.display;
  } else if (lens.lensed && lens.display) {
    siemLabel = lens.display;
  }
  const rate_source: 'list_price' | 'customer_supplied' | 'unset' = rateResolved.source;
  const costPerGb: number | null = rateResolved.rate_per_gb;

  // PL-12a — resolve include mode and the `routeState` selector once.
  // `kept` (default) uses an absence-tolerant `!=` selector so series
  // without the `routeState` label still match. `dropped` exact-matches
  // the engine-stamped cohort. `both` adds no selector here and triggers
  // the dual-query path below (a second `routeState="drop"` pass is run
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
  if (droppedFilter != null) filters['routeState'] = droppedFilter;
  // Inline selector tail for the trend-range query. Mirrors the same
  // exact/negated semantics buildSelector emits.
  const routeStateSelector =
    droppedFilter == null
      ? ''
      : typeof droppedFilter === 'string'
        ? `,routeState="${droppedFilter}"`
        : `,routeState${droppedFilter.op}"${droppedFilter.val}"`;

  // PL-12a — the 24h trend-range sparkline must read `all_events` for the
  // dropped/both cohorts: dropped events are NOT in `emitted_events`, so
  // `emitted_events{routeState="drop"}` is empty and the sparkline reads
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
  // `routeState="drop"` to recover the dropped slice per (pattern,
  // service, severity). The kept slice is `union - dropped`. When
  // include is `kept` or `dropped`, the main query already scopes to
  // the right cohort and we skip the dual query.
  const droppedSliceFilters: Record<string, FilterValue> = { ...filters };
  if (runBoth) droppedSliceFilters['routeState'] = { op: '=', val: 'drop' };

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

  // Volume projection lens. Resolve ONCE against the env's measured monthly
  // bytes (the in-scope total normalized to a 30-day month: rawTotalBytes is
  // the window total, ×720/windowHours scales window-hours to month-hours).
  // volScale folds into every RAW byte/event chokepoint below BEFORE any
  // derived share/cost is computed, so shares and ratios stay invariant by
  // construction and only absolute magnitudes move. factor 1 (no
  // monthly_volume_gb, or no basis) => byte-for-byte identical to today.
  const rawTotalBytes =
    totalRes && totalRes.status === 'success' && totalRes.data.result.length > 0
      ? parsePrometheusValue(totalRes.data.result[0])
      : 0;
  const volRes = resolveVolumeLens(
    args.monthly_volume_gb,
    windowHours > 0 ? (rawTotalBytes * 720) / windowHours : 0,
  );
  const volScale = volRes.factor;

  if (res.status !== 'success' || res.data.result.length === 0) {
    // When include='dropped', the empty-result cause is ambiguous:
    //   A. enrichment_not_wired — receiver does not emit the routeState label at all.
    //   B. enrichment_wired_window_empty — label is wired but no dropped events in this window/scope.
    //   C. onboarding_gate — engine is < 24h old and has no data yet (the original case).
    //
    // Distinguish them so an agent or user can take the right corrective action.
    // States A and B require a meta probe; skip it for `kept` / `both` which fall
    // through to the existing generic message (no dropped-label dependency there).
    if (include === 'dropped') {
      // Meta probe: count the number of distinct message_pattern series that carry
      // the routeState="drop" label env-wide (no window scope — use a generous 24h
      // lookback so a sparse env is not misclassified as unwired). If the count is
      // zero the label is not being stamped by the receiver at all (state A).
      let distinctDroppedPatternCount = 0;
      try {
        const metaProbeQuery = `count(count by (message_pattern) (all_events_summaryBytes_total{tenx_env="${metricsEnv}",routeState="drop"}[24h]))`;
        const metaRes = await queryInstant(env, metaProbeQuery);
        if (metaRes.status === 'success' && metaRes.data.result.length > 0) {
          distinctDroppedPatternCount = Number(metaRes.data.result[0].value?.[1] ?? 0) || 0;
        }
      } catch {
        // meta probe failure is non-fatal — fall through to generic message
      }

      let enrichmentState: 'enrichment_not_wired' | 'enrichment_wired_window_empty' | 'onboarding_gate' | 'unknown';
      let message: string;

      if (distinctDroppedPatternCount === 0) {
        // State A: routeState label never seen in this env.
        enrichmentState = 'enrichment_not_wired';
        message =
          'routeState enrichment is not wired on this env\'s Receiver — the receiver does not emit the routeState label. ' +
          'To enable, ensure the rate-receiver settings.yaml includes \'routeState\' in enrichmentFields (it is on by default), ' +
          'and the engine is on a run-edge release that appends the routeState label on the wire. ' +
          'See docs/cross-pillar-primitives.md for setup details.';
      } else {
        // State B: label is wired, but the requested window/scope returned zero dropped events.
        enrichmentState = 'enrichment_wired_window_empty';
        const scopeDesc = args.service ? ` for service "${args.service}"` : '';
        message =
          `No dropped-cohort patterns in this ${tf.label} window${scopeDesc}. ` +
          `The routeState enrichment IS wired (${distinctDroppedPatternCount} distinct pattern${distinctDroppedPatternCount === 1 ? '' : 's'} observed across the source in the last 24h) ` +
          `but the current scope returned zero events. ` +
          (args.service ? 'Try removing the service scope, or ' : 'Try ') +
          'widening the time window (e.g. timeRange="24h").';
      }

      // Surface the state in a structured envelope so an agent can branch
      // on data.payload.diagnostics.enrichment_state without parsing prose.
      return buildChassisEnvelope({
        tool: 'log10x_top_patterns',
        view: 'summary',
        headline: message,
        status: 'no_signal',
        decisions: {
          threshold_used: null,
          threshold_basis: 'default',
        },
        payload: {
          rate_source,
          include,
          patterns: [],
          incidents: [],
          totals: {
            monthly_usd: null,
            monthly_usd_disclosed: null,
            bytes_per_sec: 0,
            bytes_total: 0,
            top_n_percent_of_total: 0,
            pattern_count_shown: 0,
            pattern_count_total: undefined,
            dropped_bytes_total: null,
            dropped_share_pct: null,
            dropped_monthly_usd: null,
            dropped_monthly_usd_disclosed: null,
          },
          window: tf.label,
          pattern_count_shown: 0,
          pattern_count_total: undefined,
          offset: 0,
          diagnostics: {
            enrichment_state: enrichmentState,
            distinct_dropped_patterns_env_24h: distinctDroppedPatternCount,
          },
          bytes_source: {
            metric: 'all_events_summaryBytes_total',
            observation_window: tf.range,
            cohort: include,
            scope_filter: `${metricsEnv}`,
          },
          pattern_count_source: {
            query: 'distinctPatternCount',
            count: null,
            window: tf.range,
          },
        },
        human_summary: message,
        source_disclosure: {
          bytes_source: 'tsdb',
          rate_source: 'none',
          ...lensDisclosure(lens),
          ...volumeLensDisclosure(volRes),
          pattern_count_source: {
            kind: 'top_n_above_threshold',
            count: 0,
            denominator_meaning: 'No dropped-cohort data in scope',
          },
        },
        scope: {
          window: tf.label,
          window_basis: 'explicit',
          candidates_count: 0,
          candidates_usable: 0,
          candidates_evaluated: 0,
        },
        actions: enrichmentState === 'enrichment_wired_window_empty' ? [
          {
            tool: 'log10x_top_patterns',
            args: { include: 'dropped', timeRange: '24h', limit: args.limit },
            reason: 'Widen to 24h to find dropped-cohort patterns across a longer window',
          },
        ] : [],
        telemetry: newChassisTelemetry(),
      });
    }

    {
      const message = 'No pattern data available. Patterns appear after the first 24h of data collection.';
      return buildChassisEnvelope({
        tool: 'log10x_top_patterns',
        view: 'summary',
        headline: message,
        status: 'insufficient_data',
        decisions: { threshold_used: null, threshold_basis: 'default' },
        source_disclosure: { bytes_source: 'tsdb', rate_source: 'none', ...lensDisclosure(lens), ...volumeLensDisclosure(volRes) },
        scope: { window: tf.range, window_basis: args.timeRange ? 'explicit' : 'auto_default' },
        payload: {},
        human_summary: message,
        telemetry: newChassisTelemetry(),
      });
    }
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
      if (Number.isFinite(v) && v > 0) eventsByKey.set(k, v * volScale);
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
      if (Number.isFinite(v) && v > 0) droppedBytesByKey.set(k, v * volScale);
    }
  }
  // Env-wide dropped total — used by the totals block + headline when
  // include='both'. When include='dropped' this is just totalBytes
  // (the main query already scopes to the dropped cohort). When
  // include='kept' this is null.
  const droppedTotalBytes: number | null = runBoth
    ? droppedTotalRes && droppedTotalRes.status === 'success' && droppedTotalRes.data.result.length > 0
      ? parsePrometheusValue(droppedTotalRes.data.result[0]) * volScale
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
    const b = parsePrometheusValue(r) * volScale;
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

  // (analyzer + lens + label resolved up-front, before the rate — see top.)

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
            `sum by (${LABELS.hash}) (rate(${trendMetric}{${LABELS.hash}="${r.hash}"${routeStateSelector}}[5m]))`,
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
        return (Number.isFinite(n) ? n : 0) * volScale;
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
    // Scale the baseline samples by the SAME volScale as the current-window
    // bytes (r.bytes is already scaled). classifyBadge computes a trajectory
    // RATIO (current vs baseline); the factor must cancel so the badge kind —
    // and the trend window/scope/glyph it selects downstream — stays
    // volume-independent under a lens. Scaling only current would multiply the
    // ratio by the factor and corrupt the trend SHAPE (a non-scalable signal).
    const baselineSamples = (baselineByKey.get(baselineKey) ?? []).map((v) => v * volScale);
    const firstSeenSec = fsRes?.ageSeconds ?? null;
    const badgeInfo = classifyBadge(r.bytes, baselineSamples, firstSeenSec);
    const trendDelta = computeTrendDelta(badgeInfo.kind, trendVals, firstSeenSec);
    // state is now strictly derived from trend_delta.value.
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

  // --- RENDER-ONLY pattern naming (Layers 1-2) ---
  // Build the discriminator-first display_name from each row's symbolMessage
  // (r.pattern) over the env-wide df-map. The df-map is fetched once and
  // CACHED per env so pattern_detail's drill-in renders the SAME label for
  // the same pattern. Identity fields (r.pattern, r.hash) are untouched.
  // Degrades safely: a backend hiccup yields a zero-corpus df -> Layer 1.
  // Uses the default fixed 24h window (NOT the tool's timeRange) so both
  // surfaces build their df-map over the same pattern set and agree on labels.
  const dfCtx: DfContext = await getEnvDfContext(env, metricsEnv);
  for (const r of renderRows) {
    const dn = buildDisplayName(r.pattern, {
      df: dfCtx,
      service: r.service,
      severity: r.severity,
      width: DEFAULT_NAME_WIDTH,
    });
    r.display_name = dn.display_name;
    r.display_tokens = dn.display_tokens;
  }
  // Guard (d): guarantee distinct names across the visible page. Operate on
  // a thin view that writes display_name back onto the rows.
  const nameableView: NameableRow[] = renderRows.map((r) => ({
    display_name: r.display_name ?? '',
    display_tokens: r.display_tokens ?? [],
    pattern_hash: r.hash ?? '',
  }));
  dedupeVisibleNames(nameableView, dfCtx);
  nameableView.forEach((n, i) => {
    renderRows[i].display_name = n.display_name;
  });

  // Totals + analyzer detection
  const totalBytes = totalRes && totalRes.status === 'success' && totalRes.data.result.length > 0
    ? parsePrometheusValue(totalRes.data.result[0]) * volScale
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
      const b = parsePrometheusValue(r) * volScale;
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
    tool: 'log10x_whats_changing',
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

  // Headline promised "Reply 'more' to see the next 50" but no
  // machine-readable pagination action existed. Emit one when there are
  // more patterns than shown so the chain is actionable without prose
  // parsing.
  if (
    patternCountTotal != null &&
    patternCountTotal > offset + renderRows.length
  ) {
    const remaining = patternCountTotal - (offset + renderRows.length);
    nextActions.push({
      tool: 'log10x_top_patterns',
      args: {
        timeRange: tf.range,
        limit: Math.min(50, remaining),
        offset: offset + renderRows.length,
        include,
        ...(args.service ? { service: args.service } : {}),
        ...(args.severity ? { severity: args.severity } : {}),
      },
      reason: `next ${Math.min(50, remaining)} patterns below the current top ${renderRows.length} (${remaining} remaining of ${patternCountTotal} total)`,
    });
  }

  const telemetry = newTelemetry();          // legacy — kept for existing callers that read query_count
  const chassisTelemetry = newChassisTelemetry();
  // Phase-1: 7 parallel PromQL queries already ran above. Record them.
  recordQuery(chassisTelemetry);
  // Phase-2: first_seen + events + baseline + breadth + deps + trend queries.
  recordQuery(chassisTelemetry);

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
  //                          the parallel `routeState="drop"` query on
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
      cost_per_month_usd_display: costPerMonthRaw != null ? fmtDollar(costPerMonthRaw) : null,
      cost_per_hour_usd_disclosed: costPerHourDisclosed,
      cost_per_month_usd_disclosed: costPerMonthDisclosed,
      bytes: r.bytes,
      bytes_display: fmtBytesShared(r.bytes),
      percent_of_total_bytes:
        totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0,
      share_pct: totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0,
      share_pct_display: fmtPct(totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0),
      events: r.events,
      first_seen_age_seconds: r.firstSeenAgeSeconds,
      trend_delta: r.trendDelta,
      trend_delta_display: (() => {
        const { display, ageSource } = fmtTrendDelta(
          r.trendDelta!,
          r.firstSeenAgeSeconds,
          r.trendBytesPerSec.length,
          trendStepSec
        );
        return { display, first_seen_age_source: ageSource };
      })(),
      // descriptor is now the readable, discriminator-first display_name
      // (Layer 2) instead of the raw underscored symbolMessage — the burned
      // "no raw symbol_message in headlines" rule. The raw form stays
      // verbatim on `identity` + `symbol_message` for round-trip/identity.
      descriptor: r.display_name && r.display_name.length > 0 ? r.display_name : (r.pattern ?? r.hash ?? ''),
      // RENDER-ONLY output contract (consumed by the homepage chat widget).
      // symbol_message + pattern_hash are unchanged identity; display_name +
      // display_tokens are additive render fields.
      symbol_message: r.pattern ?? '',
      display_name: r.display_name ?? '',
      display_tokens: r.display_tokens ?? [],
      trend_bytes_per_sec: r.trendBytesPerSec,
      // PL-12a additions.
      kept_bytes: keptBytes,
      kept_bytes_display: keptBytes != null ? fmtBytesShared(keptBytes) : null,
      dropped_bytes: droppedBytes,
      dropped_bytes_display: droppedBytes != null ? fmtBytesShared(droppedBytes) : null,
      dropped_share_pct: droppedSharePct,
      dropped_share_pct_display: droppedSharePct != null ? fmtPct(droppedSharePct) : null,
      dropped_bytes_monthly: droppedBytesMonthly,
      dropped_bytes_monthly_display: droppedBytesMonthly != null ? fmtBytesShared(droppedBytesMonthly) : null,
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
  // when include='both' uses the parallel `totalBytesInScope(routeState="drop")`
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
    // Previously droppedBytesTotalShown summed top-N rows while
    // droppedShareTotalPct used the env-wide droppedTotalBytes, a
    // scope-mix that made the displayed share inconsistent with the
    // displayed bytes (4.83% vs the math 4.76% computed from the
    // displayed numerator/denominator). Use the env-wide source for
    // BOTH so they reconcile.
    droppedBytesTotalShown = droppedTotalBytes;
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
    // The headline "X GB union" was computed from shownBytes (sum of
    // shown rows' bytes), but no named field carried that value:
    // readers had to sum patterns[i].bytes by hand or derive from
    // bytes_total × top_n_percent_of_total (which is mathematically
    // equivalent but encoded indirectly). Surface explicitly so the
    // headline maps to a named field.
    bytes_shown: shownBytes,
    // trend_bytes_per_sec arrays were sometimes shorter than the scope
    // window (some patterns produced 130 buckets covering 21.65h, others
    // 55 buckets covering 12.60h, while scope claimed 'last 24h'). Trend
    // was a 24h rate(...) range query with a 5m rate window and 600s
    // step. Surface the step so consumers can audit per-pattern coverage
    // as array_length × trend_step_seconds = coverage_seconds and detect
    // coverage gaps without reverse-engineering the query.
    trend_basis: {
      window_seconds: 24 * 3600,
      step_seconds: trendStepSec,
      rate_window: '5m',
      note: 'trend_bytes_per_sec[i] is the average bytes/sec over a 5-minute rate window centered on bucket i. Coverage seconds = array_length × step_seconds; missing buckets indicate sparse data inside the trend window.',
    },
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
    // C-policy: a top-line dollar appears in the HEADLINE only when the
    // rate is the customer's real contracted number. At list_price the
    // dollar is the SIEM vendor rack rate, not their number, so the
    // headline leads with volume; the chassis already adds the list-rate
    // caveat. At unset there is no dollar at all.
    const showDollarHeadline =
      rate_source === 'customer_supplied' && totalCostMonthlyDisclosed != null;
    // The "set your rate" hint is unset-only. At list_price the chassis
    // emits the list-rate caveat, so we do NOT repeat a rate hint here.
    const rateHintTail =
      rate_source === 'unset'
        ? ' Dollar overlay omitted (rate unset); pass effective_ingest_per_gb to project savings.'
        : '';
    // Dollar tail rendered once. fmtDisclosedDollar carries the
    // SIEM/list-price caveat (or customer_supplied tag) inline, so the
    // pre-migration `at ${rateTag}` suffix is dropped; the disclosure
    // covers source attribution.
    const dollarTail = `${fmtDisclosedDollar(totalCostMonthlyDisclosed)}/mo`;
    if (include === 'dropped') {
      if (showDollarHeadline) {
        headline = `Top ${renderRows.length} OFFLOADED patterns over ${tf.label}: ${bytesLabel} flagged for drop/down-tier (${sharePctLabel} of scanned bytes in scope), ~${dollarTail}.${incidentTail}`;
      } else {
        headline = `Top ${renderRows.length} OFFLOADED patterns over ${tf.label}: ${bytesLabel} flagged for drop/down-tier (${sharePctLabel} of scanned bytes in scope).${rateHintTail}${incidentTail}`;
      }
    } else if (include === 'both') {
      const offloadShareLabel =
        droppedShareTotalPct != null
          ? `${Math.round(droppedShareTotalPct)}%`
          : '0%';
      if (showDollarHeadline) {
        headline = `Top ${renderRows.length} patterns over ${tf.label}: ${bytesLabel} union (${offloadShareLabel} currently reduced), ~${dollarTail} total.${incidentTail}`;
      } else {
        headline = `Top ${renderRows.length} patterns over ${tf.label}: ${bytesLabel} union (${offloadShareLabel} currently reduced).${rateHintTail}${incidentTail}`;
      }
    } else {
      // kept (default) headline shape:
      //   "Top 10 of <total> patterns cover ~$X/mo of $Y/mo total (Z%)"
      // shownCostMonthly = $/mo for the rows we're showing (computed from
      // shownBytes). totalCostMonthly = env-wide $/mo (totalBytes-based).
      // Falls back to bytes-only framing when no rate is configured.
      const totalLabel =
        patternCountTotal != null ? ` of ${patternCountTotal}` : '';
      if (showDollarHeadline && costPerGb != null && windowHours > 0) {
        const shownCostMonthly =
          (bytesToCost(shownBytes, costPerGb) / windowHours) * 720;
        const shownDollarLabel = fmtDollar(shownCostMonthly);
        const totalDollarLabel = fmtDisclosedDollar(totalCostMonthlyDisclosed);
        headline = `Top ${renderRows.length}${totalLabel} patterns cover ~${shownDollarLabel}/mo of ${totalDollarLabel}/mo total (${sharePctLabel}).${incidentTail}`;
      } else {
        headline = `Top ${renderRows.length}${totalLabel} patterns cover ${sharePctLabel} of scanned bytes (${bytesLabel}).${rateHintTail}${incidentTail}`;
      }
    }
  }

  // representativeLabel is the dominant member's descriptor, NOT a string
  // the other members literally share. Earlier the callout read "N patterns
  // share `<representativeLabel>`" which claimed something not in the data.
  // joinSignal carries the actual relationship: jaccard_direct = token-set
  // overlap, overlap_shared = shared-token threshold,
  // jaccard_with_correlation = co-trending. Phrase the callout in those
  // terms so the claim matches what the detector did.
  const joinPhrase = (s: 'jaccard_direct' | 'overlap_shared' | 'jaccard_with_correlation'): string =>
    s === 'jaccard_direct'
      ? 'similar tokens to'
      : s === 'overlap_shared'
        ? 'shared tokens with'
        : 'co-trending with';
  const callout =
    incidents.length > 0
      ? `These look like ${incidents.length === 1 ? 'one incident' : `${incidents.length} incidents`}: ` +
        incidents
          .slice(0, 2)
          .map(
            (c) =>
              `${c.members.length} patterns in \`${c.service}\` (${joinPhrase(c.joinSignal)} \`${c.representativeLabel.slice(0, 50)}\`)`,
          )
          .join('; ')
      : undefined;

  // FIX 7 — Truncation signal and pagination.
  // totalAvailable: prefer the Prometheus count query; fall back to the full
  // pre-offset rowset size as a conservative lower bound.
  const totalAvailable = patternCountTotal ?? (rawRowsAll.length > offset + renderRows.length ? rawRowsAll.length : offset + renderRows.length);
  const truncated = totalAvailable > offset + renderRows.length;
  // "more" expands, never redelivers the same chunk size. Initial 10 →
  // next 25 → next 50. Detection uses the CURRENT args.limit (the one that
  // just ran) to pick the next size. >=50 stays at 50 so pagination
  // doesn't blow up unbounded; we still page through additional results,
  // just at the schema max page size.
  const nextLimit =
    args.limit <= 10 ? 25 : args.limit <= 25 ? 50 : 50;
  // Pagination footer for must_render_verbatim — only when there are more results.
  const paginationFooter = truncated
    ? `\nShowing patterns ${offset + 1}–${offset + renderRows.length} of ${patternCountTotal ?? '?'}. Reply 'more' to see the next ${nextLimit}.`
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

  // Assemble the tool-specific payload. All pre-chassis fields are
  // preserved as payload keys so existing call sites (other tools, the
  // MCP runtime) can still read them. ChassisData wraps them inside
  // payload; back-compat fields are also spread at the data level via
  // legacyCompat.
  // Build a set of pattern_hashes we actually serialize so
  // incidents[].members can be filtered to only resolvable references.
  // Prior code shipped incidents whose members pointed at pattern_hashes
  // outside payload.patterns[] (envelope claimed pattern_count_shown=N
  // but only K patterns serialized when pattern_count_shown > limit).
  // Filtering keeps the envelope self-consistent.
  const shownPatternHashes = new Set<string>();
  for (const p of dataPatterns) {
    if (p.pattern_hash) shownPatternHashes.add(p.pattern_hash);
  }
  const topPatternsPayload = {
    rate_source,
    volume_lens: volRes,
    // Prior envelope tagged rate_source='customer_supplied' but didn't
    // expose the underlying $/GB scalar: the entire dollar surface was
    // computed from an undisclosed value. Surface it so a CFO can audit
    // "did $92/wk = bytes × this rate". Null only when
    // rate_source='unset'.
    rate_disclosure: costPerGb != null
      ? {
          value_usd_per_gb: costPerGb,
          tier: 'ingest_standard' as const,
          currency: 'USD' as const,
          source: rate_source,
          applied_to: 'bytes_per_month' as const,
        }
      : null,
    // PL-12a — echo the resolved cohort so the agent can route follow-up
    // calls (e.g. `include='dropped'` from a `'both'` audit) without
    // re-deriving from the per-row fields.
    include,
    patterns: dataPatterns,
    incidents: incidents.map((c) => {
      // Drop dangling member references (pattern_hashes not in
      // patterns[]) and surface the count of dropped members so the
      // consumer knows the cluster is partial.
      const allMembers = c.members;
      const visibleMembers = allMembers.filter(
        (m) => !m.identity || shownPatternHashes.has(m.identity)
      );
      const droppedReferenceCount = allMembers.length - visibleMembers.length;
      const combinedBytes = c.members.reduce(
        (s, m) => s + (bytesByIdentity.get(m.identity) ?? 0),
        0
      );
      return {
        members: visibleMembers.map((m) => ({
          identity: m.identity,
          cost_per_month_usd: m.costPerMonthUsd,
          descriptor: m.descriptor,
        })),
        ...(droppedReferenceCount > 0
          ? {
              members_outside_shown_set: droppedReferenceCount,
              members_outside_shown_set_note:
                'These pattern_hashes participate in the incident cluster but were not in the top-N shown. Call log10x_top_patterns with a larger limit to surface them.',
            }
          : {}),
        representative_label: c.representativeLabel,
        service: c.service,
        combined_monthly_usd: c.combinedMonthlyUsd,
        combined_percent_of_total:
          totalBytes > 0 ? (combinedBytes / totalBytes) * 100 : 0,
        join_signal: c.joinSignal,
        confidence: c.confidence,
        // confidence values without basis shipped as authoritative (0.7
        // round default for overlap_shared, 0.778 = 7/9 raw Jaccard for
        // jaccard_direct). Two methods on a non-unified scale; tag each
        // so the agent can distinguish a hand-picked default from a
        // measured overlap fraction.
        confidence_basis:
          c.joinSignal === 'overlap_shared'
            ? ('unvalidated_default' as const)
            : ('jaccard_token_overlap_ratio' as const),
      };
    }),
    totals,
    window: tf.label,
    pattern_count_shown: renderRows.length,
    pattern_count_total: patternCountTotal,
    offset,
    // Disclosure fields so an agent can explain why top_patterns (short window)
    // and preview_filter/estimate_savings (30d window) may show different numbers.
    bytes_source: {
      metric: 'all_events_summaryBytes_total',
      observation_window: tf.range,
      cohort: include,
      scope_filter: `${metricsEnv}`,
    },
    pattern_count_source: {
      query: 'distinctPatternCount',
      count: patternCountTotal ?? null,
      window: tf.range,
    },
  };

  // Determine threshold_basis from rate_source:
  //   customer_supplied → caller gave explicit $/GB, trust it.
  //   unset             → no rate configured; floor is 0 (all patterns shown).
  const chassisThresholdBasis =
    rate_source === 'customer_supplied' ? 'customer_supplied' : 'default';

  // Build must_render_verbatim monospace table.
  // Columns: # | Pattern | Service | Vol/mo | % | Trend | $/mo
  // Uses *_display sibling fields throughout so formatting is consistent.
  // Vol/mo header is unit-agnostic — bytes_display is adaptive (KB/MB/GB/TB).
  const topPatternsVerbatim = dataPatterns.length > 0
    ? renderMonospaceTable(
        dataPatterns,
        [
          { header: '#',       align: 'right',  get: (p) => String(p.rank) },
          // `identity` may fall back to `pattern_hash` when the
          // descriptor is missing. stripHashFromVisible ensures the 11-char
          // hash never leaks into the visible cell; the hash stays in the
          // structured `pattern_hash` field for tool-to-tool round-trip.
          { header: 'Pattern', align: 'left',   get: (p) => stripHashFromVisible(p.identity) || '(unnamed pattern)', max_width: 40 },
          { header: 'Service', align: 'left',   get: (p) => p.service ?? '', max_width: 24 },
          { header: 'Vol/mo',  align: 'right',  get: (p) => p.bytes_display },
          { header: '%',       align: 'right',  get: (p) => p.share_pct_display },
          { header: 'Trend',   align: 'left',   get: (p) => p.trend_delta_display?.display ?? `${p.trend_delta?.glyph ?? ''} ${p.trend_delta?.label ?? '—'}`.trim() },
          { header: '$/mo',    align: 'right',  get: (p) => p.cost_per_month_usd_display ?? '—' },
        ],
        {
          title: `Top patterns — ${tf.label}${args.service ? ` — ${args.service}` : ''}`,
          footer: patternCountTotal != null && patternCountTotal > dataPatterns.length
            ? `Showing ${dataPatterns.length} of ${patternCountTotal} patterns.${paginationFooter}`
            : undefined,
        }
      )
    : undefined;

  // human_summary is honest: volume-first, includes the "top-N of total"
  // framing + rate disclosure. We drop "env" jargon at source
  // (sanitizeUserProse on the envelope would catch it too, but writing it
  // cleanly here keeps the prose readable for code reviewers). Lead with
  // rank-1 narrative (pattern, service, severity, suggested first move)
  // before the table gets rendered, so the agent always surfaces a
  // one-line orientation. The hash NEVER falls into user-visible prose.
  // When the pattern descriptor is missing we degrade to a generic label
  // ("top pattern") rather than echoing the 11-char hash.
  // stripHashFromVisible below catches any hash that slipped into the
  // descriptor string itself.
  const rank1 = renderRows[0];
  const rank1Descriptor = rank1?.pattern || 'top pattern';
  const rank1Narrative = rank1
    ? `Rank 1: ${rank1Descriptor}` +
      (rank1.service ? ` on ${rank1.service}` : '') +
      (rank1.severity ? ` (${rank1.severity})` : '') +
      `. First move: run log10x_pattern_mitigate on it to see drop/compact/offload options.`
    : '';
  const baseSummary = renderRows.length === 0
    ? `No patterns in scope over ${tf.label}.`
    : `Top ${renderRows.length} patterns by bytes/${tf.label}` +
      (args.service ? ` on ${args.service}` : '') +
      (costPerGb != null ? ` above 0 KB/s floor (rate_source=${rate_source})` : '') +
      `. Total: ${fmtBytesShared(totalBytes)}.` +
      (patternCountTotal != null ? ` ${renderRows.length} of ${patternCountTotal} patterns shown.` : '') +
      (incidents.length > 0 ? ` ${incidents.length} incident cluster${incidents.length === 1 ? '' : 's'} detected.` : '');
  // Apply sanitize + hash-strip explicitly on this tool's human_summary
  // (chassis-envelope re-runs sanitizeUserProse idempotently; we add the
  // hash-strip pass here because the chassis doesn't run it by default).
  const chassis_human_summary = stripHashFromVisible(
    sanitizeUserProse(rank1Narrative ? `${rank1Narrative} ${baseSummary}` : baseSummary)
  );

  // Map local rate_source ('unset' is this tool's term for no rate configured)
  // to the chassis RateSource enum ('none' means absent).
  const rateSourceForChassis = rate_source as string;
  const chassis_rate_source: ChassisRateSource =
    rateSourceForChassis === 'customer_supplied' ? 'customer_supplied'
    : rateSourceForChassis === 'list_price' ? 'list_price'
    : 'none';

  if (lens.lensed && lens.display) {
    headline = `[lens: ${lens.display}] ` + headline;
  }
  // Volume projection lens: mark the headline so a lensed run is never
  // mistaken for measured volume. Full provenance is in source_disclosure
  // + warnings + payload.volume_lens.
  if (volRes.lensed) {
    const pg = (volRes.projected_monthly_bytes ?? 0) / 1_000_000_000;
    const lab = pg >= 1000 ? `${(pg / 1000).toFixed(pg >= 10000 ? 0 : 1)} TB` : `${pg.toFixed(pg >= 10 ? 0 : 1)} GB`;
    headline = `[Projected to ${lab}/mo] ` + headline;
  }
  return buildChassisEnvelope({
    tool: 'log10x_top_patterns',
    view: 'summary',
    headline: headline + paginationFooter,
    headline_callout: callout,
    status: 'success',
    decisions: {
      // Prior code aliased threshold_used := costPerGb (the $/GB rate).
      // Rate is not a threshold and rate_source provenance belongs in
      // source_disclosure. The operational threshold here is the
      // ranking volume floor (0 KB/s by default), with the top_N cap
      // as the effective cutoff. Reflect that honestly:
      //   threshold_used: 0   (the volume floor, top_n_above_floor)
      //   threshold_basis: 'unvalidated_default'  (hand-picked)
      // The same fix applies to services and savings.
      threshold_used: 0,
      threshold_basis: 'unvalidated_default',
      threshold_audit: patternCountTotal != null ? {
        value: 0,
        basis: `top_n_above_floor; ${renderRows.length} of ${patternCountTotal} patterns returned`,
        observed_distribution: null,
      } : undefined,
    },
    source_disclosure: {
      bytes_source: 'tsdb',
      rate_source: chassis_rate_source,
      pattern_count_source: {
        kind: 'top_n_above_threshold',
        count: renderRows.length,
        denominator_meaning: `Top ${renderRows.length} patterns above 0 KB/s floor in ${tf.label}${patternCountTotal != null ? ` of ${patternCountTotal} total` : ''}`,
      },
      siem_vendor: (lens.lensed ? lens.display : siemLabel) ?? undefined,
      ...lensDisclosure(lens),
      ...volumeLensDisclosure(volRes),
    },
    scope: {
      window: tf.label,
      window_basis: 'explicit',
      candidates_count: patternCountTotal,
      candidates_usable: patternCountTotal,
      candidates_evaluated: renderRows.length,
    },
    payload: topPatternsPayload,
    human_summary: chassis_human_summary,
    must_render_verbatim: topPatternsVerbatim,
    telemetry: chassisTelemetry,
    actions: [
      ...nextActions.map((a) => ({ tool: a.tool, args: a.args, reason: a.reason })),
      // next_page continuation action when results are truncated.
      // "more" expands (10 → 25 → 50), so the continuation bumps `limit`
      // to `nextLimit` rather than echoing the current size.
      ...(truncated
        ? [{
            tool: 'log10x_top_patterns',
            args: {
              ...(args.service ? { service: args.service } : {}),
              ...(args.severity ? { severity: args.severity } : {}),
              timeRange: args.timeRange,
              limit: nextLimit,
              offset: offset + renderRows.length,
              ...(args.effective_ingest_per_gb != null ? { effective_ingest_per_gb: args.effective_ingest_per_gb } : {}),
              ...(args.siemScope ? { siemScope: args.siemScope } : {}),
              include: include,
            },
            reason: `Continue to patterns ${offset + renderRows.length + 1}–${offset + renderRows.length + nextLimit} of ${patternCountTotal ?? '?'}`,
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
    warnings: volRes.lensed && volRes.disclosure ? [volRes.disclosure] : undefined,
    images,
    // Back-compat: spread legacy flat fields alongside chassis so existing
    // callers reading data.status / data.query_count / data.human_summary /
    // data.patterns continue to work during migration.
    legacyCompat: true,
    legacyExtraFields: {
      ...topPatternsPayload,
      status: 'success',
      query_count: telemetry.queryCount,
      total_latency_ms: Date.now() - telemetry.startedAt,
      backend_pressure_hint: null,
      human_summary: chassis_human_summary,
    },
  });
}
