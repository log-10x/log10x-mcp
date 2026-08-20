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

test('same-hash template variants merge into one row (per-row savings stay per-lever)', () => {
  // Two variants of one message type share a tenx_hash. Planned separately they
  // collided in the action map and a row could render a 4% cut where the lever
  // gives ~51%. Merged, there is one row whose saving is the lever's cut of the
  // combined bill.
  const twoVariants: SolverPattern[] = [
    { hash: 'same', name: 'variant A', services: { app: 60_000_000_000 }, severity: 'INFO', bytes: 60_000_000_000 },
    { hash: 'same', name: 'variant B', services: { app: 40_000_000_000 }, severity: 'INFO', bytes: 40_000_000_000 },
  ];
  const pl = solvePlan(twoVariants, { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 40 });
  assert.equal(pl.planned.length + pl.kept.length, 1, 'variants must merge to one message type');
  const row = pl.planned[0];
  const cut = row.savedUsd / row.billUsd;
  assert.ok(cut > 0.4 && cut < 0.7, `merged row must carry the lever's real cut, got ${(cut * 100).toFixed(0)}%`);
});

test('a protected variant pins the whole merged message type', () => {
  const mixed: SolverPattern[] = [
    { hash: 'same', name: 'big INFO variant', services: { app: 90_000_000_000 }, severity: 'INFO', bytes: 90_000_000_000 },
    { hash: 'same', name: 'ERROR variant', services: { app: 10_000_000_000 }, severity: 'ERROR', bytes: 10_000_000_000 },
  ];
  const pl = solvePlan(mixed, { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 40 });
  assert.equal(pl.planned.length, 0, 'a protected variant must pin the merged row at pass');
  assert.equal(pl.kept[0]?.action, 'pass');
});

// ── Budget targets ──────────────────────────────────────────────────

test('usd_budget: derives the cut, lands at or under the line, echoes the ask', () => {
  const base = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 1 });
  const budget = base.billUsd * 0.6; // force a ~40% cut
  const pl = solvePlan(estate(), {
    destination: 'splunk', retrieverInstalled: true,
    target: { kind: 'usd_budget', value: budget },
  });
  assert.equal(pl.target.kind, 'usd_budget');
  assert.ok(pl.met, `expected met, landsAt=${pl.landsAtUsd} budget=${budget}`);
  assert.ok(pl.landsAtUsd !== undefined && pl.landsAtUsd <= budget * 1.0001);
  assert.ok(pl.planned.length > 0);
  // rows still speak dollars
  assert.ok(pl.planned.every((r) => r.savedUsd > 0));
});

test('usd_budget: already under budget is an empty plan, met, full headroom', () => {
  const base = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 1 });
  const pl = solvePlan(estate(), {
    destination: 'splunk', retrieverInstalled: true,
    target: { kind: 'usd_budget', value: base.billUsd * 2 },
  });
  assert.ok(pl.met);
  assert.equal(pl.planned.length, 0);
  assert.ok(Math.abs((pl.landsAtUsd ?? 0) - pl.billUsd) < 1e-9);
});

test('usd_budget: unreachable line names the gap in budget terms', () => {
  // cloudwatch without retriever: tier_down alone cannot get near a 90% cut.
  const base = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 1 });
  const budget = base.billUsd * 0.1;
  const pl = solvePlan(estate(), {
    destination: 'cloudwatch', retrieverInstalled: false,
    target: { kind: 'usd_budget', value: budget },
  });
  assert.equal(pl.met, false);
  assert.ok(pl.gap);
  assert.ok(pl.gap!.message.includes('budget'), pl.gap!.message);
  assert.ok(pl.gap!.message.includes('over'), pl.gap!.message);
  assert.ok(pl.gap!.remedies.includes('install_retriever'));
});

test('gb_budget: tier_down is excluded — bytes only move via offload/compact', () => {
  // 400 GB of non-error bytes; budget 150 GB/mo forces real byte removal.
  const pl = solvePlan(estate(), {
    destination: 'cloudwatch', retrieverInstalled: true,
    target: { kind: 'gb_budget', value: 150 },
  });
  assert.ok(pl.planned.every((r) => r.action !== 'tier_down'),
    `tier_down leaked into a volume plan: ${pl.planned.map((r) => r.action).join(',')}`);
  assert.ok(pl.met, `landsAt=${pl.landsAtBytesMonthly}`);
  assert.ok((pl.landsAtBytesMonthly ?? Infinity) <= 150 * 1_000_000_000 * 1.0001);
  // volume rows carry the byte figure alongside the dollar one
  assert.ok(pl.planned.every((r) => (r.savedBytes ?? 0) > 0 && r.savedUsd >= 0));
});

test('gb_budget: destination whose only lever is tier_down has no lossless volume path', () => {
  const pl = solvePlan(estate(), {
    destination: 'cloudwatch', retrieverInstalled: false,
    target: { kind: 'gb_budget', value: 150 },
  });
  assert.equal(pl.met, false);
  assert.equal(pl.planned.length, 0); // nothing keeps everything AND removes bytes
  assert.ok(pl.gap);
  assert.ok(pl.gap!.message.includes('tier_down keeps every byte'), pl.gap!.message);
  assert.ok(pl.gap!.remedies.includes('install_retriever'));
});

test('percent callers are untouched by the target union (back-compat)', () => {
  const viaPct = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  const viaUnion = solvePlan(estate(), {
    destination: 'cloudwatch', retrieverInstalled: true,
    target: { kind: 'percent', value: 50 },
  });
  assert.equal(viaPct.met, viaUnion.met);
  assert.equal(viaPct.achievedPct, viaUnion.achievedPct);
  assert.equal(viaPct.targetPct, 50);
  assert.equal(viaPct.target.kind, 'percent');
});

// ── Render credibility fields ───────────────────────────────────────

test('plan arithmetic closes: totalSavedUsd = billUsd - landsAtUsd = sum of rows', () => {
  const pl = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  const rowSum = pl.planned.reduce((s, r) => s + r.savedUsd, 0);
  assert.ok(Math.abs(pl.totalSavedUsd - rowSum) < 1e-9);
  assert.ok(Math.abs(pl.billUsd - pl.totalSavedUsd - (pl.landsAtUsd ?? NaN)) < 1e-9);
});

test('rateBasis names the destination, the list-price basis, and the lever rate', () => {
  const cw = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  assert.ok(cw.rateBasis.includes('cloudwatch list price'), cw.rateBasis);
  assert.ok(cw.rateBasis.includes('ingest $'), cw.rateBasis);
  assert.ok(/Infrequent Access/i.test(cw.rateBasis), cw.rateBasis);
  const sp = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 50 });
  assert.ok(sp.rateBasis.includes('splunk list price'), sp.rateBasis);
  assert.ok(/compact assumed \d+-\d+% of original size/.test(sp.rateBasis), sp.rateBasis);
});
