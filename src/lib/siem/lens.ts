/**
 * SIEM pricing/applicability lens — "what would this look like on <SIEM>?"
 *
 * The demo pipeline (and any single customer env) has ONE actual destination,
 * but prospects evaluate against THEIR stack. The lens lets a cost-bearing
 * tool price the SAME real volumes at a different destination's list rates
 * and gate actions by that destination's rules, without pretending the
 * pipeline destination changed.
 *
 * Honesty contract (enforced by callers via this resolution):
 *   - Volumes/patterns are never lensed — they are real measurements.
 *   - A lensed run ALWAYS prices at the lens destination's list price
 *     (the env-configured analyzerCost belongs to the ACTUAL destination
 *     and must not leak into another SIEM's story). An explicit caller
 *     rate arg still wins — that is the caller asserting their own rate
 *     for the lens.
 *   - Applicability gating (compact/tier_down/...) follows the lens.
 *   - The envelope stamps both sides (siem_actual / siem_lens) so a
 *     receipt reader can verify the story matches the math.
 */

import type { SiemId } from './pricing.js';
import { DEFAULT_ANALYZER_COST_PER_GB, SIEM_DISPLAY_NAMES } from './pricing.js';
import { parseAnalyzerEnv } from '../environments.js';

/** The destinations a lens may target = the destinations we can price. */
export const SIEM_LENS_IDS = Object.keys(DEFAULT_ANALYZER_COST_PER_GB) as SiemId[];

export interface SiemLensResolution {
  /** Canonical actual destination of the connected pipeline (null if unknown). */
  actual: SiemId | null;
  /** Destination in effect for pricing + applicability. */
  effective: SiemId | null;
  /** True iff a lens was requested and differs from the actual destination. */
  lensed: boolean;
  /** Where `effective` came from. */
  basis: 'requested' | 'detected' | 'none';
  /** Display name of the effective destination (null when effective is null). */
  display: string | null;
  /**
   * One-line, render-ready provenance note when lensed; callers surface it
   * near any dollar figure. Null when not lensed.
   */
  disclosure: string | null;
}

/** Normalize an arbitrary analyzer/SIEM string to a priceable SiemId, else null. */
export function toSiemId(raw: string | undefined | null): SiemId | null {
  if (!raw) return null;
  // Models occasionally double-wrap the value in quotes ("\"splunk\"") when
  // copying example syntax; strip stray quoting before normalizing.
  const cleaned = String(raw).trim().replace(/^["']+|["']+$/g, '').trim();
  if (!cleaned) return null;
  // parseAnalyzerEnv passes unrecognized values through VERBATIM (original
  // case), so lowercase first — otherwise canonical-but-miscased ids with no
  // alias branch (e.g. "ClickHouse") would fail to resolve.
  const lower = cleaned.toLowerCase();
  const canon = parseAnalyzerEnv(lower) ?? lower;
  return (SIEM_LENS_IDS as string[]).includes(canon) ? (canon as SiemId) : null;
}

/**
 * Resolve the effective destination for a tool run.
 *
 * A lens is "in effect" when the EFFECTIVE destination differs from the env's
 * ACTUAL destination. The effective destination is derived from EITHER the
 * explicit `siem_lens` arg OR a passed-through `destination`, in that order.
 * This single-derivation rule closes the class of bug where one transport
 * (destination) carries the what-if but the lens flag is computed from another
 * (siem_lens) and silently reads false.
 *
 * @param requested  the tool's `siem_lens` arg (validated upstream by the
 *                   Zod enum, but tolerated loosely here for direct callers)
 * @param envAnalyzer the resolved env's analyzer (env.analyzer), raw form
 * @param destination optional resolved destination (e.g. cost_options'
 *                   effectiveDestination). Used only as a fallback source of
 *                   the effective destination when `requested` is absent. A
 *                   destination equal to the actual env destination yields
 *                   lensed:false (it is NOT a what-if).
 */
export function resolveSiemLens(
  requested: string | undefined | null,
  envAnalyzer: string | undefined | null,
  destination?: string | undefined | null,
): SiemLensResolution {
  const actual = toSiemId(envAnalyzer);
  const reqFromLens = toSiemId(requested);
  if (requested != null && String(requested).trim() !== '' && reqFromLens === null) {
    throw new Error(
      `siem_lens "${requested}" is not a priceable destination. Valid values: ${SIEM_LENS_IDS.join(', ')}.`,
    );
  }
  // Effective destination: explicit siem_lens wins, else the passed-through
  // destination. A bad destination string is tolerated (passes through to
  // null) — unlike siem_lens, `destination` is not a lens assertion and must
  // not throw here.
  const req = reqFromLens ?? toSiemId(destination);
  // `basis: 'requested'` reflects that the effective came from an explicit
  // lens/destination request (either transport), as opposed to env detection.
  if (req && req !== actual) {
    return {
      actual,
      effective: req,
      lensed: true,
      basis: 'requested',
      display: SIEM_DISPLAY_NAMES[req],
      disclosure:
        `Lens: priced and gated for ${SIEM_DISPLAY_NAMES[req]} at list rates; ` +
        `the connected pipeline's destination is ${actual ? SIEM_DISPLAY_NAMES[actual] : 'unknown'}. ` +
        `Volumes are real measurements; only the rate card and action applicability follow the lens.`,
    };
  }
  if (req && req === actual) {
    // Explicit lens equal to the actual destination: not a what-if.
    return { actual, effective: actual, lensed: false, basis: 'requested', display: SIEM_DISPLAY_NAMES[actual!], disclosure: null };
  }
  return {
    actual,
    effective: actual,
    lensed: false,
    basis: actual ? 'detected' : 'none',
    display: actual ? SIEM_DISPLAY_NAMES[actual] : null,
    disclosure: null,
  };
}

/**
 * source_disclosure fragment every lens-aware tool spreads into its envelope.
 * Stamped even when not lensed (so readers can rely on the field's presence
 * wherever the arg is supported).
 */
export function lensDisclosure(res: SiemLensResolution): {
  siem_actual?: string;
  siem_lens?: string;
  siem_lens_basis: 'requested' | 'detected' | 'none';
} {
  return {
    ...(res.actual ? { siem_actual: res.actual } : {}),
    ...(res.lensed && res.effective ? { siem_lens: res.effective } : {}),
    siem_lens_basis: res.basis,
  };
}

/** Zod-enum-ready list for tool schemas. */
export const SIEM_LENS_ENUM = SIEM_LENS_IDS as [SiemId, ...SiemId[]];
