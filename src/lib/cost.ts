/**
 * Cost calculation helpers.
 *
 * Two layers:
 *   - Back-compat layer (bytesToCost, bytesToGb, parsePrometheusValue):
 *     unchanged signatures, used by existing tools (savings, top-volume,
 *     top-patterns, event-lookup, trend, services, investigate, etc).
 *   - X% commitment layer (projectAction, projectActionRange,
 *     COST_MODEL_BY_DESTINATION, getDestinationCostModel, annualizeDollars):
 *     splits ingest vs storage, models per-destination compact ratios with
 *     uncertainty bands, and degrades savings for small events where
 *     envelope overhead dominates.
 *
 * Compact-ratio numbers come from the CH/ES PoC findings:
 *   - ClickHouse dict+UDF+view: 70-78% typical reduction on noisy payloads
 *     (7-79% observed range). Modeled here as compact_ratio 0.22..0.30
 *     (post/pre).
 *   - Elasticsearch pruned (compactable fields excluded from _source):
 *     45-73% reduction range. Modeled as compact_ratio 0.30..0.40.
 *   - Elasticsearch unpruned: ~45-55% post/pre. Returned via
 *     getDestinationCostModel(dest, {esPruned:false}).
 *   - Splunk envelope-in-event: ~92% reduction on the OUTER stream.
 *     Modeled as 0.08..0.15.
 *   - Datadog/CW/Azure/GCP/Sumo: no-op (destination cannot accept encoded
 *     events). compact_ratio = 1.0..1.0; a caveat is emitted by callers.
 *
 * Small-event degradation: below `small_event_floor_bytes` (default 100),
 * envelope overhead linearly degrades the compact ratio toward 1.0. At
 * avgSize == floor → baseRatio. At avgSize → 0 → ratio → 1.0.
 */

import type { SiemId } from './siem/pricing.js';
import { DEFAULT_ANALYZER_COST_PER_GB } from './siem/pricing.js';

const GB = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// BACK-COMPAT LAYER — do not change signatures.
// ---------------------------------------------------------------------------

/** Convert bytes to cost in dollars at the given $/GB rate. */
export function bytesToCost(bytes: number, costPerGb: number): number {
  return (bytes / GB) * costPerGb;
}

/** Convert bytes to GB. */
export function bytesToGb(bytes: number): number {
  return bytes / GB;
}

/** Parse a Prometheus value (always a string) to a number. */
export function parsePrometheusValue(result: { value?: [number, string] }): number {
  if (!result.value || result.value.length < 2) return 0;
  const val = parseFloat(result.value[1]);
  return isNaN(val) ? 0 : val;
}

// ---------------------------------------------------------------------------
// X% COMMITMENT LAYER
// ---------------------------------------------------------------------------

/**
 * What the destination bills on.
 *  - uncompressed-ingest: Splunk (bytes-into-indexer at uncompressed size)
 *  - compressed-ingest:   Datadog, CloudWatch, GCP Logging, Sumo, Azure
 *                         (bytes accepted by the API; vendor compresses
 *                         post-receipt)
 *  - indexed-uncompressed: Elasticsearch (the _source / index footprint)
 *  - stored-month:        ClickHouse, S3-backed offload (per GB-month)
 */
export type BillingBasis =
  | 'uncompressed-ingest'
  | 'compressed-ingest'
  | 'indexed-uncompressed'
  | 'stored-month';

/**
 * How (or whether) compaction lands at this destination.
 *  - no-op:          destination cannot accept encoded events (Datadog &
 *                    friends). compact_ratio fixed at 1.0; caller warns.
 *  - envelope:       Splunk-style encode-in-event; query-time decode.
 *  - dict-udf-view:  ClickHouse dictionary + UDF + view path.
 *  - index-pruned:   ES with `_source.excludes` of compactable fields.
 *  - index-unpruned: ES without pruning (savings come from value-level
 *                    rewrite, not index pruning).
 */
export type CompactMode =
  | 'no-op'
  | 'envelope'
  | 'dict-udf-view'
  | 'index-pruned'
  | 'index-unpruned';

export interface DestinationCostModel {
  destination: SiemId;
  /** $/GB billed at ingest. */
  ingest_per_gb: number;
  /** $/GB-month billed for retention. */
  storage_per_gb_month: number;
  billing_basis: BillingBasis;
  compact_mode: CompactMode;
  /**
   * Ratio of POST-compact bytes / PRE-compact bytes for the destination's
   * billed measure. Lower = better savings. Range describes uncertainty.
   */
  compact_ratio_low: number;
  compact_ratio_high: number;
  /**
   * Body-size below which compaction efficiency degrades (envelope overhead
   * dominates). Default 100 bytes.
   */
  small_event_floor_bytes: number;
}

