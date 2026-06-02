/**
 * log10x_retriever_series — fidelity-aware time series materialization.
 *
 * Builds a time series (counts per bucket, optionally grouped by an
 * enrichment label) from the customer's S3 archive over an arbitrary
 * window. Auto-selects between full aggregation (Strategy A) and per-
 * window-sampled fan-out (Strategy B) based on Reporter pattern volume,
 * with window-length fallback when Reporter has no signal.
 *
 * Honest at any scale: full mode returns exact counts; sampled mode
 * preserves time-distribution shape and dominant-group ranking but
 * caveats tail visibility. Pathological volume gets a structured refusal
 * with narrowing guidance, never a silent timeout.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  buildPatternSearch,
  eventTimestampMs,
  isRetrieverConfigured,
  normalizeTimeExpression,
  runRetrieverQuery,
  type RetrieverEvent,
  type RetrieverQueryRequest,
  type RetrieverQueryResponse,
  type RetrieverSummary,
} from '../lib/retriever-api.js';
import {
  decideFidelity,
  parseFidelityArg,
  timeExprToMs,
  type FidelityDecision,
  type RefusalDecision,
} from '../lib/retriever-fidelity.js';
import { createLimiter } from '../lib/concurrency.js';
import { fmtCount } from '../lib/format.js';
import { retrieverNotConfiguredMessage } from './retriever-query.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';

/** Cap on group-by cardinality. Tail collapsed to "_other_". */
const TOP_K_GROUPS = 1000;
/** Concurrency cap for Strategy B sub-window fan-out. */
const SUBWINDOW_CONCURRENCY = 6;
/**
 * Per-sub-window poll budget (ms). Each sub-window query is small (K events,
 * narrow window), so it should finish well under the global default. Cap
 * here keeps one slow sub-window from blocking a slot for the whole
 * global timeout.
 */
const SUBWINDOW_TIMEOUT_MS = 60_000;

export const retrieverSeriesSchema = {
  pattern: z
    .string()
    .optional()
    .describe(
      'Reporter-named pattern (Symbol Message). Auto-translated to `tenx_user_pattern == "<name>"` Bloom-filter expression. Use this when the agent has a pattern name from event_lookup / top_patterns / cost_drivers. Mutually exclusive with `search`; `search` wins if both provided.'
    ),
  search: z
    .string()
    .optional()
    .describe(
      'Bloom-filter search expression using the TenX subset. Tightly bound queries (e.g., `tenx_user_pattern == "PaymentRetry"`) get the cheapest fetch path. Pattern-bound expressions are also what unlocks the Reporter-driven cost heuristic — without one, mode selection falls back to window-length only. Pass `pattern` instead for the common case of scoping to one Reporter-named pattern.'
    ),
  from: z
    .string()
    .describe(
      'Start of the query window. ISO8601, epoch millis, or relative (`now-1h`, `now-7d`, `now-30d`).'
    ),
  to: z.string().default('now').describe('End of the query window. Same grammar as `from`. Default `now`.'),
  filters: z
    .array(z.string())
    .optional()
    .describe('In-memory JS filters applied after the Bloom-scoped fetch (AND-combined).'),
  target: z.string().optional().describe('Target app prefix. Defaults to __SAVE_LOG10X_RETRIEVER_TARGET__.'),
  bucket_size: z
    .string()
    .default('5m')
    .describe('Time bucket granularity (`1m`, `5m`, `1h`, `1d`). Determines the resolution of the output series.'),
  group_by: z
    .string()
    .optional()
    .describe(
      'Optional enrichment field to group the series by — e.g., `tenx_user_service`, `severity_level`, `k8s_namespace`. Top-1000 group values are retained; tail collapsed to `_other_`.'
    ),
  fidelity: z
    .string()
    .default('auto')
    .describe(
      '`auto` (tool decides via Reporter volume + window length), `full` (force exact aggregation — may exceed Lambda budget), `per_window_sampled` (force sampling, default K=1000 per sub-window), or `per_window_sampled:K` (custom K).'
    ),
  environment: z.string().optional().describe('Environment nickname — required if multi-env.'),
  view: z
    .literal('summary')
    .default('summary')
    .optional()
    .describe('summary returns the typed envelope (data.mode, data.bucket_seconds, data.series_count, data.points_returned, data.top_groups, data.caveats, data.human_summary). The deprecated markdown view was removed; data.human_summary carries the prose distillation for chat rendering.'),
};

