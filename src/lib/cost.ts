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
 * Compact-ratio numbers come from the ES/Splunk PoC findings:
 *   - Elasticsearch pruned (compactable fields excluded from _source):
 *     45-73% reduction range. Modeled as compact_ratio 0.30..0.40.
 *   - Elasticsearch unpruned: ~45-55% post/pre. Returned via
 *     getDestinationCostModel(dest, {esPruned:false}).
 *   - Splunk envelope-in-event: ~92% reduction on the OUTER stream.
 *     Modeled as 0.08..0.15.
 *   - Datadog/CW/Azure/GCP/Sumo/Coralogix/ClickHouse: no-op. compact_ratio =
 *     1.0..1.0; a caveat is emitted by callers. On ClickHouse the reason is
 *     measured rather than structural: the text index and the column codecs
 *     already absorb almost all of it, so compaction moves about 7% of table
 *     bytes, and table bytes are not where a ClickHouse bill lives. The lever
 *     there is rows that never enter, priced through the `compute` term below.
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
 *  - envelope:       Splunk-style encode-in-event; query-time expand.
 *  - index-pruned:   ES with `_source.excludes` of compactable fields.
 *  - index-unpruned: ES without pruning (savings come from value-level
 *                    rewrite, not index pruning).
 */
export type CompactMode =
  | 'no-op'
  | 'envelope'
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

/**
 * A destination whose bill is COMPUTE, not bytes accepted or bytes stored.
 *
 * ClickHouse is the only one modeled this way. Its storage line is small and
 * its ingest line is zero, so pricing it on bytes alone reads as if the bill
 * were somewhere it is not. What moves a ClickHouse bill is rows that never
 * enter: insert and merge CPU follows row count, faster than linearly, because
 * a row never written is not paid for once and is not paid for again on every
 * merge that would have carried it.
 *
 * `curve` maps rows KEPT (as a fraction of what arrives today) to insert-plus-
 * merge CPU as a fraction of today's. Points are measured; between them this
 * model interpolates linearly and nothing else.
 *
 * Compute is bought in whole units within the autoscaler's bounds, so a CPU
 * drop is worth nothing until a whole unit can go, and never below the floor.
 * `unit_step` and `min_units` carry that.
 */
export interface DestinationComputeTerm {
  /** What the CPU curve is indexed on. Rows inserted is the only measured one. */
  basis: 'rows-inserted';
  /** List price of one compute unit, $/hour. */
  unit_usd_per_hour: number;
  /** True when the platform bills whole units (round up), not fractions. */
  unit_step: boolean;
  /** Lowest unit count the service can run at. Never billed below this. */
  min_units: number;
  /**
   * [rowsKeptFraction, cpuFraction] points, ascending by rowsKeptFraction.
   * Endpoints at 0 and 1 are required so every input is bracketed.
   */
  curve: Array<[number, number]>;
}

/** What a compute term says about one action, on one estate. */
export interface ComputeSavingProjection {
  basis: 'rows-inserted';
  /** Rows still inserted after the action, as a fraction of today's rows. */
  rows_kept_fraction: number;
  /** Insert-plus-merge CPU after the action, as a fraction of today's. */
  cpu_fraction: number;
  /**
   * Compute units billed before and after, whole units, floored at min_units.
   * Present only when the caller supplied current units or a monthly spend.
   */
  units_before?: number;
  units_after?: number;
  /** (units_before - units_after) x unit_usd_per_hour x 730. */
  saving_usd_month?: number;
  /**
   * Share of today's compute bill this action removes. When units are known
   * this is (units_before - units_after) / units_before, which is the stepped
   * answer and can be 0 at the floor. When they are not, it is 1 - cpu_fraction,
   * which is the unstepped shape of the curve and nothing more.
   */
  saving_fraction: number;
  /** Always true. No ClickHouse compute dollar in this codebase is measured on the customer's estate. */
  modeled: true;
  note: string;
}

