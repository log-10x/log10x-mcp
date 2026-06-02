/**
 * log10x_pattern_detail — L4 surface.
 *
 * Composes a full single-pattern view by calling three internal helpers:
 *   1. event_lookup   — identity, first_seen, per-service cost breakdown
 *   2. pattern_trend  — time series for the lineChart() render
 *   3. pattern_examples — sample events from the SIEM (when available)
 *
 * must_render_verbatim:
 *   - "Pattern X" header (descriptor, not hash)
 *   - lineChart() output from src/lib/line-chart.ts (height up to 12 rows)
 *   - BarRow chart (ASCII horizontal bars) for cross-service distribution
 *   - Severity breakdown
 *   - 3-5 sample events truncated to 120 chars each
 *
 * must_ask_user: "Back to preview list" or "Apply with this in the picture".
 *
 * Data sources: event_lookup (TSDB + optional SIEM), pattern_trend (TSDB),
 * pattern_examples (SIEM connector, skipped gracefully when unavailable).
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { loadEnvironments } from '../lib/environments.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { queryInstant, queryRange } from '../lib/api.js';
import { LABELS } from '../lib/promql.js';
import { parsePrometheusValue } from '../lib/cost.js';
import { lineChart } from '../lib/line-chart.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const patternDetailSchema = {
  pattern_hash: z
    .string()
    .describe('The tenx_hash of the pattern to drill into. Obtained from log10x_preview_filter data.patterns[].tenx_hash.'),
  include_samples: z
    .boolean()
    .default(true)
    .describe('When true (default), attempts to fetch 3-5 sample events from the SIEM. Set false to skip the SIEM round-trip.'),
  environment: z.string().optional().describe('Environment nickname for multi-env setups.'),
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface PatternDetailEnvelope {
  pattern_hash: string;
  /** Resolved pattern name (Symbol Message). Null if not resolvable from metrics. */
  pattern_name: string | null;
  /** Per-service bytes breakdown. */
  services: Array<{
    service: string;
    severity: string;
    bytes: number;
    share_pct: number;
  }>;
  total_bytes: number;
  first_seen_age_seconds: number | null;
  /** Bytes/sec time series (24h, 10min step). */
  trend_time_series: Array<{ ts: number; bytes_per_sec: number }>;
  /** Sample events truncated to 120 chars each. */
  sample_events: string[];
  must_render_verbatim: string;
  must_ask_user: { question: string; options: string[] };
}

// ─── ASCII horizontal bar chart ───────────────────────────────────────────────

/**
 * Plain-text horizontal bar chart for cross-service distribution.
 * No external dependency — builds from scratch using Unicode block chars.
 * Max bar width: 30 columns.
 */
function renderAsciiBarChart(
  rows: Array<{ label: string; value: number }>,
  title: string,
  maxBarWidth = 30,
): string {
  if (rows.length === 0) return '';
  const maxVal = Math.max(...rows.map((r) => r.value)) || 1;
  const labelW = Math.max(...rows.map((r) => r.label.length), title.length);
  const lines: string[] = [title, '-'.repeat(labelW + maxBarWidth + 4)];
  for (const r of rows) {
    const barLen = Math.round((r.value / maxVal) * maxBarWidth);
    const bar = '█'.repeat(barLen) + '░'.repeat(maxBarWidth - barLen);
    const fmtVal =
      r.value >= 1024 ** 3
        ? `${(r.value / (1024 ** 3)).toFixed(1)}GB`
        : r.value >= 1024 ** 2
          ? `${(r.value / (1024 ** 2)).toFixed(0)}MB`
          : `${(r.value / 1024).toFixed(0)}KB`;
    lines.push(`${r.label.padEnd(labelW)}  ${bar}  ${fmtVal}`);
  }
  return lines.join('\n');
}

// ─── Probe helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the pattern name (Symbol Message) from the tenx_hash via TSDB.
 * Returns the most-emitting pattern label for this hash over 7d.
 */
