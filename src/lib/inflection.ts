/**
 * Change-point detection for an anchor pattern's rate curve.
 *
 * Replaces the old `timestamp(max_over_time(deriv(...)))` approximation
 * with an actual range-query over the anchor's rate, a per-bucket slope
 * computation, and a simple max-derivative scan. Returns the inflection
 * timestamp AND a confidence label ('sharp' | 'soft' | 'inferred') the
 * caller uses to decide whether to engage the inferred_midpoint fallback
 * in the investigate spec.
 *
 * Sub-minute resolution on the demo env (which scrapes every 15–30s) is
 * the practical limit — the detector picks the bucket whose local slope
 * maximum dominates, not a timestamp inside the bucket.
 */

import type { EnvConfig } from './environments.js';
import { queryRange } from './api.js';
import { LABELS } from './promql.js';

export interface InflectionResult {
  /** UNIX seconds of the detected inflection (or window midpoint as fallback). */
  timestamp: number;
  /** Shape classification of the detection quality. */
  confidence: 'sharp' | 'soft' | 'inferred';
  /** Peak slope value at the detection point. */
  peakSlope: number;
  /** Ratio of peak slope to median slope — higher = sharper inflection. */
  peakToMedianRatio: number;
  /** Human-readable note for the investigation metadata. */
  note: string;
}

const EVENT_COUNT_METRIC = 'all_events_summaryVolume_total';

export async function detectInflection(
  env: EnvConfig,
  metricsEnv: string,
  anchor: string,
  window: string,
  metricName?: string
): Promise<InflectionResult> {
  const metric = metricName || EVENT_COUNT_METRIC;
  const windowSeconds = parseWindowSeconds(window);
  const now = Math.floor(Date.now() / 1000);
  const start = now - windowSeconds;

  // Pick a step that gives ~30–60 buckets across the window.
  // 1h → 60s buckets; 6h → 5m buckets; 24h → 30m; 7d → 3.5h.
  const step = Math.max(30, Math.round(windowSeconds / 48));

  const promql = `sum(rate(${metric}{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(anchor)}"}[${stepLabel(step)}]))`;

  let buckets: Array<{ ts: number; value: number }> = [];
  try {
    const res = await queryRange(env, promql, start, now, step);
    if (res.status === 'success' && res.data.result[0]?.values) {
      buckets = res.data.result[0].values.map(([ts, v]) => ({
        ts,
        value: parseFloat(v) || 0,
      }));
    }
  } catch {
    // Non-fatal — fall through to midpoint fallback.
  }

  if (buckets.length < 4) {
    return {
      timestamp: Math.floor((start + now) / 2),
      confidence: 'inferred',
      peakSlope: 0,
      peakToMedianRatio: 0,
      note: 'inflection inferred to window midpoint — insufficient rate samples from Prometheus',
    };
  }

  // Compute per-bucket slope as (value[i] - value[i-1]) / step.
  // Keep absolute slopes so both up-spikes and down-drops are detected.
  const slopes: Array<{ ts: number; slope: number }> = [];
  for (let i = 1; i < buckets.length; i++) {
    const slope = Math.abs(buckets[i].value - buckets[i - 1].value) / step;
    slopes.push({ ts: buckets[i].ts, slope });
  }

  // Find peak slope and median slope. Peak/median ratio tells us how
  // dominant the peak is — a clean spike has ratio >> 1; a flat curve
  // has ratio ~ 1.
  const peak = slopes.reduce((a, b) => (b.slope > a.slope ? b : a));
  const sortedSlopes = [...slopes].map((s) => s.slope).sort((a, b) => a - b);
  const median = sortedSlopes[Math.floor(sortedSlopes.length / 2)] || 0;
  const ratio = median > 0 ? peak.slope / median : peak.slope > 0 ? 10 : 1;

  let confidence: 'sharp' | 'soft' | 'inferred';
  let note: string;
  if (ratio >= 5) {
    confidence = 'sharp';
    note = `sharp inflection detected at peak/median ratio ${ratio.toFixed(1)}`;
  } else if (ratio >= 2) {
    confidence = 'soft';
    note = `soft inflection — peak/median ratio ${ratio.toFixed(1)}, treat confidence cautiously`;
  } else {
    confidence = 'inferred';
    note = `no clear inflection — peak/median ratio ${ratio.toFixed(1)} — anchoring to window midpoint`;
    return {
      timestamp: Math.floor((start + now) / 2),
      confidence,
      peakSlope: peak.slope,
      peakToMedianRatio: ratio,
      note,
    };
  }

  return { timestamp: peak.ts, confidence, peakSlope: peak.slope, peakToMedianRatio: ratio, note };
}

function parseWindowSeconds(window: string): number {
  const m = window.match(/^(\d+)([smhdw])$/);
  if (!m) return 3600;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    case 'w':
      return n * 604800;
    default:
      return 3600;
  }
}

function stepLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
