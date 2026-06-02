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
 *   `isDropped` label (engine >= 1.0.8 — TenXSummary emits it on the
 *   receive aggregator):
 *     - baseline_bytes      : sum over baseline (isDropped="" only)
 *     - post_passed_bytes   : sum over post (isDropped="" only)
 *     - post_dropped_bytes  : sum over post (isDropped="true")
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
 *   The spec calls for `NotConfiguredError` from `lib/not-configured.ts`
 *   (the `feat/graceful-not-configured @ 87ab5e5` framework). That branch
 *   hasn't landed here; the equivalent existing primitive is
 *   `CustomerMetricsNotConfiguredError` thrown from `resolveBackend()`.
 *   We don't use that — our queries hit the env's own metrics backend
 *   (Reporter / Receiver TenXSummary metrics live on `env.metricsBackend`,
 *   not the cross-pillar customer backend), same as `savings.ts` and
 *   `trend.ts`. Structured-error envelopes are emitted directly with
 *   `phase` + `error` fields, matching the pattern in
 *   `configure-regulator.ts`. When the graceful-not-configured framework
 *   lands, swap the inline envelopes for `notConfiguredEnvelopeFromError`.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import {
  projectActionRange,
  getDestinationCostModel,
  annualizeDollars,
  type Action,
} from '../lib/cost.js';
import type { SiemId } from '../lib/siem/pricing.js';
import {
  buildEnvelope,
  type StructuredOutput,
} from '../lib/output-types.js';
import { fmtDollar, fmtPct } from '../lib/format.js';
import {
  parseCapCsv,
  buildPatternActionLookup,
  emptyActionBuckets,
  totalAttributedBytes,
  type ActionBytesBuckets,
} from '../lib/cap-csv-parser.js';

// ─── constants ──────────────────────────────────────────────────────────
const BYTES_METRIC = 'all_events_summaryBytes_total';
const VOLUME_METRIC = 'all_events_summaryVolume_total';
const GB = 1024 * 1024 * 1024;
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
      'forecast mode: action assigned to top patterns by the greedy solver when target_percent is used. Default: compact.'
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
    'Destination SIEM. Required for both modes (used to look up ingest $/GB + compact ratio band).'
  ),
  es_pruned: z
    .boolean()
    .optional()
    .describe(
      'Elasticsearch only: are compactable fields excluded from _source? Default false — the unpruned ratio band is used.'
    ),
  service: z
    .string()
    .optional()
    .describe(
      'Scope the forecast to a service. If omitted, runs across all services.'
    ),
  retention_months: z
    .number()
    .positive()
    .default(1)
    .describe('Retention window for storage cost. Default 1 month.'),
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
      "verify mode: override the destination model rate, e.g. customer's contracted $/GB."
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
  action: Action;
  bytes_in_monthly: number;
  bytes_saved_monthly: number;
  avg_event_size_bytes: number;
  dollars_saved_low: number;
  dollars_saved_expected: number;
  dollars_saved_high: number;
  notes?: string[];
}