interface SeriesPoint {
  bucket: string;
  group?: string;
  count: number;
}

export async function executeRetrieverSeries(
  rawArgs: {
    pattern?: string;
    search?: string;
    from: string;
    to: string;
    filters?: string[];
    target?: string;
    bucket_size?: string;
    group_by?: string;
    fidelity?: string;
    environment?: string;
    view?: 'summary';
  },
  env: EnvConfig
): Promise<string | import('../lib/output-types.js').StructuredOutput> {
  const { buildEnvelope: __be } = await import('../lib/output-types.js');
  if (!isRetrieverConfigured()) {
    const md = retrieverNotConfiguredMessage();
    // Typed not_configured (status + advise_retriever action) so an agent
    // branches on data.status, matching retriever_query and the framework.
    return buildNotConfiguredEnvelope({ tool: 'log10x_retriever_series', kind: 'retriever', remediation: md });
  }
  // Defensive defaults — match retrieverSeriesSchema for non-SDK
  // callers. Narrow into a fully-populated args local so the helper
  // functions can keep their non-optional bucket_size/fidelity types.
  const args = {
    ...rawArgs,
    bucket_size: rawArgs.bucket_size ?? '5m',
    fidelity: rawArgs.fidelity ?? 'auto',
  };

  // Pattern → search translation. Resolve once at the top so all downstream
  // paths (decideFidelity's pattern extractor, full-mode runRetrieverQuery,
  // sampled-mode sub-window calls, output rendering) see the same expression.
  // `search` wins over `pattern` so an agent that already authored a precise
  // expression isn't overridden. Decision rationale lives at retriever-api's
  // buildPatternSearch helper.
  if (args.pattern && !args.search) {
    args.search = buildPatternSearch(args.pattern);
  }

  const fid = parseFidelityArg(args.fidelity);

  // Validate the time expressions early so a malformed window doesn't
  // ride all the way down to the retriever for a cryptic 400.
  try {
    normalizeTimeExpression(args.from);
    normalizeTimeExpression(args.to);
  } catch (e) {
    throw new Error(`Invalid time window: ${(e as Error).message}`);
  }

  const nowMs = Date.now();
  const fromMs = timeExprToMs(args.from, nowMs);
  const toMs = timeExprToMs(args.to, nowMs);
  if (toMs <= fromMs) throw new Error(`Empty window: from=${args.from} to=${args.to}`);
  const windowMs = toMs - fromMs;

  const decision = await decideFidelity(env, {
    search: args.search,
    windowMs,
    forced: fid.forced,
    k: fid.k,
  });

  if (decision.mode === 'refused') {
    const reason = decision.reason ?? 'window/volume exceeds Lambda budget';
    const refusal_human_summary = buildRefusalHumanSummary(decision, args, windowMs);
    return __be({
      tool: 'log10x_retriever_series',
      view: 'summary',
      summary: { headline: `Series refused: ${reason}. Narrow the window or add a more selective search expression.` },
      data: {
        ok: false,
        mode: 'refused',
        from: args.from,
        to: args.to,
        window_ms: windowMs,
        reason: decision.reason,
        human_summary: refusal_human_summary,
      },
    });
  }

  const startedMs = Date.now();
  const result =
    decision.mode === 'full'
      ? await executeFullMode(env, args, fromMs, toMs)
      : await executeSampledMode(env, args, fromMs, toMs, decision.subWindows!, decision.eventsPerSubWindow!);

  const wallTimeMs = Date.now() - startedMs;
  const groupCounts: Record<string, number> = {};
  for (const p of result.series) {
    if (p.group) groupCounts[p.group] = (groupCounts[p.group] ?? 0) + p.count;
  }
  const topGroups = Object.entries(groupCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([group, count]) => ({ group, count }));
  const human_summary = buildSeriesHumanSummary({
    result,
    decision,
    args,
    wallTimeMs,
    windowMs,
    topGroups,
  });
  return __be({
    tool: 'log10x_retriever_series',
    view: 'summary',
    summary: { headline: `Retriever series for ${args.pattern ?? args.search ?? 'window'}: ${result.series.length} bucket point${result.series.length !== 1 ? 's' : ''}, ${result.groupCardinality} group${result.groupCardinality !== 1 ? 's' : ''}, mode=${decision.mode}, wall=${wallTimeMs}ms.` },
    data: {
      ok: true,
      mode: decision.mode,
      from: args.from,
      to: args.to,
      window_ms: windowMs,
      group_by: args.group_by,
      actual_events: result.actualEvents,
      worker_files: result.workerFiles,
      truncated: result.truncated,
      points_returned: result.series.length,
      series_count: result.groupCardinality,
      top_groups: topGroups,
      wall_time_ms: wallTimeMs,
      sub_windows: decision.subWindows,
      events_per_sub_window: decision.eventsPerSubWindow,
      sub_window_results: result.subWindowResults,
      human_summary,
    },
    actions: args.pattern ? [
      { tool: 'log10x_retriever_query', args: { pattern: args.pattern, from: args.from, to: args.to }, reason: 'fetch the actual events that built this series' },
      { tool: 'log10x_backfill_metric', args: { pattern: args.pattern, metric_name: `log10x.${args.pattern.toLowerCase()}_count`, destination: 'datadog', from: args.from, to: args.to, bucket_size: args.bucket_size, aggregation: 'count' }, reason: 'push this series to a TSDB as a backfilled metric' },
    ] : [],
  });
}

