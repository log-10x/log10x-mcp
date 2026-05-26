/**
 * Skew detector. Identifies patterns where one slot value dominates
 * (>= min_concentration of events). Used by `log10x_find_skew` to
 * surface sampling opportunities: "this slot is `get` 78% of events,
 * sample the get case at 1/N and save volume without losing signal."
 *
 * Algorithm:
 *   1. Run aggregateSlotsBySymbolMessage on the input patterns
 *      (Option B merge by precedingToken / semantic slot name).
 *   2. For each aggregated pattern, find slots where dominantPct >= min.
 *   3. Rank findings by (dominantPct × bytesShare) so strong skew on
 *      a big-spend pattern surfaces first.
 *   4. Surface up to top_n patterns; for each, the skewed-slot list
 *      and an estimated savings opportunity at 1/N sampling of the
 *      dominant value.
 *
 * Sampling-opportunity math: if a pattern has `count` events and
 * `dominantPct` of them carry the dominant value, sampling those at
 * 1/N drops (1 - 1/N) × dominantPct of total events. Translated to
 * bytes: (1 - 1/N) × dominantPct × bytes. At a typical N=10 and
 * dominantPct=0.78, that is 0.7 × bytes — i.e. 70% volume savings on
 * this pattern alone.
 */

import type { ExtractedPattern } from '../pattern-extraction.js';
import { aggregateSlotsBySymbolMessage, type AggregatedPattern, type AggregatedSlot } from './slot-aggregation.js';
import type { Template } from '../cli-output-parser.js';

export interface SkewFinding {
  patternIdentity: string;
  templateHashes: string[];
  costPerMonthUsd?: number;
  totalEvents: number;
  totalBytes: number;
  skewedSlots: Array<{
    slotName: string;
    precedingToken?: string;
    dominantValue: string;
    dominantPct: number;
    distinctCount: number;
    aggregationStatus: AggregatedSlot['aggregationStatus'];
  }>;
  /** Projected savings as a fraction of pattern bytes if dominant case is sampled 1/sampleN. */
  samplingOpportunityPct: number;
}

export interface FindSkewOptions {
  minConcentration?: number; // default 0.6
  topN?: number; // default 20
  minEvents?: number; // default 10 (skip low-sample noise)
  sampleN?: number; // default 10 (sampling rate for opportunity math)
  costPerMonthByIdentity?: (identity: string) => number | undefined;
  templates?: Map<string, Template>;
}

export function findSkew(
  patterns: ExtractedPattern[],
  opts: FindSkewOptions = {}
): SkewFinding[] {
  const minConcentration = opts.minConcentration ?? 0.6;
  const topN = opts.topN ?? 20;
  const minEvents = opts.minEvents ?? 10;
  const sampleN = opts.sampleN ?? 10;

  const aggregated = aggregateSlotsBySymbolMessage(patterns, {
    templates: opts.templates,
    minEvents,
  });

  const findings: SkewFinding[] = [];
  for (const agg of aggregated) {
    const skewed = agg.slots.filter((s) => s.dominantPct >= minConcentration);
    if (skewed.length === 0) continue;

    // Sampling opportunity: maximum across the skewed slots. We pick
    // the strongest skewed slot's dominantPct because sampling on it
    // is the most-impactful single action.
    const strongestPct = skewed.reduce(
      (max, s) => (s.dominantPct > max ? s.dominantPct : max),
      0
    );
    const samplingOpportunityPct = (1 - 1 / sampleN) * strongestPct;

    findings.push({
      patternIdentity: agg.symbolMessage,
      templateHashes: agg.templateHashes,
      costPerMonthUsd: opts.costPerMonthByIdentity?.(agg.symbolMessage),
      totalEvents: agg.totalEvents,
      totalBytes: agg.totalBytes,
      skewedSlots: skewed.map((s) => ({
        slotName: s.slotName,
        precedingToken: s.precedingToken,
        dominantValue: s.dominantValue,
        dominantPct: s.dominantPct,
        distinctCount: s.distinctCount,
        aggregationStatus: s.aggregationStatus,
      })),
      samplingOpportunityPct,
    });
  }

  // Rank by (strongest dominance × bytes share). Bytes-weighted so
  // strong skew on a high-volume pattern beats strong skew on a
  // tiny pattern.
  findings.sort((a, b) => {
    const aScore = a.totalBytes * (a.samplingOpportunityPct);
    const bScore = b.totalBytes * (b.samplingOpportunityPct);
    return bScore - aScore;
  });

  return findings.slice(0, topN);
}