export interface ForecastResult {
  mode: 'forecast';
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
    bytes_saved_monthly: number;
    dollars_low_monthly: number;
    dollars_expected_monthly: number;
    dollars_high_monthly: number;
    annual_projection_expected: number;
  };
  coverage_pct: number;
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
   * Bytes saved by each engine action, joined from the cap-CSV (see
   * cost-cutting-product-shape.md §6). Populated only when the caller
   * passed `cap_csv_content`; absent otherwise.
   *
   * Parts-≤-whole invariant: `totalAttributedBytes(per_action_breakdown)`
   * + `unattributed` ≤ `post_dropped_bytes` after the offload clamp;
   * see `clampOffloadToResidual` for the residual rule.
   */
  per_action_breakdown?: ActionBytesBuckets;
  /**
   * Per-pattern attribution rows. One row per pattern_hash with
   * non-zero isDropped="true" bytes in the post window. Action is
   * sourced from the cap-CSV via `buildPatternActionLookup`; rows
   * with no cap-CSV match are emitted with `action: 'drop'` and
   * `action_source: 'unattributed'` so the offload clamp + caveat
   * surfacing can identify them.
   */
  per_pattern_breakdown?: Array<{
    pattern_hash: string;
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
  },
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
}): number {
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
 * series, attributes each hash's bytes to a bucket via the cap-CSV
 * lookup, and clamps the offload bucket to the residual so the sum
 * never exceeds `post_dropped_bytes`. Returns BOTH the bucket totals
 * AND the per-pattern rows.
 */
function computeActionSplit(args: {
  postDroppedByHash: Record<string, number>;
  capCsvContent: string;
  patternToContainer: Map<string, string>;
  postDroppedBytes: number;
}): {
  buckets: ActionBytesBuckets;
  rows: NonNullable<VerifyResult['per_pattern_breakdown']>;
  clamped: boolean;
} {
  const parsed = parseCapCsv(args.capCsvContent);
  const lookup = buildPatternActionLookup(parsed, args.patternToContainer);
  const buckets = emptyActionBuckets();
  const rows: NonNullable<VerifyResult['per_pattern_breakdown']> = [];

  // Sort hashes by descending dropped bytes so the residual clamp acts
  // on the SMALLEST offload contributions first (preserves the largest
  // ones intact when the parts-sum approaches the whole).
  const sortedHashes = Object.entries(args.postDroppedByHash)
    .filter(([, b]) => Number.isFinite(b) && b > 0)
    .sort((a, b) => b[1] - a[1]);

  for (const [hash, droppedBytes] of sortedHashes) {
    const action = lookup.get(hash);
    const patRow = parsed.by_pattern.get(hash);
    const container = args.patternToContainer.get(hash);
    const containerRow = container
      ? parsed.by_container.get(container)
      : undefined;
    let action_source: 'pat_row' | 'container' | 'unattributed';
    let effectiveAction: Action;
    let expectedBytes: number | null;
    if (patRow) {
      action_source = 'pat_row';
      effectiveAction = patRow.action;
      expectedBytes = patRow.bytes_cap;
    } else if (containerRow) {
      action_source = 'container';
      effectiveAction = containerRow.action;
      expectedBytes = containerRow.bytes_cap;
    } else {
      action_source = 'unattributed';
      effectiveAction = action ?? 'drop';
      expectedBytes = null;
    }
    if (action_source === 'unattributed') {
      buckets.unattributed += droppedBytes;
    } else {
      // Bucket dispatch. The CSV grammar admits all six engine actions;
      // 'pass' and 'sample' are no-op for delivered savings but we
      // still surface the row so callers can audit unexpected configs.
      buckets[effectiveAction] += droppedBytes;
    }
    rows.push({
      pattern_hash: hash,
      action: effectiveAction,
      delivered_bytes: droppedBytes,
      expected_bytes: expectedBytes,
      action_source,
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
  /**
   * Maximum per_pattern rows to return. Default 50 when service is omitted;
   * unlimited when service is set. Totals computed over full result before slice.
   */
  pattern_limit?: number;
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
  // and default_action is a no-op on this destination, skip all Prometheus
  // queries and throw a structured error. proposed_config callers can audit
  // per-row no-op caveats in the projection loop below.
  if (
    args.target_percent !== undefined &&
    !args.proposed_config
  ) {
    const earlyModel = getDestinationCostModel(args.destination, {
      esPruned: args.es_pruned,
    });
    if (
      args.default_action === 'compact' &&
      earlyModel.compact_mode === 'no-op'
    ) {
      throw new NoOpActionError(args.default_action, args.destination);
    }
  }

  const observationWindow = args.observation_window ?? '30d';
  const obsDays = parseWindowToDays(observationWindow);

  // Build the scope selector: env always, optionally service.
  const extraFilters: string[] = [];
  if (args.service) {
    extraFilters.push(`${env.labels.service}="${escapeLabel(args.service)}"`);
  }
  const selector = selectorWithEnv(env, extraFilters);

  // Per-pattern bytes + events over the observation window.
  // Group by the stable hash (env.labels.hash → tenx_hash by default).
  const bytesQuery = `sum by (${env.labels.hash}) (increase(${BYTES_METRIC}{${selector}}[${observationWindow}]))`;
  const eventsQuery = `sum by (${env.labels.hash}) (increase(${VOLUME_METRIC}{${selector}}[${observationWindow}]))`;
  const totalQuery = `sum(increase(${BYTES_METRIC}{${selector}}[${observationWindow}]))`;

  // Per-hash service label query — used for per_service rollup when service
  // is omitted. We need (hash → service) so we can group solver rows by service
  // after projection. Query by both hash and service labels; take the dominant
  // service per hash by bytes (same tie-break as extractHashContainerMap).
  const hashServiceQuery = !args.service
    ? `sum by (${env.labels.hash},${env.labels.service}) (increase(${BYTES_METRIC}{${selectorWithEnv(env)}}[${observationWindow}]))`
    : null;

  const parallelQueries: Array<Promise<unknown>> = [
    queryInstant(env, bytesQuery),
    queryInstant(env, eventsQuery),
    queryInstant(env, totalQuery),
  ];
  if (hashServiceQuery) {
    parallelQueries.push(queryInstant(env, hashServiceQuery));
  }

  const queryResults = await Promise.all(parallelQueries);
  const [bytesRes, eventsRes, totalRes] = queryResults as [
    Parameters<typeof parsePromResult>[0],
    Parameters<typeof parsePromResult>[0],
    Parameters<typeof parseScalarSum>[0],
  ];
  const hashServiceRes = hashServiceQuery
    ? (queryResults[3] as Parameters<typeof parsePromResult>[0])
    : null;

  const bytesByHash = parsePromResult(bytesRes, env.labels.hash);
  const eventsByHash = parsePromResult(eventsRes, env.labels.hash);
  const totalBytesObserved = parseScalarSum(totalRes);
  // Scale observation to a 30-day month (the forecast quotes monthly dollars).
  const scale = MONTH_DAYS / obsDays;

  // Build hash→service map for the per_service rollup (service-omitted mode).
  // Dominant service per hash = highest bytes; ties broken lexicographically.
  const hashToService = new Map<string, string>();
  if (hashServiceRes) {
    const svcRows = hashServiceRes?.data?.result ?? [];
    const acc = new Map<string, { service: string; bytes: number }>();
    for (const row of svcRows) {
      const hash = row.metric?.[env.labels.hash];
      const svc = row.metric?.[env.labels.service];
      if (!hash || !svc) continue;
      const v = row.value ? parseFloat(row.value[1]) : NaN;
      const bytes = Number.isFinite(v) ? v : 0;
      const prior = acc.get(hash);
      if (
        !prior ||
        bytes > prior.bytes ||
        (bytes === prior.bytes && svc.localeCompare(prior.service) < 0)
      ) {
        acc.set(hash, { service: svc, bytes });
      }
    }
    for (const [hash, { service }] of acc.entries()) {
      hashToService.set(hash, service);
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
    // assign default_action until cumulative savings >= target.
    const sorted = Object.entries(bytesByHash)
      .map(([hash, b]) => ({ hash, bytes: b * scale }))
      .sort((a, b) => b.bytes - a.bytes);
    const targetBytes =
      (args.target_percent! / 100) * (totalBytesObserved * scale);
    const model = getDestinationCostModel(args.destination, {
      esPruned: args.es_pruned,
    });
    // Use the EXPECTED reduction per byte for this action — for compact
    // it's (1 - midpoint(low,high)) on supported dests, else 0.
    let expectedReductionPerByte = 0;
    if (args.default_action === 'drop' || args.default_action === 'offload') {
      expectedReductionPerByte = 1;
    } else if (args.default_action === 'sample') {
      expectedReductionPerByte = 0.9; // 1 in 10 default
    } else if (
      args.default_action === 'compact' &&
      model.compact_mode !== 'no-op'
    ) {
      expectedReductionPerByte =
        1 - (model.compact_ratio_low + model.compact_ratio_high) / 2;
    }
    let saved = 0;
    for (const row of sorted) {
      if (saved >= targetBytes) break;
      rows.push({ pattern_hash: row.hash, action: args.default_action });
      saved += row.bytes * expectedReductionPerByte;
    }
  }

  // Project each row.
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
    const passRange = projectActionRange({
      action: 'pass',
      bytes_in: monthlyBytes,
      destination: args.destination,
      retention_months: args.retention_months,
      esPruned: args.es_pruned,
    });
    const actionRange = projectActionRange({
      action: row.action,
      bytes_in: monthlyBytes,
      avg_event_size_bytes: avgSize || undefined,
      sample_n: row.sample_n ?? 10,
      destination: args.destination,
      retention_months: args.retention_months,
      esPruned: args.es_pruned,
    });

    const savedBytes = monthlyBytes - actionRange.expected.bytes_out;
    // Range is intentionally swapped: high savings = low destination cost.
    // total_dollars is now nullable; when unset we surface 0 here so the
    // existing envelope compiles. Full rate_source propagation lands in the
    // estimate-savings patch (step 6 of the build order).
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
      action: row.action,
      bytes_in_monthly: monthlyBytes,
      bytes_saved_monthly: Math.max(0, savedBytes),
      avg_event_size_bytes: avgSize,
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
  const coverage_pct = safeDiv(totalIn, totalObservedMonthly);

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
  }

  const caveats: string[] = [];
  if (noOpCompactCount > 0) {
    caveats.push(
      `${noOpCompactCount} pattern${noOpCompactCount !== 1 ? 's' : ''} use action=compact on ${args.destination}, which is a no-op destination. Consider tier_down, sample, or drop.`
    );
  }
  if (per_pattern_truncated) {
    caveats.push(
      `Showing top ${effectiveLimit} of ${per_pattern_total_count} patterns by volume. Totals and coverage_pct reflect all ${per_pattern_total_count} patterns.`
    );
  }
  if (coverage_pct < 0.6 && rows.length > 0) {
    caveats.push(
      `Forecast covers ${(coverage_pct * 100).toFixed(0)}% of monthly bytes. The long tail (${((1 - coverage_pct) * 100).toFixed(0)}%) is not modeled.`
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

  return {
    mode: 'forecast',
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
      bytes_saved_monthly: totalSavedBytes,
      dollars_low_monthly: totalLow,
      dollars_expected_monthly: totalExpected,
      dollars_high_monthly: totalHigh,
      annual_projection_expected: totalExpected * 12,
    },
    coverage_pct,
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
   * repo at `lookup_path`). When present, the verify run joins the
   * pattern-level isDropped="true" series against the CSV to populate
   * `per_action_breakdown` + `per_pattern_breakdown` on VerifyResult.
   * When absent, those fields are undefined and the commitment-report
   * adapter falls back to its legacy single-bucket attribution.
   */
  cap_csv_content?: string | null;
  /**
   * Label name carrying the container value on the engine's metrics.
   * Defaults to `k8s_container` (matches configure-engine.ts's PromQL
   * shape). Exposed so a customer with a relabeled aggregator can pass
   * the right label without us hard-coding the default in two places.
   */
  container_label?: string;
}

/**
 * Pure-function entry for verify. Queries the engine's isDropped label
 * (TenXSummary, engine >= 1.0.8) to attribute the delta.
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

  // 1. Baseline: bytes that PASSED the engine (no drops) over baseline_window.
  //    Engine 1.0.8+ emits literal label values isDropped="false" (kept) and
  //    isDropped="true" (capped). Pre-1.0.8 engines omit the label entirely.
  //    Using `isDropped!="true"` covers BOTH: matches "false" AND label-absent.
  //    Live verified 2026-06-01 on prometheus.log10x.com — `isDropped=""`
  //    matched zero series; `isDropped!="true"` matches the kept cohort.
  const baselinePassedQuery = `sum(increase(${BYTES_METRIC}{${baseSelector},isDropped!="true"}[${args.baseline_window}]))`;
  const baselineByHashQuery = `sum by (${hashLabel}) (increase(${BYTES_METRIC}{${baseSelector},isDropped!="true"}[${args.baseline_window}]))`;
  // 2. Post: same query over post_window.
  const postTotalQuery = `sum(increase(${BYTES_METRIC}{${baseSelector}}[${args.post_window}]))`;
  const postPassedQuery = `sum(increase(${BYTES_METRIC}{${baseSelector},isDropped!="true"}[${args.post_window}]))`;
  const postDroppedQuery = `sum(increase(${BYTES_METRIC}{${baseSelector},isDropped="true"}[${args.post_window}]))`;
  const postPassedByHashQuery = `sum by (${hashLabel}) (increase(${BYTES_METRIC}{${baseSelector},isDropped!="true"}[${args.post_window}]))`;
  const postDroppedByHashQuery = `sum by (${hashLabel}) (increase(${BYTES_METRIC}{${baseSelector},isDropped="true"}[${args.post_window}]))`;

  const [
    baselineTotalRes,
    baselineByHashRes,
    postTotalRes,
    postPassedRes,
    postDroppedRes,
    postPassedByHashRes,
    postDroppedByHashRes,
  ] = await Promise.all([
    queryInstant(env, baselinePassedQuery),
    queryInstant(env, baselineByHashQuery),
    queryInstant(env, postTotalQuery),
    queryInstant(env, postPassedQuery),
    queryInstant(env, postDroppedQuery),
    queryInstant(env, postPassedByHashQuery),
    queryInstant(env, postDroppedByHashQuery),
  ]);

  const baselineBytes = parseScalarSum(baselineTotalRes);
  const baselineByHash = parsePromResult(baselineByHashRes, hashLabel);
  const postTotalBytes = parseScalarSum(postTotalRes);
  const postPassedBytes = parseScalarSum(postPassedRes);
  const postDroppedBytes = parseScalarSum(postDroppedRes);
  const postPassedByHash = parsePromResult(postPassedByHashRes, hashLabel);
  const postDroppedByHash = parsePromResult(postDroppedByHashRes, hashLabel);

  // 3. Optional per-(hash, container) drop query — only when a cap-CSV
  //    was supplied AND there are dropped bytes to attribute. We skip the
  //    extra Prometheus roundtrip otherwise.
  const containerLabel = args.container_label ?? 'k8s_container';
  let patternToContainer = new Map<string, string>();
  if (args.cap_csv_content && postDroppedBytes > 0) {
    const dropByPairQuery = `sum by (${hashLabel}, ${containerLabel}) (increase(${BYTES_METRIC}{${baseSelector},isDropped="true"}[${args.post_window}]))`;
    try {
      const pairRes = await queryInstant(env, dropByPairQuery);
      patternToContainer = extractHashContainerMap(
        pairRes,
        hashLabel,
        containerLabel
      );
    } catch {
      // Best-effort: leave the map empty. The action-split path will
      // emit `unattributed` rows for every dropped hash, which the
      // caller surfaces as a caveat.
    }
  }

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

  // Dollars: deliver-side rate (passed bytes × $/GB).
  const ingestRate =
    args.effective_ingest_per_gb ??
    getDestinationCostModel(args.destination, { esPruned: args.es_pruned })
      .ingest_per_gb;
  const delivered_dollars_now = (postPassedBytes / GB) * ingestRate;
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
      'No isDropped="true" bytes observed in the post window. Either no policy is deployed, or the engine version does not emit the isDropped label (requires engine >= 1.0.8).'
    );
  }
  if (baseDays < 7) {
    caveats.push(
      `Baseline window is ${baseDays.toFixed(1)}d (<7d). Attribution may be noisy; widen the baseline for higher confidence.`
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

  const pctOf = (x: number) => safeDiv(x, attrTotal);

  // Action-split (Item 5). Runs only when a cap-CSV was supplied AND
  // we observed dropped bytes. Surfaces a caveat when the CSV joined
  // less than half the dropped bytes — that's a config drift signal
  // FinOps should see in the commitment report.
  let per_action_breakdown: ActionBytesBuckets | undefined;
  let per_pattern_breakdown: VerifyResult['per_pattern_breakdown'];
  if (args.cap_csv_content && postDroppedBytes > 0) {
    const split = computeActionSplit({
      postDroppedByHash: postDroppedByHash,
      capCsvContent: args.cap_csv_content,
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

  const rate_source: 'list_price' | 'customer_supplied' =
    args.effective_ingest_per_gb !== undefined
      ? 'customer_supplied'
      : 'list_price';

  return {
    mode: 'verify',
    destination: args.destination,
    commitment_id: args.commitment_id,
    baseline_window: args.baseline_window,
    post_window: args.post_window,
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
  const mode = args.mode ?? 'forecast';

  // Destination is required in both modes.
  if (!args.destination) {
    return buildEnvelope({
      tool: 'log10x_estimate_savings',
      view: 'summary',
      summary: {
        headline: 'estimate_savings refused: destination not specified.',
      },
      data: {
        ok: false,
        phase: 'target_resolution',
        error: 'destination is required',
        human_summary:
          'estimate_savings refused: destination is required. Pass one of splunk, datadog, elasticsearch, clickhouse, cloudwatch, azure-monitor, gcp-logging, sumo.',
      },
    });
  }

  try {
    if (mode === 'forecast') {
      if (!args.proposed_config && args.target_percent === undefined) {
        return buildEnvelope({
          tool: 'log10x_estimate_savings',
          view: 'summary',
          summary: {
            headline:
              'estimate_savings refused: pass proposed_config or target_percent.',
          },
          data: {
            ok: false,
            phase: 'target_resolution',
            error: 'proposed_config or target_percent required',
            human_summary:
              'estimate_savings forecast needs either proposed_config (explicit per-pattern rows) or target_percent (greedy solver picks rows).',
          },
        });
      }
      const proposed = args.proposed_config?.map((r) => ({
        pattern_hash: r.pattern_hash,
        action: r.action as Action,
        sample_n: r.sample_n,
      }));
      const result = await runEstimateForecast(
        {
          destination: args.destination,
          es_pruned: args.es_pruned,
          service: args.service,
          retention_months: args.retention_months ?? 1,
          proposed_config: proposed,
          target_percent: args.target_percent,
          default_action: (args.default_action ?? 'compact') as Action,
          pattern_limit: args.pattern_limit,
        },
        env
      );
      const patternCountLabel = result.per_pattern_truncated
        ? `top ${result.per_pattern.length} of ${result.per_pattern_total_count} patterns`
        : `${result.per_pattern.length} pattern${result.per_pattern.length !== 1 ? 's' : ''}`;
      const headline = `Forecast (${args.destination}): ${fmtDollar(result.totals.dollars_expected_monthly)}/mo expected savings (at ${args.destination} list price — your bill may differ) on ${patternCountLabel} (coverage ${fmtPct(result.coverage_pct)}).`;
      const human_summary = buildForecastHumanSummary(result, args.destination);
      return buildEnvelope({
        tool: 'log10x_estimate_savings',
        view: 'summary',
        summary: { headline },
        data: { ok: true, ...result, human_summary },
        warnings: result.caveats,
        actions: [
          {
            tool: 'log10x_configure_engine',
            args: {
              service: args.service,
              destination: args.destination,
              target_percent: args.target_percent,
            },
            role: 'recommended-next',
            reason:
              'Turn this forecast into a per-pattern cap PR (configure_engine emits the gh command).',
          },
        ],
      });
    }

    // verify
    if (!args.baseline_window || !args.post_window) {
      return buildEnvelope({
        tool: 'log10x_estimate_savings',
        view: 'summary',
        summary: {
          headline:
            'estimate_savings refused: verify needs baseline_window + post_window.',
        },
        data: {
          ok: false,
          phase: 'target_resolution',
          error: 'baseline_window and post_window required',
          human_summary:
            'estimate_savings verify needs baseline_window (pre-merge) and post_window (post-merge), for example baseline_window="7d" and post_window="7d".',
        },
      });
    }
    const result = await runEstimateVerify(
      {
        destination: args.destination,
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
    const headline = `Verify (${args.destination}): ${(result.delivered_pct * 100).toFixed(1)}% delivered reduction (${fmtDollar(result.delivered_dollars_annual_projection)}/yr projected at ${args.destination} list price — your bill may differ, confidence ${(result.causal_confidence * 100).toFixed(0)}%).`;
    const human_summary = buildVerifyHumanSummary(result, args.destination);
    return buildEnvelope({
      tool: 'log10x_estimate_savings',
      view: 'summary',
      summary: { headline },
      data: { ok: true, ...result, human_summary },
      warnings: result.caveats,
    });
  } catch (e: unknown) {
    if (e instanceof NoOpActionError) {
      const { action, destination } = e;
      return buildEnvelope({
        tool: 'log10x_estimate_savings',
        view: 'summary',
        summary: {
          headline: `estimate_savings refused: ${action} is a no-op on ${destination}. Use tier_down, sample, or drop instead.`,
        },
        data: {
          ok: false,
          phase: 'target_resolution',
          error: `action=${action} is a no-op on ${destination} (compact_mode=no-op)`,
          suggestion: {
            use_instead: ['tier_down', 'sample', 'drop'],
            reason: `COST_MODEL_BY_DESTINATION.${destination}.compact_mode === 'no-op' — the destination bills on compressed ingest; compaction yields 0% reduction.`,
          },
          human_summary: `compact is a no-op on ${destination}. Use tier_down, sample, or drop instead.`,
        },
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return buildEnvelope({
      tool: 'log10x_estimate_savings',
      view: 'summary',
      summary: { headline: 'estimate_savings failed.' },
      data: {
        ok: false,
        phase: 'backend',
        error: msg,
        human_summary: `estimate_savings failed: ${msg}`,
      },
    });
  }
}

// ─── human_summary builders ────────────────────────────────────────────
function buildForecastHumanSummary(
  result: ForecastResult,
  destination: string
): string {
  const patternWord = `${result.per_pattern.length} pattern${result.per_pattern.length === 1 ? '' : 's'}`;
  const coverage = `${fmtPct(result.coverage_pct)} coverage`;
  // ForecastResult does not yet carry rate_source (see TODO at top of file);
  // dollars are list-price until full propagation lands.
  return `estimate_savings forecast on ${destination} projects ${fmtDollar(result.totals.dollars_expected_monthly)}/mo expected savings (range ${fmtDollar(result.totals.dollars_low_monthly)}–${fmtDollar(result.totals.dollars_high_monthly)}) across ${patternWord} at ${coverage}, using the engine list price.${result.caveats.length ? ` Caveats: ${result.caveats.length}.` : ''}`;
}

function buildVerifyHumanSummary(
  result: VerifyResult,
  destination: string
): string {
  const lead = `estimate_savings verify on ${destination} measured ${(result.delivered_pct * 100).toFixed(1)}% delivered reduction at causal confidence ${(result.causal_confidence * 100).toFixed(0)}%.`;
  return `${lead} Annual projection ${fmtDollar(result.delivered_dollars_annual_projection)} using the engine list price.${result.caveats.length ? ` Caveats: ${result.caveats.length}.` : ''}`;
}