export interface DestinationCostModel {
  destination: SiemId;
  /** $/GB billed at ingest. */
  ingest_per_gb: number;
  /**
   * How to LABEL ingest_per_gb when quoting the model to a human. Default
   * 'ingest'. Datadog is 'all-in': its real ingest meter is ~$0.10/GB and the
   * money is per-million-event indexing, so the $2.50 figure is a blend —
   * calling that blend "ingest" reads as not knowing the platform.
   */
  ingest_label?: string;
  /** $/GB-month billed for retention. */
  storage_per_gb_month: number;
  billing_basis: BillingBasis;
  compact_mode: CompactMode;
  /**
   * What the customer must have for compact to be real here — the app, plugin,
   * or view that expands compacted events again, with its platform and version
   * constraint. Rendered on any plan that prices compact: a lever whose
   * prerequisite is unstated is a lever we are guessing at.
   */
  compact_requires?: string;
  /** Same contract for tier_down: the tier, and what enables it. */
  tier_down_requires?: string;
  /**
   * Why compact is not offered here, when the reason is NOT "the destination
   * cannot accept encoded events". Serverless-style platforms accept them
   * happily and have nowhere to install an expander, which would leave the
   * customer with unreadable events — not a keep-everything lever.
   */
  compact_unavailable_reason?: string;
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
  /**
   * Additional cheaper tiers the destination offers beyond the default
   * tier_down_target_tier, in order of increasing aggression. The engine is
   * unaware of which one a deployment uses: the MCP picks the target plan when
   * it generates the forwarder recipe, and every tier_down event for that
   * deployment lands in that one chosen plan (no per-pattern split). Consumed by
   * the offload recipe generator (renderOffloadSection), which emits a
   * provisioning recipe per plan (the default tier_down_target_tier plus each
   * alternative here). estimate_savings prices the default target tier; pricing a
   * caller-selected alternative is a planned follow-up. Example (Azure): default
   * = Basic Logs; alt = [Auxiliary Logs].
   */
  tier_down_alt_tiers?: TierDownTargetTier[];
  /**
   * Present only where the bill is compute rather than bytes. ClickHouse only.
   * Do not add one to a destination that bills per GB accepted or per GB
   * stored: there the byte projection already IS the bill, and a compute term
   * would double-count it.
   */
  compute?: DestinationComputeTerm;
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
  /**
   * Present only on a destination with a `compute` term (ClickHouse), and only
   * for the actions that keep rows out of the cluster: offload, drop, sample.
   * The byte axis above still carries the storage saving; this carries the
   * compute one, which is the larger number and the modeled one.
   */
  compute_saving?: ComputeSavingProjection;
  /**
   * True when any dollar on this projection rests on a model rather than on the
   * destination's own meter. Set on every ClickHouse projection, because the
   * compute term is a curve fitted to one capture and a unit floor that is
   * ASSUMED. Renderers must carry the word "modeled" wherever they print these.
   */
  modeled?: boolean;
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
    compact_requires: 'the 10x Splunk app installed (it auto-expands compacted events at search time)',
    compact_ratio_low: 0.08,
    compact_ratio_high: 0.15,
    small_event_floor_bytes: 100,
  },
  datadog: {
    destination: 'datadog',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.datadog,
    // The $2.50 is the canonical ALL-IN blend (real ingest meter is ~$0.10/GB;
    // the money is per-M-event indexing). Label it honestly when quoted.
    ingest_label: 'all-in',
    storage_per_gb_month: 0.0,
    billing_basis: 'compressed-ingest',
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
    // Datadog Flex Logs — the cheaper, still-searchable tier tier_down routes to.
    // Without this, tier_down had no cheaper tier to price against and returned
    // $0 saving on Datadog, the destination whose whole tier_down story IS Flex.
    // $1.00/GB is standard $2.50 × 0.40, i.e. the canonical conservative
    // tier_down cost-delta of 0.60 (poc-envelope-v2 reducibility coefficients).
    // Datadog bills on ingest, not separate storage, so the delta is all ingest.
    tier_down_target_tier: {
      name: 'Datadog Flex Logs',
      ingest_rate_usd_per_gb: 1.0,
      storage_rate_usd_per_gb_month: 0.0,
    },
  },
  elasticsearch: {
    destination: 'elasticsearch',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.elasticsearch,
    storage_per_gb_month: 0.05,
    billing_basis: 'indexed-uncompressed',
    // compact_mode describes the MECHANISM (encoded events shrink the _source
    // footprint ES bills on). Whether it is AVAILABLE depends on the
    // deployment: the l1es plugin installs on self-managed nodes only, and is
    // built against specific versions. So this generic key does not offer
    // compact — a confirmed `deployment: 'self_managed'` does. Ask which
    // deployment before pricing compact on Elasticsearch.
    compact_mode: 'index-pruned',
    compact_requires:
      'the l1es plugin installed on your nodes, which auto-expands compacted events at query time (self-managed Elasticsearch 8.17.0; OpenSearch 2.19.0)',
    tier_down_requires:
      'frozen searchable snapshots — an Enterprise licence self-managed, or Gold+ on Elastic Cloud Hosted',
    compact_ratio_low: 0.3,
    compact_ratio_high: 0.4,
    small_event_floor_bytes: 100,
    // Frozen tier via searchable snapshots. On Elastic Cloud Hosted the
    // marked slice routes to its own index, ILM mounts it as
    // partial-<index> on the data_frozen node, and the index drops to
    // store=0b local while a hot control stays at 19.2kb. Critically,
    // identity SURVIVES the transition -- a term query on
    // tenx_hash returned 400/400 and routeState stayed aggregatable -- so the
    // down-tiered slice is still retrievable, not merely cheap.
    //
    // RATE DERIVATION, stated because it is weaker than the mechanism. Elastic
    // publishes frozen at roughly one fifth to one tenth of hot. This model
    // takes the CONSERVATIVE end (1/5) of a blended $1/GB, giving $0.20. That blend is
    // a vendors.json infrastructure figure, not a list price, so treat the
    // ratio as sound and the absolute as an estimate; override with
    // analyzer_cost_per_gb for a known deployment.
    //
    // ON ELASTIC CLOUD HOSTED THE SAVING IS NOT AUTOMATIC. Hosted is priced by
    // provisioned resources, so moving data out of hot creates HEADROOM; the
    // deployment still has to be resized to bank it. That is unlike Coralogix,
    // where the policy changed the billed rate on its own. Callers must say so.
    tier_down_target_tier: {
      name: 'Elasticsearch frozen tier (searchable snapshots)',
      ingest_rate_usd_per_gb: 0.2,
      storage_rate_usd_per_gb_month: 0.01,
    },
  },
  // Elastic Cloud Serverless. Split out from `elasticsearch` because the two
  // bill on different axes and the self-hosted assumption overstates a
  // Serverless bill by roughly 14x.
  //
  // Serverless charges per GB INGESTED ($0.07) plus per GB RETAINED per month
  // ($0.017), so compact -- which reduces the bytes that arrive -- lands
  // directly on the larger of the two lines. Self-hosted `elasticsearch` has no
  // per-GB licence at all; its 1.0 is a blended infrastructure figure from
  // vendors.json.
  //
  // NO tier_down here, deliberately. Serverless retention is already at roughly
  // object-storage cost ($0.017/GB-month), so there is no premium tier to
  // escape; the frozen-tier lever belongs to Elastic Cloud HOSTED, which is
  // resource-priced and is NOT modelled separately yet (it would be identical
  // to `elasticsearch` until that lever exists, and a destination with no
  // behavioural difference is just surface area).
  'elastic-serverless': {
    destination: 'elastic-serverless',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB['elastic-serverless'],
    storage_per_gb_month: 0.017,
    billing_basis: 'uncompressed-ingest',
    // COMPACT IS NOT A LEVER ON SERVERLESS. The bytes would shrink, but the
    // expander is an Elasticsearch PLUGIN (l1es, installed with
    // `bin/elasticsearch-plugin install` or baked into a node image) and
    // Serverless has no plugin surface at all. Shipping encoded events with
    // nothing to expand them leaves the customer reading `~hash,val,val`,
    // which is not a keep-everything lever whatever the byte number says.
    // This entry previously inherited ES's index-pruned mode and priced a
    // 65% saving the platform cannot deliver.
    compact_mode: 'no-op',
    compact_unavailable_reason:
      'the l1es expander is an Elasticsearch plugin and Elastic Serverless has no plugin surface — compacted events would arrive unreadable',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
    tier_down_requires:
      'the Serverless cost-efficient tier (rate below is derived, not quoted — confirm against your live Serverless price)',
    // Elastic Serverless DOES offer a cheaper searchable tier (confirmed with
    // product): tier_down routes there, and per the ladder it is taken before
    // offload. Rate is the conservative 0.60 cost-delta on the ingest floor
    // ($0.07 × 0.40 = $0.028); confirm against the live Serverless tier price.
    tier_down_target_tier: {
      name: 'Elastic Serverless cost-efficient tier',
      ingest_rate_usd_per_gb: 0.028,
      storage_rate_usd_per_gb_month: 0.008,
    },
  },
  // ClickHouse is priced as a COMPUTE bill. Ingest is genuinely $0 and the
  // storage rate below is genuinely small, and both stay because both are
  // true; what changed is that neither is the bill. See `compute`.
  clickhouse: {
    destination: 'clickhouse',
    ingest_per_gb: 0.0,
    storage_per_gb_month: 0.023,
    billing_basis: 'stored-month',
    // COMPACT IS NOT A LEVER ON CLICKHOUSE, and this is a measurement rather
    // than a missing expander. On a ClickStack table at ZSTD(1) the compact
    // form is worth about 7% of table bytes: the text index and the column
    // codecs have already taken the repetition that compaction would take.
    // Seven percent of a line that is itself a small share of the bill is not
    // a lever. Offload is.
    compact_mode: 'no-op',
    compact_unavailable_reason:
      'the column codecs and the text index already absorb the repetition compaction would remove, so it is worth about 7% of table bytes, and table bytes are not where a ClickHouse bill lives',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 80,
    // COMPUTE TERM. Rows that never enter are the lever.
    //
    // unit_usd_per_hour: ClickHouse Cloud Scale compute unit, 8 GiB / 2 vCPU,
    // billed per minute. Documented pricing read 2026-09.
    //
    // min_units 12 is an ASSUMPTION: three replicas of four units, the
    // autoscaler's configured minimum on a Scale service sized for a log
    // estate. It is a knob, not a measurement. Where the customer's own floor
    // is known, pass it and the stepping answers differently.
    //
    // curve: measured 2026-09-13 (benchmarks clickhouse-clickstack,
    // compute-vs-rows). Insert CPU from system.query_log, merge CPU from
    // system.part_log, fastest of three passes after a discarded warm-up, same
    // ClickStack schema at ZSTD(1) in every arm. The points below are the
    // `bypattern` arms, where whole message types were removed, because that is
    // what a per-pattern policy actually does; the uniform-sample arms agree
    // within a couple of points at half and a quarter of the rows.
    //   rows 72.85% -> CPU 83%   (bypattern_75)
    //   rows 49.32% -> CPU 35%   (bypattern_50)
    //   rows 23.88% -> CPU 15%   (bypattern_25)
    // Endpoints (0,0) and (1,1) close the curve. Between points, linear.
    compute: {
      basis: 'rows-inserted',
      unit_usd_per_hour: 0.2985,
      unit_step: true,
      min_units: 12,
      curve: [
        [0.0, 0.0],
        [0.2388, 0.15],
        [0.4932, 0.35],
        [0.7285, 0.83],
        [1.0, 1.0],
      ],
    },
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
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB['azure-monitor'], // $2.30/GB Analytics (standard) table plan
    storage_per_gb_month: 0.12, // Analytics interactive retention
    billing_basis: 'compressed-ingest',
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
    // Azure Monitor cheaper table plans. Like CloudWatch IA, the plan is fixed
    // on the table (via a Data Collection Rule) at creation, so tier_down routes
    // the marked slice to a table pre-provisioned on the cheaper plan. Default
    // target is Basic (still KQL-queryable); Auxiliary is the aggressive,
    // archive-oriented alternative. Both bill a per-GB QUERY fee, so the savings
    // are ingest-side only.
    tier_down_target_tier: {
      name: 'Azure Monitor Basic Logs',
      ingest_rate_usd_per_gb: 0.5, // vs $2.30 Analytics (~78% off ingest)
      storage_rate_usd_per_gb_month: 0.1, // interactive retention
    },
    tier_down_alt_tiers: [
      {
        name: 'Azure Monitor Auxiliary Logs',
        ingest_rate_usd_per_gb: 0.05, // vs $2.30 Analytics (~98% off ingest)
        storage_rate_usd_per_gb_month: 0.02, // long-term retention
      },
    ],
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
  coralogix: {
    destination: 'coralogix',
    ingest_per_gb: DEFAULT_ANALYZER_COST_PER_GB.coralogix, // $1.15/GB Frequent Search
    storage_per_gb_month: 0.0, // unit-based pricing bundles retention into the priority
    billing_basis: 'compressed-ingest',
    // Coralogix cannot decode a 10x envelope at query time, so compact is a
    // no-op here exactly as it is for Datadog/CW. tier_down is the lever.
    compact_mode: 'no-op',
    compact_ratio_low: 1.0,
    compact_ratio_high: 1.0,
    small_event_floor_bytes: 100,
    // Coralogix TCO priority levels: High (Frequent Search) is the default for
    // anything no policy matches; Medium (Monitoring) is the cheap tier, still
    // DataPrime-queryable with alerting and dashboarding (so tier_down here is
    // NOT a loss of queryability, unlike an archive).
    //
    // Storage is 0.0 on both sides because Monitoring stores into the
    // CUSTOMER's own S3 bucket: those bytes are not billed by Coralogix at all.
    // Netting the customer's own S3 cost is the caller's job via
    // S3_STORAGE_PER_GB_MONTH, the same way `offload` is netted; folding it in
    // here would double-count it.
    tier_down_target_tier: {
      name: 'Coralogix Monitoring (Medium priority)',
      ingest_rate_usd_per_gb: 0.5,
      storage_rate_usd_per_gb_month: 0.0,
    },
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
//   - Azure Monitor:          tier_down (Basic/Auxiliary) → offload
//   - Splunk Cloud / Ent:     offload           → compact (if 10x app installable)
//   - Elasticsearch self / OpenSearch self:
//                             offload           → compact (if 10x plugin installable)
//   - Elasticsearch managed / OpenSearch managed:
//                             offload                  (no compact on managed)
//   - ClickHouse:             offload                  (compact is a no-op here;
//                             the bill is compute, and offload is what keeps
//                             rows out of it. tier_down, as a cold table read
//                             through a Merge table, is a storage saving only
//                             and is not modeled yet.)
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
  // Coralogix: Monitoring (Medium) is an in-platform cheap tier that stays
  // DataPrime-queryable, so tier_down is the level-1 lever, offload the
  // fallback. Unlike Datadog Flex / CW IA, the tier_down slice goes to the SAME
  // ingest endpoint — only the subsystem differs, and a TCO policy keyed on
  // that subsystem does the routing.
  coralogix: ['tier_down', 'offload'],
  // Splunk: 10x envelope-compact app installable on both Cloud and Enterprise.
  splunk: ['compact', 'offload'],
  splunk_cloud: ['compact', 'offload'],
  // Self-hosted ES/OS can run the l1es plugin (built for ES 8.17.0 /
  // OpenSearch 2.19.0); managed offerings cannot, and Serverless has no plugin
  // surface at all.
  // tier_down works via a frozen searchable snapshot (identity
  // survives). Needs an Enterprise licence self-managed, or Gold+ on Elastic
  // Cloud Hosted; the recipe states that as a prerequisite.
  // Deployment unknown: tier_down is a PLATFORM feature (frozen searchable
  // snapshots, licence-gated) so it holds either way; compact needs OUR plugin
  // and therefore self-managed, which only a confirmed deployment asserts
  // (see getAvailableActions).
  elasticsearch: ['tier_down', 'offload'],
  // Serverless: the cheaper searchable tier is confirmed with product; compact
  // is not offered (no plugin surface for the expander — see the model entry).
  'elastic-serverless': ['tier_down', 'offload'],
  elasticsearch_self: ['compact', 'offload'],
  elasticsearch_managed: ['offload'],
  opensearch_self: ['compact', 'offload'],
  opensearch_managed: ['offload'],
  // ClickHouse: offload is the only modeled lever. Compaction is a no-op on the
  // billed measure, and the cold-table tier_down recipe is not built yet.
  clickhouse: ['offload'],
  // Single-lever destinations.
  sumo: ['offload'],
  newrelic: ['offload'],
  honeycomb: ['offload'],
  grafana_cloud_logs: ['offload'],
  loki: ['offload'],
  // Azure Monitor: Basic/Auxiliary table plans are the cheap-tier lever
  // (the analog of CloudWatch IA / Datadog Flex).
  'azure-monitor': ['tier_down', 'offload'],
  // Map the remaining SiemId entries to the safe single-lever default. These
  // sit at the bottom because the table is keyed by the wider DestinationKey
  // and TypeScript requires every key to be present.
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
 * THE predicate for "does `compact` keep the line queryable in this
 * destination, in place".
 *
 * True only where the destination has a real compaction mechanism: Splunk
 * (envelope) and self-hosted Elasticsearch/OpenSearch (index-pruned).
 * Everywhere else `compact_mode` is `no-op` with ratio 1.0, and claiming
 * in-place compaction there is a false statement about the customer's own
 * platform.
 *
 * Every surface that renders or gates compaction language routes through
 * this. Without it the renderer carries rival notions of the same fact:
 * unconditional prose in four places, a hardcoded
 * `splunk || elasticsearch || clickhouse` gating the measured-ratio
 * section, and an allowed-actions lookup in the action selector — which
 * lets a CloudWatch report assert in-place compaction in its opening
 * paragraph while the section demonstrating it is skipped, so the section
 * numbering jumps 5 to 7. `test/compaction-claim-drift.test.ts` fails if
 * a rival notion appears.
 */
/**
 * The actions available on a destination GIVEN THE DEPLOYMENT — the single
 * source of truth for availability, so the lever choice and the plan's action
 * set can never disagree.
 *
 * The base list omits compaction on the Elasticsearch/OpenSearch family
 * because the expander is the l1es plugin, installable only on nodes the
 * customer controls. A CONFIRMED self-managed deployment adds it back.
 * Serverless never qualifies: its compact_mode is 'no-op' precisely because
 * there is no plugin surface, so the guard below refuses it there too.
 */
export function getAvailableActions(
  destination: SiemId,
  opts?: { selfManaged?: boolean },
): Action[] {
  const base = getAllowedActionsForDestination(destination);
  const d = String(destination);
  const pluginFamily = d.startsWith('elasticsearch') || d.startsWith('opensearch');
  if (
    opts?.selfManaged === true &&
    pluginFamily &&
    !base.includes('compact') &&
    compactsInPlace(destination)
  ) {
    return [...base, 'compact'];
  }
  return base;
}

export function compactsInPlace(destination: string): boolean {
  // Alias-aware: a deployment variant (elasticsearch_self, splunk_cloud …)
  // has no model of its own but compacts exactly like its base. Reading the
  // raw table here made every variant silently non-compacting, which sent the
  // solver past a real lever to offload.
  let model: DestinationCostModel | undefined;
  try {
    model = getDestinationCostModel(destination as SiemId);
  } catch {
    return false; // unmodeled destination: no compact claim
  }
  if (!model) return false;
  return model.compact_mode !== 'no-op';
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
/**
 * Deployment variants that share a modeled sibling's economics. The variant
 * exists to assert a different LEVER SET (self-managed can run our plugin,
 * managed cannot), not different rates — so it resolves to the base model.
 * Without this, every variant key returned `undefined` and the first read of
 * a rate crashed inside projectAction with a bare TypeError.
 */
const COST_MODEL_ALIAS: Partial<Record<string, SiemId>> = {
  splunk_cloud: 'splunk',
  elasticsearch_self: 'elasticsearch',
  elasticsearch_managed: 'elasticsearch',
  opensearch_self: 'elasticsearch',
  opensearch_managed: 'elasticsearch',
};

export function getDestinationCostModel(
  dest: SiemId,
  opts?: { esPruned?: boolean }
): DestinationCostModel {
  const aliased = COST_MODEL_ALIAS[dest as string];
  if (aliased) {
    const model = getDestinationCostModel(aliased, opts);
    // Keep the caller's destination on the returned model so disclosure lines
    // name what the user actually asked about, not the sibling we priced from.
    return { ...model, destination: dest };
  }
  const base = COST_MODEL_BY_DESTINATION[dest];
  if (!base) {
    // Offload-only destinations (loki, honeycomb, newrelic, grafana, generic)
    // have no rate model. Say so instead of handing back undefined and letting
    // the first property read explode three frames deeper.
    throw new Error(
      `No cost model for destination "${dest}". Modeled destinations: ` +
        `${Object.keys(COST_MODEL_BY_DESTINATION).join(', ')}. ` +
        `Pass effective_ingest_per_gb to price an unmodeled destination, or pick a modeled one.`,
    );
  }
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

/** Hours in a billing month, the figure every compute dollar here is built on. */
export const HOURS_PER_MONTH = 730;

/**
 * Insert-plus-merge CPU as a fraction of today's, for a given fraction of
 * today's rows kept. Linear between measured points; identity outside them,
 * which cannot happen once a curve carries its 0 and 1 endpoints.
 *
 * Exposed for testing and for surfaces that want the shape without the money.
 */
export function cpuFractionForRowsKept(
  curve: Array<[number, number]>,
  rowsKeptFraction: number,
): number {
  const kept = Math.max(0, Math.min(1, rowsKeptFraction));
  const pts = [...curve].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    const [r0, c0] = pts[i];
    const [r1, c1] = pts[i + 1];
    if (kept >= r0 && kept <= r1) {
      if (r1 === r0) return c0;
      return c0 + ((c1 - c0) * (kept - r0)) / (r1 - r0);
    }
  }
  return kept;
}

/**
 * Model what an action does to a compute-billed destination's bill.
 *
 * Whole units, floored: the platform bills capacity in units within the
 * autoscaler's bounds, so lower CPU is worth nothing until a whole unit can go
 * and never below the floor. A small estate already at the floor saves zero,
 * and this returns zero rather than a fractional dollar the invoice will not
 * show.
 *
 * Without a current unit count or a monthly spend there is no dollar to give,
 * so this returns the fraction and says what to supply.
 */
export function projectComputeSaving(
  compute: DestinationComputeTerm,
  rowsKeptFraction: number,
  opts?: { current_units?: number; monthly_spend_usd?: number },
): ComputeSavingProjection {
  const kept = Math.max(0, Math.min(1, rowsKeptFraction));
  const cpuFraction = cpuFractionForRowsKept(compute.curve, kept);
  const monthlyPerUnit = compute.unit_usd_per_hour * HOURS_PER_MONTH;

  let currentUnits: number | undefined = opts?.current_units;
  if (currentUnits == null && opts?.monthly_spend_usd != null && monthlyPerUnit > 0) {
    currentUnits = opts.monthly_spend_usd / monthlyPerUnit;
  }

  if (currentUnits == null || !Number.isFinite(currentUnits) || currentUnits <= 0) {
    return {
      basis: compute.basis,
      rows_kept_fraction: kept,
      cpu_fraction: cpuFraction,
      saving_fraction: 1 - cpuFraction,
      modeled: true,
      note:
        'modeled compute saving: supply current compute units or monthly compute spend to get dollars',
    };
  }

  const step = (u: number): number => (compute.unit_step ? Math.ceil(u) : u);
  const units_before = Math.max(compute.min_units, step(currentUnits));
  const units_after = Math.max(compute.min_units, step(units_before * cpuFraction));
  const saving_usd_month = (units_before - units_after) * compute.unit_usd_per_hour * HOURS_PER_MONTH;

  return {
    basis: compute.basis,
    rows_kept_fraction: kept,
    cpu_fraction: cpuFraction,
    units_before,
    units_after,
    saving_usd_month,
    saving_fraction: units_before > 0 ? (units_before - units_after) / units_before : 0,
    modeled: true,
    note:
      units_after === units_before
        ? `modeled compute saving: ${units_before} units before and after. Compute is billed in whole units with a floor of ${compute.min_units}, so this much row reduction sheds none.`
        : `modeled compute saving: ${units_before} units to ${units_after}, at $${compute.unit_usd_per_hour}/unit-hour over ${HOURS_PER_MONTH} hours.`,
  };
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
   * Which tier_down plan to price. Matches (case-insensitive substring) the
   * name of the destination's default tier_down_target_tier or any
   * tier_down_alt_tiers entry (e.g. "auxiliary" → Azure Auxiliary Logs). Omit
   * for the default target tier (e.g. Azure Basic Logs). No effect on
   * destinations whose tier_down has no alternative tiers.
   */
  tier_down_plan?: string;
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
   * Ignored on index-pruned (ES) destinations, where the wire ratio diverges
   * from the billed index size; those keep the static band for the dollar
   * projection. Ignored on ClickHouse too, where compact is a no-op. The value already
   * reflects realized small-event overhead, so it is NOT re-degraded.
   */
  compact_ratio_override?: number;
  /**
   * Compute-billed destinations only (ClickHouse). The service's CURRENT
   * compute unit count. Supply it, or `monthly_compute_spend_usd`, to get a
   * dollar compute saving instead of a fraction.
   */
  current_compute_units?: number;
  /**
   * Compute-billed destinations only. The service's current monthly compute
   * spend in dollars. Converted to units at the model's unit price when
   * `current_compute_units` is absent.
   */
  monthly_compute_spend_usd?: number;
  /**
   * Rows still inserted after the action, as a fraction of the cluster's
   * current rows. Supply it when `bytes_in` is one slice of a larger estate.
   * When absent, the compute term ASSUMES `bytes_in` is everything the cluster
   * takes today and reads rows kept off the byte reduction.
   */
  rows_kept_fraction?: number;
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

/**
 * Resolve which tier_down tier to price for a destination. Without a selector,
 * returns the default tier_down_target_tier (e.g. Azure Basic Logs). A selector
 * matches (case-insensitive substring) the name of the default tier or any
 * tier_down_alt_tiers entry (e.g. "auxiliary" → Azure Auxiliary Logs). Returns
 * undefined only when the destination has no tier_down tier at all. The engine
 * is unaware of the plan; this only prices the caller-selected one.
 */
export function resolveTierDownTier(
  model: DestinationCostModel,
  planSelector?: string | null
): TierDownTargetTier | undefined {
  const defaultTier = model.tier_down_target_tier;
  const alts = model.tier_down_alt_tiers ?? [];
  if (!defaultTier && alts.length === 0) return undefined;
  const fallback = defaultTier ?? alts[0];
  const needle = planSelector?.trim().toLowerCase();
  if (!needle) return fallback;
  const all = [...(defaultTier ? [defaultTier] : []), ...alts];
  return all.find((t) => t.name.toLowerCase().includes(needle)) ?? fallback;
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
  // Caller-selected tier_down plan (default target tier, or a named alternative
  // such as Azure Auxiliary Logs). undefined for non-tier_down actions and for
  // destinations with no cheaper tier.
  const selectedTierDownTier =
    args.action === 'tier_down' ? resolveTierDownTier(model, args.tier_down_plan) : undefined;

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
      // When tier_down_target_tier is defined in the cost model, the
      // the dollar delta below by substituting the tier rates. bytes_out is
      // still set to bytes_in so the byte-reduction fields reflect 0 — the
      // savings are entirely in the rate axis, not the byte axis.
      bytes_out = args.bytes_in;
      if (selectedTierDownTier) {
        notes.push(
          `tier_down: assumes ${selectedTierDownTier.name} ($${selectedTierDownTier.ingest_rate_usd_per_gb}/GB ingest + $${selectedTierDownTier.storage_rate_usd_per_gb_month}/GB-mo storage); destination-side routing rule must be configured to realize.`
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
      // cost), so offload is not modeled as a free win. The explanatory
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
        // so it is NOT re-degraded. The low/expected/high band collapses to
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
  const tierTarget = selectedTierDownTier;
  const effectiveIngestRateList = tierTarget
    ? tierTarget.ingest_rate_usd_per_gb
    : model.ingest_per_gb;
  const effectiveStorageRateList = tierTarget
    ? tierTarget.storage_rate_usd_per_gb_month
    : model.storage_per_gb_month;

  // Ingest axis: customer override > list rate (effective for tier) > unset.
  // model.ingest_per_gb is always a known number in COST_MODEL_BY_DESTINATION
  // (ClickHouse is genuinely $0 at ingest, not unknown, and that zero is not
  // the whole bill: the compute term below carries what a ClickHouse cluster
  // actually costs). 'unset' is reserved for future destinations that come
  // without a list rate.
  const ingestOverride = args.customer_rate?.ingest_per_gb_override;
  let ingest_dollars: number | null;
  let ingestSource: 'list' | 'customer_supplied' | 'unset';
  if (ingestOverride != null) {
    // For tier_down with a customer override, the override scales by the
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
  // "vendor includes storage" signal (e.g. Datadog), so it emits 0 + 'list'
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

  // Compute term. Only ClickHouse carries one. The byte axis above already
  // holds the storage saving, which on this destination is the small half; the
  // compute saving is the other half and the one worth naming.
  //
  // Rows kept is read off the byte reduction unless the caller states it. That
  // ASSUMES bytes_in is everything the cluster takes today, which is right when
  // the caller is pricing a whole estate and wrong when it is pricing one
  // pattern out of many; `rows_kept_fraction` is there for the second case.
  let compute_saving: ComputeSavingProjection | undefined;
  if (
    model.compute &&
    (args.action === 'offload' || args.action === 'drop' || args.action === 'sample')
  ) {
    const rowsKept =
      args.rows_kept_fraction ??
      (args.bytes_in > 0 ? bytes_out / args.bytes_in : 1);
    compute_saving = projectComputeSaving(model.compute, rowsKept, {
      current_units: args.current_compute_units,
      monthly_spend_usd: args.monthly_compute_spend_usd,
    });
    notes.push(compute_saving.note);
  }
  if (model.compute) {
    notes.push(
      `${siemLabel ?? args.destination} dollars are modeled: the bill is compute, priced from a measured rows-to-CPU curve and an ASSUMED unit floor, not from the destination's own meter.`,
    );
  }

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
    ...(compute_saving ? { compute_saving } : {}),
    ...(model.compute ? { modeled: true as const } : {}),
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
      // The list-rate view re-projects without the override so callers
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
