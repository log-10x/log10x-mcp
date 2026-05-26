/**
 * Constant-slot detector. Identifies slots that have exactly one
 * distinct value across an aggregated pattern (within the captured
 * cap). A constant slot carries zero per-event information and is the
 * canonical compact-mode candidate: the receiver can strip it from
 * emission without losing anything.
 *
 * Algorithm:
 *   1. Run aggregateSlotsBySymbolMessage (Option B).
 *   2. For each aggregated pattern, find slots where distinctCount === 1
 *      AND totalEventsIncluded >= min_sample_count (default 10) to
 *      filter low-sample noise (one event with one value looks
 *      constant; with 10 events, it actually is).
 *   3. Estimate compact savings as the sum of constant-slot byte
 *      shares divided by total bytes. Heuristic: each constant slot
 *      typically contributes 10-30 bytes per event (key + value);
 *      we use the conservative average of 18 bytes per slot for the
 *      projection. The user-facing tool surfaces the real measured
 *      compact-byte ratio (ExtractedPattern.encodedBytes) separately
 *      when the engine emits it.
 */

import type { ExtractedPattern } from '../pattern-extraction.js';
import { aggregateSlotsBySymbolMessage } from './slot-aggregation.js';
import type { Template } from '../cli-output-parser.js';

export interface ConstantSlotFinding {
  patternIdentity: string;
  templateHashes: string[];
  costPerMonthUsd?: number;
  totalEvents: number;
  totalBytes: number;
  constantSlots: Array<{
    slotName: string;
    precedingToken?: string;
    constantValue: string;
    sampleCount: number;
  }>;
  estimatedCompactSavingsPct: number;
}

export interface FindConstantSlotsOptions {
  topN?: number; // default 20
  minSampleCount?: number; // default 10
  /** Estimated bytes per constant slot (key + value + separator). Conservative average. */
  bytesPerConstantSlot?: number; // default 18
  costPerMonthByIdentity?: (identity: string) => number | undefined;
  templates?: Map<string, Template>;
}

export function findConstantSlots(
  patterns: ExtractedPattern[],
  opts: FindConstantSlotsOptions = {}
): ConstantSlotFinding[] {
  const topN = opts.topN ?? 20;
  const minSampleCount = opts.minSampleCount ?? 10;
  const bytesPerConstantSlot = opts.bytesPerConstantSlot ?? 18;

  const aggregated = aggregateSlotsBySymbolMessage(patterns, {
    templates: opts.templates,
    minEvents: minSampleCount,
  });

  const findings: ConstantSlotFinding[] = [];
  for (const agg of aggregated) {
    const constants = agg.slots.filter(
      (s) =>
        s.distinctCount === 1 &&
        s.totalEventsIncluded >= minSampleCount
    );
    if (constants.length === 0) continue;

    // Estimated compact savings: (bytes_stripped_per_event × total_events) / total_bytes
    const bytesStripped = constants.length * bytesPerConstantSlot * agg.totalEvents;
    const estimatedCompactSavingsPct =
      agg.totalBytes > 0 ? Math.min(0.95, bytesStripped / agg.totalBytes) : 0;

    findings.push({
      patternIdentity: agg.symbolMessage,
      templateHashes: agg.templateHashes,
      costPerMonthUsd: opts.costPerMonthByIdentity?.(agg.symbolMessage),
      totalEvents: agg.totalEvents,
      totalBytes: agg.totalBytes,
      constantSlots: constants.map((s) => ({
        slotName: s.slotName,
        precedingToken: s.precedingToken,
        constantValue: s.dominantValue,
        sampleCount: s.totalEventsIncluded,
      })),
      estimatedCompactSavingsPct,
    });
  }

  // Rank by total bytes savings (estimatedCompactSavingsPct × totalBytes).
  findings.sort((a, b) => {
    const aSave = a.totalBytes * a.estimatedCompactSavingsPct;
    const bSave = b.totalBytes * b.estimatedCompactSavingsPct;
    return bSave - aSave;
  });

  return findings.slice(0, topN);
}
