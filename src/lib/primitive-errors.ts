/**
 * Structured error envelope for cross-pillar primitives.
 *
 * Without this, the primitives throw string errors when the customer
 * backend fails. An agent caller gets the string and has to NLP-parse it
 * to decide whether to retry, back off, or give up. A structured error
 * envelope lets the agent branch on a typed category instead.
 *
 * This module defines:
 *   - `PrimitiveErrorType` — the taxonomy of error categories an agent
 *     can branch on.
 *   - `PrimitiveError` — the envelope shape returned in tool output
 *     when the call fails before useful results.
 *   - `wrapBackendError()` — translates a thrown Error from the
 *     backend layer (GenericPromBackend / Log10xBackend / etc.) into
 *     a typed `PrimitiveError`.
 *
 * Error envelopes are returned in the tool's `data.error` field with
 * `status: "error"` on the top level. The agent reads `error_type` to
 * decide:
 *
 *   - `backend_timeout` / `backend_unavailable` → retryable, back off
 *   - `anchor_not_found` → re-anchor with a different pattern
 *   - `candidate_too_many` → caller-side input error, won't retry-fix
 *   - `schema_invalid` → caller-side input error
 *   - `partial_failure` → some candidates succeeded; check
 *     evaluation_failed[] for details
 *   - `unknown` → log and surface to user; not auto-retryable
 */

export const PRIMITIVE_ERROR_TYPES = [
  'backend_timeout',
  'backend_unavailable',
  'anchor_not_found',
  'candidate_too_many',
  'schema_invalid',
  'partial_failure',
  /** Local-engine tools: input failed validation (empty events, malformed
   * payload, exceeded size cap). Caller-side bug; do NOT retry. */
  'input_invalid',
  /** Local-engine tools: local processing failed (engine error, parse
   * failure, tenx CLI not installed). Surface to user; retry only if the
   * underlying cause is resolved. */
  'local_processing_failed',
  /** Required identifier (pattern_hash / pattern name) was not passed. */
  'missing_identifier',
  /** No environment is configured; run discover_env first. */
  'no_environment',
  /** Tool requires a destination (SIEM vendor) but none was supplied or
   * could be auto-detected. */
  'missing_destination',
  /** Auto-detected destination is not in this tool's supported set.
   * Caller should pass the destination explicitly. */
  'unsupported_destination',
  /** Multiple SIEM vendors found; cannot choose automatically. Caller
   * must supply destination explicitly. */
  'ambiguous_destination',
  /** A required numeric or scalar input was not supplied. */
  'missing_input',
  /** The requested action would be a no-op (e.g. all patterns already
   * below threshold). Not a backend error; informational. */
  'noop_action',
  /** A required configuration value (API key, config file, env var) is
   * absent. Different from no_environment: covers tool-level config that
   * is not the environment identity. */
  'config_missing',
  /** Metric / data backend returned no signal for the query window. Tool
   * ran successfully but there is nothing to show. */
  'no_signal',
  /** Generic backend-layer error not covered by more specific types. */
  'backend_error',
  /** The requested operation would write to an external system but is
   * blocked by a read-only or demo-env guard. Pass dry_run=true to
   * preview without writing, or switch to a non-demo environment. */
  'write_not_allowed',
  /** Caller passed an argument key that is not declared in the tool's
   * input schema. Detected at the executor entry point via `.strict()`
   * validation. Caller-side bug — DO NOT retry; surface the rejected
   * key(s) so the agent can correct the call. */
  'unknown_arg',
  /** The MCP is running in the hosted demo playground with
   * `LOG10X_MCP_READ_ONLY=true`. Writer tools refuse to execute and
   * return a `demo_read_only` envelope describing what they WOULD have
   * done. Catalog stays visible; execution is gated. Not retryable — the
   * caller must run against a real environment with the env var unset. */
  'demo_read_only',
  'unknown',
] as const;

export type PrimitiveErrorType = (typeof PRIMITIVE_ERROR_TYPES)[number];

export interface PrimitiveError {
  error_type: PrimitiveErrorType;
  /** Whether the agent should retry the call after `suggested_backoff_ms`. */
  retryable: boolean;
  /** Hint for the agent's backoff. Null when retryable=false. */
  suggested_backoff_ms: number | null;
  /** Plain-English context for the agent OR a human reading the log. */
  hint: string;
}

/**
 * Translate an arbitrary thrown error (string or Error) from the
 * customer-metrics backend layer into a typed `PrimitiveError`.
 *
 * The current `GenericPromBackend.fetchJson` throws strings of the form
 * `"generic_prom HTTP 503: ..."`. We pattern-match on the status code
 * to classify retryability and backoff.
 */
export function wrapBackendError(err: unknown): PrimitiveError {
  const msg = err instanceof Error ? err.message : String(err);

  // HTTP status-coded throws from GenericPromBackend / Log10xBackend.
  const httpMatch = msg.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    if (status === 503 || status === 502 || status === 504) {
      return {
        error_type: 'backend_unavailable',
        retryable: true,
        suggested_backoff_ms: 2000,
        hint: `Backend returned HTTP ${status}. Retry after backoff. Original: ${msg.slice(0, 200)}`,
      };
    }
    if (status === 408 || status === 429) {
      return {
        error_type: 'backend_timeout',
        retryable: true,
        // 429 (rate limit) → longer backoff than 408 (timeout).
        suggested_backoff_ms: status === 429 ? 5000 : 1500,
        hint: `Backend returned HTTP ${status}. Retry after backoff. Original: ${msg.slice(0, 200)}`,
      };
    }
    if (status === 400 || status === 422) {
      return {
        error_type: 'schema_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `Backend rejected the query as malformed (HTTP ${status}). Check the PromQL syntax. Original: ${msg.slice(0, 200)}`,
      };
    }
    if (status === 404) {
      return {
        error_type: 'anchor_not_found',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `Backend returned HTTP 404 — the queried metric or endpoint does not exist. Original: ${msg.slice(0, 200)}`,
      };
    }
  }

  // Network-level failures surfaced by node's fetch.
  if (/ECONN|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return {
      error_type: 'backend_unavailable',
      retryable: true,
      suggested_backoff_ms: 3000,
      hint: `Network-level failure reaching the customer backend. Retry after backoff. Original: ${msg.slice(0, 200)}`,
    };
  }

  return {
    error_type: 'unknown',
    retryable: false,
    suggested_backoff_ms: null,
    hint: msg.slice(0, 300),
  };
}
