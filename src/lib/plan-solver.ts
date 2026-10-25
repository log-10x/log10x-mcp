/**
 * plan-solver — the ONE routine that turns per-pattern data into a
 * "cut N% of the bill" plan, shared by the POC path (log10x_poc_from_local)
 * and the analysis path (log10x_estimate_savings / cost_options). Before this,
 * the two paths ran different algorithms — POC a byte "droppable fraction",
 * analysis a byte-denominated greedy — and disagreed (65% vs 0% on the same
 * environment). This makes them agree by construction.
 *
 * The model is the destination ladder, made explicit:
 *
 *   keep everything, recoverable        lossy, opt-in
 *   ─────────────────────────────       ──────────────
 *   1 compact    in SIEM, smaller       4 sample  keep 1 in N
 *   2 tier_down  in SIEM, cheaper tier   5 drop    keep nothing
 *   3 offload    out of SIEM, in your S3 (needs the retriever)
 *
 * Rules the solver enforces:
 *   - Errors and warnings are pinned at `pass` — never eligible for anything.
 *   - The target is met with keep-everything rungs (1-3) FIRST. Lossy rungs are
 *     surfaced only as a labelled opt-in when the keep-everything ceiling falls
 *     short, and applied only when the caller passes allowLossy.
 *   - offload (rung 3) is available only when the retriever is installed, since
 *     without it the offloaded events are unreachable. So a destination with no
 *     compact and no tier_down and no retriever collapses to drop — honestly.
 *   - Accounting is in DOLLARS (bill = bytes × rate; each lever cuts its own
 *     factor via cost.projectAction), so tier_down — which keeps every byte and
 *     cuts the rate — reads as the real cut it is instead of a byte "0%".
 *   - Scope is a set of services (or all). A pattern touching any scoped service
 *     is a candidate, weighted by its bytes in those services.
 */

import { placeServiceCap } from './service-cap.js';
import {
  getAllowedActionsForDestination,
  getAvailableActions,
  getDestinationCostModel,
  compactsInPlace,
  describeCompactFigure,
  describePerEventTierRate,
  fmtListRate,
  perEventTierPricing,
  projectAction,
  projectPerEventTierMove,
  sumPerEventTierMoves,
  type Action,
  type PerEventTierMove,
} from './cost.js';
import { type SiemId, defaultRateLabel } from './siem/pricing.js';
import { isProtectedSeverity } from './severity-policy.js';
import { isSplunkDestination, splunkKeepRaw, type SplunkPricing } from './siem/splunk-keep-raw.js';
import { ALWAYS_PASS_LINES, REGULATOR_WINDOW_SECONDS, SECONDS_PER_DAY } from './report/user-units.js';
import { ERROR_CLASS_LEVELS, KEEP_COUNT_DEFAULT } from './fleet-default-install.js';

/**
 * Lines of a statement over its cap that the shipped Receiver still passes per
 * window per node: the keep count for an error-class level, none for the rest
 * (config/pipelines/run/receive/rate/config.yaml keepCounts and severityFloors).
 */
export function keptOverCapLines(severity?: string | null): number {
  return (ERROR_CLASS_LEVELS as readonly string[]).includes((severity ?? '').toUpperCase()) ? KEEP_COUNT_DEFAULT : 0;
}

/** True ladder order: keep-everything (in-SIEM before out) then lossy. */
const LADDER: Action[] = ['compact', 'tier_down', 'offload', 'sample', 'drop'];

/** A container's tier_down cap and how it was placed (service-cap.ts). */
interface TierDownCap {
  capBytesMonthly: number;
  keptMaxPattern?: string;
  movedMinPattern?: string;
  separated: boolean;
  margin?: number;
  keptMaxBytesMonthly: number;
  movedMinBytesMonthly?: number;
}

/** One pattern (message type) as the solver consumes it. */
export interface SolverPattern {
  /**
   * The template body with `$` marking variable slots — the message type's
   * own skeleton, the unit made visible. Present where the source has real
   * templates (the POC extraction); absent on the analysis path until its
   * metrics carry one. First line only for multi-line templates.
   */
  skeleton?: string;
  /** Stable identity (tenx_hash / templateHash). */
  hash: string;
  /** Human-readable message-type face. */
  name: string;
  /** Service → bytes attributed to this pattern in that service. A pattern
   *  usually maps to one service, but a shared log line can span several, so
   *  the shape is a distribution. */
  services: Record<string, number>;
  /** Dominant severity for the pattern. */
  severity: string;
  /** Total observed bytes for the pattern over `SolveOpts.spanSeconds`, the
   *  span the Receiver's per-window sample and keep count are counted over. */
  bytes: number;
  /** Average event size in bytes; degrades the compact ratio for tiny events. */
  avgEventBytes?: number;
  /**
   * The same bytes in the Receiver's unit, at the pattern's busiest window's
   * rate (`ExtractedPattern.receiverCapBytes`, scaled like `bytes`). Caps are
   * set and compared in this unit; `bytes` stays the billing figure.
   */
  capBytes?: number;
}

/**
 * What the plan is solving FOR. Three denominations:
 *  - percent:    "cut X% of the bill" — a one-shot project. On a destination
 *                whose tier_down is billed per event (Datadog Flex), no share
 *                of the bill can be stated for a plan that uses it, because
 *                the Flex compute add-on is unpriced. There the percent is
 *                read as a share of the volume moved OUT OF THE STANDARD
 *                INDEX, and Plan.percentBasis says so.
 *  - usd_budget: "keep the (scoped) bill under $B/mo" — a standing constraint;
 *                the reduction is derived: max(0, bill - budget). Idempotent:
 *                already under budget -> an empty plan with headroom.
 *  - gb_budget:  "keep (scoped) ingest under V GB/mo" — BYTE accounting.
 *                tier_down keeps every byte, so it contributes NOTHING to this
 *                target and is excluded from the ladder; compact counts only
 *                where it lands on the billed wire (compactsInPlace).
 */
export type PlanTarget =
  | { kind: 'percent'; value: number }
  | { kind: 'usd_budget'; value: number }
  | { kind: 'gb_budget'; value: number };

