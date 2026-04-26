/**
 * Shared SIEM-vendor resolution.
 *
 * Every vendor-taking tool (poc_from_siem_submit, dependency_check,
 * exclusion_filter, advise_*) used to roll its own "is the user explicit
 * or should we sniff env vars?" logic. This module centralizes that, so
 * the same priority + ambiguity rules apply everywhere:
 *
 *   1. Explicit id wins, no probing.
 *   2. Otherwise discover all configured connectors in parallel.
 *   3. Single available → use it.
 *   4. Multiple → prefer the one whose creds came from explicit env
 *      vars over ambient (AWS instance role / SSO chain). If a single
 *      env-source winner exists → use it. Otherwise → ambiguous.
 *   5. None → caller decides whether to fall back to bash, error out,
 *      or use a default.
 *
 * Tools that only support a subset of SIEMs (dep-check covers 4 of 8;
 * exclusion_filter SIEM subset covers the same 4) pass `restrictTo` to
 * scope discovery — both ambiguity and none-found resolve against the
 * narrower set.
 */

import {
  ALL_CONNECTORS,
  discoverAvailable,
  type CredentialSource,
  type DiscoveredConnector,
} from './index.js';
import type { SiemId } from './pricing.js';
import { SIEM_DISPLAY_NAMES } from './pricing.js';

export type SelectionMethod = 'explicit' | 'sole' | 'preferred-explicit-env';

export interface AmbiguousCandidate {
  id: SiemId;
  displayName: string;
  source: CredentialSource;
}

export type ResolveResult =
  | {
      kind: 'resolved';
      id: SiemId;
      displayName: string;
      selectionMethod: SelectionMethod;
      /** Human note suitable for the report header; undefined when explicit. */
      note?: string;
    }
  | {
      kind: 'ambiguous';
      candidates: AmbiguousCandidate[];
    }
  | {
      kind: 'none';
      probedIds: SiemId[];
    };

export interface ResolveOptions {
  /** When provided, bypass discovery and accept the user-supplied id verbatim. */
  explicit?: string;
  /**
   * When provided, only consider these SIEMs during auto-detect. The
   * full registry is filtered to this set before discovery runs, so
   * ambiguity is computed on the narrower scope too.
   */
  restrictTo?: SiemId[];
}

export async function resolveSiemSelection(opts: ResolveOptions): Promise<ResolveResult> {
  const restrictSet = opts.restrictTo ? new Set(opts.restrictTo) : null;
  const candidates = restrictSet
    ? ALL_CONNECTORS.filter((c) => restrictSet.has(c.id))
    : ALL_CONNECTORS;
  const candidateIds = candidates.map((c) => c.id);

  if (opts.explicit) {
    const id = opts.explicit as SiemId;
    if (!candidateIds.includes(id)) {
      throw new Error(
        `Unknown SIEM id "${opts.explicit}". Valid: ${candidateIds.join(', ')}.`
      );
    }
    return {
      kind: 'resolved',
      id,
      displayName: SIEM_DISPLAY_NAMES[id] || id,
      selectionMethod: 'explicit',
    };
  }

  const all = await discoverAvailable();
  const available: DiscoveredConnector[] = all
    .filter((d) => d.detection.available)
    .filter((d) => candidateIds.includes(d.id));

  if (available.length === 0) {
    return { kind: 'none', probedIds: candidateIds };
  }

  if (available.length === 1) {
    const one = available[0];
    const note =
      one.detection.source === 'ambient'
        ? `Detected ambient credentials for ${one.displayName} — assuming ${one.id}. Override with \`vendor=<other>\` if wrong.`
        : `Auto-detected ${one.displayName}.`;
    return {
      kind: 'resolved',
      id: one.id,
      displayName: one.displayName,
      selectionMethod: 'sole',
      note,
    };
  }

  // Multiple — prefer explicit env over ambient (AWS instance role chain etc.).
  const explicitEnv = available.filter((d) => d.detection.source === 'env');
  if (explicitEnv.length === 1) {
    const winner = explicitEnv[0];
    const others = available.filter((d) => d.id !== winner.id).map((d) => d.id);
    return {
      kind: 'resolved',
      id: winner.id,
      displayName: winner.displayName,
      selectionMethod: 'preferred-explicit-env',
      note: `Auto-detected ${winner.displayName} via explicit env vars (others available: ${others.join(', ')}).`,
    };
  }

  return {
    kind: 'ambiguous',
    candidates: available.map((d) => ({
      id: d.id,
      displayName: d.displayName,
      source: d.detection.source,
    })),
  };
}

/**
 * Render an ambiguous-resolution result as the markdown error body the
 * MCP tool wrap fn surfaces back to the caller. Naming the arg is the
 * caller's job — `vendor` for dep-check / exclusion_filter, `siem` for
 * poc_from_siem, `destination` for advise_*.
 */
export function formatAmbiguousError(
  candidates: AmbiguousCandidate[],
  argName: string
): string {
  const ids = candidates.map((c) => c.id).join(', ');
  const detail = candidates
    .map((c) => `  - ${c.id} (${c.displayName}, source: ${c.source})`)
    .join('\n');
  return [
    `Multiple SIEMs detected (${ids}). Pass \`${argName}=<name>\` to disambiguate.`,
    '',
    'Detected:',
    detail,
  ].join('\n');
}

/**
 * Render a no-creds result. Caller supplies a hint so the message can
 * point users at the right env-var docs (e.g., "see log10x_doctor for
 * per-SIEM discovery detail").
 */
export function formatNoneError(probedIds: SiemId[], hint: string): string {
  return (
    `No SIEM credentials detected. Set credentials for one of: ${probedIds.join(', ')}. ` +
    hint
  );
}
