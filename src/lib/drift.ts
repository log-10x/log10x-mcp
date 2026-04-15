/**
 * Drift detection and slope-similarity correlation for log10x_investigate.
 *
 * Drift cases are structurally different from acute spikes: there is no
 * inflection to anchor lag analysis on. Instead, we compute the anchor's
 * slope (rate of change per week) and find co-drifters whose slope most
 * closely matches the anchor's. The output is a cohort of patterns
 * growing together, not a causal chain.
 */

import type { EnvConfig } from './environments.js';
import { queryInstant } from './api.js';
import { LABELS } from './promql.js';
import { parsePrometheusValue } from './cost.js';
import type { InvestigateThresholds } from './thresholds.js';

export interface DriftResult {
  anchor: string;
  anchorSlopePerWeek: number;
  cohort: CoDrifter[];
  metadata: {
    patternsAnalyzed: number;
    queriesExecuted: number;
    wallTimeMs: number;
  };
}

export interface CoDrifter {
  pattern: string;
  service: string;
  severity: string;
  slopePerWeek: number;
  slopeSimilarity: number; // 0-1, how close to anchor's slope
}

export interface DriftOptions {
  env: EnvConfig;
  metricsEnv: string;
  anchor: string;
  /** Window for slope computation. Typically wider than acute-spike window: "30d" or "90d". */
  window: string;
  depth: 'shallow' | 'normal' | 'deep';
  thresholds: InvestigateThresholds;
  scopeService?: string;
  anchorSeverity?: string;
  metricName?: string;
}

const EVENT_COUNT_METRIC = 'all_events_summaryVolume_total';

/**
 * Classify whether an anchor's trajectory is an acute spike, drift, or flat.
 * Returns the anchor's per-week growth rate for downstream use by the drift
 * flow, plus a simple shape classification.
 */
export async function classifyTrajectory(
  env: EnvConfig,
  metricsEnv: string,
  anchor: string,
  window: string,
  thresholds: InvestigateThresholds,
  severity?: string,
  metricName?: string,
  baselineOffset: string = '7d'
): Promise<{ shape: 'acute' | 'drift' | 'flat'; slopePerWeek: number; rateChange: number }> {
  const metric = metricName || EVENT_COUNT_METRIC;
  const envLabel = `${LABELS.env}="${metricsEnv}"`;

  // Compare current rate to the user's baseline_offset (default 7d for backward
  // compat with callers that don't pass it). Previously this was hardcoded to
  // 7d, which meant a service-mode investigate with window=5m baseline=1h would
  // still classify "flat" against a 7d-ago bucket, ignoring the user's actual
  // comparison intent. Downstream: `shape === 'flat'` → tool returns "no
  // significant movement", so getting this wrong silences real signals.
  const currentVsBaseline =
    `sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(anchor)}"}[${window}])) ` +
    `/ ` +
    `sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(anchor)}"}[${window}] offset ${baselineOffset}))`;

  // Compute per-week growth rate via derivative over the window.
  const slopeQuery =
    `deriv(sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(anchor)}"}[1h]))[${window}:1h]) * 604800`;

  let rateChangeRatio = 1;
  let slopePerWeek = 0;
  try {
    const res = await queryInstant(env, currentVsBaseline);
    if (res.status === 'success' && res.data.result[0]) {
      rateChangeRatio = parsePrometheusValue(res.data.result[0]);
    }
  } catch {
    // non-fatal
  }
  try {
    const res = await queryInstant(env, slopeQuery);
    if (res.status === 'success' && res.data.result[0]) {
      slopePerWeek = parsePrometheusValue(res.data.result[0]);
    }
  } catch {
    // non-fatal
  }

  const rateChange = rateChangeRatio - 1;
  const sevKey = (severity || 'default').toLowerCase() as keyof typeof thresholds.driftMinSlopePerWeek;
  const driftFloor = thresholds.driftMinSlopePerWeek[sevKey] ?? thresholds.driftMinSlopePerWeek.default;

  // Acute if |rateChange| >= 0.5 (50% deviation in either direction). Previous
  // threshold was `> 1.0` (week-over-week doubling or halving), which had two
  // problems:
  //   1. A pattern that fully stopped has rateChange = -1.0 exactly, which is
  //      NOT > 1.0 in absolute value — so "stopped firing" incidents (a clear
  //      operational signal) were classified as "flat" and hidden.
  //   2. Env-mode already surfaces movers down to a 15% floor, so service-mode
  //      and env-mode disagreed on the same data: env-mode reported a -73%
  //      decline, service-mode reported "no significant movement". Customers
  //      reading both got whiplash.
  // 0.5 matches the `streamerEscalationThreshold` philosophy (50% confidence
  // floor) and is halfway between env-mode's 15% surface and the old 100%
  // threshold, preserving back-compat for most tests while fixing the
  // stopped-firing and consistency cases.
  if (Math.abs(rateChange) >= 0.5) {
    return { shape: 'acute', slopePerWeek, rateChange };
  }
  // Drift if the per-week slope exceeds the severity-calibrated floor.
  if (Math.abs(slopePerWeek) > driftFloor) {
    return { shape: 'drift', slopePerWeek, rateChange };
  }
  return { shape: 'flat', slopePerWeek, rateChange };
}

