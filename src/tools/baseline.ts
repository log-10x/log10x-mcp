/**
 * log10x_baseline — establish the X% commitment baseline.
 *
 * Hero pre-requisite for any commitment-grade configuration. Before an
 * agent can wire a target reduction percent into `log10x_configure_engine`,
 * we need three things to be true:
 *
 *   1. Reporter has been emitting metrics for at least 7 days. Anything
 *      shorter and the cap derivation rests on cold-start noise.
 *   2. The metrics we see cover at least 80% of the customer's stated
 *      destination volume. If we're only seeing 30% of the SIEM's daily
 *      ingest, the cap will under-attribute spend and over-promise savings.
 *   3. The 30-day history is not visibly contaminated by an anomaly
 *      window (deploy storms, incident floods). Any single day > 4× the
 *      rolling 7d median poisons the percentile math.
 *
 * When any gate fails we return `status: 'not_ready'` with a structured
 * `not_ready_reason` and a remediation string. When all gates pass, we
 * return the current spend, the no-action 90d projection (organic growth
 * extrapolated from the 30d window), the top contributors, and a
 * recommended `target_percent` band derived from how much of the top is
 * actually compactable on the destination.
 *
 * Reads only existing Reporter metrics (`all_events_summaryBytes_total`,
 * `all_events_summaryVolume_total`). Zero engine ask.
 *
 * Open questions resolved by spec (defaults chosen, flagged inline):
 *   - Reporter age threshold: 7d. Overridable via LOG10X_BASELINE_MIN_DAYS
 *     for testing fixtures with shorter histories.
 *   - Coverage threshold: 80% of stated_daily_gb (caller-supplied; absent
 *     → coverage gate is informational, not blocking).
 *   - Anomaly threshold: 4× rolling 7d median on any day in the 30d
 *     window. Single-day windows below 1% of trailing 7d are skipped
 *     (treated as missing data, not zeros, so a forwarder outage doesn't
 *     trip the anomaly gate).
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant, queryRange } from '../lib/api.js';
import {
  bytesToGb,
  parsePrometheusValue,
  annualizeDollars,
  getDestinationCostModel,
  type Action,
} from '../lib/cost.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { fmtDollar, fmtBytes } from '../lib/format.js';
import {
  buildEnvelope,
  buildMarkdownEnvelope,
  type StructuredOutput,
} from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';

// ─── constants ────────────────────────────────────────────────────────

/** Minimum Reporter age in days before baseline derivation is trusted. */
const DEFAULT_MIN_REPORTER_AGE_DAYS = 7;

/** Coverage gate: bytes_seen / stated_daily_gb must be ≥ this (percent). */
const MIN_COVERAGE_PCT = 80;

/** Anomaly gate: any day above this multiple of trailing 7d median trips it. */
const ANOMALY_MULTIPLIER = 4;

/** Days at which an anomaly-window cools off enough to retry. */
const ANOMALY_COOLDOWN_DAYS = 7;

/** Default horizon window. */
const DEFAULT_HORIZON: BaselineHorizon = '30d';

/** Used as the divisor for $/mo when monthlyizing window bytes. */
const DAYS_PER_MONTH = 30;

/** Cap the recommended target range — never promise more than 80%. */
const MAX_RECOMMENDED_PCT = 80;

/** Floor for the recommended target range — never promise less than 10%. */
const MIN_RECOMMENDED_PCT = 10;

/** Small-event floor below which "compactable" share is discounted to 0. */
const COMPACTABLE_AVG_FLOOR_BYTES = 100;

// ─── types ────────────────────────────────────────────────────────────

export type BaselineHorizon = '30d' | '90d';

export type BaselineStatus = 'ready' | 'not_ready';

export type NotReadyReason =
  | 'reporter_too_new'
  | 'coverage_low'
  | 'anomaly_window'
  | 'no_destination'
  | 'no_data';

export interface BaselineTopContributor {
  pattern_hash: string;
  pattern: string;
  service: string;
  severity: string;
  share_pct: number;
  monthly_usd: number;
  avg_event_size_bytes: number;
  compactable: boolean;
}

