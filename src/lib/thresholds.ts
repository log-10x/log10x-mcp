/**
 * Configurable thresholds for log10x_investigate.
 *
 * Defaults match the spec. Overrides load from a JSON file pointed at by
 * LOG10X_THRESHOLDS_FILE at process startup — the file is merged against
 * the defaults, so users only need to specify the keys they care about.
 *
 * Future: the canonical source is the Reducer policy file (git-versioned,
 * PR-reviewed) alongside the mute entries. Wire that once the Reporter
 * config-read path exists.
 */

import { readFileSync } from 'fs';

export interface InvestigateThresholds {
  retrieverEscalationThreshold: number;
  cleanChainThreshold: number;
  acuteNoiseFloor: number; // events/sec sustained
  driftMinSlopePerWeek: {
    error: number;
    warn: number;
    info: number;
    debug: number;
    default: number;
  };
  maxCoMoversForLag: number;
  maxParallelPromqlQueries: number;
  lagSoftTimeoutMs: number;
  lagHardTimeoutMs: number;
  investigationSoftTimeoutMs: number;
  investigationHardTimeoutMs: number;
  maxCohortSize: number;
}

const SPEC_DEFAULTS: InvestigateThresholds = {
  retrieverEscalationThreshold: 0.5,
  cleanChainThreshold: 0.7,
  acuteNoiseFloor: 0.001,
  driftMinSlopePerWeek: {
    error: 0.01,
    warn: 0.02,
    info: 0.03,
    debug: 0.05,
    default: 0.03,
  },
  maxCoMoversForLag: 8,
  maxParallelPromqlQueries: 30,
  lagSoftTimeoutMs: 15_000,
  lagHardTimeoutMs: 30_000,
  investigationSoftTimeoutMs: 30_000,
  investigationHardTimeoutMs: 60_000,
  maxCohortSize: 20,
};

/**
 * Load thresholds from LOG10X_THRESHOLDS_FILE if set, merged against
 * SPEC_DEFAULTS. Invalid files are logged to stderr and the defaults
 * are returned unchanged — threshold loading never crashes the server.
 */
function loadThresholds(): InvestigateThresholds {
  const path = process.env.LOG10X_THRESHOLDS_FILE;
  if (!path) return SPEC_DEFAULTS;

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<InvestigateThresholds> & {
      driftMinSlopePerWeek?: Partial<InvestigateThresholds['driftMinSlopePerWeek']>;
    };
    return {
      ...SPEC_DEFAULTS,
      ...parsed,
      driftMinSlopePerWeek: {
        ...SPEC_DEFAULTS.driftMinSlopePerWeek,
        ...(parsed.driftMinSlopePerWeek || {}),
      },
    };
  } catch (e) {
    console.error(`[log10x-mcp] failed to load thresholds from ${path}: ${(e as Error).message}. Using defaults.`);
    return SPEC_DEFAULTS;
  }
}

export const DEFAULT_THRESHOLDS: InvestigateThresholds = loadThresholds();