interface SeriesResult {
  series: SeriesPoint[];
  actualEvents: number;
  workerFiles: number;
  truncated: boolean;
  groupCardinality: number;
  /** Sub-window-level diagnostics, present only in sampled mode. */
  subWindowResults?: Array<{
    fromMs: number;
    toMs: number;
    eventsFetched: number;
    truncated: boolean;
  }>;
}

async function executeFullMode(
  env: EnvConfig,
  args: { search?: string; filters?: string[]; target?: string; bucket_size: string; group_by?: string },
  fromMs: number,
  toMs: number
): Promise<SeriesResult> {
  // Summaries path: ~50–500x bandwidth reduction vs raw events because each
  // qrs/ record carries `summaryVolume` (count) + grouping fields directly,
  // skipping the per-event `text` payload. Gated by an env flag while the
  // engine-side writer is rolling out (engine#36 / pipeline-extensions#6).
  // Fall back to the events path on empty summaries so older retrievers
  // (no qrs/ writer) still produce a series.
  const useSummaries = process.env.LOG10X_RETRIEVER_SERIES_USE_SUMMARIES === 'true';
  if (useSummaries) {
    const req: RetrieverQueryRequest = {
      from: String(fromMs),
      to: String(toMs),
      search: args.search,
      filters: args.filters,
      target: args.target,
      writeResults: false,
      writeSummaries: true,
    };
    const resp = await runRetrieverQuery(env, req);
    if (resp.summaries && resp.summaries.length > 0) {
      return aggregateSummaries(resp.summaries, args.bucket_size, args.group_by, {
        workerFiles: resp.execution.slicesObserved ?? 0,
        truncated: false,
      });
    }
    // Empty summaries — fall through to the events path (older retriever or
    // genuinely empty range). Keeping the second roundtrip avoids silent
    // false-zero series when the deployment isn't running the writer yet.
  }

  const req: RetrieverQueryRequest = {
    from: String(fromMs),
    to: String(toMs),
    search: args.search,
    filters: args.filters,
    target: args.target,
    // Pull up to the full hard cap; the engine will truncate per-worker if
    // the matched-event volume is genuinely huge. The whole point of the
    // mode-selection heuristic is to keep us off this path when that's
    // expected to happen.
    limit: 10_000,
  };
  const resp = await runRetrieverQuery(env, req);
  return aggregate(resp.events, args.bucket_size, args.group_by, {
    workerFiles: resp.execution.workerFiles,
    truncated: resp.execution.truncated,
  });
}

/**
 * Common name aliases for `group_by`. The engine's
 * `enrichmentFields` expansion emits field names like `severity_level`
 * and `tenx_user_service`; tool callers commonly type `severity` /
 * `service`. Resolve the alias once, look up by name on the summary
 * record (which is self-describing — see RetrieverSummary).
 */
