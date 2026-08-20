/**
 * Batch dependency scan for ladder plans: vendor mapping, credential
 * preflight, aggregation, error short-circuit, deadline honesty.
 * Uses the _setDepsChecker seam; no network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPlanDependencies,
  depVendorForDestination,
  depCredsPresent,
  _setDepsChecker,
  _resetDepsChecker,
} from '../src/lib/plan-dependencies.js';
import { solvePlan, type SolverPattern } from '../src/lib/plan-solver.js';
import type { DepCheckResult } from '../src/lib/siem/deps/index.js';

function estate(): SolverPattern[] {
  return [
    { hash: 'p1', name: 'Transaction_complete', services: { payment: 100_000_000_000 }, severity: 'INFO', bytes: 100_000_000_000 },
    { hash: 'p2', name: 'Charge_received', services: { payment: 90_000_000_000 }, severity: 'INFO', bytes: 90_000_000_000 },
    { hash: 'e1', name: 'Charge_FAILED', services: { payment: 60_000_000_000 }, severity: 'ERROR', bytes: 60_000_000_000 },
  ];
}
const plan = () => solvePlan(estate(), { destination: 'datadog', retrieverInstalled: true, targetPct: 50 });

function fakeResult(pattern: string, matches: number): DepCheckResult {
  return {
    vendor: 'datadog',
    scannedAt: 'x',
    pattern,
    matches: Array.from({ length: matches }, (_, i) => ({
      type: 'dashboard', name: `dash-${pattern}-${i}`, matchedIn: ['title'],
    })) as unknown as DepCheckResult['matches'],
    byType: { dashboards: matches, alerts: 0, savedSearches: 0, monitors: 0, metricFilters: 0 },
    notes: [],
  };
}

const CLEAN_ENV = ['DD_API_KEY', 'DD_APP_KEY', 'DATADOG_API_KEY', 'DATADOG_APP_KEY'];
afterEach(() => {
  _resetDepsChecker();
  for (const k of CLEAN_ENV) delete process.env[k];
});

test('destination mapping covers the aliases and refuses the rest', () => {
  assert.equal(depVendorForDestination('splunk_cloud' as never), 'splunk');
  assert.equal(depVendorForDestination('elasticsearch_self' as never), 'elasticsearch');
  assert.equal(depVendorForDestination('elastic-serverless' as never), 'elasticsearch');
  assert.equal(depVendorForDestination('datadog' as never), 'datadog');
  assert.equal(depVendorForDestination('sumo' as never), null);
});

test('no credentials -> checked:false with the missing vars named, zero scans', async () => {
  let calls = 0;
  _setDepsChecker(async (v, o) => { calls += 1; return fakeResult(o.pattern, 0); });
  const s = await checkPlanDependencies(plan());
  assert.equal(s.checked, false);
  assert.equal(calls, 0);
  assert.ok(s.note.includes('DD_API_KEY'), s.note);
  assert.ok(depCredsPresent('datadog').present === false);
});

test('with credentials: scans top rows, aggregates refs, protected rows never scanned', async () => {
  process.env.DD_API_KEY = 'k'; process.env.DD_APP_KEY = 'a';
  const seen: string[] = [];
  _setDepsChecker(async (_v, o) => {
    seen.push(o.pattern);
    return fakeResult(o.pattern, o.pattern === 'Transaction_complete' ? 2 : 0);
  });
  const s = await checkPlanDependencies(plan());
  assert.equal(s.checked, true);
  assert.equal(s.vendor, 'datadog');
  assert.equal(s.scanned_rows, 2);
  assert.ok(!seen.includes('Charge_FAILED'), 'kept/protected rows are not planned and must not be scanned');
  assert.equal(s.rows_with_refs, 1);
  assert.equal(s.total_refs, 2);
  assert.equal(s.rows[0].names.length, 2);
  assert.ok(s.note.includes('checked datadog'), s.note);
});

test('a scanner error short-circuits to not-checked with the error relayed', async () => {
  process.env.DD_API_KEY = 'k'; process.env.DD_APP_KEY = 'a';
  _setDepsChecker(async (_v, o) => ({ ...fakeResult(o.pattern, 0), error: 'Datadog 403: bad app key' }));
  const s = await checkPlanDependencies(plan());
  assert.equal(s.checked, false);
  assert.ok(s.note.includes('403'), s.note);
});

test('deadline: slow scanner stops the batch between rows and the note says so', async () => {
  process.env.DD_API_KEY = 'k'; process.env.DD_APP_KEY = 'a';
  // The deadline is checked before each row starts; a row in flight finishes.
  // Five planned rows at 120ms each against a 150ms budget: rows 1-2 start
  // (t=0, t=120), row 3 sees the deadline passed and the batch stops.
  const wide: SolverPattern[] = Array.from({ length: 5 }, (_, i) => ({
    hash: `w${i}`, name: `Wide_pattern_${i}`,
    services: { api: (100 - i) * 1_000_000_000 }, severity: 'INFO',
    bytes: (100 - i) * 1_000_000_000,
  }));
  const widePlan = solvePlan(wide, { destination: 'datadog', retrieverInstalled: true, targetPct: 90 });
  assert.ok(widePlan.planned.length >= 4, 'test premise: several planned rows');
  let calls = 0;
  _setDepsChecker(async (_v, o) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 120));
    return fakeResult(o.pattern, 0);
  });
  const s = await checkPlanDependencies(widePlan, { timeoutMs: 150 });
  assert.equal(s.checked, true);
  assert.ok(s.scanned_rows < widePlan.planned.length, `expected partial scan, scanned ${s.scanned_rows} of ${widePlan.planned.length}`);
  assert.equal(calls, s.scanned_rows);
  assert.ok(/budget hit/.test(s.note), s.note);
});

test('empty plan scans nothing', async () => {
  process.env.DD_API_KEY = 'k'; process.env.DD_APP_KEY = 'a';
  _setDepsChecker(async () => { throw new Error('must not be called'); });
  const empty = solvePlan(estate(), {
    destination: 'datadog', retrieverInstalled: true,
    target: { kind: 'usd_budget', value: 1_000_000 },
  });
  const s = await checkPlanDependencies(empty);
  assert.equal(s.checked, false);
  assert.ok(s.note.includes('nothing planned'), s.note);
});