export interface SolveOpts {
  destination: SiemId;
  /** Whether the S3 retriever is installed. Gates the offload rung. */
  retrieverInstalled: boolean;
  /** Reduction goal as a percent of the (scoped) bill, e.g. 50. Ignored when
   *  `target` is supplied; kept for the existing percent callers. */
  targetPct?: number;
  /** The full target union; wins over targetPct when present. */
  target?: PlanTarget;
  /** Services to solve for; omit or 'all' for the whole estate. */
  scope?: string[] | 'all';
  /** Permit the lossy rungs (sample/drop) to close a keep-everything shortfall.
   *  Default false: the plan stops at the keep-everything ceiling and names the
   *  gap instead of silently discarding data. */
  allowLossy?: boolean;
  /** Services pinned at pass (the POC's exception_services): their patterns
   *  stay in the bill but are never planned, exactly like protected severities.
   *  Matched case-insensitively against the pattern's dominant service. */
  exceptionServices?: string[];
  /**
   * The customer's blended all-in $/GB for this destination (their contracted
   * or invoice-derived rate). When present, every dollar on the plan is scaled
   * from the list-price structure to this blend — the ladder physics (lever
   * ratios) stay list-structure, the absolute dollars become theirs. Provenance
   * is echoed on the plan (rateSource / rateBasis). Absent = list price.
   */
  customerRatePerGb?: number;
  /**
   * Specific pattern hashes pinned at pass — the referenced-types exclusion:
   * a type a monitor or saved search names stays exactly as it is unless the
   * user explicitly trades it back in. Pinned like protected severities.
   */
  pinnedHashes?: string[];
  /**
   * Whether the customer runs this destination themselves. Decides whether
   * compaction is available on the Elasticsearch/OpenSearch family: the
   * expander is the l1es PLUGIN, installable on your own nodes and nowhere
   * else. Absent = unknown, and unknown prices only the levers that hold on
   * any deployment. Never inferred.
   */
  selfManaged?: boolean;
  /**
   * Splunk only. `workload`: the licence meters vCPU, not bytes, and compact
   * leaves the lever set. Absent means ingest pricing, Splunk's common case.
   */
  splunkPricing?: SplunkPricing;
  /**
   * Splunk only. Whether Enterprise Security (or any CIM data model) reads
   * this estate. True or absent keeps the add-on sourcetypes raw; false,
   * stated by the user, frees them. Never inferred.
   */
  enterpriseSecurity?: boolean;
  /**
   * Specific pattern hashes the user EXPLICITLY unpinned from the severity
   * floor — a warn-level retry storm they chose to act on. Bypasses ONLY the
   * severity protection for the listed hashes; pinnedHashes and
   * exceptionServices still win. Never inferred, never estate-wide.
   */
  unprotectPatterns?: string[];
  /** The span the patterns' bytes cover, in seconds. Absent = a 30-day month. */
  spanSeconds?: number;
  /**
   * Receiver nodes each container's pods run on. Each node keeps its own
   * always-pass sample and keep count, so a container absent here counts as
   * one node and the plan says so.
   */
  nodesByContainer?: Record<string, number>;
}

export interface PlannedRow {
  hash: string;
  name: string;
  /** Readable opener for the card: the identifier de-underscored and
   *  whitespace-collapsed. Tool-emitted so every host opens the card with the
   *  same noun instead of each agent deriving its own. Mechanical, never
   *  interpretive: same tokens as `name`. */
  displayName: string;
  dominantService: string;
  serviceMix: { service: string; sharePct: number }[];
  severity: string;
  billUsd: number;
  action: Action | 'pass';
  /**
   * tier_down rows: the bytes the engine moves, the pattern's lines past the
   * larger of its container's cap and the always-pass sample, less the keep
   * count of an error-class level, on every node. In the plan's own scale.
   */
  movedBytesMonthly?: number;
  savedUsd: number;
  /** The template skeleton ($-slots), passed through from the source. */
  skeleton?: string;
  /** Volume-budget plans only: bytes this row removes from the billed wire. */
  savedBytes?: number;
  /**
   * Per-event tier rows only (tier_down to Datadog Flex): the line the move
   * ADDS at the tier the plan's Flex volume lands in, at list, $/mo. On these
   * rows savedUsd is the Standard indexing line avoided at list, so neither
   * number is a net; perEventMove.text names the tier and how compute is billed.
   */
  addedUsd?: number;
  /** Per-event tier rows only: the move as stated lines. Render its text. */
  perEventMove?: PerEventTierMove;
  keepsEverything: boolean;
}

