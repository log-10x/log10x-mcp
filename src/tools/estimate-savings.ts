/**
 * log10x_estimate_savings — forecast and verify per-pattern reduction policy.
 *
 * Two modes share one file because they share the same per-destination cost
 * model and PromQL plumbing. `runEstimateForecast` and `runEstimateVerify`
 * are exported as pure functions so `configure_engine` can fold a forecast
 * into its own envelope without re-querying.
 *
 * MODE: forecast
 *   Input is either:
 *     (a) `proposed_config`: explicit per-pattern (action, optional cap)
 *         rows, e.g. produced by `configure_engine`'s greedy solver.
 *     (b) `target_percent`: a % reduction goal. We run the same greedy
 *         the solver uses (sorted by 30d bytes DESC), assigning the
 *         destination's `action_defaults.standard` action until we hit
 *         the target.
 *   For each row we look up the 30d bytes + events, compute avg event
 *   size, project low/expected/high savings via projectActionRange, and
 *   aggregate totals + coverage. Caveats surface destination/no-op
 *   mismatches and small-event degradation.
 *
 * MODE: verify
 *   Input is `baseline_window` (pre-merge) + `post_window` (post-merge).
 *   We query `all_events_summaryBytes_total` segmented by the engine's
 *   `routeState` label (TenXSummary emits it on the
 *   receive aggregator):
 *     - baseline_bytes      : sum over baseline (routeState!="drop" only)
 *     - post_passed_bytes   : sum over post (routeState!="drop" only)
 *     - post_dropped_bytes  : sum over post (routeState="drop")
 *   `delivered_pct = 1 - (post_passed_bytes / scale(baseline_bytes,...))`
 *   and we attribute the gap to four buckets:
 *     - cap_fired   : bytes the engine dropped for patterns that
 *                     existed in the baseline (i.e. the policy worked)
 *     - drift       : organic growth on patterns we DIDN'T cap
 *     - new_patterns: bytes from patterns that weren't in the baseline
 *     - leakage     : bytes that passed for patterns we SHOULD have
 *                     capped (cap mis-set, no row, sample_n too loose)
 *
 * GRACEFUL-NOT-CONFIGURED NOTE
 *   The spec calls for `NotConfiguredError` from `lib/not-configured.ts`.
 *   That framework hasn't landed here; the equivalent existing primitive is
 *   `CustomerMetricsNotConfiguredError` thrown from `resolveBackend()`.
 *   We don't use that: our queries hit the env's own metrics backend
 *   (Reporter / Receiver TenXSummary metrics live on `env.metricsBackend`,
 *   not the cross-pillar customer backend), same as `savings.ts` and
 *   `trend.ts`. Structured-error envelopes are emitted directly with
 *   `phase` + `error` fields. When the graceful-not-configured framework
 *   lands, swap the inline envelopes for `notConfiguredEnvelopeFromError`.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { iQueryInstant, QUERY_BUDGET } from '../lib/interactive-query.js';
import {
  projectActionRange,
  resolveTierDownTier,
  getDestinationCostModel,
  getDefaultActionForDestination,
  annualizeDollars,
  type Action,
} from '../lib/cost.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { resolveRate } from '../lib/rate-resolution.js';
import { resolveSiemLens, lensDisclosure, SIEM_LENS_ENUM } from '../lib/siem/lens.js';
import { resolveVolumeLens, volumeLensDisclosure, type VolumeLensResolution } from '../lib/volume-lens.js';
import {
  type StructuredOutput,
} from '../lib/output-types.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  newChassisTelemetry,
  recordQuery,
} from '../lib/chassis-envelope.js';
import { buildSourceDisclosureFromEnv } from '../lib/source-disclosure.js';
import { fmtDollar, fmtPct, fmtBytes } from '../lib/format.js';
import {
  parseCapCsv,
  emptyActionBuckets,
  totalAttributedBytes,
  type ActionBytesBuckets,
} from '../lib/cap-csv-parser.js';
import { parseActionIntent } from '../lib/action-intent-parser.js';
import { resolveSiemSelection } from '../lib/siem/resolve.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import * as pql from '../lib/promql.js';
import { type FilterValue } from '../lib/promql.js';

// ─── constants ──────────────────────────────────────────────────────────
const BYTES_METRIC = 'all_events_summaryBytes_total';
const VOLUME_METRIC = 'all_events_summaryVolume_total';
const GB = 1_000_000_000; // decimal GB — matches CloudWatch/Datadog/Splunk billing
/** Forecast period is always normalized to a 30-day month. */
const MONTH_DAYS = 30;

// ─── schema ─────────────────────────────────────────────────────────────

const proposedRow = z.object({
  pattern_hash: z.string().describe('Stable pattern identity (tenx_hash).'),
  action: z
    .enum(['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop'])
    .describe('Action the receiver would take for this pattern.'),
  cap_bytes_per_window: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      'Per-5min-window cap in bytes. Informational; the forecast computes savings from `action` alone.'
    ),
  sample_n: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("For action='sample', N where we keep 1 in N. Default 10."),
});

const DEST_ENUM = z.enum([
  'splunk',
  'datadog',
  'elasticsearch',
  'clickhouse',
  'cloudwatch',
  'azure-monitor',
  'gcp-logging',
  'sumo',
]);

export const estimateSavingsSchema = {
  mode: z
    .enum(['forecast', 'verify'])
    .default('forecast')
    .describe(
      'forecast: project savings of a proposed per-pattern policy (or a target_percent). verify: measure realized savings from a deployed policy by comparing baseline vs post-merge windows.'
    ),
  // ── forecast inputs ────────────────────────────────────────────────
  proposed_config: z
    .array(proposedRow)
    .optional()
    .describe(
      'forecast mode: explicit per-pattern (action, optional cap) rows. Either this OR target_percent is required.'
    ),
  target_percent: z
    .number()
    .min(1)
    .max(95)
    .optional()
    .describe(
      'forecast mode: % volume reduction goal. Tool runs the same greedy solver as configure_engine on observed 30d bytes.'
    ),
  default_action: z
    .enum(['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop'])
    .default('compact')
    .describe(
      'forecast mode: action assigned to top patterns by the greedy solver when target_percent is used. This is a hard constraint — every per_pattern row receives this action (subject to destination compatibility: compact is silently replaced by the destination canonical action when compact_mode=no-op). Default: compact.'
    ),
  pattern_limit: z
    .number()
    .int()
    .positive()
    .default(50)
    .describe(
      'forecast mode: maximum number of per_pattern rows returned. Default 50 when service is omitted; ignored (unlimited) when service is set. Totals and coverage_pct are always computed over the full solver result before slicing.'
    ),
  destination: DEST_ENUM.optional().describe(
    'Destination stack. Required for both modes (used to look up ingest $/GB + compact ratio band).'
  ),
  siem_lens: z.enum(SIEM_LENS_ENUM).optional().describe(
    'What-if destination lens (alias of `destination` with provenance stamping): price the projection for THIS destination while the pipeline keeps its actual one. Envelope stamps siem_actual vs siem_lens.'
  ),
  monthly_volume_gb: z.number().positive().optional().describe(
    'What-if volume lens (forecast mode): model the environment at THIS monthly volume (decimal GB/month) instead of its measured volume. The real per-pattern shares and pattern mix are held fixed; only absolute bytes and dollars scale, by one uniform factor. Use it to project a prospect onto their own scale, or to forecast a real env after growth. Pairs with `siem_lens`. This is a PROJECTION: the envelope stamps volume_actual_gb vs volume_projected_gb and the scale factor, and the note points at the POC for the caller\'s real patterns.'
  ),
  es_pruned: z
    .boolean()
    .optional()
    .describe(
      'Elasticsearch only: are compactable fields excluded from _source? Default false — the unpruned ratio band is used.'
    ),
  tier_down_plan: z
    .string()
    .optional()
    .describe(
      'Which tier_down plan to price when the action is tier_down. Matches the plan name (case-insensitive substring): omit for the destination default (e.g. Azure Basic Logs), or pass e.g. "auxiliary" to price the aggressive alternative (Azure Auxiliary Logs). No effect on destinations without an alternative tier.'
    ),
  service: z
    .string()
    .optional()
    .describe(
      'Scope the target_percent greedy solver and coverage_pct to a single service. When present, only patterns from that service are candidates; coverage_of_env_pct and dollar totals reflect that service only. pattern_limit is ignored (all service patterns are returned). If omitted, runs across all services.'
    ),
  retention_months: z
    .number()
    .positive()
    .default(1)
    .describe('Retention window for storage cost. Default 1 month.'),
  observation_window: z
    .string()
    .regex(/^\d+[dh]$/)
    .optional()
    .describe(
      'forecast mode: PromQL range expression for the observation window the solver/projection runs over. Default `30d`. Accepts `1h`, `24h`, `7d`, `30d`, etc. Alias: `timeRange`.'
    ),
  timeRange: z
    .string()
    .optional()
    .describe(
      'forecast mode: alias for `observation_window` for consistency with other Log10x tools. If both are set, `observation_window` wins.'
    ),
  // ── verify inputs ──────────────────────────────────────────────────
  baseline_window: z
    .string()
    .regex(/^\d+[dh]$/)
    .optional()
    .describe(
      'verify mode: PromQL range expression for the pre-merge window, e.g. "7d", "168h".'
    ),
  post_window: z
    .string()
    .regex(/^\d+[dh]$/)
    .optional()
    .describe(
      'verify mode: PromQL range expression for the post-merge window, e.g. "7d".'
    ),
  commitment_id: z
    .string()
    .optional()
    .describe(
      'verify mode: when present, the verify output is shaped as a commitment delta (used by log10x_commitment_report).'
    ),
  contract_type: z
    .enum(['committed', 'on_demand'])
    .optional()
    .describe(
      'verify mode: shapes the dollar projection (committed vs on-demand renewal math).'
    ),
  effective_ingest_per_gb: z
    .number()
    .positive()
    .optional()
    .describe(
      "forecast and verify mode: override the destination list-price rate with the customer's contracted $/GB. When supplied, dollar projections use this rate and surface rate_source='customer_supplied'."
    ),
  // ── presentation ──────────────────────────────────────────────────
  enforcement_mode: z
    .enum(['engine', 'manual_report'])
    .optional()
    .describe(
      "forecast mode: when manual_report, reframes the headline as a potential-savings estimate under external enforcement rather than engine enforcement. Headline reads 'If you enforce externally: X savings potential. Enforcement choice is yours.' instead of the standard forecast headline."
    ),
  // ── shared ─────────────────────────────────────────────────────────
  environment: z
    .string()
    .optional()
    .describe('Environment nickname; routes to the right metrics backend.'),
};
const schemaObj = z.object(estimateSavingsSchema);
export type EstimateSavingsArgs = z.infer<typeof schemaObj>;

// ─── typed output ───────────────────────────────────────────────────────

export interface ForecastRow {
  pattern_hash: string;
  /** Dominant service for this pattern. User-facing renderers MUST use this
   * (and symbol_message) on user-visible cells, never the raw pattern_hash. */
  service: string;
  /** Pattern descriptor (symbol_message). Empty string when the metric
   * backend didn't surface a label value for this hash. */
  symbol_message: string;
  action: Action;
  bytes_in_monthly: number;
  bytes_in_monthly_display: string;
  bytes_saved_monthly: number;
  bytes_saved_monthly_display: string;
  avg_event_size_bytes: number;
  avg_event_size_bytes_display: string;
  dollars_saved_low: number;
  dollars_saved_expected: number;
  dollars_saved_high: number;
  notes?: string[];  siem_lens?: string;
}

export interface ForecastResult {
  mode: 'forecast';
  /** Volume projection lens result. `lensed:false` when the env's real volume was used. */
  volume_lens: VolumeLensResolution;
  destination: SiemId;
  es_pruned?: boolean;
  service?: string;
  observation_window: string;
  target_percent?: number;
  per_pattern: ForecastRow[];
  /** True when per_pattern was sliced to pattern_limit (service-omitted mode). */
  per_pattern_truncated: boolean;
  /** Total number of modeled patterns before the limit slice. */
  per_pattern_total_count: number;
  /**
   * Per-service rollup. Populated when service is omitted; aggregated from
   * per_pattern AFTER the solver over the full (pre-slice) result set.
   */
  per_service?: Array<{
    service: string;
    pattern_count: number;
    bytes_saved_monthly: number;
    dollars_saved_expected: number;
  }>;
  totals: {
    bytes_in_monthly: number;
    /**
     * Env-wide observed monthly bytes — the denominator that
     * `coverage_of_env_pct` divides into `bytes_in_monthly` to compute
     * the coverage percent. When `args.service` is set, `bytes_in_monthly`
     * is the service-scope total and this field is the wider env-wide
     * total; when no service filter is set the two are equal. Exposed so
     * the headline coverage % is reconstructible from the envelope
     * without a hidden side query.
     */
    env_bytes_in_monthly: number;
    bytes_saved_monthly: number;
    dollars_low_monthly: number;
    dollars_expected_monthly: number;
    dollars_high_monthly: number;
    annual_projection_expected: number;
    /**
     * Disclose the extrapolation method for annual_projection_expected so
     * consumers understand it's a naive monthly × 12, NOT a
     * seasonality-adjusted forecast. Matches the projection_basis pattern
     * in savings.ts.
     */
    projection_basis: {
      method: 'linear_extrapolation';
      scale_factor: 12;
      basis_value: 'dollars_expected_monthly';
      note: string;
    };
    /**
     * Per-action breakdown of the forecast totals. Populated by the
     * executeEstimateSavings path so renderers can surface which
     * dollar/byte contribution came from which action.
     *
     * tier_down.bytes_saved is always 0 (byte volume is unchanged); savings
     * come from the lower per-GB rate at the cheaper destination tier, which
     * cuts both the ingest and storage rate. cost.ts computes the full
     * standard-vs-tier rate delta.
     */
    action_mix?: ActionMix;
  };
  /**
   * Fraction of TOTAL observed monthly env bytes that this forecast covers.
   * For a single-pattern proposed_config this is typically small (e.g. 0.01
   * = 1% of env bytes). Use coverage_of_proposed_pct for "how complete is
   * this forecast relative to what was requested".
   */
  coverage_of_env_pct: number;
  /**
   * The `_pct` suffix is misleading on
   * coverage_of_env_pct (the value 0.97 means "97%" but is stored as a
   * decimal ratio). Sibling `_percent` field stores the true-percent
   * value (97.27, not 0.9727) so consumers reading the `_pct` naming
   * convention used by sibling share_pct fields in this envelope (where
   * share_pct=16.09 means 16.09%) get the consistent reading.
   */
  coverage_of_env_percent: number;
  /**
   * @deprecated use coverage_of_env_pct. Kept for backward compatibility.
   */
  coverage_pct: number;
  /**
   * For the greedy/target_percent path: fraction of the total candidate bytes
   * (all observed patterns) that the solver actually modeled. For the
   * explicit proposed_config path this is always 1.0 (100%) because the
   * caller specified every row they care about.
   */
  coverage_of_proposed_pct: number;
  /** Same value × 100. 97.27 means "97.27% of proposed bytes modeled". */
  coverage_of_proposed_percent: number;
  /**
   * Source of the $/GB rate used to compute dollar projections.
   *  - 'customer_supplied' — caller passed effective_ingest_per_gb
   *  - 'list_price'        — from COST_MODEL_BY_DESTINATION.ingest_per_gb
   */
  rate_source: 'list_price' | 'customer_supplied';
  /**
   * Human-readable disclosure of the rate used. Null when customer_supplied
   * (no caveat needed). Non-null for list_price.
   */
  rate_disclosure: string | null;
  /**
   * Provenance of the bytes data — allows an agent to explain why two tools
   * show different numbers when called with different windows or cohorts.
   */
  bytes_source: {
    metric: string;
    observation_window: string;
    cohort: 'kept';
    scope_filter: string;
  };
  /**
   * Pattern-universe count from the same scope as bytes_source. Null when the
   * distinctPatternCount query failed or returned no data.
   */
  pattern_count_source: {
    query: 'distinctPatternCount';
    count: number | null;
    window: string;
  };
  caveats: string[];
}

