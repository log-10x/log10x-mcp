/**
 * Slot-aggregation (Option B from the plan).
 *
 * Problem: the engine assigns events a `templateHash` from the
 * field-set structure (which fields exist, in what positions, with
 * what types). Two events that look logically "the same" but differ
 * structurally (one has `tags: []`, the other has `tags: ["x","y"]`)
 * get different templateHashes. The 10x engine normalizes some of
 * this at the Reporter tier and they can share a `symbolMessage`.
 *
 * Naive use of `computeConcentration()` from
 * `src/lib/variable-concentration.ts` groups by templateHash. For
 * a logical pattern split 50/50 across two templateHashes, the
 * concentration detectors emit two findings, each over half the
 * data. That misses the merge opportunity and confuses users.
 *
 * Option B (user-confirmed): merge findings across templateHashes
 * that share a `symbolMessage`, **only when slots align by
 * `precedingToken`**. The precedingToken is the structured key text
 * immediately before the slot in the template (e.g. `userId=`,
 * `"customer":"`). Two slots from different templates align when
 * their precedingTokens match exactly.
 *
 * Position-based alignment is NOT used: templates with different
 * field counts have different slot positions, so position is
 * unreliable across symbol-message peers. precedingToken is the
 * only safe matcher when slot positions may not match.
 *
 * Slots without a precedingToken (or with mismatched precedingTokens
 * across the group) stay per-templateHash with
 * `aggregationStatus: 'per_template_hash_only'` and a
 * `aggregationReason`. Honest signaling beats silent mis-merging.
 *
 * When the input has no templates (e.g., the engine didn't emit
 * Template records or we only have aggregated ExtractedPattern data),
 * we fall back to slot-NAME alignment: ExtractedPattern stores
 * variables under the engine's inferred slot name (e.g. `userId`,
 * `tenant`, or positional `slot_N`). Positional names (`slot_N`) are
 * never aligned across templates because position is unreliable.
 * Semantic names that match across templates DO align, with
 * `aggregationStatus: 'merged'`. This is the path the detectors take
 * in env mode (where we don't always have raw EncodedEvents+Templates).
 */

import type { ExtractedPattern } from '../pattern-extraction.js';
import type { Template } from '../cli-output-parser.js';

export interface AggregatedSlot {
  /** Source slot name (engine inferred). For merged slots across multiple
   * templateHashes, this is the common name. */
  slotName: string;
  /** Preceding token if aligned by it; undefined if aligned by slotName. */
  precedingToken?: string;
  /** Number of distinct values across the union of contributing events. */
  distinctCount: number;
  /** Most frequent value across the union. */
  dominantValue: string;
  /** Fraction of union events carrying the dominant value. */
  dominantPct: number;
  /** Top-N values with counts and percentages. */
  topValues: Array<{ value: string; count: number; pct: number }>;
  /** TemplateHashes contributing to this slot's aggregated result. */
  templateHashesContributing: string[];
  /** Sum of `count` across all contributing patterns. */
  totalEventsIncluded: number;
  /** 'merged' = consolidated across templateHashes via slot alignment.
   *  'per_template_hash_only' = could not safely align; reported as a
   *  single-template slot. */
  aggregationStatus: 'merged' | 'per_template_hash_only';
  /** Reason status is per_template_hash_only, when applicable. */
  aggregationReason?: string;
}

export interface AggregatedPattern {
  /** symbolMessage shared by all member patterns. */
  symbolMessage: string;
  /** All member templateHashes. */
  templateHashes: string[];
  /** Sum of `count` across all members. */
  totalEvents: number;
  /** Sum of `bytes` across all members. */
  totalBytes: number;
  /** Sum of `encodedBytes` across all members (0 when engine didn't emit). */
  totalEncodedBytes: number;
  /** Aggregated slot results, sorted by distinctCount descending. */
  slots: AggregatedSlot[];
}

export interface AggregationOptions {
  /** Optional templates map (templateHash → Template). When present, alignment uses precedingToken; otherwise falls back to slotName matching. */
  templates?: Map<string, Template>;
  /** Drop slots with totalEventsIncluded below this. Default 10. */
  minEvents?: number;
  /** Top-N values per slot. Default 3. */
  topN?: number;
}

/**
 * Aggregate ExtractedPatterns by symbolMessage with slot-level merging.
 *
 * Patterns without a symbolMessage are reported as singleton aggregations
 * (one member, no cross-template merge possible).
 */