export interface BaselineEnvelopeData {
  status: BaselineStatus;
  not_ready_reason?: NotReadyReason;
  reporter_age_days: number;
  coverage_pct: number;
  destination: SiemId | null;
  horizon: BaselineHorizon;
  current: {
    bytes_window: number;
    bytes_per_day_p50: number;
    bytes_per_day_p90: number;
    monthly_usd: number;
  };
  projection_no_action_90d: {
    monthly_usd_in_90d: number;
    growth_pct: number;
  };
  top_contributors: BaselineTopContributor[];
  recommended_target_range?: {
    low_pct: number;
    expected_pct: number;
    high_pct: number;
  };
  remediation?: string;
}

// ─── schema ───────────────────────────────────────────────────────────

export const baselineSchema = {
  horizon: z
    .enum(['30d', '90d'])
    .default('30d')
    .describe(
      'Lookback window for the baseline. 30d is the default and what `recommended_target_range` is calibrated against; 90d trades freshness for stability on lower-volume tenants.'
    ),
  destination: z
    .enum([
      'splunk',
      'datadog',
      'elasticsearch',
      'clickhouse',
      'cloudwatch',
      'azure-monitor',
      'gcp-logging',
      'sumo',
    ])
    .optional()
    .describe(
      'Destination SIEM. Required to project dollar baselines and decide which top contributors are compactable. Auto-detected from `env.analyzer` when omitted; falls back to `not_ready/no_destination` if neither is available.'
    ),
  statedDailyGb: z
    .number()
    .positive()
    .optional()
    .describe(
      'Customer-stated daily SIEM ingest in GB. When supplied, the coverage gate compares observed bytes against this number; ≥80% passes, <80% returns `not_ready/coverage_low`. Omit to skip the coverage gate (the result still surfaces observed coverage as informational).'
    ),
  environment: z
    .string()
    .optional()
    .describe('Environment nickname for multi-env setups.'),
  view: z
    .enum(['summary', 'markdown'])
    .default('summary')
    .describe(
      'summary returns the typed envelope; markdown wraps the rendered report in data.markdown for human-consumable deliverables.'
    ),
};

// ─── main entry ───────────────────────────────────────────────────────

export async function executeBaseline(
  args: {
    horizon?: BaselineHorizon;
    destination?: SiemId;
    statedDailyGb?: number;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const horizon: BaselineHorizon = args.horizon ?? DEFAULT_HORIZON;
  const view = args.view ?? 'summary';
  const telemetry = newTelemetry();

  const result = await computeBaseline(args, env, horizon);

  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_baseline',
      summary: { headline: headlineFor(result) },
      markdown: renderBaselineMarkdown(result),
    });
  }

  return buildEnvelope({
    tool: 'log10x_baseline',
    view: 'summary',
    summary: { headline: headlineFor(result) },
    data: {
      ...result,
      ...buildUnifiedFields({
        status: result.status === 'ready' ? 'success' : 'insufficient_data',
        telemetry,
        humanSummary: headlineFor(result),
      }),
    },
  });
}

// ─── core logic ───────────────────────────────────────────────────────