export interface VerifyAttribution {
  cap_fired_bytes: number;
  drift_bytes: number;
  new_patterns_bytes: number;
  leakage_bytes: number;
}

export interface VerifyResult {
  mode: 'verify';
  destination: SiemId;
  commitment_id?: string;
  baseline_window: string;
  post_window: string;
  /** Echo of the honored baseline offset (pre-policy anchor); absent when none/invalid. */
  baseline_offset?: string;
  baseline_bytes: number;
  post_passed_bytes: number;
  post_dropped_bytes: number;
  /** baseline scaled to the same window length as post_window for an apples-to-apples ratio. */
  baseline_bytes_scaled: number;
  delivered_pct: number;
  delivered_dollars_now: number;
  delivered_dollars_annual_projection: number;
  delivered_dollars_at_renewal?: number;
  attribution: VerifyAttribution;
  attribution_pct: VerifyAttribution;
  causal_confidence: number;
  /**
   * Source of the $/GB rate used to compute the dollar projections.
   *  - 'customer_supplied' — caller passed `effective_ingest_per_gb`
   *  - 'list_price'        — from `getDestinationCostModel().ingest_per_gb`
   * Propagated by the commitment-report adapter into per-week
   * `WeeklyVerifyResult.rate_source` (the verifier always has one).
   */
  rate_source: 'list_price' | 'customer_supplied';
  /**
   * Bytes saved by each engine action, joined from the cap-CSV.
   * Populated only when the caller passed `cap_csv_content`; absent
   * otherwise.
   *
   * Parts-≤-whole invariant: `totalAttributedBytes(per_action_breakdown)`
   * + `unattributed` ≤ `post_dropped_bytes` after the offload clamp;
   * see `clampOffloadToResidual` for the residual rule.
   */
  per_action_breakdown?: ActionBytesBuckets;
  /**
   * Per-pattern attribution rows. One row per pattern_hash with
   * non-zero routeState="drop" bytes in the post window. Action is
   * sourced from the cap-CSV via `buildPatternActionLookup`; rows
   * with no cap-CSV match are emitted with `action: 'drop'` and
   * `action_source: 'unattributed'` so the offload clamp + caveat
   * surfacing can identify them.
   */
  per_pattern_breakdown?: Array<{
    pattern_hash: string;
    /** Human pattern name (TSDB pattern label); falls back to the hash. */
    pattern: string;
    action: Action;
    delivered_bytes: number;
    /**
     * Expected bytes saved at this pattern's cap, scaled to the post
     * window. Null when the cap-CSV has no row for this hash.
     */
    expected_bytes: number | null;
    /**
     * How the action was attributed:
     *  - 'pat_row'      — from a `pat:<hash>` row in the cap-CSV
     *  - 'container'    — from the container-default row
     *  - 'unattributed' — no row matched; action defaulted to 'drop'
     */
    action_source: 'pat_row' | 'container' | 'unattributed';
  }>;
  caveats: string[];
}

// ─── helpers ────────────────────────────────────────────────────────────

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function selectorWithEnv(env: EnvConfig, extra: string[] = []): string {
  // `env.labels.env` is the engine's pipeline-stage label (default tenx_env)
  // and its values are 'edge' or 'cloud', NOT the env UUID. The auth header
  // (`X-10X-Auth: <key>/<env_uuid>`) already scopes queries to the tenant on
  // the backend side, so we filter by the pipeline stage where Receiver
  // metrics live (edge) plus the receiver|reporter app filter so the merged
  // engine architecture (Receiver took over Reporter's role) is matched.
  const parts = [
    ...extra,
    `tenx_app=~"reporter|receiver"`,
    `${env.labels.env}="edge"`,
  ];
  return parts.join(',');
}

/** Parse `7d` or `168h` into a day count. */
function parseWindowToDays(s: string): number {
  const m = s.match(/^(\d+)([dh])$/);
  if (!m) throw new Error(`bad window: ${s}`);
  const n = parseInt(m[1], 10);
  return m[2] === 'd' ? n : n / 24;
}