const GROUP_BY_ALIAS: Record<string, string> = {
  severity: 'severity_level',
  service: 'tenx_user_service',
  pattern: 'message_pattern',
  // deprecated alias — `pattern` is canonical. This groups by the PATTERN
  // (message_pattern / symbolMessage), not the engine template hash.
  templateHash: 'message_pattern',
};

function aggregateSummaries(
  summaries: RetrieverSummary[],
  bucketSize: string,
  groupBy: string | undefined,
  meta: { workerFiles: number; truncated: boolean }
): SeriesResult {
  const bucketMs = parseBucketSize(bucketSize);
  const buckets = new Map<number, Map<string, number>>();
  const fieldName = groupBy ? GROUP_BY_ALIAS[groupBy] ?? groupBy : undefined;
  let totalEvents = 0;

  for (const s of summaries) {
    // Use slice midpoint so a slice spanning a bucket boundary lands in
    // the bucket it overlaps most. For typical 1-min slice / 5-min bucket
    // configs this is equivalent to using sliceFromMs, but it stays
    // honest if the user picks bucket_size < slice duration.
    const ts = Math.floor((s.sliceFromMs + s.sliceToMs) / 2);
    const bucketKey = Math.floor(ts / bucketMs) * bucketMs;
    let row = buckets.get(bucketKey);
    if (!row) {
      row = new Map();
      buckets.set(bucketKey, row);
    }
    let groupKey = '__total__';
    if (fieldName) {
      // Engine emits enrichment fields as arrays (matches the events
      // writer shape); flatten single-element arrays to strings before
      // lookup. Non-string values fall through to '_unknown_' so the
      // tool surfaces "we got data we couldn't bucket" rather than
      // silently misattributing.
      const raw = (s as Record<string, unknown>)[fieldName];
      const v = Array.isArray(raw) ? raw[0] : raw;
      groupKey = typeof v === 'string' && v ? v : '_unknown_';
    }
    row.set(groupKey, (row.get(groupKey) || 0) + s.summaryVolume);
    totalEvents += s.summaryVolume;
  }

  // Top-K cap — same semantics as the events-path aggregate.
  let allowedGroups: Set<string> | undefined;
  let groupCardinality = 0;
  if (groupBy) {
    const totals = new Map<string, number>();
    for (const row of buckets.values()) {
      for (const [g, c] of row.entries()) {
        totals.set(g, (totals.get(g) || 0) + c);
      }
    }
    groupCardinality = totals.size;
    if (totals.size > TOP_K_GROUPS) {
      allowedGroups = new Set(
        [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_K_GROUPS).map(([g]) => g)
      );
    }
  }

  const series: SeriesPoint[] = [];
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  for (const k of sortedKeys) {
    const row = buckets.get(k)!;
    const ts = new Date(k).toISOString();
    if (!groupBy) {
      const c = row.get('__total__') || 0;
      series.push({ bucket: ts, count: c });
      continue;
    }
    let otherCount = 0;
    for (const [g, c] of row.entries()) {
      if (allowedGroups && !allowedGroups.has(g)) {
        otherCount += c;
        continue;
      }
      series.push({ bucket: ts, group: g || '_unknown_', count: c });
    }
    if (otherCount > 0) series.push({ bucket: ts, group: '_other_', count: otherCount });
  }

  return {
    series,
    actualEvents: totalEvents,
    workerFiles: meta.workerFiles,
    truncated: meta.truncated,
    groupCardinality,
  };
}

