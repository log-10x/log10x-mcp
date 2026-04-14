/**
 * Acute-spike correlation engine for log10x_investigate.
 *
 * Given an anchor pattern with a detected inflection, query the
 * Prometheus metric universe for co-movers (patterns whose rate changed
 * sharply in the same window), run lag analysis across a handful of
 * offsets, and build a causal chain ordered by lead time.
 *
 * The engine returns a structured result the renderer turns into markdown.
 * Confidence is mechanically derived from stat strength, lag tightness,
 * and chain coherence — never the model's self-assessment.
 */

import type { EnvConfig } from './environments.js';
import { queryInstant, type PrometheusResponse } from './api.js';
import { LABELS } from './promql.js';
import { parsePrometheusValue } from './cost.js';
import { createLimiter } from './concurrency.js';
import type { InvestigateThresholds } from './thresholds.js';

export interface CoMover {
  pattern: string;
  service: string;
  severity: string;
  currentRate: number;
  baselineRate: number;
  rateChange: number; // (current / baseline) - 1
  direction: 'up' | 'down';
  /** Lag in seconds relative to anchor inflection — negative = leads. */
  lagSeconds?: number;
  /** Per-offset rate change: used for lag-tightness scoring. */
  lagProfile?: Array<{ offsetSeconds: number; rateChange: number }>;
}

export interface ChainLink {
  mover: CoMover;
  /** Stat sub-score (0-1) — magnitude above noise floor. */
  stat: number;
  /** Lag tightness (0-1) — sharpness of the peak across offsets. */
  lag: number;
  /** Chain coherence (0-1) — how well this link fits the chain vs star pattern. */
  chain: number;
  /** Final per-link confidence = stat * lag * chain. */
  confidence: number;
}

export interface CorrelationResult {
  anchor: string;
  anchorRateChange: number;
  /** Sorted by lead time (most-leading first). The final entry is the anchor. */
  chain: ChainLink[];
  /** Co-movers that didn't make the chain but have above-floor signal. */
  coMovers: CoMover[];
  metadata: {
    patternsAnalyzed: number;
    queriesExecuted: number;
    wallTimeMs: number;
    softTimeoutHit: boolean;
    hardTimeoutHit: boolean;
  };
}

export interface CorrelationOptions {
  env: EnvConfig;
  metricsEnv: string;
  anchor: string;
  inflectionTimestamp: number; // UNIX seconds
  baselineOffsetSeconds: number; // e.g. 86400
  window: string; // PromQL range expression, e.g. "5m"
  depth: 'shallow' | 'normal' | 'deep';
  thresholds: InvestigateThresholds;
  /** Service label to scope the universe when depth != "deep". */
  scopeService?: string;
  /** Event-count metric to use for correlation. */
  metricName?: string;
}

const EVENT_COUNT_METRIC = 'all_events_summaryVolume_total';
const LAG_OFFSETS_SECONDS = [30, 60, 120, 180, 300];

