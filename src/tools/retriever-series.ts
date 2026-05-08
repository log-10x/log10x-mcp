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
import { renderNextActions, type NextAction } from '../lib/next-actions.js';

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
};

interface SeriesPoint {
  bucket: string;
  group?: string;
  count: number;
}

export async function executeRetrieverSeries(
  args: {
    pattern?: string;
    search?: string;
    from: string;
    to: string;
    filters?: string[];
    target?: string;
    bucket_size: string;
    group_by?: string;
    fidelity: string;
    environment?: string;
  },
  env: EnvConfig
): Promise<string> {
  if (!isRetrieverConfigured()) {
    return retrieverNotConfiguredMessage();
  }

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
    return renderRefusal(decision, args, windowMs);
  }

  const startedMs = Date.now();
  const result =
    decision.mode === 'full'
      ? await executeFullMode(env, args, fromMs, toMs)
      : await executeSampledMode(env, args, fromMs, toMs, decision.subWindows!, decision.eventsPerSubWindow!);

  const wallTimeMs = Date.now() - startedMs;
  return renderSeries(result, decision, args, wallTimeMs, windowMs);
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

// ─── Renderers ───────────────────────────────────────────────────────────

function renderSeries(
  result: SeriesResult,
  decision: FidelityDecision,
  args: { from: string; to: string; bucket_size: string; group_by?: string; search?: string; pattern?: string },
  wallTimeMs: number,
  windowMs: number
): string {
  const lines: string[] = [];
  lines.push(`## Retriever Series`);
  lines.push('');
  lines.push(`**Window**: ${args.from} → ${args.to} (${formatDuration(windowMs)})`);
  if (args.pattern) {
    lines.push(`**Pattern**: \`${args.pattern}\` (auto-translated to \`${args.search}\`)`);
  } else if (args.search) {
    lines.push(`**Search**: \`${args.search}\``);
  }
  if (args.group_by) lines.push(`**Group by**: \`${args.group_by}\``);
  lines.push(`**Bucket**: ${args.bucket_size}`);
  lines.push('');

  // Mode + reasoning block.
  lines.push(`### Mode: \`${decision.mode}\``);
  lines.push(`**Reason**: ${humanizeReason(decision.reason)}`);
  if (decision.estimatedEvents !== undefined) {
    lines.push(`**Estimated events in window**: ${fmtCount(decision.estimatedEvents)}`);
  }
  if (decision.estimatedBytes !== undefined) {
    lines.push(`**Estimated fetch**: ${formatBytes(decision.estimatedBytes)}`);
  }
  if (decision.reporter?.note) {
    lines.push(`**Reporter note**: ${decision.reporter.note}`);
  } else if (decision.reporter?.pattern) {
    lines.push(
      `**Reporter pattern**: \`${decision.reporter.pattern}\` · ${
        decision.reporter.rateEventsPerMinute !== undefined
          ? `${fmtCount(Math.round(decision.reporter.rateEventsPerMinute))} events/min`
          : 'rate unknown'
      }${
        decision.reporter.bytesPerEvent !== undefined
          ? ` · ${formatBytes(decision.reporter.bytesPerEvent)}/event`
          : ''
      }`
    );
  }
  if (decision.mode === 'per_window_sampled') {
    lines.push(
      `**Sampling**: ${decision.subWindows} sub-windows × ${decision.eventsPerSubWindow} events/sub-window (max ${
        (decision.subWindows ?? 0) * (decision.eventsPerSubWindow ?? 0)
      } total)`
    );
  }
  lines.push('');

  // Execution stats.
  lines.push(`### Execution`);
  lines.push(
    `- **Events processed**: ${fmtCount(result.actualEvents)}` +
      (result.truncated ? ' _(some workers truncated)_' : '')
  );
  lines.push(`- **Worker files**: ${result.workerFiles}`);
  lines.push(`- **Wall time**: ${wallTimeMs}ms`);
  if (result.groupCardinality > 0) {
    lines.push(
      `- **Group cardinality**: ${result.groupCardinality}` +
        (result.groupCardinality > TOP_K_GROUPS ? ` _(top ${TOP_K_GROUPS} kept; tail in_ \`_other_\`)` : '')
    );
  }
  lines.push('');

  // Series body.
  if (result.series.length === 0) {
    lines.push(
      '_Series is empty — no events with parseable timestamps. Verify the search expression matches and the window covers actual ingest._'
    );
  } else {
    lines.push(`### Series (${result.series.length} points)`);
    lines.push('');
    if (args.group_by) {
      // Top-K table per bucket — just dump as a flat list ordered by bucket then count.
      lines.push('```');
      lines.push(`bucket                      group                                 count`);
      for (const p of result.series.slice(0, 200)) {
        lines.push(
          `${p.bucket.slice(0, 19).padEnd(20)}  ${(p.group ?? '').padEnd(40).slice(0, 40)}  ${String(p.count).padStart(8)}`
        );
      }
      if (result.series.length > 200) {
        lines.push(`... (${result.series.length - 200} additional rows omitted)`);
      }
      lines.push('```');
    } else {
      const max = result.series.reduce((m, p) => Math.max(m, p.count), 0);
      lines.push('```');
      for (const p of result.series.slice(0, 80)) {
        const bar = max > 0 ? renderBar(p.count / max, 30) : '';
        lines.push(`${p.bucket.slice(0, 19)}  ${String(p.count).padStart(8)}  ${bar}`);
      }
      if (result.series.length > 80) {
        lines.push(`... (${result.series.length - 80} additional buckets omitted)`);
      }
      lines.push('```');
    }
  }
  lines.push('');

  // Fidelity caveats.
  if (decision.mode === 'per_window_sampled') {
    const k = decision.eventsPerSubWindow ?? 0;
    const n = decision.subWindows ?? 0;
    lines.push(`### Fidelity notes`);
    lines.push(
      `- **Time-distribution**: preserved by construction. Each of the ${n} sub-windows contributed up to ${k} events independently — the shape of the series reflects sub-window-relative rate variation.`
    );
    if (args.group_by) {
      lines.push(
        `- **Group ranking**: dominant ${args.group_by} values are ranked reliably. Groups with very few events in the window may be absent from any sub-window's sample. For exact tail visibility, narrow the query or use \`fidelity: "full"\` if the volume permits.`
      );
    }
    lines.push(
      `- **Bucket counts**: estimates, not exact. To upper-bound the absolute scale, multiply each bucket's count by (estimated events in that sub-window / events sampled from that sub-window).`
    );
    if (result.subWindowResults && result.subWindowResults.some((s) => s.eventsFetched < k)) {
      const underfilled = result.subWindowResults.filter((s) => s.eventsFetched < k).length;
      lines.push(
        `- **Underfilled sub-windows**: ${underfilled}/${n} sub-windows returned fewer than K events, meaning the pattern's actual volume in those time slices is below the budget — counts there are exact, not sampled.`
      );
    }
  } else if (decision.reason === 'window_length_short_fallback') {
    lines.push(
      `_Mode chosen via window-length fallback (Reporter had no per-pattern volume signal for this query). Counts are exact._`
    );
  }

  // Structured NEXT_ACTIONS for autonomous chains. The natural follow-up
  // after a series is to backfill the metric into a TSDB so dashboards /
  // alerts can use it ongoing. Only emit when a pattern arg was supplied
  // (the typical autonomous-chain path); free-form search expressions don't
  // round-trip cleanly into backfill_metric without further translation.
  const nextActions: NextAction[] = [];
  if (args.pattern && result.actualEvents > 0) {
    nextActions.push({
      tool: 'log10x_backfill_metric',
      args: {
        pattern: args.pattern,
        metric_name: `log10x.${args.pattern.toLowerCase()}_count`,
        destination: 'datadog',
        from: args.from,
        to: args.to,
        bucket_size: args.bucket_size,
      },
      reason: 'create a TSDB metric from this series so dashboards / alerts can consume it',
    });
  }
  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);
  return lines.join('\n');
}

