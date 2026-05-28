/**
 * Unified envelope helpers for the low-woowoo data tools (envelope-
 * consistency pass, 2026-05-28).
 *
 * Low-woowoo tools are those that return data, not calibrated
 * judgments — top_patterns, event_lookup, pattern_examples, etc.
 * They don't need threshold_basis / threshold_audit. They DO need the
 * shared envelope fields the cross-pillar primitives + find_skew +
 * pattern_mitigate use, so the agent gets consistent shapes across
 * the whole catalog:
 *
 *   - status: enum
 *   - query_count: number
 *   - total_latency_ms: number
 *   - backend_pressure_hint: enum | null
 *   - human_summary: string
 *   - error: PrimitiveError (optional)
 *
 * Each tool wraps its execute function with a `Telemetry` instance,
 * increments `queryCount` on each backend call, and calls
 * `buildUnifiedFields` when assembling the response envelope.
 *
 * For tools that throw on backend failures, the wrapper pattern is:
 *
 *   try {
 *     // existing logic
 *     return buildEnvelope({ ..., data: { ...existingData, ...unifiedFields } });
 *   } catch (e) {
 *     return buildErrorEnvelope({ tool, telemetry, err: wrapBackendError(e) });
 *   }
 */

import type { PrimitiveError } from './primitive-errors.js';
import { buildEnvelope, type StructuredOutput } from './output-types.js';

/**
 * Generic status enum used by tools whose semantics don't warrant a
 * tool-specific status type. Tools with richer semantics
 * (anchor_no_phase_separation, etc.) keep their own enums.
 */
export type GenericStatus = 'success' | 'no_signal' | 'insufficient_data' | 'error';

export interface Telemetry {
  startedAt: number;
  queryCount: number;
  throttledHit: boolean;
}

export interface UnifiedEnvelopeFields {
  status: GenericStatus;
  query_count: number;
  total_latency_ms: number;
  backend_pressure_hint: 'ok' | 'slow' | 'throttled' | null;
  human_summary: string;
  error?: PrimitiveError;
}

export function newTelemetry(): Telemetry {
  return { startedAt: Date.now(), queryCount: 0, throttledHit: false };
}

/**
 * Backend pressure heuristic. Rough — not a calibrated rate-limit
 * detector. Returns null when the tool didn't query any backend
 * (paste-mode tools, local-only tools).
 */
export function pressureHint(t: Telemetry): 'ok' | 'slow' | 'throttled' | null {
  if (t.queryCount === 0) return null;
  if (t.throttledHit) return 'throttled';
  if ((Date.now() - t.startedAt) / t.queryCount > 1000) return 'slow';
  return 'ok';
}

export function buildUnifiedFields(opts: {
  status: GenericStatus;
  telemetry: Telemetry;
  humanSummary: string;
  error?: PrimitiveError;
}): UnifiedEnvelopeFields {
  const fields: UnifiedEnvelopeFields = {
    status: opts.status,
    query_count: opts.telemetry.queryCount,
    total_latency_ms: Date.now() - opts.telemetry.startedAt,
    backend_pressure_hint: pressureHint(opts.telemetry),
    human_summary: opts.humanSummary,
  };
  if (opts.error) fields.error = opts.error;
  return fields;
}

/**
 * Build a structured-error envelope for tools that hit a backend
 * failure. Matches the shape used by cross-pillar primitives.
 */
export function buildErrorEnvelope(opts: {
  tool: string;
  telemetry: Telemetry;
  err: PrimitiveError;
  /** Tool-specific minimal data block. Tools fill this in with the
   * input echo (anchor_ref / pattern_ref / etc.) so the error envelope
   * still carries identification. */
  data?: Record<string, unknown>;
}): StructuredOutput {
  return buildEnvelope({
    tool: opts.tool,
    view: 'summary',
    summary: { headline: `Error (${opts.err.error_type}): ${opts.err.hint.slice(0, 120)}` },
    data: {
      ...(opts.data ?? {}),
      ...buildUnifiedFields({
        status: 'error',
        telemetry: opts.telemetry,
        humanSummary: `Call failed: ${opts.err.hint}`,
        error: opts.err,
      }),
    },
  });
}