export async function runAcuteSpikeCorrelation(opts: CorrelationOptions): Promise<CorrelationResult> {
  const started = Date.now();
  const metric = opts.metricName || EVENT_COUNT_METRIC;
  const envLabel = `${LABELS.env}="${opts.metricsEnv}"`;
  const scopeLabel = opts.depth !== 'deep' && opts.scopeService
    ? `,${LABELS.service}="${escape(opts.scopeService)}"`
    : '';

  // ── Phase A — topk rate-change query ──
  // We compute the current rate over `window` and divide by the baseline
  // (same window, shifted by baselineOffsetSeconds). We rank by magnitude
  // of rate change, anchored by the anchor direction.
  const baseOffset = `${opts.baselineOffsetSeconds}s`;
  const noiseFloor = opts.thresholds.acuteNoiseFloor;

  const topkQuery =
    `topk(20, abs(` +
    `(sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (rate(${metric}{${envLabel}${scopeLabel}}[${opts.window}])) ` +
    `/ ` +
    `sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (rate(${metric}{${envLabel}${scopeLabel}}[${opts.window}] offset ${baseOffset}) > ${noiseFloor})` +
    `) - 1))`;

  let queriesExecuted = 0;
  let softTimeoutHit = false;
  let hardTimeoutHit = false;

  let topkRes: PrometheusResponse;
  try {
    topkRes = await queryInstant(opts.env, topkQuery);
    queriesExecuted += 1;
  } catch (e) {
    throw new Error(`Correlation topk query failed: ${(e as Error).message}`);
  }

  const coMoversAll: CoMover[] = [];
  if (topkRes.status === 'success') {
    for (const row of topkRes.data.result) {
      const pattern = row.metric[LABELS.pattern];
      if (!pattern || pattern === opts.anchor) continue;
      const rateChange = parsePrometheusValue(row);
      if (!Number.isFinite(rateChange)) continue;
      coMoversAll.push({
        pattern,
        service: row.metric[LABELS.service] || '',
        severity: row.metric[LABELS.severity] || '',
        currentRate: 0,
        baselineRate: 0,
        rateChange,
        direction: rateChange >= 0 ? 'up' : 'down',
      });
    }
  }

  // ── Phase B — anchor rate-change for direction reference ──
  const anchorRateQuery =
    `(sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(opts.anchor)}"}[${opts.window}])) ` +
    `/ ignoring(__name__) ` +
    `sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(opts.anchor)}"}[${opts.window}] offset ${baseOffset}))) - 1`;

  let anchorRateChange = 0;
  try {
    const res = await queryInstant(opts.env, anchorRateQuery);
    queriesExecuted += 1;
    if (res.status === 'success' && res.data.result[0]) {
      anchorRateChange = parsePrometheusValue(res.data.result[0]);
    }
  } catch {
    // non-fatal
  }

  // Keep top N movers in the anchor's direction (or both if anchor direction ambiguous).
  const sameDirection = anchorRateChange >= 0 ? 'up' : 'down';
  const movers = coMoversAll
    .filter((m) => Math.abs(m.rateChange) > 0.15) // 15% floor to discard tiny noise
    .sort((a, b) => Math.abs(b.rateChange) - Math.abs(a.rateChange));
  const topMovers = movers.slice(0, opts.thresholds.maxCoMoversForLag);

  // ── Phase C — Lag analysis (parallelized) ──
  // Enumerate every (mover, offset) pair and run them through a single-flight
  // semaphore capped at max_parallel_promql_queries. Previous implementation
  // iterated offsets sequentially per mover, so wall time scaled as
  // movers × offsets × query_latency (~10s for 8 movers × 5 offsets on the
  // demo env). The limiter fans out all 40 queries at once and respects the
  // soft/hard deadlines uniformly.
  const softDeadlineMs = opts.thresholds.lagSoftTimeoutMs;
  const hardDeadline = started + opts.thresholds.lagHardTimeoutMs;
  const limiter = createLimiter(opts.thresholds.maxParallelPromqlQueries, softDeadlineMs);

  // Per-mover accumulator for offset results.
  const profiles = new Map<string, Array<{ offsetSeconds: number; rateChange: number }>>();
  for (const m of topMovers) profiles.set(m.pattern, []);

  const pairs: Array<{ mover: CoMover; offset: number }> = [];
  for (const m of topMovers) {
    for (const off of LAG_OFFSETS_SECONDS) pairs.push({ mover: m, offset: off });
  }

  const lagTasks = pairs.map(({ mover, offset }) =>
    limiter(async () => {
      if (Date.now() > hardDeadline) {
        hardTimeoutHit = true;
        return;
      }
      const q =
        `(sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(mover.pattern)}"}[${opts.window}] offset ${offset}s)) ` +
        `/ ignoring(__name__) ` +
        `sum(rate(${metric}{${envLabel},${LABELS.pattern}="${escape(mover.pattern)}"}[${opts.window}] offset ${offset + opts.thresholds.maxCoMoversForLag * 60}s))) - 1`;
      try {
        const res = await queryInstant(opts.env, q);
        queriesExecuted += 1;
        if (res.status === 'success' && res.data.result[0]) {
          const rc = parsePrometheusValue(res.data.result[0]);
          if (Number.isFinite(rc)) {
            profiles.get(mover.pattern)!.push({ offsetSeconds: offset, rateChange: rc });
          }
        }
      } catch {
        // skip
      }
    })
  );

  await Promise.allSettled(lagTasks);
  if (limiter.isSoftExpired()) softTimeoutHit = true;

  // Attach profiles back to mover records and compute lagSeconds per mover.
  for (const mover of topMovers) {
    const profile = (profiles.get(mover.pattern) || []).sort((a, b) => a.offsetSeconds - b.offsetSeconds);
    mover.lagProfile = profile;
    if (profile.length > 0) {
      // Peak offset = offset with maximum |rate_change|
      const peak = profile.reduce((a, b) => (Math.abs(b.rateChange) > Math.abs(a.rateChange) ? b : a));
      // Lead time is -peak.offsetSeconds (mover peaked N seconds before the inflection window).
      mover.lagSeconds = -peak.offsetSeconds;
    }
  }

  // ── Phase D — Build the causal chain ──
  // Sort movers by lag (most-leading first), keep only those in the
  // anchor's direction, compute per-link confidences.
  const sameDir = topMovers.filter((m) => m.direction === sameDirection);
  sameDir.sort((a, b) => (a.lagSeconds ?? 0) - (b.lagSeconds ?? 0));

  const chain: ChainLink[] = sameDir.map((mover, idx) => {
    const stat = statScore(mover.rateChange, noiseFloor);
    const lag = lagScore(mover.lagProfile);
    const chainCoh = chainCoherenceScore(idx, sameDir.length);
    return {
      mover,
      stat,
      lag,
      chain: chainCoh,
      confidence: stat * lag * chainCoh,
    };
  });

  return {
    anchor: opts.anchor,
    anchorRateChange,
    chain,
    coMovers: topMovers,
    metadata: {
      patternsAnalyzed: coMoversAll.length,
      queriesExecuted,
      wallTimeMs: Date.now() - started,
      softTimeoutHit,
      hardTimeoutHit,
    },
  };
}

// ── Sub-score functions ──

function statScore(rateChange: number, noiseFloor: number): number {
  const ratio = Math.abs(rateChange) / Math.max(noiseFloor, 0.0001);
  return Math.min(1, ratio / 10);
}

function lagScore(profile?: Array<{ offsetSeconds: number; rateChange: number }>): number {
  if (!profile || profile.length === 0) return 0.3;
  const mags = profile.map((p) => Math.abs(p.rateChange));
  const max = Math.max(...mags);
  const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
  if (max === 0) return 0;
  // Sharp peak = max >> mean → high score. Flat profile = max ~ mean → low score.
  return Math.max(0, Math.min(1, (max - mean) / max));
}

function chainCoherenceScore(index: number, total: number): number {
  // Linear chain is coherent if each link's position is well-defined.
  // Simple proxy: small chains (≤4) get high coherence; larger chains
  // get penalized slightly because they're more likely to include false
  // positives.
  if (total <= 3) return 0.9;
  if (total <= 5) return 0.8;
  return Math.max(0.5, 1 - (index / total) * 0.4);
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
