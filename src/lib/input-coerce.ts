/**
 * LLM-tolerant input coercion at the registration layer.
 *
 * Why this exists: Claude Code, Cursor, ChatGPT, and Gemini frequently emit
 * arguments that are *structurally* valid but *type-loose*. The most common
 * cases on the wire are:
 *
 *   - `"limit": "5"`  instead of  `"limit": 5`         (string-quoted number)
 *   - `"top_n": "20"` instead of  `"top_n": 20`        (same)
 *   - `"events": "the only event"`  instead of  `"events": ["the only event"]`
 *     (single string for a string-array field)
 *
 * Strict Zod (which we use at registration) rejects all three with a
 * 4xx-shaped Zod error. From the agent's point of view that looks like a
 * tool that randomly fails on trivial input. Grafana's mcp-grafana solved
 * this in Go via `unmarshalWithIntConversion` at `tools.go:81-128`: before
 * the strict schema runs, walk the schema descriptor and coerce
 * string-quoted numerics into numbers, and single string values into
 * single-element string arrays.
 *
 * This file is the TypeScript equivalent. We do it at the registration
 * boundary, BEFORE the SDK's Zod validator runs, by reaching into the raw
 * `arguments` object and rewriting fields whose declared Zod type is
 * `number` / `integer` / `array of string`. The inner handler still gets
 * a fully-validated, strictly-typed args object — coercion only happens
 * on the outer surface.
 *
 * Limitations:
 *   - We only coerce at the TOP level of the args object. Nested objects
 *     (e.g. `args.metadata.analyzer_cost`) keep Zod's strict behavior.
 *     This matches Grafana's scope; their unmarshaler is also one-level.
 *   - We don't coerce booleans (`"true"` → `true`) because the failure
 *     mode is rare and the cost-of-being-wrong is higher.
 *   - We don't coerce numbers from objects with `.value` keys etc. — the
 *     coercion is intentionally narrow: only the two specific cases the
 *     LLM-host telemetry shows as the bulk of complaints.
 */

import { z, type ZodTypeAny, type ZodRawShape } from 'zod';

type ZodKind = 'number' | 'array-of-string' | 'array-of-number' | 'enum' | 'other';

/** The parts of a Zod 4 schema definition the classifier reads. */
type ZodDefShape = { type?: string; innerType?: ZodTypeAny; element?: ZodTypeAny; entries?: Record<string, unknown> };

/**
 * Inspect a Zod type and classify it for the coercer. Strips `optional`,
 * `default`, and `nullable` wrappers so the underlying type is detected
 * regardless of how the schema author composed it.
 */
function classifyZodType(zod: ZodTypeAny): ZodKind {
  let t: ZodTypeAny = zod;
  // Strip wrapper types. Zod represents `.optional()`, `.default(x)` and
  // `.nullable()` as wrappers that expose the inner type as `_def.innerType`;
  // `.describe(...)` adds no wrapper.
  let safety = 0;
  while (safety++ < 8) {
    const def = (t as unknown as { _def?: ZodDefShape })._def;
    if (!def) break;
    if (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') {
      if (def.innerType) {
        t = def.innerType;
        continue;
      }
    }
    break;
  }
  const def = (t as unknown as { _def?: ZodDefShape })._def;
  if (!def) return 'other';
  if (def.type === 'number') return 'number';
  if (def.type === 'enum') return 'enum';
  if (def.type === 'array') {
    const inner = def.element;
    if (inner) {
      const innerKind = classifyZodType(inner);
      if (innerKind === 'number') return 'array-of-number';
    }
    // Default: treat as array-of-string. We don't try to detect richer
    // element types — the coercion only kicks in on single-string-given-
    // for-array, which is universally a string-array case in our schemas.
    return 'array-of-string';
  }
  return 'other';
}

