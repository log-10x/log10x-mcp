import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solvePlan, type SolverPattern } from '../src/lib/plan-solver.js';

/** A capture's worth of patterns: 2,600 across 30 containers, mostly INFO, sizes spread over four decades. */
function capture(n = 2600): SolverPattern[] {
  const out: SolverPattern[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = Math.round(1000 * Math.pow(10, (i * 7919) % 4000 / 1000));
    out.push({
      hash: `h${i}`,
      name: `pattern_${i}`,
      services: { [`svc${i % 30}`]: bytes },
      severity: i % 11 === 0 ? 'ERROR' : 'INFO',
      bytes,
      avgEventBytes: 200 + (i % 7) * 50,
    });
  }
  return out;
}

// The tier_down selection looked up every moved pattern with a linear search on
// every step, cubic in the pattern count: a 30% target on 2,608 patterns took
// minutes. Each case below runs in about a second on the fixed solver.
for (const destination of ['datadog', 'cloudwatch'] as const) {
  test(`a 30% target on 2,600 patterns plans in seconds (${destination})`, () => {
    const t0 = Date.now();
    const plan = solvePlan(capture(), { destination, retrieverInstalled: false, targetPct: 30 });
    const ms = Date.now() - t0;
    assert.ok(plan.planned.length > 0, 'expected planned rows');
    assert.ok(ms < 15_000, `solvePlan took ${ms} ms`);
  });
}
