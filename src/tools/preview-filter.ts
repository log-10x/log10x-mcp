/**
 * log10x_preview_filter — L3b surface.
 *
 * Shows the list of patterns that would be affected by applying a given
 * enforcement mode to a service — BEFORE any action is taken.
 *
 * Output:
 *   data.patterns[]     — structured per-pattern array for agent consumption.
 *   must_render_verbatim — fixed-width plain-text table (NOT a markdown table).
 *                          Columns: #, Descriptor (36 chars), Volume, %,
 *                          Service, Severity, First seen, Trend (sparkline).
 *   must_ask_user       — "Drill into a pattern (give number)", "Apply",
 *                         "Pick different mode".
 *   forbidden_next_actions — apply tools locked until user commits.
 *
 * Side effect: writes the full data as CSV to
 *   /tmp/log10x-preview-<mode>-<service>.csv
 * (overwrite-in-place each call).
 *
 * Data source routing:
 *   - Reporter/Receiver/Retriever tier (TSDB available): top_patterns scoped
 *     to service.
 *   - Dev / no-TSDB tier: poc_from_siem path via log10x_poc_from_siem.
 *   Customer sees the same output shape either way.
 *
 * routes_to drill: log10x_pattern_detail with the selected tenx_hash.
 */

import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import type { EnvConfig } from '../lib/environments.js';
import { loadEnvironments } from '../lib/environments.js';
import { queryInstant, queryRange } from '../lib/api.js';
import { LABELS } from '../lib/promql.js';
import * as pql from '../lib/promql.js';
import { parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { tenxHash } from '../lib/pattern-hash.js';
import { fetchFirstSeenBatch } from '../lib/first-seen.js';
import { sparkline } from '../lib/line-chart.js';
import { type StructuredOutput } from '../lib/output-types.js';
import {
  buildChassisEnvelope,
  newChassisTelemetry,
  recordQuery,
} from '../lib/chassis-envelope.js';
import { fmtBytes as fmtBytesShared } from '../lib/format.js';
import { EXPLAIN_MODES, type ExplainMode } from './explain-mode.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const previewFilterSchema = {
  service: z
    .string()
    .describe('Service to scope the preview to.'),
  mode: z
    .enum(EXPLAIN_MODES)
    .describe('The enforcement mode being previewed. Controls which patterns are highlighted as affected.'),
  top_n: z
    .number()
    .min(1)
    .max(50)
    .default(20)
    .describe('Number of patterns to surface. Default 20.'),
  environment: z.string().optional().describe('Environment nickname for multi-env setups.'),
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface PreviewPatternRow {
  rank: number;
  /** Descriptor truncated to 36 chars for table display. */
  descriptor: string;
  /** Full descriptor (un-truncated) for agent use. */
  descriptor_full: string;
  tenx_hash: string;
  bytes_per_month: number;
  percent_of_service: number;
  service: string;
  severity: string;
  /** Human-readable relative age, e.g. "3 days ago". Null when unknown. */
  first_seen_relative: string | null;
  /** Raw trend data (bytes/sec) for sparkline rendering. */
  trend_data: number[];
  /** 8-char sparkline string. */
  trend_sparkline: string;
}

export interface PreviewFilterEnvelope {
  service: string;
  mode: ExplainMode;
  patterns: PreviewPatternRow[];
  total_service_bytes_per_month: number;
  must_render_verbatim: string;
  must_ask_user: { question: string; options: string[] };
  forbidden_next_actions: string[];
  csv_path: string | null;
  data_source: 'tsdb' | 'poc_siem';
  /**
   * Pattern-universe count (all distinct patterns with nonzero bytes in the 30d
   * window, not just top_n shown). Null when the TSDB query failed or not available.
   */
  pattern_count_total: number | null;
  /**
   * Provenance of the bytes data — allows an agent to explain why two tools
   * show different numbers when called with different windows or cohorts.
   */
  bytes_source: {
    metric: string;
    observation_window: string;
    cohort: 'kept';
    scope_filter: string;
  } | null;
}

// ─── Fixed-width table renderer ───────────────────────────────────────────────

/**
 * Renders a plain-text fixed-width table.
 * NOT a markdown table — no pipes, no dashes header row.
 * Columns: #, Descriptor, Volume, %, Service, Severity, First seen, Trend
 */
function renderFixedWidthTable(
  rows: PreviewPatternRow[],
  service: string,
  mode: ExplainMode,
): string {
  // Column widths
  const COL_RANK = 3;
  const COL_DESC = 36;
  const COL_VOLUME = 10;
  const COL_PCT = 6;
  const COL_SERVICE = 18;
  const COL_SEV = 8;
  const COL_FIRST = 12;
  const COL_TREND = 8;

  const pad = (s: string, w: number): string => s.slice(0, w).padEnd(w, ' ');
  const padL = (s: string, w: number): string => s.slice(0, w).padStart(w, ' ');

  const fmtBytes = (b: number): string => {
    if (b >= 1024 ** 3) return `${(b / (1024 ** 3)).toFixed(1)}GB`;
    if (b >= 1024 ** 2) return `${(b / (1024 ** 2)).toFixed(0)}MB`;
    return `${(b / 1024).toFixed(0)}KB`;
  };

  // Header
  const header = [
    pad('#', COL_RANK),
    pad('Descriptor', COL_DESC),
    padL('Volume', COL_VOLUME),
    padL('%', COL_PCT),
    pad('Service', COL_SERVICE),
    pad('Sev', COL_SEV),
    pad('First seen', COL_FIRST),
    pad('Trend', COL_TREND),
  ].join('  ');

  const separator = '-'.repeat(header.length);

  const dataLines = rows.map((r) => {
    return [
      padL(String(r.rank), COL_RANK),
      pad(r.descriptor, COL_DESC),
      padL(fmtBytes(r.bytes_per_month), COL_VOLUME),
      padL(`${r.percent_of_service.toFixed(1)}%`, COL_PCT),
      pad(r.service, COL_SERVICE),
      pad(r.severity || '-', COL_SEV),
      pad(r.first_seen_relative ?? '-', COL_FIRST),
      r.trend_sparkline,
    ].join('  ');
  });

  const title = `Preview: ${mode} on service "${service}"   (${rows.length} patterns shown)`;

  return [title, separator, header, separator, ...dataLines, separator].join('\n');
}

// ─── CSV writer ───────────────────────────────────────────────────────────────

async function writeCsv(rows: PreviewPatternRow[], mode: ExplainMode, service: string): Promise<string | null> {
  try {
    const safeSvc = service.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const path = `/tmp/log10x-preview-${mode}-${safeSvc}.csv`;
    const header = 'rank,descriptor,tenx_hash,bytes_per_month,percent_of_service,service,severity,first_seen_relative,trend_sparkline';
    const csvRows = rows.map((r) =>
      [
        r.rank,
        `"${r.descriptor_full.replace(/"/g, '""')}"`,
        r.tenx_hash,
        r.bytes_per_month.toFixed(0),
        r.percent_of_service.toFixed(2),
        `"${r.service}"`,
        `"${r.severity}"`,
        `"${r.first_seen_relative ?? ''}"`,
        `"${r.trend_sparkline}"`,
      ].join(',')
    );
    await writeFile(path, [header, ...csvRows].join('\n'), 'utf8');
    return path;
  } catch {
    return null;
  }
}

// ─── Relative age formatter ───────────────────────────────────────────────────

function fmtRelativeAge(ageSeconds: number | null): string | null {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return null;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86400) return `${Math.round(ageSeconds / 3600)}h ago`;
  if (ageSeconds < 86400 * 30) return `${Math.round(ageSeconds / 86400)}d ago`;
  return `${Math.round(ageSeconds / (86400 * 30))}mo ago`;
}

