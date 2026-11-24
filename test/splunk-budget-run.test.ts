/**
 * The Splunk run: each named service held at its own GB a day in the index.
 * The reads go through a fake Prometheus that answers the run's two queries;
 * the plan is checked against the arithmetic it states (each service keeps at
 * most its number at the limits, down to the always-pass floor), and the run
 * writes the policy ConfigMap through a stub Kubernetes API. No network.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { parsePolicyYaml, PolicyLoadError } from '../src/lib/policy-loader.js';
import { emitPolicyYaml, emitK8sBudgetCronJob, emitGitHubActions, isBudgetRun, scheduleOf } from '../src/lib/scheduler-manifest-emitter.js';
import { planSplunk, readSplunkInputs, renderSplunkReport, type SplunkReads } from '../src/lib/splunk-budget-tick.js';
import { renderBudgetFiles } from '../src/lib/budget-tick.js';
import { receiverFleetValues } from '../src/lib/fleet-default-install.js';
import { executeSetupRecurring } from '../src/tools/setup-recurring.js';
import { isStructuredOutput } from '../src/lib/output-types.js';
import { REGULATOR_WINDOW_SECONDS } from '../src/lib/report/user-units.js';
import * as tick from '../src/lib/recurring-tick.js';
import type { CustomerMetricsBackend } from '../src/lib/customer-metrics.js';

const NOW = 1_792_660_000;
const HOUR_END = Math.floor(NOW / 3600) * 3600;
const WINDOWS = 3600 / REGULATOR_WINDOW_SECONDS;
const GB = 1e9;

function policyText(extra: string, plane = '  delivery: configmap\n  namespace: logging'): string {
  return ['schema_version: "1.0"', 'reduction:', '  target_services: []', extra, '  exceptions: []', 'config_plane:', '  repo: /tmp/x', plane, ''].join('\n');
}

const TWO = '  splunk_gb_per_day:\n    checkout: 40\n    payments: 25\n  splunk_deployment: cloud';

test('policy: GB a day per service, the deployment, tier_down on Cloud and offload on Enterprise', () => {
  const p = parsePolicyYaml(policyText(TWO));
  assert.deepEqual(p.splunk?.gb_per_day, { checkout: 40, payments: 25 });
  assert.equal(p.splunk?.deployment, 'cloud');
  assert.equal(p.splunk?.default_action, 'tier_down');
  assert.equal(p.splunk?.container_label, 'k8s_container');
  assert.equal(p.splunk?.keep_count, 50);
  assert.equal(p.config_plane.delivery, 'configmap');
  const e = parsePolicyYaml(policyText('  splunk_gb_per_day:\n    checkout: 40\n  splunk_deployment: enterprise'));
  assert.equal(e.splunk?.default_action, 'offload');
  assert.throws(() => parsePolicyYaml(policyText('  splunk_gb_per_day:\n    checkout: 40\n  splunk_deployment: enterprise\n  default_action: tier_down')), /Splunk Cloud only/);
  assert.throws(() => parsePolicyYaml(policyText('  splunk_gb_per_day:\n    checkout: 40\n  splunk_deployment: enterprise\n  service_actions:\n    checkout: tier_down')), /Splunk Cloud only/);
  assert.throws(() => parsePolicyYaml(policyText('  splunk_gb_per_day:\n    checkout: 40')), /splunk_deployment must be cloud or enterprise/);
  assert.throws(() => parsePolicyYaml(policyText('  splunk_gb_per_day: {}\n  splunk_deployment: cloud')), /at least one service/);
  assert.throws(() => parsePolicyYaml(policyText('  splunk_gb_per_day:\n    checkout: lots\n  splunk_deployment: cloud')), PolicyLoadError);
  assert.throws(() => parsePolicyYaml(policyText(`${TWO}\n  target_percent: 30`)), /different goals/);
  assert.throws(() => parsePolicyYaml(policyText(`${TWO}\n  rows_per_hour: 100`)), /different goals/);
  assert.throws(() => parsePolicyYaml(policyText(`${TWO}\n  container_label: k8s.container`)), /Prometheus label name/);
  const exc = ['schema_version: "1.0"', 'reduction:', TWO, '  exceptions:', '    - checkout', 'config_plane:', '  delivery: configmap', ''].join('\n');
  assert.throws(() => parsePolicyYaml(exc), /in both splunk_gb_per_day and exceptions/);
});

test('setup writes a Splunk policy the loader reads, hourly, with the Prometheus URL only', () => {
  for (const scheduler of ['k8s_cron', 'github_actions'] as const) {
    const opts = { target_services: [], target_percent: 30, scheduler, config_plane: '/tmp/repo', exceptions: [], min_delta_pp: 2, splunk_gb_per_day: { checkout: 40, payments: 25 }, splunk_deployment: 'cloud' as const };
    assert.ok(isBudgetRun(opts));
    assert.equal(scheduleOf(opts), 'hourly');
    const p = parsePolicyYaml(emitPolicyYaml(opts));
    assert.deepEqual(p.splunk?.gb_per_day, { checkout: 40, payments: 25 }, scheduler);
    assert.equal(p.splunk?.default_action, 'tier_down');
    assert.equal(p.cron_utc, '0 * * * *');
    assert.equal(p.config_plane.delivery, scheduler === 'k8s_cron' ? 'configmap' : 'gitops');
    const manifest = scheduler === 'k8s_cron' ? emitK8sBudgetCronJob(opts) : emitGitHubActions(opts);
    assert.match(manifest, /LOG10X_CUSTOMER_METRICS_URL/);
    assert.doesNotMatch(manifest, /DD_API_KEY|CLICKHOUSE_URL|LOG10X_ES_URL/);
    if (scheduler === 'k8s_cron') assert.match(manifest, /name: log10x-prometheus\n\s+key: LOG10X_CUSTOMER_METRICS_URL/);
  }
  const ent = emitPolicyYaml({ target_services: [], target_percent: 30, scheduler: 'k8s_cron', config_plane: '', exceptions: [], min_delta_pp: 2, splunk_gb_per_day: { checkout: 40 }, splunk_deployment: 'enterprise' });
  assert.equal(parsePolicyYaml(ent).splunk?.default_action, 'offload');
});

test('a Splunk Receiver counts bytes, returns full text with routeState, and names the hash tenx_pattern', () => {
  const v = receiverFleetValues({ datadog: false, splunkBudget: true, engineVersion: '1.1.181' });
  assert.deepEqual(v.options.find(([k]) => k === 'symbolMessageHashField'), ['symbolMessageHashField', 'tenx_pattern']);
  assert.equal(v.options.find(([k]) => k === 'rateReceiverUnit'), undefined);
  assert.deepEqual(v.env, [['outputOffload', 'true']]);
  assert.ok(!v.options.some(([, val]) => val === 'tenx_hash'));
});

type Row = { c: string; h: string; sev?: string; route?: string; bytes: number; lines: number; label?: 'tenx_pattern' | 'tenx_hash' };

function fakeProm(rows: Row[]) {
  const promql: string[] = [];
  const answer = (q: string, pick: (r: Row) => number) => ({
    status: 'success',
    data: {
      resultType: 'vector',
      result: rows.map((r) => ({
        metric: { k8s_container: r.c, [r.label ?? 'tenx_pattern']: r.h, message_pattern: `p_${r.h}`, severity_level: r.sev ?? 'INFO', routeState: r.route ?? 'pass' },
        value: [HOUR_END, String(pick(r))] as [number, string],
      })),
    },
  });
  const prom = {
    backendType: 'mock',
    endpoint: 'mock',
    async queryInstant(q: string) {
      promql.push(q);
      if (q.includes('all_events_summaryBytes_total')) return answer(q, (r) => r.bytes);
      if (q.includes('all_events_summaryVolume_total')) return answer(q, (r) => r.lines);
      throw new Error(`unexpected PromQL: ${q}`);
    },
    async queryRange() {
      throw new Error('not used');
    },
    async listLabels() {
      return [];
    },
    async listLabelValues() {
      return [];
    },
    remoteWriteUrl() {
      return undefined;
    },
  } as unknown as CustomerMetricsBackend;
  return { prom, promql };
}

/** checkout over its 40 GB a day, payments under its 25, frontend without a number. */
const FLEET: Row[] = [
  { c: 'checkout', h: 'AAAAAAAAAAA', bytes: 1.2e9, lines: 2.4e6 },
  { c: 'checkout', h: 'AAAAAAAAAAA', route: 'tier_down', bytes: 0.3e9, lines: 0.6e6 },
  { c: 'checkout', h: 'BBBBBBBBBBB', bytes: 0.5e9, lines: 1e6 },
  { c: 'checkout', h: 'CCCCCCCCCCC', sev: 'ERROR', bytes: 0.1e9, lines: 2e5 },
  { c: 'payments', h: 'DDDDDDDDDDD', bytes: 0.4e9, lines: 8e5 },
  { c: 'payments', h: 'EEEEEEEEEEE', label: 'tenx_hash', bytes: 0.2e9, lines: 4e5 },
  { c: 'frontend', h: 'FFFFFFFFFFF', bytes: 0.3e9, lines: 6e5 },
];