async function computeBaseline(
  args: {
    horizon?: BaselineHorizon;
    destination?: SiemId;
    statedDailyGb?: number;
  },
  env: EnvConfig,
  horizon: BaselineHorizon
): Promise<BaselineEnvelopeData> {
  const horizonDays = horizon === '90d' ? 90 : 30;
  const metricsEnv = await resolveMetricsEnv(env);

  // ── Gate 0: destination. ────────────────────────────────────────
  // Without a destination there is no $/GB to project against.
  const destination = args.destination ?? autoDetectDestination(env);
  if (!destination) {
    return buildNotReadyEnvelope({
      reason: 'no_destination',
      horizon,
      remediation:
        'Pass `destination` (splunk | datadog | elasticsearch | clickhouse | cloudwatch | azure-monitor | gcp-logging | sumo) or set the env profile `analyzer` field.',
    });
  }

  // ── Gate 1: Reporter age. ───────────────────────────────────────
  const minDays = readMinAgeOverride() ?? DEFAULT_MIN_REPORTER_AGE_DAYS;
  const reporterAge = await fetchReporterAgeDays(env, metricsEnv);
  if (reporterAge === null) {
    // No Reporter timestamp at all → Reporter not deployed.
    return buildNotReadyEnvelope({
      reason: 'reporter_too_new',
      destination,
      horizon,
      reporterAgeDays: 0,
      remediation:
        'Deploy Reporter (Tier 2) before running baseline. Once it has been emitting metrics for 7 days, re-run.',
    });
  }
  if (reporterAge < minDays) {
    return buildNotReadyEnvelope({
      reason: 'reporter_too_new',
      destination,
      horizon,
      reporterAgeDays: reporterAge,
      remediation: `Wait until Reporter has ${minDays}d of data; current age=${reporterAge.toFixed(1)}d. Commitment-grade baseline requires ${minDays}d of history so percentile math is not dominated by cold-start noise.`,
    });
  }

  // ── Pull the 30/90d time series in daily buckets. ───────────────
  const series = await fetchDailyBytes(env, metricsEnv, horizonDays);
  const validDays = series.filter((d) => Number.isFinite(d) && d >= 0);
  if (validDays.length === 0) {
    return buildNotReadyEnvelope({
      reason: 'no_data',
      destination,
      horizon,
      reporterAgeDays: reporterAge,
      remediation:
        'Reporter is deployed but has not emitted bytes metrics yet in the chosen window. Verify the engine is wired to the metrics backend the MCP is reading from.',
    });
  }

  const totalBytes = validDays.reduce((s, x) => s + x, 0);
  const observedDailyGb =
    totalBytes / Math.max(1, validDays.length) / (1024 ** 3);

  // ── Gate 2: coverage. ───────────────────────────────────────────
  let coveragePct = 100;
  if (args.statedDailyGb && args.statedDailyGb > 0) {
    coveragePct = Math.min(
      100,
      Math.round((observedDailyGb / args.statedDailyGb) * 100)
    );
    if (coveragePct < MIN_COVERAGE_PCT) {
      return buildNotReadyEnvelope({
        reason: 'coverage_low',
        destination,
        horizon,
        reporterAgeDays: reporterAge,
        coveragePct,
        remediation: `Observed ${observedDailyGb.toFixed(1)} GB/day vs stated ${args.statedDailyGb} GB/day (${coveragePct}% coverage). Commitment-grade baseline requires ≥${MIN_COVERAGE_PCT}% coverage so attribution is not biased by missing sources. Verify Reporter is wired to every forwarder feeding ${destination}.`,
      });
    }
  }

  // ── Gate 3: anomaly window. ─────────────────────────────────────
  const anomaly = detectAnomalyWindow(validDays);
  if (anomaly) {
    return buildNotReadyEnvelope({
      reason: 'anomaly_window',
      destination,
      horizon,
      reporterAgeDays: reporterAge,
      coveragePct,
      remediation: `Day ${anomaly.dayOffset} of the trailing ${horizonDays}d window had ${anomaly.multiplier.toFixed(1)}× the rolling 7d median bytes. Wait ${ANOMALY_COOLDOWN_DAYS}d after this anomaly window then re-run baseline; otherwise the percentile math will be biased by the spike.`,
    });
  }

  // ── All gates passed. Compute the baseline. ─────────────────────
  const sorted = [...validDays].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);

  // Monthly $ = bytes/day_p50 × 30 × ($/GB ingest + $/GB-month storage).
  const model = getDestinationCostModel(destination);
  const monthlyGb = (p50 * DAYS_PER_MONTH) / (1024 ** 3);
  const monthlyUsd =
    monthlyGb * (model.ingest_per_gb + model.storage_per_gb_month);

  const growthPct = computeGrowthPct(validDays);
  const monthlyUsdIn90d = monthlyUsd * Math.pow(1 + growthPct, 3);

  const top = await fetchTopContributors(
    env,
    metricsEnv,
    horizonDays,
    totalBytes,
    destination
  );

  const recommended = recommendTargetRange(top);

  return {
    status: 'ready',
    reporter_age_days: reporterAge,
    coverage_pct: coveragePct,
    destination,
    horizon,
    current: {
      bytes_window: totalBytes,
      bytes_per_day_p50: p50,
      bytes_per_day_p90: p90,
      monthly_usd: monthlyUsd,
    },
    projection_no_action_90d: {
      monthly_usd_in_90d: monthlyUsdIn90d,
      growth_pct: growthPct,
    },
    top_contributors: top,
    recommended_target_range: recommended,
  };
}