// ─── TSDB data path ───────────────────────────────────────────────────────────

interface TsdbResult {
  rows: PreviewPatternRow[];
  patternCountTotal: number | null;
  /** Full-service byte total from the totalRes query (covers all patterns,
   * not just the top-N slice). Use this for total_service_bytes_per_month. */
  totalServiceBytes: number;
  /** Sum of bytes for the top-N rows shown. Subset of totalServiceBytes. */
  shownBytes: number;
  metricsEnv: string;
  scopeFilter: string;
  timeRange: string;
}

/**
 * Query the metrics backend for top-N patterns scoped to service.
 * Returns rows sorted by bytes desc plus metadata for the bytes_source envelope field.
 */
async function fetchFromTsdb(
  env: EnvConfig,
  service: string,
  topN: number,
): Promise<TsdbResult> {
  const metricsEnv = await resolveMetricsEnv(env);
  const timeRange = '30d';

  // Scope selector — kept cohort, isDropped absence-tolerant.
  const escapedService = service.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const scopeFilter = `${LABELS.service}="${escapedService}",${LABELS.env}="${metricsEnv}",isDropped!="true"`;

  // Top patterns scoped to service
  const topQ =
    `topk(${topN}, sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) ` +
    `(increase(all_events_summaryBytes_total{${scopeFilter}}[${timeRange}])))`;

  // Distinct pattern count for the pattern_count_total envelope field.
  const distinctQ = pql.distinctPatternCount(
    { [LABELS.service]: service, isDropped: { op: '!=', val: 'true' } },
    metricsEnv,
    timeRange,
  );

  const [topRes, totalRes, distinctRes] = await Promise.all([
    queryInstant(env, topQ),
    queryInstant(
      env,
      `sum(increase(all_events_summaryBytes_total{${scopeFilter}}[${timeRange}]))`,
    ).catch(() => null),
    queryInstant(env, distinctQ).catch(() => null),
  ]);

  if (topRes.status !== 'success' || topRes.data.result.length === 0) {
    return {
      rows: [],
      patternCountTotal: null,
      totalServiceBytes: 0,
      shownBytes: 0,
      metricsEnv,
      scopeFilter,
      timeRange,
    };
  }

  // Extract distinct pattern count.
  let patternCountTotal: number | null = null;
  if (distinctRes && distinctRes.status === 'success' && distinctRes.data.result.length > 0) {
    const n = parsePrometheusValue(distinctRes.data.result[0]);
    if (Number.isFinite(n) && n > 0) patternCountTotal = Math.round(n);
  }

  interface RawRow {
    pattern: string;
    service: string;
    severity: string;
    bytes: number;
    hash: string;
  }
  const rawRows: RawRow[] = topRes.data.result.map((r): RawRow => {
    const p = r.metric[LABELS.pattern] || '';
    return {
      pattern: p,
      service: r.metric[LABELS.service] || service,
      severity: r.metric[LABELS.severity] || '',
      bytes: parsePrometheusValue(r),
      hash: p ? tenxHash(p) : '',
    };
  });
  rawRows.sort((a, b) => b.bytes - a.bytes);

  const totalBytes =
    totalRes && totalRes.status === 'success' && totalRes.data.result.length > 0
      ? parsePrometheusValue(totalRes.data.result[0])
      : rawRows.reduce((s, r) => s + r.bytes, 0);

  // Trend queries (24h, 10m step) — one per row in parallel.
  // Primary metric: emitted_events_summaryBytes_total (kept/emitted cohort).
  // Fallback: all_events_summaryBytes_total when the primary returns no data
  // (covers patterns present in the volume metric but absent from emitted).
  const now = Math.floor(Date.now() / 1000);
  const trendWindowSec = 24 * 3600;
  const trendStep = 600;
  const trendStart = now - trendWindowSec;

  const hashes = rawRows.map((r) => r.hash).filter(Boolean);

  const [firstSeenByHash, ...primaryTrendResults] = await Promise.all([
    fetchFirstSeenBatch(env, hashes),
    ...rawRows.map((r) =>
      r.hash
        ? queryRange(
            env,
            `sum by (${LABELS.hash}) (rate(emitted_events_summaryBytes_total{${LABELS.hash}="${r.hash}"}[5m]))`,
            trendStart,
            now,
            trendStep,
          ).catch(() => null)
        : Promise.resolve(null),
    ),
  ]);

  // Fallback: for rows with no primary data, query all_events_summaryBytes_total.
  const fallbackNeeded = rawRows.map((r, idx) => {
    const res = primaryTrendResults[idx];
    return r.hash && (res === null || res.status !== 'success' || !res.data.result[0]?.values?.length);
  });
  const fallbackResults = await Promise.all(
    rawRows.map((r, idx) =>
      fallbackNeeded[idx]
        ? queryRange(
            env,
            `sum by (${LABELS.hash}) (rate(all_events_summaryBytes_total{${LABELS.hash}="${r.hash}"}[5m]))`,
            trendStart,
            now,
            trendStep,
          ).catch(() => null)
        : Promise.resolve(null),
    ),
  );

  // Merge: prefer primary; use fallback when primary has no data.
  const trendResults = primaryTrendResults.map((primary, idx) => {
    if (primary && primary.status === 'success' && primary.data.result[0]?.values?.length) return primary;
    return fallbackResults[idx] ?? primary;
  });

  // Assemble rows (descriptor disambiguation applied below)
  const rawAssembled = rawRows.map((r, idx) => {
    const fsRes = firstSeenByHash.get(r.hash);
    const trendRes = trendResults[idx];
    let trendVals: number[] = [];
    if (trendRes && trendRes.status === 'success' && trendRes.data.result[0]?.values) {
      trendVals = (trendRes.data.result[0].values as [number, string][]).map(([, v]) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      });
    }
    const pctOfService = totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0;
    return {
      rank: idx + 1,
      descriptor_full: r.pattern,
      tenx_hash: r.hash,
      bytes_per_month: r.bytes,
      percent_of_service: pctOfService,
      service: r.service,
      severity: r.severity,
      first_seen_relative: fmtRelativeAge(fsRes?.ageSeconds ?? null),
      trend_data: trendVals,
      trend_sparkline: sparkline(trendVals, 8),
    };
  });

  // Disambiguate descriptors: when two rows share a 36-char prefix, append
  // the last 4 chars of tenx_hash in parens to make each row unique.
  const descriptor36s = rawAssembled.map((r) => r.descriptor_full.slice(0, 36));
  const seenPrefixes = new Map<string, number>();
  for (const d of descriptor36s) seenPrefixes.set(d, (seenPrefixes.get(d) ?? 0) + 1);

  const rows: PreviewPatternRow[] = rawAssembled.map((r) => {
    const prefix = r.descriptor_full.slice(0, 36);
    const needsDisambig = (seenPrefixes.get(prefix) ?? 0) > 1 && r.tenx_hash.length >= 4;
    const descriptor = needsDisambig
      ? `${r.descriptor_full.slice(0, 31)}(${r.tenx_hash.slice(-4)})`
      : prefix;
    return { ...r, descriptor };
  });
  const shownBytes = rows.reduce((s, r) => s + r.bytes_per_month, 0);
  return { rows, patternCountTotal, totalServiceBytes: totalBytes, shownBytes, metricsEnv, scopeFilter, timeRange };
}

