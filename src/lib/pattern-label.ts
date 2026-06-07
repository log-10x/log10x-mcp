/**
 * Shared pattern-label helper for user-facing headlines + summaries.
 *
 * BURNED RULE (memory: feedback_no_hash_in_user_headlines):
 *   Lead with pattern name + service + state, NOT raw symbol_message
 *   blobs (underscored token sequences like
 *   "terror_v_logger_go_failed_t_resource_service_instance_id_...").
 *
 * Math-lens workflows surfaced this defect in SIX separate tools across
 * this session (whats_changing, pattern_mitigate, top_patterns,
 * whats_new, pattern_detail, pattern_trend). Each tool had its own
 * formatHeadlineDescriptor-like function with the same shape, all
 * subtly different. Refactored to a single shared helper so the next
 * tool can't re-introduce the bug.
 *
 * The label format:
 *   - With service + severity: "<service> <SEVERITY> pattern (<hint>)"
 *   - With service only:       "<service> pattern (<hint>)"
 *   - With hint only:          "<hint>"
 *   - Fallback:                "pattern"
 *
 * <hint> is the symbol_message with underscores replaced by spaces,
 * capped at maxHintChars (default 40) and suffixed with "..." when
 * truncated. When the symbol_message is empty, the hint is dropped
 * and we render just the service-led lead.
 *
 * Callers should keep the raw underscored symbol_message + pattern_hash
 * in the payload (machine fields) for round-trip and downstream tool
 * chaining; this helper is for prose only.
 */

export interface PatternLabelInput {
  /** Raw symbol_message (underscored tokens) or descriptor. May be null/undefined. */
  symbol_message?: string | null;
  /** Top service name when available (from services[0].name or scope_service). */
  service?: string | null;
  /** Severity of the top service when available (ERROR, INFO, DEBUG, etc.). */
  severity?: string | null;
  /** Override the default 40-char hint cap. */
  maxHintChars?: number;
  /** Fallback string when no signal at all is available. */
  fallback?: string;
}

export function formatPatternLabel(input: PatternLabelInput): string {
  const fallback = input.fallback ?? 'pattern';
  const svc = input.service?.trim();
  const sev = input.severity?.trim();
  const lead = svc
    ? sev && sev.length > 0
      ? `${svc} ${sev} pattern`
      : `${svc} pattern`
    : null;

  const raw = (input.symbol_message ?? '').trim();
  const hint = raw.replace(/_/g, ' ');
  const maxHint = input.maxHintChars ?? 40;
  const truncatedHint =
    hint.length > maxHint ? hint.slice(0, Math.max(0, maxHint - 3)) + '...' : hint;

  if (lead && truncatedHint) return `${lead} (${truncatedHint})`;
  if (lead) return lead;
  if (truncatedHint) return truncatedHint;
  return fallback;
}

/**
 * Convenience wrapper that pulls service + severity from a typical
 * services[] array shape used across whats_changing, pattern_mitigate,
 * pattern_detail, etc.
 */
export function formatPatternLabelFromServices(input: {
  symbol_message?: string | null;
  services?: Array<{ name?: string; service?: string; severity?: string }>;
  maxHintChars?: number;
  fallback?: string;
}): string {
  const top = input.services?.[0];
  return formatPatternLabel({
    symbol_message: input.symbol_message,
    service: top?.name ?? top?.service,
    severity: top?.severity,
    maxHintChars: input.maxHintChars,
    fallback: input.fallback,
  });
}