async function executeSampledMode(
  env: EnvConfig,
  args: { search?: string; filters?: string[]; target?: string; bucket_size: string; group_by?: string },
  fromMs: number,
  toMs: number,
  n: number,
  k: number
): Promise<SeriesResult> {
  const subWindows = splitWindow(fromMs, toMs, n);
  const limiter = createLimiter(SUBWINDOW_CONCURRENCY);

  const responses = await Promise.all(
    subWindows.map((sw) =>
      limiter(() =>
        runRetrieverQuery(
          env,
          {
            from: String(sw.fromMs),
            to: String(sw.toMs),
            search: args.search,
            filters: args.filters,
            target: args.target,
            limit: k,
          },
          { timeoutMs: SUBWINDOW_TIMEOUT_MS }
        ).catch((e: Error) => {
          // One failing sub-window must not poison the whole series — empty
          // its slot, surface the failure in diagnostics, and keep going.
          return { __error: e.message } as unknown as RetrieverQueryResponse;
        })
      )
    )
  );

  const allEvents: RetrieverEvent[] = [];
  const subWindowResults: SeriesResult['subWindowResults'] = [];
  let workerFiles = 0;
  let anyTruncated = false;

  for (let i = 0; i < subWindows.length; i++) {
    const sw = subWindows[i];
    const resp = responses[i] as (RetrieverQueryResponse & { __error?: string }) | undefined;
    if (!resp || resp.__error) {
      subWindowResults.push({ fromMs: sw.fromMs, toMs: sw.toMs, eventsFetched: 0, truncated: false });
      continue;
    }
    allEvents.push(...resp.events);
    workerFiles += resp.execution.workerFiles;
    if (resp.execution.truncated) anyTruncated = true;
    subWindowResults.push({
      fromMs: sw.fromMs,
      toMs: sw.toMs,
      eventsFetched: resp.events.length,
      truncated: resp.execution.truncated,
    });
  }

  const result = aggregate(allEvents, args.bucket_size, args.group_by, {
    workerFiles,
    truncated: anyTruncated,
  });
  result.subWindowResults = subWindowResults;
  return result;
}

function splitWindow(fromMs: number, toMs: number, n: number): Array<{ fromMs: number; toMs: number }> {
  const span = toMs - fromMs;
  const step = Math.max(1, Math.floor(span / n));
  const out: Array<{ fromMs: number; toMs: number }> = [];
  for (let i = 0; i < n; i++) {
    const s = fromMs + i * step;
    const e = i === n - 1 ? toMs : s + step;
    out.push({ fromMs: s, toMs: e });
  }
  return out;
}

function aggregate(
  events: RetrieverEvent[],
  bucketSize: string,
  groupBy: string | undefined,
  meta: { workerFiles: number; truncated: boolean }
): SeriesResult {
  const bucketMs = parseBucketSize(bucketSize);
  // bucketStart -> group -> count
  const buckets = new Map<number, Map<string, number>>();

  for (const ev of events) {
    const ts = eventTimestampMs(ev);
    if (!ts) continue;
    const bucketKey = Math.floor(ts / bucketMs) * bucketMs;
    let row = buckets.get(bucketKey);
    if (!row) {
      row = new Map();
      buckets.set(bucketKey, row);
    }
    const groupKey = groupBy ? extractGroupValue(ev, groupBy) : '__total__';
    row.set(groupKey, (row.get(groupKey) || 0) + 1);
  }

  // If grouping, cap cardinality at TOP_K_GROUPS by total count, collapse tail to _other_.
  let allowedGroups: Set<string> | undefined;
  let groupCardinality = 0;
  if (groupBy) {
    const totals = new Map<string, number>();
    for (const row of buckets.values()) {
      for (const [g, c] of row.entries()) {
        totals.set(g, (totals.get(g) || 0) + c);
      }
    }
    groupCardinality = totals.size;
    if (totals.size > TOP_K_GROUPS) {
      allowedGroups = new Set(
        [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_K_GROUPS).map(([g]) => g)
      );
    }
  }

  const series: SeriesPoint[] = [];
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  for (const k of sortedKeys) {
    const row = buckets.get(k)!;
    const ts = new Date(k).toISOString();
    if (!groupBy) {
      const c = row.get('__total__') || 0;
      series.push({ bucket: ts, count: c });
      continue;
    }
    let otherCount = 0;
    for (const [g, c] of row.entries()) {
      if (allowedGroups && !allowedGroups.has(g)) {
        otherCount += c;
        continue;
      }
      series.push({ bucket: ts, group: g || '_unknown_', count: c });
    }
    if (otherCount > 0) series.push({ bucket: ts, group: '_other_', count: otherCount });
  }

  return {
    series,
    actualEvents: events.length,
    workerFiles: meta.workerFiles,
    truncated: meta.truncated,
    groupCardinality,
  };
}

