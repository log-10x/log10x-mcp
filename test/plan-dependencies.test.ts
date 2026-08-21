/**
 * Two-tier blast-radius scan: inventory fetched once, literal matches across
 * ALL planned rows, slice disclosure, default-exclude re-solve, honesty notes.
 * Uses the _setInventoryFetcher seam; no network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPlanDependencies,
  applyReferencedExclusion,
  depVendorForDestination,
  depCredsPresent,
  sliceScan,
  platformTruth,
  _setInventoryFetcher,
  _resetInventoryFetcher,
} from '../src/lib/plan-dependencies.js';
import { solvePlan, type SolverPattern } from '../src/lib/plan-solver.js';
import type { VendorInventory, InventoryObject } from '../src/lib/siem/deps/index.js';

function estate(): SolverPattern[] {
  return [
    { hash: 'p1', name: 'Transaction_complete', services: { payment: 100_000_000_000 }, severity: 'INFO', bytes: 100_000_000_000 },
    { hash: 'p2', name: 'Charge_received', services: { payment: 90_000_000_000 }, severity: 'INFO', bytes: 90_000_000_000 },
    { hash: 'c1', name: 'GetCart_called', services: { cart: 80_000_000_000 }, severity: 'INFO', bytes: 80_000_000_000 },
    { hash: 'e1', name: 'Charge_FAILED', services: { payment: 60_000_000_000 }, severity: 'ERROR', bytes: 60_000_000_000 },
  ];
}
const plan = () => solvePlan(estate(), { destination: 'datadog', retrieverInstalled: true, targetPct: 60 });

function obj(partial: Partial<InventoryObject> & { name: string }): InventoryObject {
  return {
    type: 'monitor',
    url: undefined,
    texts: { name: [], query: [], definition: [] },
    hasQueryText: true,
    ...partial,
  } as InventoryObject;
}

function inv(objects: InventoryObject[], error?: string): VendorInventory {
  return {
    vendor: 'datadog',
    objects,
    notes: [],
    scanDepth: 'monitor queries and dashboard titles/descriptions',
    ...(error ? { error } : {}),
  };
}

const CLEAN_ENV = ['DD_API_KEY', 'DD_APP_KEY', 'DATADOG_API_KEY', 'DATADOG_APP_KEY'];
afterEach(() => {
  _resetInventoryFetcher();
  for (const k of CLEAN_ENV) delete process.env[k];
});

function withCreds(): void {
  process.env.DD_API_KEY = 'k';
  process.env.DD_APP_KEY = 'a';
}

test('destination mapping covers the aliases and refuses the rest', () => {
  assert.equal(depVendorForDestination('splunk_cloud' as never), 'splunk');
  assert.equal(depVendorForDestination('elasticsearch_self' as never), 'elasticsearch');
  assert.equal(depVendorForDestination('elastic-serverless' as never), 'elasticsearch');
  assert.equal(depVendorForDestination('datadog' as never), 'datadog');
  assert.equal(depVendorForDestination('sumo' as never), null);
});

test('no credentials -> checked:false with the missing vars named, zero fetches', async () => {
  let calls = 0;
  _setInventoryFetcher(async () => { calls += 1; return inv([]); });
  const s = await checkPlanDependencies(plan());
  assert.equal(s.checked, false);
  assert.equal(calls, 0);
  assert.ok(s.note.includes('DD_API_KEY'), s.note);
  assert.equal(depCredsPresent('datadog').present, false);
});

test('one fetch matches ALL planned rows; literal hits carry refs, names, forgone savings', async () => {
  withCreds();
  let calls = 0;
  _setInventoryFetcher(async () => {
    calls += 1;
    return inv([
      obj({ name: 'payment volume anomaly', texts: { name: ['payment volume anomaly'], query: ['logs("Charge received").rollup("count")'], definition: [] } }),
      obj({ name: 'unrelated cpu monitor', texts: { name: ['unrelated cpu monitor'], query: ['avg:system.cpu{*}'], definition: [] } }),
    ]);
  });
  const pl = plan();
  const s = await checkPlanDependencies(pl);
  assert.equal(calls, 1, 'inventory fetched exactly once for the whole plan');
  assert.equal(s.checked, true);
  assert.equal(s.scanned_rows, pl.planned.length);
  assert.equal(s.literal.length, 1);
  assert.equal(s.literal[0].hash, 'p2');
  assert.equal(s.literal[0].refs, 1);
  assert.deepEqual(s.literal[0].names, ['payment volume anomaly']);
  assert.ok(s.literal[0].forgoneUsd > 0);
  assert.ok(s.note.includes('scanned monitor queries'), s.note);
});

test('empty literal says "no literal references found in what was scanned", never "safe"', async () => {
  withCreds();
  _setInventoryFetcher(async () => inv([
    obj({ name: 'cpu monitor', texts: { name: ['cpu monitor'], query: ['avg:system.cpu{*}'], definition: [] } }),
  ]));
  const s = await checkPlanDependencies(plan());
  assert.equal(s.literal.length, 0);
  assert.ok(s.note.includes('no literal references found in what was scanned'), s.note);
  assert.ok(!/\bsafe\b/i.test(s.note), s.note);
});

test('slice tier: objects mentioning a planned service are disclosed, never excluded', async () => {
  withCreds();
  _setInventoryFetcher(async () => inv([
    obj({ name: 'payment error rate', texts: { name: ['payment error rate'], query: ['logs("service:payment status:error")'], definition: [] } }),
    obj({ name: 'cart p95', texts: { name: ['cart p95'], query: ['logs("service:cart").rollup("p95")'], definition: [] } }),
    obj({ name: 'infra disk', texts: { name: ['infra disk'], query: ['avg:system.disk{*}'], definition: [] } }),
  ]));
  const s = await checkPlanDependencies(plan());
  assert.equal(s.literal.length, 0, 'slice mentions are not literal template hits');
  const svcNames = s.slice.map((x) => x.service).sort();
  assert.deepEqual(svcNames, ['cart', 'payment']);
  const pay = s.slice.find((x) => x.service === 'payment')!;
  assert.equal(pay.objects, 1);
  assert.deepEqual(pay.names, ['payment error rate']);
});

test('sliceScan skips generic and unattributed service names', () => {
  const i = inv([obj({ name: 'x', texts: { name: ['api app main all'], query: [], definition: [] } })]);
  assert.deepEqual(sliceScan(i, ['api', 'app', '(unattributed)', 'al']), []);
});

test('platform truth states the lever consequences per destination', () => {
  const dd = plan(); // datadog tier_down (+ offload with retriever)
  const truth = platformTruth(dd) ?? '';
  assert.ok(truth.includes('Flex-tier events do not feed real-time log monitors'), truth);
  // 60%: the tier lever carries most rows and the top rows escalate to
  // offload — both sentences must appear. (At 90% every row escalates and
  // the tier sentence rightly disappears.)
  const cw = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 60 });
  const cwTruth = platformTruth(cw) ?? '';
  assert.ok(cwTruth.includes('Infrequent Access class does not support metric filters'), cwTruth);
  assert.ok(cwTruth.includes('offloaded types leave the destination'), cwTruth);
});

test('default-exclude: referenced types pin at pass and the plan re-solves around them', async () => {
  withCreds();
  _setInventoryFetcher(async () => inv([
    obj({ name: 'txn monitor', texts: { name: ['txn monitor'], query: ['logs("Transaction complete")'], definition: [] } }),
  ]));
  const patterns = estate();
  const opts = { destination: 'datadog', retrieverInstalled: true, targetPct: 30 } as const;
  const first = solvePlan(patterns, opts);
  const summary = await checkPlanDependencies(first);
  assert.equal(summary.literal.length, 1);
  assert.equal(summary.literal[0].hash, 'p1');

  const { plan: resolved, excluded } = applyReferencedExclusion(patterns, opts, summary);
  assert.equal(excluded.length, 1);
  assert.ok(!resolved.planned.some((r) => r.hash === 'p1'), 'referenced type must not be planned');
  assert.ok(resolved.kept.some((r) => r.hash === 'p1' && r.action === 'pass'), 'referenced type stays as-is');
  // the plan re-solved around it: other types now carry the target
  assert.ok(resolved.planned.length > 0);
});

test('solver pinnedHashes behaves exactly like a protected severity', () => {
  const pinned = solvePlan(estate(), {
    destination: 'datadog', retrieverInstalled: true, targetPct: 30,
    pinnedHashes: ['p1', 'c1'],
  });
  assert.ok(!pinned.planned.some((r) => r.hash === 'p1' || r.hash === 'c1'));
  assert.ok(pinned.kept.some((r) => r.hash === 'p1'));
  assert.ok(pinned.kept.some((r) => r.hash === 'c1'));
});

test('inventory error short-circuits to not-checked with the error relayed', async () => {
  withCreds();
  _setInventoryFetcher(async () => inv([], 'Datadog 403: bad app key'));
  const s = await checkPlanDependencies(plan());
  assert.equal(s.checked, false);
  assert.ok(s.note.includes('403'), s.note);
});

test('fetch timeout is honest, never a crash', async () => {
  withCreds();
  _setInventoryFetcher(async () => {
    await new Promise((r) => setTimeout(r, 300));
    return inv([]);
  });
  const s = await checkPlanDependencies(plan(), { timeoutMs: 50 });
  assert.equal(s.checked, false);
  assert.ok(s.note.includes('timeout'), s.note);
});

test('empty plan scans nothing', async () => {
  withCreds();
  _setInventoryFetcher(async () => { throw new Error('must not be called'); });
  const empty = solvePlan(estate(), {
    destination: 'datadog', retrieverInstalled: true,
    target: { kind: 'usd_budget', value: 1_000_000 },
  });
  const s = await checkPlanDependencies(empty);
  assert.equal(s.checked, false);
  assert.ok(s.note.includes('nothing planned'), s.note);
});