/**
 * Wrap a single Zod field with a `z.preprocess(fn, original)` so coercion
 * runs BEFORE the schema's validators (min/max/enum/regex/etc.). The output
 * type of `z.preprocess` matches the inner schema's output type, so
 * downstream handler types are unchanged. The JSON Schema serialization of
 * `z.preprocess` (via zod-to-json-schema or the SDK's emitter) is the
 * inner schema's JSON Schema, so what the agent sees in `tools/list` is
 * identical to the un-coerced version.
 *
 * Coercions applied:
 *   - `z.number()` (under optional/default wrappers): string-quoted numerics
 *     get `Number()` parsed. Non-numeric strings pass through untouched so
 *     the inner schema gives a clean type-mismatch error.
 *   - `z.array(z.string())` / `z.array(z.number())`: a single non-array
 *     value gets wrapped in a single-element array.
 *   - `z.array(z.number())`: each element that's a string-quoted numeric
 *     gets `Number()` parsed.
 */
/** The string options of an enum under optional/default/nullable wrappers. */
function enumOptions(zod: ZodTypeAny): string[] {
  let t: ZodTypeAny = zod;
  for (let i = 0; i < 8; i++) {
    const def = (t as unknown as { _def?: ZodDefShape })._def;
    if (def && (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') && def.innerType) {
      t = def.innerType;
      continue;
    }
    break;
  }
  const entries = (t as unknown as { _def?: ZodDefShape })._def?.entries;
  return entries ? Object.values(entries).filter((v): v is string => typeof v === 'string') : [];
}

const DURATION_RE = /^\s*(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)\s*$/i;

/** Minutes in a duration like "24h", "1d", "1w", "90m"; null when not one. */
export function durationMinutes(v: string): number | null {
  const m = DURATION_RE.exec(v);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const u = m[2]!.toLowerCase();
  if (u.startsWith('w')) return n * 7 * 24 * 60;
  if (u.startsWith('d')) return n * 24 * 60;
  if (u.startsWith('h')) return n * 60;
  return n;
}

/**
 * Map a value an enum does not list onto the option it means: the same
 * option in another case, or the listed duration of equal length. Agents
 * send "24h" to every time-window field because most tools list it; three
 * tools list "1d" instead and rejected "24h" as invalid input (hosted demo,
 * 2026-11-13). Unmappable values pass through for the enum's own error.
 */
export function coerceEnumValue(v: unknown, options: string[]): unknown {
  if (typeof v !== 'string' || options.includes(v)) return v;
  const lower = v.trim().toLowerCase();
  const sameCase = options.find((o) => o.toLowerCase() === lower);
  if (sameCase !== undefined) return sameCase;
  const mins = durationMinutes(v);
  if (mins !== null) {
    const same = options.find((o) => durationMinutes(o) === mins);
    if (same !== undefined) return same;
  }
  return v;
}

function wrapFieldForCoercion(zodType: ZodTypeAny): ZodTypeAny {
  const kind = classifyZodType(zodType);
  if (kind === 'enum') {
    const options = enumOptions(zodType);
    if (options.length === 0) return zodType;
    return z.preprocess((v) => coerceEnumValue(v, options), zodType);
  }
  if (kind === 'number') {
    return z.preprocess((v) => {
      if (typeof v === 'string' && v.trim().length > 0) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return v;
    }, zodType);
  }
  if (kind === 'array-of-string') {
    return z.preprocess((v) => {
      if (typeof v === 'string') return [v];
      return v;
    }, zodType);
  }
  if (kind === 'array-of-number') {
    return z.preprocess((v) => {
      let arr: unknown[];
      if (typeof v === 'string') {
        arr = [v];
      } else if (Array.isArray(v)) {
        arr = [...v];
      } else {
        return v;
      }
      for (let i = 0; i < arr.length; i++) {
        const el = arr[i];
        if (typeof el === 'string' && el.trim().length > 0) {
          const n = Number(el);
          if (Number.isFinite(n)) arr[i] = n;
        }
      }
      return arr;
    }, zodType);
  }
  return zodType;
}

/**
 * Build a coercive copy of a Zod shape. Used at tool registration:
 * `applyToolRegistrations()` rewrites every tool's `inputSchema` through
 * this so the SDK's strict Zod validation sees coerced values.
 */
export function makeShapeCoercive(shape: ZodRawShape): ZodRawShape {
  const out: Record<string, ZodTypeAny> = {};
  for (const [key, zodType] of Object.entries(shape)) {
    out[key] = wrapFieldForCoercion(zodType as ZodTypeAny);
  }
  return out;
}
