/**
 * Scenario validators — pure functions that run after the agent finishes.
 *
 * Two responsibilities:
 *   1. LCS-style subsequence match against `expected_sequence.must_include`
 *      (so the agent can interleave extra steps without failing the test,
 *      as long as the canonical chain appears in order).
 *   2. Ground-truth assertions against tool results / final text /
 *      tool-call args (the four matcher_kinds: contains | regex |
 *      numeric_range | rank_at_least).
 *
 * Both produce structured results consumed by the report writer and the
 * pass/fail gate in run-scenario.mjs.
 */
import type {
  Scenario,
  GroundTruthAssertion,
  GroundTruthResult,
  SequenceDiff,
} from './types.js';
import type { ParsedTranscript } from './transcript-parser.js';

// ─── Sequence diff ──────────────────────────────────────────────────────

export function computeSequenceDiff(
  scenario: Scenario,
  parsed: ParsedTranscript
): SequenceDiff {
  const actual = parsed.toolCalls.map((c) => c.name);
  const must = scenario.expected_sequence.must_include;
  const mustNot = scenario.expected_sequence.must_not_include ?? [];
  const tolerance = scenario.expected_sequence.tolerance;

  const { satisfied, missing } = subsequenceMatch(actual, must, tolerance);

  // "extra" = tools called but not in must_include (just informative; not a failure)
  const expectedSet = new Set(must);
  const extra = actual.filter((t) => !expectedSet.has(t));

  const mustNotIncludeViolations = mustNot.filter((t) => actual.includes(t));

  return {
    expected: must,
    actual,
    missing,
    extra,
    mustNotIncludeViolations,
    satisfied: satisfied && mustNotIncludeViolations.length === 0,
  };
}

/**
 * Subsequence match: every element of `must` appears in `actual` in
 * order. Extras between expected steps are always allowed — tolerance
 * here is a *global* budget on missing-but-required items.
 *
 * Earlier versions used a per-gap "extras allowed" counter; that
 * fought autonomous chains that fan wide between expected anchors
 * (e.g., cost_drivers → 6 hints → dependency_check is a perfectly
 * good chain, but tolerance=2 between gaps would reject it). The
 * point of must_include is to verify ordered coverage, not minimize
 * detours. must_not_include is the lever for catching wrong tool
 * routing; tolerance just decides how many missing required tools we
 * forgive.
 */
function subsequenceMatch(
  actual: string[],
  must: string[],
  tolerance: number
): { satisfied: boolean; missing: string[] } {
  if (must.length === 0) return { satisfied: true, missing: [] };
  const missing: string[] = [];
  let cursor = 0;
  for (const expected of must) {
    const found = actual.indexOf(expected, cursor);
    if (found < 0) {
      missing.push(expected);
    } else {
      cursor = found + 1;
    }
  }
  return { satisfied: missing.length <= tolerance, missing };
}

// ─── Ground-truth assertions ────────────────────────────────────────────

export function evaluateGroundTruth(
  scenario: Scenario,
  parsed: ParsedTranscript
): GroundTruthResult[] {
  return scenario.ground_truth.map((a) => evaluateOne(a, parsed));
}

function evaluateOne(a: GroundTruthAssertion, parsed: ParsedTranscript): GroundTruthResult {
  const haystack = collectScopeText(a, parsed);

  switch (a.matcher_kind) {
    case 'contains': {
      const ci = a.case_insensitive ?? false;
      const h = ci ? haystack.toLowerCase() : haystack;
      const needle = ci ? a.value.toLowerCase() : a.value;
      const passed = h.includes(needle);
      return {
        description: a.description,
        matcher_kind: a.matcher_kind,
        passed,
        detail: passed
          ? `found "${a.value}"${a.tool ? ` in ${a.tool} result` : ''}`
          : `"${a.value}" not found in ${a.scope}${a.tool ? ` for tool ${a.tool}` : ''} (${haystack.length} chars searched)`,
      };
    }
    case 'regex': {
      const re = new RegExp(a.pattern, a.flags ?? '');
      const passed = re.test(haystack);
      return {
        description: a.description,
        matcher_kind: a.matcher_kind,
        passed,
        detail: passed
          ? `regex /${a.pattern}/${a.flags ?? ''} matched`
          : `regex /${a.pattern}/${a.flags ?? ''} did not match`,
      };
    }
    case 'numeric_range': {
      const re = new RegExp(a.extract);
      const m = haystack.match(re);
      if (!m || m[1] === undefined) {
        return {
          description: a.description,
          matcher_kind: a.matcher_kind,
          passed: false,
          detail: `extract pattern /${a.extract}/ matched no capturing group`,
        };
      }
      const n = Number(m[1]);
      if (Number.isNaN(n)) {
        return {
          description: a.description,
          matcher_kind: a.matcher_kind,
          passed: false,
          detail: `extracted value "${m[1]}" is not numeric`,
        };
      }
      const okMin = a.min === undefined || n >= a.min;
      const okMax = a.max === undefined || n <= a.max;
      const passed = okMin && okMax;
      return {
        description: a.description,
        matcher_kind: a.matcher_kind,
        passed,
        detail: passed
          ? `extracted ${n} (in [${a.min ?? '-∞'}, ${a.max ?? '∞'}])`
          : `extracted ${n} not in [${a.min ?? '-∞'}, ${a.max ?? '∞'}]`,
      };
    }
    case 'rank_at_least': {
      // Find every occurrence position of `pattern` in haystack and
      // count how many *distinct* lines it appears on at-or-before
      // position `max_rank`. We interpret rank by line ordering:
      // tool_results / final_text are typically markdown tables where
      // line N is rank N.
      const lines = haystack.split('\n');
      let rank = -1;
      const re = new RegExp(a.pattern);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          rank = i + 1;
          break;
        }
      }
      const passed = rank > 0 && rank <= a.max_rank;
      return {
        description: a.description,
        matcher_kind: a.matcher_kind,
        passed,
        detail: passed
          ? `pattern /${a.pattern}/ found at line ${rank} (≤${a.max_rank})`
          : rank > 0
            ? `pattern found at line ${rank}, exceeds max_rank ${a.max_rank}`
            : `pattern /${a.pattern}/ not found`,
      };
    }
  }
}

function collectScopeText(a: GroundTruthAssertion, parsed: ParsedTranscript): string {
  switch (a.scope) {
    case 'tool_result': {
      // tool-result text(s) for the named tool, or all if no tool given.
      const ids = a.tool
        ? new Set(parsed.toolCalls.filter((c) => c.name === a.tool).map((c) => c.id))
        : null;
      return parsed.toolResults
        .filter((r) => (ids ? ids.has(r.tool_use_id) : true))
        .map((r) => r.text)
        .join('\n\n');
    }
    case 'final_text':
      return parsed.finalText;
    case 'tool_call_args': {
      const calls = a.tool
        ? parsed.toolCalls.filter((c) => c.name === a.tool)
        : parsed.toolCalls;
      return calls.map((c) => JSON.stringify(c.input)).join('\n');
    }
  }
}