export interface SavingsProjection {
  bytes_in: number;
  /** Post-action bytes leaving forwarder toward destination. */
  bytes_out: number;
  ingest_dollars: number | null;
  /** For the retention window the caller supplies (default 1 month). */
  storage_dollars: number | null;
  total_dollars: number | null;
  basis: BillingBasis;
  confidence: 'low' | 'expected' | 'high';
  /** Always populated. 0..100. */
  percent_reduction: number;
  /** Origin of each axis' rate. */
  rate_source: {
    ingest: 'list' | 'customer_supplied' | 'unset';
    storage: 'list' | 'customer_supplied' | 'unset';
  };
  notes?: string[];
}

/**
 * Headline-shaped projection consumed by percent-first tool surfaces. Mixes
 * percent (always present) with optional dollar overlays gated on whether the
 * caller could supply a rate (customer-supplied) or fall back to vendors.json
 * list. When neither is available, dollars are omitted entirely.
 */
export interface SavingsHeadline {
  percent: { low: number; expected: number; high: number };
  bytes: { in: number; out_expected: number };
  dollars?: {
    list_low?: number;
    list_expected?: number;
    list_high?: number;
    customer_low?: number;
    customer_expected?: number;
    customer_high?: number;
  };
  rate_source: 'list_price' | 'customer_supplied' | 'unset';
  range?: {
    low: SavingsProjection;
    expected: SavingsProjection;
    high: SavingsProjection;
  };
}

export type Action =
  | 'pass'
  | 'sample'
  | 'compact'
  | 'tier_down'
  | 'offload'
  | 'drop';

/**
 * Per-destination cost & compaction model.
 *
 * Note: $/GB ingest values intentionally match
 * DEFAULT_ANALYZER_COST_PER_GB from lib/siem/pricing.ts (single source of
 * truth: comsite vendors.json). Storage numbers are estimates:
 *  - Splunk: ~$0.10/GB-month retained (varies wildly by tier).
 *  - ES: $0.05/GB-month at hot-tier list pricing.
 *  - CH self-hosted: $0.023/GB-month (S3-backed object cost).
 *  - CW: $0.03/GB-month.
 *  - Azure Logs: $0.12/GB-month (interactive).
 *  - GCP Logging: $0.01/GB-month (after 30d free).
 *  - Sumo: $0.02/GB-month (continuous tier).
 *  - Datadog: $0 storage (commodity included; pure ingest billing).
 */
export const COST_MODEL_BY_DESTINATION: Record<SiemId, DestinationCostModel> = {
  splunk: {
    destination: 'splunk',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.splunk,
    storage_per_gb_month: 0.1,
    billing_basis: 'uncompressed-ingest',
    compact_mode: 'envelope',
    compact_ratio_low: 0.08,
    compact_ratio_high: 0.15,
    small_event_floor_bytes: 100,
  },
  datadog: {
    destination: 'datadog',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.datadog,
    storage_per_gb_month: 0.0,
    billing_basis: 'compressed-ingest',
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
  },
  elasticsearch: {
    destination: 'elasticsearch',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.elasticsearch,
    storage_per_gb_month: 0.05,
    billing_basis: 'indexed-uncompressed',
    compact_mode: 'index-pruned',
    compact_ratio_low: 0.3,
    compact_ratio_high: 0.4,
    small_event_floor_bytes: 100,
  },
  clickhouse: {
    destination: 'clickhouse',
    ingest_per_gb: 0.0,
    storage_per_gb_month: 0.023,
    billing_basis: 'stored-month',
    compact_mode: 'dict-udf-view',
    compact_ratio_low: 0.22,
    compact_ratio_high: 0.3,
    small_event_floor_bytes: 80,
  },
  cloudwatch: {
    destination: 'cloudwatch',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.cloudwatch,
    storage_per_gb_month: 0.03,
    billing_basis: 'compressed-ingest',
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
  },
  'azure-monitor': {
    destination: 'azure-monitor',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB['azure-monitor'],
    storage_per_gb_month: 0.12,
    billing_basis: 'compressed-ingest',
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
  },
  'gcp-logging': {
    destination: 'gcp-logging',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB['gcp-logging'],
    storage_per_gb_month: 0.01,
    billing_basis: 'compressed-ingest',
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
  },
  sumo: {
    destination: 'sumo',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.sumo,
    storage_per_gb_month: 0.02,
    billing_basis: 'compressed-ingest',
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
  },
};

