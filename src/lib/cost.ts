/**
 * Cost calculation helpers.
 *
 * Two layers:
 *   - Back-compat layer (bytesToCost, bytesToGb, parsePrometheusValue):
 *     unchanged signatures, used by existing tools (savings, top-patterns,
 *     event-lookup, trend, services, investigate, etc).
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
import { DEFAULT_ANALYZER_COST_PER_GB, SIEM_DISPLAY_NAMES } from './siem/pricing.js';

// GB = 10^9 bytes (decimal). This is the unit CloudWatch / Datadog /
// Splunk / Azure Monitor / GCP Logging / Sumo all bill in, so dollar
// math here matches the customer's invoice. Using GiB (2^30) under a
// `$/GB` label silently understates spend by ~6.87%, so this constant
// is decimal GB.
const GB = 1_000_000_000;

// Customer-owned object-store (S3) standard storage rate, $/GB-month. Used to
// NET the `offload` action: offloaded bytes leave the SIEM entirely (full byte
// saving) but do not vanish: the customer still pays to store them in their
// own bucket. ~$0.023/GB-mo is S3 Standard; cheaper tiers (S3-IA ~$0.0125,
// Glacier Instant ~$0.004) apply when the offload bucket uses them, overridable
// via customer_rate.s3_per_gb_month_override. Without netting this, offload
// reads as a free win and the compact-vs-offload comparison is rigged toward it.
export const S3_STORAGE_PER_GB_MONTH = 0.023;

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

/**
 * Cheaper storage/ingest tier that tier_down routes events to.
 * When present in a destination's cost model, projectActionWithRatio can
 * compute meaningful dollar savings for tier_down (rather than returning
 * zero with a caveat about "rule not yet configured").
 */
export interface TierDownTargetTier {
  /** Human-readable tier name, e.g. "CloudWatch Logs Infrequent Access". */
  name: string;
  /** Cheaper ingest rate for this tier ($/GB). */
  ingest_rate_usd_per_gb: number;
  /** Cheaper storage rate for this tier ($/GB-month). */
  storage_rate_usd_per_gb_month: number;
}

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
  /**
   * Cheaper tier that tier_down can route events to. When present,
   * tier_down savings are computed as the delta between standard and tier
   * rates. When absent, tier_down produces bytes_out=bytes_in with a caveat.
   */
  tier_down_target_tier?: TierDownTargetTier;
}

/**
 * Provenance tag for any dollar value the pipeline emits.
 *  - 'list_price'        — derived from vendor list $/GB (lib/siem/pricing).
 *  - 'customer_supplied' — caller passed an explicit override rate.
 *  - 'unset'             — no rate available; value is a placeholder (0/null).
 */
export type DollarSource = 'list_price' | 'customer_supplied' | 'unset';

/**
 * Envelope shape that every dollar field in an envelope MUST use.
 *
 * The plain-English `disclosure` rides alongside `value` so renderers cannot
 * print a list-price number without the "may differ depending on discounts,
 * commits, or contract tier" caveat. `disclosure` is null only when the rate
 * came from the customer (no caveat needed).
 */
export interface DisclosedDollarValue {
  value: number;
  source: DollarSource;
  /** Plain-English disclosure. null iff source === 'customer_supplied'. */
  disclosure: string | null;
}

/**
 * Build a DisclosedDollarValue. Single source-of-truth constructor — renderers
 * NEVER inline an object literal of this shape.
 *
 *  - source='customer_supplied' → disclosure=null (caller owns the rate).
 *  - source='unset'             → disclosure='(no $/GB rate configured)'.
 *  - source='list_price'        → disclosure carries the SIEM label + list
 *                                 rate + "may differ" caveat.
 */
export function buildDisclosedDollarValue(
  value: number,
  source: DollarSource,
  siemLabel: string | null,
  listRatePerGb: number | null,
): DisclosedDollarValue {
  if (source === 'customer_supplied') {
    return { value, source, disclosure: null };
  }
  if (source === 'unset') {
    return { value, source, disclosure: '(no $/GB rate configured — set `analyzerCost` in your env config or pass `effective_ingest_per_gb`)' };
  }
  const siem = siemLabel ?? 'SIEM';
  const rate = listRatePerGb != null ? `$${listRatePerGb.toFixed(2)}/GB` : 'list price';
  return {
    value,
    source,
    disclosure: `(at ${siem} list price ${rate} — your actual bill may differ depending on discounts, commits, or contract tier. To use your real rate, set \`analyzerCost\` in your env config or pass \`effective_ingest_per_gb\`.)`,
  };
}

