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
  getDestinationCostModel,
  buildDisclosedDollarValue,
  type Action,
  type DisclosedDollarValue,
} from '../lib/cost.js';
import { SIEM_DISPLAY_NAMES, type SiemId } from '../lib/siem/pricing.js';
import { fmtBytes, fmtDollar, fmtDisclosedDollar } from '../lib/format.js';
import {
  type StructuredOutput,
} from '../lib/output-types.js';
import { newChassisTelemetry, buildChassisEnvelope } from '../lib/chassis-envelope.js';
import { buildSourceDisclosureFromEnv } from '../lib/source-disclosure.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { resolveRate } from '../lib/rate-resolution.js';
import { resolveSiemSelection } from '../lib/siem/resolve.js';
import { resolveVolumeLens, volumeLensDisclosure, type VolumeLensResolution } from '../lib/volume-lens.js';

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

export type RateSource = 'list_price' | 'customer_supplied' | 'unset';

export interface BaselineTopContributor {
  pattern_hash: string;
  pattern: string;
  service: string;
  severity: string;
  share_pct: number;
  /**
   * Projected monthly $ for this contributor at the resolved `rate_source`.
   * `null` when `rate_source === 'unset'` (no destination + no customer
   * override). Aliased by `monthly_usd_at_list` for one release per the
   * percent-first dual-field rule.
   */
  monthly_usd: number | null;
  /** Alias of `monthly_usd` carried for one release while callers migrate. */
  monthly_usd_at_list: number | null;
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
  /**
   * Origin of the $/GB used for all dollar math in this envelope. `unset`
   * means no destination was resolved and no `effective_ingest_per_gb` was
   * supplied — dollar fields are then `null` and the headline / markdown go
   * percent-first.
   */
  rate_source: RateSource;
  /**
   * The resolved ingest $/GB actually used for all dollar math, stated
   * explicitly so readers don't have to back it out of monthly_usd / bytes.
   * `null` when rate_source === 'unset'. (services exposes the same via
   * `cost_per_gb`; baseline carries it here for symmetry.) Optional: the
   * not_ready envelope omits it (no rate computed before the gates pass).
   */
  effective_per_gb?: number | null;
  current: {
    bytes_window: number;
    bytes_window_display: string;
    bytes_per_day_p50: number;
    bytes_per_day_p50_display: string;
    bytes_per_day_p90: number;
    bytes_per_day_p90_display: string;
    /** `null` when `rate_source === 'unset'`. */
    monthly_usd: number | null;
    /** Alias of `monthly_usd` carried for one release. */
    monthly_usd_at_list: number | null;
    /** Disclosed-value mirror of `monthly_usd`. `null` when `rate_source === 'unset'`. */
    monthly_usd_disclosed: DisclosedDollarValue | null;
  };
  projection_no_action_90d: {
    /** `null` when `rate_source === 'unset'`. */
    monthly_usd_in_90d: number | null;
    monthly_usd_in_90d_at_list: number | null;
    /** Disclosed-value mirror of `monthly_usd_in_90d`. `null` when `rate_source === 'unset'`. */
    monthly_usd_in_90d_disclosed: DisclosedDollarValue | null;
    /**
     * @deprecated Ambiguous unit. Use `monthly_compound_growth_pct` (same
     * value) for clarity, or `horizon_total_growth_pct` for the 90d total.
     * Kept for back-compat. The naming was flagged as a CFO 46% under-read
     * risk.
     */
    growth_pct: number;
    /**
     * Monthly compound growth rate as a DECIMAL RATIO (0.36 = 36%/mo).
     * NOT a true percent — the `_pct` suffix is historical. For the
     * field whose value matches a "percent" reading (36, not 0.36) use
     * `monthly_compound_growth_percent`.
     */
    monthly_compound_growth_pct: number;
    /**
     * Same value × 100 for readers who trust the `_pct` naming convention
     * used by sibling `share_pct` fields in the same envelope (where
     * share_pct=16.09 means 16.09%). monthly_compound_growth_percent=36
     * means "36% growth per month compounded" with no ambiguity.
     */
    monthly_compound_growth_percent: number;
    /**
     * Total growth over the 90d horizon as a DECIMAL RATIO (1.52 =
     * +152% total = 2.52× the starting cost). NOT a true percent —
     * use `horizon_total_growth_percent` for the percent-shaped value.
     */
    horizon_total_growth_pct: number;
    /** Same value × 100. 152 means "+152% total growth over horizon". */
    horizon_total_growth_percent: number;
  };
  top_contributors: BaselineTopContributor[];
  /**
   * Volume projection lens resolution. {lensed:false,factor:1} on a normal
   * (measured) run — the source_disclosure stamp + headline prefix only fire
   * when lensed. Always present so callers can read it without a guard.
   */
  volume_lens: VolumeLensResolution;
  recommended_target_range?: {
    low_pct: number;
    expected_pct: number;
    high_pct: number;
    /**
     * Provenance for the band so consumers can tell a calibrated heuristic
     * from the hand-picked drop-only fallback. `drop_only_fallback` = no
     * compactable contributors, range is the hardcoded {10/15/25}.
     * `compactable_share_heuristic` = expected = share_top5_compactable_pct
     * × 0.7.
     */
    basis: 'drop_only_fallback' | 'compactable_share_heuristic';
    /** The exact formula that produced (low_pct, expected_pct, high_pct). */
    formula: string;
    /** Inputs the formula consumed. */
    inputs: {
      share_top5_compactable_pct: number;
    };
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
  effectiveIngestPerGb: z
    .number()
    .positive()
    .optional()
    .describe(
      "Customer-negotiated $/GB for the destination. When supplied, baseline dollar projections use this rate and `rate_source` resolves to `customer_supplied`. Omit to fall back to vendors.json list pricing for the resolved destination (`rate_source: list_price`); omit BOTH this and `destination` to get a percent-first envelope (`rate_source: unset`, dollar fields null)."
    ),
  environment: z
    .string()
    .optional()
    .describe('Environment nickname for multi-env setups.'),
  monthly_volume_gb: z.number().positive().optional().describe(
    'What-if volume lens (forecast mode): model the environment at THIS monthly volume (decimal GB/month) instead of its measured volume. The real per-pattern shares and pattern mix are held fixed; only absolute bytes and dollars scale, by one uniform factor. Use it to project a prospect onto their own scale, or to forecast a real env after growth. Pairs with siem_lens. This is a PROJECTION: the envelope stamps volume_actual_gb vs volume_projected_gb and the scale factor, and the note points at the POC for the caller real patterns.'
  ),
  view: z
    .literal('summary')
    .default('summary')
    .optional()
    .describe(
      'Output format. Always "summary" — the typed envelope. Field retained for backward-compat with callers that still pass `view: "summary"`.'
    ),
};

// ─── main entry ───────────────────────────────────────────────────────

export async function executeBaseline(
  args: {
    horizon?: BaselineHorizon;
    destination?: SiemId;
    statedDailyGb?: number;
    effectiveIngestPerGb?: number;
    monthly_volume_gb?: number;
    view?: 'summary';
  },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const horizon: BaselineHorizon = args.horizon ?? DEFAULT_HORIZON;
  const telemetry = newChassisTelemetry();

  const result = await computeBaseline(args, env, horizon);
  const headline = headlineFor(result);
  const rateSourceMapped = result.rate_source === 'customer_supplied' ? 'customer_supplied' as const
    : result.rate_source === 'list_price' ? 'list_price' as const
    : 'none' as const;

  // Build siem_vendor + source_label from the resolved env-config so a
  // reader can tell WHICH instance of result.destination the baseline
  // applies to (e.g. "datadog [prod-us | us-east-1]" vs the staging org).
  const envDisclosure = await buildSourceDisclosureFromEnv(env, result.destination ?? undefined);

  return buildChassisEnvelope({
    tool: 'log10x_baseline',
    view: 'summary',
    headline,
    status: result.status === 'ready' ? 'success' : 'insufficient_data',
    decisions: {
      // The prior code wired
      //   threshold_used: null
      //   threshold_basis: rate_source === 'customer_supplied' ? ... : 'default'
      // which leaks rate-source provenance into the chassis decision
      // block. rate_source belongs in source_disclosure.rate_source
      // (it's already there). The chassis decision block describes the
      // operationally meaningful THRESHOLD: here, the expected
      // reduction target the recommendation surfaces.
      threshold_used: result.status === 'ready' && result.recommended_target_range
        ? result.recommended_target_range.expected_pct
        : null,
      threshold_basis: result.status === 'ready' && result.recommended_target_range
        // Both branches are `unvalidated_default` against the chassis
        // enum because the recommendation formula itself uses
        // hand-picked coefficients (× 0.7, clamp [15, 60]) that aren't
        // calibrated for any specific customer. Drill into
        // payload.recommended_target_range.basis + .formula for the
        // operational provenance (heuristic vs hardcoded fallback).
        ? 'unvalidated_default'
        : 'default',
    },
    source_disclosure: {
      bytes_source: 'tsdb',
      rate_source: rateSourceMapped,
      ...envDisclosure,
      ...volumeLensDisclosure(result.volume_lens),
    },
    scope: {
      window: horizon,
      window_basis: 'explicit',
      candidates_count: result.top_contributors.length,
      // Previously this filtered to .compactable only, which on cloudwatch
      // (compact = no-op) returned 0 every time and contradicted both the
      // headline "Baseline ready" AND the 9 top contributors shown
      // immediately below. Any contributor is usable for SOME action
      // (drop/sample/offload/tier_down all work regardless of
      // compactability), so candidates_usable now reports the full count.
      // Compactable count is a separate downstream concern surfaced on
      // each row's .compactable field.
      candidates_usable: result.top_contributors.length,
    },
    payload: result,
    human_summary: headline,
    warnings: result.volume_lens.lensed && result.volume_lens.disclosure
      ? [result.volume_lens.disclosure]
      : undefined,
    telemetry,
  });
}

// ─── core logic ───────────────────────────────────────────────────────

async function computeBaseline(
  args: {
    horizon?: BaselineHorizon;
    destination?: SiemId;
    statedDailyGb?: number;
    effectiveIngestPerGb?: number;
    monthly_volume_gb?: number;
  },
  env: EnvConfig,
  horizon: BaselineHorizon
): Promise<BaselineEnvelopeData> {
  const horizonDays = horizon === '90d' ? 90 : 30;
  const metricsEnv = await resolveMetricsEnv(env);

  // ── Gate 0: destination. ────────────────────────────────────────
  // Without a destination there is no $/GB to project against.
  // Resolution order:
  //   1. Explicit arg (caller-supplied).
  //   2. resolveSiemSelection auto-detect (same helper cost_options /
  //      pattern_mitigate / estimate_savings use, reads env profile +
  //      SIEM connector heuristics).
  //   3. autoDetectDestination(env) env.analyzer string-match fallback.
  //   4. Gate failure → not_ready/no_destination.
  let destination: SiemId | undefined = args.destination;
  if (!destination) {
    const detected = await resolveSiemSelection({});
    destination =
      detected.kind === 'resolved'
        ? (detected.id as SiemId)
        : autoDetectDestination(env);
  }
  if (!destination) {
    return buildNotReadyEnvelope({
      reason: 'no_destination',
      horizon,
      rateSource: 'unset',
      remediation:
        'Pass `destination` (splunk | datadog | elasticsearch | clickhouse | cloudwatch | azure-monitor | gcp-logging | sumo) or set the env profile `analyzer` field.',
    });
  }

  // Resolve rate_source once for every downstream envelope (success +
  // not_ready). Destination is non-null past Gate 0, so the fallback when
  // no customer override is supplied is always `list_price`.
  // Honor the SHARED rate resolver (lib/rate-resolution.ts) — the SAME
  // priority chain services / top_patterns / estimate_savings walk: caller
  // arg → envs.json analyzerCost → LOG10X_ANALYZER_COST → destination list.
  // Prior to this, baseline rolled its own arg-only check and fell back to
  // list_price even when a customer rate was configured on the env, so the
  // SAME env showed services $1.50 customer_supplied vs baseline $0.50
  // list_price. Destination is non-null past Gate 0, so resolveRate never
  // returns 'unset' here (rung 4 yields the destination list price).
  const resolvedRate = resolveRate(
    { effective_ingest_per_gb: args.effectiveIngestPerGb },
    env,
    destination,
  );
  const rateSource: RateSource = resolvedRate.source;

  // ── Gate 1: Reporter age. ───────────────────────────────────────
  const minDays = readMinAgeOverride() ?? DEFAULT_MIN_REPORTER_AGE_DAYS;
  const reporterAge = await fetchReporterAgeDays(env, metricsEnv);
  if (reporterAge === null) {
    // No Reporter timestamp at all → Reporter not deployed.
    return buildNotReadyEnvelope({
      reason: 'reporter_too_new',
      destination,
      horizon,
      rateSource,
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
      rateSource,
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
      rateSource,
      reporterAgeDays: reporterAge,
      remediation:
        'Reporter is deployed but has not emitted bytes metrics yet in the chosen window. Verify the engine is wired to the metrics backend the MCP is reading from.',
    });
  }

  const totalBytes = validDays.reduce((s, x) => s + x, 0);
  // Switch from binary GB (1024^3) to decimal GB (10^9) to match the
  // catalog-wide CloudWatch/Datadog/Splunk billing convention used by
  // bytesToGb. Prior binary divisor here vs decimal divisor in
  // fetchTopContributors caused ~7% drift between current.monthly_usd
  // and the sum-of-contributors check.
  const observedDailyGb = bytesToGb(totalBytes / Math.max(1, validDays.length));

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
        rateSource,
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
      rateSource,
      reporterAgeDays: reporterAge,
      coveragePct,
      remediation: `Day ${anomaly.dayOffset} of the trailing ${horizonDays}d window had ${anomaly.multiplier.toFixed(1)}× the rolling 7d median bytes. Wait ${ANOMALY_COOLDOWN_DAYS}d after this anomaly window then re-run baseline; otherwise the percentile math will be biased by the spike.`,
    });
  }

  // ── Volume projection lens. ─────────────────────────────────────
  // Resolve ONCE against the env's measured monthly bytes (mean daily ×
  // 30). The factor folds into a SCALED copy of the daily series so every
  // downstream magnitude (percentiles, mean, total, monthly $, 90d
  // projection, per-contributor $) inherits it, while coverage_pct stays
  // on the UNSCALED observed volume and growth_pct / shares stay on the
  // UNSCALED series — those are ratios the uniform factor cancels in.
  // factor 1 (no monthly_volume_gb, or no basis) => scaledDays == validDays
  // => byte-for-byte identical to today.
  const actualMonthlyBytes = (totalBytes / Math.max(1, validDays.length)) * DAYS_PER_MONTH;
  const volumeLens = resolveVolumeLens(args.monthly_volume_gb, actualMonthlyBytes);
  const f = volumeLens.factor;
  const scaledDays = validDays.map((d) => d * f);
  const totalBytesScaled = totalBytes * f;

  // ── All gates passed. Compute the baseline. ─────────────────────
  const sorted = [...scaledDays].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);

  // Monthly $ = bytes/day_p50 × 30 × ($/GB ingest + $/GB-month storage).
  // When the caller supplied `effective_ingest_per_gb` we honour it on the
  // ingest axis; storage stays at list price (no per-customer storage
  // override surface in baseline today — kept consistent with cost.ts).
  const model = getDestinationCostModel(destination);
  const ingestPerGb =
    rateSource === 'customer_supplied'
      ? (resolvedRate.rate_per_gb as number)
      : model.ingest_per_gb;
  // Two fixes here.
  //  (1) Use decimal GB (bytesToGb) instead of binary 1024^3 to match
  //      the catalog convention and what fetchTopContributors uses.
  //  (2) Use window MEAN bytes (totalBytes / validDays) × 30, not p50.
  //      Per-contributor monthly_usd is mean-based (bytes / horizonDays
  //      × 30) so deriving the total from p50 left the sum-of-contributors
  //      disagreeing with current.monthly_usd by ~6.6% on right-tailed
  //      log volume distributions (observed $505 sum vs $473.69 headline).
  //      Mean-based makes the math consistent: sum(per-contributor
  //      monthly_usd) equals current.monthly_usd within float tolerance.
  //      p50 stays as bytes_per_day_p50 for tail planning, p90 stays for
  //      capacity.
  const meanDailyBytes = totalBytesScaled / Math.max(1, validDays.length);
  const monthlyGb = bytesToGb(meanDailyBytes * DAYS_PER_MONTH);
  const monthlyUsd = monthlyGb * (ingestPerGb + model.storage_per_gb_month);

  // growth_pct is a tail-ratio of the daily series — factor-invariant under
  // uniform scaling, so compute it from the UNSCALED validDays explicitly.
  const growthPct = computeGrowthPct(validDays);
  const monthlyUsdIn90d = monthlyUsd * Math.pow(1 + growthPct, 3);

  const top = await fetchTopContributors(
    env,
    metricsEnv,
    horizonDays,
    totalBytesScaled,
    destination,
    ingestPerGb,
    f
  );

  const recommended = recommendTargetRange(top);

  // Disclosed-value mirrors so renderers can call fmtDisclosedDollar
  // without re-resolving rate_source + siemLabel + listRate.
  const siemLabel = SIEM_DISPLAY_NAMES[destination] ?? null;
  const monthlyUsdDisclosed = buildDisclosedDollarValue(
    monthlyUsd,
    rateSource,
    siemLabel,
    ingestPerGb
  );
  const monthlyUsdIn90dDisclosed = buildDisclosedDollarValue(
    monthlyUsdIn90d,
    rateSource,
    siemLabel,
    ingestPerGb
  );

  return {
    status: 'ready',
    reporter_age_days: reporterAge,
    coverage_pct: coveragePct,
    destination,
    horizon,
    rate_source: rateSource,
    effective_per_gb: rateSource === 'unset' ? null : ingestPerGb,
    current: {
      bytes_window: totalBytesScaled,
      bytes_window_display: fmtBytes(totalBytesScaled),
      bytes_per_day_p50: p50,
      bytes_per_day_p50_display: fmtBytes(p50),
      bytes_per_day_p90: p90,
      bytes_per_day_p90_display: fmtBytes(p90),
      monthly_usd: monthlyUsd,
      monthly_usd_at_list: monthlyUsd,
      monthly_usd_disclosed: monthlyUsdDisclosed,
    },
    projection_no_action_90d: {
      monthly_usd_in_90d: monthlyUsdIn90d,
      monthly_usd_in_90d_at_list: monthlyUsdIn90d,
      monthly_usd_in_90d_disclosed: monthlyUsdIn90dDisclosed,
      // growth_pct is the MONTHLY COMPOUND rate (e.g. 0.36 = 36%/mo), but
      // the field name + parent object ("projection_no_action_90d") biased
      // CFO readers toward interpreting it as the 90d total growth, a 46%
      // under-read risk. Surface both values with unambiguous names; keep
      // the legacy growth_pct alias so existing consumers don't break.
      growth_pct: growthPct,
      monthly_compound_growth_pct: growthPct,
      // Emit the percent-shaped sibling so consumers reading `_pct` at
      // face value (where share_pct=16.09 means 16.09% in the same
      // envelope) get the consistent reading.
      monthly_compound_growth_percent: growthPct * 100,
      horizon_total_growth_pct:
        monthlyUsd > 0 && monthlyUsdIn90d != null
          ? monthlyUsdIn90d / monthlyUsd - 1
          : 0,
      horizon_total_growth_percent:
        monthlyUsd > 0 && monthlyUsdIn90d != null
          ? (monthlyUsdIn90d / monthlyUsd - 1) * 100
          : 0,
    },
    top_contributors: top,
    volume_lens: volumeLens,
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
  const q = `min(min_over_time(timestamp(all_events_summaryBytes_total{tenx_app=~"reporter|receiver",${env.labels.env}="${metricsEnv}"})[30d:1d]))`;
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
  const q = `sum(increase(all_events_summaryBytes_total{tenx_app=~"reporter|receiver",${env.labels.env}="${metricsEnv}"}[1d]))`;
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
  destination: SiemId,
  ingestPerGb: number,
  // Volume-lens factor. 1 on a measured run. Scales per-contributor bytes
  // (and therefore monthly_usd) but NOT avg_event_size_bytes (computed from
  // raw bytes/events — bytes/event is invariant under uniform scaling) and
  // NOT share_pct (totalBytes is passed already-scaled, so numerator and
  // denominator scale together).
  factor: number = 1,
): Promise<BaselineTopContributor[]> {
  const labels = env.labels;
  const range = `${horizonDays}d`;
  const bytesQ = `topk(10, sum by (${labels.pattern}, ${labels.service}, ${labels.severity}, ${labels.hash}) (increase(all_events_summaryBytes_total{tenx_app=~"reporter|receiver",${labels.env}="${metricsEnv}"}[${range}])))`;
  const eventsQ = `sum by (${labels.pattern}, ${labels.service}, ${labels.severity}, ${labels.hash}) (increase(all_events_summaryVolume_total{tenx_app=~"reporter|receiver",${labels.env}="${metricsEnv}"}[${range}]))`;

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
    const rawBytes = parsePrometheusValue(r);
    if (rawBytes <= 0) continue;
    // Scaled bytes drive share_pct (denom passed pre-scaled) and monthly_usd.
    // avg_event_size_bytes below uses rawBytes/rawEvents so it never moves.
    const bytes = rawBytes * factor;
    // Drop rows where both pattern_hash and message_pattern are empty strings.
    // These are aggregate or per-container rollup series (emitted by
    // tenx_app="reporter|receiver") that carry no per-pattern labels and would
    // appear as zero-identity contributor rows in the result.
    // TODO: handle empty pattern_hash (a metric series with a missing
    //       message_pattern label).
    const rawHash    = String(r.metric[labels.hash]    ?? '');
    const rawPattern = String(r.metric[labels.pattern] ?? '');
    if (rawHash === '') continue;
    const key = topKey(r.metric, labels);
    const events = eventsByKey.get(key) ?? 0;
    // avg_event_size_bytes is bytes/event — invariant under uniform scaling.
    // Compute from RAW bytes/events so a lensed run reports the same per-event
    // size as the measured run (the canonical leak trap).
    const avgSize = events > 0 ? rawBytes / events : 0;
    const sharePct = totalBytes > 0 ? (bytes / totalBytes) * 100 : 0;

    // Monthly $ = (window_bytes ÷ horizonDays) × 30 × $/GB. Uses the rate
    // resolved by `computeBaseline` (customer_supplied when supplied; else
    // vendors.json list).
    const monthlyBytes = (bytes / horizonDays) * DAYS_PER_MONTH;
    const monthlyUsd =
      bytesToGb(monthlyBytes) *
      (ingestPerGb + model.storage_per_gb_month);

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
      monthly_usd_at_list: monthlyUsd,
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
  basis: 'drop_only_fallback' | 'compactable_share_heuristic';
  formula: string;
  inputs: {
    share_top5_compactable_pct: number;
  };
} {
  const top5 = top.slice(0, 5);
  const compactableShare = top5
    .filter((t) => t.compactable)
    .reduce((s, t) => s + t.share_pct, 0);

  // Destination doesn't support compaction (or no compactable
  // top-5 contributors) → drop-only band.
  // A hardcoded {10/15/25}% range was shipping without basis disclosure,
  // surfacing as if it were calibrated when it's a hand-picked
  // conservative fallback. Expose `basis` + `formula` + the input that
  // drove the branch so a CFO reader can audit the recommendation
  // instead of trusting the band.
  if (compactableShare <= 0) {
    return {
      low_pct: 10,
      expected_pct: 15,
      high_pct: 25,
      basis: 'drop_only_fallback',
      formula: 'hardcoded_conservative_band',
      inputs: { share_top5_compactable_pct: 0 },
    };
  }

  // share_top5_compactable is already in percent (0..100); the formula
  // multiplies by 0.7 and stays in percent space.
  const raw = compactableShare * 0.7;
  const expected = Math.round(Math.min(60, Math.max(15, raw)));
  const low = Math.max(MIN_RECOMMENDED_PCT, expected - 15);
  const high = Math.min(MAX_RECOMMENDED_PCT, expected + 15);

  return {
    low_pct: low,
    expected_pct: expected,
    high_pct: high,
    basis: 'compactable_share_heuristic',
    formula: 'expected = clamp(15, 60, share_top5_compactable_pct * 0.7); low = max(10, expected-15); high = min(80, expected+15)',
    inputs: { share_top5_compactable_pct: compactableShare },
  };
}