/**
 * Returns the cost model for a destination, with ES-unpruned override.
 *
 * OPEN Q (default chosen, flag for product review): ES-unpruned ratios.
 * Default chosen 0.45-0.55. Pruning detection is the caller's job — read
 * the customer's index template or helm values for `_source.excludes`.
 *
 * @param dest      destination SIEM id
 * @param opts      esPruned: when destination is 'elasticsearch' and this
 *                  is explicitly false, the unpruned ratio band is used.
 */
export function getDestinationCostModel(
  dest: SiemId,
  opts?: { esPruned?: boolean }
): DestinationCostModel {
  const base = COST_MODEL_BY_DESTINATION[dest];
  if (dest === 'elasticsearch' && opts?.esPruned === false) {
    return {
      ...base,
      compact_mode: 'index-unpruned',
      compact_ratio_low: 0.45,
      compact_ratio_high: 0.55,
    };
  }
  return base;
}

/**
 * Below the floor, envelope overhead linearly degrades compact savings:
 * the effective ratio walks from baseRatio (at floor) toward 1.0 (at 0).
 * Above the floor, returns baseRatio unchanged.
 *
 * Exposed for testing; not part of the v1 stable surface.
 */
export function degradeRatioForSmallEvents(
  baseRatio: number,
  avgSize?: number,
  floor = 100
): number {
  if (!avgSize || avgSize >= floor) return baseRatio;
  if (avgSize <= 0) return 1;
  const penalty = (floor - avgSize) / floor; // 0..1
  return Math.min(1, baseRatio + (1 - baseRatio) * penalty);
}

function midpoint(a: number, b: number): number {
  return (a + b) / 2;
}

export interface ProjectActionArgs {
  action: Action;
  bytes_in: number;
  avg_event_size_bytes?: number;
  /** For action='sample', e.g. 10 means keep 1 in 10. Default 10. */
  sample_n?: number;
  destination: SiemId;
  /** Default 1 month. */
  retention_months?: number;
  esPruned?: boolean;
  /**
   * Optional customer-supplied rate overrides. When present, the
   * corresponding rate_source axis flips to 'customer_supplied'. When the
   * destination has no list rate AND no override is supplied, that axis
   * collapses to `null` dollars + `rate_source = 'unset'`.
   */
  customer_rate?: {
    ingest_per_gb_override?: number;
    storage_per_gb_month_override?: number;
  };
}

/**
 * Compute reduction as a 0..100 percent. Always non-negative and clamped to
 * 100. When passBytes is 0, returns 0 (nothing to reduce, no inflation).
 *
 * Scalar form returns the same value across all three confidence axes so
 * callers can splat into a triplet uniformly.
 */
export function percentReduction(
  passBytes: number,
  actionBytes: number | { low: number; expected: number; high: number }
): { low: number; expected: number; high: number } {
  const one = (out: number): number => {
    if (passBytes <= 0) return 0;
    const pct = ((passBytes - out) / passBytes) * 100;
    return Math.max(0, Math.min(100, pct));
  };
  if (typeof actionBytes === 'number') {
    const v = one(actionBytes);
    return { low: v, expected: v, high: v };
  }
  return {
    low: one(actionBytes.low),
    expected: one(actionBytes.expected),
    high: one(actionBytes.high),
  };
}