/** Internal alias used during the migration. Renderers should call buildDisclosedDollarValue. */
export const makeDisclosedDollar = buildDisclosedDollarValue;

export interface SavingsProjection {
  bytes_in: number;
  /** Post-action bytes leaving forwarder toward destination. */
  bytes_out: number;
  ingest_dollars: number | null;
  /** For the retention window the caller supplies (default 1 month). */
  storage_dollars: number | null;
  total_dollars: number | null;
  /**
   * For `offload` only: the residual cost the customer pays to store the
   * offloaded bytes in their own object store ($/window). 0 for every other
   * action. Already NETTED into total_dollars, so savings = baseline - total is
   * net of S3. Surfaced separately so renderers can show "saved $X (net of $Y
   * S3 storage)".
   */
  s3_storage_dollars?: number;
  /** Disclosed-value mirror of total_dollars. Always populated when total_dollars is non-null. */
  total_dollars_disclosed?: DisclosedDollarValue | null;
  /** Disclosed-value mirror of ingest_dollars. */
  ingest_dollars_disclosed?: DisclosedDollarValue | null;
  /** Disclosed-value mirror of storage_dollars. */
  storage_dollars_disclosed?: DisclosedDollarValue | null;
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
  /**
   * Disclosed-value mirror of `dollars`. Every numeric cell above is also
   * available here wrapped in DisclosedDollarValue so renderers can call
   * fmtDisclosedDollar without re-resolving rate_source + listRate.
   */
  dollars_disclosed?: {
    list_low?: DisclosedDollarValue;
    list_expected?: DisclosedDollarValue;
    list_high?: DisclosedDollarValue;
    customer_low?: DisclosedDollarValue;
    customer_expected?: DisclosedDollarValue;
    customer_high?: DisclosedDollarValue;
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
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.cloudwatch, // $0.50/GB standard tier
    storage_per_gb_month: 0.03, // standard tier
    billing_basis: 'compressed-ingest',
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
    // CloudWatch Logs Infrequent Access (IA) tier:
    // $0.25/GB ingest (50% reduction vs standard $0.50)
    // $0.0075/GB-month storage (75% reduction vs standard $0.03)
    // Destination-side routing rule required (keyed on the routeState marker)
    tier_down_target_tier: {
      name: 'CloudWatch Logs Infrequent Access',
      ingest_rate_usd_per_gb: 0.25,
      storage_rate_usd_per_gb_month: 0.0075,
    },
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

// ---------------------------------------------------------------------------
// PER-DESTINATION DEFAULT ACTION HIERARCHY
//
// Where COST_MODEL_BY_DESTINATION answers "what does compact look like on
// this destination", this table answers the prior question: "if no
// per-pattern override applies, what is the *first* cost-reduction lever to
// pull on this destination, and what is the level-2 fallback if level-1 is
// unavailable?"
//
// The hierarchy comes from the cost-cutting product shape:
//   - Datadog:                tier_down (Flex)  → offload
//   - CloudWatch:             tier_down (IA)    → offload
//   - Splunk Cloud / Ent:     offload           → compact (if 10x app installable)
//   - Elasticsearch self / OpenSearch self:
//                             offload           → compact (if 10x plugin installable)
//   - Elasticsearch managed / OpenSearch managed:
//                             offload                  (no compact on managed)
//   - ClickHouse:             compact (CH UDF)  → offload
//   - Sumo / NewRelic / Honeycomb / Grafana Cloud Logs / Loki:
//                             offload                  (no level-2)
//   - generic / unknown:      offload                  (safe fallback)
//
// Keyspace is wider than SiemId because the action hierarchy splits
// `elasticsearch` into self-managed vs managed (only the self path can run
// the 10x plugin). Callers that hold a SiemId pass it directly — it lands
// in the same table.
// ---------------------------------------------------------------------------

/** Stable identity for the action-hierarchy table. Superset of SiemId. */
export type DestinationKey =
  | SiemId
  | 'splunk_cloud'
  | 'elasticsearch_self'
  | 'elasticsearch_managed'
  | 'opensearch_self'
  | 'opensearch_managed'
  | 'newrelic'
  | 'honeycomb'
  | 'grafana_cloud_logs'
  | 'loki'
  | 'generic';

export const DEFAULT_ACTION_BY_DESTINATION: Record<DestinationKey, Action[]> = {
  // SIEM-billed analyzers with cheap-tier in-platform options.
  datadog: ['tier_down', 'offload'],
  cloudwatch: ['tier_down', 'offload'],
  // Splunk: 10x envelope-compact app installable on both Cloud and Enterprise.
  splunk: ['offload', 'compact'],
  splunk_cloud: ['offload', 'compact'],
  // Self-hosted ES/OS can run the 10x plugin; managed offerings cannot.
  elasticsearch: ['offload', 'compact'], // back-compat default = self-hosted assumption
  elasticsearch_self: ['offload', 'compact'],
  elasticsearch_managed: ['offload'],
  opensearch_self: ['offload', 'compact'],
  opensearch_managed: ['offload'],
  // ClickHouse: the dict+UDF+view compact path is the level-1 lever (PoC: 70-78%).
  clickhouse: ['compact', 'offload'],
  // Single-lever destinations.
  sumo: ['offload'],
  newrelic: ['offload'],
  honeycomb: ['offload'],
  grafana_cloud_logs: ['offload'],
  loki: ['offload'],
  // Map the remaining SiemId entries to the safe single-lever default. These
  // sit at the bottom because the table is keyed by the wider DestinationKey
  // and TypeScript requires every key to be present.
  'azure-monitor': ['offload'],
  'gcp-logging': ['offload'],
  generic: ['offload'],
};

/**
 * Return the destination's preferred action at the given level (1-based).
 * Level 1 = first lever to pull; level 2 = fallback when level-1 is
 * unavailable. Unknown destinations and out-of-range levels fall back to
 * 'offload' (the safe single-lever default).
 */
export function getDefaultActionForDestination(
  destination: string,
  level: number = 1
): Action {
  const list = DEFAULT_ACTION_BY_DESTINATION[destination as DestinationKey]
    ?? DEFAULT_ACTION_BY_DESTINATION.generic;
  const idx = Math.max(1, level) - 1;
  return list[idx] ?? list[list.length - 1] ?? 'offload';
}

/**
 * Return the full ordered hierarchy of allowed default actions for a
 * destination. Used by the offload-section renderer to gate which
 * down-tier / compact sub-sections are relevant (e.g. Datadog Flex only
 * shows when 'tier_down' is allowed on 'datadog').
 */
export function getAllowedActionsForDestination(destination: string): Action[] {
  return DEFAULT_ACTION_BY_DESTINATION[destination as DestinationKey]
    ?? DEFAULT_ACTION_BY_DESTINATION.generic;
}

/**
 * Returns the cost model for a destination, with ES-unpruned override.
 *
 * ES-unpruned ratios default to the 0.45-0.55 band. Pruning detection is
 * the caller's job: read the customer's index template or helm values for
 * `_source.excludes`.
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
    /**
     * Customer's offload-bucket storage rate ($/GB-month) used to net the
     * `offload` action. Defaults to S3 Standard (S3_STORAGE_PER_GB_MONTH) when
     * absent. Pass the cheaper tier (IA / Glacier) when the offload bucket uses
     * it.
     */
    s3_per_gb_month_override?: number;
  };
  /**
   * Measured per-service compact ratio (optimized_bytes / input_bytes, in
   * [0.02, 1.0]) from the engine's own `emitted_events_optimized_size_total`.
   * When present AND the destination compacts in `envelope` mode (Splunk,
   * where the on-wire encoded size IS the billed size), this replaces the
   * static destination band for action='compact' so the projection reflects
   * the service's real compressibility instead of a destination-wide guess.
   * Ignored on index-pruned (ES) / dict-udf-view (ClickHouse) destinations,
   * where the wire ratio diverges from the billed index/stored size; those
   * keep the static band for the dollar projection. The value already
   * reflects realized small-event overhead, so it is NOT re-degraded.
   */
  compact_ratio_override?: number;
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
      // Bytes leaving the forwarder are unchanged (events still reach the
      // SIEM; only the storage/ingest tier changes). Savings come from the
      // rate delta between standard and the cheaper destination tier.
      // When tier_down_target_tier is defined in the cost model we compute
      // the dollar delta below by substituting the tier rates. bytes_out is
      // still set to bytes_in so the byte-reduction fields reflect 0 — the
      // savings are entirely in the rate axis, not the byte axis.
      bytes_out = args.bytes_in;
      if (model.tier_down_target_tier) {
        notes.push(
          `tier_down: assumes ${model.tier_down_target_tier.name} ($${model.tier_down_target_tier.ingest_rate_usd_per_gb}/GB ingest + $${model.tier_down_target_tier.storage_rate_usd_per_gb_month}/GB-mo storage); destination-side routing rule must be configured to realize.`
        );
      } else {
        notes.push(
          'tier_down savings depend on a destination-side routing rule (keyed on the routeState marker) and cheaper tier pricing not configured for this destination'
        );
      }
      break;
    case 'offload':
      // Destination sees nothing (full byte saving), but the bytes do not
      // vanish: they land in the customer's own object store. The S3 storage
      // cost is netted into total_dollars below (savings = SIEM cost - S3
      // cost), so offload is no longer modeled as a free win. The explanatory
      // note is pushed after the S3 dollar is computed.
      bytes_out = 0;
      break;
    case 'compact': {
      if (model.compact_mode === 'no-op') {
        bytes_out = args.bytes_in;
        notes.push(`compact not supported on ${args.destination}`);
      } else if (
        args.compact_ratio_override !== undefined &&
        args.compact_ratio_override >= 0.02 &&
        args.compact_ratio_override <= 1.0 &&
        model.compact_mode === 'envelope'
      ) {
        // Measured per-service ratio on an envelope destination (Splunk):
        // the on-wire encoded size IS the billed size, so use the real
        // measurement directly. It already reflects small-event overhead,
        // so we do NOT re-degrade. The low/expected/high band collapses to
        // this single value across all three legs (no modeled uncertainty).
        bytes_out = args.bytes_in * args.compact_ratio_override;
        notes.push(
          `compact ratio ${args.compact_ratio_override.toFixed(3)} measured from emitted_events_optimized_size_total`
        );
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

  // For tier_down: when the cost model has a tier_down_target_tier, use
  // the cheaper tier's rates rather than the standard model rates. This
  // makes the dollar cost represent what the SIEM bills after routing to
  // the IA/Flex tier — so savings = standard_cost - tier_down_cost.
  // When no tier_down_target_tier is present, fall through to standard rates
  // (which will produce zero savings since bytes_out == bytes_in at the same rate).
  const isTierDown = args.action === 'tier_down';
  const tierTarget = isTierDown ? model.tier_down_target_tier : undefined;
  const effectiveIngestRateList = tierTarget
    ? tierTarget.ingest_rate_usd_per_gb
    : model.ingest_per_gb;
  const effectiveStorageRateList = tierTarget
    ? tierTarget.storage_rate_usd_per_gb_month
    : model.storage_per_gb_month;

  // Ingest axis: customer override > list rate (effective for tier) > unset.
  // model.ingest_per_gb is always a known number in COST_MODEL_BY_DESTINATION
  // (clickhouse self-hosted is genuinely $0, not unknown). 'unset' is
  // reserved for future destinations that come without a list rate.
  const ingestOverride = args.customer_rate?.ingest_per_gb_override;
  let ingest_dollars: number | null;
  let ingestSource: 'list' | 'customer_supplied' | 'unset';
  if (ingestOverride != null) {
    // For tier_down with a customer override we scale the override by the
    // same ratio as the tier discount so customer-rate savings are proportional.
    const tierScaleFactor =
      isTierDown && tierTarget && model.ingest_per_gb > 0
        ? tierTarget.ingest_rate_usd_per_gb / model.ingest_per_gb
        : 1;
    ingest_dollars = gbOut * ingestOverride * tierScaleFactor;
    ingestSource = 'customer_supplied';
  } else if (Number.isFinite(effectiveIngestRateList)) {
    ingest_dollars = gbOut * effectiveIngestRateList;
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
    const tierScaleFactor =
      isTierDown && tierTarget && model.storage_per_gb_month > 0
        ? tierTarget.storage_rate_usd_per_gb_month / model.storage_per_gb_month
        : 1;
    storage_dollars = gbOut * storageOverride * tierScaleFactor * months;
    storageSource = 'customer_supplied';
  } else if (effectiveStorageRateList >= 0) {
    storage_dollars = gbOut * effectiveStorageRateList * months;
    storageSource = 'list';
  } else {
    storage_dollars = null;
    storageSource = 'unset';
  }

  // offload: net the customer's residual object-store cost. The bytes left the
  // SIEM (bytes_out=0 -> ingest+storage = 0 above) but the customer still pays
  // to store them in their own bucket. Netting here makes downstream savings =
  // SIEM cost - S3 cost instead of a gross "free win".
  const s3RatePerGbMonth =
    args.customer_rate?.s3_per_gb_month_override ?? S3_STORAGE_PER_GB_MONTH;
  const s3_storage_dollars =
    args.action === 'offload' ? (args.bytes_in / GB) * s3RatePerGbMonth * months : 0;
  if (args.action === 'offload') {
    notes.push(
      `offload: net of ~$${s3_storage_dollars.toFixed(2)} customer S3 storage (${months}mo at $${s3RatePerGbMonth}/GB-mo); bytes leave the SIEM in full.`
    );
  }

  // total nulls out if either axis is unset (cannot sum a known and an
  // unknown without misrepresenting the unknown as zero). The S3 residual (0
  // for non-offload) is added so total_dollars is the customer's real cost
  // after the action.
  const total_dollars =
    ingest_dollars == null || storage_dollars == null
      ? null
      : ingest_dollars + storage_dollars + s3_storage_dollars;

  const pct = percentReduction(args.bytes_in, bytes_out).expected;

  // Build disclosed-value mirrors so renderers can call fmtDisclosedDollar
  // directly without rediscovering rate provenance.
  const siemLabel = SIEM_DISPLAY_NAMES[args.destination] ?? null;
  // For disclosure: use the effective (tier-aware) list rate, not the
  // standard model rate, so the caveat string quotes the actual rate used.
  const ingestRate = ingestOverride != null
    ? ingestOverride
    : (Number.isFinite(effectiveIngestRateList) ? effectiveIngestRateList : null);
  const storageRate = storageOverride != null
    ? storageOverride
    : (effectiveStorageRateList >= 0 ? effectiveStorageRateList : null);
  const toAxisSource = (s: 'list' | 'customer_supplied' | 'unset'): DollarSource =>
    s === 'list' ? 'list_price' : s;
  const ingest_dollars_disclosed = ingest_dollars == null
    ? null
    : buildDisclosedDollarValue(ingest_dollars, toAxisSource(ingestSource), siemLabel, ingestRate);
  const storage_dollars_disclosed = storage_dollars == null
    ? null
    : buildDisclosedDollarValue(storage_dollars, toAxisSource(storageSource), siemLabel, storageRate);
  // Total picks the strongest axis-provenance: if either axis is customer the
  // total is customer-supplied (no caveat); else list_price if both are list;
  // else unset.
  let totalSource: DollarSource;
  if (ingestSource === 'customer_supplied' || storageSource === 'customer_supplied') {
    totalSource = 'customer_supplied';
  } else if (ingestSource === 'list' && storageSource === 'list') {
    totalSource = 'list_price';
  } else if (ingestSource === 'list' || storageSource === 'list') {
    totalSource = 'list_price';
  } else {
    totalSource = 'unset';
  }
  const total_dollars_disclosed = total_dollars == null
    ? null
    : buildDisclosedDollarValue(total_dollars, totalSource, siemLabel, null);

  return {
    bytes_in: args.bytes_in,
    bytes_out,
    ingest_dollars,
    storage_dollars,
    total_dollars,
    s3_storage_dollars,
    ingest_dollars_disclosed,
    storage_dollars_disclosed,
    total_dollars_disclosed,
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
    const dollars_disclosed: NonNullable<SavingsHeadline['dollars_disclosed']> = {};
    const siemLabel = SIEM_DISPLAY_NAMES[args.destination] ?? null;
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
      if (listOnly.low.total_dollars != null) {
        dollars_disclosed.list_low =
          buildDisclosedDollarValue(listOnly.low.total_dollars, 'list_price', siemLabel, null);
      }
      if (listOnly.expected.total_dollars != null) {
        dollars_disclosed.list_expected =
          buildDisclosedDollarValue(listOnly.expected.total_dollars, 'list_price', siemLabel, null);
      }
      if (listOnly.high.total_dollars != null) {
        dollars_disclosed.list_high =
          buildDisclosedDollarValue(listOnly.high.total_dollars, 'list_price', siemLabel, null);
      }
    }
    if (anyCustomer) {
      dollars.customer_low = range.low.total_dollars ?? undefined;
      dollars.customer_expected = range.expected.total_dollars ?? undefined;
      dollars.customer_high = range.high.total_dollars ?? undefined;
      if (range.low.total_dollars != null) {
        dollars_disclosed.customer_low =
          buildDisclosedDollarValue(range.low.total_dollars, 'customer_supplied', siemLabel, null);
      }
      if (range.expected.total_dollars != null) {
        dollars_disclosed.customer_expected =
          buildDisclosedDollarValue(range.expected.total_dollars, 'customer_supplied', siemLabel, null);
      }
      if (range.high.total_dollars != null) {
        dollars_disclosed.customer_high =
          buildDisclosedDollarValue(range.high.total_dollars, 'customer_supplied', siemLabel, null);
      }
    }
    headline.dollars = dollars;
    headline.dollars_disclosed = dollars_disclosed;
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