function renderRefusal(
  refusal: RefusalDecision,
  args: { from: string; to: string; search?: string; pattern?: string },
  windowMs: number
): string {
  const lines: string[] = [];
  lines.push(`## Retriever Series — Refused`);
  lines.push('');
  lines.push(`**Window**: ${args.from} → ${args.to} (${formatDuration(windowMs)})`);
  if (args.pattern) {
    lines.push(`**Pattern**: \`${args.pattern}\` (auto-translated to \`${args.search}\`)`);
  } else if (args.search) {
    lines.push(`**Search**: \`${args.search}\``);
  }
  lines.push('');
  lines.push(`**Reason**: \`${refusal.reason}\``);
  if (refusal.estimatedEvents !== undefined) {
    lines.push(`**Estimated events**: ${fmtCount(refusal.estimatedEvents)}`);
  }
  if (refusal.estimatedBytes !== undefined) {
    lines.push(`**Estimated fetch**: ${formatBytes(refusal.estimatedBytes)}`);
  }
  lines.push('');
  lines.push(`**Recommendation**: ${refusal.recommendation}`);
  return lines.join('\n');
}

function humanizeReason(r: string): string {
  switch (r) {
    case 'estimated_events_under_threshold':
      return 'Reporter-estimated event count fits the full-aggregation budget.';
    case 'estimated_events_exceeded_threshold':
      return 'Reporter-estimated event count exceeds the full-aggregation budget — sampling per sub-window.';
    case 'estimated_bytes_exceeded_threshold':
      return 'Reporter-estimated fetch size exceeds the full-aggregation budget — sampling per sub-window.';
    case 'window_length_short_fallback':
      return 'No Reporter pattern signal; window short enough to attempt full aggregation.';
    case 'window_length_long_fallback':
      return 'No Reporter pattern signal; window long enough that sampling is the safer default.';
    case 'pattern_volume_unknown_fallback':
      return 'No Reporter pattern signal — fallback to window-length heuristic.';
    case 'forced_full':
      return 'User forced `fidelity: "full"`.';
    case 'forced_per_window_sampled':
      return 'User forced `fidelity: "per_window_sampled"`.';
    default:
      return r;
  }
}

function formatDuration(ms: number): string {
  const d = ms / 86_400_000;
  if (d >= 1) return `${d.toFixed(1)}d`;
  const h = ms / 3_600_000;
  if (h >= 1) return `${h.toFixed(1)}h`;
  const m = ms / 60_000;
  return `${m.toFixed(1)}m`;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}

function renderBar(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