// ─── Entry function ─────────────────────────────────────────────────────────────

export async function executePreviewFilter(args: {
  service: string;
  mode: ExplainMode;
  top_n?: number;
  environment?: string;
}): Promise<StructuredOutput> {
  const telemetry = newChassisTelemetry();
  const topN = args.top_n ?? 20;

  let env: EnvConfig | undefined;
  let dataSource: 'tsdb' | 'poc_siem' = 'poc_siem';
  try {
    const envs = await loadEnvironments();
    env = envs.default;
    if (env) dataSource = 'tsdb';
  } catch {
    env = undefined;
  }

  let patterns: PreviewPatternRow[] = [];
  let totalServiceBytes = 0;
  let shownBytesTotal = 0;
  let patternCountTotal: number | null = null;
  let bytesSource: PreviewFilterEnvelope['bytes_source'] = null;

  if (env && dataSource === 'tsdb') {
    try {
      const tsdbResult = await fetchFromTsdb(env, args.service, topN);
      recordQuery(telemetry);
      patterns = tsdbResult.rows;
      patternCountTotal = tsdbResult.patternCountTotal;
      bytesSource = {
        metric: 'all_events_summaryBytes_total',
        observation_window: tsdbResult.timeRange,
        cohort: 'kept',
        scope_filter: tsdbResult.scopeFilter,
      };
      totalServiceBytes = tsdbResult.totalServiceBytes;
      shownBytesTotal = tsdbResult.shownBytes;
    } catch {
      // Fall through to empty result; surface as no-signal
      patterns = [];
    }
  }

  // Write CSV side-effect (best-effort)
  let csvPath: string | null = null;
  if (patterns.length > 0) {
    csvPath = await writeCsv(patterns, args.mode, args.service);
  }

  // Build must_render_verbatim — fixed-width table when data is available,
  // plain message when no patterns found.
  let verbatim: string;
  if (patterns.length === 0) {
    verbatim =
      `Preview: ${args.mode} on service "${args.service}"\n` +
      `No pattern data found. Metrics may not yet be available for this service.\n` +
      `Run log10x_doctor to verify the Reporter is running.`;
  } else {
    verbatim = renderFixedWidthTable(patterns, args.service, args.mode);
    if (csvPath) {
      verbatim += `\n\nFull data written to: ${csvPath}`;
    }
  }

  const mustAskUser = {
    question:
      `What next? Give a pattern number to drill in, type "Apply" to proceed with ${args.mode}, ` +
      `or "Mode" to pick a different approach.`,
    options: [
      '1-N. Drill into pattern #N (calls log10x_pattern_detail)',
      'Apply — proceed with applying this mode',
      'Mode — go back and pick a different mode',
    ],
  };

  const forbiddenNextActions = [
    'log10x_configure_engine',
    'log10x_pattern_mitigate',
    'log10x_advise_retriever',
  ];

  const status = patterns.length === 0 ? 'no_signal' as const : 'success' as const;
  const headline =
    patterns.length === 0
      ? `preview_filter(${args.mode}, ${args.service}): no patterns found.`
      : `preview_filter(${args.mode}, ${args.service}): ${patterns.length} patterns shown, ` +
        `${fmtBytesShared(shownBytesTotal)}/mo shown total (service total: ${fmtBytesShared(totalServiceBytes)}/mo). ` +
        `CSV: ${csvPath ?? 'write failed'}.`;

  const human_summary =
    patterns.length === 0
      ? `No patterns found for service "${args.service}" in mode "${args.mode}". Metrics may not be available yet.`
      : `Top ${patterns.length} patterns matching mode "${args.mode}" for "${args.service}", ${fmtBytesShared(shownBytesTotal)}/mo shown total (${fmtBytesShared(totalServiceBytes)}/mo full service total).`;

  const envelope: PreviewFilterEnvelope = {
    service: args.service,
    mode: args.mode,
    patterns,
    total_service_bytes_per_month: totalServiceBytes,
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
    forbidden_next_actions: forbiddenNextActions,
    csv_path: csvPath,
    data_source: dataSource,
    pattern_count_total: patternCountTotal,
    bytes_source: bytesSource,
  };

  // Top-3 most useful actions only (defect 27: was 40-entry bloat).
  const top3 = patterns.slice(0, 3);

  return buildChassisEnvelope({
    tool: 'log10x_preview_filter',
    view: 'summary',
    headline,
    status,
    decisions: {
      threshold_used: topN,
      threshold_basis: 'customer_supplied',
    },
    source_disclosure: {
      bytes_source: 'tsdb',
      pattern_count_source: patternCountTotal !== null
        ? {
            kind: 'scoped_total_above_threshold',
            count: patternCountTotal,
            denominator_meaning: `All distinct patterns for service "${args.service}" in 30d window`,
          }
        : undefined,
    },
    scope: {
      window: '30d',
      window_basis: 'auto_default',
      candidates_count: patternCountTotal ?? undefined,
      candidates_evaluated: patterns.length,
    },
    payload: envelope,
    human_summary,
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
    forbidden_next_actions: forbiddenNextActions,
    actions: top3.flatMap((p) => [
      {
        tool: 'log10x_pattern_detail',
        args: { pattern_hash: p.tenx_hash },
        reason: `drill into pattern #${p.rank}: ${p.descriptor}`,
        role: 'alternative' as const,
      },
      {
        tool: 'log10x_pattern_examples',
        args: { pattern: p.descriptor_full },
        reason: 'Bucket sample events by slot value to see if a single slot value dominates.',
        role: 'optional-followup' as const,
      },
    ]),
    telemetry,
  });
}
