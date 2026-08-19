import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solvePlan, keepEverythingLever, type SolverPattern } from '../src/lib/plan-solver.js';

// A small synthetic estate: two big INFO patterns per service, one ERROR.
function estate(): SolverPattern[] {
  return [
    { hash: 'p1', name: 'Transaction complete', services: { payment: 100_000_000_000 }, severity: 'INFO', bytes: 100_000_000_000 },
    { hash: 'p2', name: 'Charge received', services: { payment: 90_000_000_000 }, severity: 'INFO', bytes: 90_000_000_000 },
    { hash: 'c1', name: 'GetCart', services: { cart: 80_000_000_000 }, severity: 'INFO', bytes: 80_000_000_000 },
    { hash: 'c2', name: 'AddItem', services: { cart: 70_000_000_000 }, severity: 'INFO', bytes: 70_000_000_000 },
    { hash: 'e1', name: 'Charge FAILED', services: { payment: 60_000_000_000 }, severity: 'ERROR', bytes: 60_000_000_000 },
  ];
}

test('lever derivation: compact destinations, tier_down destinations, retriever gate', () => {
  assert.equal(keepEverythingLever('splunk', true), 'compact');
  assert.equal(keepEverythingLever('clickhouse', true), 'compact');
  assert.equal(keepEverythingLever('cloudwatch', true), 'tier_down');
  assert.equal(keepEverythingLever('datadog', true), 'tier_down');
  // sumo has no in-SIEM lever; with the retriever it offloads, without it there is none.
  assert.equal(keepEverythingLever('sumo', true), 'offload');
  assert.equal(keepEverythingLever('sumo', false), null);
});

test('errors are pinned at pass — never planned', () => {
  const pl = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 50 });
  assert.ok(pl.planned.every((r) => r.severity.toUpperCase() !== 'ERROR'));
  assert.ok(pl.kept.some((r) => r.hash === 'e1' && r.action === 'pass'));
});

test('compact destination hits the target losslessly, everything kept', () => {
  const pl = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 50 });
  assert.ok(pl.met, `expected met, got ${pl.achievedPct}%`);
  assert.ok(pl.planned.every((r) => r.action === 'compact'));
  assert.ok(pl.planned.every((r) => r.keepsEverything));
  assert.equal(pl.gap, null);
});

test('tier_down destination + retriever escalates to offload only as needed', () => {
  const pl = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  assert.ok(pl.met);
  // in-SIEM tier_down carries most; offload closes the gap, nothing lossy.
  assert.ok(pl.planned.some((r) => r.action === 'tier_down'));
  assert.ok(pl.planned.every((r) => r.keepsEverything));
});

test('tier_down destination WITHOUT retriever falls short and names the remedies', () => {
  const pl = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 50 });
  assert.equal(pl.met, false);
  assert.ok(pl.gap);
  assert.ok(pl.gap!.remedies.includes('install_retriever'));
  assert.ok(pl.gap!.remedies.includes('accept_loss'));
  // nothing lossy was applied silently
  assert.ok(pl.planned.every((r) => r.action !== 'drop' && r.action !== 'sample'));
});

test('allowLossy closes the shortfall with the minimum drop, opt-in only', () => {
  const noLossy = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 50 });
  const withLossy = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 50, allowLossy: true });
  assert.equal(noLossy.planned.some((r) => r.action === 'drop'), false);
  assert.ok(withLossy.met);
  assert.ok(withLossy.planned.some((r) => r.action === 'drop'));
});

test('service scope: solving one service ignores the rest', () => {
  const all = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  const pay = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50, scope: ['payment'] });
  assert.ok(pay.planned.every((r) => r.dominantService === 'payment'));
  assert.ok(pay.planned.length <= all.planned.length);
  assert.ok(pay.met);
});

test('reconciliation: same method on two different windows both hit the target', () => {
  // "POC" (small sample) and "analysis" (larger) of the same shape both reconcile.
  const small = estate();
  const large = estate().map((p) => ({ ...p, bytes: p.bytes * 1000, services: Object.fromEntries(Object.entries(p.services).map(([s, b]) => [s, b * 1000])) }));
  const a = solvePlan(small, { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  const b = solvePlan(large, { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  assert.ok(a.met && b.met);
  // same lever, same action vocabulary — the plans agree in shape at any scale
  assert.equal(a.keepEverythingLever, b.keepEverythingLever);
});

test('tier_down is priced on its destinations (regression: Datadog was $0, Serverless absent)', async () => {
  const { projectAction } = await import('../src/lib/cost.js');
  // The exact bug surface: tier_down must produce a real dollar cut where it is
  // the destination lever. Datadog (Flex) had no tier and returned $0; Elastic
  // Serverless had no tier at all.
  for (const destination of ['datadog', 'cloudwatch', 'elastic-serverless'] as const) {
    const bill = projectAction({ action: 'pass', bytes_in: 1e9, destination }).total_dollars ?? 0;
    const after = projectAction({ action: 'tier_down', bytes_in: 1e9, destination }).total_dollars ?? bill;
    assert.ok(bill > 0, `${destination} should have a bill`);
    assert.ok(after < bill, `${destination} tier_down must cut the bill (was ${bill} -> ${after})`);
  }
  // Datadog cut 50% now reaches the target on tier_down alone.
  const dd = solvePlan(
    [{ hash: 'x', name: 'noisy', services: { app: 50_000_000_000 }, severity: 'INFO', bytes: 50_000_000_000 }],
    { destination: 'datadog', retrieverInstalled: false, targetPct: 40 },
  );
  assert.equal(dd.keepEverythingLever, 'tier_down');
  assert.ok(dd.met, `Datadog should meet 40% via tier_down, got ${dd.achievedPct}%`);
});
