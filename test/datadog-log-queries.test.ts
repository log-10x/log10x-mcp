/**
 * E79: before a rule moves statements off Standard, the Datadog log monitors
 * and log-based metrics whose query reads those lines are listed beside it.
 * The reads are GET /api/v1/monitor and GET /api/v2/logs/config/metrics;
 * both are stubbed here with their documented shapes. No network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLogSearch,
  evaluateLogSearch,
  statementTokens,
  logMonitorSearches,
  matchRuleDependencies,
  ruleDependenciesNotChecked,
  dependencyLinesForService,
  type DependencyRule,
} from '../src/lib/siem/deps/datadog-log-queries.js';
import { fetchDatadogInventory } from '../src/lib/siem/deps/datadog.js';
import { dependencyRulesFromPlan, checkRuleDependencies, _setInventoryFetcher, _resetInventoryFetcher } from '../src/lib/plan-dependencies.js';
import { solvePlan } from '../src/lib/plan-solver.js';
import { dependencyRulesFromEngineRows, userUnitLinesWithDependencies, type PerPatternRow } from '../src/tools/configure-engine.js';
import type { LogQueryObject } from '../src/lib/siem/deps/types.js';

const line = (services: string[], text: string, status?: string) => ({
  services,
  tokens: statementTokens(text),
  ...(status !== undefined ? { status } : {}),
});

test('log search syntax: facets, phrases, groups, negation; a slot value never matches', () => {
  const l = line(['checkout'], 'request served in $ ms');
  assert.equal(evaluateLogSearch(parseLogSearch('service:checkout'), l), 1);
  assert.equal(evaluateLogSearch(parseLogSearch('service:(checkout OR cart)'), l), 1);
  assert.equal(evaluateLogSearch(parseLogSearch('service:check*'), l), 1);
  assert.equal(evaluateLogSearch(parseLogSearch('-service:checkout'), l), 0);
  assert.equal(evaluateLogSearch(parseLogSearch('service:cart'), l), 0);
  assert.equal(evaluateLogSearch(parseLogSearch('"request served"'), l), 1);
  assert.equal(evaluateLogSearch(parseLogSearch('served'), l), 1);
  assert.equal(evaluateLogSearch(parseLogSearch('"served in 12"'), l), 0, 'a value in a slot is not known');
  assert.equal(evaluateLogSearch(parseLogSearch('@message:"request served"'), l), 1);
  // Facets a statement does not show are unknown, never a refusal.
  assert.equal(evaluateLogSearch(parseLogSearch('env:prod service:checkout'), l), 0.5);
  assert.equal(evaluateLogSearch(parseLogSearch('status:error'), l), 0.5);
  assert.equal(evaluateLogSearch(parseLogSearch('status:error'), line(['checkout'], 'x', 'info')), 0);
  assert.equal(evaluateLogSearch(parseLogSearch('status:(error OR warn)'), line(['checkout'], 'x', 'warning')), 1);
  assert.equal(evaluateLogSearch(parseLogSearch('*'), l), 1);
  assert.equal(evaluateLogSearch(parseLogSearch(''), l), 1);
});

test('a log monitor query carries its searches in logs("...") and in formula variables', () => {
  assert.deepEqual(
    logMonitorSearches('logs("service:checkout status:error").index("*").rollup("count").last("5m") > 10'),
    ['service:checkout status:error'],
  );
  assert.deepEqual(
    logMonitorSearches('formula("query1 / query2").last("15m") > 0.1', [
      { data_source: 'logs', name: 'query1', search: { query: 'service:checkout status:error' }, indexes: ['*'] },
      { data_source: 'logs', name: 'query2', search: { query: 'service:checkout' }, indexes: ['*'] },
      { data_source: 'metrics', name: 'query3', query: 'avg:system.cpu.user{*}' },
    ]),
    ['service:checkout status:error', 'service:checkout'],
  );
  assert.deepEqual(logMonitorSearches(undefined), []);
});

function objects(): LogQueryObject[] {
  return [
    { kind: 'log_monitor', id: '1', name: 'Checkout errors', url: 'https://app.datadoghq.com/monitors/1', searches: ['service:checkout status:error'] },
    { kind: 'log_monitor', id: '2', name: 'Checkout volume', searches: ['service:checkout'] },
    { kind: 'log_monitor', id: '3', name: 'Ad requests', searches: ['"ad request received"'] },
    { kind: 'log_monitor', id: '4', name: 'All errors', searches: ['status:error'] },
    { kind: 'log_monitor', id: '5', name: 'Everything', searches: ['*'] },
    { kind: 'log_monitor', id: '6', name: 'Payments', searches: ['service:payments'] },
    { kind: 'log_metric', id: 'checkout.requests', name: 'checkout.requests', searches: ['service:checkout "request served"'] },
    { kind: 'log_metric', id: 'ad.requests', name: 'ad.requests', searches: ['service:ad'] },
  ];
}

function rules(): DependencyRule[] {
  return [
    {
      service: 'checkout',
      action: 'tier_down',
      statements: [
        { name: 'request_served', text: 'request served in $ ms', severity: 'INFO' },
        { name: 'cache_warmed', text: 'cache warmed $ entries', severity: 'INFO' },
      ],
    },
    { service: 'ad', action: 'offload', statements: [{ name: 'ad_request', text: 'Targeted ad request received for $', severity: 'INFO' }] },
  ];
}

test('each rule lists the monitors that go blind, the ones that only read errors, and the metrics that keep or stop counting', () => {
  const s = matchRuleDependencies(rules(), objects());
  assert.equal(s.checked, true);
  assert.equal(s.log_monitors_scanned, 6);
  assert.equal(s.log_metrics_scanned, 2);
  const [checkout, ad] = s.rules;

  assert.equal(checkout.lines[0], 'checkout (tier_down to Flex, 2 statements): 2 log monitors and 1 log-based metric read these lines.');
  assert.deepEqual(checkout.monitors.map((m) => [m.name, m.matched_on, m.effect]), [
    ['Checkout errors', 'service', 'not_blinded'],
    ['Checkout volume', 'service', 'goes_blind'],
  ]);
  assert.match(checkout.monitors[0].line, /^Monitor "Checkout errors" reads only error and warning lines, which the severity defaults keep in Standard, so it is not blinded \(query service:checkout status:error\)\.$/);
  assert.match(checkout.monitors[1].line, /^Monitor "Checkout volume" stops seeing the lines moved to Flex, because Flex lines do not feed log monitors \(query service:checkout\)\.$/);
  assert.deepEqual(checkout.metrics.map((m) => [m.name, m.effect, m.statements]), [['checkout.requests', 'still_counts', ['request_served']]]);
  assert.match(checkout.metrics[0].line, /^Log-based metric checkout\.requests still counts the lines moved to Flex, because Datadog generates log-based metrics at ingestion \(query service:checkout "request served"; statement request_served\)\.$/);

  assert.equal(ad.lines[0], 'ad (offload to S3, 1 statement): 1 log monitor and 1 log-based metric read these lines.');
  assert.deepEqual(ad.monitors.map((m) => [m.name, m.matched_on, m.effect]), [['Ad requests', 'text', 'goes_blind']]);
  assert.match(ad.monitors[0].line, /^Monitor "Ad requests" goes blind to the lines sent to S3 \(query "ad request received"; statement ad_request\)\.$/);
  assert.match(ad.metrics[0].line, /^Log-based metric ad\.requests stops counting the lines sent to S3 \(query service:ad\)\.$/);

  // Not tied to one service: listed once for all rules.
  assert.deepEqual(s.unscoped.map((u) => [u.name, u.reads, u.errors_only]), [
    ['All errors', 'maybe', true],
    ['Everything', 'all', false],
  ]);
  assert.match(s.unscoped[0].line, /^Monitor "All errors" reads only error and warning lines, which the severity defaults keep in Standard, so it is not blinded \(query status:error\)\.$/);
  assert.match(s.unscoped[1].line, /^Monitor "Everything" reads every service and stops seeing the lines these rules move off Standard \(query \*\)\.$/);
  assert.ok(s.lines.includes('Not tied to one service: 2 log monitors also read lines from the services above.'));
  // A monitor on another service is not listed anywhere.
  assert.ok(!JSON.stringify(s).includes('Payments'));
  assert.match(s.note, /^checked 6 log monitors and 2 log-based metrics against 2 rules; 5 matches by service or statement text; 2 not tied to a service$/);
  assert.deepEqual(dependencyLinesForService(s, 'ad'), ad.lines);
  assert.deepEqual(dependencyLinesForService(s, 'none'), []);
  for (const l of s.lines) assert.ok(!/—/.test(l), l);
});

test('an error-class moved statement is not kept by the severity defaults, so an errors-only monitor goes blind', () => {
  const s = matchRuleDependencies(
    [{ service: 'checkout', action: 'tier_down', statements: [{ name: 'payment_failed', text: 'payment failed $', severity: 'ERROR' }] }],
    objects(),
  );
  const m = s.rules[0].monitors.find((x) => x.name === 'Checkout errors')!;
  assert.equal(m.effect, 'goes_blind');
});

test('no rule, no reader, or no credentials: the check says why and lists nothing', async () => {
  const none = ruleDependenciesNotChecked('no Datadog credentials in this session');
  assert.equal(none.checked, false);
  assert.deepEqual(none.lines, ['Log monitors and log-based metrics were not checked: no Datadog credentials in this session.']);
  for (const k of ['DD_API_KEY', 'DD_APP_KEY', 'DATADOG_API_KEY', 'DATADOG_APP_KEY']) delete process.env[k];
  const r = await checkRuleDependencies('datadog', rules());
  assert.equal(r.checked, false);
  assert.match(r.note, /no Datadog credentials/);
  const other = await checkRuleDependencies('cloudwatch', rules());
  assert.match(other.note, /not cloudwatch/);
});

test('with credentials the check uses the inventory the plan check fetched, once', async () => {
  process.env.DD_API_KEY = 'k';
  process.env.DD_APP_KEY = 'a';
  let calls = 0;
  _setInventoryFetcher(async () => {
    calls += 1;
    return {
      vendor: 'datadog',
      objects: [],
      notes: [],
      scanDepth: 'test',
      logQueries: { objects: objects(), monitorsRead: true, metricsRead: true, notes: [] },
    };
  });
  try {
    const r = await checkRuleDependencies('datadog', rules());
    assert.equal(calls, 1);
    assert.equal(r.checked, true);
    assert.equal(r.rules.length, 2);
  } finally {
    _resetInventoryFetcher();
    delete process.env.DD_API_KEY;
    delete process.env.DD_APP_KEY;
  }
});

test('rules come from the plan rows and from the engine rows, one per service and action', () => {
  const plan = solvePlan(
    [
      { hash: 'a', name: 'request served', skeleton: 'request served in $ ms', services: { checkout: 60e9 }, severity: 'INFO', bytes: 60e9 },
      { hash: 'b', name: 'payment failed', services: { checkout: 10e9 }, severity: 'ERROR', bytes: 10e9 },
      { hash: 'c', name: 'ad request', services: { ad: 30e9 }, severity: 'INFO', bytes: 30e9 },
    ],
    { destination: 'datadog', retrieverInstalled: false, targetPct: 50 },
  );
  const fromPlan = dependencyRulesFromPlan(plan);
  assert.ok(fromPlan.length >= 1);
  assert.ok(fromPlan.every((r) => r.action === 'tier_down'));
  const checkout = fromPlan.find((r) => r.service === 'checkout')!;
  assert.deepEqual(checkout.statements[0], { name: 'request served', text: 'request served in $ ms', severity: 'INFO' });

  const row = (o: Partial<PerPatternRow>): PerPatternRow => ({
    pattern_hash: 'h', pattern: 'p', container: 'checkout', current_bytes_30d: 0, cap_bytes_per_window: 0, action: 'pass',
    saved_bytes_monthly: 0, saved_dollars_monthly: 0, projected_monthly_usd_low: 0, projected_monthly_usd_expected: 0,
    projected_monthly_usd_high: 0, reason: 'r', ...o,
  });
  const fromRows = dependencyRulesFromEngineRows(
    [
      row({ pattern_hash: 'a', pattern: 'request served', action: 'tier_down' }),
      row({ pattern_hash: 'k', pattern: 'kept', action: 'pass' }),
      row({ pattern_hash: 'c', pattern: 'ad request', container: 'ad', action: 'offload' }),
    ],
    [{ pattern_hash: 'a', container: 'checkout', severity: 'INFO' }, { pattern_hash: 'c', container: 'ad', severity: 'INFO' }],
    'shop',
  );
  assert.deepEqual(fromRows, [
    { service: 'checkout', aliases: ['shop'], action: 'tier_down', statements: [{ name: 'request served', severity: 'INFO' }] },
    { service: 'ad', aliases: ['shop'], action: 'offload', statements: [{ name: 'ad request', severity: 'INFO' }] },
  ]);
});

test('the summary prints each service line, then its monitors, then the fleet line and the unscoped block', () => {
  const s = matchRuleDependencies(rules(), objects());
  const lines = userUnitLinesWithDependencies(
    new Map([
      ['checkout', 'checkout: any statement above 10,000 lines a day goes to Flex. Today that is these 2 statements, about $17 a month.'],
      ['ad', 'ad: every statement goes to the offload bucket. Today that is this one statement, about $2 a month.'],
    ]),
    'Any service not listed keeps every statement in Standard. The first 5 lines of every statement always reach Standard.',
    s,
  );
  assert.equal(lines[0].slice(0, 9), 'checkout:');
  assert.equal(lines[1], s.rules[0].lines[0]);
  assert.equal(lines[1 + s.rules[0].lines.length].slice(0, 3), 'ad:');
  assert.ok(lines.includes('Any service not listed keeps every statement in Standard. The first 5 lines of every statement always reach Standard.'));
  assert.equal(lines[lines.length - 3], 'Not tied to one service: 2 log monitors also read lines from the services above.');
  const unchecked = userUnitLinesWithDependencies(new Map([['a', 'a: x.']]), 'fleet.', ruleDependenciesNotChecked('no Datadog credentials in this session'));
  assert.deepEqual(unchecked, ['a: x.', 'fleet.', 'Log monitors and log-based metrics were not checked: no Datadog credentials in this session.']);
});

// ── The reads, against the documented response shapes ──

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DD_API_KEY;
  delete process.env.DD_APP_KEY;
  delete process.env.DD_SITE;
});

function stubFetch(routes: Record<string, unknown>, seen: string[]): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    const path = new URL(url).pathname;
    const body = routes[path];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('fetchDatadogInventory reads monitors and log-based metrics with GETs only, keeps log alerts and metric filters', async () => {
  process.env.DD_API_KEY = 'k';
  process.env.DD_APP_KEY = 'a';
  process.env.DD_SITE = 'datadoghq.eu';
  const seen: string[] = [];
  stubFetch(
    {
      '/api/v1/dashboard': { dashboards: [{ id: 'abc-def', title: 'Checkout', description: 'checkout dashboard' }] },
      '/api/v1/monitor': [
        { id: 11, type: 'log alert', name: 'Checkout errors', query: 'logs("service:checkout status:error").index("*").rollup("count").last("5m") > 10', message: 'page', options: {} },
        {
          id: 12,
          type: 'log alert',
          name: 'Checkout error rate',
          query: 'formula("query1 / query2").last("15m") > 0.1',
          options: { variables: [{ data_source: 'logs', name: 'query1', search: { query: 'service:checkout status:error' } }, { data_source: 'logs', name: 'query2', search: { query: 'service:checkout' } }] },
        },
        { id: 13, type: 'metric alert', name: 'CPU', query: 'avg(last_5m):avg:system.cpu.user{*} > 90' },
      ],
      '/api/v2/logs/config/metrics': {
        data: [
          { id: 'checkout.requests', type: 'logs_metrics', attributes: { compute: { aggregation_type: 'count' }, filter: { query: 'service:checkout "request served"' }, group_by: [] } },
          { id: 'all.logs', type: 'logs_metrics', attributes: { compute: { aggregation_type: 'count' } } },
        ],
      },
    },
    seen,
  );
  const inv = await fetchDatadogInventory();
  assert.equal(inv.error, undefined);
  assert.ok(seen.every((s) => s.startsWith('GET ')), seen.join('\n'));
  assert.ok(seen.some((s) => s.includes('https://api.datadoghq.eu/api/v1/monitor?')));
  assert.ok(seen.some((s) => s.includes('https://api.datadoghq.eu/api/v2/logs/config/metrics')));
  assert.equal(inv.objects.filter((o) => o.type === 'monitor').length, 3);
  assert.equal(inv.objects.filter((o) => o.type === 'dashboard').length, 1);
  const lq = inv.logQueries!;
  assert.equal(lq.monitorsRead, true);
  assert.equal(lq.metricsRead, true);
  assert.deepEqual(
    lq.objects.map((o) => [o.kind, o.id, o.name, o.searches]),
    [
      ['log_monitor', '11', 'Checkout errors', ['service:checkout status:error']],
      ['log_monitor', '12', 'Checkout error rate', ['service:checkout status:error', 'service:checkout']],
      ['log_metric', 'checkout.requests', 'checkout.requests', ['service:checkout "request served"']],
      ['log_metric', 'all.logs', 'all.logs', ['*']],
    ],
  );
  assert.equal(lq.objects[0].url, 'https://app.datadoghq.eu/monitors/11');
  // An error-rate monitor whose denominator reads every checkout line is blinded by a Flex move.
  const s = matchRuleDependencies(rules().slice(0, 1), lq.objects);
  const rate = s.rules[0].monitors.find((m) => m.name === 'Checkout error rate')!;
  assert.equal(rate.effect, 'goes_blind');
  assert.equal(rate.errors_only, false);
});

test('a failed read is reported as not read, never as an empty account', async () => {
  process.env.DD_API_KEY = 'k';
  process.env.DD_APP_KEY = 'a';
  const seen: string[] = [];
  stubFetch({ '/api/v1/dashboard': { dashboards: [] }, '/api/v1/monitor': [] }, seen);
  const inv = await fetchDatadogInventory();
  const lq = inv.logQueries!;
  assert.equal(lq.monitorsRead, true);
  assert.equal(lq.metricsRead, false);
  assert.match(lq.notes.join(' '), /log-based metrics could not be read \(HTTP 404/);
});
