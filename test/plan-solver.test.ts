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

// ── Customer-rate seam ──────────────────────────────────────────────

test('customer rate scales every dollar, leaves the plan rows and ratios alone', () => {
  const list = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  const impliedList = list.billUsd / (list.bytesInMonthly / 1_000_000_000);
  const custom = solvePlan(estate(), {
    destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50,
    customerRatePerGb: impliedList * 2,
  });
  // same physics: identical row set and actions, identical achieved percent
  assert.deepEqual(custom.planned.map((r) => [r.hash, r.action]), list.planned.map((r) => [r.hash, r.action]));
  assert.ok(Math.abs(custom.achievedPct - list.achievedPct) < 1e-9);
  // their dollars: everything exactly doubled, and the arithmetic still closes
  assert.ok(Math.abs(custom.billUsd - list.billUsd * 2) < 1e-6);
  assert.ok(Math.abs(custom.totalSavedUsd - list.totalSavedUsd * 2) < 1e-6);
  assert.ok(Math.abs(custom.billUsd - custom.totalSavedUsd - (custom.landsAtUsd ?? NaN)) < 1e-9);
  assert.equal(custom.rateSource, 'customer_supplied');
  assert.ok(custom.rateBasis.includes('your rate'), custom.rateBasis);
  assert.ok(custom.rateBasis.includes('customer supplied'), custom.rateBasis);
  assert.equal(list.rateSource, 'list_price');
});

test('usd budget is judged in the customer\'s dollars, not list dollars', () => {
  const list = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 1 });
  const impliedList = list.billUsd / (list.bytesInMonthly / 1_000_000_000);
  // Budget above the list bill but below the customer-priced bill: with list
  // dollars this is "already under"; with the doubled customer rate it forces
  // a real cut. The budget must be compared against THEIR bill.
  const budget = list.billUsd * 1.5;
  const pl = solvePlan(estate(), {
    destination: 'splunk', retrieverInstalled: true,
    target: { kind: 'usd_budget', value: budget },
    customerRatePerGb: impliedList * 2,
  });
  assert.ok(pl.billUsd > budget, 'premise: customer bill exceeds the budget');
  assert.ok(pl.planned.length > 0, 'a real cut is required in customer dollars');
  assert.ok(pl.met);
  assert.ok((pl.landsAtUsd ?? Infinity) <= budget * 1.0001);
});

test('bytesInMonthly is the reconciliation multiplicand', () => {
  const pl = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  const inputBytes = estate().reduce((s, p) => s + p.bytes, 0);
  assert.equal(pl.bytesInMonthly, inputBytes);
});

test('datadog rate label is the honest all-in blend, not "ingest"', () => {
  const dd = solvePlan(estate(), { destination: 'datadog', retrieverInstalled: true, targetPct: 50 });
  assert.ok(dd.rateBasis.includes('all-in $2.5/GB'), dd.rateBasis);
  assert.ok(!dd.rateBasis.includes('ingest $2.5/GB'), dd.rateBasis);
});

// ── Explicit unpin of the severity floor ────────────────────────────