function parseBucketSize(expr: string): number {
  const m = expr.trim().match(/^(\d+)([smhd])$/);
  if (!m) return 5 * 60_000;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return 5 * 60_000;
  }
}

function extractGroupValue(ev: RetrieverEvent, field: string): string {
  // Support dotted paths so callers can group on nested fluent-bit fields
  // (e.g. `kubernetes.container_name`, `kubernetes.labels.app`). Falls back
  // to the literal key for fields written with dotted names verbatim
  // (e.g. `LevelTemplate.severity_level` from the engine's templated
  // enrichment).
  let v: unknown = (ev as unknown as Record<string, unknown>)[field];
  if (v === undefined && field.includes('.')) {
    let cur: unknown = ev;
    for (const part of field.split('.')) {
      if (cur && typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        cur = undefined;
        break;
      }
    }
    v = cur;
  }
  if (v == null) return '_unknown_';
  if (typeof v === 'string') return v || '_empty_';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v).slice(0, 64);
}

// ─── human_summary helpers ───────────────────────────────────────────

/**
 * Three-sentence plain-prose distillation of a successful retriever_series
 * run. No markdown syntax (no `#`, no `\n- `, no `|` table separators), no
 * dollar figures. Mirrors the canonical buildHumanSummary pattern in
 * src/tools/find-skew.ts:216.
 */
function buildSeriesHumanSummary(s: {
  result: SeriesResult;
  decision: FidelityDecision;
  args: { from: string; to: string; bucket_size: string; group_by?: string; search?: string; pattern?: string };
  wallTimeMs: number;
  windowMs: number;
  topGroups: Array<{ group: string; count: number }>;
}): string {
  const { result, decision, args, wallTimeMs, windowMs } = s;
  const scope = args.pattern
    ? `pattern ${args.pattern}`
    : args.search
      ? `search ${args.search}`
      : 'open scan';
  const first = `Retriever series for ${scope} over ${args.from} to ${args.to} (${formatDuration(windowMs)}) produced ${result.series.length} bucket points across ${result.groupCardinality} group${result.groupCardinality === 1 ? '' : 's'} in mode ${decision.mode} (wall ${wallTimeMs}ms).`;
  const second = decision.mode === 'per_window_sampled'
    ? `Sampled mode used ${decision.subWindows} sub-windows of up to ${decision.eventsPerSubWindow} events each; time-distribution shape is preserved but bucket counts are estimates.`
    : `Full-aggregation mode returned exact counts over ${result.actualEvents} processed events${result.truncated ? ' (some workers truncated at the per-worker cap)' : ''}.`;
  const top = s.topGroups[0];
  const third = args.group_by && top
    ? `Top ${args.group_by} value is ${top.group} with ${top.count} event${top.count === 1 ? '' : 's'}.`
    : result.series.length === 0
      ? 'Series is empty; verify the search expression matches and the window covers actual ingest.'
      : `Worker files: ${result.workerFiles}.`;
  return `${first} ${second} ${third}`;
}

/**
 * Three-sentence plain-prose distillation of a refused retriever_series
 * call. Mirrors buildSeriesHumanSummary but explains the budget refusal.
 */
function buildRefusalHumanSummary(
  refusal: RefusalDecision,
  args: { from: string; to: string; search?: string; pattern?: string },
  windowMs: number,
): string {
  const scope = args.pattern
    ? `pattern ${args.pattern}`
    : args.search
      ? `search ${args.search}`
      : 'open scan';
  const first = `Retriever series refused for ${scope} over ${args.from} to ${args.to} (${formatDuration(windowMs)}): ${refusal.reason}.`;
  const second = refusal.estimatedEvents !== undefined
    ? `Reporter-estimated event count for this window is ${fmtCount(refusal.estimatedEvents)}, which exceeds the Lambda budget.`
    : `The estimator could not bound the window cost safely.`;
  const third = `Recommendation: ${refusal.recommendation}`;
  return `${first} ${second} ${third}`;
}

function formatDuration(ms: number): string {
  const d = ms / 86_400_000;
  if (d >= 1) return `${d.toFixed(1)}d`;
  const h = ms / 3_600_000;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const m = ms / 60_000;
  return `${m.toFixed(1)}m`;
}

