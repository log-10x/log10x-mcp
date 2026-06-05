/**
 * Strict-args validation for retriever-shaped tools.
 *
 * Why this exists: callers (autonomous agents, chain walkers, tests) routinely
 * pass argument keys that the tool's Zod schema does NOT declare. Today the
 * MCP SDK builds `z.object(shape)` with the default `strip` semantics — so an
 * undeclared key like `pattern_hash: "FU1__vh8hbY"` is silently dropped, the
 * tool runs with `args.pattern === undefined`, and the caller waits ~3 minutes
 * for a zero-event result that should have been a fast unknown_arg error.
 *
 * Verified live on 2026-06-04 against the demo retriever: `retriever_query`
 * with `pattern_hash: "FU1__vh8hbY"` returned 0 events after 185s — no error,
 * no warning, no hint that the arg was discarded. That's the foot-gun this
 * helper closes.
 *
 * Usage at the executor entry point:
 *
 *   const strict = validateStrictArgs('log10x_retriever_query', retrieverQuerySchema, args);
 *   if (strict.error) return strict.error;
 *   // args is the validated, strict-mode object — extra keys would have errored.
 *
 * The returned `error` is a fully-formed chassis error envelope (status:
 * 'error', error_type: 'unknown_arg', retryable: false) — agents read the
 * `hint` field to learn which key(s) were rejected.
 *
 * NOTE: we run the strict check AT the executor entry, not at the registration
 * boundary. The SDK boundary path produces an MCP protocol error rather than
 * our typed envelope; doing it here keeps the chassis envelope shape and also
 * catches direct callers (tests, chain walkers, eval harnesses) that bypass
 * the SDK validation entirely.
 */

import { z, type ZodRawShape } from 'zod';
import { buildChassisErrorEnvelope, type ChassisEnvelope } from './chassis-envelope.js';

export interface StrictArgsResult<T> {
  /** Strictly-validated args; only present when the input had no unknown keys. */
  args?: T;
  /** Pre-built chassis error envelope to return when unknown keys are present. */
  error?: ChassisEnvelope;
}

/**
 * Validate `args` against `shape` with `.strict()` semantics. Unknown keys
 * yield a chassis error envelope; valid args are returned in-place.
 *
 * The `shape` is the same plain-object Zod raw shape the tools export today
 * (e.g. `retrieverQuerySchema`). We wrap it with `z.object(...).strict()`
 * just for the validation pass — the registration path keeps its own
 * coercive wrapper unchanged.
 */
export function validateStrictArgs<T>(
  tool: string,
  shape: ZodRawShape,
  args: unknown,
): StrictArgsResult<T> {
  const strictSchema = z.object(shape).strict();
  const parsed = strictSchema.safeParse(args);
  if (parsed.success) {
    return { args: parsed.data as T };
  }
  // Collect unknown-key issues. Zod emits `code: 'unrecognized_keys'` with
  // `keys: string[]` for strict-mode rejections; other issue codes (type
  // mismatch, missing required) fall through to the SDK's normal validation
  // path so we don't pre-empt those error messages.
  const unrecognized: string[] = [];
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
      for (const k of keys) unrecognized.push(k);
    }
  }
  if (unrecognized.length === 0) {
    // No unknown keys — the parse failed for other reasons (type mismatch,
    // missing required). Pass the raw args through; downstream validation
    // (the SDK boundary or the tool's own defensive defaults) will surface
    // the actual error in its normal shape.
    return { args: args as T };
  }
  const hint = `unknown arg${unrecognized.length === 1 ? '' : 's'}: ${unrecognized.join(', ')}`;
  const error = buildChassisErrorEnvelope({
    tool,
    err: {
      error_type: 'unknown_arg',
      retryable: false,
      suggested_backoff_ms: null,
      hint,
    },
    contextPayload: {
      unknown_args: unrecognized,
      received_args: args && typeof args === 'object' ? Object.keys(args as Record<string, unknown>) : [],
    },
  });
  return { error };
}
