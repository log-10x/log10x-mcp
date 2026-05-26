/**
 * UUID-in-body detector. Identifies slots where every event has an
 * effectively unique value (cardinality / event_count >= threshold,
 * default 0.9). When the dominant values match a UUID / ISO timestamp
 * / hex-id regex, the finding is confirmed; otherwise marked
 * 'unknown' (still high-cardinality, anti-pattern shape).
 *
 * Why it matters: a slot with one unique value per event is almost
 * certainly a UUID, request ID, or timestamp stuffed in the message
 * body. Either it should be a structured label at the forwarder (cheap)
 * or stripped (cheaper). Storage cost per event scales with that
 * slot's bytes; analytic value across events is zero (you cannot
 * group on it).
 *
 * Algorithm:
 *   1. Run aggregateSlotsBySymbolMessage (Option B).
 *   2. For each aggregated pattern, find slots where
 *      distinctCount / totalEventsIncluded >= cardinality_ratio_threshold.
 *      Note that ExtractedPattern.variables caps distinct values at
 *      20, so the maximum observable ratio is bounded by 20/N where
 *      N = totalEventsIncluded. For UUID detection we therefore also
 *      require distinctCount >= 10 (high-cardinality cap saturates
 *      well before threshold for non-UUIDs).
 *   3. Probe the dominantValue (and up to 2 more topValues) with
 *      regex set: UUID, ISO timestamp, hex-id-16+. Strongest match
 *      becomes `regex_match`. None match → 'unknown'.
 *   4. Surface fix_hint based on the match.
 */

import type { ExtractedPattern } from '../pattern-extraction.js';
import { aggregateSlotsBySymbolMessage } from './slot-aggregation.js';
import type { Template } from '../cli-output-parser.js';

export type UuidRegexMatch = 'uuid' | 'timestamp' | 'hex_id' | 'unknown';

export interface UuidInBodyFinding {
  patternIdentity: string;
  templateHashes: string[];
  costPerMonthUsd?: number;
  totalEvents: number;
  totalBytes: number;
  uuidLikeSlots: Array<{
    slotName: string;
    precedingToken?: string;
    cardinalityRatio: number;
    sampleValues: string[];
    regexMatch: UuidRegexMatch;
  }>;
  fixHint: string;
}

export interface FindUuidInBodyOptions {
  topN?: number; // default 20
  cardinalityRatioThreshold?: number; // default 0.9
  minDistinctForUuid?: number; // default 10 (anti-saturation guard)
  costPerMonthByIdentity?: (identity: string) => number | undefined;
  templates?: Map<string, Template>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/;
const HEX_ID_RE = /^[0-9a-f]{16,}$/i;

export function findUuidInBody(
  patterns: ExtractedPattern[],
  opts: FindUuidInBodyOptions = {}
): UuidInBodyFinding[] {
  const topN = opts.topN ?? 20;
  const threshold = opts.cardinalityRatioThreshold ?? 0.9;
  const minDistinctForUuid = opts.minDistinctForUuid ?? 10;

  const aggregated = aggregateSlotsBySymbolMessage(patterns, {
    templates: opts.templates,
  });

  const findings: UuidInBodyFinding[] = [];
  for (const agg of aggregated) {
    // ExtractedPattern caps distinct values per slot at 20. For a slot
    // to be detected as "every event has a unique value", we need (a)
    // distinctCount >= minDistinctForUuid (otherwise low-card slots
    // could falsely trigger), and (b) cardinality ratio above
    // threshold. Note: ratio is bounded by 20/N because of the cap;
    // for N=20 events both values can saturate at distinct=20, ratio=1.
    const uuidLike = agg.slots.filter((s) => {
      if (s.distinctCount < minDistinctForUuid) return false;
      const ratio = s.distinctCount / s.totalEventsIncluded;
      return ratio >= threshold;
    });
    if (uuidLike.length === 0) continue;

    const annotated = uuidLike.map((s) => {
      const probeValues = s.topValues.slice(0, 3).map((v) => v.value);
      let regexMatch: UuidRegexMatch = 'unknown';
      for (const v of probeValues) {
        if (UUID_RE.test(v)) {
          regexMatch = 'uuid';
          break;
        }
        if (ISO_TS_RE.test(v)) {
          regexMatch = 'timestamp';
          // Don't break; UUID is stronger if found later.
        }
        if (HEX_ID_RE.test(v) && regexMatch === 'unknown') {
          regexMatch = 'hex_id';
        }
      }
      return {
        slotName: s.slotName,
        precedingToken: s.precedingToken,
        cardinalityRatio: s.distinctCount / s.totalEventsIncluded,
        sampleValues: probeValues,
        regexMatch,
      };
    });

    const fixHint = formatFixHint(annotated);

    findings.push({
      patternIdentity: agg.symbolMessage,
      templateHashes: agg.templateHashes,
      costPerMonthUsd: opts.costPerMonthByIdentity?.(agg.symbolMessage),
      totalEvents: agg.totalEvents,
      totalBytes: agg.totalBytes,
      uuidLikeSlots: annotated,
      fixHint,
    });
  }

  // Rank by bytes × number of uuid-like slots (more slots in one
  // pattern = more bytes wasted on per-event uniques).
  findings.sort((a, b) => {
    const aScore = a.totalBytes * a.uuidLikeSlots.length;
    const bScore = b.totalBytes * b.uuidLikeSlots.length;
    return bScore - aScore;
  });

  return findings.slice(0, topN);
}

function formatFixHint(
  slots: Array<{ slotName: string; regexMatch: UuidRegexMatch }>
): string {
  if (slots.length === 0) return '';
  const named = slots.map((s) => `\`${s.slotName}\``).join(', ');
  const hasUuid = slots.some((s) => s.regexMatch === 'uuid');
  const hasTs = slots.some((s) => s.regexMatch === 'timestamp');
  const hasHex = slots.some((s) => s.regexMatch === 'hex_id');
  if (hasUuid) {
    return `Slot(s) ${named} carry per-event UUIDs in the message body. Promote to a structured label at the forwarder (cheap to query, drops byte cost on each event), or strip if not needed for traceability.`;
  }
  if (hasTs) {
    return `Slot(s) ${named} carry per-event timestamps in the message body. Most analyzers already index event time; the in-body timestamp is redundant and stripping it saves bytes.`;
  }
  if (hasHex) {
    return `Slot(s) ${named} carry per-event hex IDs in the message body. Promote to structured label or strip; cardinality this high means the field is event-identity, not categorical.`;
  }
  return `Slot(s) ${named} carry effectively-unique values per event. Cardinality this high means the field carries no analytic value across events; consider promoting to a structured label or stripping from the body.`;
}
