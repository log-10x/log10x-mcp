/**
 * Cost driver gates.
 *
 * A pattern is a cost driver only if BOTH gates pass:
 * 1. Dollar delta > minDollarPerWeek (default $500/wk)
 * 2. Contribution > minContributionPct of total positive delta (default 5%)
 *
 * These are business rules, not statistical constants.
 * Ported from SlackPatternService.java.
 */

export interface PatternWithDelta {
  delta: number;
}

export interface GateConfig {
  minDollarPerWeek: number;
  minContributionPct: number;
}

export const DEFAULT_GATES: GateConfig = {
  minDollarPerWeek: 500,
  minContributionPct: 5,
};

/**
 * Filters patterns through cost driver gates.
 * Returns only patterns that pass both the dollar floor and contribution % gate.
 */
export function applyCostDriverGates<T extends PatternWithDelta>(
  patterns: T[],
  totalPositiveDelta: number,
  gates: GateConfig = DEFAULT_GATES
): T[] {
  return patterns.filter(p => {
    if (p.delta <= 0) return false;
    const passesDollar = p.delta >= gates.minDollarPerWeek;
    const passesContrib = totalPositiveDelta > 0
      && (p.delta / totalPositiveDelta) * 100 >= gates.minContributionPct;
    return passesDollar && passesContrib;
  });
}
