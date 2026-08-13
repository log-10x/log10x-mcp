/**
 * Severity policy — the one definition of which severities are protected
 * (kept verbatim) and which may take a lossless lever.
 *
 * Two surfaces would otherwise carry private copies of this rule and drift
 * apart: the POC report renderer, which tells a prospect what will happen,
 * and `configure_engine`'s solver, which decides what actually happens. A
 * report promising "ERROR/CRIT/FATAL and low-volume patterns are kept
 * verbatim. Nothing is sampled or dropped." while the solver assigns
 * `sample` to every error/warn/warning pattern is the failure this
 * prevents, along with the two classifying WARN opposite ways and the
 * renderer disagreeing with itself (risk-review paths treating WARN as
 * error-class where the action selector does not).
 *
 * Everything resolves through here, and `test/severity-policy-drift.test.ts`
 * fails if the rendered promise and the solver default diverge.
 *
 * WARN is PROTECTED. `configure_engine`'s `inferTier` puts warn/warning in the
 * same tier as error, and the customer-facing text has to match the solver
 * rather than the other way round.
 *
 * Callers uppercase their severity before testing in most cases; both
 * predicates are case-insensitive so it does not matter either way.
 */

/**
 * Error-class severities: ERROR, WARN/WARNING, CRIT/CRITICAL, FATAL.
 * Never reduced by any auto path. Substring matching is deliberate so
 * WARNING/CRITICAL and vendor-prefixed spellings ("LOG_ERROR") both match.
 */
export const PROTECTED_SEVERITY_RE = /ERROR|WARN|CRIT|FATAL/i;

/**
 * Severities an auto path may put a lossless lever on. A pattern with no
 * severity attribution counts as reducible; `isReducibleSeverity` handles
 * that case, since it is not something a string test can express.
 */
export const REDUCIBLE_SEVERITY_RE = /DEBUG|INFO|TRACE/i;

/** True when the severity is error-class and must be kept verbatim. */
export function isProtectedSeverity(severity?: string | null): boolean {
  return !!severity && PROTECTED_SEVERITY_RE.test(severity);
}

/**
 * True when the severity may take a lossless lever. Protected always wins, so
 * the two predicates can never both be true for the same input.
 */
export function isReducibleSeverity(severity?: string | null): boolean {
  if (!severity) return true;
  if (isProtectedSeverity(severity)) return false;
  return REDUCIBLE_SEVERITY_RE.test(severity);
}

/**
 * Minimum share of patterns that must carry a severity before any auto path
 * may recommend a lossless lever.
 *
 * `isReducibleSeverity(undefined)` returning true is correct per-pattern (a
 * single unlabelled INFO line should not block a recommendation) but it fails
 * OPEN in aggregate: when severity extraction returns nothing at all, every
 * pattern reads as reducible and the "ERROR/WARN/CRIT/FATAL kept verbatim"
 * promise silently cannot fire. An engine config that omits its aggregator
 * produces exactly that: 0% coverage, and ERROR patterns queued for
 * reduction.
 *
 * A gate has to fail on the known-broken input, so below this floor the
 * recommender refuses rather than guesses.
 */
export const MIN_SEVERITY_COVERAGE = 0.5;

/**
 * True when enough patterns carry a severity to honour the protected-severity
 * promise. `coverage` is a 0..1 fraction of patterns, not of events.
 */
export function severityAttributionSufficient(coverage: number | undefined): boolean {
  return typeof coverage === 'number' && coverage >= MIN_SEVERITY_COVERAGE;
}

/**
 * The severity names the report's "kept verbatim" sentence lists, in the
 * order it lists them. The drift test reads this, not the prose, so a prose
 * edit that drops a severity cannot silently widen what gets reduced.
 */
export const PROTECTED_SEVERITY_LABELS = ['ERROR', 'WARN', 'CRIT', 'FATAL'] as const;

/**
 * The severity names the report's "reducible pattern" clause lists.
 */
export const REDUCIBLE_SEVERITY_LABELS = ['DEBUG', 'INFO', 'TRACE'] as const;
