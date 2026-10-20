import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planForResponse, RESPONSE_KEPT_ROWS } from '../src/tools/poc-from-local.js';
import type { Plan, PlannedRow } from '../src/lib/plan-solver.js';

function row(i: number, bill: number): PlannedRow {
  return { hash: `h${i}`, name: `p${i}`, displayName: `p${i}`, dominantService: 'svc', serviceMix: [], severity: 'INFO', billUsd: bill, action: 'pass', savedUsd: 0, keepsEverything: true } as PlannedRow;
}

test('the response keeps the costliest kept rows and counts the rest; planned rows are untouched', () => {
  const kept = Array.from({ length: 2240 }, (_, i) => row(i, i % 97));
  const planned = [row(9000, 50)];
  const plan = { kept, planned } as unknown as Plan;
  const out = planForResponse(plan);
  assert.equal(out.kept.length, RESPONSE_KEPT_ROWS);
  assert.equal(out.keptTotal, 2240);
  assert.equal(out.keptOmitted, 2240 - RESPONSE_KEPT_ROWS);
  assert.ok(out.kept.every((r) => r.billUsd === 96));
  assert.equal(out.planned, planned);
  assert.equal(plan.kept.length, 2240, 'the full plan is not modified');
});

test('a small plan is returned as it is', () => {
  const plan = { kept: [row(1, 1)], planned: [] } as unknown as Plan;
  assert.equal(planForResponse(plan), plan);
});
