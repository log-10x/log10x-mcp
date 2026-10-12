import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splunkKeepRaw, isSplunkDestination, SPLUNK_WORKLOAD_COMPACT_NOTE } from '../src/lib/siem/splunk-keep-raw.js';
import { getAvailableActions } from '../src/lib/cost.js';
import { solvePlan, keepEverythingLever, type SolverPattern } from '../src/lib/plan-solver.js';

test('Cisco sourcetypes stay raw under any licence; add-on sourcetypes stay raw unless Enterprise Security is ruled out', () => {
  assert.equal(splunkKeepRaw('cisco:asa')?.reason, 'cisco_rate');
  assert.equal(splunkKeepRaw('cisco:asa', { enterpriseSecurity: false })?.reason, 'cisco_rate');
  assert.equal(splunkKeepRaw('XmlWinEventLog:Security')?.reason, 'enterprise_security_add_on');
  assert.equal(splunkKeepRaw('pan:traffic', { enterpriseSecurity: true })?.reason, 'enterprise_security_add_on');
  assert.equal(splunkKeepRaw('pan:traffic', { enterpriseSecurity: false }), undefined);
  assert.equal(splunkKeepRaw('kube:container:cartservice'), undefined);
  assert.equal(splunkKeepRaw('_json'), undefined);
  assert.equal(splunkKeepRaw(undefined), undefined);
  assert.match(splunkKeepRaw('WinEventLog:Security')!.text, /enterprise_security=false/);
  assert.ok(isSplunkDestination('splunk') && isSplunkDestination('splunk_cloud') && !isSplunkDestination('datadog'));
});

test('workload pricing takes compact out of the Splunk lever set', () => {
  assert.deepEqual(getAvailableActions('splunk'), ['compact', 'offload']);
  assert.deepEqual(getAvailableActions('splunk', { splunkPricing: 'ingest' }), ['compact', 'offload']);
  assert.deepEqual(getAvailableActions('splunk', { splunkPricing: 'workload' }), ['offload']);
  assert.deepEqual(getAvailableActions('datadog', { splunkPricing: 'workload' }), getAvailableActions('datadog'));
  assert.equal(keepEverythingLever('splunk', true), 'compact');
  assert.equal(keepEverythingLever('splunk', true, { splunkPricing: 'workload' }), 'offload');
  assert.equal(keepEverythingLever('splunk', false, { splunkPricing: 'workload' }), null);
  assert.match(SPLUNK_WORKLOAD_COMPACT_NOTE, /not a saving/);
});

function estate(): SolverPattern[] {
  const gb = 1_000_000_000;
  return [
    { hash: 'w1', name: 'An account was successfully logged on', services: { 'XmlWinEventLog:Security': 100 * gb }, severity: 'INFO', bytes: 100 * gb },
    { hash: 'c1', name: 'Built outbound TCP connection', services: { 'cisco:asa': 90 * gb }, severity: 'INFO', bytes: 90 * gb },
    { hash: 'a1', name: 'GetCart', services: { 'kube:container:cartservice': 80 * gb }, severity: 'INFO', bytes: 80 * gb },
    { hash: 'a2', name: 'AddItem', services: { 'kube:container:cartservice': 70 * gb }, severity: 'INFO', bytes: 70 * gb },
  ];
}

test('a Splunk plan pins the add-on and Cisco sources at pass and says why', () => {
  const pl = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 30 });
  const kept = new Map(pl.kept.map((r) => [r.hash, r.action]));
  assert.equal(kept.get('w1'), 'pass');
  assert.equal(kept.get('c1'), 'pass');
  assert.ok(pl.planned.every((r) => r.hash === 'a1' || r.hash === 'a2'), JSON.stringify(pl.planned.map((r) => r.hash)));
  assert.ok(pl.keptRaw, 'keptRaw present');
  assert.deepEqual(
    pl.keptRaw!.map((k) => [k.service, k.reason]).sort(),
    [['XmlWinEventLog:Security', 'enterprise_security_add_on'], ['cisco:asa', 'cisco_rate']].sort(),
  );
});

test('enterprise_security=false frees the add-on sources, not the Cisco ones', () => {
  const pl = solvePlan(estate(), { destination: 'splunk', retrieverInstalled: true, targetPct: 30, enterpriseSecurity: false });
  assert.ok(pl.planned.some((r) => r.hash === 'w1'), 'Windows source planned once ES is ruled out');
  assert.ok(!pl.planned.some((r) => r.hash === 'c1'), 'Cisco stays raw');
  assert.deepEqual(pl.keptRaw!.map((k) => k.service), ['cisco:asa']);
});

test('the rules are Splunk only', () => {
  const pl = solvePlan(estate(), { destination: 'cloudwatch', retrieverInstalled: true, targetPct: 30 });
  assert.equal(pl.keptRaw, undefined);
});
