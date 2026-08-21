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

import {
  getAllowedActionsForDestination,
  getDestinationCostModel,
  compactsInPlace,
  projectAction,
  type Action,
} from './cost.js';
import { type SiemId } from './siem/pricing.js';
import { isProtectedSeverity } from './severity-policy.js';

/** True ladder order: keep-everything (in-SIEM before out) then lossy. */
const LADDER: Action[] = ['compact', 'tier_down', 'offload', 'sample', 'drop'];

/** One pattern (message type) as the solver consumes it. */
export interface SolverPattern {
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
  /** Total observed bytes for the pattern (over whatever window the caller
   *  measured — the plan is percentage-correct at any scale). */
  bytes: number;
  /** Average event size in bytes; degrades the compact ratio for tiny events. */
  avgEventBytes?: number;
}

/**
 * What the plan is solving FOR. Three denominations:
 *  - percent:    "cut X% of the bill" — a one-shot project.
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
  savedUsd: number;
  /** Volume-budget plans only: bytes this row removes from the billed wire. */
  savedBytes?: number;
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
  billUsd: number;
  /** The keep-everything lever the destination resolves to (rung 1-3), or null
   *  when only lossy rungs remain. */
  keepEverythingLever: Action | null;
  /** Max percent of the bill removable while keeping everything (rungs 1-3 on
   *  every non-error pattern). */
  keepEverythingCeilingPct: number;
  achievedPct: number;
  met: boolean;
  /** Sum of planned rows' savedUsd — equals billUsd minus landsAtUsd, so the
   *  arithmetic on a rendered plan closes visibly. */
  totalSavedUsd: number;
  /** The pricing basis behind every dollar on this plan, one human-readable
   *  line. Render it verbatim. */
  rateBasis: string;
  /** Whose dollars these are: the destination list-price model, or the
   *  customer's supplied blended rate scaled over the list structure. */
  rateSource: 'list_price' | 'customer_supplied';
  /** Echo of the supplied blended rate when rateSource is customer_supplied. */
  customerRatePerGb?: number;
  /** Total scoped bytes/mo behind the bill — the reconciliation multiplicand:
   *  bytesInMonthly times the rate should foot against the invoice line. */
  bytesInMonthly: number;
  /** usd_budget / percent targets: the bill after the plan, in $/mo. */
  landsAtUsd?: number;
  /** gb_budget targets: monthly bytes toward the destination after the plan. */
  landsAtBytesMonthly?: number;
  planned: PlannedRow[];
  kept: PlannedRow[];
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
): Action | null {
  const allowed = new Set(getAllowedActionsForDestination(destination));
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
    prev.bytes += p.bytes;
    for (const [svc, b] of Object.entries(p.services)) {
      prev.services[svc] = (prev.services[svc] ?? 0) + b;
    }
    if (isProtectedSeverity(p.severity) && !isProtectedSeverity(prev.severity)) {
      prev.severity = p.severity;
    }
    if (prev.avgEventBytes !== undefined && p.avgEventBytes !== undefined) {
      prev.avgEventBytes = (prev.avgEventBytes + p.avgEventBytes) / 2;
    }
  }
  const patterns = [...byHash.values()];

  const scopeSet =
    opts.scope && opts.scope !== 'all' ? new Set(opts.scope) : null;
  const lever = keepEverythingLever(opts.destination, opts.retrieverInstalled);

  // Scope: keep patterns touching a scoped service; weight by scoped bytes.
  const exceptions = new Set(
    (opts.exceptionServices ?? []).map((x) => x.toLowerCase()),
  );
  const isPinned = (p: SolverPattern): boolean => {
    if (isProtectedSeverity(p.severity)) return true;
    if (exceptions.size === 0) return false;
    const { dominant } = serviceMix(p.services);
    return exceptions.has(dominant.toLowerCase());
  };

  const rows = patterns
    .map((p) => {
      const scopedBytes = scopeSet
        ? Object.entries(p.services)
            .filter(([s]) => scopeSet.has(s))
            .reduce((s, [, b]) => s + b, 0)
        : p.bytes;
      return { p, scopedBytes };
    })
    .filter((r) => r.scopedBytes > 0);

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
  const denom: 'usd' | 'bytes' = target.kind === 'gb_budget' ? 'bytes' : 'usd';
  const poolTotal = denom === 'usd' ? billUsd : bytesIn;
  const targetAmount =
    target.kind === 'percent' ? (target.value / 100) * billUsd
    : target.kind === 'usd_budget' ? Math.max(0, billUsd - target.value)
    : Math.max(0, bytesIn - target.value * 1_000_000_000);
  const derivedPct = poolTotal > 0 ? (targetAmount * 100) / poolTotal : 0;
  /** The denomination's gain function: dollars off the bill, or bytes off the wire. */
  const gain = (action: Action, bytes: number, avg: number | undefined): number =>
    denom === 'usd'
      ? saveUsd(action, bytes, opts.destination, avg) * dollarScale
      : saveBytes(action, bytes, opts.destination, avg);

  const allowed = new Set(getAllowedActionsForDestination(opts.destination));
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
  const ceilingAmount = deepest
    ? nonError.reduce(
        (s, r) => s + gain(deepest, r.scopedBytes, r.p.avgEventBytes),
        0,
      )
    : 0;
  const keepEverythingCeilingPct = poolTotal > 0 ? (ceilingAmount * 100) / poolTotal : 0;

  // Rank by bill (biggest cost first).
  const ranked = [...rows].sort(
    (a, b) => billOf(b.scopedBytes, opts.destination, b.p.avgEventBytes) - billOf(a.scopedBytes, opts.destination, a.p.avgEventBytes),
  );
  const rankedNonError = ranked.filter((r) => !isPinned(r.p));

  const build = (r: (typeof rows)[number], action: Action | 'pass', gained: number): PlannedRow => {
    // Row display is ALWAYS dollars; on a volume target the greedy ran on
    // bytes, so recompute the dollar figure for the card.
    const savedUsd =
      action === 'pass' ? 0
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
      action,
      savedUsd,
      ...(denom === 'bytes' && action !== 'pass' ? { savedBytes: gained } : {}),
      keepsEverything: action === 'pass' || action === 'compact' || action === 'tier_down' || action === 'offload',
    };
  };

  // action[hash] chosen so far, and the running saving in the TARGET
  // denomination (dollars for percent/usd_budget, bytes for gb_budget).
  const chosen = new Map<string, { action: Action; saved: number }>();
  let savedAmount = 0;

  // Rung 1-2: the in-SIEM lever, biggest patterns first, until the target.
  if (inSiem) {
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

  const planned: PlannedRow[] = [];
  const kept: PlannedRow[] = [];
  for (const r of ranked) {
    const c = chosen.get(r.p.hash);
    if (c) planned.push(build(r, c.action, c.saved));
    else kept.push(build(r, 'pass', 0));
  }

  const achievedPct = poolTotal > 0 ? (savedAmount * 100) / poolTotal : 0;
  // percent keeps its half-point slack; a budget is a hard line — met means
  // the landing is at or under it (targetAmount 0 = already under budget).
  const met =
    target.kind === 'percent'
      ? achievedPct >= target.value - 0.5
      : savedAmount >= targetAmount * 0.9999;

  // Where the plan LANDS, in both denominations where tracked.
  const totalSavedUsd = planned.reduce((s, r) => s + r.savedUsd, 0);
  const landsAtUsd = Math.max(0, billUsd - totalSavedUsd);
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
    if (!opts.retrieverInstalled && allowed.has('offload')) {
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
        ? 'sample or drop them (lossy — you stop keeping some or all of these events)'
        : 'drop them (lossy — these events stop reaching the destination)',
    );
    const opening =
      target.kind === 'percent'
        ? `Keeping everything, this destination cuts ${Math.round(keepEverythingCeilingPct)}% of the bill, ` +
          `${Math.round(remainingPct)} points short of the ${target.value}% target.`
        : target.kind === 'usd_budget'
          ? `Keeping everything, this destination gets the bill to ${fmtUsd(landsAtUsd)}/mo against the ` +
            `${fmtUsd(target.value)}/mo budget, ${fmtUsd(Math.max(0, landsAtUsd - target.value))}/mo over.`
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
  if (lever === 'tier_down' && model.tier_down_target_tier) {
    structureParts.push(
      `${model.tier_down_target_tier.name} ingest ${rate(model.tier_down_target_tier.ingest_rate_usd_per_gb)}/GB`,
    );
  }
  if (lever === 'compact' && model.compact_mode !== 'no-op') {
    structureParts.push(
      `compact assumed ${Math.round(model.compact_ratio_low * 100)}-${Math.round(model.compact_ratio_high * 100)}% of original size`,
    );
  }
  const rateSource: 'list_price' | 'customer_supplied' = dollarScale !== 1 ? 'customer_supplied' : 'list_price';
  let rateBasis: string;
  if (rateSource === 'customer_supplied') {
    rateBasis =
      `${opts.destination} at your rate: ${rate(opts.customerRatePerGb!)}/GB all-in (customer supplied)` +
      (structureParts.length > 0 ? `; lever ratios from list structure: ${structureParts.join(', ')}` : '');
  } else {
    const basisParts = [`${opts.destination} list price: ${ingestLabel} ${rate(model.ingest_per_gb)}/GB`];
    if (model.storage_per_gb_month > 0) {
      basisParts.push(`storage ${rate(model.storage_per_gb_month)}/GB-mo`);
    }
    basisParts.push(...structureParts);
    rateBasis = basisParts.join(', ');
  }

  return {
    destination: opts.destination,
    retrieverInstalled: opts.retrieverInstalled,
    scope: opts.scope ?? 'all',
    target,
    targetPct: target.kind === 'percent' ? target.value : Math.round(derivedPct * 10) / 10,
    billUsd,
    keepEverythingLever: lever,
    keepEverythingCeilingPct,
    achievedPct,
    met,
    totalSavedUsd,
    rateBasis,
    rateSource,
    ...(rateSource === 'customer_supplied' ? { customerRatePerGb: opts.customerRatePerGb } : {}),
    bytesInMonthly: bytesIn,
    landsAtUsd,
    ...(landsAtBytesMonthly !== undefined ? { landsAtBytesMonthly } : {}),
    planned,
    kept,
    gap,
  };
}
