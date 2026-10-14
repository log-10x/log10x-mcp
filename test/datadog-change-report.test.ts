/**
 * Item 9: the weekly Datadog change report and the two spike monitors, read
 * from the per-pattern series the engine's Datadog metric output publishes.
 * Every Datadog response is a stub with the documented shape. No network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChangeReport,
  executeDatadogChangeReport,
  parseActionsCsv,
  parseSince,
  renderChangeReportMarkdown,
  standardUsdMonth,
  type PolicyFiles,
} from '../src/tools/datadog-change-report.js';
import { ddQueryWindow, type DdSeries } from '../src/lib/datadog-metrics-read.js';
import { buildSpikeMonitors, spikeMonitorGroupBy } from '../src/lib/datadog-monitors.js';

const DAY = 86_400;
const NOW = 1_760_400_000; // fixed clock, seconds
const SINCE = NOW - 7 * DAY;

function series(tags: Record<string, string>, perDay: number, firstSec = SINCE + 3600): DdSeries {
  return { tags, total: perDay * 7, firstNonZeroSec: firstSec };
}

const tagsOf = (pattern: string, hash: string, container: string, route = 'pass') => ({
  message_pattern: pattern,
  tenx_hash: hash,
  k8s_container: container,
  tenx_user_service: container,
  routestate: route,
});

// checkout: A is old and kept at 1,000 a day; B is new at 5,000 a day.
// payments: F is old and kept at 1,500 a day; C is new, held by the payments row.
// newsvc: no history; D is new at 4,000 a day, E at 100 a day.
const CURRENT: DdSeries[] = [
  series(tagsOf('order_placed', 'qka', 'checkout'), 1000),
  series(tagsOf('cart_retry_storm', 'qkb', 'checkout'), 5000, SINCE + 2 * DAY),
  series(tagsOf('ledger_synced', 'qkf', 'payments'), 1500),
  series(tagsOf('card_declined_retry', 'qkc', 'payments', 'tier_down'), 300),
  series(tagsOf('card_declined_retry', 'qkc', 'payments', 'pass'), 100),
  series(tagsOf('cache_miss_burst', 'qkd', 'newsvc'), 4000),
  series(tagsOf('boot_complete', 'qke', 'newsvc'), 100),
];
const PRIOR: DdSeries[] = [
  { tags: { message_pattern: 'order_placed', tenx_hash: 'qka', k8s_container: 'checkout' }, total: 28_000, firstNonZeroSec: SINCE - 20 * DAY },
  { tags: { message_pattern: 'ledger_synced', tenx_hash: 'qkf', k8s_container: 'payments' }, total: 42_000, firstNonZeroSec: SINCE - 20 * DAY },
];
const POLICY: PolicyFiles = {
  source: 'gitops repo acme/policy',
  capsCsv: 'container,cap\npayments,40000\n',
  actionsCsv: 'container,action\ntenx-seed,pass\npayments,tier_down:0:fleet rule\n',
};

function report(policy: PolicyFiles = POLICY, extra: Partial<Parameters<typeof buildChangeReport>[0]> = {}) {
  return buildChangeReport({
    current: CURRENT,
    prior: PRIOR,
    sinceSec: SINCE,
    nowSec: NOW,
    teamTag: null,
    policy,
    action: 'tier_down',
    headroom: 2,
    limit: 25,
    ...extra,
  });
}

test('actions.csv rows: the action before the first colon; the seed row and comments are skipped', () => {
  const m = parseActionsCsv('container,action\n# note\ntenx-seed,pass\ncheckout,tier_down:1760000000:reason\nbad\nauth,offload\n');
  assert.deepEqual([...m.entries()], [['checkout', 'tier_down'], ['auth', 'offload']]);
  assert.equal(parseActionsCsv(undefined).size, 0);
});

test('since: a duration back from now, a date, or nothing usable', () => {
  assert.equal(parseSince('7d', NOW), NOW - 7 * DAY);
  assert.equal(parseSince('36h', NOW), NOW - 36 * 3600);
  assert.equal(parseSince('2026-10-06', NOW), Date.parse('2026-10-06') / 1000);
  assert.equal(parseSince('last week', NOW), null);
});

test('new statements: lines a day, Standard cost, held or not, and the rule that held each', () => {
  const r = report();
  assert.equal(r.window_days, 7);
  assert.equal(r.statement_count_total, 4);
  assert.deepEqual(
    r.statements.map((s) => [s.pattern, s.container, Math.round(s.lines_a_day), s.held]),
    [
      ['cart_retry_storm', 'checkout', 5000, false],
      ['cache_miss_burst', 'newsvc', 4000, false],
      ['card_declined_retry', 'payments', 400, true],
      ['boot_complete', 'newsvc', 100, false],
    ],
  );
  // 5,000 lines a day x 730/24 days at $1.70 per million = $0.2585 a month.
  assert.ok(Math.abs(r.statements[0].standard_usd_month - (5000 * (730 / 24) / 1e6) * 1.7) < 1e-9);
  assert.equal(standardUsdMonth(1e6 / (730 / 24)), 1.7);
  const held = r.statements.find((s) => s.held)!;
  assert.equal(Math.round(held.held_lines_a_day), 300);
  assert.deepEqual(held.rule, { kind: 'service_row', container: 'payments', action: 'tier_down', text: 'the payments row (tier_down)' });
  assert.equal(r.held_count, 1);
  assert.equal(r.next_since, new Date(NOW * 1000).toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z'));
});

test('proposed rows: the service\'s largest kept statement, or the fleet\'s times the headroom, in the plan\'s sentence', () => {
  const r = report();
  assert.deepEqual(
    r.proposed_rows.map((p) => [p.container, p.basis, p.lines_a_day_limit, p.statements.map((s) => s.pattern)]),
    [
      ['checkout', 'service', 1000, ['cart_retry_storm']],
      // fleet's largest kept statement is ledger_synced at 1,500 a day; times 2 = 3,000
      ['newsvc', 'fleet', 3000, ['cache_miss_burst']],
    ],
  );
  assert.equal(
    r.proposed_rows[0].sentence,
    'checkout: any statement above 1,000 lines a day goes to Flex. Today that is this one statement, about $0.26 a month.',
  );
  assert.equal(
    r.proposed_rows[1].sentence,
    'newsvc: any statement above 3,000 lines a day goes to Flex. Today that is this one statement, about $0.21 a month.',
  );
  // payments has a row, so it gets no proposal; nothing in it is listed as without one either.
  assert.ok(!r.proposed_rows.some((p) => p.container === 'payments'));
  assert.ok(r.caveats.some((c) => c.includes('times 2')));

  const wider = report(POLICY, { headroom: 3 });
  assert.equal(wider.proposed_rows.find((p) => p.container === 'newsvc'), undefined);
  assert.deepEqual(wider.services_without_proposal, ['newsvc']);
});

test('a statement row matches the series hash without case, since Datadog lower-cases metric tags', () => {
  const r = report({ ...POLICY, capsCsv: 'container,cap\npat:QKC,4096\n', actionsCsv: undefined });
  const held = r.statements.find((s) => s.held)!;
  assert.equal(held.rule?.kind, 'statement_row');
  assert.equal(held.rule?.text, 'the statement row for qkc in payments (tier_down)');
});

test('engine files not read: held statements show the route only, every service with an unheld new statement is proposed', () => {
  const r = report({ source: null });
  const held = r.statements.find((s) => s.held)!;
  assert.equal(held.rule?.kind, 'not_read');
  assert.ok(r.caveats.some((c) => c.startsWith('The engine files (caps.csv, actions.csv) were not read')));
  assert.equal(r.policy_source, null);
});

test('offload rows use the plan\'s offload wording', () => {
  const r = report(POLICY, { action: 'offload' });
  assert.equal(
    r.proposed_rows[0].sentence,
    'checkout: any statement above 1,000 lines a day goes to the offload bucket. Today that is this one statement, about $0.26 a month.',
  );
});

test('the rendered report: plain sentences, the proposed rows, the next since', () => {
  const md = renderChangeReportMarkdown(report(), { tenxEnv: 'prod' });
  assert.ok(md.includes('4 statements new since'));
  assert.ok(md.includes('1 held by a rule, 2 proposed rows.'));
  assert.ok(md.includes('Held: 300 lines a day to Flex by the payments row (tier_down).'));
  assert.ok(md.includes('- checkout: any statement above 1,000 lines a day goes to Flex.'));
  assert.ok(md.includes('Next report: since='));
  assert.ok(!md.includes('\u2014'), 'no em dash');
  assert.ok(!/\byou\b/i.test(md), 'no "you"');
  assert.ok(!/costliest/i.test(md));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Seen {
  method: string;
  host: string;
  path: string;
}

function stubDatadog(seen: Seen[], body: (url: URL) => unknown): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    seen.push({ method: init?.method ?? 'GET', host: url.host, path: url.pathname });
    return new Response(JSON.stringify(body(url)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('ddQueryWindow: one GET to /api/v1/query, window totals per group, null points skipped', async () => {
  const seen: Seen[] = [];
  let query = '';
  stubDatadog(seen, (url) => {
    query = url.searchParams.get('query') ?? '';
    assert.equal(url.searchParams.get('from'), String(SINCE));
    assert.equal(url.searchParams.get('to'), String(NOW));
    return {
      status: 'ok',
      series: [
        { tag_set: ['message_pattern:a', 'routestate:tier_down'], pointlist: [[(SINCE + 60) * 1000, 0], [(SINCE + 120) * 1000, 4], [(SINCE + 180) * 1000, null], [(SINCE + 240) * 1000, 6]] },
        { scope: 'message_pattern:b,routestate:pass', pointlist: [[(SINCE + 60) * 1000, 0]] },
      ],
    };
  });
  const rows = await ddQueryWindow({ site: 'us5.datadoghq.com', apiKey: 'k', appKey: 'a' }, 'sum:m{*} by {message_pattern}.as_count()', SINCE, NOW);
  assert.deepEqual(seen, [{ method: 'GET', host: 'api.us5.datadoghq.com', path: '/api/v1/query' }]);
  assert.equal(query, 'sum:m{*} by {message_pattern}.as_count()');
  assert.deepEqual(rows, [
    { tags: { message_pattern: 'a', routestate: 'tier_down' }, total: 10, firstNonZeroSec: SINCE + 120 },
    { tags: { message_pattern: 'b', routestate: 'pass' }, total: 0, firstNonZeroSec: null },
  ]);
});

test('the tool reads only GETs on the metrics API, detects the team tag, and writes nothing', async () => {
  const seen: Seen[] = [];
  const queries: string[] = [];
  stubDatadog(seen, (url) => {
    if (url.pathname.endsWith('/all-tags')) {
      return { data: { attributes: { tags: ['message_pattern:a', 'tenx_team:payments-eng', 'routestate:pass'] } } };
    }
    const q = url.searchParams.get('query') ?? '';
    queries.push(q);
    const isPrior = Number(url.searchParams.get('to')) <= SINCE;
    if (isPrior) {
      return { status: 'ok', series: [{ tag_set: ['message_pattern:order_placed', 'tenx_hash:qka', 'k8s_container:checkout'], pointlist: [[(SINCE - DAY) * 1000, 900]] }] };
    }
    return {
      status: 'ok',
      series: [
        { tag_set: ['message_pattern:order_placed', 'tenx_hash:qka', 'k8s_container:checkout', 'tenx_user_service:checkout', 'routestate:pass', 'tenx_team:payments-eng'], pointlist: [[(SINCE + 60) * 1000, 7000]] },
        { tag_set: ['message_pattern:cart_retry_storm', 'tenx_hash:qkb', 'k8s_container:checkout', 'tenx_user_service:checkout', 'routestate:pass', 'tenx_team:payments-eng'], pointlist: [[(SINCE + 60) * 1000, 35000]] },
      ],
    };
  });
  const out = await executeDatadogChangeReport(
    { since: '7d', tenx_env: 'prod' },
    undefined,
    { creds: { site: 'datadoghq.eu', apiKey: 'k', appKey: 'a' }, readPolicy: async () => ({ source: null }), nowMs: () => NOW * 1000 },
  );
  assert.ok(seen.every((s) => s.method === 'GET' && s.host === 'api.datadoghq.eu'), JSON.stringify(seen));
  assert.ok(seen.some((s) => s.path === '/api/v2/metrics/emitted_events_summaryVolume/all-tags'));
  assert.equal(seen.filter((s) => s.path === '/api/v1/query').length, 2);
  assert.equal(seen.length, 3);
  assert.ok(queries.every((q) => q.startsWith('sum:emitted_events_summaryVolume{tenx_env:prod} by {')));
  assert.ok(queries.some((q) => q.includes('tenx_team')));
  assert.equal(out.status, 'success');
  const payload = out.data.payload as Record<string, unknown>;
  assert.equal(payload.team_tag, 'tenx_team');
  const stmts = payload.statements as Array<{ pattern: string; team: string | null }>;
  assert.deepEqual(stmts.map((s) => [s.pattern, s.team]), [['cart_retry_storm', 'payments-eng']]);
  assert.ok(String(payload.markdown).includes('team payments-eng'));
});

test('without keys the tool says which to set and offers the monitors view, which needs none', async () => {
  globalThis.fetch = (async () => {
    throw new Error('no network in this test');
  }) as typeof fetch;
  const out = await executeDatadogChangeReport({}, undefined, { creds: null });
  assert.equal(out.status, 'error');
  assert.equal(out.data.error?.error_type, 'config_missing');
  assert.ok(String(out.data.error?.hint).includes('DD_API_KEY'));
  const mon = await executeDatadogChangeReport({ view: 'monitors', tenx_env: 'prod' }, undefined, { creds: null });
  assert.equal(mon.status, 'success');
  const p = mon.data.payload as { monitors: Array<{ query: string }> };
  assert.equal(p.monitors.length, 2);
});

test('the route monitor fires per statement when its lines turn tier_down or offload', () => {
  const m = buildSpikeMonitors({ tenxEnv: 'Prod', notify: ['@slack-log-cost', 'not-a-handle'] });
  assert.equal(
    m.route.query,
    'sum(last_1h):sum:emitted_events_summaryVolume{tenx_env:prod AND routestate IN (tier_down, offload)} ' +
      'by {message_pattern,tenx_hash,k8s_container,tenx_user_service,routestate}.as_count() > 0',
  );
  assert.equal(m.route.type, 'query alert');
  assert.deepEqual((m.route.options as { thresholds: unknown }).thresholds, { critical: 0 });
  assert.ok(m.route.message.endsWith('\n@slack-log-cost'));
  assert.ok(!m.route.message.includes('not-a-handle'));
});

test('the volume monitor is an anomaly monitor with weekly seasonality, above only', () => {
  const m = buildSpikeMonitors({ teamTag: 'tenx_team' });
  assert.ok(m.volume.query.startsWith('avg(last_5h):anomalies(sum:emitted_events_summaryVolume{*} by {message_pattern,tenx_hash,k8s_container,tenx_user_service,tenx_team}.as_count(), \'robust\', 3,'));
  assert.ok(m.volume.query.includes("direction='above'"));
  assert.ok(m.volume.query.includes("seasonality='weekly'"));
  assert.ok(m.volume.query.endsWith('>= 1'));
  assert.deepEqual((m.volume.options as { thresholds: unknown }).thresholds, { critical: 1, critical_recovery: 0 });
  assert.ok(m.volume.message.includes('Team: {{tenx_team.name}}.'));
  assert.deepEqual(spikeMonitorGroupBy(), ['message_pattern', 'tenx_hash', 'k8s_container', 'tenx_user_service']);
  for (const def of [m.route, m.volume]) {
    assert.ok(!def.message.includes('\u2014') && !def.name.includes('\u2014'), 'no em dash');
    assert.ok(!/\byou\b/i.test(def.message), 'no "you"');
  }
});