function projectActionWithRatio(
  args: ProjectActionArgs,
  ratio: number,
  confidence: 'low' | 'expected' | 'high'
): SavingsProjection {
  const model = getDestinationCostModel(args.destination, {
    esPruned: args.esPruned,
  });
  const notes: string[] = [];
  let bytes_out: number;

  switch (args.action) {
    case 'pass':
      bytes_out = args.bytes_in;
      break;
    case 'drop':
      bytes_out = 0;
      break;
    case 'sample': {
      const n = Math.max(1, args.sample_n ?? 10);
      bytes_out = args.bytes_in / n;
      break;
    }
    case 'tier_down':
      // Savings depend on destination-side routing rule (e.g. Splunk index
      // tier swap, Datadog Flex). The bytes leaving the forwarder are
      // unchanged; the caller must swap storage_per_gb_month to the
      // tier-down rate. Default chosen wire format: tenx_action=tier_down.
      bytes_out = args.bytes_in;
      notes.push(
        'tier_down savings depend on destination-side routing rule not yet configured (tenx_action=tier_down)'
      );
      break;
    case 'offload':
      // Destination sees nothing; S3 cost is OUT OF SCOPE here. Caller
      // adds S3 storage separately.
      bytes_out = 0;
      notes.push('offload: S3 archival cost not included in this projection');
      break;
    case 'compact': {
      if (model.compact_mode === 'no-op') {
        bytes_out = args.bytes_in;
        notes.push(`compact not supported on ${args.destination}`);
      } else {
        const effective = degradeRatioForSmallEvents(
          ratio,
          args.avg_event_size_bytes,
          model.small_event_floor_bytes
        );
        bytes_out = args.bytes_in * effective;
        if (
          args.avg_event_size_bytes !== undefined &&
          args.avg_event_size_bytes < model.small_event_floor_bytes
        ) {
          notes.push(
            `avg event size ${args.avg_event_size_bytes}B below floor ${model.small_event_floor_bytes}B; envelope overhead reduces savings`
          );
        }
      }
      break;
    }
  }

  const months = args.retention_months ?? 1;
  const gbOut = bytes_out / GB;

  // Ingest axis: customer override > list rate > unset.
  // model.ingest_per_gb is always a known number in COST_MODEL_BY_DESTINATION
  // (clickhouse self-hosted is genuinely $0, not unknown). 'unset' is
  // reserved for future destinations that come without a list rate.
  const ingestOverride = args.customer_rate?.ingest_per_gb_override;
  let ingest_dollars: number | null;
  let ingestSource: 'list' | 'customer_supplied' | 'unset';
  if (ingestOverride != null) {
    ingest_dollars = gbOut * ingestOverride;
    ingestSource = 'customer_supplied';
  } else if (Number.isFinite(model.ingest_per_gb)) {
    ingest_dollars = gbOut * model.ingest_per_gb;
    ingestSource = 'list';
  } else {
    ingest_dollars = null;
    ingestSource = 'unset';
  }

  // Storage axis: same precedence. storage_per_gb_month == 0 is a legitimate
  // "vendor includes storage" signal (e.g. Datadog), so we emit 0 + 'list'
  // there rather than null.
  const storageOverride = args.customer_rate?.storage_per_gb_month_override;
  let storage_dollars: number | null;
  let storageSource: 'list' | 'customer_supplied' | 'unset';
  if (storageOverride != null) {
    storage_dollars = gbOut * storageOverride * months;
    storageSource = 'customer_supplied';
  } else if (model.storage_per_gb_month >= 0) {
    storage_dollars = gbOut * model.storage_per_gb_month * months;
    storageSource = 'list';
  } else {
    storage_dollars = null;
    storageSource = 'unset';
  }

  // total nulls out if either axis is unset (cannot sum a known and an
  // unknown without misrepresenting the unknown as zero).
  const total_dollars =
    ingest_dollars == null || storage_dollars == null
      ? null
      : ingest_dollars + storage_dollars;

  const pct = percentReduction(args.bytes_in, bytes_out).expected;

  return {
    bytes_in: args.bytes_in,
    bytes_out,
    ingest_dollars,
    storage_dollars,
    total_dollars,
    basis: model.billing_basis,
    confidence,
    percent_reduction: pct,
    rate_source: { ingest: ingestSource, storage: storageSource },
    notes: notes.length ? notes : undefined,
  };
}

/**
 * Project the destination cost of one (action, bytes_in) pair using the
 * expected (mid-band) compact ratio for the destination.
 *
 * Examples:
 *   projectAction({ action:'compact', bytes_in:1e9, destination:'splunk' })
 *     → total_dollars ≈ 1.0 * 6 * 0.115 ≈ $0.69 (i.e. ~88.5% savings on $6).
 *   projectAction({ action:'compact', bytes_in:1e9, destination:'datadog' })
 *     → bytes_out === bytes_in, notes includes
 *       'compact not supported on datadog'.
 */
export function projectAction(args: ProjectActionArgs): SavingsProjection {
  const model = getDestinationCostModel(args.destination, {
    esPruned: args.esPruned,
  });
  const ratio = midpoint(model.compact_ratio_low, model.compact_ratio_high);
  return projectActionWithRatio(args, ratio, 'expected');
}

/**
 * Project low / expected / high savings using the destination's compact
 * ratio uncertainty band. All three legs are degraded by the small-event
 * curve when avg_event_size_bytes is supplied.
 *
 * 'low'  = least savings  = compact_ratio_high (more bytes through)
 * 'high' = most savings   = compact_ratio_low  (fewer bytes through)
 */
