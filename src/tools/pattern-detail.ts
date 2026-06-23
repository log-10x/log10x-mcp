/**
 * log10x_pattern_detail — L4 surface.
 *
 * Composes a full single-pattern view by calling three internal helpers:
 *   1. event_lookup   — identity, first_seen, per-service cost breakdown
 *   2. pattern_trend  — time series for the lineChart() render
 *   3. pattern_examples — sample events from your stack (when available)
 *
 * must_render_verbatim:
 *   - "Pattern X" header (descriptor, not hash)
 *   - lineChart() output from src/lib/line-chart.ts (height up to 12 rows)
 *   - BarRow chart (ASCII horizontal bars) for cross-service distribution
 *   - Severity breakdown
 *   - up to 3 full sample events (uncropped at 2048 chars; quality over quantity)
 *
 * must_ask_user: "Back to preview list" or "Apply with this in the picture".
 *
 * Data sources: event_lookup (TSDB + optional SIEM), pattern_trend (TSDB),
 * pattern_examples (SIEM connector, skipped gracefully when unavailable).
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { loadEnvironments } from '../lib/environments.js';
import { formatPatternLabelFromServices } from '../lib/pattern-label.js';
import {
  getEnvDfContext,
  buildDisplayName,
  DEFAULT_NAME_WIDTH,
  type DfContext,
  type DisplayToken,
} from '../lib/pattern-df.js';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { queryInstant, queryRange } from '../lib/api.js';
import { LABELS } from '../lib/promql.js';
import { parsePrometheusValue } from '../lib/cost.js';
import { lineChart } from '../lib/line-chart.js';
import { fmtBytes, fmtPct, normalizePattern } from '../lib/format.js';
import { type StructuredOutput } from '../lib/output-types.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  newChassisTelemetry,
  recordQuery,
} from '../lib/chassis-envelope.js';
import { oneLine } from '../lib/siem/sample.js';
import { resolvePatternHashFromMetrics } from '../lib/resolve-pattern-hash.js';
import { resolveVolumeLens, volumeLensDisclosure, type VolumeLensResolution } from '../lib/volume-lens.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export const patternDetailSchema = {
  pattern_hash: z
    .string()
    .optional()
    .describe('The tenx_hash of the pattern to drill into. Obtained from log10x_preview_filter data.patterns[].tenx_hash. Preferred over pattern when available (skips a metrics lookup).'),
  pattern: z
    .string()
    .optional()
    .describe('Pattern name (Symbol Message, e.g. "Payment_Gateway_Timeout") as an alias for pattern_hash. Resolved to hash via metrics lookup. Provide either pattern or pattern_hash.'),
  include_samples: z
    .boolean()
    .default(true)
    .describe('When true (default), attempts to fetch up to 3 full sample events from your stack. Set false to skip the stack round-trip.'),
  timeRange: z
    .string()
    .regex(/^\d+[mhd]$/)
    .default('7d')
    .describe('Time window for the volume trend and sample events lookback. Default 7d. Pattern: ^\\d+[mhd]$.'),
  environment: z.string().optional().describe('Environment nickname for multi-env setups.'),
  monthly_volume_gb: z.number().positive().optional().describe(
    'What-if volume lens (forecast mode): model the environment at THIS monthly volume (decimal GB/month) instead of its measured volume. The real per-pattern shares and pattern mix are held fixed; only absolute bytes and dollars scale, by one uniform factor. Use it to project a prospect onto their own scale, or to forecast a real env after growth. Pairs with siem_lens. This is a PROJECTION: the envelope stamps volume_actual_gb vs volume_projected_gb and the scale factor, and the note points at the POC for the caller real patterns.'
  ),
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface PatternDetailEnvelope {
  pattern_hash: string;
  /** Resolved pattern name (Symbol Message). Null if not resolvable from metrics. */
  pattern_name: string | null;
  /** RENDER-ONLY (Layer 2): discriminator-first display name over the shared
   * env df-map — the SAME label top_patterns shows. Identity is pattern_name. */
  display_name?: string;
  /** RENDER-ONLY: per-token {text, distinctive} classification of pattern_name. */
  display_tokens?: DisplayToken[];
  /** Per-service bytes breakdown. */
  services: Array<{
    service: string;
    severity: string;
    bytes: number;
    bytes_display: string;
    share_pct: number;
    share_pct_display: string;
  }>;
  total_bytes: number;
  total_bytes_display: string;
  first_seen_age_seconds: number | null;
  /** Bytes/sec time series (24h, 10min step). */
  trend_time_series: Array<{ ts: number; bytes_per_sec: number }>;
  /** Full sample events, capped at 2048 chars each. Up to 3 shown. */
  sample_events: string[];
  /**
   * Volume projection lens resolution. {lensed:false,factor:1} on a normal
   * (measured) run — the stamp + headline prefix only fire when lensed.
   */
  volume_lens: VolumeLensResolution;
  must_render_verbatim: string;
  must_ask_user: { question: string; options: string[] };
}