export interface Plan {
  destination: SiemId;
  retrieverInstalled: boolean;
  scope: string[] | 'all';
  /** The ask, echoed. For budgets this is the user's budget, and targetPct is
   *  the DERIVED reduction percent the solver actually chased. */
  target: PlanTarget;
  targetPct: number;
  /**
   * What every percentage on this plan (targetPct, achievedPct,
   * keepEverythingCeilingPct, gap.remainingPct) is a share OF. 'bill' almost
   * everywhere. 'standard_index_volume' on Datadog, where Flex is the lever
   * and no share of the bill can be stated: there each percentage is the
   * share of volume moved out of the Standard index. Renderers must name the
   * basis beside every percentage they print.
   */
  percentBasis: 'bill' | 'standard_index_volume';
  billUsd: number;
  /** The keep-everything lever the destination resolves to (rung 1-3), or null
   *  when only lossy rungs remain. */
  keepEverythingLever: Action | null;
  /** Max percent of the bill removable while keeping everything (rungs 1-3 on
   *  every non-error pattern). */
  keepEverythingCeilingPct: number;
  achievedPct: number;
  met: boolean;
  /** Sum of planned rows' savedUsd — equals billUsd minus landsAtUsd (plus
   *  totalAddedUsd where present), so the arithmetic on a rendered plan
   *  closes visibly. */
  totalSavedUsd: number;
  /** Per-event tier plans only: the Flex lines the plan adds at its tier, at list. */
  totalAddedUsd?: number;
  /**
   * Per-event tier plans only (Datadog Flex): every tier_down row's move,
   * summed and stated as lines. Render its text verbatim. It carries no
   * percentage and no net, and neither may be derived from it.
   */
  perEventMove?: PerEventTierMove;
  /** The pricing basis behind every dollar on this plan, one human-readable
   *  line. Render it verbatim. */
  rateBasis: string;
  /** Whose dollars these are: the destination list-price model, or the
   *  customer's supplied blended rate scaled over the list structure. */
  rateSource: 'list_price' | 'customer_supplied';
  /**
   * True when this plan's dollars rest on a model rather than on the
   * destination's own meter. ClickHouse only, today: the per-GB rate behind
   * these figures is a storage rate and the bill is compute. Renderers must
   * carry the word "modeled" wherever they print one of these dollars.
   */
  modeled: boolean;
  /** Why the dollars are modeled, in one line. Present only when modeled. */
  modeledNote?: string;
  /**
   * Notes the cost model attached to this plan's projections, deduplicated.
   * The compute term's own sentences ride here, so a renderer that shows the
   * plan can show why a ClickHouse dollar is what it is. A tier_down plan adds
   * what the Receiver keeps over each cap and the node count it was counted on.
   */
  notes?: string[];
  /**
   * What the levers this plan actually uses REQUIRE — the app, plugin, tier,
   * or licence, with its platform and version constraint. Only for levers the
   * plan uses. A priced lever with an unstated prerequisite is a lever we are
   * guessing at, so the render states these before the user agrees.
   */
  prerequisites: string[];
  /** Echo of the supplied blended rate when rateSource is customer_supplied. */
  customerRatePerGb?: number;
  /** Total scoped bytes/mo behind the bill — the reconciliation multiplicand:
   *  bytesInMonthly times the rate should foot against the invoice line. */
  bytesInMonthly: number;
  /**
   * Splunk only: sources pinned at pass by the destination's own rules (an
   * Enterprise Security add-on reads them, or Splunk meters them at the
   * Cisco rate), with the sentence that says why. Render each one.
   */
  keptRaw?: { service: string; reason: 'cisco_rate' | 'enterprise_security_add_on'; text: string }[];
  /** usd_budget / percent targets: the bill after the plan, in $/mo. Absent
   *  on a percent plan over a per-event tier (Datadog Flex): a before and
   *  after pair there IS a bill percentage, and none can be stated. On a
   *  Datadog dollar budget it counts priced lines only, scalable Flex compute excluded. */
  landsAtUsd?: number;
  /** gb_budget targets: monthly bytes toward the destination after the plan. */
  landsAtBytesMonthly?: number;
  /**
   * The engine's files, one row per container that hosts a planned pattern:
   * the action its excess takes and, for tier_down, the cap that moves the
   * planned patterns and no other, the largest kept pattern's bytes. In the
   * plan's own byte scale and span; the writer converts to bytes per
   * regulator window.
   */
  containerCaps: Record<
    string,
    {
      action: Action;
      capBytesMonthly: number;
      keptMaxPattern?: string;
      /** tier_down: true when the cap sits between the largest kept and the smallest moved statement. */
      separated?: boolean;
      /** tier_down, separated: the factor of margin on each side of the cap. */
      margin?: number;
      /** tier_down: the smallest moved statement, when the plan moves one. */
      movedMinPattern?: string;
      /** tier_down: the largest kept and the smallest moved statement, in the cap's unit. */
      keptMaxBytesMonthly?: number;
      movedMinBytesMonthly?: number;
    }
  >;
  planned: PlannedRow[];
  kept: PlannedRow[];
  /** Set only on a copy trimmed for a tool response: how many kept rows the full plan has, and how many the copy leaves out. */
  keptTotal?: number;
  keptOmitted?: number;
  /** Present when the keep-everything ceiling is below the target. Names the
   *  remedies (install the retriever, or accept loss) rather than pretending. */
  gap: null | {
    remainingPct: number;
    remedies: Array<'install_retriever' | 'accept_loss'>;
    message: string;
  };
}

/**
 * The destination's best keep-everything lever, respecting the ladder and the
 * retriever gate. compact wins over tier_down (both keep in-SIEM queryability;
 * compact also shrinks the bytes); offload is last and needs the retriever.
 */
export function keepEverythingLever(
  destination: SiemId,
  retrieverInstalled: boolean,
  opts?: { selfManaged?: boolean; splunkPricing?: SplunkPricing },
): Action | null {
  const allowed = new Set(getAvailableActions(destination, opts));
  // in-SIEM rungs, in ladder order, gated by whether compact is real here
  for (const lever of ['compact', 'tier_down'] as Action[]) {
    if (!allowed.has(lever)) continue;
    if (lever === 'compact' && !compactsInPlace(destination)) continue;
    return lever;
  }
  if (retrieverInstalled && allowed.has('offload')) return 'offload';
  return null;
}

function serviceMix(services: Record<string, number>): {
  dominant: string;
  mix: { service: string; sharePct: number }[];
} {
  const entries = Object.entries(services).filter(([, b]) => b > 0);
  const total = entries.reduce((s, [, b]) => s + b, 0) || 1;
  const mix = entries
    .map(([service, b]) => ({ service, sharePct: (b * 100) / total }))
    .sort((a, b) => b.sharePct - a.sharePct);
  return { dominant: mix[0]?.service ?? '(unattributed)', mix };
}

/** Full monthly bill for a pattern's bytes at the destination's standard rate.
 *  This is the `pass` (do-nothing) cost, so every lever's saving is measured
 *  against the same baseline. Uses projectAction so ingest+storage are modelled
 *  the same way the saving is. */
function billOf(
  bytes: number,
  destination: SiemId,
  avgEventBytes: number | undefined,
): number {
  return (
    projectAction({
      action: 'pass',
      bytes_in: bytes,
      destination,
      ...(avgEventBytes ? { avg_event_size_bytes: avgEventBytes } : {}),
    }).total_dollars ?? 0
  );
}

/** DOLLAR saving for applying `action` to `bytes` — the bill delta, not the
 *  byte delta. tier_down keeps every byte and cuts only the rate, so its byte
 *  reduction is 0 while its dollar saving is real; accounting in dollars is the
 *  whole point of the solver. */
function saveUsd(
  action: Action,
  bytes: number,
  destination: SiemId,
  avgEventBytes: number | undefined,
): number {
  const bill = billOf(bytes, destination, avgEventBytes);
  const after =
    projectAction({
      action,
      bytes_in: bytes,
      destination,
      ...(avgEventBytes ? { avg_event_size_bytes: avgEventBytes } : {}),
    }).total_dollars ?? bill;
  return Math.max(0, bill - after);
}

/** BYTES removed from the destination's billed wire by `action`. tier_down is
 *  always 0 here (every byte still lands); compact counts only where it lands
 *  on the wire (projectAction's ratio is 1.0 on no-op destinations). */
function saveBytes(
  action: Action,
  bytes: number,
  destination: SiemId,
  avgEventBytes: number | undefined,
): number {
  const proj = projectAction({
    action,
    bytes_in: bytes,
    destination,
    ...(avgEventBytes ? { avg_event_size_bytes: avgEventBytes } : {}),
  });
  return Math.max(0, bytes - proj.bytes_out);
}

