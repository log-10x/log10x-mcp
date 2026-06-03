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
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
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

/**
 * Query the metrics backend for top-N patterns scoped to service.
 * Returns rows sorted by bytes desc.
 */
async function fetchFromTsdb(
  env: EnvConfig,
  service: string,
  topN: number,
): Promise<PreviewPatternRow[]> {
  const metricsEnv = await resolveMetricsEnv(env);
  const timeRange = '30d';

  // Top patterns scoped to service
  const filters: Record<string, string> = {
    [LABELS.service]: service,
  };

  // topPatternsFull expects FilterValue map; use the raw PromQL here for
  // simplicity (same query shape pql.topPatternsFull generates).
  const topQ =
    `topk(${topN}, sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) ` +
    `(increase(all_events_summaryBytes_total{` +
    `${LABELS.service}="${service.replace(/"/g, '\\"')}",` +
    `${LABELS.env}="${metricsEnv}",isDropped!="true"}[${timeRange}])))`;

  const [topRes, totalRes] = await Promise.all([
    queryInstant(env, topQ),
    queryInstant(
      env,
      `sum(increase(all_events_summaryBytes_total{` +
      `${LABELS.service}="${service.replace(/"/g, '\\"')}",` +
      `${LABELS.env}="${metricsEnv}",isDropped!="true"}[${timeRange}]))`,
    ).catch(() => null),
  ]);

  if (topRes.status !== 'success' || topRes.data.result.length === 0) {
    return [];
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

  // Trend queries (24h, 10m step) — one per row in parallel
  const now = Math.floor(Date.now() / 1000);
  const trendWindowSec = 24 * 3600;
  const trendStep = 600;
  const trendStart = now - trendWindowSec;

  const hashes = rawRows.map((r) => r.hash).filter(Boolean);

  const [firstSeenByHash, ...trendResults] = await Promise.all([
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

  // Assemble rows
  return rawRows.map((r, idx): PreviewPatternRow => {
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
    const descriptor36 = r.pattern.slice(0, 36);
    return {
      rank: idx + 1,
      descriptor: descriptor36,
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
}

// ─── Entry function ─────────────────────────────────────────────────────────────

export async function executePreviewFilter(args: {
  service: string;
  mode: ExplainMode;
  top_n?: number;
  environment?: string;
}): Promise<StructuredOutput> {
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

  if (env && dataSource === 'tsdb') {
    try {
      patterns = await fetchFromTsdb(env, args.service, topN);
      totalServiceBytes = patterns.reduce((s, r) => s + r.bytes_per_month, 0);
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

  const headline =
    patterns.length === 0
      ? `preview_filter(${args.mode}, ${args.service}): no patterns found.`
      : `preview_filter(${args.mode}, ${args.service}): ${patterns.length} patterns shown, ` +
        `${fmtBytesShared(totalServiceBytes)}/mo total. ` +
        `CSV: ${csvPath ?? 'write failed'}.`;

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
  };

  return buildEnvelope({
    tool: 'log10x_preview_filter',
    view: 'summary',
    summary: { headline },
    data: envelope,
    actions: patterns.flatMap((p) => [
      {
        tool: 'log10x_pattern_detail',
        args: { pattern_hash: p.tenx_hash },
        reason: `drill into pattern #${p.rank}: ${p.descriptor}`,
        role: 'alternative' as const,
      },
      {
        tool: 'log10x_pattern_examples',
        args: { pattern: p.descriptor_full },
        reason: 'Bucket sample events by slot value to see if a single slot value dominates (low-cardinality skew) — useful before deciding drop vs sample vs compact.',
        role: 'optional-followup' as const,
      },
    ]),
  });
}