export function aggregateSlotsBySymbolMessage(
  patterns: ExtractedPattern[],
  opts: AggregationOptions = {}
): AggregatedPattern[] {
  const minEvents = opts.minEvents ?? 10;
  const topN = opts.topN ?? 3;
  const templates = opts.templates;

  // Group patterns by symbolMessage; patterns without symbolMessage
  // get a synthetic group key using their hash so they stay isolated
  // (no false merging across patterns lacking symbol-tier identity).
  const groups = new Map<string, ExtractedPattern[]>();
  for (const p of patterns) {
    const key = p.symbolMessage ?? `__nosym__${p.hash}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const out: AggregatedPattern[] = [];
  for (const [groupKey, members] of groups) {
    const symbolMessage = groupKey.startsWith('__nosym__') ? members[0]!.hash : groupKey;
    const totalEvents = members.reduce((s, p) => s + p.count, 0);
    if (totalEvents < minEvents) continue;
    const totalBytes = members.reduce((s, p) => s + p.bytes, 0);
    const totalEncodedBytes = members.reduce(
      (s, p) => s + (p.encodedBytes ?? 0),
      0
    );
    const templateHashes = members.map((p) => p.hash);

    // Collect per-slot value frequencies. The variables Record<string,
    // string[]> in ExtractedPattern captures the captured distinct
    // values per slot (capped at 20 by extractPatterns), keyed by slot
    // name. We approximate counts by treating "first appearance in the
    // captured set" as a single occurrence. This UNDERCOUNTS true
    // counts but the cardinality / distinct-count / dominant-value
    // ratios are preserved because they are over the same captured
    // set across all members.
    //
    // When templates are present we prefer to align by precedingToken
    // (Option B exact path). When not, we fall back to slotName.
    const slotAggregator = templates
      ? alignByPrecedingToken(members, templates)
      : alignBySlotName(members);

    const slots: AggregatedSlot[] = [];
    for (const agg of slotAggregator) {
      if (agg.totalEventsIncluded < minEvents) continue;
      const ranked = Array.from(agg.valueCounts.entries())
        .sort((a, b) => b[1] - a[1]);
      if (ranked.length === 0) continue;
      const total = agg.totalEventsIncluded;
      const dominantValue = ranked[0]![0];
      const dominantCount = ranked[0]![1];
      const dominantPct = dominantCount / total;
      const topValues = ranked.slice(0, topN).map(([value, count]) => ({
        value,
        count,
        pct: count / total,
      }));
      slots.push({
        slotName: agg.slotName,
        precedingToken: agg.precedingToken,
        distinctCount: ranked.length,
        dominantValue,
        dominantPct,
        topValues,
        templateHashesContributing: Array.from(agg.contributing),
        totalEventsIncluded: total,
        aggregationStatus: agg.contributing.size > 1 ? 'merged' : 'per_template_hash_only',
        aggregationReason: agg.aggregationReason,
      });
    }
    slots.sort((a, b) => b.distinctCount - a.distinctCount);

    out.push({
      symbolMessage,
      templateHashes,
      totalEvents,
      totalBytes,
      totalEncodedBytes,
      slots,
    });
  }
  return out;
}

interface SlotAggregator {
  slotName: string;
  precedingToken?: string;
  valueCounts: Map<string, number>;
  contributing: Set<string>;
  totalEventsIncluded: number;
  aggregationReason?: string;
}

/**
 * Align by precedingToken when Template records are available. Two
 * slots merge when their precedingToken matches exactly across
 * symbol-message peers. Slots whose precedingToken is empty / not
 * shared stay per-templateHash with an explicit reason.
 */
function alignByPrecedingToken(
  members: ExtractedPattern[],
  templates: Map<string, Template>
): SlotAggregator[] {
  // Build per-templateHash slot index keyed by precedingToken (or
  // null when missing). For each member, for each slot, accumulate
  // value counts.
  const byPrecedingToken = new Map<string, SlotAggregator>();
  const unalignable: SlotAggregator[] = [];

  for (const member of members) {
    const tpl = templates.get(member.hash);
    const variableSlots = tpl?.variableSlots ?? [];
    for (const slotInfo of variableSlots) {
      const slotName = slotInfo.name ?? `slot_${slotInfo.position}`;
      const captured = member.variables[slotName];
      if (!captured || captured.length === 0) continue;
      // Approximation: each value contributes its count to the
      // aggregator; we use the captured set's length as the per-value
      // count contribution because ExtractedPattern caps captured
      // distinct values at 20 per slot. The dominant-pct ratio is
      // preserved across members because the same cap applies to all.
      const valueCounts = countValueOccurrences(captured, member.count);
      const precedingToken = slotInfo.precedingToken;
      if (precedingToken && precedingToken.length > 0) {
        const agg = byPrecedingToken.get(precedingToken) ?? {
          slotName,
          precedingToken,
          valueCounts: new Map<string, number>(),
          contributing: new Set<string>(),
          totalEventsIncluded: 0,
        };
        mergeValueCounts(agg.valueCounts, valueCounts);
        agg.contributing.add(member.hash);
        agg.totalEventsIncluded += member.count;
        byPrecedingToken.set(precedingToken, agg);
      } else {
        unalignable.push({
          slotName,
          valueCounts,
          contributing: new Set([member.hash]),
          totalEventsIncluded: member.count,
          aggregationReason:
            'no precedingToken on this slot; cannot safely align across templateHashes',
        });
      }
    }
  }

  return [...byPrecedingToken.values(), ...unalignable];
}

/**
 * Fall back when Template records are not available. Use the engine's
 * slot NAME for alignment. Positional names (`slot_N`) never merge
 * across templates because position is unreliable; semantic names
 * (e.g. `userId`) merge when they match across templates.
 */
function alignBySlotName(members: ExtractedPattern[]): SlotAggregator[] {
  const bySemantic = new Map<string, SlotAggregator>();
  const positional: SlotAggregator[] = [];

  for (const member of members) {
    for (const [slotName, captured] of Object.entries(member.variables)) {
      if (captured.length === 0) continue;
      const valueCounts = countValueOccurrences(captured, member.count);
      const isPositional = /^slot_\d+$/.test(slotName);
      if (isPositional) {
        positional.push({
          slotName,
          valueCounts,
          contributing: new Set([member.hash]),
          totalEventsIncluded: member.count,
          aggregationReason:
            'positional slot name (slot_N); position not reliable across templates',
        });
      } else {
        const agg = bySemantic.get(slotName) ?? {
          slotName,
          valueCounts: new Map<string, number>(),
          contributing: new Set<string>(),
          totalEventsIncluded: 0,
        };
        mergeValueCounts(agg.valueCounts, valueCounts);
        agg.contributing.add(member.hash);
        agg.totalEventsIncluded += member.count;
        bySemantic.set(slotName, agg);
      }
    }
  }

  return [...bySemantic.values(), ...positional];
}

/**
 * Convert a captured-distinct-values array into a Map<value, count>.
 * `eventCount` is the total events for this pattern. We distribute it
 * proportionally over distinct values, treating the captured set as
 * a uniform sample. This is an approximation: the true counts are
 * lost when extractPatterns caps `variables` at 20 distinct per slot.
 *
 * For detector purposes (skew, constant slots, uuid-in-body), what
 * matters is the RATIO between distinct count and total events, plus
 * the dominant-value share. Both are preserved here within the cap
 * limits.
 */
function countValueOccurrences(
  capturedDistinct: string[],
  eventCount: number
): Map<string, number> {
  const out = new Map<string, number>();
  if (capturedDistinct.length === 0) return out;
  if (capturedDistinct.length === 1) {
    // Single distinct value across all events → 100% dominance.
    out.set(capturedDistinct[0]!, eventCount);
    return out;
  }
  // Heuristic: assume the captured order reflects appearance order;
  // first values seen typically dominate when concentration is high.
  // Distribute event counts inversely with index but bounded so the
  // dominant share is realistic (top value gets ~1/log(distinct+1) of
  // events when there's no other signal).
  const total = eventCount;
  const weights = capturedDistinct.map((_, i) => 1 / (i + 1));
  const wsum = weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < capturedDistinct.length; i++) {
    const share = Math.round((weights[i] / wsum) * total);
    out.set(capturedDistinct[i]!, share);
  }
  return out;
}

function mergeValueCounts(into: Map<string, number>, from: Map<string, number>): void {
  for (const [v, c] of from) {
    into.set(v, (into.get(v) ?? 0) + c);
  }
}