export function projectActionRange(args: ProjectActionArgs): {
  low: SavingsProjection;
  expected: SavingsProjection;
  high: SavingsProjection;
  percent_reduction_low: number;
  percent_reduction_expected: number;
  percent_reduction_high: number;
  rate_source: SavingsProjection['rate_source'];
} {
  const model = getDestinationCostModel(args.destination, {
    esPruned: args.esPruned,
  });
  const low = projectActionWithRatio(args, model.compact_ratio_high, 'low');
  const expected = projectActionWithRatio(
    args,
    midpoint(model.compact_ratio_low, model.compact_ratio_high),
    'expected'
  );
  const high = projectActionWithRatio(args, model.compact_ratio_low, 'high');
  const pct = percentReduction(args.bytes_in, {
    // 'high' compact ratio means MORE bytes through, i.e. LESS reduction —
    // so percent_reduction_low pairs with the 'low' projection (which itself
    // was built from the high ratio). Naming stays consistent: _low = worst
    // case savings, _high = best case savings.
    low: low.bytes_out,
    expected: expected.bytes_out,
    high: high.bytes_out,
  });
  return {
    low,
    expected,
    high,
    percent_reduction_low: pct.low,
    percent_reduction_expected: pct.expected,
    percent_reduction_high: pct.high,
    // Hoist from expected — all three axes share the same rate_source by
    // construction (same customer_rate + same destination).
    rate_source: expected.rate_source,
  };
}

/**
 * Percent-first headline wrapper around projectActionRange.
 *
 * Threads `effective_ingest_per_gb` (if supplied) through as an ingest
 * override on the underlying projection. Top-level `rate_source` collapses
 * the per-axis sources into a single tag callers can render:
 *  - 'customer_supplied' if any axis was overridden
 *  - 'list_price' if any axis used the vendor list rate (and none was
 *    overridden)
 *  - 'unset' if neither axis has a rate at all
 *
 * Both `dollars.list_*` and `dollars.customer_*` can be populated in mixed
 * cases (e.g. customer overrides ingest only; storage still on list).
 */
export function projectSavings(
  args: ProjectActionArgs & { effective_ingest_per_gb?: number }
): SavingsHeadline {
  const merged: ProjectActionArgs = {
    ...args,
    customer_rate: {
      ...args.customer_rate,
      ingest_per_gb_override:
        args.customer_rate?.ingest_per_gb_override ??
        args.effective_ingest_per_gb,
    },
  };

  const range = projectActionRange(merged);
  const rs = range.rate_source;

  let top: SavingsHeadline['rate_source'];
  if (rs.ingest === 'customer_supplied' || rs.storage === 'customer_supplied') {
    top = 'customer_supplied';
  } else if (rs.ingest === 'list' || rs.storage === 'list') {
    top = 'list_price';
  } else {
    top = 'unset';
  }

  const headline: SavingsHeadline = {
    percent: {
      low: range.percent_reduction_low,
      expected: range.percent_reduction_expected,
      high: range.percent_reduction_high,
    },
    bytes: {
      in: args.bytes_in,
      out_expected: range.expected.bytes_out,
    },
    rate_source: top,
    range: { low: range.low, expected: range.expected, high: range.high },
  };

  if (top !== 'unset') {
    const dollars: NonNullable<SavingsHeadline['dollars']> = {};
    const anyList = rs.ingest === 'list' || rs.storage === 'list';
    const anyCustomer =
      rs.ingest === 'customer_supplied' || rs.storage === 'customer_supplied';
    if (anyList) {
      // For the list-rate view we re-project without the override so callers
      // see the unblended list-only total.
      const listOnly = projectActionRange({
        ...args,
        customer_rate: undefined,
      });
      dollars.list_low = listOnly.low.total_dollars ?? undefined;
      dollars.list_expected = listOnly.expected.total_dollars ?? undefined;
      dollars.list_high = listOnly.high.total_dollars ?? undefined;
    }
    if (anyCustomer) {
      dollars.customer_low = range.low.total_dollars ?? undefined;
      dollars.customer_expected = range.expected.total_dollars ?? undefined;
      dollars.customer_high = range.high.total_dollars ?? undefined;
    }
    headline.dollars = dollars;
  }

  return headline;
}

/**
 * Annualize a window of dollars: e.g. 7-day spend × 365/7.
 * Returns 0 if windowDays <= 0.
 */
export function annualizeDollars(windowDollars: number, windowDays: number): number {
  if (!windowDays || windowDays <= 0) return 0;
  return (windowDollars * 365) / windowDays;
}