// ─── Descriptor fallback ──────────────────────────────────────────────────────

/**
 * User-facing descriptor for a pattern when we want to avoid echoing a raw
 * hash slice in headlines, headers, or human_summary prose. Preference order:
 *   1. patternName (Symbol Message resolved from metrics)
 *   2. top service from the breakdown (e.g. "checkout-service")
 *   3. fallbackLabel — e.g. "(unnamed pattern)" or "(no metrics in window)"
 *
 * The hash itself stays in the structured payload (pattern_hash) and
 * actions[].args for round-trip identity; this helper is for prose only.
 */
function patternDescriptor(
  patternName: string | null,
  services: Array<{ service: string; severity?: string }>,
  fallbackLabel: string,
  df?: DfContext | null,
): string {
  // Delegates to the shared formatPatternLabelFromServices helper. When a
  // df-context is threaded in, the hint is the discriminator-first
  // display_name (Layer 2) — the SAME label top_patterns shows.
  // See lib/pattern-label.ts for the burned-rule rationale.
  return formatPatternLabelFromServices({
    symbol_message: patternName,
    services: services.map((s) => ({ name: s.service, severity: s.severity })),
    fallback: fallbackLabel,
    df,
  });
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
    // Decimal (SI) byte units to match every other tool's GB/MB rendering
    // (services, baseline, top_patterns all use /1e9). Binary divisors here
    // understated the same byte count by ~6.87% vs the rest of the envelope.
    const fmtVal =
      r.value >= 1e9
        ? `${(r.value / 1e9).toFixed(1)}GB`
        : r.value >= 1e6
          ? `${(r.value / 1e6).toFixed(0)}MB`
          : `${(r.value / 1e3).toFixed(0)}KB`;
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
): Promise<Array<{ service: string; severity: string; bytes: number; bytes_display: string; share_pct: number; share_pct_display: string }>> {
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
      bytes_display: fmtBytes(r.bytes),
      share_pct: total > 0 ? (r.bytes / total) * 100 : 0,
      share_pct_display: fmtPct(total > 0 ? (r.bytes / total) * 100 : 0),
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch the ENV-WIDE total bytes over 30d (the volume-lens basis). MUST be
 * env-wide, not this pattern's own total — scaling against the pattern's own
 * bytes would blow a single pattern up to the whole stated volume. Returns 0
 * on any failure (=> resolveVolumeLens treats it as no_basis).
 */
async function fetchEnvMonthlyBytes(env: EnvConfig, metricsEnv: string): Promise<number> {
  try {
    const q =
      `sum(increase(all_events_summaryBytes_total{` +
      `${LABELS.env}="${metricsEnv}"}[30d]))`;
    const res = await queryInstant(env, q);
    if (res.status !== 'success' || res.data.result.length === 0) return 0;
    const v = parsePrometheusValue(res.data.result[0]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
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

/** Fetch trend (bytes/sec) for this hash at adaptive resolution. */
async function fetchTrend(
  env: EnvConfig,
  hash: string,
  timeRange = '7d',
): Promise<Array<{ ts: number; bytes_per_sec: number }>> {
  try {
    const now = Math.floor(Date.now() / 1000);
    // Parse timeRange to seconds: d=days, h=hours, m=minutes.
    const trMatch = timeRange.match(/^(\d+)([mhd])$/);
    const trSeconds = trMatch
      ? Number(trMatch[1]) * ({ m: 60, h: 3600, d: 86400 } as Record<string, number>)[trMatch[2]]
      : 7 * 86400;
    const start = now - trSeconds;
    // Adaptive step: target ~144 points regardless of window.
    const step = Math.max(300, Math.round(trSeconds / 144));
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
 * Best-effort: fetch up to 3 full sample events from your stack for this hash.
 * Uses the same direct connector pull that pattern_examples uses:
 * no buckets:1 cap, maxPullMinutes:2, and no fetchEventsByHashes wrapper
 * that would limit scan depth on wide windows.
 * Returns { events, siemKind } where siemKind describes the resolution status.
 */
async function fetchSampleEvents(
  hash: string,
  _patternName: string | null,
  window = '7d',
): Promise<{ events: string[]; siemKind: 'resolved' | 'unresolved' }> {
  try {
    const { resolveSiemSelection } = await import('../lib/siem/resolve.js');
    const sel = await resolveSiemSelection({});
    if (sel.kind !== 'resolved') {
      return { events: [], siemKind: 'unresolved' };
    }
    const { getConnector } = await import('../lib/siem/index.js');
    const { buildHashQuery } = await import('../lib/siem/hash-query.js');
    const conn = getConnector(sel.id);
    const q = buildHashQuery(sel.id, hash);
    const probe = await conn.pullEvents({
      window,
      query: q,
      targetEventCount: 3,
      maxPullMinutes: 2,
      onProgress: () => {},
    });
    // Render event bodies from the full event object, not just the first line
    // of raw. oneLine unwraps transport envelopes (.log / .message / .body)
    // before truncating, so multi-line JSON blocks whose SIEM connector
    // delivers the opening "{" as a bare string render via their parent
    // envelope field rather than the bare "{" fragment.
    // Cap raised to 2048 so the user sees the actual log content (fields,
    // error detail, service context) rather than a teaser that ends with "...".
    return {
      events: probe.events.slice(0, 3).map((ev) => oneLine(ev, 2048)),
      siemKind: 'resolved',
    };
  } catch {
    return { events: [], siemKind: 'unresolved' };
  }
}

// ─── Verbatim renderer ─────────────────────────────────────────────────────────

function renderVerbatim(args: {
  patternName: string | null;
  hash: string;
  services: Array<{ service: string; severity: string; bytes: number; bytes_display: string; share_pct: number; share_pct_display: string }>;
  totalBytes: number;
  firstSeenAgeSeconds: number | null;
  trendSeries: Array<{ ts: number; bytes_per_sec: number }>;
  sampleEvents: string[];
  timeRange: string;
  siemKind: 'resolved' | 'unresolved';
  /** Layer 2 discriminator-first name (shared with top_patterns). */
  displayName?: string;
  /** Layer 3 grounding: representative $-marked template from the 10x engine. */
  groundingTemplate?: string;
  /** Layer 3 grounding: captured slot names from the 10x engine. */
  groundingSlots?: string[];
}): string {
  const { patternName, hash, services, totalBytes, firstSeenAgeSeconds, trendSeries, sampleEvents, timeRange, siemKind } = args;

  const lines: string[] = [];

  // Header (Layer 2/3) — the discriminator-first display_name, the SAME
  // label top_patterns shows for this pattern. Falls back to the df-less
  // service-led label, never a raw hash slice.
  const displayName =
    args.displayName && args.displayName.length > 0
      ? args.displayName
      : patternDescriptor(patternName, services, '(unnamed pattern)');
  lines.push(`Pattern: ${displayName}`);
  if (firstSeenAgeSeconds !== null) {
    const days = Math.round(firstSeenAgeSeconds / 86400);
    lines.push(`First seen: ${days} day${days !== 1 ? 's' : ''} ago`);
  }

  // Layer 3 grounding — drill-in proof, all VERBATIM, nothing synthesized.
  // The display_name above is a derived label; these lines anchor it to the
  // real identity + a real example so the reader can trust the name:
  //   - full untouched symbolMessage as a monospace secondary id
  //   - pattern_hash on a metadata line (the stable identity behind it)
  //   - the 10x engine's $-marked template + captured slot names (when the
  //     local engine is reachable)
  //   - a verbatim representative example line from the fetched samples
  if (patternName) {
    lines.push(`  symbol message: \`${patternName}\``);
  }
  lines.push(`  pattern_hash: \`${hash}\``);
  if (args.groundingTemplate) {
    lines.push(`  template: \`${args.groundingTemplate}\``);
  }
  if (args.groundingSlots && args.groundingSlots.length > 0) {
    lines.push(`  captured slots: ${args.groundingSlots.join(', ')}`);
  }
  if (sampleEvents.length > 0) {
    lines.push(`  example: ${sampleEvents[0]}`);
  }
  lines.push('');

  // lineChart — FIX 8: use timeRange window label, adaptive step
  const trMatch = timeRange.match(/^(\d+)([mhd])$/);
  const trSeconds = trMatch
    ? Number(trMatch[1]) * ({ m: 60, h: 3600, d: 86400 } as Record<string, number>)[trMatch[2]]
    : 7 * 86400;
  const bytesPerSecVals = trendSeries.map((p) => p.bytes_per_sec);
  // FIX 5: insufficient history placeholder when < 2 data points.
  if (bytesPerSecVals.filter((v) => v > 0).length < 2) {
    lines.push(`Volume trend (${timeRange}): insufficient history (pattern emerged recently or no data in this window)`);
    lines.push('');
  } else {
    const chart = lineChart(bytesPerSecVals, {
      widthCap: 60,
      maxTotalWidth: 72,
      spanSeconds: trSeconds,
    });
    if (chart) {
      lines.push(`Volume trend (${timeRange})`);
      lines.push(chart);
      lines.push('');
    } else {
      lines.push(`Volume trend (${timeRange}): insufficient history (pattern emerged recently or no data in this window)`);
      lines.push('');
    }
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

  // FIX 4: Severity breakdown — use fmtBytes instead of raw GB division.
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
        return `${sev}: ${fmtBytes(bytes)} (${pct}%)`;
      });
    lines.push(`Severity breakdown: ${sevParts.join('  |  ')}`);
    lines.push('');
  }

  // FIX 9: Sample events — branched error messages by SIEM resolution state.
  if (sampleEvents.length > 0) {
    // Sort sample events by timestamp descending (most recent first) when the
    // event strings contain parseable ISO timestamps. Best-effort: if no
    // timestamp is found, preserve the original connector order.
    // Accept ISO 8601 ('T' separator) and CloudWatch-style space-separated timestamps.
    const tsPattern = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/;
    const sortedEvents = [...sampleEvents].sort((a, b) => {
      const ta = tsPattern.exec(a)?.[1];
      const tb = tsPattern.exec(b)?.[1];
      if (!ta || !tb) return 0;
      // Normalise space-separated to 'T' so Date.parse works correctly.
      return tb.replace(' ', 'T').localeCompare(ta.replace(' ', 'T')); // lexicographic ISO sort is chronologically correct
    });

    // Disclosure: if the latest sample is more than 24h old, note that events
    // are distributed across the probe window and not necessarily the most recent.
    let disclosureLine = '';
    const latestTsRaw = tsPattern.exec(sortedEvents[0])?.[1];
    const latestTs = latestTsRaw?.replace(' ', 'T');
    if (latestTs) {
      const latestMs = Date.parse(latestTs);
      const ageMs = Date.now() - latestMs;
      if (ageMs > 24 * 3600 * 1000) {
        const ageDays = Math.round(ageMs / (24 * 3600 * 1000));
        disclosureLine = `Sample events (${sortedEvents.length} shown, latest from ${ageDays}d ago; samples distributed across ${timeRange} stack probe):`;
      }
    }
    lines.push(disclosureLine || `Sample events (${sortedEvents.length} shown):`);
    sortedEvents.forEach((evt, i) => {
      lines.push(`  ${i + 1}. ${evt}`);
    });
    lines.push('');
  } else if (siemKind !== 'resolved') {
    lines.push('Sample events: not available (no stack connector resolved — set LOG10X_METRICS_* or run log10x_discover_env).');
    lines.push('');
  } else {
    lines.push(`Sample events: not available (no matching events in the last ${timeRange}; this is normal for bursty patterns with the window outside their burst, or for very low-volume patterns).`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Entry function ─────────────────────────────────────────────────────────────

export async function executePatternDetail(args: {
  pattern_hash?: string;
  pattern?: string;
  include_samples?: boolean;
  timeRange?: string;
  environment?: string;
  monthly_volume_gb?: number;
}): Promise<StructuredOutput> {
  const telemetry = newChassisTelemetry();

  // Validate: at least one of pattern / pattern_hash must be provided.
  if (!args.pattern_hash && !args.pattern) {
    return buildChassisEnvelope({
      tool: 'log10x_pattern_detail',
      view: 'summary',
      headline: 'pattern_detail: provide either pattern_hash or pattern (name).',
      status: 'error',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      // bytes_source is TSDB for all pattern_detail metrics queries; carry it
      // on validation-error envelopes so the provenance chain is unbroken.
      source_disclosure: { bytes_source: 'tsdb' },
      scope: { window: 'unknown', window_basis: 'auto_default' },
      payload: { error: 'missing_identifier' },
      human_summary: 'pattern_detail requires either pattern_hash or pattern (name). Provide one.',
      error: {
        error_type: 'missing_identifier',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'Pass pattern_hash (from top_patterns / preview_filter) or pattern (Symbol Message name).',
      },
      telemetry,
    });
  }

  const includeSamples = args.include_samples !== false;
  const timeRange = args.timeRange ?? '7d';

  let env: EnvConfig | undefined;
  try {
    const envs = await loadEnvironments();
    env = envs.default;
  } catch {
    env = undefined;
  }

  if (!env) {
    // Prefer the human-readable pattern name when the caller supplied one
    // (args.pattern); only fall back to a generic descriptor when the caller
    // supplied a hash. The hash stays in payload.pattern_hash + actions.
    const id = args.pattern ?? '(unnamed pattern)';
    return buildChassisEnvelope({
      tool: 'log10x_pattern_detail',
      view: 'summary',
      headline: `pattern_detail(${id}): no environment configured.`,
      status: 'error',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      // Environment is absent so we cannot query TSDB yet, but the intended
      // bytes_source for this tool is always tsdb.
      source_disclosure: { bytes_source: 'tsdb' },
      scope: { window: 'unknown', window_basis: 'auto_default' },
      payload: { pattern_hash: args.pattern_hash ?? null, error: 'no environment configured' },
      human_summary: 'No environment configured. Run log10x_discover_env or set LOG10X_METRICS_* env vars.',
      error: {
        error_type: 'no_environment',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'Run log10x_discover_env or set LOG10X_METRICS_URL / LOG10X_AUTH.',
      },
      telemetry,
    });
  }

  // Resolve hash: prefer the explicit pattern_hash; fall back to name → hash
  // via metrics lookup (same authoritative path as pattern_examples).
  let resolvedHash: string;
  if (args.pattern_hash) {
    resolvedHash = args.pattern_hash;
  } else {
    const canonicalName = normalizePattern(args.pattern!);
    const fromMetrics = await resolvePatternHashFromMetrics(env, canonicalName);
    recordQuery(telemetry);
    if (!fromMetrics) {
      return buildChassisEnvelope({
        tool: 'log10x_pattern_detail',
        view: 'summary',
        headline: `pattern_detail: no metrics found for pattern "${canonicalName}". Try passing pattern_hash directly.`,
        status: 'no_signal',
        decisions: { threshold_used: null, threshold_basis: 'default' },
        source_disclosure: { bytes_source: 'tsdb' },
        scope: { window: timeRange, window_basis: 'explicit' },
        payload: { error: 'pattern_not_found', pattern: canonicalName },
        human_summary: `No metrics found for pattern "${canonicalName}" in TSDB. Try pattern_hash directly from top_patterns.`,
        telemetry,
      });
    }
    resolvedHash = fromMetrics;
  }

  // The env-wide total is ONLY the volume-lens basis. Resolving the metrics
  // env (an edge/cloud probe query) AND fetching the total are BOTH wasted
  // work when no projection was requested, so gate the whole chain on
  // monthly_volume_gb. When lensed it runs concurrently with the main batch;
  // when off it costs zero queries, keeping the hot path identical to today.
  const basisPromise: Promise<number> = args.monthly_volume_gb
    ? resolveMetricsEnv(env).then((metricsEnv) => fetchEnvMonthlyBytes(env, metricsEnv))
    : Promise.resolve(0);

  // Fetch all data in parallel.
  const [patternName, services, firstSeenAgeSeconds, trendSeries, envMonthlyBytes] = await Promise.all([
    resolvePatternName(env, resolvedHash),
    fetchServiceBreakdown(env, resolvedHash),
    fetchFirstSeen(env, resolvedHash),
    fetchTrend(env, resolvedHash, timeRange),
    basisPromise,
  ]);
  recordQuery(telemetry);

  // ── Volume projection lens. ─────────────────────────────────────
  // Resolve ONCE against the ENV-WIDE monthly bytes (NOT this pattern's own
  // total — that would blow one pattern up to the whole stated volume). When
  // lensed, scale every absolute magnitude (per-service bytes, trend
  // bytes/sec) by the uniform factor BEFORE total_bytes / shares / severity
  // breakdown are derived, so shares stay invariant by construction. Sample
  // event bodies are REAL captured text and are left untouched. factor 1 (no
  // monthly_volume_gb, or no basis) => byte-for-byte identical to today.
  const volumeLens = resolveVolumeLens(args.monthly_volume_gb, envMonthlyBytes);
  if (volumeLens.factor !== 1) {
    for (const s of services) {
      s.bytes *= volumeLens.factor;
      s.bytes_display = fmtBytes(s.bytes);
    }
    for (const p of trendSeries) p.bytes_per_sec *= volumeLens.factor;
  }

  const { events: sampleEvents, siemKind } = includeSamples
    ? await fetchSampleEvents(resolvedHash, patternName, timeRange)
    : { events: [] as string[], siemKind: 'unresolved' as const };

  if (includeSamples && siemKind === 'resolved') {
    recordQuery(telemetry);
  }

  const totalBytes = services.reduce((s, r) => s + r.bytes, 0);

  // RENDER-ONLY pattern naming (Layer 2) — the SAME shared env df-map
  // top_patterns uses, so the drill-in header matches the list row. Degrades
  // to Layer 1 on any backend hiccup (zero-corpus df).
  const metricsEnvForDf = await resolveMetricsEnv(env);
  const dfCtx: DfContext = await getEnvDfContext(env, metricsEnvForDf);
  const topSvc = services[0];
  const built = patternName
    ? buildDisplayName(patternName, {
        df: dfCtx,
        service: topSvc?.service,
        severity: topSvc?.severity,
        width: DEFAULT_NAME_WIDTH,
      })
    : { display_name: '', display_tokens: [] as DisplayToken[] };
  const displayName = built.display_name;

  // Layer 3 grounding — best-effort 10x engine pass over the fetched samples
  // for the representative $-marked template + captured slot names. Local CLI
  // only; on any failure (hosted MCP, no local engine) Layer 3 degrades to
  // identity + example, never failing the tool. Nothing synthesized.
  let groundingTemplate: string | undefined;
  let groundingSlots: string[] = [];
  if (sampleEvents.length > 0) {
    try {
      const ext = await extractPatterns(sampleEvents.slice(0, 20));
      const match = ext.patterns.find((p) => p.symbolMessage === patternName) ?? ext.patterns[0];
      if (match) {
        groundingTemplate = match.template;
        groundingSlots = Object.keys(match.variables ?? {});
      }
    } catch {
      // local engine unreachable — grounding degrades silently.
    }
  }

  const verbatim = renderVerbatim({
    patternName,
    hash: resolvedHash,
    services,
    totalBytes,
    firstSeenAgeSeconds,
    trendSeries,
    sampleEvents,
    timeRange,
    siemKind,
    displayName,
    groundingTemplate,
    groundingSlots,
  });

  const mustAskUser = {
    question: 'What next?',
    options: [
      'Back — return to the preview list',
      'Apply — proceed with applying the mode to this pattern',
    ],
  };

  // FIX 4: headline uses fmtBytes instead of raw GB division.
  // Descriptor preference: patternName > top service > "(no metrics in window)"
  // when no service breakdown came back either. The hash never appears in
  // prose; it stays in payload.pattern_hash + actions[].args.
  const descriptor =
    displayName && displayName.length > 0
      ? displayName
      : patternDescriptor(patternName, services, '(no metrics in window)', dfCtx);
  let headline =
    `pattern_detail(${descriptor}): ` +
    `${services.length} service(s), ${fmtBytes(totalBytes)}/mo (30d). ` +
    `${sampleEvents.length} sample event(s) fetched.`;
  // Volume projection lens: mark the headline so a lensed run is never
  // mistaken for measured volume.
  if (volumeLens.lensed) {
    const pg = (volumeLens.projected_monthly_bytes ?? 0) / 1_000_000_000;
    const lab = pg >= 1000 ? `${(pg / 1000).toFixed(pg >= 10000 ? 0 : 1)} TB` : `${pg.toFixed(pg >= 10 ? 0 : 1)} GB`;
    headline = `[Projected to ${lab}/mo] ${headline}`;
  }

  const human_summary =
    `Pattern ${descriptor} ` +
    `(services=${services.length}, ${fmtBytes(totalBytes)}/mo). ` +
    `${sampleEvents.length} sample event(s) fetched.`;

  const envelope: PatternDetailEnvelope = {
    pattern_hash: resolvedHash,
    pattern_name: patternName,
    // RENDER-ONLY output contract (consumed by the homepage chat widget),
    // additive to the unchanged pattern_name (raw symbolMessage) + pattern_hash.
    display_name: displayName || (patternName ?? ''),
    display_tokens: built.display_tokens,
    services,
    total_bytes: totalBytes,
    total_bytes_display: fmtBytes(totalBytes),
    first_seen_age_seconds: firstSeenAgeSeconds,
    trend_time_series: trendSeries,
    sample_events: sampleEvents,
    volume_lens: volumeLens,
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
  };

  // FIX 6: Apply action uses the correct service field from breakdown,
  // not the pattern name. When multiple services emit this hash, we omit
  // the service arg and let the user pick (configure_engine will show
  // the full list). When exactly one service is present, pass it directly.
  const applyArgs: Record<string, unknown> = { pattern_hash: resolvedHash };
  if (services.length === 1) {
    applyArgs['service'] = services[0].service;
  }

  return buildChassisEnvelope({
    tool: 'log10x_pattern_detail',
    view: 'summary',
    headline,
    status: totalBytes > 0 ? 'success' : 'no_signal',
    decisions: {
      threshold_used: null,
      threshold_basis: 'default',
    },
    source_disclosure: {
      bytes_source: 'tsdb',
      siem_vendor: siemKind === 'resolved' ? 'detected' : undefined,
      ...volumeLensDisclosure(volumeLens),
    },
    scope: {
      window: timeRange,
      window_basis: 'explicit',
      candidates_count: services.length,
      candidates_evaluated: services.length,
    },
    payload: envelope,
    human_summary,
    warnings: volumeLens.lensed && volumeLens.disclosure
      ? [volumeLens.disclosure]
      : undefined,
    must_render_verbatim: verbatim,
    must_ask_user: mustAskUser,
    actions: [
      {
        tool: 'log10x_preview_filter',
        args: {},
        reason: 'Back — return to the preview list',
        role: 'alternative',
      },
      {
        tool: 'log10x_configure_engine',
        args: applyArgs,
        reason: services.length > 1
          ? `Apply with this pattern in the picture (${services.length} services emit this hash — pick a service to scope)`
          : 'Apply with this pattern in the picture',
        role: 'alternative',
      },
      {
        tool: 'log10x_pattern_examples',
        args: { pattern: patternName ?? args.pattern_hash },
        reason: 'Bucket sample events by slot value to see if a single slot value dominates (low-cardinality skew) — useful before deciding drop vs sample vs compact.',
        role: 'optional-followup',
      },
    ],
    telemetry,
  });
}

// ─── Test exports ─────────────────────────────────────────────────────────────

/** Exported for unit tests only. */
export const __testables = {
  renderAsciiBarChart,
};