function parsePromResult(
  res: {
    data?: {
      result?: Array<{
        metric: Record<string, string>;
        value?: [number, string];
      }>;
    };
  } | null,
  keyLabel: string
): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = res?.data?.result ?? [];
  for (const row of rows) {
    const key = row.metric?.[keyLabel];
    if (!key) continue;
    const v = row.value ? parseFloat(row.value[1]) : NaN;
    if (Number.isFinite(v)) out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

function parseScalarSum(res: {
  data?: { result?: Array<{ value?: [number, string] }> };
} | null): number {
  const rows = res?.data?.result ?? [];
  let sum = 0;
  for (const row of rows) {
    const v = row.value ? parseFloat(row.value[1]) : NaN;
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

function safeDiv(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

/**
 * Pull (hash → container) pairs from a Prometheus result keyed by both
 * labels. When a single pattern_hash is emitted from multiple containers
 * (multi-tenant aggregator), the container with the largest dropped-bytes
 * value wins — that's the one the cap-CSV container default most likely
 * applies to. Ties are broken by lexicographic container name for stable
 * test output.
 */
function extractHashContainerMap(
  res: {
    data?: {
      result?: Array<{
        metric: Record<string, string>;
        value?: [number, string];
      }>;
    };
  },
  hashLabel: string,
  containerLabel: string
): Map<string, string> {
  const acc = new Map<string, { container: string; bytes: number }>();
  const rows = res?.data?.result ?? [];
  for (const row of rows) {
    const hash = row.metric?.[hashLabel];
    const container = row.metric?.[containerLabel];
    if (!hash || !container) continue;
    const v = row.value ? parseFloat(row.value[1]) : NaN;
    const bytes = Number.isFinite(v) ? v : 0;
    const prior = acc.get(hash);
    if (!prior) {
      acc.set(hash, { container, bytes });
      continue;
    }
    if (
      bytes > prior.bytes ||
      (bytes === prior.bytes && container.localeCompare(prior.container) < 0)
    ) {
      acc.set(hash, { container, bytes });
    }
  }
  const out = new Map<string, string>();
  for (const [hash, { container }] of acc.entries()) {
    out.set(hash, container);
  }
  return out;
}

/**
 * Action-split + parts-≤-whole guard. Walks the per-hash dropped-bytes
 * series, attributes each hash's bytes to an action bucket, and clamps
 * the offload bucket to the residual so the sum never exceeds
 * `post_dropped_bytes`. Returns BOTH the bucket totals AND the per-pattern rows.
 *
 * Action resolution order (canonical as of action-intent migration):
 *   1. `actionIntentLookup` (from data/action-intent.json) — canonical
 *   2. Legacy cap-CSV `legacy_action_suffix` on the `pat:<hash>` row — backward compat
 *   3. Legacy cap-CSV `legacy_action_suffix` on the container-default row — backward compat
 *   4. Unattributed — no intent record and no legacy suffix
 */
export function computeActionSplit(args: {
  postDroppedByHash: Record<string, number>;
  hashToPattern?: Map<string, string>;
  capCsvContent?: string | null;
  actionIntentLookup?: Map<string, Action>;
  patternToContainer: Map<string, string>;
  postDroppedBytes: number;
}): {
  buckets: ActionBytesBuckets;
  rows: NonNullable<VerifyResult['per_pattern_breakdown']>;
  clamped: boolean;
} {
  // Parse the cap CSV for byte-cap context and legacy action suffixes.
  const parsed = args.capCsvContent ? parseCapCsv(args.capCsvContent) : null;
  const buckets = emptyActionBuckets();
  const rows: NonNullable<VerifyResult['per_pattern_breakdown']> = [];

  // Sort hashes by descending dropped bytes so the residual clamp acts
  // on the SMALLEST offload contributions first (preserves the largest
  // ones intact when the parts-sum approaches the whole).
  const sortedHashes = Object.entries(args.postDroppedByHash)
    .filter(([, b]) => Number.isFinite(b) && b > 0)
    .sort((a, b) => b[1] - a[1]);

  for (const [hash, droppedBytes] of sortedHashes) {
    const container = args.patternToContainer.get(hash);
    const patRow = parsed?.by_pattern.get(hash);
    const containerRow =
      container && parsed ? parsed.by_container.get(container) : undefined;

    let action_source: 'action_intent' | 'pat_row' | 'container' | 'unattributed';
    let effectiveAction: Action;
    let expectedBytes: number | null = null;

    // Resolution order: action-intent > legacy cap-CSV suffix > unattributed.
    if (args.actionIntentLookup?.has(hash)) {
      action_source = 'action_intent';
      effectiveAction = args.actionIntentLookup.get(hash)!;
      expectedBytes = patRow?.bytes_cap ?? containerRow?.bytes_cap ?? null;
    } else if (patRow?.legacy_action_suffix) {
      action_source = 'pat_row';
      effectiveAction = patRow.legacy_action_suffix;
      expectedBytes = patRow.bytes_cap;
    } else if (containerRow?.legacy_action_suffix) {
      action_source = 'container';
      effectiveAction = containerRow.legacy_action_suffix;
      expectedBytes = containerRow.bytes_cap;
    } else {
      action_source = 'unattributed';
      effectiveAction = 'drop'; // conservative default for display only
      expectedBytes = null;
    }

    if (action_source === 'unattributed') {
      buckets.unattributed += droppedBytes;
    } else {
      // Bucket dispatch. All six engine actions are admitted;
      // 'pass' and 'sample' are no-op for delivered savings but we
      // still surface the row so callers can audit unexpected configs.
      buckets[effectiveAction] += droppedBytes;
    }
    rows.push({
      pattern_hash: hash,
      pattern: args.hashToPattern?.get(hash) || hash,
      action: effectiveAction,
      delivered_bytes: droppedBytes,
      expected_bytes: expectedBytes,
      action_source: action_source === 'action_intent' ? 'pat_row' : action_source,
    });
  }

  // Parts-≤-whole guard. The whole = post_dropped_bytes; the
  // attributed parts ≤ whole by metric identity (each per-hash series
  // is a subset of the total). In practice tiny FP drift can push the
  // sum a hair above the whole; clamp the offload bucket to the
  // residual (offload is the "softer" action, least confidence in its
  // exact magnitude vs drop/compact which are deterministic).
  const attributed = totalAttributedBytes(buckets) + buckets.unattributed;
  let clamped = false;
  if (attributed > args.postDroppedBytes && buckets.offload > 0) {
    const overshoot = attributed - args.postDroppedBytes;
    const trim = Math.min(buckets.offload, overshoot);
    buckets.offload -= trim;
    clamped = true;
  }
  return { buckets, rows, clamped };
}

// ─── errors ─────────────────────────────────────────────────────────────

/**
 * Thrown by runEstimateForecast when default_action is a no-op on the
 * destination (e.g., action=compact on datadog where compact_mode=no-op).
 * executeEstimateSavings catches this and returns a structured refusal
 * envelope with a next-action suggestion instead of a generic failure.
 */
export class NoOpActionError extends Error {
  readonly action: string;
  readonly destination: string;
  constructor(action: string, destination: string) {
    super(`action=${action} is a no-op on ${destination}`);
    this.name = 'NoOpActionError';
    this.action = action;
    this.destination = destination;
  }
}

// ─── forecast ──────────────────────────────────────────────────────────

export interface RunForecastArgs {
  destination: SiemId;
  es_pruned?: boolean;
  tier_down_plan?: string;
  service?: string;
  retention_months: number;
  proposed_config?: Array<{
    pattern_hash: string;
    action: Action;
    sample_n?: number;
  }>;
  target_percent?: number;
  default_action: Action;
  /** PromQL range expression for the observation window. Default 30d. */
  observation_window?: string;
  /** Alias for `observation_window`. observation_window wins when both are set. */
  timeRange?: string;
  /**
   * Maximum per_pattern rows to return. Default 50 when service is omitted;
   * unlimited when service is set. Totals computed over full result before slice.
   */
  pattern_limit?: number;
  /**
   * Customer-supplied ingest $/GB override. When provided, dollar projections
   * use this rate instead of the destination list price (same as the verify path).
   * Surfaces as rate_source='customer_supplied' in the result.
   */
  effective_ingest_per_gb?: number;  /**
   * SIEM lens active: skip env-configured rates (they belong to the actual
   * destination). FED BY THE EXECUTOR from `lensRes.lensed` (executeEstimateSavings,
   * ~line 1818 -> 2013), NOT from the public estimate_savings arg. It is read
   * ONLY at the forecast resolveRate site (~1026). A future refactor that
   * inlines runEstimateForecast must keep this assignment, or the rate stops
   * following the SIEM lens. This is the SIEM lens; the VOLUME lens lives in a
   * separate object (result.volume_lens.lensed) — do not conflate.
   */
  lensed?: boolean;
  /**
   * Volume projection lens: model the env at this monthly volume (decimal
   * GB/month) instead of its measured volume. Scales the byte basis by a
   * uniform factor (per-pattern shares + coverage unchanged). Omit for the
   * real measured volume. configure-engine never sets it.
   */
  monthly_volume_gb?: number;
}

/**
 * Pure-function entry: callers (configure-engine) can run a forecast
 * inline against the same env they already resolved. Throws on missing
 * required args; lets the caller wrap into an envelope.
 */
export async function runEstimateForecast(
  args: RunForecastArgs,
  env: EnvConfig
): Promise<ForecastResult> {
  if (!args.proposed_config && args.target_percent === undefined) {
    throw new Error(
      'estimate_savings forecast requires either proposed_config or target_percent.'
    );
  }

  // Apply defaults that the Zod schema would set at the MCP boundary, in
  // case the function is called directly (e.g., from configure_engine's
  // forecast-fold, the standalone runner, or a unit test). Without this
  // every per-pattern projection runs with action=undefined and projects
  // bytes_out as NaN, which serializes to null in the envelope.
  args = {
    ...args,
    default_action: args.default_action ?? 'compact',
    retention_months: args.retention_months ?? 1,
  };

  // Early-exit: if the caller is running the greedy solver (target_percent)
  // and the explicit default_action is a no-op on this destination, throw.
  // NOTE: the solver itself will substitute the destination's canonical action
  // (getDefaultActionForDestination) so the no-op path is only reachable when
  // a caller explicitly passes default_action='compact' on a no-op destination.
  // That is a user error; the structured error carries the right suggestion.
  if (
    args.target_percent !== undefined &&
    !args.proposed_config
  ) {
    const earlyModel = getDestinationCostModel(args.destination, {
      esPruned: args.es_pruned,
    });
    // Only throw when the destination's own canonical first action is also
    // compact (i.e., no valid fallback exists — the solver would silently
    // assign compact again, which is still a no-op).  When canonicalAction
    // is something else (drop, sample, tier_down …) the solver will substitute
    // it transparently and the caller should not be blocked.
    const canonicalAction = getDefaultActionForDestination(args.destination, 1);
    const actionIsExplicitlyBad =
      args.default_action === 'compact' &&
      earlyModel.compact_mode === 'no-op' &&
      canonicalAction === 'compact';
    if (actionIsExplicitlyBad) {
      throw new NoOpActionError(args.default_action, args.destination);
    }
  }

  // Honor `timeRange` as an alias for `observation_window` per the schema
  // docstring (same precedence rule as the explicit-args path at line ~1706
  // and as log10x_investigate's window/timeRange aliasing). Forecast mode
  // had the alias declared but never read here; caller passing
  // `{ timeRange: '1d' }` was silently overridden to '30d'.
  const observationWindow = args.observation_window ?? args.timeRange ?? '30d';
  const obsDays = parseWindowToDays(observationWindow);

  // Resolve the edge/cloud metrics env the same way top_patterns and
  // preview_filter do — so queries land on the same backend that generated
  // the numbers those tools show. The selectorWithEnv() helper hardcoded
  // tenx_app=~"reporter|receiver",tenx_env="edge" which diverged from the
  // kept-cohort routeState!="drop" selector the other tools use, causing
  // total-bytes mismatch on the same service+window.
  const probeFilters: Record<string, string> = {};
  if (args.service) probeFilters[env.labels.service] = args.service;
  const metricsEnv = Object.keys(probeFilters).length > 0
    ? await resolveMetricsEnvFiltered(env, probeFilters)
    : await resolveMetricsEnv(env, QUERY_BUDGET.cheap);

  // Build the scope selector using the same buildSelector path as top_patterns:
  // routeState!="drop" (absence-tolerant kept cohort) + optional service filter.
  // This replaces selectorWithEnv() which used tenx_app=~"reporter|receiver".
  const scopeFilters: Record<string, FilterValue> = {
    routeState: { op: '!=', val: 'drop' },
  };
  if (args.service) {
    scopeFilters[env.labels.service] = args.service;
  }
  // Build a PromQL selector fragment for bytes queries. Re-use pql.bytesPerPattern
  // shape but inline here so we can group by hash rather than pattern string.
  // The selector is the routeState+service part; metricsEnv is appended via
  // the promql helpers internally. We build it manually to match the group-by-hash shape.
  const selectorParts: string[] = [
    `routeState!="drop"`,
    `${env.labels.env}="${metricsEnv}"`,
  ];
  if (args.service) {
    selectorParts.splice(1, 0, `${env.labels.service}="${escapeLabel(args.service)}"`);
  }
  const selector = selectorParts.join(',');

  // Per-pattern bytes + events over the observation window.
  // Group by the stable hash (env.labels.hash → tenx_hash by default).
  const bytesQuery = `sum by (${env.labels.hash}) (increase(${BYTES_METRIC}{${selector}}[${observationWindow}]))`;
  const eventsQuery = `sum by (${env.labels.hash}) (increase(${VOLUME_METRIC}{${selector}}[${observationWindow}]))`;
  const totalQuery = `sum(increase(${BYTES_METRIC}{${selector}}[${observationWindow}]))`;

  // Distinct pattern count — same scope as bytes query but grouped by pattern
  // string for the pattern-universe disclosure field.
  const distinctCountQuery = pql.distinctPatternCount(scopeFilters, metricsEnv, observationWindow);

  // Per-hash (service, descriptor) label query — used for per_service rollup
  // AND to enrich per_pattern rows so they carry a user-readable descriptor
  // (symbol_message) + service instead of just a raw hash. We always run this
  // — even when args.service is set, we still need the descriptor to avoid
  // leaking pattern_hash as the only identifier in user-facing rows.
  // Group by hash + service + message_pattern; take the dominant (service,
  // descriptor) per hash by bytes (same tie-break as extractHashContainerMap).
  const hashServiceQuery =
    `sum by (${env.labels.hash},${env.labels.service},${env.labels.pattern}) (increase(${BYTES_METRIC}{routeState!="drop",${env.labels.env}="${metricsEnv}"}[${observationWindow}]))`;

  // increase[observation_window] legs surface exact bytes/$ to the user → heavy
  // budget. distinctCount is a count-of-counts disclosure value → cheap. Each
  // leg degrades to null independently (iQueryInstant swallows timeout/error)
  // so one slow leg cannot sink the batch; the parsers below tolerate null
  // (parsePromResult → {}, parseScalarSum → 0, the same "no data" fallback).
  const parallelQueries: Array<Promise<unknown>> = [
    iQueryInstant(env, bytesQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, eventsQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, totalQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, distinctCountQuery, QUERY_BUDGET.cheap),
  ];
  parallelQueries.push(iQueryInstant(env, hashServiceQuery, QUERY_BUDGET.heavy));

  const queryResults = await Promise.all(parallelQueries);
  const [bytesRes, eventsRes, totalRes, distinctCountRes] = queryResults as [
    Parameters<typeof parsePromResult>[0],
    Parameters<typeof parsePromResult>[0],
    Parameters<typeof parseScalarSum>[0],
    Parameters<typeof parseScalarSum>[0] | null,
  ];
  const hashServiceRes = queryResults[4] as Parameters<typeof parsePromResult>[0];

  // Backend-down detection: iQueryInstant returns null on a FAILED fetch, vs an
  // empty-but-successful response when the backend is up with no data in window.
  // If every measurement leg failed, the backend is unreachable — throw so the
  // top-level handler emits the structured backend_error envelope (restores the
  // pre-bounding throw→catch behavior). A misleading zero-savings "success" must
  // never ship when we simply could not measure.
  if (!bytesRes && !eventsRes && !totalRes && !hashServiceRes) {
    throw new Error('metrics backend unreachable: all estimate_savings forecast queries failed');
  }

  // Extract distinct pattern count from the count-of-counts query.
  let patternUniverseCount: number | null = null;
  if (distinctCountRes) {
    const n = parseScalarSum(distinctCountRes);
    if (Number.isFinite(n) && n > 0) patternUniverseCount = Math.round(n);
  }

  const bytesByHash = parsePromResult(bytesRes, env.labels.hash);
  const eventsByHash = parsePromResult(eventsRes, env.labels.hash);
  const totalBytesObserved = parseScalarSum(totalRes);
  // Scale observation to a 30-day month (the forecast quotes monthly dollars).
  const baseMonthly = MONTH_DAYS / obsDays;
  // Volume projection lens: when the caller states a monthly volume, scale the
  // real basis to it with one uniform factor. Because the factor is uniform,
  // per-pattern shares and coverage_of_env_pct are unchanged by construction;
  // only absolute bytes/dollars move. `lensed:false` (factor 1) for the
  // measured-volume path.
  const volumeLens = resolveVolumeLens(args.monthly_volume_gb, totalBytesObserved * baseMonthly);
  const scale = baseMonthly * volumeLens.factor;

  // Build hash → (service, descriptor) maps for per_service rollup AND for
  // enriching per_pattern rows with the user-facing symbol_message + service.
  // Dominant (service, descriptor) per hash = highest bytes; ties broken
  // lexicographically on service then descriptor.
  const hashToService = new Map<string, string>();
  const hashToDescriptor = new Map<string, string>();
  if (hashServiceRes) {
    const svcRows = hashServiceRes?.data?.result ?? [];
    const acc = new Map<string, { service: string; descriptor: string; bytes: number }>();
    for (const row of svcRows) {
      const hash = row.metric?.[env.labels.hash];
      const svc = row.metric?.[env.labels.service];
      const desc = row.metric?.[env.labels.pattern] ?? '';
      if (!hash || !svc) continue;
      const v = row.value ? parseFloat(row.value[1]) : NaN;
      const bytes = Number.isFinite(v) ? v : 0;
      const prior = acc.get(hash);
      if (
        !prior ||
        bytes > prior.bytes ||
        (bytes === prior.bytes && svc.localeCompare(prior.service) < 0) ||
        (bytes === prior.bytes && svc === prior.service && desc.localeCompare(prior.descriptor) < 0)
      ) {
        acc.set(hash, { service: svc, descriptor: desc, bytes });
      }
    }
    for (const [hash, { service, descriptor }] of acc.entries()) {
      hashToService.set(hash, service);
      if (descriptor) hashToDescriptor.set(hash, descriptor);
    }
  }

  // Decide which rows to model.
  type Row = { pattern_hash: string; action: Action; sample_n?: number };
  let rows: Row[] = [];

  if (args.proposed_config && args.proposed_config.length > 0) {
    rows = args.proposed_config.map((r) => ({
      pattern_hash: r.pattern_hash,
      action: r.action,
      sample_n: r.sample_n,
    }));
  } else {
    // Greedy from target_percent. Sort patterns by 30d bytes DESC and
    // assign the destination's canonical action until cumulative savings >= target.
    //
    // The canonical action comes from DEFAULT_ACTION_BY_DESTINATION (level 1),
    // NOT from args.default_action — that field is an explicit caller override
    // and the solver should not use it when the caller is cost_options building
    // a routes_to hint (it will have passed a mode-appropriate action already).
    // When the caller explicitly passes default_action AND it is valid for the
    // destination, we honour it; otherwise we fall back to the canonical action.
    const model = getDestinationCostModel(args.destination, {
      esPruned: args.es_pruned,
    });
    const canonicalAction = getDefaultActionForDestination(args.destination, 1);
    // Honour an explicit non-compact caller action even when the canonical
    // differs, unless compact is a no-op (then override to canonical).
    const solverAction: Action =
      args.default_action === 'compact' && model.compact_mode === 'no-op'
        ? canonicalAction
        : args.default_action;

    const sorted = Object.entries(bytesByHash)
      .map(([hash, b]) => ({ hash, bytes: b * scale }))
      .sort((a, b) => b.bytes - a.bytes);
    const targetBytes =
      (args.target_percent! / 100) * (totalBytesObserved * scale);
    // Use the EXPECTED reduction per byte for the resolved action.
    let expectedReductionPerByte = 0;
    if (solverAction === 'drop' || solverAction === 'offload') {
      expectedReductionPerByte = 1;
    } else if (solverAction === 'sample') {
      expectedReductionPerByte = 0.9; // 1 in 10 default
    } else if (solverAction === 'tier_down') {
      // tier_down: estimate via the IA tier delta when available; fall back
      // to a conservative 50% ingest reduction for destinations with a known
      // cheap tier (CloudWatch IA) and 0 elsewhere.
      const solverTier = resolveTierDownTier(model, args.tier_down_plan);
      if (solverTier) {
        const ingestDelta = model.ingest_per_gb - solverTier.ingest_rate_usd_per_gb;
        expectedReductionPerByte = model.ingest_per_gb > 0
          ? ingestDelta / model.ingest_per_gb
          : 0.5;
      } else {
        expectedReductionPerByte = 0.5;
      }
    } else if (solverAction === 'compact' && model.compact_mode !== 'no-op') {
      expectedReductionPerByte =
        1 - (model.compact_ratio_low + model.compact_ratio_high) / 2;
    }
    let saved = 0;
    for (const row of sorted) {
      if (saved >= targetBytes) break;
      rows.push({ pattern_hash: row.hash, action: solverAction });
      saved += row.bytes * expectedReductionPerByte;
    }
  }

  // Project each row.
  // Resolve the $/GB ONCE via the shared chain (caller arg → envs.json
  // analyzerCost → LOG10X_ANALYZER_COST → destination list) and use it for BOTH
  // the per-pattern dollar math (below) and the rate_source / rate_disclosure
  // label (further down). Resolving in two places previously let the label and
  // the math disagree.
  const forecastRateResolved = resolveRate(
    { effective_ingest_per_gb: args.effective_ingest_per_gb },
    env,
    args.destination,
    { lensed: args.lensed === true },
  );

  const per_pattern: ForecastRow[] = [];
  let totalIn = 0;
  let totalSavedBytes = 0;
  let totalLow = 0;
  let totalExpected = 0;
  let totalHigh = 0;
  const smallEventPatterns: string[] = [];
  let noOpCompactCount = 0;

  for (const row of rows) {
    const obsBytes = bytesByHash[row.pattern_hash] ?? 0;
    const obsEvents = eventsByHash[row.pattern_hash] ?? 0;
    const monthlyBytes = obsBytes * scale;
    const avgSize = obsEvents > 0 ? obsBytes / obsEvents : 0;

    // Cost at PASS (the counterfactual) vs cost at proposed action.
    // Both legs use the same retention so retention drops out for `compact`
    // savings on `compact_ratio` etc. Keeping it explicit avoids the
    // subtle bug where caller-supplied retention_months changes the
    // PASS leg dollars (it should, since both legs are at the same
    // retention) — savings is still (pass - action).
    //
    // Use the SHARED resolved rate (caller arg → envs.json analyzerCost →
    // LOG10X_ANALYZER_COST → destination list), NOT just args.effective_ingest_per_gb.
    // The rate_source / rate_disclosure LABEL already resolves this way, so if the
    // dollar math used only the caller arg, a rate supplied via env var / env
    // config flipped the label to customer_supplied ($1.53/GB) while the per-pattern
    // dollars stayed at list ($0.53/GB) — a 2.9x understatement that contradicted
    // the tool's own disclosure. Both pass and action legs get the same override.
    const customerRate =
      forecastRateResolved.source === 'customer_supplied'
        ? { ingest_per_gb_override: forecastRateResolved.rate_per_gb as number }
        : undefined;
    const passRange = projectActionRange({
      action: 'pass',
      bytes_in: monthlyBytes,
      destination: args.destination,
      retention_months: args.retention_months,
      esPruned: args.es_pruned,
      customer_rate: customerRate,
    });
    const actionRange = projectActionRange({
      action: row.action,
      bytes_in: monthlyBytes,
      avg_event_size_bytes: avgSize || undefined,
      sample_n: row.sample_n ?? 10,
      destination: args.destination,
      retention_months: args.retention_months,
      esPruned: args.es_pruned,
      tier_down_plan: args.tier_down_plan,
      customer_rate: customerRate,
    });

    const savedBytes = monthlyBytes - actionRange.expected.bytes_out;
    // Range is intentionally swapped: high savings = low destination cost.
    const dollarsLow =
      (passRange.low.total_dollars ?? 0) - (actionRange.low.total_dollars ?? 0);
    const dollarsExpected =
      (passRange.expected.total_dollars ?? 0) -
      (actionRange.expected.total_dollars ?? 0);
    const dollarsHigh =
      (passRange.high.total_dollars ?? 0) -
      (actionRange.high.total_dollars ?? 0);

    if (
      row.action === 'compact' &&
      getDestinationCostModel(args.destination, { esPruned: args.es_pruned })
        .compact_mode === 'no-op'
    ) {
      noOpCompactCount++;
    }
    if (avgSize > 0 && avgSize < 100) {
      smallEventPatterns.push(row.pattern_hash);
    }

    per_pattern.push({
      pattern_hash: row.pattern_hash,
      // User-facing identifiers (renderers MUST show these, not the
      // hash, on user-visible cells). Service falls back to the args.service
      // when the caller scoped the call; descriptor stays empty when the
      // metric backend doesn't surface message_pattern for this hash.
      service: hashToService.get(row.pattern_hash) ?? args.service ?? '',
      symbol_message: hashToDescriptor.get(row.pattern_hash) ?? '',
      action: row.action,
      bytes_in_monthly: monthlyBytes,
      bytes_in_monthly_display: fmtBytes(monthlyBytes),
      bytes_saved_monthly: Math.max(0, savedBytes),
      bytes_saved_monthly_display: fmtBytes(Math.max(0, savedBytes)),
      avg_event_size_bytes: avgSize,
      avg_event_size_bytes_display: fmtBytes(avgSize),
      dollars_saved_low: Math.max(0, dollarsLow),
      dollars_saved_expected: Math.max(0, dollarsExpected),
      dollars_saved_high: Math.max(0, dollarsHigh),
      notes: actionRange.expected.notes,
    });
    totalIn += monthlyBytes;
    totalSavedBytes += Math.max(0, savedBytes);
    totalLow += Math.max(0, dollarsLow);
    totalExpected += Math.max(0, dollarsExpected);
    totalHigh += Math.max(0, dollarsHigh);
  }

  // Coverage: fraction of TOTAL observed bytes (monthly-scaled) that the
  // forecast modeled. Patterns not in proposed_config and not picked by
  // the solver are unmodeled long-tail.
  const totalObservedMonthly = totalBytesObserved * scale;
  const coverage_of_env_pct = safeDiv(totalIn, totalObservedMonthly);

  // coverage_of_proposed_pct: for proposed_config callers this is always
  // 1.0 (100%) because every row in the config was modeled. For the greedy
  // solver the denominator is totalObservedMonthly (same as coverage_of_env_pct)
  // since the solver selects from the full observed candidate set. The two
  // values diverge only when the caller passes a sparse proposed_config that
  // covers a small fraction of env bytes — in that case coverage_of_env_pct
  // is small but coverage_of_proposed_pct = 1.0.
  const coverage_of_proposed_pct = args.proposed_config && args.proposed_config.length > 0
    ? 1.0
    : coverage_of_env_pct; // greedy: same as env fraction (all candidates available)

  // ── per_pattern limit + truncation ────────────────────────────────
  // Sort full result by bytes_in_monthly DESC, then slice to the limit.
  // Totals were accumulated above over the full set; slicing here is
  // presentation-only and does not affect coverage_pct or dollar totals.
  const per_pattern_total_count = per_pattern.length;
  const effectiveLimit = args.service
    ? per_pattern.length // unlimited when scoped to a service
    : (args.pattern_limit ?? 50);
  // Ensure descending sort before slice (greedy path is already sorted, but
  // proposed_config may be in arbitrary order).
  per_pattern.sort((a, b) => b.bytes_in_monthly - a.bytes_in_monthly);
  const per_pattern_truncated = per_pattern.length > effectiveLimit;
  const per_pattern_sliced = per_pattern_truncated
    ? per_pattern.slice(0, effectiveLimit)
    : per_pattern;

  // ── per_service rollup ────────────────────────────────────────────
  // Aggregated from the FULL (pre-slice) per_pattern set so the rollup
  // totals match the headline dollar figures exactly.
  //
  // When service is omitted: group all patterns by service via hashToService.
  // When service is specified: populate a single-entry array for the scoped
  // service so callers can confirm scoping and get the rollup totals for it.
  let per_service:
    | Array<{
        service: string;
        pattern_count: number;
        bytes_saved_monthly: number;
        dollars_saved_expected: number;
      }>
    | undefined;
  if (!args.service) {
    const svcMap = new Map<
      string,
      { pattern_count: number; bytes_saved_monthly: number; dollars_saved_expected: number }
    >();
    for (const row of per_pattern) {
      const svc = hashToService.get(row.pattern_hash) ?? '(unknown)';
      const prior = svcMap.get(svc) ?? {
        pattern_count: 0,
        bytes_saved_monthly: 0,
        dollars_saved_expected: 0,
      };
      svcMap.set(svc, {
        pattern_count: prior.pattern_count + 1,
        bytes_saved_monthly: prior.bytes_saved_monthly + row.bytes_saved_monthly,
        dollars_saved_expected:
          prior.dollars_saved_expected + row.dollars_saved_expected,
      });
    }
    per_service = Array.from(svcMap.entries())
      .map(([service, v]) => ({ service, ...v }))
      .sort((a, b) => b.dollars_saved_expected - a.dollars_saved_expected);
  } else {
    // Service-scoped: single rollup entry for the specified service,
    // aggregated over the full (pre-slice) per_pattern set.
    const scopedTotals = per_pattern.reduce(
      (acc, row) => ({
        pattern_count: acc.pattern_count + 1,
        bytes_saved_monthly: acc.bytes_saved_monthly + row.bytes_saved_monthly,
        dollars_saved_expected: acc.dollars_saved_expected + row.dollars_saved_expected,
      }),
      { pattern_count: 0, bytes_saved_monthly: 0, dollars_saved_expected: 0 }
    );
    per_service = [{ service: args.service, ...scopedTotals }];
  }

  // SHARED rate resolver (lib/rate-resolution.ts). Same priority chain as
  // services / top_patterns / event_lookup / explain_mode: caller arg →
  // envs.json analyzerCost → LOG10X_ANALYZER_COST → destination list →
  // unset. Prior to this, estimate_savings labeled the destination list
  // price as 'list_price' even when the env carried a customer-supplied
  // rate that the other tools surfaced as 'customer_supplied'.
  //
  // forecast NEVER collapses to 'unset' because args.destination is required:
  // rung 4 always returns the destination's list price as a safety net.
  // The rung-2/3 env-supplied rate (envs.json analyzerCost or
  // LOG10X_ANALYZER_COST) still wins when present.
  const forecast_rate_source: 'list_price' | 'customer_supplied' =
    forecastRateResolved.source === 'customer_supplied' ? 'customer_supplied' : 'list_price';
  // The resolved disclosure only
  // names the ingest list rate ("$0.50/GB"), but projectActionRange returns
  // total_dollars = ingest_dollars + storage_dollars × retention_months. A
  // CFO reading the disclosure expects the totals to reconcile at $0.50/GB
  // ingest, but they actually reconcile at ingest + storage = $0.53/GB on
  // CloudWatch (and similarly on Splunk, ES, Azure, GCP, Sumo where
  // storage_per_gb_month > 0). Augment the list-price disclosure to name
  // the storage component when it materially affects the math.
  const forecastModel = getDestinationCostModel(args.destination, {
    esPruned: args.es_pruned,
  });
  const forecastRetentionMonths = 1; // matches projectActionRange default
  const customerSuppliedRate = forecastRateResolved.rate_per_gb;
  const forecast_rate_disclosure: string | null =
    forecastRateResolved.source === 'list_price' &&
    forecastModel.storage_per_gb_month > 0 &&
    forecastRateResolved.disclosure
      ? forecastRateResolved.disclosure.replace(
          /(\$[\d.]+\/GB)/,
          (match) =>
            `${match} ingest + $${forecastModel.storage_per_gb_month.toFixed(2)}/GB-month storage × ${forecastRetentionMonths}mo = $${(forecastModel.ingest_per_gb + forecastModel.storage_per_gb_month * forecastRetentionMonths).toFixed(2)}/GB effective`
        )
      : forecastRateResolved.source === 'customer_supplied' && customerSuppliedRate != null
        // Prior code shipped rate_disclosure=null when
        // rate_source='customer_supplied' so every dollar figure was
        // computed from an undisclosed scalar. Surface the customer-supplied
        // rate string so a CFO can audit the math from the envelope alone,
        // matching the top_patterns rate_disclosure pattern.
        ? `$${customerSuppliedRate.toFixed(2)}/GB ingest (customer-supplied)${forecastModel.storage_per_gb_month > 0 ? ` + $${forecastModel.storage_per_gb_month.toFixed(2)}/GB-month storage × ${forecastRetentionMonths}mo = $${(customerSuppliedRate + forecastModel.storage_per_gb_month * forecastRetentionMonths).toFixed(2)}/GB effective` : ''}`
        : forecastRateResolved.disclosure;

  const caveats: string[] = [];
  if (noOpCompactCount > 0) {
    caveats.push(
      `${noOpCompactCount} pattern${noOpCompactCount !== 1 ? 's' : ''} use action=compact on ${args.destination}, which is a no-op destination. Consider tier_down, sample, or drop.`
    );
  }
  if (per_pattern_truncated) {
    caveats.push(
      `Showing top ${effectiveLimit} of ${per_pattern_total_count} patterns by volume. Totals and coverage_of_env_pct reflect all ${per_pattern_total_count} patterns.`
    );
  }
  if (coverage_of_env_pct < 0.6 && rows.length > 0) {
    caveats.push(
      `Forecast covers ${(coverage_of_env_pct * 100).toFixed(0)}% of monthly env bytes. The long tail (${((1 - coverage_of_env_pct) * 100).toFixed(0)}%) is not modeled.`
    );
  }
  if (smallEventPatterns.length > 0) {
    caveats.push(
      `${smallEventPatterns.length} pattern${smallEventPatterns.length !== 1 ? 's have' : ' has'} avg event size below 100B; envelope overhead reduces compaction savings.`
    );
  }
  if (totalBytesObserved === 0) {
    caveats.push(
      'No bytes observed in the window. Either the Reporter is not deployed for this scope, or the service/env filters matched nothing.'
    );
  }
  // pattern_count_source.count is the
  // pattern universe from the distinct-count query (all patterns with
  // ANY bytes in window); per_pattern_total_count is the post-filter
  // set the forecast actually modeled (patterns with non-zero monthly
  // bytes for the resolved scope). They disagree when patterns exist
  // in the count but were filtered out (e.g. matched the scope but
  // bytes rolled up to zero). Surface the gap so consumers know the
  // forecast covered fewer rows than the count claims exist.
  if (
    patternUniverseCount != null &&
    patternUniverseCount > per_pattern.length &&
    per_pattern.length > 0
  ) {
    const dropped = patternUniverseCount - per_pattern.length;
    caveats.push(
      `pattern_count_source.count=${patternUniverseCount} but per_pattern_total_count=${per_pattern.length} — ${dropped} pattern${dropped !== 1 ? 's' : ''} exist in the count query but were filtered out of the forecast (bytes rolled up to zero in the resolved scope, or filtered by the destination action model).`
    );
  }
  if (forecast_rate_source === 'list_price') {
    caveats.push(
      `Dollar projections use ${args.destination} list price. Pass effective_ingest_per_gb to use your contracted rate and align with top_patterns output.`
    );
  }
  // When EVERY row got tier_down and the
  // destination cost model has NO tier_down_target_tier configured, the
  // per-row `notes` already explain the $0 (cheaper tier price not
  // configured) but a downstream agent reading totals/action_mix sees
  // 0 with no top-level signal. Lift the config gap to caveats[] so
  // automation can detect the structural invalidity at a single read.
  const forecastModelForGap = getDestinationCostModel(args.destination, {
    esPruned: args.es_pruned,
  });
  const everyRowTierDown = per_pattern.length > 0 && per_pattern.every((r) => r.action === 'tier_down');
  if (everyRowTierDown && !forecastModelForGap.tier_down_target_tier) {
    caveats.push(
      `config_gap: every pattern was assigned tier_down but ${args.destination}'s cost model has no tier_down_target_tier configured. Dollar savings are $0 by configuration, not by forecast. Configure the cheaper tier rate, or switch default_action to drop/sample for a meaningful projection.`
    );
  }
  // When the caller asked for a target_percent reduction but every
  // pattern got mapped to tier_down (a routing marker that cuts the
  // per-GB rate, not the byte volume), the headline declares "$0/mo
  // savings" without telling the caller the requested target wasn't met.
  // Surface explicitly so the agent can route to a destination that
  // supports the requested reduction.
  if (
    args.target_percent !== undefined &&
    totalSavedBytes === 0 &&
    rows.length > 0
  ) {
    caveats.push(
      `Requested ${args.target_percent}% volume reduction; achieved 0% on ${args.destination} because the only applicable action is tier_down (a storage-tier marker, not a byte reduction). To actually cut volume on this destination, pass default_action=drop or default_action=sample; or switch to a destination where compact is non-no-op.`
    );
  }

  return {
    mode: 'forecast',
    volume_lens: volumeLens,
    destination: args.destination,
    es_pruned: args.es_pruned,
    service: args.service,
    observation_window: observationWindow,
    target_percent: args.target_percent,
    per_pattern: per_pattern_sliced,
    per_pattern_truncated,
    per_pattern_total_count,
    per_service,
    totals: {
      bytes_in_monthly: totalIn,
      // env_bytes_in_monthly is the denominator behind coverage_of_env_pct.
      // Surfaced so the coverage % is reconstructible from the envelope
      // without a hidden side query. When
      // args.service is set, bytes_in_monthly is the service-scope total
      // and env_bytes_in_monthly is the env-wide total (larger). When no
      // service filter is set the two are equal.
      env_bytes_in_monthly: totalObservedMonthly,
      bytes_saved_monthly: totalSavedBytes,
      dollars_low_monthly: totalLow,
      dollars_expected_monthly: totalExpected,
      dollars_high_monthly: totalHigh,
      annual_projection_expected: totalExpected * 12,
      projection_basis: {
        method: 'linear_extrapolation' as const,
        scale_factor: 12 as const,
        basis_value: 'dollars_expected_monthly' as const,
        note: 'annual_projection_expected = dollars_expected_monthly × 12. Linear extrapolation from observed monthly figure; NOT seasonality-adjusted, growth-adjusted, or contract-tier-adjusted. For verified savings under a real deployed policy use mode=verify with baseline_window + post_window.',
      },
    },
    coverage_of_env_pct,
    coverage_of_env_percent: coverage_of_env_pct * 100,
    coverage_pct: coverage_of_env_pct, // backward-compat alias
    coverage_of_proposed_pct,
    coverage_of_proposed_percent: coverage_of_proposed_pct * 100,
    rate_source: forecast_rate_source,
    rate_disclosure: forecast_rate_disclosure,
    bytes_source: {
      metric: BYTES_METRIC,
      observation_window: observationWindow,
      cohort: 'kept' as const,
      scope_filter: selector,
    },
    pattern_count_source: {
      query: 'distinctPatternCount' as const,
      count: patternUniverseCount,
      window: observationWindow,
    },
    caveats,
  };
}

// ─── verify ────────────────────────────────────────────────────────────

export interface RunVerifyArgs {
  destination: SiemId;
  es_pruned?: boolean;
  service?: string;
  baseline_window: string;
  post_window: string;
  commitment_id?: string;
  contract_type?: 'committed' | 'on_demand';
  effective_ingest_per_gb?: number;
  /**
   * Optional cap-CSV content (verbatim string from the customer gitops
   * repo at `lookup_path`). When present alongside `action_intent_content`,
   * the verify run can also supply per-pattern byte-cap context for the
   * attribution rows. The cap CSV no longer carries action tokens — see
   * `action_intent_content` for action routing.
   *
   * Legacy rows that still contain a `:<action>` suffix are silently
   * stripped; the suffix is stored in `legacy_action_suffix` on each row
   * but NOT used for action routing. If `action_intent_content` is also
   * absent but `cap_csv_content` is present with legacy suffixes, the
   * split will fall back to those legacy values (backward compat).
   */
  cap_csv_content?: string | null;
  /**
   * Optional action-intent.json content (verbatim JSON from the customer
   * gitops repo at `data/action-intent.json`). When present, this is the
   * canonical source for per-pattern action attribution. Takes precedence
   * over any legacy `:action` suffix that may still be in the cap CSV.
   * When absent, the verify run falls back to cap-CSV legacy suffixes (if
   * present) or marks all dropped bytes as `unattributed`.
   */
  action_intent_content?: string | null;
  /**
   * Label name carrying the container value on the engine's metrics.
   * Defaults to `k8s_container` (matches configure-engine.ts's PromQL
   * shape). Exposed so a customer with a relabeled aggregator can pass
   * the right label without us hard-coding the default in two places.
   */
  container_label?: string;  /**
   * SIEM lens active: skip env-configured rates (they belong to the actual
   * destination). FED BY THE EXECUTOR from `lensRes.lensed` (executeEstimateSavings,
   * ~line 1818 -> 2198), NOT from the public estimate_savings arg. It is read
   * ONLY at the verify resolveRate site (~1638). A future refactor that inlines
   * runEstimateVerify must keep this assignment, or the rate stops following the
   * SIEM lens. This is the SIEM lens; the VOLUME lens is a separate object — do
   * not conflate.
   */
  lensed?: boolean;
  /**
   * PromQL duration (e.g. "30d") shifting the BASELINE queries back in time
   * via the `offset` modifier, so the baseline measures a window that ENDS
   * `baseline_offset` ago instead of trailing to "now".
   *
   * Why it exists: without it, both baseline and post `increase(...[w])`
   * vectors trail from "now" over an overlapping range, so the baseline is
   * the policy's own post-deploy output. delivered_pct then collapses to 0
   * algebraically (the degenerate-windowing caveat fires). Anchoring the
   * baseline before the policy went live (`commitment.started_at`) is exactly
   * the fix the caveat prescribes; the commitment runner sets this to the
   * age of the commitment so the baseline window lands in pre-policy data.
   *
   * Must be a bare PromQL range duration (`^\d+(ms|s|m|h|d|w|y)$`); any other
   * value is ignored (no offset applied) and a caveat is pushed. The $ view
   * is unaffected either way; it reads post-window dropped bytes directly.
   */
  baseline_offset?: string;
}

/** PromQL range-duration shape, e.g. "7d", "168h", "30m". */
const PROMQL_DURATION_RE = /^\d+(ms|s|m|h|d|w|y)$/;

/**
 * Pure-function entry for verify. Queries the engine's routeState label
 * (TenXSummary) to attribute the delta.
 */
export async function runEstimateVerify(
  args: RunVerifyArgs,
  env: EnvConfig
): Promise<VerifyResult> {
  const baseDays = parseWindowToDays(args.baseline_window);
  const postDays = parseWindowToDays(args.post_window);

  const extraFilters: string[] = [];
  if (args.service) {
    extraFilters.push(`${env.labels.service}="${escapeLabel(args.service)}"`);
  }
  const baseSelector = selectorWithEnv(env, extraFilters);
  const hashLabel = env.labels.hash;

  // baseline_offset: shift the baseline range-vector back in time so it
  // measures pre-policy data instead of trailing to "now" over the same
  // range as the post window (which would force delivered_pct to 0). Only a
  // well-formed PromQL duration is honored; anything else is ignored with a
  // caveat. The clause goes AFTER the range bracket, inside increase().
  const baselineOffsetValid =
    !!args.baseline_offset && PROMQL_DURATION_RE.test(args.baseline_offset);
  const baseOffsetClause = baselineOffsetValid ? ` offset ${args.baseline_offset}` : '';

  // 1. Baseline: bytes that PASSED the engine (no drops) over baseline_window.
  //    The engine emits the routeState label as a state NAME string
  //    ("drop" for capped events). Older series may omit the label entirely.
  //    Using `routeState!="drop"` covers BOTH: matches other states AND
  //    label-absent. The negative-equality form matches the kept cohort
  //    without excluding future kept states (regex alternation is reserved).
  const baselinePassedQuery = `sum(increase(${BYTES_METRIC}{${baseSelector},routeState!="drop"}[${args.baseline_window}]${baseOffsetClause}))`;
  const baselineByHashQuery = `sum by (${hashLabel}) (increase(${BYTES_METRIC}{${baseSelector},routeState!="drop"}[${args.baseline_window}]${baseOffsetClause}))`;
  // 2. Post: same query over post_window.
  const postTotalQuery = `sum(increase(${BYTES_METRIC}{${baseSelector}}[${args.post_window}]))`;
  const postPassedQuery = `sum(increase(${BYTES_METRIC}{${baseSelector},routeState!="drop"}[${args.post_window}]))`;
  const postDroppedQuery = `sum(increase(${BYTES_METRIC}{${baseSelector},routeState="drop"}[${args.post_window}]))`;
  const postPassedByHashQuery = `sum by (${hashLabel}) (increase(${BYTES_METRIC}{${baseSelector},routeState!="drop"}[${args.post_window}]))`;
  const patternLabel = env.labels.pattern;
  const postDroppedByHashQuery = `sum by (${hashLabel}, ${patternLabel}) (increase(${BYTES_METRIC}{${baseSelector},routeState="drop"}[${args.post_window}]))`;

  const [
    baselineTotalRes,
    baselineByHashRes,
    postTotalRes,
    postPassedRes,
    postDroppedRes,
    postPassedByHashRes,
    postDroppedByHashRes,
  ] = await Promise.all([
    // All seven are increase[baseline/post_window] legs that surface exact
    // bytes/$/delivered_pct to the user → heavy budget. Any leg that times out
    // resolves to null; the parsers below (parseScalarSum → 0, parsePromResult
    // → {}) map null to the same empty-data fallback the tool already gives.
    iQueryInstant(env, baselinePassedQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, baselineByHashQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, postTotalQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, postPassedQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, postDroppedQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, postPassedByHashQuery, QUERY_BUDGET.heavy),
    iQueryInstant(env, postDroppedByHashQuery, QUERY_BUDGET.heavy),
  ]);

  const baselineBytes = parseScalarSum(baselineTotalRes);
  const baselineByHash = parsePromResult(baselineByHashRes, hashLabel);
  const postTotalBytes = parseScalarSum(postTotalRes);
  const postPassedBytes = parseScalarSum(postPassedRes);
  const postDroppedBytes = parseScalarSum(postDroppedRes);
  const postPassedByHash = parsePromResult(postPassedByHashRes, hashLabel);
  const postDroppedByHash = parsePromResult(postDroppedByHashRes, hashLabel);
  // Human pattern names ride the same series (hash -> name is 1:1); the
  // breakdown rows carry them so downstream renderers (commitment_report's
  // CFO tables) lead with the name, never the hash.
  const hashToPattern = new Map<string, string>();
  if (postDroppedByHashRes && postDroppedByHashRes.status === 'success') {
    for (const r of postDroppedByHashRes.data.result) {
      const h = r.metric[hashLabel];
      const p = r.metric[patternLabel];
      if (h && p && !hashToPattern.has(h)) hashToPattern.set(h, p);
    }
  }

  // 3. Optional per-(hash, container) drop query — only when an action
  //    attribution source (cap-CSV or action-intent) was supplied AND
  //    there are dropped bytes to attribute. We skip the extra Prometheus
  //    roundtrip otherwise.
  const containerLabel = args.container_label ?? 'k8s_container';
  const hasActionSource =
    !!(args.cap_csv_content || args.action_intent_content);
  let patternToContainer = new Map<string, string>();
  if (hasActionSource && postDroppedBytes > 0) {
    const dropByPairQuery = `sum by (${hashLabel}, ${containerLabel}) (increase(${BYTES_METRIC}{${baseSelector},routeState="drop"}[${args.post_window}]))`;
    // Best-effort container attribution: the per-pair value only ranks which
    // container owns a hash (no exact byte/$ reaches the user), so the cheap
    // budget is right. On timeout/error iQueryInstant resolves null and
    // extractHashContainerMap (res?.data?.result ?? []) yields an empty map —
    // the action-split path then emits `unattributed` rows, the same fallback
    // the prior try/catch produced.
    const pairRes = await iQueryInstant(env, dropByPairQuery, QUERY_BUDGET.cheap);
    patternToContainer = extractHashContainerMap(
      pairRes ?? {},
      hashLabel,
      containerLabel
    );
  }

  // Parse action-intent.json (canonical action source) when supplied.
  const actionIntentLookup: Map<string, Action> | undefined =
    args.action_intent_content
      ? parseActionIntent(args.action_intent_content).by_pattern
      : undefined;

  // Scale baseline to the post window length for an apples-to-apples ratio.
  const baselineScaled = baselineBytes * (postDays / baseDays);
  // Delivered_pct: fraction by which passed bytes fell vs the scaled baseline.
  // If passed bytes grew (drift > savings), this goes negative.
  const delivered_pct =
    baselineScaled > 0 ? 1 - postPassedBytes / baselineScaled : 0;

  // ── Attribution ──
  // cap_fired: bytes dropped on patterns that existed in baseline.
  //   For each hash that had baseline bytes, count its post-window
  //   dropped bytes. That's the engine doing its job.
  let cap_fired = 0;
  // leakage: bytes that passed for patterns we capped. We don't know
  //   which patterns were INTENDED to be capped (that's in the policy
  //   CSV, not in the metric). Approximation: a baseline pattern is
  //   "policy-targeted" if it has ANY dropped bytes in post — meaning
  //   the cap engaged. For those patterns, post-passed bytes above the
  //   scaled baseline floor represent leakage (events that should have
  //   been dropped but slipped through).
  let leakage = 0;
  // drift: organic growth on baseline patterns we did NOT cap.
  //   That's (post_passed[hash] - scale(baseline[hash])) summed over
  //   patterns with zero post-drops. Negative deltas (patterns whose
  //   volume FELL) are clipped to 0 so they don't offset drift.
  let drift = 0;
  for (const [hash, baseB] of Object.entries(baselineByHash)) {
    const scaledBase = baseB * (postDays / baseDays);
    const postPassed = postPassedByHash[hash] ?? 0;
    const postDropped = postDroppedByHash[hash] ?? 0;
    cap_fired += postDropped;
    if (postDropped > 0) {
      // Policy-targeted pattern. Anything passed above the scaled
      // baseline floor is leakage above the pre-policy run-rate.
      const overshoot = Math.max(0, postPassed - scaledBase);
      leakage += overshoot;
    } else {
      // Not policy-targeted. Anything above scaledBase is organic drift.
      drift += Math.max(0, postPassed - scaledBase);
    }
  }

  // new_patterns: post-window bytes for hashes ABSENT from baseline.
  let new_patterns = 0;
  for (const [hash, postPassed] of Object.entries(postPassedByHash)) {
    if (!(hash in baselineByHash)) {
      new_patterns += postPassed;
    }
  }

  // Dollars: SAVINGS = dropped bytes × $/GB. Keeps the envelope internally
  // consistent — commitment-report.delivered_bytes sources from
  // post_dropped_bytes, so multiplying the same quantity by the same rate
  // means delivered_dollars / delivered_bytes always reconciles to the
  // disclosed rate (audit-friendly; CFO can divide the two and get $0.50/GB
  // out the back).
  //
  // Routed through the SHARED rate resolver (lib/rate-resolution.ts) so
  // verify agrees with services / top_patterns / event_lookup / explain_mode
  // on the SAME tag for the same env/window. Priority chain: caller arg →
  // envs.json analyzerCost → LOG10X_ANALYZER_COST → destination list price
  // → unset. verify NEVER lands on 'unset' because args.destination is
  // required and rung 4 supplies the list price as a safety net.
  const verifyRateResolved = resolveRate(
    { effective_ingest_per_gb: args.effective_ingest_per_gb },
    env,
    args.destination,
    { lensed: args.lensed === true },
  );
  const ingestRate = verifyRateResolved.rate_per_gb
    ?? getDestinationCostModel(args.destination, { esPruned: args.es_pruned }).ingest_per_gb;
  const delivered_dollars_now = (postDroppedBytes / GB) * ingestRate;
  const delivered_dollars_annual_projection = annualizeDollars(
    delivered_dollars_now,
    postDays
  );
  // Committed-volume customers may have a renewal projection where
  // realized savings translate to lower contracted spend. We surface
  // the same number for now; callers (commitment_report) can supply
  // a different rate via effective_ingest_per_gb.
  const delivered_dollars_at_renewal =
    args.contract_type === 'committed' ? delivered_dollars_now : undefined;

  // Causal confidence: how confident are we that the delivered_pct
  // reflects the policy, vs noise. v1 heuristic: confidence = 1 when
  // cap_fired dominates attribution AND post_window >= 7d; halves when
  // baseline < 7d; deweights when new_patterns/leakage dominate
  // cap_fired.
  let confidence = 1.0;
  if (postDays < 7) confidence *= 0.5;
  if (baseDays < 7) confidence *= 0.5;
  const attrTotal = cap_fired + drift + new_patterns + leakage;
  if (attrTotal > 0) {
    const capShare = cap_fired / attrTotal;
    if (capShare < 0.5) confidence *= 0.75;
  } else {
    confidence = 0;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  const caveats: string[] = [];
  if (postDroppedBytes === 0 && postTotalBytes > 0) {
    caveats.push(
      'No routeState="drop" bytes observed in the post window. Either no policy is deployed, or the engine version does not emit the routeState label.'
    );
  }
  if (baseDays < 7) {
    caveats.push(
      `Baseline window is ${baseDays.toFixed(1)}d (<7d). Attribution may be noisy; widen the baseline for higher confidence.`
    );
  }
  if (baselineOffsetValid) {
    caveats.push(
      `Baseline anchored ${args.baseline_offset} before now via offset (pre-policy window), so delivered_pct compares post-deploy volume against pre-deploy volume rather than the policy's own output.`
    );
  } else if (args.baseline_offset) {
    caveats.push(
      `baseline_offset "${args.baseline_offset}" is not a valid PromQL duration (e.g. "30d") and was ignored; the baseline trails to now. delivered_pct may be degenerate.`
    );
  }
  if (postDays < 7) {
    caveats.push(
      `Post window is ${postDays.toFixed(1)}d (<7d). Drift and new-pattern attribution may not have stabilized.`
    );
  }
  if (delivered_pct < 0) {
    caveats.push(
      `Delivered % is negative (${(delivered_pct * 100).toFixed(1)}%) — post-window passed bytes EXCEED scaled baseline. Likely drift/new_patterns swamped the cap.`
    );
  }
  // Degenerate-window detection. When baseline_bytes_scaled equals
  // post_passed_bytes to 8+ sig digits, the verify is comparing the policy
  // against its own output: delivered_pct is algebraically forced to 0
  // regardless of whether bytes were actually dropped. Two common causes:
  // (1) baseline_window == post_window AND both anchor to "now" (the same
  // Prometheus range), (2) env grew by exactly the cap-fired byte count
  // this window (coincidence; rare). In either case the % view is
  // meaningless; the $ view (computed from postDroppedBytes) is still
  // correct. Surface a caveat + downgrade causal_confidence so the headline
  // and CFO-facing renderers can't silently report "0% delivered reduction"
  // alongside a positive $/yr.
  const degenerateBaselinePassedMatch =
    baselineScaled > 0 &&
    postPassedBytes > 0 &&
    Math.abs(baselineScaled - postPassedBytes) / baselineScaled < 1e-8;
  if (degenerateBaselinePassedMatch && postDroppedBytes > 0) {
    confidence = Math.min(confidence, 0.5);
    caveats.push(
      `Degenerate windowing: baseline_bytes_scaled (${baselineScaled.toFixed(0)}) equals post_passed_bytes (${postPassedBytes.toFixed(0)}) to ${(Math.abs(baselineScaled - postPassedBytes) / baselineScaled < 1e-12 ? 'full precision' : '8+ significant digits')}, forcing delivered_pct to 0 algebraically. Either baseline_window and post_window anchor to the same time range, OR the env grew by exactly the cap-fired byte count. The $ view (${(postDroppedBytes / GB).toFixed(2)} GB dropped) is unaffected — trust delivered_dollars_now. To get a meaningful % view, anchor baseline_window before the policy went live (use pre-policy data).`
    );
  }

  const pctOf = (x: number) => safeDiv(x, attrTotal);

  // Action-split. Runs when an action attribution source was supplied AND
  // we observed dropped bytes. Prefers action-intent.json over legacy
  // cap-CSV suffixes. Surfaces a caveat when the attribution joined less
  // than half the dropped bytes — that's a config drift signal FinOps
  // should see in the commitment report.
  let per_action_breakdown: ActionBytesBuckets | undefined;
  let per_pattern_breakdown: VerifyResult['per_pattern_breakdown'];
  if (hasActionSource && postDroppedBytes > 0) {
    const split = computeActionSplit({
      postDroppedByHash: postDroppedByHash,
      hashToPattern,
      capCsvContent: args.cap_csv_content,
      actionIntentLookup,
      patternToContainer,
      postDroppedBytes,
    });
    per_action_breakdown = split.buckets;
    per_pattern_breakdown = split.rows;
    if (split.clamped) {
      caveats.push(
        'Action-split offload bucket clamped to residual to enforce parts-≤-whole (sum of per-action bytes exceeded post_dropped_bytes by FP drift).'
      );
    }
    if (
      split.buckets.unattributed > 0 &&
      split.buckets.unattributed / postDroppedBytes > 0.5
    ) {
      caveats.push(
        `Cap-CSV join attributed <50% of dropped bytes (${(
          ((postDroppedBytes - split.buckets.unattributed) /
            postDroppedBytes) *
          100
        ).toFixed(1)}%). Likely cap-CSV drift vs the deployed engine config.`
      );
    }
  }

  // SHARED rate resolver result drives the tag — agrees with the
  // delivered_dollars_now computation above. Collapses to 'list_price'
  // when neither caller arg, envs.json analyzerCost, nor
  // LOG10X_ANALYZER_COST is set; verify never reports 'unset' because the
  // destination list always provides a safety-net rate.
  const rate_source: 'list_price' | 'customer_supplied' =
    verifyRateResolved.source === 'customer_supplied' ? 'customer_supplied' : 'list_price';

  return {
    mode: 'verify',
    destination: args.destination,
    commitment_id: args.commitment_id,
    baseline_window: args.baseline_window,
    post_window: args.post_window,
    ...(baselineOffsetValid ? { baseline_offset: args.baseline_offset } : {}),
    baseline_bytes: baselineBytes,
    baseline_bytes_scaled: baselineScaled,
    post_passed_bytes: postPassedBytes,
    post_dropped_bytes: postDroppedBytes,
    delivered_pct,
    delivered_dollars_now,
    delivered_dollars_annual_projection,
    delivered_dollars_at_renewal,
    attribution: {
      cap_fired_bytes: cap_fired,
      drift_bytes: drift,
      new_patterns_bytes: new_patterns,
      leakage_bytes: leakage,
    },
    attribution_pct: {
      cap_fired_bytes: pctOf(cap_fired),
      drift_bytes: pctOf(drift),
      new_patterns_bytes: pctOf(new_patterns),
      leakage_bytes: pctOf(leakage),
    },
    causal_confidence: confidence,
    rate_source,
    per_action_breakdown,
    per_pattern_breakdown,
    caveats,
  };
}

// ─── markdown rendering ────────────────────────────────────────────────

// ─── main entry ────────────────────────────────────────────────────────

export async function executeEstimateSavings(
  args: EstimateSavingsArgs,
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const telemetry = newChassisTelemetry();
  const mode = args.mode ?? 'forecast';
  // siem_lens: stamped alias of destination (same pricing/gating override,
  // plus actual-vs-lens provenance on every emission site).
  if (args.siem_lens && !args.destination) (args as { destination?: string }).destination = args.siem_lens as never;
  // Thread args.destination so a what-if carried only via `destination` (no
  // explicit siem_lens) is detected as a lens when it differs from the env's
  // actual destination. siem_lens still wins; destination == actual => not a lens.
  const lensRes = resolveSiemLens(args.siem_lens, env?.analyzer, args.destination);

  // Helper: build a source_label from the EnvConfig nickname + cluster
  // identity for whatever destination the call settled on. Called per
  // emission site (forecast / verify / ambiguous / unsupported / no-op)
  // because each site knows a different vendor string. Memoised within the
  // call so the on-prem store resolution only runs once.
  let cachedEnvLabel: Awaited<ReturnType<typeof buildSourceDisclosureFromEnv>> | undefined;
  const labelForVendor = async (
    vendor: string | undefined | null,
  ): Promise<{ siem_vendor?: string; source_label?: string }> => {
    if (!vendor) return {};
    if (!cachedEnvLabel) {
      cachedEnvLabel = await buildSourceDisclosureFromEnv(env, vendor);
    }
    // cachedEnvLabel was built against the first vendor the executor saw;
    // when later sites pass a different vendor (e.g. the no-op refusal
    // names a destination distinct from the eventually-chosen one) we
    // honour the call-site's vendor but reuse the cached hints by
    // overriding siem_vendor + recomputing source_label from the same
    // bracketed suffix.
    if (cachedEnvLabel.siem_vendor === vendor) return cachedEnvLabel;
    const sl = cachedEnvLabel.source_label;
    const suffix = sl && sl.includes(' [') ? sl.slice(sl.indexOf(' [')) : '';
    return { siem_vendor: vendor, source_label: `${vendor}${suffix}` };
  };

  // Destination is required in both modes. When not passed explicitly, attempt
  // auto-detection via the same resolveSiemSelection helper that pattern_mitigate
  // and cost_options use — so all three tools apply consistent detection logic.
  const VALID_DESTS = [
    'splunk', 'datadog', 'elasticsearch', 'clickhouse',
    'cloudwatch', 'azure-monitor', 'gcp-logging', 'sumo',
  ] as const;
  type ValidDest = typeof VALID_DESTS[number];

  let destination: ValidDest;
  if (!args.destination) {
    const detected = await resolveSiemSelection({});
    recordQuery(telemetry);
    if (detected.kind === 'resolved') {
      const resolvedId = detected.id as string;
      // Validate the resolved id is in DEST_ENUM before accepting it.
      if (!(VALID_DESTS as readonly string[]).includes(resolvedId)) {
        return buildChassisEnvelope({
          tool: 'log10x_estimate_savings',
          view: 'summary',
          headline: 'estimate_savings refused: auto-detected destination not supported.',
          status: 'error',
          decisions: { threshold_used: null, threshold_basis: 'default' },
          // siem_vendor carries the detected (but unsupported) vendor name so
          // agents and log readers can see what was resolved.
          source_disclosure: { ...lensDisclosure(lensRes), bytes_source: 'tsdb', ...(await labelForVendor(resolvedId)) },
          scope: { window: 'unknown', window_basis: 'auto_default' },
          payload: {
            ok: false,
            phase: 'target_resolution',
            error: `auto-detected destination "${resolvedId}" is not in the supported set`,
          },
          human_summary: `Auto-detected "${resolvedId}" but that destination is not supported by estimate_savings. Pass one of ${VALID_DESTS.join(', ')}.`,
          error: {
            error_type: 'unsupported_destination',
            retryable: false,
            suggested_backoff_ms: null,
            hint: `Pass one of ${VALID_DESTS.join(', ')}.`,
          },
          telemetry,
        });
      }
      destination = resolvedId as ValidDest;
    } else if (detected.kind === 'ambiguous') {
      const names = detected.candidates.map((c) => c.displayName).join(', ');
      return buildChassisEnvelope({
        tool: 'log10x_estimate_savings',
        view: 'summary',
        headline: 'estimate_savings refused: multiple stacks detected — pass destination explicitly.',
        status: 'error',
        decisions: { threshold_used: null, threshold_basis: 'default' },
        // siem_vendor is intentionally absent: multiple vendors were found and
        // we cannot resolve to one. bytes_source is still tsdb.
        source_disclosure: { bytes_source: 'tsdb', ...lensDisclosure(lensRes) },
        scope: { window: 'unknown', window_basis: 'auto_default' },
        payload: {
          ok: false,
          phase: 'target_resolution',
          error: 'ambiguous destination',
          candidates: detected.candidates.map((c) => ({ id: c.id, displayName: c.displayName, source: c.source })),
        },
        human_summary: `Multiple configured stacks detected (${names}). Pass destination explicitly to specify which to use.`,
        error: {
          error_type: 'ambiguous_destination',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `Multiple stacks detected (${names}). Pass destination explicitly.`,
        },
        telemetry,
      });
    } else {
      // kind === 'none' — no credentials found, fall through to original refusal.
      return buildChassisEnvelope({
        tool: 'log10x_estimate_savings',
        view: 'summary',
        headline: 'estimate_savings refused: destination not specified.',
        status: 'error',
        decisions: { threshold_used: null, threshold_basis: 'default' },
        // No vendor resolved at all; bytes_source is still tsdb for this tool.
        source_disclosure: { bytes_source: 'tsdb', ...lensDisclosure(lensRes) },
        scope: { window: 'unknown', window_basis: 'auto_default' },
        payload: {
          ok: false,
          phase: 'target_resolution',
          error: 'destination is required',
        },
        human_summary: 'estimate_savings refused: destination is required. Pass one of splunk, datadog, elasticsearch, clickhouse, cloudwatch, azure-monitor, gcp-logging, sumo.',
        error: {
          error_type: 'missing_destination',
          retryable: false,
          suggested_backoff_ms: null,
          hint: 'Pass destination explicitly. Supported: splunk, datadog, elasticsearch, clickhouse, cloudwatch, azure-monitor, gcp-logging, sumo.',
        },
        telemetry,
      });
    }
  } else {
    destination = args.destination as ValidDest;
  }

  try {
    if (mode === 'forecast') {
      if (!args.proposed_config && args.target_percent === undefined) {
        return buildChassisEnvelope({
          tool: 'log10x_estimate_savings',
          view: 'summary',
          headline: 'estimate_savings needs target_percent or proposed_config — neither was passed.',
          status: 'error',
          decisions: { threshold_used: null, threshold_basis: 'default' },
          source_disclosure: { ...lensDisclosure(lensRes), bytes_source: 'tsdb', ...(await labelForVendor(destination)) },
          scope: { window: 'unknown', window_basis: 'auto_default' },
          payload: {
            ok: false,
            phase: 'target_resolution',
            error: 'target_percent or proposed_config required',
            required_inputs: {
              option_1: {
                arg: 'target_percent',
                description: 'a % reduction goal — the greedy solver picks which patterns to act on to hit it.',
                example_call: 'log10x_estimate_savings({ target_percent: 30 })',
              },
              option_2: {
                arg: 'proposed_config',
                description: 'an explicit list of per-pattern rows (pattern_hash + action) — the forecast scores exactly that plan.',
                example_call: 'log10x_estimate_savings({ proposed_config: [{ pattern_hash: "<hash>", action: "compact" }, ...] })',
              },
              gathering_tool: 'log10x_top_patterns',
              gathering_note: 'Most starting points: call log10x_top_patterns first, pick the heavy patterns, then call estimate_savings with either a target_percent or those patterns as proposed_config rows.',
            },
          },
          human_summary:
            'estimate_savings needs one of two inputs and neither was passed.\n\n' +
            'Option 1 — a savings target. Tell me how much you want to save.\n' +
            '  Example: log10x_estimate_savings({ target_percent: 30 }) — estimates what it would take to cut your bill by 30%.\n\n' +
            'Option 2 — specific patterns to target. Tell me which patterns you would mitigate.\n' +
            '  Example: log10x_estimate_savings({ proposed_config: [{ pattern_hash: "<hash>", action: "compact" }] }) — estimates savings if you mitigate those patterns.\n\n' +
            'Most starting points: run log10x_top_patterns first, pick the heavy ones, then call this with their hashes.',
          error: {
            error_type: 'missing_input',
            retryable: false,
            suggested_backoff_ms: null,
            hint:
              'Pass one of two inputs:\n' +
              '  • target_percent (number, 1-95): a % reduction goal. Example: log10x_estimate_savings({ target_percent: 30 }).\n' +
              '  • proposed_config (array of {pattern_hash, action}): explicit per-pattern rows. Example: log10x_estimate_savings({ proposed_config: [{ pattern_hash: "<hash>", action: "compact" }] }).\n' +
              'Gather candidate patterns first with log10x_top_patterns, then re-run with either input.',
          },
          telemetry,
        });
      }
      const proposed = args.proposed_config?.map((r) => ({
        pattern_hash: r.pattern_hash,
        action: r.action as Action,
        sample_n: r.sample_n,
      }));
      // Resolve effective observation window + basis. `timeRange` is an
      // alias for `observation_window` (same precedence rule as
      // log10x_investigate's window/timeRange aliasing). Without this
      // plumbing the alias was silently dropped at the Zod boundary: the
      // schema strips unknown keys, so a caller passing `{ timeRange: '7d' }`
      // would fall through to the hard-coded `'30d'` default inside
      // runEstimateForecast.
      const explicitObservationWindow =
        args.observation_window ?? args.timeRange;
      const forecastWindowBasis: 'explicit' | 'auto_default' =
        explicitObservationWindow ? 'explicit' : 'auto_default';
      const result = await runEstimateForecast(
        {
          lensed: lensRes.lensed,
          destination,
          es_pruned: args.es_pruned,
          tier_down_plan: args.tier_down_plan,
          service: args.service,
          retention_months: args.retention_months ?? 1,
          proposed_config: proposed,
          target_percent: args.target_percent,
          default_action: (args.default_action ?? 'compact') as Action,
          pattern_limit: args.pattern_limit,
          effective_ingest_per_gb: args.effective_ingest_per_gb,
          observation_window: explicitObservationWindow,
          monthly_volume_gb: args.monthly_volume_gb,
        },
        env
      );
      recordQuery(telemetry);
      const patternCountLabel = result.per_pattern_truncated
        ? `top ${result.per_pattern.length} of ${result.per_pattern_total_count} patterns`
        : `${result.per_pattern.length} pattern${result.per_pattern.length !== 1 ? 's' : ''}`;
      const rateTag = result.rate_source === 'customer_supplied'
        ? 'contracted rate'
        : `${destination} list price, your bill may differ`;

      // ── Action-mix disclosure ──
      // Compute per-action bucket totals from the full (pre-slice) per_pattern
      // set so the mix reflects every row the solver touched, not just the
      // displayed slice. We re-derive from per_pattern_sliced which is the
      // displayed set; for totals we already have result.totals.bytes_saved_monthly.
      const actionMix = buildActionMix(result.per_pattern);

      // Add action_mix to totals payload so renderers can surface it directly.
      result.totals.action_mix = actionMix;

      // Check whether the mix is uniformly tier_down (or has zero combined
      // bytes_saved_monthly across all patterns). tier_down does not reduce
      // byte volume; savings come from the lower per-GB rate at the cheaper
      // destination tier (both ingest and storage rate).
      const allTierDown =
        result.per_pattern.length > 0 &&
        result.per_pattern.every((r) => r.action === 'tier_down');
      const zeroByteSaved = result.totals.bytes_saved_monthly === 0;
      const tierDownOnly = allTierDown || (zeroByteSaved && actionMix.tier_down.pattern_count > 0 && actionMix.tier_down.pattern_count === result.per_pattern.length);

      // ── Headline construction ──
      const serviceTag = args.service ? ` on ${args.service}` : '';
      const solverActionTag = args.target_percent !== undefined && !args.proposed_config
        ? ` via ${(args.default_action ?? 'compact')}`
        : '';

      // When the solver wanted `compact` but the destination's no-op mode
      // forced every pattern to `tier_down`, the headline concatenated BOTH
      // clauses: "$0/mo savings via compact ... via tier_down ...". The
      // `solverActionTag` reflects what the SOLVER requested; the `via
      // tier_down` reflects what the destination ACTUALLY ASSIGNED. When
      // every pattern got tier_down (tierDownOnly), only the actual action
      // matters; suppress solverActionTag in that branch so the headline
      // stops claiming two contradictory actions.
      // C-policy: quote the saved DOLLAR in the headline only when the rate is
      // grounded in the customer's real (contracted) rate. At list_price the
      // dollar is the SIEM vendor rack rate, not their number, so lead with
      // VOLUME (GB saved / % reduction, always exact) and let the chassis
      // list-rate calibration callout (fired by source_disclosure.rate_source
      // === 'list_price') carry the "set effective_ingest_per_gb" caveat.
      const leadDollar = result.rate_source === 'customer_supplied';
      // Exact saved-volume framing for the volume-lead branches.
      const savedVol = fmtBytes(result.totals.bytes_saved_monthly);
      const bytePctReduced = result.totals.bytes_in_monthly > 0
        ? `${((result.totals.bytes_saved_monthly / result.totals.bytes_in_monthly) * 100).toFixed(0)}% reduction`
        : '0% reduction';
      let headline: string;
      if (args.enforcement_mode === 'manual_report') {
        headline = leadDollar
          ? `If you enforce externally: ${fmtDollar(result.totals.dollars_expected_monthly)}/mo savings potential${solverActionTag}${serviceTag} on ${patternCountLabel} (${(result.coverage_of_env_pct * 100).toFixed(0)}% of monthly env bytes). Enforcement choice is yours.`
          : `If you enforce externally: ${savedVol}/mo (${bytePctReduced})${solverActionTag}${serviceTag} on ${patternCountLabel} (${(result.coverage_of_env_pct * 100).toFixed(0)}% of monthly env bytes). Enforcement choice is yours.`;
      } else if (tierDownOnly) {
        const solverNote = args.target_percent !== undefined && args.default_action === 'compact'
          ? ` (solver requested compact; destination forced tier_down)`
          : '';
        // tier_down leaves byte volume unchanged; the saving is purely the
        // per-GB rate delta, so there is no GB-reduction volume to lead with.
        // Lead with the moved GB at the cheaper tier + pattern coverage, and
        // append the dollar only at customer_supplied.
        const tierVol = fmtBytes(result.totals.bytes_in_monthly);
        headline = leadDollar
          ? `Forecast (${destination}): ${fmtDollar(result.totals.dollars_expected_monthly)}/mo savings${serviceTag} via tier_down (cheaper destination tier, lower ingest + storage rate; byte volume unchanged) on ${patternCountLabel}${solverNote}.`
          : `Forecast (${destination}): ${tierVol}/mo moved to a cheaper destination tier${serviceTag} via tier_down (lower ingest + storage rate; byte volume unchanged) on ${patternCountLabel}${solverNote}.`;
      } else if (actionMix.tier_down.pattern_count > 0 && actionMix.tier_down.dollars > 0) {
        // Mixed: some tier_down + other actions
        const bytesSavingDollars = result.totals.dollars_expected_monthly - actionMix.tier_down.dollars;
        const bytePct = totalBytesForMix(actionMix, ['drop', 'sample', 'compact', 'offload']);
        const totalIn = result.totals.bytes_in_monthly;
        const bytePctStr = totalIn > 0 ? `${((bytePct / totalIn) * 100).toFixed(0)}% bytes` : '';
        headline = leadDollar
          ? `Forecast (${destination}): ${fmtDollar(result.totals.dollars_expected_monthly)}/mo total savings (at ${rateTag})${serviceTag}, ${fmtDollar(bytesSavingDollars)} via byte reduction (${bytePctStr}), ${fmtDollar(actionMix.tier_down.dollars)} via tier_down (no bytes change), on ${patternCountLabel}.`
          : `Forecast (${destination}): ${savedVol}/mo (${bytePctReduced}) via byte-reducing actions plus tier_down (no bytes change)${serviceTag} on ${patternCountLabel}.`;
      } else {
        headline = leadDollar
          ? `Forecast (${destination}): ${fmtDollar(result.totals.dollars_expected_monthly)}/mo expected savings (at ${rateTag})${solverActionTag}${serviceTag} on ${patternCountLabel} (${(result.coverage_of_env_pct * 100).toFixed(0)}% of monthly env bytes).`
          : `Forecast (${destination}): ${savedVol}/mo (${bytePctReduced}) expected reduction${solverActionTag}${serviceTag} on ${patternCountLabel} (${(result.coverage_of_env_pct * 100).toFixed(0)}% of monthly env bytes).`;
      }

      // Volume projection lens: mark the headline so a lensed run is never
      // mistaken for measured volume. Full provenance is in source_disclosure
      // + warnings + payload.volume_lens.
      if (result.volume_lens.lensed) {
        const pg = (result.volume_lens.projected_monthly_bytes ?? 0) / 1_000_000_000;
        const lab = pg >= 1000 ? `${(pg / 1000).toFixed(pg >= 10000 ? 0 : 1)} TB` : `${pg.toFixed(pg >= 10 ? 0 : 1)} GB`;
        headline = `[Projected to ${lab}/mo] ${headline}`;
      }

      const human_summary = buildForecastHumanSummary(result, destination, args.enforcement_mode, actionMix);
      // Compute threshold_basis from rate_source for the decisions block.
      const thresholdBasis = result.rate_source === 'customer_supplied'
        ? 'customer_supplied' as const
        : 'default' as const;
      return buildChassisEnvelope({
        tool: 'log10x_estimate_savings',
        view: 'summary',
        headline,
        status: result.totals.bytes_in_monthly > 0 ? 'success' : 'no_signal',
        decisions: {
          threshold_used: args.target_percent ?? null,
          threshold_basis: args.target_percent !== undefined ? 'customer_supplied' : thresholdBasis,
        },
        source_disclosure: {
          ...lensDisclosure(lensRes),
          ...volumeLensDisclosure(result.volume_lens),
          bytes_source: 'tsdb',
          rate_source: result.rate_source === 'customer_supplied' ? 'customer_supplied' : 'list_price',
          ...(await labelForVendor(destination)),
        },
        scope: {
          window: result.observation_window,
          window_basis: forecastWindowBasis,
          candidates_count: result.per_pattern_total_count,
          candidates_evaluated: result.per_pattern.length,
        },
        payload: { ok: true, ...result },
        human_summary,
        actions: [
          {
            tool: 'log10x_configure_engine',
            args: {
              service: args.service,
              destination,
              target_percent: args.target_percent,
            },
            role: 'recommended-next',
            reason: 'Turn this forecast into a per-pattern cap PR (configure_engine emits the gh command).',
          },
        ],
        warnings: result.volume_lens.lensed && result.volume_lens.disclosure
          ? [result.volume_lens.disclosure, ...result.caveats]
          : result.caveats,
        telemetry,
      });
    }

    // verify
    if (!args.baseline_window || !args.post_window) {
      return buildChassisEnvelope({
        tool: 'log10x_estimate_savings',
        view: 'summary',
        headline: 'estimate_savings refused: verify needs baseline_window + post_window.',
        status: 'error',
        decisions: { threshold_used: null, threshold_basis: 'default' },
        source_disclosure: { ...lensDisclosure(lensRes), bytes_source: 'tsdb', ...(await labelForVendor(destination)) },
        scope: { window: 'unknown', window_basis: 'auto_default' },
        payload: {
          ok: false,
          phase: 'target_resolution',
          error: 'baseline_window and post_window required',
        },
        human_summary: 'estimate_savings verify needs baseline_window (pre-merge) and post_window (post-merge), for example baseline_window="7d" and post_window="7d".',
        error: {
          error_type: 'missing_input',
          retryable: false,
          suggested_backoff_ms: null,
          hint: 'Pass baseline_window and post_window (e.g. "7d").',
        },
        telemetry,
      });
    }
    const result = await runEstimateVerify(
      {
        lensed: lensRes.lensed,
        destination,
        es_pruned: args.es_pruned,
        service: args.service,
        baseline_window: args.baseline_window,
        post_window: args.post_window,
        commitment_id: args.commitment_id,
        contract_type: args.contract_type,
        effective_ingest_per_gb: args.effective_ingest_per_gb,
      },
      env
    );
    recordQuery(telemetry);
    // When delivered_pct=0 but the engine dropped non-zero bytes (typical
    // when baseline == post_passed by construction or by env-growth
    // coincidence), the old headline
    // "0.0% delivered reduction ($52/yr projected)" was self-
    // contradicting to a CFO. Reframe: lead with what actually moved
    // (the $ value derived from dropped bytes) when delivered_pct is
    // structurally zero, and call out the % view as washed.
    const droppedBytesPositive =
      result.post_dropped_bytes > 0 &&
      Number.isFinite(result.post_dropped_bytes);
    // Tolerance for "effectively zero": when baseline_bytes_scaled differs
    // from post_passed_bytes by a few hundred bytes out of ~50 GB (float
    // noise + same-window-anchor artifact), delivered_pct lands at ~-5e-9,
    // close enough to zero that the CFO-facing narrative still applies.
    const pctViewWashed =
      Math.abs(result.delivered_pct) < 1e-6 && droppedBytesPositive;
    // C-policy: quote the projected DOLLAR in the headline only when the rate
    // is the customer's contracted rate. At list_price the dollar is the SIEM
    // rack rate, so lead with VOLUME (GB cap-fired / % delivered reduction,
    // always exact) and drop the dollar; the chassis list-rate callout (fired
    // by source_disclosure.rate_source === 'list_price') carries the caveat.
    const verifyRateSource = result.rate_source === 'customer_supplied' ? 'customer_supplied' as const : 'list_price' as const;
    const verifyLeadDollar = verifyRateSource === 'customer_supplied';
    const droppedGb = (result.post_dropped_bytes / 1_000_000_000).toFixed(2);
    const deliveredPctStr = (result.delivered_pct * 100).toFixed(1);
    const confStr = (result.causal_confidence * 100).toFixed(0);
    let headline: string;
    if (pctViewWashed) {
      headline = verifyLeadDollar
        ? `Verify (${destination}): cap fired on ${droppedGb} GB this window (${fmtDollar(result.delivered_dollars_annual_projection)}/yr at your contracted rate). Passed-byte ratio washed to 0% (see degenerate-windowing caveat); trust the $ figure. Confidence ${confStr}%.`
        : `Verify (${destination}): cap fired on ${droppedGb} GB this window. Passed-byte ratio washed to 0% (see degenerate-windowing caveat); trust the GB figure. Confidence ${confStr}%.`;
    } else {
      headline = verifyLeadDollar
        ? `Verify (${destination}): ${deliveredPctStr}% delivered reduction (${fmtDollar(result.delivered_dollars_annual_projection)}/yr at your contracted rate, confidence ${confStr}%).`
        : `Verify (${destination}): ${deliveredPctStr}% delivered reduction (${droppedGb} GB cap-fired this window, confidence ${confStr}%).`;
    }
    const human_summary = buildVerifyHumanSummary(result, destination);
    return buildChassisEnvelope({
      tool: 'log10x_estimate_savings',
      view: 'summary',
      headline,
      status: result.post_passed_bytes > 0 ? 'success' : 'no_signal',
      decisions: {
        threshold_used: null,
        threshold_basis: 'default',
        threshold_audit: {
          value: result.causal_confidence,
          basis: `causal_confidence=${(result.causal_confidence * 100).toFixed(0)}% (based on cap_fired share of attribution)`,
        },
      },
      source_disclosure: {
        ...lensDisclosure(lensRes),
        bytes_source: 'tsdb',
        rate_source: verifyRateSource,
        ...(await labelForVendor(destination)),
      },
      scope: {
        window: result.post_window,
        window_basis: 'explicit',
      },
      payload: { ok: true, ...result },
      human_summary,
      warnings: result.caveats,
      telemetry,
    });
  } catch (e: unknown) {
    if (e instanceof NoOpActionError) {
      const { action, destination: noOpDest } = e;
      return buildChassisEnvelope({
        tool: 'log10x_estimate_savings',
        view: 'summary',
        headline: `estimate_savings refused: ${action} is a no-op on ${noOpDest}. Use tier_down, sample, or drop instead.`,
        status: 'error',
        decisions: { threshold_used: null, threshold_basis: 'default' },
        source_disclosure: { ...lensDisclosure(lensRes), bytes_source: 'tsdb', ...(await labelForVendor(noOpDest)) },
        scope: { window: 'unknown', window_basis: 'auto_default' },
        payload: {
          ok: false,
          phase: 'target_resolution',
          error: `action=${action} is a no-op on ${noOpDest} (compact_mode=no-op)`,
          suggestion: {
            use_instead: ['tier_down', 'sample', 'drop'],
            reason: `COST_MODEL_BY_DESTINATION.${noOpDest}.compact_mode === 'no-op' — the destination bills on compressed ingest; compaction yields 0% reduction.`,
          },
        },
        human_summary: `compact is a no-op on ${noOpDest}. Use tier_down, sample, or drop instead.`,
        error: {
          error_type: 'noop_action',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `Use tier_down, sample, or drop on ${noOpDest} instead of compact.`,
        },
        telemetry,
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return buildChassisErrorEnvelope({
      tool: 'log10x_estimate_savings',
      err: {
        error_type: 'backend_error',
        retryable: true,
        suggested_backoff_ms: 2000,
        hint: msg,
      },
      telemetry,
      source_disclosure: { bytes_source: 'tsdb', ...lensDisclosure(lensRes) },
    });
  }
}

// ─── action-mix helpers ───────────────────────────────────────────────

export interface ActionMixBucket {
  dollars: number;
  bytes_saved: number;
  pattern_count: number;
}

export interface ActionMix {
  pass: ActionMixBucket;
  sample: ActionMixBucket;
  compact: ActionMixBucket;
  tier_down: ActionMixBucket;
  offload: ActionMixBucket;
  drop: ActionMixBucket;
}

function emptyBucket(): ActionMixBucket {
  return { dollars: 0, bytes_saved: 0, pattern_count: 0 };
}

export function buildActionMix(rows: ForecastRow[]): ActionMix {
  const mix: ActionMix = {
    pass: emptyBucket(),
    sample: emptyBucket(),
    compact: emptyBucket(),
    tier_down: emptyBucket(),
    offload: emptyBucket(),
    drop: emptyBucket(),
  };
  for (const row of rows) {
    const bucket = mix[row.action];
    if (!bucket) continue;
    bucket.pattern_count += 1;
    bucket.bytes_saved += row.bytes_saved_monthly;
    bucket.dollars += row.dollars_saved_expected;
  }
  return mix;
}

/** Sum bytes_saved across the specified actions. */
function totalBytesForMix(mix: ActionMix, actions: (keyof ActionMix)[]): number {
  let total = 0;
  for (const a of actions) total += mix[a].bytes_saved;
  return total;
}

// ─── human_summary builders ────────────────────────────────────────────
function buildForecastHumanSummary(
  result: ForecastResult,
  destination: string,
  enforcement_mode?: string,
  actionMix?: ActionMix,
): string {
  const patternWord = `${result.per_pattern.length} pattern${result.per_pattern.length === 1 ? '' : 's'}`;
  const envCoverage = `${(result.coverage_of_env_pct * 100).toFixed(0)}% of monthly env bytes`;
  const serviceClause = result.service ? ` on service ${result.service}` : '';
  const rateTag = result.rate_source === 'customer_supplied'
    ? 'contracted rate'
    : `${destination} list price`;
  // C-policy: lead the summary with the saved DOLLAR only when the rate is the
  // customer's contracted rate. At list_price the dollar is the SIEM rack
  // rate, so lead with VOLUME (GB saved / % reduction, always exact); the
  // chassis list-rate callout carries the calibration caveat.
  const leadDollar = result.rate_source === 'customer_supplied';
  const savedVol = fmtBytes(result.totals.bytes_saved_monthly);
  const bytePctReduced = result.totals.bytes_in_monthly > 0
    ? `${((result.totals.bytes_saved_monthly / result.totals.bytes_in_monthly) * 100).toFixed(0)}% reduction`
    : '0% reduction';

  // When action mix is uniformly tier_down (or bytes_saved is 0 and tier_down
  // dominates), use the tier-down framing so callers understand savings come
  // from the price differential, not byte reduction.
  if (actionMix) {
    const zeroByteSaved = result.totals.bytes_saved_monthly === 0;
    const allTierDown =
      result.per_pattern.length > 0 &&
      result.per_pattern.every((r) => r.action === 'tier_down');
    const tierDownOnly = allTierDown || (zeroByteSaved && actionMix.tier_down.pattern_count === result.per_pattern.length);
    if (tierDownOnly) {
      // tier_down leaves byte volume unchanged; lead with the moved GB at the
      // cheaper tier, append the dollar only at customer_supplied.
      const tierVol = fmtBytes(result.totals.bytes_in_monthly);
      const tierLead = leadDollar
        ? `${fmtDollar(result.totals.dollars_expected_monthly)}/mo savings via tier_down (cheaper destination tier, lower ingest + storage rate; byte volume unchanged)`
        : `${tierVol}/mo moved to a cheaper destination tier via tier_down (lower ingest + storage rate; byte volume unchanged)`;
      return `estimate_savings forecast on ${destination}${serviceClause}: ${tierLead}. ${patternWord} covering ${envCoverage}.${result.caveats.length ? ` Caveats: ${result.caveats.length}.` : ''}`;
    }
    // Mixed actions: break down by byte-reducing vs tier_down.
    if (actionMix.tier_down.pattern_count > 0 && actionMix.tier_down.dollars > 0) {
      const byteReducingDollars = result.totals.dollars_expected_monthly - actionMix.tier_down.dollars;
      const bytesPct = result.totals.bytes_in_monthly > 0
        ? `${((result.totals.bytes_saved_monthly / result.totals.bytes_in_monthly) * 100).toFixed(0)}% bytes`
        : '0% bytes';
      const mixLead = leadDollar
        ? `${fmtDollar(result.totals.dollars_expected_monthly)}/mo total savings, ${fmtDollar(byteReducingDollars)} via byte-reducing actions (${bytesPct} reduced), ${fmtDollar(actionMix.tier_down.dollars)} via tier_down (no bytes change)`
        : `${savedVol}/mo (${bytesPct} reduced) via byte-reducing actions plus tier_down (no bytes change)`;
      return `estimate_savings forecast on ${destination}${serviceClause}: ${mixLead}. ${patternWord} covering ${envCoverage}.${result.caveats.length ? ` Caveats: ${result.caveats.length}.` : ''}`;
    }
  }

  // Only surface a "(range $X to $Y)" band when the endpoints actually differ.
  // Point-estimate actions (e.g. offload, where low=expected=high) were
  // rendering "(range $49 to $49)", a single number dressed as a band, which
  // reads as false rigor. Suppress the band when low and high are within a
  // cent of each other. The dollar band only appears in the dollar-lead path.
  const rangeClause =
    Math.abs(result.totals.dollars_high_monthly - result.totals.dollars_low_monthly) >= 0.01
      ? ` (range ${fmtDollar(result.totals.dollars_low_monthly)} to ${fmtDollar(result.totals.dollars_high_monthly)})`
      : '';
  let lead: string;
  if (leadDollar) {
    lead =
      enforcement_mode === 'manual_report'
        ? `If you enforce externally on ${destination}${serviceClause}: ${fmtDollar(result.totals.dollars_expected_monthly)}/mo savings potential${rangeClause}. Enforcement is not automatic; this is the potential if the exclusion/drop is applied.`
        : `estimate_savings forecast on ${destination}${serviceClause} projects ${fmtDollar(result.totals.dollars_expected_monthly)}/mo expected savings${rangeClause}`;
  } else {
    lead =
      enforcement_mode === 'manual_report'
        ? `If you enforce externally on ${destination}${serviceClause}: ${savedVol}/mo (${bytePctReduced}) savings potential. Enforcement is not automatic; this is the potential if the exclusion/drop is applied.`
        : `estimate_savings forecast on ${destination}${serviceClause} projects ${savedVol}/mo (${bytePctReduced}) expected reduction`;
  }
  const disclosureSuffix = result.rate_disclosure ? ` ${result.rate_disclosure}.` : '.';
  return `${lead} across ${patternWord} covering ${envCoverage}, using ${rateTag}${disclosureSuffix}${result.caveats.length ? ` Caveats: ${result.caveats.length}.` : ''}`;
}

function buildVerifyHumanSummary(
  result: VerifyResult,
  destination: string
): string {
  // Same degenerate-windowing reframing as the headline: when the % view
  // is washed to 0 by baseline equaling post_passed, lead with the $
  // figure instead.
  const droppedBytesPositive =
    result.post_dropped_bytes > 0 &&
    Number.isFinite(result.post_dropped_bytes);
  const pctViewWashed = Math.abs(result.delivered_pct) < 1e-6 && droppedBytesPositive;
  const lead = pctViewWashed
    ? `estimate_savings verify on ${destination} measured cap fired on ${(result.post_dropped_bytes / 1_000_000_000).toFixed(2)} GB this window (passed-byte ratio washed to 0%, see caveat) at causal confidence ${(result.causal_confidence * 100).toFixed(0)}%.`
    : `estimate_savings verify on ${destination} measured ${(result.delivered_pct * 100).toFixed(1)}% delivered reduction at causal confidence ${(result.causal_confidence * 100).toFixed(0)}%.`;
  // C-policy: append the annual DOLLAR projection only when the rate is the
  // customer's contracted rate. At list_price it is the SIEM rack rate, so the
  // summary stays on the volume/% lead and the chassis list-rate callout
  // carries the caveat.
  const dollarSuffix = result.rate_source === 'customer_supplied'
    ? ` Annual projection ${fmtDollar(result.delivered_dollars_annual_projection)} at your contracted rate.`
    : '';
  return `${lead}${dollarSuffix}${result.caveats.length ? ` Caveats: ${result.caveats.length}.` : ''}`;
}