async function resolvePatternName(
  env: EnvConfig,
  hash: string,
): Promise<string | null> {
  try {
    const metricsEnv = await resolveMetricsEnv(env);
    const q =
      `topk(1, sum by (${LABELS.pattern}) (increase(all_events_summaryBytes_total{` +
      `${LABELS.hash}="${hash.replace(/"/g, '\\"')}",` +
      `${LABELS.env}="${metricsEnv}"}[7d])))`;
    const res = await queryInstant(env, q);
    if (res.status === 'success' && res.data.result.length > 0) {
      return res.data.result[0].metric[LABELS.pattern] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch per-service breakdown for this hash over 30d. */
async function fetchServiceBreakdown(
  env: EnvConfig,
  hash: string,
): Promise<Array<{ service: string; severity: string; bytes: number; share_pct: number }>> {
  try {
    const metricsEnv = await resolveMetricsEnv(env);
    const q =
      `sum by (${LABELS.service}, ${LABELS.severity}) ` +
      `(increase(all_events_summaryBytes_total{` +
      `${LABELS.hash}="${hash.replace(/"/g, '\\"')}",` +
      `${LABELS.env}="${metricsEnv}"}[30d]))`;
    const res = await queryInstant(env, q);
    if (res.status !== 'success' || res.data.result.length === 0) return [];
    const rows = res.data.result.map((r) => ({
      service: r.metric[LABELS.service] || '(unattributed)',
      severity: r.metric[LABELS.severity] || '',
      bytes: parsePrometheusValue(r),
    }));
    rows.sort((a, b) => b.bytes - a.bytes);
    const total = rows.reduce((s, r) => s + r.bytes, 0);
    return rows.map((r) => ({
      ...r,
      share_pct: total > 0 ? (r.bytes / total) * 100 : 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch first-seen age for this hash.
 * Reuses the same approach as fetchFirstSeenBatch but for a single hash.
 */
async function fetchFirstSeen(env: EnvConfig, hash: string): Promise<number | null> {
  try {
    // Importing fetchFirstSeenBatch as a batch call for a single item
    const { fetchFirstSeenBatch } = await import('../lib/first-seen.js');
    const m = await fetchFirstSeenBatch(env, [hash]);
    return m.get(hash)?.ageSeconds ?? null;
  } catch {
    return null;
  }
}

/** Fetch 24h trend (bytes/sec) for this hash at 10-minute resolution. */
async function fetchTrend(
  env: EnvConfig,
  hash: string,
): Promise<Array<{ ts: number; bytes_per_sec: number }>> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 24 * 3600;
    const step = 600; // 10 minutes
    const q =
      `sum by (${LABELS.hash}) ` +
      `(rate(all_events_summaryBytes_total{` +
      `${LABELS.hash}="${hash.replace(/"/g, '\\"')}"}[5m]))`;
    const res = await queryRange(env, q, start, now, step);
    if (res.status !== 'success' || res.data.result.length === 0) return [];
    return (res.data.result[0].values as [number, string][]).map(([ts, v]) => ({
      ts,
      bytes_per_sec: Number.isFinite(Number(v)) ? Number(v) : 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Best-effort: fetch 3-5 sample events from the SIEM for this hash.
 * Uses the same fetchEventsByHashes path that top_patterns uses.
 * Returns empty array when no SIEM is configured or query fails.
 */
async function fetchSampleEvents(
  hash: string,
  patternName: string | null,
): Promise<string[]> {
  try {
    const { fetchEventsByHashes } = await import('../lib/siem/sample.js');
    const results = await fetchEventsByHashes(
      [{ hash, service: undefined as unknown as string, severity: undefined as unknown as string }],
      { perHash: 5 },
    );
    const events = results.get(hash) ?? [];
    return events.slice(0, 5).map((e) => {
      const line = typeof e === 'string' ? e : ((e as unknown) as Record<string, string>)?.message ?? String(e);
      return line.slice(0, 120);
    });
  } catch {
    return [];
  }
}

// ─── Verbatim renderer ─────────────────────────────────────────────────────────

function renderVerbatim(args: {
  patternName: string | null;
  hash: string;
  services: Array<{ service: string; severity: string; bytes: number; share_pct: number }>;
  totalBytes: number;
  firstSeenAgeSeconds: number | null;
  trendSeries: Array<{ ts: number; bytes_per_sec: number }>;
  sampleEvents: string[];
}): string {
  const { patternName, hash, services, totalBytes, firstSeenAgeSeconds, trendSeries, sampleEvents } = args;

  const lines: string[] = [];

  // Header — descriptor (name), not hash
  const displayName = patternName ?? `(hash: ${hash.slice(0, 16)})`;
  lines.push(`Pattern: ${displayName}`);
  if (firstSeenAgeSeconds !== null) {
    const days = Math.round(firstSeenAgeSeconds / 86400);
    lines.push(`First seen: ${days} day${days !== 1 ? 's' : ''} ago`);
  }
  lines.push('');

  // lineChart — larger view, up to 12 rows tall
  const bytesPerSecVals = trendSeries.map((p) => p.bytes_per_sec);
  const chart = lineChart(bytesPerSecVals, {
    widthCap: 60,
    maxTotalWidth: 72,
    spanSeconds: 24 * 3600,
  });
  if (chart) {
    lines.push('Volume trend (24h)');
    lines.push(chart);
    lines.push('');
  }

  // Cross-service distribution bar chart (top 8 services)
  if (services.length > 0) {
    const topSvcs = services.slice(0, 8).map((s) => ({
      label: `${s.service}${s.severity ? ` [${s.severity}]` : ''}`.slice(0, 28),
      value: s.bytes,
    }));
    const barChart = renderAsciiBarChart(topSvcs, 'Service distribution (30d)', 28);
    if (barChart) {
      lines.push(barChart);
      lines.push('');
    }
  }

  // Severity breakdown
  const sevMap = new Map<string, number>();
  for (const s of services) {
    const k = s.severity || '(none)';
    sevMap.set(k, (sevMap.get(k) ?? 0) + s.bytes);
  }
  if (sevMap.size > 0) {
    const sevParts = [...sevMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sev, bytes]) => {
        const pct = totalBytes > 0 ? ((bytes / totalBytes) * 100).toFixed(0) : '?';
        const gb = (bytes / (1024 ** 3)).toFixed(2);
        return `${sev}: ${gb}GB (${pct}%)`;
      });
    lines.push(`Severity breakdown: ${sevParts.join('  |  ')}`);
    lines.push('');
  }

  // Sample events
  if (sampleEvents.length > 0) {
    lines.push(`Sample events (${sampleEvents.length} shown, truncated to 120 chars):`);
    sampleEvents.forEach((evt, i) => {
      lines.push(`  ${i + 1}. ${evt}`);
    });
    lines.push('');
  } else {
    lines.push('Sample events: not available (no SIEM connector configured, or pattern not active in the last hour).');
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Entry function ─────────────────────────────────────────────────────────────

export async function executePatternDetail(args: {
  pattern_hash: string;
  include_samples?: boolean;
  environment?: string;
}): Promise<StructuredOutput> {
  const includeSamples = args.include_samples !== false;

  let env: EnvConfig | undefined;
  try {
    const envs = await loadEnvironments();
    env = envs.default;
  } catch {
    env = undefined;
  }

  if (!env) {
    return buildEnvelope({
      tool: 'log10x_pattern_detail',
      view: 'summary',
      summary: { headline: `pattern_detail(${args.pattern_hash.slice(0, 12)}): no environment configured.` },
      data: {
        pattern_hash: args.pattern_hash,
        error: 'no environment configured',
      },
    });
  }

  // Fetch all data in parallel
  const [patternName, services, firstSeenAgeSeconds, trendSeries] = await Promise.all([
    resolvePatternName(env, args.pattern_hash),
    fetchServiceBreakdown(env, args.pattern_hash),
    fetchFirstSeen(env, args.pattern_hash),
    fetchTrend(env, args.pattern_hash),
  ]);

  const sampleEvents: string[] = includeSamples
    ? await fetchSampleEvents(args.pattern_hash, patternName)
    : [];

  const totalBytes = services.reduce((s, r) => s + r.bytes, 0);

  const verbatim = renderVerbatim({
    patternName,
    hash: args.pattern_hash,
    services,
    totalBytes,
    firstSeenAgeSeconds,
    trendSeries,
    sampleEvents,
  });

  const mustAskUser = {
    question: 'What next?',
    options: [
      'Back — return to the preview list',
      'Apply — proceed with applying the mode to this pattern',
    ],
  };

  const headline =
    `pattern_detail(${patternName ?? args.pattern_hash.slice(0, 12)}): ` +
    `${services.length} service(s), ${(totalBytes / (1024 ** 3)).toFixed(2)} GB/mo (30d). ` +
    `${sampleEvents.length} sample event(s) fetched.`;

  const envelope: PatternDetailEnvelope = {
    pattern_hash: args.pattern_hash,
    pattern_name: patternName,
    services,
    total_bytes: totalBytes,
    first_seen_age_seconds: firstSeenAgeSeconds,
    trend_time_series: trendSeries,
    sample_events: sampleEvents,
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
  };

  return buildEnvelope({
    tool: 'log10x_pattern_detail',
    view: 'summary',
    summary: { headline },
    data: envelope,
    actions: [
      {
        tool: 'log10x_preview_filter',
        args: {},
        reason: 'Back — return to the preview list',
        role: 'alternative',
      },
      {
        tool: 'log10x_configure_engine',
        args: { service: patternName ?? args.pattern_hash },
        reason: 'Apply with this pattern in the picture',
        role: 'alternative',
      },
    ],
  });
}

// ─── Test exports ─────────────────────────────────────────────────────────────

/** Exported for unit tests only. */
export const __testables = {
  renderAsciiBarChart,
};