export async function runDriftCorrelation(opts: DriftOptions): Promise<DriftResult> {
  const started = Date.now();
  const metric = opts.metricName || EVENT_COUNT_METRIC;
  const envLabel = `${LABELS.env}="${opts.metricsEnv}"`;
  const sevKey = (opts.anchorSeverity || 'default').toLowerCase() as keyof typeof opts.thresholds.driftMinSlopePerWeek;
  const driftFloor = opts.thresholds.driftMinSlopePerWeek[sevKey] ?? opts.thresholds.driftMinSlopePerWeek.default;

  // Anchor slope.
  const anchorSlopeQ =
    `deriv(sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(opts.anchor)}"}[1h]))[${opts.window}:1h]) * 604800`;
  let anchorSlopePerWeek = 0;
  let queriesExecuted = 1;
  try {
    const res = await queryInstant(opts.env, anchorSlopeQ);
    if (res.status === 'success' && res.data.result[0]) {
      anchorSlopePerWeek = parsePrometheusValue(res.data.result[0]);
    }
  } catch {
    // fall through
  }

  // Find co-drifters: compute per-pattern slope, rank by closeness to anchor slope.
  const cohortQ =
    `topk(${opts.thresholds.maxCohortSize}, ` +
    `-abs(` +
    `deriv(sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (rate(${metric}{${envLabel}}[1h]))[${opts.window}:1h]) * 604800 ` +
    `- ${anchorSlopePerWeek})` +
    ` and deriv(sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (rate(${metric}{${envLabel}}[1h]))[${opts.window}:1h]) * 604800 > ${driftFloor}` +
    `)`;

  let cohort: CoDrifter[] = [];
  try {
    const res = await queryInstant(opts.env, cohortQ);
    queriesExecuted += 1;
    if (res.status === 'success') {
      // topk with negative abs returns patterns sorted by closeness to anchor slope.
      // Their per-pattern slopes must be fetched separately or extracted from a second pass;
      // for the MVP, we re-derive slope via a per-pattern call if the pattern isn't the anchor.
      const patterns: Array<{ p: string; s: string; sev: string }> = [];
      for (const row of res.data.result) {
        const pat = row.metric[LABELS.pattern];
        if (!pat || pat === opts.anchor) continue;
        patterns.push({
          p: pat,
          s: row.metric[LABELS.service] || '',
          sev: row.metric[LABELS.severity] || '',
        });
      }
      // Pull actual slopes in a single batch query.
      for (const pat of patterns) {
        const slopeQ = `deriv(sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(pat.p)}"}[1h]))[${opts.window}:1h]) * 604800`;
        try {
          const r = await queryInstant(opts.env, slopeQ);
          queriesExecuted += 1;
          if (r.status === 'success' && r.data.result[0]) {
            const slope = parsePrometheusValue(r.data.result[0]);
            const similarity = slopeSimilarity(anchorSlopePerWeek, slope);
            cohort.push({
              pattern: pat.p,
              service: pat.s,
              severity: pat.sev,
              slopePerWeek: slope,
              slopeSimilarity: similarity,
            });
          }
        } catch {
          // skip
        }
      }
    }
  } catch (e) {
    // fall through
  }

  cohort.sort((a, b) => b.slopeSimilarity - a.slopeSimilarity);
  cohort = cohort.slice(0, opts.thresholds.maxCohortSize);

  return {
    anchor: opts.anchor,
    anchorSlopePerWeek,
    cohort,
    metadata: {
      patternsAnalyzed: cohort.length,
      queriesExecuted,
      wallTimeMs: Date.now() - started,
    },
  };
}

export function driftConfidence(anchorSlope: number, cohort: CoDrifter[], driftFloor: number): {
  slopeSig: number;
  cohortCoh: number;
  combined: number;
} {
  const slopeSig = Math.max(0, Math.min(1, Math.abs(anchorSlope) / Math.max(driftFloor * 10, 0.0001)));
  if (cohort.length === 0) {
    return { slopeSig, cohortCoh: 0, combined: slopeSig * 0.3 };
  }
  const avgSim = cohort.reduce((s, c) => s + c.slopeSimilarity, 0) / cohort.length;
  return {
    slopeSig,
    cohortCoh: avgSim,
    combined: Math.min(1, slopeSig * avgSim * 1.2),
  };
}

function slopeSimilarity(anchor: number, candidate: number): number {
  // Similarity 1.0 when slopes are equal, decaying as they diverge.
  const denom = Math.max(Math.abs(anchor), Math.abs(candidate), 0.0001);
  const ratio = Math.abs(anchor - candidate) / denom;
  return Math.max(0, 1 - Math.min(1, ratio));
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
