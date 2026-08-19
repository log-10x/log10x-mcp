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

export interface SolveOpts {
  destination: SiemId;
  /** Whether the S3 retriever is installed. Gates the offload rung. */
  retrieverInstalled: boolean;
  /** Reduction goal as a percent of the (scoped) bill, e.g. 50. */
  targetPct: number;
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
}

export interface PlannedRow {
  hash: string;
  name: string;
  dominantService: string;
  serviceMix: { service: string; sharePct: number }[];
  severity: string;
  billUsd: number;
  action: Action | 'pass';
  savedUsd: number;
  keepsEverything: boolean;
}

export interface Plan {
  destination: SiemId;
  retrieverInstalled: boolean;
  scope: string[] | 'all';
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

export function solvePlan(patterns: SolverPattern[], opts: SolveOpts): Plan {
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

  const billUsd = rows.reduce(
    (s, r) => s + billOf(r.scopedBytes, opts.destination, r.p.avgEventBytes),
    0,
  );
  const targetUsd = (opts.targetPct / 100) * billUsd;

  const allowed = new Set(getAllowedActionsForDestination(opts.destination));
  const canOffload = opts.retrieverInstalled && allowed.has('offload');
  // The in-SIEM keep-everything lever (compact/tier_down), separate from offload
  // so the two can be applied as an escalation, not an either/or.
  const inSiem: Action | null =
    lever === 'compact' || lever === 'tier_down' ? lever : null;

  // Keep-everything ceiling = the DEEPEST keep-everything rung on every
  // non-error pattern. offload (when the retriever is present) removes the
  // event from the SIEM, so it is the deepest lossless cut; otherwise the
  // in-SIEM lever caps it.
  const deepest: Action | null = canOffload ? 'offload' : inSiem;
  const nonError = rows.filter((r) => !isPinned(r.p));
  const ceilingUsd = deepest
    ? nonError.reduce(
        (s, r) => s + saveUsd(deepest, r.scopedBytes, opts.destination, r.p.avgEventBytes),
        0,
      )
    : 0;
  const keepEverythingCeilingPct = billUsd > 0 ? (ceilingUsd * 100) / billUsd : 0;

  // Rank by bill (biggest cost first).
  const ranked = [...rows].sort(
    (a, b) => billOf(b.scopedBytes, opts.destination, b.p.avgEventBytes) - billOf(a.scopedBytes, opts.destination, a.p.avgEventBytes),
  );
  const rankedNonError = ranked.filter((r) => !isPinned(r.p));

  const build = (r: (typeof rows)[number], action: Action | 'pass', saved: number): PlannedRow => {
    const { dominant, mix } = serviceMix(r.p.services);
    return {
      hash: r.p.hash,
      name: r.p.name,
      dominantService: dominant,
      serviceMix: mix,
      severity: r.p.severity,
      billUsd: billOf(r.scopedBytes, opts.destination, r.p.avgEventBytes),
      action,
      savedUsd: saved,
      keepsEverything: action === 'pass' || action === 'compact' || action === 'tier_down' || action === 'offload',
    };
  };

  // action[hash] chosen so far, and the running dollar saving.
  const chosen = new Map<string, { action: Action; saved: number }>();
  let savedUsd = 0;

  // Rung 1-2: the in-SIEM lever, biggest patterns first, until the target.
  if (inSiem) {
    for (const r of rankedNonError) {
      if (savedUsd >= targetUsd) break;
      const saved = saveUsd(inSiem, r.scopedBytes, opts.destination, r.p.avgEventBytes);
      if (saved <= 0) continue;
      chosen.set(r.p.hash, { action: inSiem, saved });
      savedUsd += saved;
    }
  }

  // Rung 3: escalate the biggest patterns to offload to close any shortfall,
  // still keeping everything (recoverable from the customer's S3). Upgrading a
  // pattern already on the in-SIEM lever adds only the delta.
  if (savedUsd < targetUsd * 0.9999 && canOffload) {
    for (const r of rankedNonError) {
      if (savedUsd >= targetUsd) break;
      const off = saveUsd('offload', r.scopedBytes, opts.destination, r.p.avgEventBytes);
      const prev = chosen.get(r.p.hash);
      if (prev) {
        if (off <= prev.saved) continue;
        savedUsd += off - prev.saved;
      } else {
        if (off <= 0) continue;
        savedUsd += off;
      }
      chosen.set(r.p.hash, { action: 'offload', saved: off });
    }
  }

  // Rung 4-5: lossy, opt-in only, when the keep-everything ceiling falls short.
  if (savedUsd < targetUsd * 0.9999 && opts.allowLossy) {
    const lossy: Action = allowed.has('sample') ? 'sample' : 'drop';
    for (const r of rankedNonError) {
      if (savedUsd >= targetUsd) break;
      const l = saveUsd(lossy, r.scopedBytes, opts.destination, r.p.avgEventBytes);
      const prev = chosen.get(r.p.hash);
      if (prev) {
        if (l <= prev.saved) continue;
        savedUsd += l - prev.saved;
      } else {
        if (l <= 0) continue;
        savedUsd += l;
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

  const achievedPct = billUsd > 0 ? (savedUsd * 100) / billUsd : 0;
  const met = achievedPct >= opts.targetPct - 0.5;

  let gap: Plan['gap'] = null;
  if (!met && !opts.allowLossy) {
    const remainingPct = Math.max(0, opts.targetPct - achievedPct);
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
    gap = {
      remainingPct,
      remedies,
      message:
        `Keeping everything, this destination cuts ${Math.round(keepEverythingCeilingPct)}% of the bill — ` +
        `${Math.round(remainingPct)} short of your ${opts.targetPct}% target. To close it, ${parts.join(', or ')}.`,
    };
  }

  return {
    destination: opts.destination,
    retrieverInstalled: opts.retrieverInstalled,
    scope: opts.scope ?? 'all',
    targetPct: opts.targetPct,
    billUsd,
    keepEverythingLever: lever,
    keepEverythingCeilingPct,
    achievedPct,
    met,
    planned,
    kept,
    gap,
  };
}
