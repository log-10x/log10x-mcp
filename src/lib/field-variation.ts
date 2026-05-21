/**
 * Field-variation analysis for `log10x_top_patterns`.
 *
 * Given N parsed events that match the same hash, count distinct values
 * per top-level field in the events' JSON tail. This answers the
 * Reader's core question for a pattern: "what does this hash actually
 * group, beyond just the tokenized name?"
 *
 * Three buckets:
 *   - **varying** — 2 to <80% distinct values. These are real dimensions
 *     the pattern groups over. Worth drilling for the Reader.
 *   - **noise** — ≥80% distinct values relative to N. Per-event values
 *     (timestamps, durations, request IDs); not actionable.
 *   - **constant** — exactly one distinct value across N. Defines the
 *     pattern's identity; same for every event.
 *
 * Nested objects (the otelcol `resource` block, for example) flatten
 * one level so `resource.service.instance.id` becomes a flat key the
 * Reader can read without descending into JSON in their head.
 */

import type { ParsedSiemEvent } from './siem/sample.js';

export interface FieldVariationEntry {
  /** Flat field name. */
  field: string;
  /** Distinct values seen across the sample. */
  distinct: number;
  /** True if distinct count is ≥80% of N — treat as continuous/noise. */
  isNoise: boolean;
  /** First few distinct values, in insertion order from the underlying
   * Set. Lets the renderer show concrete examples so the Reader can
   * tell "17 distinct rejected_items" is `100, 250, 500…` (real
   * counts) vs `a8f3-, 9d2e-, …` (opaque IDs). Capped at 3 to keep
   * cards skim-able. */
  sampleValues: string[];
}

export interface FieldVariation {
  /** Number of events that contributed (had a parsed JSON tail). */
  totalEvents: number;
  /** Fields with 2..(<80%) distinct values — drill candidates. */
  varying: FieldVariationEntry[];
  /** Fields with ≥80% distinct values — per-event noise. */
  noise: FieldVariationEntry[];
  /** Fields with exactly 1 distinct value — define the pattern's identity. */
  constants: FieldVariationEntry[];
}

const MAX_VALUE_CHARS = 200;
const NOISE_THRESHOLD_PCT = 0.8;
const NOISE_MIN_EVENTS = 5;

/**
 * Compute field variation across a set of events. Caller is expected
 * to have pulled the events with `fetchEventsByHashes` so each event's
 * `logJson` is populated (when parseable).
 */
export function fieldVariation(events: ParsedSiemEvent[]): FieldVariation {
  const fieldValues = new Map<string, Set<string>>();
  let n = 0;

  for (const ev of events) {
    if (!ev.logJson) continue;
    n++;
    for (const [key, val] of Object.entries(ev.logJson)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        // Flatten one level — e.g. resource.{service.instance.id, ...}
        for (const [subKey, subVal] of Object.entries(val as Record<string, unknown>)) {
          if (isScalar(subVal)) {
            const flat = `${key}.${subKey}`;
            const set = fieldValues.get(flat) ?? new Set<string>();
            set.add(String(subVal).slice(0, MAX_VALUE_CHARS));
            fieldValues.set(flat, set);
          }
        }
      } else if (isScalar(val)) {
        const set = fieldValues.get(key) ?? new Set<string>();
        set.add(String(val).slice(0, MAX_VALUE_CHARS));
        fieldValues.set(key, set);
      }
    }
  }

  const entries: FieldVariationEntry[] = [];
  for (const [field, values] of fieldValues.entries()) {
    const distinct = values.size;
    const isNoise = n >= NOISE_MIN_EVENTS && distinct >= NOISE_THRESHOLD_PCT * n;
    // First 3 distinct values, insertion order — enough to convey
    // shape ("100, 250, 500" vs "a8f3-..., 9d2e-...") without
    // ballooning the card body.
    const sampleValues: string[] = [];
    for (const v of values) {
      if (sampleValues.length >= 3) break;
      sampleValues.push(v);
    }
    entries.push({ field, distinct, isNoise, sampleValues });
  }

  const varying = entries
    .filter(e => !e.isNoise && e.distinct > 1)
    .sort((a, b) => b.distinct - a.distinct);
  const noise = entries
    .filter(e => e.isNoise)
    .sort((a, b) => a.field.localeCompare(b.field));
  const constants = entries
    .filter(e => !e.isNoise && e.distinct === 1)
    .sort((a, b) => a.field.localeCompare(b.field));

  return { totalEvents: n, varying, noise, constants };
}

function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}