// ─── helpers: gates & queries ─────────────────────────────────────────

function readMinAgeOverride(): number | null {
  const raw = process.env.LOG10X_BASELINE_MIN_DAYS;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function autoDetectDestination(env: EnvConfig): SiemId | undefined {
  const a = (env.analyzer ?? '').toLowerCase().trim();
  if (!a) return undefined;
  if (a.includes('splunk')) return 'splunk';
  if (a.includes('datadog') || a === 'dd') return 'datadog';
  if (a.includes('elastic') || a === 'es' || a.includes('opensearch'))
    return 'elasticsearch';
  if (a.includes('clickhouse') || a === 'ch') return 'clickhouse';
  if (a.includes('cloudwatch') || a === 'cw') return 'cloudwatch';
  if (a.includes('azure') || a.includes('monitor')) return 'azure-monitor';
  if (a.includes('gcp') || a.includes('stackdriver') || a.includes('google'))
    return 'gcp-logging';
  if (a.includes('sumo')) return 'sumo';
  return undefined;
}

/**
 * Returns the Reporter age in days, or null if no Reporter timestamps
 * exist at all (Reporter not deployed). Uses Prometheus `timestamp()`
 * on the bytes-total counter restricted to `tenx_app=reporter`.
 *
 * `min(min_over_time(timestamp(...)))` returns the unix seconds of the
 * OLDEST sample of the metric — i.e. the first time we observed bytes
 * flowing through Reporter.
 */
async function fetchReporterAgeDays(
  env: EnvConfig,
  metricsEnv: 'edge' | 'cloud'
): Promise<number | null> {
  // Demo Prom backend rejects [90d:1d] instant subqueries with
  // "queries with long day range (32d to 95d) are currently only supported
  // for range type queries". Use [30d:1d] — well within bounds — and treat
  // anything older than 30d as "ready" (cap return value at 30 with overflow
  // bit so the caller can still tell the gate is passed).
  const q = `min(min_over_time(timestamp(all_events_summaryBytes_total{tenx_app="reporter",${env.labels.env}="${metricsEnv}"})[30d:1d]))`;
  try {
    const res = await queryInstant(env, q);
    const point = res?.data?.result?.[0];
    if (!point) return null;
    const oldestUnix = parsePrometheusValue(point);
    if (!oldestUnix || oldestUnix <= 0) return null;
    const ageSec = Date.now() / 1000 - oldestUnix;
    if (ageSec <= 0) return 0;
    return ageSec / 86400;
  } catch {
    return null;
  }
}

/**
 * Fetch per-day bytes over the trailing N days. Returns an array of
 * length up to N where index 0 is the oldest day. Failed buckets are
 * returned as NaN so the caller can distinguish them from real zeros.
 */
async function fetchDailyBytes(
  env: EnvConfig,
  metricsEnv: 'edge' | 'cloud',
  days: number
): Promise<number[]> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - days * 86400;
  const step = 86400; // 1 day
  const q = `sum(increase(all_events_summaryBytes_total{tenx_app="reporter",${env.labels.env}="${metricsEnv}"}[1d]))`;
  try {
    const res = await queryRange(env, q, start, now, step);
    const series = res?.data?.result?.[0];
    if (!series || !series.values) return Array(days).fill(NaN);
    const out: number[] = [];
    for (const [, val] of series.values) {
      const n = parseFloat(val);
      out.push(Number.isFinite(n) ? n : NaN);
    }
    return out;
  } catch {
    return Array(days).fill(NaN);
  }
}