test('unprotectPatterns: a named WARN type becomes plannable; everything else stays protected', () => {
  const withWarn: SolverPattern[] = [
    ...estate(),
    { hash: 'w1', name: 'Retry storm', services: { checkout: 120_000_000_000 }, severity: 'WARN', bytes: 120_000_000_000 },
  ];
  const locked = solvePlan(withWarn, { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  assert.ok(!locked.planned.some((r) => r.hash === 'w1'), 'WARN is protected by default');
  const unpinned = solvePlan(withWarn, {
    destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50,
    unprotectPatterns: ['w1'],
  });
  assert.ok(unpinned.planned.some((r) => r.hash === 'w1'), 'explicitly unpinned WARN is plannable');
  assert.ok(!unpinned.planned.some((r) => r.hash === 'e1'), 'the ERROR stays protected — unpin is per-hash, never estate-wide');
});

test('an explicit pin beats an unpin of the same hash', () => {
  const withWarn: SolverPattern[] = [
    ...estate(),
    { hash: 'w1', name: 'Retry storm', services: { checkout: 120_000_000_000 }, severity: 'WARN', bytes: 120_000_000_000 },
  ];
  const pl = solvePlan(withWarn, {
    destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50,
    unprotectPatterns: ['w1'], pinnedHashes: ['w1'],
  });
  assert.ok(!pl.planned.some((r) => r.hash === 'w1'));
});

test('skeleton passes through from source pattern to planned row', () => {
  const withSkel: SolverPattern[] = estate().map((p) =>
    p.hash === 'p1' ? { ...p, skeleton: 'Transaction complete order=$ amount=$' } : p,
  );
  const pl = solvePlan(withSkel, { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 50 });
  const r = pl.planned.find((x) => x.hash === 'p1')!;
  assert.equal(r.skeleton, 'Transaction complete order=$ amount=$');
  assert.ok(pl.planned.filter((x) => x.hash !== 'p1').every((x) => x.skeleton === undefined));
});

// ── Lever availability: what a platform can actually do ─────────────

test('serverless cannot compact: no plugin surface, so the confirmed tier is used', () => {
  const pl = solvePlan(estate(), { destination: 'elastic-serverless', retrieverInstalled: true, targetPct: 40 });
  assert.ok(pl.planned.every((r) => r.action !== 'compact'),
    'compact must never appear on a platform with nowhere to install the expander');
  assert.equal(pl.keepEverythingLever, 'tier_down');
  assert.ok(pl.prerequisites.some((x) => /cost-efficient tier/i.test(x)), pl.prerequisites.join(' | '));
});

test('generic elasticsearch prices only deployment-independent levers', () => {
  const pl = solvePlan(estate(), { destination: 'elasticsearch', retrieverInstalled: true, targetPct: 40 });
  assert.equal(pl.keepEverythingLever, 'tier_down',
    'without knowing the deployment, the platform feature holds and our plugin does not');
  assert.ok(pl.planned.every((r) => r.action !== 'compact'));
  assert.ok(pl.prerequisites.some((x) => /searchable snapshots/i.test(x)), pl.prerequisites.join(' | '));
});

test('a CONFIRMED self-managed cluster unlocks compact, and says what it needs', () => {
  const pl = solvePlan(estate(), {
    destination: 'elasticsearch', retrieverInstalled: true, targetPct: 40, selfManaged: true,
  });
  assert.equal(pl.keepEverythingLever, 'compact');
  assert.ok(pl.prerequisites.some((x) => /l1es plugin/i.test(x) && /8\.17\.0/.test(x)),
    'the plugin prerequisite must carry its version constraint: ' + pl.prerequisites.join(' | '));
});

test('managed, or unstated, never unlocks compact — silence is not consent', () => {
  for (const opts of [{}, { selfManaged: false }]) {
    const pl = solvePlan(estate(), {
      destination: 'elasticsearch', retrieverInstalled: true, targetPct: 40, ...opts,
    });
    assert.equal(pl.keepEverythingLever, 'tier_down');
    assert.ok(pl.planned.every((r) => r.action !== 'compact'));
  }
});

test('self-managed does NOT resurrect compact on serverless — there is no plugin surface', () => {
  const pl = solvePlan(estate(), {
    destination: 'elastic-serverless', retrieverInstalled: true, targetPct: 40, selfManaged: true,
  });
  assert.equal(pl.keepEverythingLever, 'tier_down');
  assert.ok(pl.planned.every((r) => r.action !== 'compact'));
});

test('prerequisites cover only the levers a plan actually uses', () => {
  const noRetr = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: false, targetPct: 30 });
  assert.ok(noRetr.prerequisites.some((x) => /Splunk app/i.test(x)));
  assert.ok(!noRetr.prerequisites.some((x) => /retriever/i.test(x)), 'no offload row, no retriever prerequisite');
  const deep = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 95, allowLossy: true });
  if (deep.planned.some((r) => r.action === 'offload')) {
    assert.ok(deep.prerequisites.some((x) => /retriever/i.test(x)));
  }
});

test('an unmodeled destination fails loudly instead of crashing on a rate read', () => {
  assert.throws(
    () => solvePlan(estate(), { destination: 'loki' as never, retrieverInstalled: true, targetPct: 30 }),
    /No cost model for destination "loki"/,
  );
});