test('reads: bytes and lines a pattern over the last complete hour, every route kept apart', async () => {
  const splunk = parsePolicyYaml(policyText(TWO)).splunk!;
  const f = fakeProm(FLEET);
  const r = await readSplunkInputs(NOW, splunk, f.prom, 'edge');
  assert.equal(f.promql.length, 2);
  for (const q of f.promql) {
    assert.match(q, /^sum by \(k8s_container, tenx_pattern, tenx_hash, message_pattern, severity_level, routeState\) \(clamp_min\(/);
    assert.match(q, new RegExp(`\\{tenx_env="edge"\\} @ ${HOUR_END} - \\(all_events_\\w+_total\\{tenx_env="edge"\\} @ ${HOUR_END - 3600} or `));
  }
  assert.equal(r.statements.length, FLEET.length);
  const a = r.statements.filter((s) => s.hash === 'AAAAAAAAAAA');
  assert.deepEqual(a.map((s) => s.route).sort(), ['pass', 'tier_down']);
  assert.equal(r.statements.find((s) => s.hash === 'EEEEEEEEEEE')?.bytesPerHour, 0.2e9, 'a hash under tenx_hash is read too');
  assert.equal(r.statements.find((s) => s.hash === 'CCCCCCCCCCC')?.linesPerHour, 2e5);
});

function reads(rows: Row[]): SplunkReads {
  return {
    statements: rows.map((r) => ({ container: r.c, hash: r.h, pattern: `p_${r.h}`, severity: r.sev ?? 'INFO', route: r.route ?? 'pass', bytesPerHour: r.bytes, linesPerHour: r.lines })),
    queries: [],
  };
}

test('plan: a service over its number trims its loudest pattern to the level; one under it keeps every pattern', () => {
  const splunk = parsePolicyYaml(policyText(TWO)).splunk!;
  const plan = planSplunk({ splunk, reads: reads(FLEET), instances: { checkout: 3, payments: 2 }, nodesTotal: 3, instanceBasis: 'discovery' });
  const checkout = plan.rows.find((r) => r.container === 'checkout')!;
  const payments = plan.rows.find((r) => r.container === 'payments')!;
  assert.deepEqual(plan.rows.map((r) => r.container), ['checkout', 'payments'], 'only named services get rows');
  // checkout: 50.4 GB a day against 40; the loud pattern A (36 GB a day) gives way, B and C stay whole.
  assert.ok(Math.abs(checkout.bytesPerHour * 24 - 50.4 * GB) < 1);
  assert.ok(Math.abs(checkout.keptPerHour * 24 - 40 * GB) < 1e6, `kept ${checkout.keptPerHour * 24}`);
  const level = checkout.cap * 3 * WINDOWS; // fleet bytes an hour per pattern
  assert.ok(level < 1.5e9 && level > 0.5e9, `level ${level} sits between A and B`);
  assert.ok(checkout.total * 3 * WINDOWS <= (40 * GB) / 24, 'the total per node per window adds up to at most the number');
  assert.equal(checkout.action, 'tier_down');
  // payments: 14.4 GB a day against 25; room to grow, never above its number.
  assert.ok(Math.abs(payments.keptPerHour - payments.bytesPerHour) < 1);
  assert.ok(payments.total * 2 * WINDOWS <= (25 * GB) / 24 + 1);
  // every other service: a limit of 0, which exempts it
  assert.deepEqual(plan.star, { action: 'pass', instances: 3, cap: 0, total: 0 });
  const files = renderBudgetFiles(plan);
  assert.equal(files['caps.csv'], `container,cap\ncheckout,${checkout.cap}::budget run\npayments,${payments.cap}::budget run\n*,0::budget run\n`);
  assert.equal(files['actions.csv'], 'container,action\ncheckout,tier_down::budget run\npayments,tier_down::budget run\n*,pass::budget run\n');
  assert.equal(files['totals.csv'], `container,total\ncheckout,${checkout.total}::budget run\npayments,${payments.total}::budget run\n*,0::budget run\n`);
  const report = renderSplunkReport(plan, splunk, NOW);
  assert.match(report, /Splunk index held at 65 GB a day across 2 services/);
  assert.match(report, /checkout sends 50\.4 GB a day against its 40 GB: each pattern keeps up to/);
  assert.match(report, /1 other service seen by the Receiver is left alone/);
  assert.match(report, /Machine Data Lake/);
  assert.doesNotMatch(report, /\$|USD|price/i);
});

test('plan: Splunk Enterprise offloads; a named service the Receiver does not see keeps its whole number', () => {
  const splunk = parsePolicyYaml(policyText('  splunk_gb_per_day:\n    checkout: 40\n    billing: 5\n  splunk_deployment: enterprise')).splunk!;
  const plan = planSplunk({ splunk, reads: reads(FLEET), instances: { checkout: 3 }, nodesTotal: 3, instanceBasis: 'policy' });
  assert.ok(plan.rows.every((r) => r.action === 'offload'));
  const billing = plan.rows.find((r) => r.container === 'billing')!;
  assert.equal(billing.total, Math.floor((5 * GB * REGULATOR_WINDOW_SECONDS) / 86400));
  assert.ok(plan.warnings.some((w) => w.includes('no lines from billing')));
  assert.ok(plan.warnings.some((w) => w.includes('No node count for billing')));
  assert.match(renderSplunkReport(plan, splunk, NOW), /the account's bucket/);
});

test('plan: when the always-pass sample alone exceeds a number, the run says so', () => {
  const splunk = parsePolicyYaml(policyText('  splunk_gb_per_day:\n    chatty: 0.001\n  splunk_deployment: cloud')).splunk!;
  const many = Array.from({ length: 40 }, (_, i) => ({ c: 'chatty', h: `h${i}`, bytes: 1e8, lines: 1e6 }));
  const plan = planSplunk({ splunk, reads: reads(many), instances: { chatty: 10 }, nodesTotal: 10, instanceBasis: 'discovery' });
  assert.ok(plan.warnings.some((w) => w.includes('always-pass sample alone') && w.includes('rateReceiverBaselineCount')));
});

test('setup wizard: splunk_gb_per_day asks Cloud or Enterprise, then emits', async () => {
  const getData = (r: unknown) => {
    assert.ok(isStructuredOutput(r));
    return (r as { data: Record<string, unknown> }).data;
  };
  let data = getData(await executeSetupRecurring({ target_services: [], splunk_gb_per_day: { checkout: 40, payments: 25 }, scheduler: 'k8s_cron', namespace: 'logging' }));
  assert.equal(data.question_id, 'splunk_deployment', String(data.markdown));
  const session_id = data.session_id as string;
  data = getData(await executeSetupRecurring({ session_id, splunk_deployment: 'cloud' }));
  assert.equal(data.question_id, 'confirm', String(data.markdown));
  assert.match(String(data.markdown), /Splunk budget +\| checkout 40 GB, payments 25 GB a day in the index, lines over it to Machine Data Lake/);
  data = getData(await executeSetupRecurring({ session_id, confirm: true }));
  assert.equal(data.mode, 'emit', String(data.markdown));
  const p = parsePolicyYaml(String(data.policy_yaml));
  assert.equal(p.splunk?.deployment, 'cloud');
  assert.equal(p.config_plane.namespace, 'logging');
  assert.match(String(data.apply_instructions), /log_destination: "splunk"/);
  assert.match(String(data.apply_instructions), /destination: "splunk_cloud"/);
  await assert.rejects(executeSetupRecurring({ target_services: [], splunk_gb_per_day: { checkout: 40 }, rows_per_hour: 100 }), /pass one goal/);
});

// ─── the run ─────────────────────────────────────────────────────────────────

function clusterStub(writes: Array<Record<string, string>>, unit = 'bytes') {
  const receivers = ['node-0', 'node-1', 'node-2'].map((n) => ({ nodeName: n, containers: ['fluent-bit', 'tenx'], policyConfigMaps: ['log10x-action-intent'] }));
  const apps = [
    ...['node-0', 'node-1', 'node-2'].map((n) => ({ nodeName: n, containers: ['checkout'] })),
    ...['node-0', 'node-1'].map((n) => ({ nodeName: n, containers: ['payments'] })),
  ];
  return {
    async listRunningPods(namespace?: string) {
      return namespace === 'logging' ? receivers : [...receivers, ...apps];
    },
    async getConfigMap() {
      return { data: { 'caps.csv': 'container,cap\ntenx-seed,1::install seed\n', 'regulator-unit': unit }, resourceVersion: '7' };
    },
    async replaceConfigMap(_ns: string, _name: string, data: Record<string, string>) {
      writes.push(data);
    },
  };
}

const seams = tick as unknown as { _setBudgetDeps: (d: unknown) => void; _resetBudgetDeps: () => void };

afterEach(() => seams._resetBudgetDeps());

test('run: reads the counters, discovers the nodes, writes the three files and the report to the ConfigMap', async () => {
  const writes: Array<Record<string, string>> = [];
  seams._setBudgetDeps({ prom: fakeProm(FLEET).prom, k8s: clusterStub(writes), nowMs: () => NOW * 1000 });
  const result = await tick.runTick(parsePolicyYaml(policyText(TWO)));
  assert.equal(result.status, 'applied', result.message);
  assert.equal(writes.length, 1);
  const w = writes[0];
  assert.match(w['caps.csv'], /^container,cap\ncheckout,\d+::budget run\npayments,\d+::budget run\n\*,0::budget run\n$/);
  assert.match(w['actions.csv'], /^checkout,tier_down::budget run$/m);
  assert.match(w['totals.csv'], /^\*,0::budget run$/m);
  assert.ok(w['config-generation.csv']);
  assert.match(w['budget-report.md'], /Node counts discovered on this run/);
  assert.equal(w['regulator-unit'], 'bytes', 'the rest of the ConfigMap is kept');
  // checkout on 3 nodes, payments on 2
  const plan = planSplunk({ splunk: parsePolicyYaml(policyText(TWO)).splunk!, reads: reads(FLEET), instances: { checkout: 3, payments: 2 }, nodesTotal: 3, instanceBasis: 'discovery' });
  assert.equal(w['caps.csv'], renderBudgetFiles(plan)['caps.csv']);
});

test('run: a Receiver recorded as counting events is refused and nothing is written', async () => {
  const writes: Array<Record<string, string>> = [];
  seams._setBudgetDeps({ prom: fakeProm(FLEET).prom, k8s: clusterStub(writes, 'events'), nowMs: () => NOW * 1000 });
  const result = await tick.runTick(parsePolicyYaml(policyText(TWO)));
  assert.equal(result.status, 'refused');
  assert.match(result.message, /The Splunk run writes limits in bytes/);
  assert.equal(writes.length, 0);
});

test('run: a failed Prometheus read keeps the last files', async () => {
  const writes: Array<Record<string, string>> = [];
  const down = { async queryInstant() { return { status: 'error', data: { result: [] } }; } } as unknown as CustomerMetricsBackend;
  seams._setBudgetDeps({ prom: down, k8s: clusterStub(writes), nowMs: () => NOW * 1000 });
  const result = await tick.runTick(parsePolicyYaml(policyText(TWO)));
  assert.equal(result.status, 'read_failed');
  assert.match(result.message, /The files from the last run stay in force/);
  assert.equal(writes.length, 0);
});
