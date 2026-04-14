/**
 * Per-pattern variable concentration analysis.
 *
 * Given a set of encoded events for one template and the template's slot
 * definitions, tally the distinct values per slot and compute each slot's
 * dominant values with percentages.
 *
 * Semantic naming is honest: structured-log slots get high-confidence
 * names from their preceding JSON/logfmt keys; free-text slots with
 * natural-language preceding tokens get medium-confidence inferred names;
 * positional-only slots get `slot_<n>` with low confidence and no
 * hallucinated name.
 */

import type { EncodedEvent, Template, VariableSlot } from './cli-output-parser.js';

export interface SlotConcentration {
  slot: number;
  precedingToken?: string;
  inferredName: string;
  namingConfidence: 'high' | 'medium' | 'low';
  distinctCount: number;
  topValues: { value: string; count: number; pct: number }[];
}

export interface PatternConcentration {
  templateHash: string;
  symbolMessage?: string;
  template: string;
  count: number;
  severityDistribution: Record<string, number>;
  dominantSeverity?: string;
  /** Concentration analysis per slot, sorted by strength of concentration (highest first). */
  slots: SlotConcentration[];
  /** Max top-value pct across all slots — "how concentrated is this pattern on one dimension". */
  maxConcentration: number;
}

export interface VariableConcentrationOptions {
  /** How many top values per slot to surface. Default 3. */
  topN?: number;
  /** Minimum events per pattern to bother computing concentration. Default 2. */
  minCount?: number;
  /** Whether to sort slots by concentration strength (true) or by position (false). Default true. */
  sortByStrength?: boolean;
}

/**
 * Compute per-pattern concentration from a list of encoded events grouped by template hash.
 *
 * @param events - encoded events, will be grouped by templateHash internally
 * @param templates - map of templateHash → Template (from parseTemplates)
 * @param options - optional tuning knobs
 */
export function computeConcentration(
  events: EncodedEvent[],
  templates: Map<string, Template>,
  options: VariableConcentrationOptions = {}
): PatternConcentration[] {
  const topN = options.topN ?? 3;
  const minCount = options.minCount ?? 2;
  const sortByStrength = options.sortByStrength ?? true;

  // Group events by hash.
  const byHash = new Map<string, EncodedEvent[]>();
  for (const ev of events) {
    const arr = byHash.get(ev.templateHash) || [];
    arr.push(ev);
    byHash.set(ev.templateHash, arr);
  }

  const out: PatternConcentration[] = [];
  for (const [hash, evts] of byHash) {
    if (evts.length < minCount) continue;
    const template = templates.get(hash);
    const slots = template?.variableSlots || inferSlotsFromValues(evts);
    const slotResults: SlotConcentration[] = [];

    for (const slot of slots) {
      const pos = slot.position;
      const values = new Map<string, number>();
      for (const ev of evts) {
        const v = ev.values[pos];
        if (v === undefined) continue;
        values.set(v, (values.get(v) || 0) + 1);
      }
      if (values.size === 0) continue;

      const sorted = Array.from(values.entries())
        .sort((a, b) => b[1] - a[1]);
      const total = evts.length;
      const topValues = sorted.slice(0, topN).map(([value, count]) => ({
        value,
        count,
        pct: count / total,
      }));

      const { inferredName, namingConfidence } = inferSlotName(slot, pos);
      slotResults.push({
        slot: pos,
        precedingToken: slot.precedingToken,
        inferredName,
        namingConfidence,
        distinctCount: values.size,
        topValues,
      });
    }

    if (sortByStrength) {
      slotResults.sort((a, b) => {
        const ac = a.topValues[0]?.pct ?? 0;
        const bc = b.topValues[0]?.pct ?? 0;
        return bc - ac;
      });
    }

    const maxConcentration = slotResults[0]?.topValues[0]?.pct ?? 0;

    out.push({
      templateHash: hash,
      symbolMessage: template?.symbolMessage,
      template: template?.template || '(unknown template)',
      count: evts.length,
      severityDistribution: {}, // filled by caller from aggregated.csv if available
      slots: slotResults,
      maxConcentration,
    });
  }

  return out;
}

/**
 * Semantic naming for a slot based on its preceding static token.
 *
 * - structured-log key (`"tenant":"`, `pod_id=`) → high confidence, name from key
 * - natural-language word (`customer`, `tenant`) → medium, name from word + "(inferred)"
 * - punctuation or whitespace only → low, name is `slot_N`
 */
function inferSlotName(
  slot: VariableSlot,
  position: number
): { inferredName: string; namingConfidence: 'high' | 'medium' | 'low' } {
  if (slot.name) {
    return { inferredName: slot.name, namingConfidence: 'high' };
  }
  const tok = slot.precedingToken || '';
  if (!tok) {
    return { inferredName: `slot_${position}`, namingConfidence: 'low' };
  }

  // Structured log key: ends with `":"`, `":`, `=`, `=\"`
  const structured = tok.match(/([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?$/);
  if (structured) {
    return { inferredName: structured[1], namingConfidence: 'high' };
  }

  // Natural-language word right before the slot.
  const wordMatch = tok.match(/\b([A-Za-z][A-Za-z0-9_]{1,})\s*[:=]?\s*$/);
  if (wordMatch) {
    const word = wordMatch[1].toLowerCase();
    // Semantic-sounding words get medium confidence.
    if (word.length >= 3) {
      return { inferredName: `${word} (inferred)`, namingConfidence: 'medium' };
    }
  }

  return { inferredName: `slot_${position}`, namingConfidence: 'low' };
}

/**
 * If the template has no declared slots, infer them positionally from the
 * values in the encoded events. Used as a fallback when the CLI's
 * templates.json doesn't include slot metadata.
 */
function inferSlotsFromValues(events: EncodedEvent[]): VariableSlot[] {
  const maxLen = events.reduce((m, e) => Math.max(m, e.values.length), 0);
  const slots: VariableSlot[] = [];
  for (let i = 0; i < maxLen; i++) {
    slots.push({ position: i });
  }
  return slots;
}