// ─── not-ready envelope builder ───────────────────────────────────────

function buildNotReadyEnvelope(opts: {
  reason: NotReadyReason;
  destination?: SiemId;
  horizon?: BaselineHorizon;
  rateSource: RateSource;
  reporterAgeDays?: number;
  coveragePct?: number;
  remediation: string;
}): BaselineEnvelopeData {
  // Dollar fields collapse to null when no rate is resolvable (no
  // destination + no customer override). Keeps callers from reading 0 as a
  // real projection.
  const dollarsKnown = opts.rateSource !== 'unset';
  const zeroMonthly = dollarsKnown ? 0 : null;
  // Disclosed mirrors are null whenever the underlying number is null —
  // not_ready gate failures don't emit dollar lines anyway (the headline
  // returns early on `not_ready`), so we don't synthesise a disclosure.
  return {
    status: 'not_ready',
    not_ready_reason: opts.reason,
    reporter_age_days: opts.reporterAgeDays ?? 0,
    coverage_pct: opts.coveragePct ?? 0,
    destination: opts.destination ?? null,
    horizon: opts.horizon ?? DEFAULT_HORIZON,
    rate_source: opts.rateSource,
    current: {
      bytes_window: 0,
      bytes_window_display: fmtBytes(0),
      bytes_per_day_p50: 0,
      bytes_per_day_p50_display: fmtBytes(0),
      bytes_per_day_p90: 0,
      bytes_per_day_p90_display: fmtBytes(0),
      monthly_usd: zeroMonthly,
      monthly_usd_at_list: zeroMonthly,
      monthly_usd_disclosed: null,
    },
    projection_no_action_90d: {
      monthly_usd_in_90d: zeroMonthly,
      monthly_usd_in_90d_at_list: zeroMonthly,
      monthly_usd_in_90d_disclosed: null,
      growth_pct: 0,
      monthly_compound_growth_pct: 0,
      monthly_compound_growth_percent: 0,
      horizon_total_growth_pct: 0,
      horizon_total_growth_percent: 0,
    },
    top_contributors: [],
    // not_ready gates never scale anything; the lens is a clean no-op here.
    volume_lens: {
      actual_monthly_bytes: null,
      projected_monthly_bytes: null,
      factor: 1,
      lensed: false,
      basis: 'none',
      disclosure: null,
    },
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
  // Percent-first: target reduction band leads. Volume (bytes) is the
  // second beat. Dollars are an overlay gated on rate_source.
  const r = d.recommended_target_range;
  const band = r
    ? `target band ${r.low_pct}-${r.high_pct}% (expected ${r.expected_pct}%)`
    : 'target band unavailable';
  const volume = `${fmtBytes(d.current.bytes_per_day_p50)}/day p50`;
  let dollarClause = '';
  if (
    d.rate_source !== 'unset' &&
    d.current.monthly_usd_disclosed != null &&
    d.projection_no_action_90d.monthly_usd_in_90d_disclosed != null
  ) {
    const cur = d.current.monthly_usd_disclosed;
    const fut = d.projection_no_action_90d.monthly_usd_in_90d_disclosed;
    // Format raw dollar amounts without the per-value disclosure tail so
    // the parenthetical appears exactly once at the end of the clause.
    const curAmt  = cur.source === 'unset'  ? '—' : fmtDollar(cur.value);
    const futAmt  = fut.source === 'unset'  ? '—' : fmtDollar(fut.value);
    // Pick whichever non-null disclosure string is available (both carry the
    // same text when source === 'list_price'; neither fires for customer_supplied).
    const disclosure = cur.disclosure ?? fut.disclosure ?? null;
    const tail = disclosure ? ` ${disclosure}` : '';
    dollarClause = ` · ${curAmt}/mo current, ${futAmt}/mo projected 90d no-action${tail}`;
  }
  let headline = `Baseline ready: ${band} · ${volume}${dollarClause}.`;
  // Volume projection lens: mark the headline so a lensed run is never
  // mistaken for measured volume.
  if (d.volume_lens.lensed) {
    const pg = (d.volume_lens.projected_monthly_bytes ?? 0) / 1_000_000_000;
    const lab = pg >= 1000 ? `${(pg / 1000).toFixed(pg >= 10000 ? 0 : 1)} TB` : `${pg.toFixed(pg >= 10 ? 0 : 1)} GB`;
    headline = `[Projected to ${lab}/mo] ${headline}`;
  }
  return headline;
}

// Re-export Action so callers that want to type per-contributor tier choices
// can do so without re-importing from cost.ts.
export type { Action };