/**
 * Anomaly gate: any single day > ANOMALY_MULTIPLIER × rolling 7d median
 * within the daily series. Returns the offending day's offset (0-indexed
 * from window start) and the multiplier, or null if clean. Days below
 * 1% of trailing-7d median are treated as MISSING, not real zeros, so
 * a forwarder outage doesn't trip the gate (and doesn't drag the median
 * down such that the next day looks like a spike).
 */
function detectAnomalyWindow(
  days: number[]
): { dayOffset: number; multiplier: number } | null {
  if (days.length < 8) return null;
  for (let i = 7; i < days.length; i++) {
    const value = days[i];
    if (!Number.isFinite(value) || value <= 0) continue;
    const window = days
      .slice(i - 7, i)
      .filter((x) => Number.isFinite(x) && x > 0);
    if (window.length === 0) continue;
    const median = percentile(
      [...window].sort((a, b) => a - b),
      0.5
    );
    if (median <= 0) continue;
    // Skip days that look like reporter-outage residue: a value below
    // 1% of trailing median is more likely missing data than a real low.
    if (value < median * 0.01) continue;
    const multiplier = value / median;
    if (multiplier > ANOMALY_MULTIPLIER) {
      return { dayOffset: i, multiplier };
    }
  }
  return null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Organic growth: (last 7d mean / first 7d mean) - 1, computed over
 * the window. Returns 0 when either tail is empty/zero or the window
 * is shorter than 14 days (not enough signal to extrapolate).
 */
function computeGrowthPct(days: number[]): number {
  const valid = days.filter((d) => Number.isFinite(d) && d >= 0);
  if (valid.length < 14) return 0;
  const first = valid.slice(0, 7);
  const last = valid.slice(-7);
  const firstAvg = first.reduce((s, x) => s + x, 0) / first.length;
  const lastAvg = last.reduce((s, x) => s + x, 0) / last.length;
  if (firstAvg <= 0) return 0;
  return lastAvg / firstAvg - 1;
}

// ─── top contributors ─────────────────────────────────────────────────

async function fetchTopContributors(
  env: EnvConfig,
  metricsEnv: 'edge' | 'cloud',
  horizonDays: number,
  totalBytes: number,
  destination: SiemId
): Promise<BaselineTopContributor[]> {
  const labels = env.labels;
  const range = `${horizonDays}d`;
  const bytesQ = `topk(10, sum by (${labels.pattern}, ${labels.service}, ${labels.severity}, ${labels.hash}) (increase(all_events_summaryBytes_total{tenx_app="reporter",${labels.env}="${metricsEnv}"}[${range}])))`;
  const eventsQ = `sum by (${labels.pattern}, ${labels.service}, ${labels.severity}, ${labels.hash}) (increase(all_events_summaryVolume_total{tenx_app="reporter",${labels.env}="${metricsEnv}"}[${range}]))`;

  let bytesRes;
  let eventsRes;
  try {
    [bytesRes, eventsRes] = await Promise.all([
      queryInstant(env, bytesQ),
      queryInstant(env, eventsQ),
    ]);
  } catch {
    return [];
  }

  const eventsByKey = new Map<string, number>();
  for (const r of eventsRes?.data?.result ?? []) {
    const key = topKey(r.metric, labels);
    eventsByKey.set(key, parsePrometheusValue(r));
  }

  const model = getDestinationCostModel(destination);
  const out: BaselineTopContributor[] = [];

  for (const r of bytesRes?.data?.result ?? []) {
    const bytes = parsePrometheusValue(r);
    if (bytes <= 0) continue;
    const key = topKey(r.metric, labels);
    const events = eventsByKey.get(key) ?? 0;
    const avgSize = events > 0 ? bytes / events : 0;
    const sharePct = totalBytes > 0 ? (bytes / totalBytes) * 100 : 0;

    // Monthly $ = (window_bytes ÷ horizonDays) × 30 × $/GB
    const monthlyBytes = (bytes / horizonDays) * DAYS_PER_MONTH;
    const monthlyUsd =
      bytesToGb(monthlyBytes) *
      (model.ingest_per_gb + model.storage_per_gb_month);

    // Compactable test: destination is not a no-op AND avg event ≥ floor.
    const compactable =
      model.compact_mode !== 'no-op' &&
      avgSize >= COMPACTABLE_AVG_FLOOR_BYTES;

    out.push({
      pattern_hash: String(r.metric[labels.hash] ?? ''),
      pattern: String(r.metric[labels.pattern] ?? ''),
      service: String(r.metric[labels.service] ?? ''),
      severity: String(r.metric[labels.severity] ?? ''),
      share_pct: sharePct,
      monthly_usd: monthlyUsd,
      avg_event_size_bytes: avgSize,
      compactable,
    });
  }

  out.sort((a, b) => b.share_pct - a.share_pct);
  return out.slice(0, 10);
}

function topKey(
  metric: Record<string, string>,
  labels: EnvConfig['labels']
): string {
  return [
    metric[labels.pattern] ?? '',
    metric[labels.service] ?? '',
    metric[labels.severity] ?? '',
    metric[labels.hash] ?? '',
  ].join('|');
}

// ─── target recommendation ────────────────────────────────────────────

/**
 * Heuristic from spec:
 *   expected_pct = min(60, max(15, share_top5_compactable × 0.7))
 *   low_pct      = max(10, expected - 15)
 *   high_pct     = min(80, expected + 15)
 *
 * `share_top5_compactable` is the sum of the top-5 contributors' share
 * percent that are also marked compactable. If the destination is no-op
 * (Datadog & friends) every contributor is non-compactable and we fall
 * back to a conservative drop-only band (low=10, expected=15, high=25).
 */
function recommendTargetRange(top: BaselineTopContributor[]): {
  low_pct: number;
  expected_pct: number;
  high_pct: number;
} {
  const top5 = top.slice(0, 5);
  const compactableShare = top5
    .filter((t) => t.compactable)
    .reduce((s, t) => s + t.share_pct, 0);

  // Destination doesn't support compaction (or no compactable
  // top-5 contributors) → drop-only band.
  if (compactableShare <= 0) {
    return { low_pct: 10, expected_pct: 15, high_pct: 25 };
  }

  // share_top5_compactable is already in percent (0..100); the formula
  // multiplies by 0.7 and stays in percent space.
  const raw = compactableShare * 0.7;
  const expected = Math.round(Math.min(60, Math.max(15, raw)));
  const low = Math.max(MIN_RECOMMENDED_PCT, expected - 15);
  const high = Math.min(MAX_RECOMMENDED_PCT, expected + 15);

  return { low_pct: low, expected_pct: expected, high_pct: high };
}

// ─── not-ready envelope builder ───────────────────────────────────────

function buildNotReadyEnvelope(opts: {
  reason: NotReadyReason;
  destination?: SiemId;
  horizon?: BaselineHorizon;
  reporterAgeDays?: number;
  coveragePct?: number;
  remediation: string;
}): BaselineEnvelopeData {
  return {
    status: 'not_ready',
    not_ready_reason: opts.reason,
    reporter_age_days: opts.reporterAgeDays ?? 0,
    coverage_pct: opts.coveragePct ?? 0,
    destination: opts.destination ?? null,
    horizon: opts.horizon ?? DEFAULT_HORIZON,
    current: {
      bytes_window: 0,
      bytes_per_day_p50: 0,
      bytes_per_day_p90: 0,
      monthly_usd: 0,
    },
    projection_no_action_90d: {
      monthly_usd_in_90d: 0,
      growth_pct: 0,
    },
    top_contributors: [],
    remediation: opts.remediation,
  };
}

// ─── rendering ────────────────────────────────────────────────────────

function headlineFor(d: BaselineEnvelopeData): string {
  if (d.status === 'not_ready') {
    return `Baseline not_ready (${d.not_ready_reason}): ${d.remediation ?? ''}`.slice(
      0,
      240
    );
  }
  const monthly = fmtDollar(d.current.monthly_usd);
  const future = fmtDollar(d.projection_no_action_90d.monthly_usd_in_90d);
  const r = d.recommended_target_range;
  const band = r
    ? ` · target band ${r.low_pct}-${r.high_pct}% (expected ${r.expected_pct}%)`
    : '';
  return `Baseline ready: ${monthly}/mo current, ${future}/mo projected 90d no-action${band}.`;
}

function renderBaselineMarkdown(d: BaselineEnvelopeData): string {
  const lines: string[] = [];

  if (d.status === 'not_ready') {
    lines.push(`# Baseline: not_ready — ${d.not_ready_reason}`);
    lines.push('');
    if (d.remediation) lines.push(d.remediation);
    lines.push('');
    lines.push(`- Reporter age: ${d.reporter_age_days.toFixed(1)}d`);
    if (d.coverage_pct > 0) {
      lines.push(`- Coverage: ${d.coverage_pct}%`);
    }
    if (d.destination) {
      lines.push(`- Destination: ${d.destination}`);
    }
    return lines.join('\n');
  }

  lines.push(`# Baseline (${d.horizon}) — ready`);
  lines.push('');
  lines.push(`- **Destination**: ${d.destination}`);
  lines.push(`- **Reporter age**: ${d.reporter_age_days.toFixed(1)}d`);
  if (d.coverage_pct > 0) {
    lines.push(`- **Coverage**: ${d.coverage_pct}%`);
  }
  lines.push('');

  lines.push('## Current spend');
  lines.push(
    `- Window total: ${fmtBytes(d.current.bytes_window)} over ${d.horizon}`
  );
  lines.push(`- Daily p50: ${fmtBytes(d.current.bytes_per_day_p50)}`);
  lines.push(`- Daily p90: ${fmtBytes(d.current.bytes_per_day_p90)}`);
  lines.push(`- Monthly: ${fmtDollar(d.current.monthly_usd)}`);
  lines.push('');

  lines.push('## No-action 90d projection');
  const growth = d.projection_no_action_90d.growth_pct;
  const growthFmt = (growth * 100).toFixed(1);
  lines.push(
    `- Organic growth (window trend): ${growth >= 0 ? '+' : ''}${growthFmt}%`
  );
  lines.push(
    `- Monthly run-rate in 90d: ${fmtDollar(d.projection_no_action_90d.monthly_usd_in_90d)}`
  );
  lines.push(
    `- Annualized: ${fmtDollar(annualizeDollars(d.current.monthly_usd, DAYS_PER_MONTH))}`
  );
  lines.push('');

  if (d.recommended_target_range) {
    const r = d.recommended_target_range;
    lines.push('## Recommended target band');
    lines.push(`- Low: ${r.low_pct}%`);
    lines.push(`- Expected: ${r.expected_pct}%`);
    lines.push(`- High: ${r.high_pct}%`);
    lines.push('');
    lines.push(
      `_Heuristic: top-5 compactable share × 0.7, clamped to [${MIN_RECOMMENDED_PCT}, ${MAX_RECOMMENDED_PCT}]. Destinations with no-op compaction (datadog / cloudwatch / azure-monitor / gcp-logging / sumo) get a drop-only band (10-25%)._`
    );
    lines.push('');
  }

  if (d.top_contributors.length > 0) {
    lines.push('## Top contributors');
    lines.push('');
    lines.push(
      '| # | Service | Severity | Pattern | Share | $/mo | Avg size | Compactable |'
    );
    lines.push(
      '|---|---------|----------|---------|------:|-----:|---------:|-------------|'
    );
    d.top_contributors.forEach((c, i) => {
      const patternPreview =
        c.pattern.length > 40 ? c.pattern.slice(0, 37) + '...' : c.pattern;
      lines.push(
        `| ${i + 1} | ${c.service || '-'} | ${c.severity || '-'} | \`${patternPreview}\` | ${c.share_pct.toFixed(1)}% | ${fmtDollar(c.monthly_usd)} | ${fmtBytes(c.avg_event_size_bytes)} | ${c.compactable ? 'yes' : 'no'} |`
      );
    });
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `_Next: pass \`target_percent\` from this band (or your own number) into \`log10x_configure_engine\` to derive per-pattern actions._`
  );

  return lines.join('\n');
}

// Re-export Action so callers that want to type per-contributor tier choices
// can do so without re-importing from cost.ts.
export type { Action };