export function solvePlan(rawPatterns: SolverPattern[], opts: SolveOpts): Plan {
  // MERGE same-hash inputs first: two extraction rows sharing a tenx_hash are
  // template VARIANTS of one message type (the product's unit of identity),
  // and planning them as separate rows collided in the action map — the last
  // variant's action/saving was attributed to every sibling, so a row could
  // render a 4% cut where the lever gives 51%. One hash, one row: bytes and
  // service distributions sum; a protected severity on any variant pins the
  // merged row (the rail must not be washed out by a larger INFO sibling).
  const byHash = new Map<string, SolverPattern>();
  for (const p of rawPatterns) {
    const prev = byHash.get(p.hash);
    if (!prev) {
      byHash.set(p.hash, { ...p, services: { ...p.services } });
      continue;
    }
    const prevBytes = prev.bytes;
    prev.bytes += p.bytes;
    // Rows of one hash are templates of one Receiver counter, which already
    // carry the counter's figure: keep the larger, never the sum.
    if (prev.capBytes !== undefined || p.capBytes !== undefined) {
      prev.capBytes = Math.max(prev.capBytes ?? prevBytes, p.capBytes ?? p.bytes);
    }
    for (const [svc, b] of Object.entries(p.services)) {
      prev.services[svc] = (prev.services[svc] ?? 0) + b;
    }
    if (isProtectedSeverity(p.severity) && !isProtectedSeverity(prev.severity)) {
      prev.severity = p.severity;
    }
    if (prev.avgEventBytes !== undefined && p.avgEventBytes !== undefined) {
      // Weighted by events, so a few large records do not inflate the size of many small ones.
      const events = prevBytes / prev.avgEventBytes + p.bytes / p.avgEventBytes;
      prev.avgEventBytes = events > 0 ? prev.bytes / events : prev.avgEventBytes;
    }
  }
  const patterns = [...byHash.values()];

  const scopeSet =
    opts.scope && opts.scope !== 'all' ? new Set(opts.scope) : null;
  const lever = keepEverythingLever(opts.destination, opts.retrieverInstalled, {
    selfManaged: opts.selfManaged,
    splunkPricing: opts.splunkPricing,
  });
  // Splunk sources that stay raw whatever the target: the add-on sourcetypes
  // Enterprise Security reads, and the Cisco sourcetypes metered at their own
  // rate. Pinned like the exception services, with the reason kept for the render.
  const keptRaw: NonNullable<Plan['keptRaw']> = [];
  const keptRawServices = new Set<string>();
  if (isSplunkDestination(opts.destination)) {
    for (const p of rawPatterns) {
      const { dominant } = serviceMix(p.services);
      if (keptRawServices.has(dominant.toLowerCase())) continue;
      const verdict = splunkKeepRaw(dominant, { enterpriseSecurity: opts.enterpriseSecurity });
      if (verdict) {
        keptRawServices.add(dominant.toLowerCase());
        keptRaw.push({ service: dominant, reason: verdict.reason, text: verdict.text });
      }
    }
  }

  // Scope: keep patterns touching a scoped service; weight by scoped bytes.
  const exceptions = new Set(
    (opts.exceptionServices ?? []).map((x) => x.toLowerCase()),
  );
  const pinnedHashes = new Set(opts.pinnedHashes ?? []);
  const unprotect = new Set(opts.unprotectPatterns ?? []);
  const isPinned = (p: SolverPattern): boolean => {
    // Explicit pins win over everything, including an unpin of the same hash.
    if (pinnedHashes.has(p.hash)) return true;
    if (isProtectedSeverity(p.severity) && !unprotect.has(p.hash)) return true;
    if (exceptions.size === 0 && keptRawServices.size === 0) return false;
    const { dominant } = serviceMix(p.services);
    return exceptions.has(dominant.toLowerCase()) || keptRawServices.has(dominant.toLowerCase());
  };

  const rows = patterns
    .map((p) => {
      const scopedBytes = scopeSet
        ? Object.entries(p.services)
            .filter(([s]) => scopeSet.has(s))
            .reduce((s, [, b]) => s + b, 0)
        : p.bytes;
      // The cap unit, scoped like the bytes.
      const scopedCapBytes = p.capBytes !== undefined && p.bytes > 0 ? (p.capBytes * scopedBytes) / p.bytes : scopedBytes;
      return { p, scopedBytes, scopedCapBytes };
    })
    .filter((r) => r.scopedBytes > 0);
  // Rows by hash: the selection loop looks a row up for every moved pattern on
  // every step, which a linear search made cubic in the pattern count.
  const rowByHash = new Map(rows.map((r) => [r.p.hash, r] as const));

  const billUsdList = rows.reduce(
    (s, r) => s + billOf(r.scopedBytes, opts.destination, r.p.avgEventBytes),
    0,
  );
  const bytesIn = rows.reduce((s, r) => s + r.scopedBytes, 0);

  // Customer-rate seam: scale list-structure dollars to the customer's blended
  // all-in $/GB. Ratios (percent targets, lever ordering, ceiling %) are
  // scale-invariant; absolute dollars (usd budgets, row savings, lands-at)
  // become the customer's. bytes denomination is untouched.
  const impliedListRatePerGb = bytesIn > 0 ? billUsdList / (bytesIn / 1_000_000_000) : 0;
  const dollarScale =
    opts.customerRatePerGb && opts.customerRatePerGb > 0 && impliedListRatePerGb > 0
      ? opts.customerRatePerGb / impliedListRatePerGb
      : 1;
  const billUsd = billUsdList * dollarScale;

  // Resolve the ask into ONE denomination and one target amount.
  const target: PlanTarget = opts.target ?? { kind: 'percent', value: opts.targetPct ?? 0 };
  // Datadog Flex is billed per event, so no share of the Datadog bill is
  // stated for a plan that uses it. There a percent target counts the volume
  // moved out of the Standard index (to Flex, to the customer's S3, or away),
  // and a dollar budget counts Flex at its priced lines only: Standard
  // indexing avoided less the Flex line added at the plan's tier.
  const perEvent = perEventTierPricing(opts.destination);
  const percentBasis: Plan['percentBasis'] = perEvent ? 'standard_index_volume' : 'bill';
  const denom: 'usd' | 'bytes' | 'index_volume' =
    target.kind === 'gb_budget' ? 'bytes'
    : perEvent && target.kind === 'percent' ? 'index_volume'
    : 'usd';
  const poolTotal = denom === 'usd' ? billUsd : bytesIn;
  // The Flex tier follows the whole plan's volume, so every row is priced at
  // the tier of all the events the plan moves (tierEvents).
  const flexMoveOf = (bytes: number, avg: number | undefined, tierEvents?: number): PerEventTierMove | undefined =>
    perEvent
      ? projectPerEventTierMove(perEvent, bytes, {
          ...(avg ? { avgEventBytes: avg } : {}),
          ...(tierEvents != null ? { tierEventsMonthly: tierEvents } : {}),
        })
      : undefined;
  const flexEventsOf = (moved: Map<string, number>): number => {
    if (!perEvent) return 0;
    let n = 0;
    for (const [h, bytes] of moved) {
      const avg = rowByHash.get(h)?.p.avgEventBytes;
      n += bytes / (avg && avg > 0 ? avg : perEvent.assumed_event_bytes);
    }
    return n;
  };
  const targetAmount =
    target.kind === 'percent' ? (target.value / 100) * poolTotal
    : target.kind === 'usd_budget' ? Math.max(0, billUsd - target.value)
    : Math.max(0, bytesIn - target.value * 1_000_000_000);
  const derivedPct = poolTotal > 0 ? (targetAmount * 100) / poolTotal : 0;
  /** The denomination's gain function: dollars off the bill, bytes off the
   *  wire, or bytes out of the Standard index. */
  const gain = (action: Action, bytes: number, avg: number | undefined, tierEvents?: number): number => {
    if (denom === 'index_volume') {
      // tier_down keeps every byte in Datadog but takes all of it out of the
      // Standard index; the other levers take what they take off the wire.
      return action === 'tier_down' ? bytes : saveBytes(action, bytes, opts.destination, avg);
    }
    if (denom === 'bytes') return saveBytes(action, bytes, opts.destination, avg);
    if (action === 'tier_down' && perEvent) {
      // Priced lines at list, never scaled to a customer blend: the blend is
      // per GB and these lines are per event.
      const m = flexMoveOf(bytes, avg, tierEvents)!;
      return m.standard_indexing_avoided_usd - m.tier_storage_added_usd;
    }
    return saveUsd(action, bytes, opts.destination, avg) * dollarScale;
  };

  // How the engine enforces tier_down: a cap on each pattern's bytes per
  // container per window, the excess over it taking the container's action.
  // The cap that moves the planned patterns and no other is the largest kept
  // pattern's bytes in that container. Each window on each node the Receiver
  // passes a pattern's lines up to the larger of the cap and the always-pass
  // sample, then the keep count of an error-class level, and moves the rest
  // (rate-object-cap.js). Recomputed as the selection grows, since every
  // pattern added lowers its container's cap.
  const containerOf = (p: SolverPattern): string => serviceMix(p.services).dominant;
  const windows = (opts.spanSeconds && opts.spanSeconds > 0 ? opts.spanSeconds : 30 * SECONDS_PER_DAY) / REGULATOR_WINDOW_SECONDS;
  const nodesOf = (c: string): number => {
    const n = opts.nodesByContainer?.[c];
    return n != null && Number.isFinite(n) && n >= 1 ? Math.round(n) : 1;
  };
  /** Billed bytes the Receiver moves of a planned pattern under `cap`, counted in the cap's unit. */
  const movedUnderCap = (r: (typeof rows)[number], cap: number, nodes: number): number => {
    if (r.scopedCapBytes <= 0) return 0;
    const capUnitsPerByte = r.scopedCapBytes / r.scopedBytes;
    // One line a window on every node over the span; 0 when the line size is unknown.
    const perLine = windows * nodes * (r.p.avgEventBytes ?? 0) * capUnitsPerByte;
    const kept = Math.max(cap, ALWAYS_PASS_LINES * perLine) + keptOverCapLines(r.p.severity) * perLine;
    return Math.max(0, r.scopedCapBytes - kept) / capUnitsPerByte;
  };
  const byContainer = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    const c = containerOf(r.p);
    const list = byContainer.get(c) ?? [];
    list.push(r);
    byContainer.set(c, list);
  }
  const tierDownMoves = (
    chosenHashes: Set<string>,
  ): { moved: Map<string, number>; caps: Map<string, TierDownCap> } => {
    const moved = new Map<string, number>();
    const caps = new Map<string, TierDownCap>();
    for (const [c, members] of byContainer) {
      // The cap is in the Receiver's unit, between the largest kept pattern
      // and the smallest moved one, at their geometric mean.
      let keptMax = 0;
      let keptMaxPattern: string | undefined;
      let movedMin: number | undefined;
      let movedMinPattern: string | undefined;
      for (const r of members) {
        if (chosenHashes.has(r.p.hash)) {
          if (movedMin === undefined || r.scopedCapBytes < movedMin) { movedMin = r.scopedCapBytes; movedMinPattern = r.p.name; }
        } else if (r.scopedCapBytes > keptMax) { keptMax = r.scopedCapBytes; keptMaxPattern = r.p.name; }
      }
      const placement = placeServiceCap(keptMax, movedMin);
      const cap = placement.cap;
      caps.set(c, {
        capBytesMonthly: cap,
        ...(keptMaxPattern ? { keptMaxPattern } : {}),
        ...(movedMinPattern ? { movedMinPattern } : {}),
        separated: placement.separated,
        ...(placement.margin !== undefined ? { margin: placement.margin } : {}),
        keptMaxBytesMonthly: keptMax,
        ...(movedMin !== undefined ? { movedMinBytesMonthly: movedMin } : {}),
      });
      for (const r of members) {
        if (chosenHashes.has(r.p.hash)) moved.set(r.p.hash, movedUnderCap(r, cap, nodesOf(c)));
      }
    }
    return { moved, caps };
  };
  const tierDownMoved = new Map<string, number>();
  /** Events a month the final plan moves to the per-event tier; set once selection ends. */
  let planFlexEvents = 0;

  const allowed = new Set(getAvailableActions(opts.destination, { selfManaged: opts.selfManaged }));
  const canOffload = opts.retrieverInstalled && allowed.has('offload');
  // The in-SIEM keep-everything lever (compact/tier_down), separate from offload
  // so the two can be applied as an escalation, not an either/or. For a VOLUME
  // target, tier_down keeps every byte and therefore is not a lever at all.
  let inSiem: Action | null =
    lever === 'compact' || lever === 'tier_down' ? lever : null;
  if (denom === 'bytes' && inSiem === 'tier_down') {
    inSiem = compactsInPlace(opts.destination) ? 'compact' : null;
  }

  // Keep-everything ceiling = the DEEPEST keep-everything rung on every
  // non-error pattern. offload (when the retriever is present) removes the
  // event from the SIEM, so it is the deepest lossless cut; otherwise the
  // in-SIEM lever caps it.
  const deepest: Action | null = canOffload ? 'offload' : inSiem;
  const nonError = rows.filter((r) => !isPinned(r.p));
  const ceilingMoved = deepest === 'tier_down' ? tierDownMoves(new Set(nonError.map((r) => r.p.hash))).moved : undefined;
  const ceilingBytesOf = (r: (typeof rows)[number]): number =>
    ceilingMoved ? (ceilingMoved.get(r.p.hash) ?? 0) : r.scopedBytes;
  const ceilingFlexEvents = ceilingMoved ? flexEventsOf(ceilingMoved) : undefined;
  const ceilingAmount = deepest
    ? nonError.reduce(
        (s, r) => s + gain(deepest, ceilingBytesOf(r), r.p.avgEventBytes, ceilingFlexEvents),
        0,
      )
    : 0;
  const keepEverythingCeilingPct =
    denom === 'usd' && perEvent
      ? bytesIn > 0 && deepest
        ? (nonError.reduce(
            (s, r) => s + (deepest === 'tier_down' ? ceilingBytesOf(r) : saveBytes(deepest, r.scopedBytes, opts.destination, r.p.avgEventBytes)),
            0,
          ) * 100) / bytesIn
        : 0
      : poolTotal > 0 ? (ceilingAmount * 100) / poolTotal : 0;

  // Rank by bill (biggest cost first).
  const ranked = [...rows].sort(
    (a, b) => billOf(b.scopedBytes, opts.destination, b.p.avgEventBytes) - billOf(a.scopedBytes, opts.destination, a.p.avgEventBytes),
  );
  const rankedNonError = ranked.filter((r) => !isPinned(r.p));

  const build = (r: (typeof rows)[number], action: Action | 'pass', gained: number): PlannedRow => {
    // Row display is ALWAYS dollars; on a volume target the greedy ran on
    // bytes, so recompute the dollar figure for the card. A per-event tier
    // row states its two priced lines separately: savedUsd is the Standard
    // indexing line avoided and addedUsd the Flex storage line added.
    const movedBytes = action === 'tier_down' ? (tierDownMoved.get(r.p.hash) ?? 0) : undefined;
    const move = action === 'tier_down' ? flexMoveOf(movedBytes ?? 0, r.p.avgEventBytes, planFlexEvents) : undefined;
    const savedUsd =
      action === 'pass' ? 0
      : move ? move.standard_indexing_avoided_usd
      : denom === 'usd' ? gained
      : saveUsd(action, r.scopedBytes, opts.destination, r.p.avgEventBytes) * dollarScale;
    const { dominant, mix } = serviceMix(r.p.services);
    return {
      hash: r.p.hash,
      name: r.p.name,
      displayName: r.p.name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim(),
      dominantService: dominant,
      serviceMix: mix,
      severity: r.p.severity,
      billUsd: billOf(r.scopedBytes, opts.destination, r.p.avgEventBytes) * dollarScale,
      ...(r.p.skeleton ? { skeleton: r.p.skeleton } : {}),
      action,
      ...(movedBytes !== undefined ? { movedBytesMonthly: movedBytes } : {}),
      savedUsd,
      ...(move ? { addedUsd: move.tier_storage_added_usd, perEventMove: move } : {}),
      ...(denom === 'bytes' && action !== 'pass' ? { savedBytes: gained } : {}),
      keepsEverything: action === 'pass' || action === 'compact' || action === 'tier_down' || action === 'offload',
    };
  };

  // action[hash] chosen so far, and the running saving in the TARGET
  // denomination (dollars for percent/usd_budget, bytes for gb_budget).
  const chosen = new Map<string, { action: Action; saved: number }>();
  let savedAmount = 0;


  // Rung 1-2: the in-SIEM lever, biggest patterns first, until the target.
  if (inSiem === 'tier_down') {
    const settle = (): void => {
      const { moved } = tierDownMoves(new Set(chosen.keys()));
      const tierEvents = flexEventsOf(moved);
      savedAmount = 0;
      for (const [h, bytes] of moved) {
        const src = rowByHash.get(h)!;
        const saved = gain('tier_down', bytes, src.p.avgEventBytes, tierEvents);
        chosen.set(h, { action: 'tier_down', saved });
        tierDownMoved.set(h, bytes);
        savedAmount += saved;
      }
    };
    for (const r of rankedNonError) {
      if (savedAmount >= targetAmount) break;
      chosen.set(r.p.hash, { action: 'tier_down', saved: 0 });
      settle();
    }
    // Toward a dollar budget, Flex at a tier that adds more than the Standard
    // indexing it avoids is no lever: plan none of it.
    if (denom === 'usd' && perEvent && savedAmount <= 0) {
      chosen.clear();
      tierDownMoved.clear();
      savedAmount = 0;
    }
    // A pattern that moves nothing, under its container's cap or within what
    // the Receiver keeps over it, is not planned. Kept, it can raise its
    // container's cap, so the rest are counted again under the caps that leaves.
    for (;;) {
      const none = [...chosen.keys()].filter((h) => (tierDownMoved.get(h) ?? 0) <= 0);
      if (none.length === 0) break;
      for (const h of none) {
        chosen.delete(h);
        tierDownMoved.delete(h);
      }
      settle();
    }
  } else if (inSiem) {
    for (const r of rankedNonError) {
      if (savedAmount >= targetAmount) break;
      const saved = gain(inSiem, r.scopedBytes, r.p.avgEventBytes);
      if (saved <= 0) continue;
      chosen.set(r.p.hash, { action: inSiem, saved });
      savedAmount += saved;
    }
  }

  // Rung 3: escalate the biggest patterns to offload to close any shortfall,
  // still keeping everything (recoverable from the customer's S3). Upgrading a
  // pattern already on the in-SIEM lever adds only the delta.
  if (savedAmount < targetAmount * 0.9999 && canOffload) {
    for (const r of rankedNonError) {
      if (savedAmount >= targetAmount) break;
      const off = gain('offload', r.scopedBytes, r.p.avgEventBytes);
      const prev = chosen.get(r.p.hash);
      if (prev) {
        if (off <= prev.saved) continue;
        savedAmount += off - prev.saved;
      } else {
        if (off <= 0) continue;
        savedAmount += off;
      }
      chosen.set(r.p.hash, { action: 'offload', saved: off });
    }
  }

  // Rung 4-5: lossy, opt-in only, when the keep-everything ceiling falls short.
  if (savedAmount < targetAmount * 0.9999 && opts.allowLossy) {
    const lossy: Action = allowed.has('sample') ? 'sample' : 'drop';
    for (const r of rankedNonError) {
      if (savedAmount >= targetAmount) break;
      const l = gain(lossy, r.scopedBytes, r.p.avgEventBytes);
      const prev = chosen.get(r.p.hash);
      if (prev) {
        if (l <= prev.saved) continue;
        savedAmount += l - prev.saved;
      } else {
        if (l <= 0) continue;
        savedAmount += l;
      }
      chosen.set(r.p.hash, { action: lossy, saved: l });
    }
  }

  // One row per container that hosts a planned pattern, with the strongest
  // action among its patterns (the order the action-intent writer uses) and,
  // for tier_down, the cap that moves the planned patterns and no other.
  const ACTION_RANK: Record<string, number> = { drop: 5, offload: 4, tier_down: 3, compact: 2, sample: 1, pass: 0 };
  const containerCaps: Plan['containerCaps'] = {};
  const tierDownCaps = tierDownMoves(new Set([...chosen.entries()].filter(([, c]) => c.action === 'tier_down').map(([h]) => h))).caps;
  for (const r of rows) {
    const c = chosen.get(r.p.hash);
    if (!c) continue;
    const container = containerOf(r.p);
    // A pattern with no container has no engine key; unattributedPlanned counts it.
    if (container === '(unattributed)') continue;
    const current = containerCaps[container];
    if (!current || ACTION_RANK[c.action] > ACTION_RANK[current.action]) {
      const cap = tierDownCaps.get(container);
      containerCaps[container] = {
        action: c.action,
        capBytesMonthly: c.action === 'tier_down' ? (cap?.capBytesMonthly ?? 0) : 0,
        ...(c.action === 'tier_down' && cap
          ? {
              ...(cap.keptMaxPattern ? { keptMaxPattern: cap.keptMaxPattern } : {}),
              ...(cap.movedMinPattern ? { movedMinPattern: cap.movedMinPattern } : {}),
              separated: cap.separated,
              ...(cap.margin !== undefined ? { margin: cap.margin } : {}),
              keptMaxBytesMonthly: cap.keptMaxBytesMonthly,
              ...(cap.movedMinBytesMonthly !== undefined ? { movedMinBytesMonthly: cap.movedMinBytesMonthly } : {}),
            }
          : {}),
      };
    }
  }

  planFlexEvents = flexEventsOf(
    new Map([...tierDownMoved].filter(([h]) => chosen.get(h)?.action === 'tier_down')),
  );
  const planned: PlannedRow[] = [];
  const kept: PlannedRow[] = [];
  for (const r of ranked) {
    const c = chosen.get(r.p.hash);
    if (c) planned.push(build(r, c.action, c.saved));
    else kept.push(build(r, 'pass', 0));
  }

  // On a per-event tier every percentage is the Standard-index volume share,
  // whatever the target's denomination, so a dollar budget met with Flex
  // still prints no share of the bill.
  const indexVolumeOf = (rs: PlannedRow[], lever: (r: PlannedRow) => Action | 'pass'): number =>
    rs.reduce((s, pr) => {
      const src = rowByHash.get(pr.hash);
      if (!src) return s;
      const a = lever(pr);
      if (a === 'pass') return s;
      return s + (a === 'tier_down' ? (tierDownMoved.get(pr.hash) ?? 0) : saveBytes(a, src.scopedBytes, opts.destination, src.p.avgEventBytes));
    }, 0);
  const achievedPct =
    denom === 'usd' && perEvent
      ? bytesIn > 0 ? (indexVolumeOf(planned, (pr) => pr.action) * 100) / bytesIn : 0
      : poolTotal > 0 ? (savedAmount * 100) / poolTotal : 0;
  // percent keeps its half-point slack; a budget is a hard line — met means
  // the landing is at or under it (targetAmount 0 = already under budget).
  const met =
    target.kind === 'percent'
      ? achievedPct >= target.value - 0.5
      : savedAmount >= targetAmount * 0.9999;

  // Where the plan LANDS, in both denominations where tracked.
  const totalSavedUsd = planned.reduce((s, r) => s + r.savedUsd, 0);
  const totalAddedUsd = planned.reduce((s, r) => s + (r.addedUsd ?? 0), 0);
  const landsAtUsd = Math.max(0, billUsd - totalSavedUsd + totalAddedUsd);
  const flexMoves = planned.map((r) => r.perEventMove).filter((m): m is PerEventTierMove => !!m);
  const perEventMove = perEvent ? sumPerEventTierMoves(perEvent, flexMoves) : undefined;
  const landsAtBytesMonthly =
    denom === 'bytes' ? Math.max(0, bytesIn - savedAmount) : undefined;

  const fmtUsd = (v: number) => '$' + Number(v.toFixed(2)).toString();
  const fmtGb = (bytes: number) => Number((bytes / 1_000_000_000).toFixed(1)).toString() + ' GB';

  let gap: Plan['gap'] = null;
  if (!met && !opts.allowLossy) {
    const remainingPct = Math.max(0, derivedPct - achievedPct);
    const remedies: Array<'install_retriever' | 'accept_loss'> = [];
    // If offload would help but the retriever isn't installed, that's the
    // lossless remedy; otherwise the only way down is loss.
    // On the Standard-index volume basis offload moves no more than Flex
    // already does, so the retriever is not a remedy there.
    if (!opts.retrieverInstalled && allowed.has('offload') && !(denom === 'index_volume' && inSiem === 'tier_down')) {
      remedies.push('install_retriever');
    }
    remedies.push('accept_loss');
    const parts: string[] = [];
    if (remedies.includes('install_retriever')) {
      parts.push(
        'install the S3 retriever to offload these message types (keeps everything, recoverable on demand)',
      );
    }
    parts.push(
      allowed.has('sample')
        ? 'sample or drop them (lossy: you stop keeping some or all of these events)'
        : 'drop them (lossy: these events stop reaching the destination)',
    );
    const opening =
      target.kind === 'percent' && denom === 'index_volume'
        ? `Keeping everything, this plan moves ${Math.round(keepEverythingCeilingPct)}% of the volume out of the Standard index, ` +
          `${Math.round(remainingPct)} points short of the ${target.value}% target.`
        : target.kind === 'percent'
        ? `Keeping everything, this destination cuts ${Math.round(keepEverythingCeilingPct)}% of the bill, ` +
          `${Math.round(remainingPct)} points short of the ${target.value}% target.`
        : target.kind === 'usd_budget'
          ? `Keeping everything, this destination gets the bill to ${fmtUsd(landsAtUsd)}/mo against the ` +
            `${fmtUsd(target.value)}/mo budget, ${fmtUsd(Math.max(0, landsAtUsd - target.value))}/mo over` +
            (perEventMove?.unpriced ? ', counting priced lines only (Flex compute is unpriced and excluded).' : '.')
          : `Keeping everything, this destination gets ingest to ${fmtGb(landsAtBytesMonthly ?? bytesIn)}/mo against the ` +
            `${fmtGb(target.value * 1_000_000_000)}/mo budget, ` +
            `${fmtGb(Math.max(0, (landsAtBytesMonthly ?? bytesIn) - target.value * 1_000_000_000))}/mo over.` +
            (lever === 'tier_down'
              ? ' tier_down keeps every byte in the destination, so it cannot reduce volume.'
              : '');
    gap = {
      remainingPct,
      remedies,
      message: `${opening} To close it, ${parts.join(', or ')}.`,
    };
  }

  // The pricing basis, stated once so every rendered dollar has its source on
  // the page. Two provenances: the destination's list-price cost model
  // (default), or the customer's blended rate scaled over the list structure.
  const model = getDestinationCostModel(opts.destination);
  const rate = (v: number) => '$' + Number(v.toFixed(4)).toString();
  const ingestLabel = model.ingest_label ?? 'ingest';
  const structureParts: string[] = [];
  if (lever === 'tier_down' && perEvent) {
    // Per-event list prices, never a per-GB Flex rate: the retired $1.00/GB
    // was a 0.6 fraction of the bill wearing a rate's name.
    structureParts.push(
      `${model.tier_down_target_tier!.name} priced per event at list: Standard indexing avoided ` +
        `${fmtListRate(perEvent.standard_index_usd_per_million_events)} per million events (${perEvent.standard_index_retention_days}-day retention), ` +
        `${describePerEventTierRate(perEvent, perEventMove?.pricing_tier)} (${perEvent.source})`,
    );
  } else if (lever === 'tier_down' && model.tier_down_target_tier) {
    structureParts.push(
      `${model.tier_down_target_tier.name} ingest ${rate(model.tier_down_target_tier.ingest_rate_usd_per_gb)}/GB`,
    );
  }
  const compactFigure = lever === 'compact' ? describeCompactFigure(model) : null;
  if (compactFigure) structureParts.push(`compact ${compactFigure}`);
  // Prerequisites for the levers this plan actually uses — not the menu.
  const usedActions = new Set(planned.map((r) => r.action));
  const prerequisites: string[] = [];
  if (usedActions.has('compact') && model.compact_requires) prerequisites.push(model.compact_requires);
  if (usedActions.has('tier_down') && model.tier_down_requires) prerequisites.push(model.tier_down_requires);
  if (usedActions.has('offload')) {
    prerequisites.push('the S3 retriever installed, so offloaded events stay recoverable');
  }

  const rateSource: 'list_price' | 'customer_supplied' = dollarScale !== 1 ? 'customer_supplied' : 'list_price';
  let rateBasis: string;
  if (rateSource === 'customer_supplied') {
    rateBasis =
      `${opts.destination} at your rate: ${rate(opts.customerRatePerGb!)}/GB all-in (customer supplied)` +
      (structureParts.length > 0 ? `; lever ratios from list structure: ${structureParts.join(', ')}` : '');
  } else {
    const basisParts = [`${opts.destination} ${defaultRateLabel(opts.destination)}: ${ingestLabel} ${rate(model.ingest_per_gb)}/GB`];
    if (model.storage_per_gb_month > 0) {
      basisParts.push(`storage ${rate(model.storage_per_gb_month)}/GB-mo`);
    }
    basisParts.push(...structureParts);
    rateBasis = basisParts.join(', ');
  }

  // A compute-billed destination prices from a model, so the plan says so
  // rather than handing a renderer a bare number. The notes come off a `pass`
  // projection because that is the one projection every plan computes for
  // every pattern, and the compute term attaches its sentences there too.
  const modeledNotes = projectAction({
    action: 'pass',
    bytes_in: Math.max(1, bytesIn),
    destination: opts.destination,
  }).notes;
  const planModeled = model.compute != null;
  const planModeledNote = model.compute
    ? `Modeled. On ${opts.destination} the per-GB rate above is a storage rate, not the bill: the bill is ` +
      `compute, priced from a measured rows-to-CPU curve and a unit floor of ${model.compute.min_units} ` +
      `that is ASSUMED.`
    : undefined;

  // What the moved figures leave behind, and on how many nodes.
  const tierDownRows = planned.filter((r) => r.action === 'tier_down');
  const floorNotes: string[] = [];
  if (tierDownRows.length > 0) {
    const levels = ERROR_CLASS_LEVELS.join(', ').replace(/, (\w+)$/, ' or $1');
    const unknown = [...new Set(tierDownRows.map((r) => r.dominantService))].filter(
      (c) => !(Number(opts.nodesByContainer?.[c]) >= 1),
    );
    const unsized = tierDownRows.filter((r) => !((rowByHash.get(r.hash)?.p.avgEventBytes ?? 0) > 0)).length;
    floorNotes.push(
      `tier_down moves a planned statement's lines over its cap except what the Receiver passes whatever the cap: ` +
        `the first ${ALWAYS_PASS_LINES} lines of each statement and, for an ${levels} statement, ${KEEP_COUNT_DEFAULT} lines over the cap, ` +
        `every ${REGULATOR_WINDOW_SECONDS / 60}-minute window on each node.` +
        (unknown.length > 0
          ? ` Node count unknown for ${unknown.join(', ')}: counted as one node. Each further node keeps as much again, so the moved figures there are the most that moves.`
          : '') +
        (unsized > 0 ? ` ${unsized} planned statement${unsized === 1 ? ' carries' : 's carry'} no line size, so nothing is kept back from ${unsized === 1 ? 'its' : 'their'} moved figure${unsized === 1 ? '' : 's'}.` : ''),
    );
  }
  const notes = [...new Set([...(modeledNotes ?? []), ...floorNotes])];

  return {
    destination: opts.destination,
    retrieverInstalled: opts.retrieverInstalled,
    scope: opts.scope ?? 'all',
    target,
    // A dollar budget on a per-event tier chases dollars, so its derived
    // percentage would be a share of the bill. None is stated there.
    targetPct:
      target.kind === 'percent' ? target.value
      : denom === 'usd' && perEvent ? 0
      : Math.round(derivedPct * 10) / 10,
    percentBasis,
    billUsd,
    keepEverythingLever: lever,
    keepEverythingCeilingPct,
    achievedPct,
    met,
    totalSavedUsd,
    ...(perEvent ? { totalAddedUsd } : {}),
    ...(perEventMove ? { perEventMove } : {}),
    rateBasis,
    rateSource,
    modeled: planModeled,
    ...(planModeledNote ? { modeledNote: planModeledNote } : {}),
    ...(notes.length ? { notes } : {}),
    prerequisites,
    ...(rateSource === 'customer_supplied' ? { customerRatePerGb: opts.customerRatePerGb } : {}),
    bytesInMonthly: bytesIn,
    ...(keptRaw.length > 0 ? { keptRaw } : {}),
    containerCaps,
    ...(denom === 'index_volume' ? {} : { landsAtUsd }),
    ...(landsAtBytesMonthly !== undefined ? { landsAtBytesMonthly } : {}),
    planned,
    kept,
    gap,
  };
}
