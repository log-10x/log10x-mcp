/**
 * Gate for handoff 4b.2: the budget run. A Datadog Standard budget held
 * month to date, every row re-derived on each run and divided by the node
 * count found on that run, written to the policy ConfigMap the Receiver
 * reads. Datadog and the Kubernetes API are stubs; no network.
 *
 * The gate: a run with a doubled node count halves the per-node limits.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePolicyYaml } from '../src/lib/policy-loader.js';
import * as tick from '../src/lib/recurring-tick.js';

const H = 3600;
const NOW = Date.UTC(2026, 9, 15, 12) / 1000; // 2026-10-15T12:00Z
const OCT1 = Date.UTC(2026, 9, 1) / 1000;

type Series = { tags: Record<string, string>; points: Array<[number, number]> };

function hourly(tags: Record<string, string>, from: number, to: number, v: number): Series {
  const points: Array<[number, number]> = [];
  for (let t = from; t < to; t += H) points.push([t, v]);
  return { tags, points };
}

/**
 * Standard counted 10,000 events an hour this month, 8,000 of them from the
 * Receiver; a Flex-only index counted more, which must not count. The
 * Receiver's statements: checkout 30,000 and 1,000 an hour, payments 5,000.
 */
function datadogStub(calls: string[]) {
  return async (_c: unknown, q: string, from: number, to: number): Promise<Series[]> => {
    calls.push(q);
    if (q.includes('datadog.estimated_usage.logs.ingested_events')) {
      return [
        hourly({ service: 'checkout', datadog_index: 'main' }, OCT1, NOW, 10_000),
        hourly({ service: 'checkout', datadog_index: 'flex-only' }, OCT1, NOW, 50_000),
      ];
    }
    if (q.includes('emitted_events_summaryVolume')) {
      return [
        hourly({ routestate: 'pass' }, OCT1, NOW, 8_000),
        hourly({ routestate: 'tier_down' }, OCT1, NOW, 20_000),
      ];
    }
    if (q.includes('all_events_summaryVolume')) {
      return [
        hourly({ tenx_hash: 'a', message_pattern: 'big_one', k8s_container: 'checkout', severity_level: 'INFO' }, from, to, 30_000),
        hourly({ tenx_hash: 'b', k8s_container: 'checkout', severity_level: 'ERROR' }, from, to, 1_000),
        hourly({ tenx_hash: 'c', k8s_container: 'payments', severity_level: 'INFO' }, from, to, 5_000),
      ];
    }
    return [];
  };
}

/**
 * `nodes` nodes run a Receiver pod (fluent-bit, whose env names the policy
 * ConfigMap) and both services. One more node runs checkout but no Receiver:
 * it enforces nothing and must not count.
 */
function clusterStub(nodes: number, writes: Array<Record<string, string>>, extra: Record<string, string> = {}) {
  const names = Array.from({ length: nodes }, (_, i) => `node-${i}`);
  const receivers = names.map((n) => ({ nodeName: n, containers: ['fluent-bit', 'tenx'], policyConfigMaps: ['log10x-action-intent'] }));
  const apps = [
    ...names.flatMap((n) => [
      { nodeName: n, containers: ['checkout'] },
      { nodeName: n, containers: ['payments'] },
    ]),
    { nodeName: 'node-without-receiver', containers: ['checkout'] },
  ];
  return {
    async listRunningPods(namespace?: string) {
      return namespace === 'logging' ? receivers : [...receivers, ...apps, { nodeName: 'node-without-receiver', containers: ['other'] }];
    },
    async getConfigMap() {
      return { data: { 'caps.csv': 'container,cap\ntenx-seed,1::install seed\n', 'regulator-unit': 'events', ...extra }, resourceVersion: '7' };
    },
    async replaceConfigMap(_ns: string, _name: string, data: Record<string, string>) {
      writes.push(data);
    },
  };
}

const repo = mkdtempSync(join(tmpdir(), 'budget-run-'));

function policy(extra = ''): string {
  return [
    'schema_version: "1.0"',
    'reduction:',
    '  target_services: []',
    '  budget_usd_monthly: 20',
    '  standard_indexes:',
    '    - main',
    '  exceptions: []',
    extra,
    'config_plane:',
    `  repo: ${repo}`,
    '  delivery: configmap',
    '  namespace: logging',
    '  env_id: env-1',
    '',
  ].join('\n');
}

/** Rows of one file as container -> number. */
function rows(csv: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of (csv ?? '').split('\n').slice(1)) {
    const [c, v] = line.split(',');
    if (c && v) out[c] = Number(v.split(':')[0]);
  }
  return out;
}

const seams = tick as unknown as {
  _setBudgetDeps?: (d: unknown) => void;
  _resetBudgetDeps?: () => void;
};

async function run(nodes: number, text = policy()) {
  const writes: Array<Record<string, string>> = [];
  const calls: string[] = [];
  seams._setBudgetDeps?.({ creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' }, query: datadogStub(calls), k8s: clusterStub(nodes, writes), nowMs: () => NOW * 1000 });
  // Main runs the mute-list tick for this policy; give it an empty metrics backend.
  tick._setBackendLoader(async () => ({ queryInstant: async () => ({ status: 'success', data: { result: [] } }) }) as never);
  const result = await tick.runTick(parsePolicyYaml(text));
  return { result, writes, calls };
}

afterEach(() => {
  seams._resetBudgetDeps?.();
  tick._resetBackendLoader();
});

test('4b.2 gate: a run with a doubled node count halves the per-node limits and totals', async () => {
  const two = await run(2);
  const four = await run(4);
  assert.equal(two.writes.length, 1, 'the run writes the policy ConfigMap');
  assert.equal(four.writes.length, 1);
  const caps2 = rows(two.writes[0]['caps.csv']);
  const caps4 = rows(four.writes[0]['caps.csv']);
  const tot2 = rows(two.writes[0]['totals.csv']);
  const tot4 = rows(four.writes[0]['totals.csv']);
  for (const svc of ['checkout', 'payments']) {
    assert.ok(caps2[svc] > 1, `${svc} has a limit`);
    assert.ok(Math.abs(caps4[svc] - caps2[svc] / 2) <= 1, `${svc} limit halves: ${caps2[svc]} -> ${caps4[svc]}`);
    assert.ok(Math.abs(tot4[svc] - tot2[svc] / 2) <= 1, `${svc} total halves: ${tot2[svc]} -> ${tot4[svc]}`);
  }
});

test('4b.2: month to date, (X - spent - lines outside the Receiver) over the hours left, noisiest first', async () => {
  const { result, writes } = await run(2);
  assert.equal(result.status, 'applied');
  const w = writes[0];
  // X = $20 at $1.70 a million = 11,764,706 events. Spent: 348 hours x 10,000 (the
  // flex-only index does not count). Outside the Receiver: 2,000 an hour, so
  // 792,000 more over the 396 hours left. The rest over 396 hours is about
  // 18,921 an hour against 36,000 sent: statements are held at about 12,921 an
  // hour, so the 30,000 one moves and the two small ones keep every line.
  // Per 4-minute window per node: 12,921 / 15 / 2 = 430.
  const allowance = (20 / 1.7e-6 - 348 * 10_000 - 2_000 * 396) / 396;
  const level = allowance - 6_000;
  const caps = rows(w['caps.csv']);
  const totals = rows(w['totals.csv']);
  assert.equal(caps.checkout, Math.floor(level / 15 / 2));
  assert.equal(caps.checkout, 430);
  assert.equal(caps.payments, 430);
  assert.equal(totals.checkout, Math.floor((1_000 + level) / 15 / 2));
  assert.equal(totals.payments, Math.floor(5_000 / 15 / 2));
  // Over budget, nothing is left for a service without a row.
  assert.equal(caps['*'], 1);
  assert.equal(totals['*'], 1);
  assert.match(w['actions.csv'], /^checkout,tier_down::/m);
  assert.match(w['actions.csv'], /^\*,tier_down::/m);
  assert.match(w['config-generation.csv'], /^key,value\ngeneration,[0-9a-f]{12}\n$/);
  assert.match(w['budget-report.md'], /Standard indexing this month: \$5\.9 of \$20/);
  // The seed and every other key of the ConfigMap survive.
  assert.ok(!('tenx-seed' in caps));
});

test('4b.2: under the budget each service keeps room to grow and the `*` row gets what is left', async () => {
  const { writes } = await run(2, policy().replace('budget_usd_monthly: 20', 'budget_usd_monthly: 200'));
  const caps = rows(writes[0]['caps.csv']);
  const totals = rows(writes[0]['totals.csv']);
  // Headroom 2: checkout's largest statement 30,000 an hour x 2 / 15 / 2 nodes.
  assert.equal(caps.checkout, 2_000);
  assert.equal(totals.checkout, Math.floor((31_000 * 2) / 15 / 2));
  assert.ok(totals['*'] > 1);
});

test('4b.2: once spent reaches X, every line past its sample moves for the rest of the month', async () => {
  const { result, writes } = await run(2, policy().replace('budget_usd_monthly: 20', 'budget_usd_monthly: 5'));
  const caps = rows(writes[0]['caps.csv']);
  const totals = rows(writes[0]['totals.csv']);
  assert.deepEqual(caps, { checkout: 1, payments: 1, '*': 1 });
  assert.deepEqual(totals, { checkout: 1, payments: 1, '*': 1 });
  assert.match(result.budget_report ?? '', /Standard has reached \$5 for this month\. Until the month ends, every line past its 5-line sample moves to Flex, except up to 50 error lines/);
});

test('4b.2: a failed Datadog read writes nothing, keeps the last files and says so', async () => {
  const writes: Array<Record<string, string>> = [];
  seams._setBudgetDeps?.({
    creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' },
    query: async () => {
      throw new Error('HTTP 503');
    },
    k8s: clusterStub(2, writes),
    nowMs: () => NOW * 1000,
  });
  const result = await tick.runTick(parsePolicyYaml(policy()));
  assert.equal(result.status, 'read_failed');
  assert.match(result.message, /HTTP 503.*The files from the last run stay in force\./);
  assert.equal(writes.length, 0);
});

test('4b.2: missing Datadog keys are a read failure, not a run on stale numbers', async () => {
  const writes: Array<Record<string, string>> = [];
  seams._setBudgetDeps?.({ creds: null, k8s: clusterStub(2, writes), nowMs: () => NOW * 1000 });
  const result = await tick.runTick(parsePolicyYaml(policy()));
  assert.equal(result.status, 'read_failed');
  assert.match(result.message, /DD_API_KEY and DD_APP_KEY/);
  assert.equal(writes.length, 0);
});

test('4b.2: exceptions are left alone and lines outside the Receiver near X are warned about', async () => {
  const text = policy()
    .replace('  exceptions: []', '  exceptions:\n    - payments')
    .replace('budget_usd_monthly: 20', 'budget_usd_monthly: 2');
  const { writes, result } = await run(2, text.replace('    - payments', '    - payments\n    - audit'));
  assert.match(writes[0]['actions.csv'], /^payments,pass::/m);
  // A 0 cap row exempts the service even with a `*` row; one that sent nothing still gets it.
  assert.equal(rows(writes[0]['caps.csv']).payments, 0);
  assert.equal(rows(writes[0]['caps.csv']).audit, 0);
  assert.match(writes[0]['actions.csv'], /^audit,pass::/m);
  assert.match(result.budget_report ?? '', /Warning: Lines that do not pass the Receiver alone reach/);
});

test('4b.2: gitops delivery divides by nodes_by_container and states it', async () => {
  const text = policy('  nodes_by_container:\n    checkout: 4\n    payments: 4')
    .replace('  delivery: configmap\n', '  delivery: gitops\n');
  mkdirSync(join(repo, 'log10x', 'policy'), { recursive: true });
  writeFileSync(join(repo, 'log10x', 'policy', 'regulator-unit'), 'events\n');
  seams._setBudgetDeps?.({ creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' }, query: datadogStub([]), k8s: null, nowMs: () => NOW * 1000 });
  const result = await tick.runTick(parsePolicyYaml(text), { dryRun: true });
  assert.equal(result.status, 'dry_run');
  assert.equal(rows(result.budget_files?.['caps.csv']).checkout, 215);
  assert.match(result.budget_report ?? '', /Node counts from nodes_by_container in policy\.yaml/);
  assert.ok(!existsSync(join(repo, 'log10x', 'policy', 'caps.csv')), 'dry run writes nothing');
  rmSync(join(repo, 'log10x'), { recursive: true, force: true });
});

test('4b.2: the run history is appended (no require in an ES module)', async () => {
  const before = existsSync(join(tmpdir(), 'log10x-recur-history.jsonl'))
    ? readFileSync(join(tmpdir(), 'log10x-recur-history.jsonl'), 'utf8').length
    : 0;
  await run(2);
  const after = readFileSync(join(tmpdir(), 'log10x-recur-history.jsonl'), 'utf8').length;
  assert.ok(after > before);
});

test('4b.2 (ruling 16): the report says when statements a mute protects alone exceed a service total', async () => {
  const writes: Array<Record<string, string>> = [];
  const until = NOW + 86_400;
  seams._setBudgetDeps?.({
    creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' },
    query: datadogStub([]),
    k8s: clusterStub(2, writes, { 'mutes.csv': `fieldSet,value\nbig_one,1:${until}:keep for audit\nother,0::drop\n` }),
    nowMs: () => NOW * 1000,
  });
  const result = await tick.runTick(parsePolicyYaml(policy()));
  assert.match(result.budget_report ?? '', /Warning: In checkout, statements a mute protects send 30,000 events an hour, above its total of 13,921: they still pass, every other line in it moves/);
  // The mute file the run read is left as it was.
  assert.equal(writes[0]['mutes.csv'], `fieldSet,value\nbig_one,1:${until}:keep for audit\nother,0::drop\n`);

  const expired: Array<Record<string, string>> = [];
  seams._setBudgetDeps?.({
    creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' },
    query: datadogStub([]),
    k8s: clusterStub(2, expired, { 'mutes.csv': `fieldSet,value\nbig_one,1:${NOW - 1}:expired\n` }),
    nowMs: () => NOW * 1000,
  });
  const r2 = await tick.runTick(parsePolicyYaml(policy()));
  assert.doesNotMatch(r2.budget_report ?? '', /statements a mute protects/);
});

// ── Review fixes (cold review of #279) ──────────────────────────────────────

const creds = { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' };

test('review 1 gate: the run refuses to write limits unless the Receiver is recorded as counting events', async () => {
  const writes: Array<Record<string, string>> = [];
  const k8s = clusterStub(2, writes, { 'regulator-unit': 'bytes' });
  seams._setBudgetDeps?.({ creds, query: datadogStub([]), k8s, nowMs: () => NOW * 1000 });
  const r = await tick.runTick(parsePolicyYaml(policy()));
  assert.equal(r.status, 'refused');
  assert.match(r.message, /found "bytes"[\s\S]*Re-install the Receiver with log10x_advise_install/);
  assert.equal(writes.length, 0);
  const missing = clusterStub(2, writes);
  const getCm = missing.getConfigMap;
  missing.getConfigMap = async () => {
    const cm = await getCm();
    delete (cm.data as Record<string, string>)['regulator-unit'];
    return cm;
  };
  seams._setBudgetDeps?.({ creds, query: datadogStub([]), k8s: missing, nowMs: () => NOW * 1000 });
  assert.equal((await tick.runTick(parsePolicyYaml(policy()))).status, 'refused');
  assert.equal(writes.length, 0);
});

test('review 1: the install records the unit; a Datadog Receiver counts events by default on 1.1.146', async () => {
  const { receiverFleetValues } = await import('../src/lib/fleet-default-install.js');
  const { renderPolicyConfigMapManifest } = await import('../src/lib/advisor/reporter-forwarders.js');
  const v = receiverFleetValues({ datadog: true, engineVersion: '1.1.146' });
  assert.ok(v.options.some(([k, val]) => k === 'rateReceiverUnit' && val === 'events'));
  assert.ok(!receiverFleetValues({ datadog: true, engineVersion: '1.1.145' }).options.some(([k]) => k === 'rateReceiverUnit'));
  assert.ok(!receiverFleetValues({ datadog: true, engineVersion: '1.1.146', unit: 'bytes' }).options.some(([k]) => k === 'rateReceiverUnit'));
  assert.match(renderPolicyConfigMapManifest('logging', 'events'), /\n  regulator-unit: events\n/);
  // A fleet limit given in lines is written as lines; one given in bytes only is not written as lines.
  const fd = { capBytesPerWindowPerNode: 6000, capEventsPerWindowPerNode: 40, action: 'tier_down' as const };
  assert.ok(receiverFleetValues({ datadog: true, engineVersion: '1.1.146', fleetDefault: fd }).options.some(([k, val]) => k === 'rateReceiverAbsoluteCap' && val === '40'));
  const bytesOnly = receiverFleetValues({ datadog: true, engineVersion: '1.1.146', fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'tier_down' } });
  assert.ok(!bytesOnly.options.some(([k]) => k === 'rateReceiverAbsoluteCap'));
});

test('review 2 gate: Flex never counts as spend; standard_indexes is required', async () => {
  // Spend in the MCP's Flex index (tenx-offload) and an unnamed index must not count.
  const calls: string[] = [];
  const base = datadogStub(calls);
  const withFlex = async (c: unknown, q: string, from: number, to: number) => {
    const out = await base(c, q, from, to);
    if (q.includes('estimated_usage')) out.push(hourly({ service: 'checkout', datadog_index: 'tenx-offload' }, OCT1, NOW, 900_000));
    return out;
  };
  const writes: Array<Record<string, string>> = [];
  seams._setBudgetDeps?.({ creds, query: withFlex, k8s: clusterStub(2, writes), nowMs: () => NOW * 1000 });
  const text = policy().replace('    - main', '    - main\n    - tenx-offload');
  const r = await tick.runTick(parsePolicyYaml(text));
  assert.match(r.budget_report ?? '', /Standard indexing this month: \$5\.9 of \$20/);
  assert.throws(() => parsePolicyYaml(policy().replace('  standard_indexes:\n    - main\n', '')), /needs standard_indexes/);
});

test('review 3 gate: nodes are the Receiver pods\' nodes, per service only those running a Receiver', async () => {
  const { discoverInstances } = await import('../src/lib/budget-tick.js');
  const d = await discoverInstances(clusterStub(2, []) as never, 'logging', 'log10x-action-intent');
  // checkout also runs on node-without-receiver, which enforces nothing.
  assert.deepEqual(d.instances, { 'fluent-bit': 2, tenx: 2, checkout: 2, payments: 2 });
  assert.equal(d.nodesTotal, 2);
  await assert.rejects(discoverInstances(clusterStub(2, []) as never, 'logging', 'other-cm'), /no running pod in logging names the ConfigMap other-cm/);
  const { result } = await run(2);
  assert.match(result.budget_report ?? '', /The division assumes a DaemonSet Receiver, one per node/);
});

test('review 4 gate: spend and the Receiver\'s own count end at the same hour; a clamp is logged', async () => {
  // Datadog's usage lags 3 hours; the Receiver's series run to now. Through the
  // same hour the split is exact: outside = 2,000 an hour, not less.
  const LAG = 3 * H;
  const lagged = async (_c: unknown, q: string, from: number, to: number) => {
    if (q.includes('estimated_usage')) return [hourly({ service: 'checkout', datadog_index: 'main' }, OCT1, NOW - LAG, 10_000)];
    if (q.includes('emitted_events')) return [hourly({ routestate: 'pass' }, OCT1, NOW, 8_000)];
    return datadogStub([])(_c, q, from, to);
  };
  const writes: Array<Record<string, string>> = [];
  seams._setBudgetDeps?.({ creds, query: lagged, k8s: clusterStub(2, writes), nowMs: () => NOW * 1000 });
  const r = await tick.runTick(parsePolicyYaml(policy()));
  // 345 hours of usage: 3.45 million spent, 690,000 outside (2,000 x 345).
  assert.match(r.budget_report ?? '', /Lines that do not pass the Receiver: 690,000 events in Standard this month/);
  // The Receiver above Datadog's count: outside is clamped at 0 and the report says so.
  const over = async (_c: unknown, q: string, from: number, to: number) => {
    if (q.includes('emitted_events')) return [hourly({ routestate: 'pass' }, OCT1, NOW, 12_000)];
    return datadogStub([])(_c, q, from, to);
  };
  seams._setBudgetDeps?.({ creds, query: over, k8s: clusterStub(2, []), nowMs: () => NOW * 1000 });
  const r2 = await tick.runTick(parsePolicyYaml(policy()));
  assert.match(r2.budget_report ?? '', /Warning: The Receiver's own count of lines sent to Standard \(4\.2 million\) is above Datadog's usage count \(3\.5 million\)[^\n]*taken as 0\./);
});

test('review 6: the statement query asks one point per series over the lookback', async () => {
  const calls: string[] = [];
  seams._setBudgetDeps?.({ creds, query: datadogStub(calls), k8s: clusterStub(2, []), nowMs: () => NOW * 1000 });
  await tick.runTick(parsePolicyYaml(policy()));
  assert.ok(calls.some((q) => /log10x\.all_events_summaryVolume\{tenx_env:env-1\} by \{tenx_hash,message_pattern,k8s_container,severity_level\}\.rollup\(sum, 86400\)/.test(q)), calls.join('\n'));
});

test('git path: gitops delivery commits straight to the log10x-policy branch, never a PR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'budget-git-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  g(work, 'config', 'user.email', 't@example.com');
  g(work, 'config', 'user.name', 't');
  // The install's seed: the four files and the unit on the pulled branch.
  g(work, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(work, 'policy.yaml'), 'x\n');
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'init');
  g(work, 'push', '-q', 'origin', 'main');
  g(work, 'checkout', '-q', '-b', 'log10x-policy');
  mkdirSync(join(work, 'log10x', 'policy'), { recursive: true });
  for (const [f, body] of [['caps.csv', 'container,cap\ntenx-seed,1::install seed\n'], ['actions.csv', 'container,action\ntenx-seed,pass::install seed\n'], ['totals.csv', 'container,total\ntenx-seed,1::install seed\n'], ['config-generation.csv', 'key,value\ngeneration,seed\n'], ['regulator-unit', 'events\n']]) {
    writeFileSync(join(work, 'log10x', 'policy', f), body);
  }
  g(work, 'add', '-A');
  g(work, 'commit', '-q', '-m', 'seed');
  g(work, 'push', '-q', 'origin', 'log10x-policy');
  g(work, 'checkout', '-q', 'main');
  const text = policy('  nodes_by_container:\n    checkout: 2\n    payments: 2')
    .replace(`  repo: ${repo}\n  delivery: configmap\n`, `  repo: ${work}\n  delivery: gitops\n  base_branch: main\n`);
  seams._setBudgetDeps?.({ creds, query: datadogStub([]), k8s: null, nowMs: () => NOW * 1000 });
  const prev = process.env.LOG10X_GITOPS_REPO_PATH;
  delete process.env.LOG10X_GITOPS_REPO_PATH;
  try {
    const r = await tick.runTick(parsePolicyYaml(text));
    assert.equal(r.status, 'applied', r.message);
    const caps = execFileSync('git', ['--git-dir', origin, 'show', 'log10x-policy:log10x/policy/caps.csv']).toString();
    assert.match(caps, /^checkout,430::/m);
    for (const f of ['actions.csv', 'totals.csv', 'config-generation.csv']) {
      assert.doesNotMatch(execFileSync('git', ['--git-dir', origin, 'show', `log10x-policy:log10x/policy/${f}`]).toString(), /tenx-seed/);
    }
    // main is untouched, no other branch was pushed (no PR branch), and the checkout stays on main.
    assert.throws(() => execFileSync('git', ['--git-dir', origin, 'show', 'main:log10x/policy/caps.csv'], { stdio: 'pipe' }));
    assert.deepEqual(execFileSync('git', ['--git-dir', origin, 'branch', '--format=%(refname:short)']).toString().trim().split('\n').sort(), ['log10x-policy', 'main']);
    assert.equal(g(work, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    // A second run with the same numbers changes nothing.
    assert.equal((await tick.runTick(parsePolicyYaml(text))).status, 'no_change');
  } finally {
    if (prev !== undefined) process.env.LOG10X_GITOPS_REPO_PATH = prev;
  }
});

test('git path gate: the install pulls log10x/policy from the branch with GH_* and seeds the four files first', async () => {
  const { putSnapshot } = await import('../src/lib/discovery/snapshot-store.js');
  const { SNAPSHOT_SCHEMA_VERSION } = await import('../src/lib/discovery/types.js');
  const { executeAdviseInstall } = await import('../src/tools/advise-install.js');
  putSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'snap-policy-git',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kubectl: {
      available: true,
      namespaces: ['logging'],
      probedNamespaces: ['logging'],
      forwarders: [
        { kind: 'fluentbit', namespace: 'logging', workloadKind: 'DaemonSet', workloadName: 'fluent-bit', image: 'cr.fluentbit.io/fluent/fluent-bit:3.1.0', containerName: 'fluent-bit', labels: {}, readyReplicas: 3 },
      ],
      helmReleases: [],
      log10xApps: [],
      storageClasses: [],
      ingressClasses: [],
      serviceAccountIrsa: [],
      backendAgents: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
    probeLog: [],
  } as never);
  const out = await executeAdviseInstall(
    {
      snapshot_id: 'snap-policy-git',
      app: 'receiver',
      forwarder: 'fluentbit',
      backends: ['prometheus'],
      backend_credentials: { prometheus: { secretName: 'prom-creds' } },
      airgapped: false,
      license_source: 'builtin',
      log_destination: 'datadog',
      policy_git: { repo: 'acme/log10x-config' },
    } as never,
    {} as never,
  );
  const md = String((out.data as Record<string, unknown>).markdown);
  assert.match(md, /- name: GH_ENABLED\n\s+value: "true"/);
  assert.match(md, /- name: GH_REPO\n\s+value: "acme\/log10x-config"/);
  assert.match(md, /- name: GH_BRANCH\n\s+value: "log10x-policy"/);
  assert.match(md, /- name: GH_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: log10x-policy-git\n\s+key: GH_TOKEN/);
  assert.doesNotMatch(md, /CAP_LOOKUP_FILE|ACTION_LOOKUP_FILE|TOTAL_LOOKUP_FILE|CONFIG_GENERATION_FILE|K8S_CONFIGMAP|K8S_ENABLED/);
  // The lane accepts only true/True/TRUE.
  assert.ok(md.includes('- name: GH_ENABLED\n          value: "true"') || /- name: GH_ENABLED\n\s+value: "true"\n/.test(md));
  assert.match(md, /Seed the policy files on the pulled branch/);
  for (const f of ['caps.csv', 'actions.csv', 'totals.csv', 'config-generation.csv']) {
    assert.ok(md.includes(`[ -f log10x/policy/${f} ] || printf`), `seeds ${f}`);
  }
  assert.match(md, /git push --quiet origin log10x-policy/);
  assert.doesNotMatch(md, /Seed the engine-policy ConfigMap/);
  // The seed step comes before the Helm values step.
  assert.ok(md.indexOf('Seed the policy files on the pulled branch') < md.indexOf('Write Helm values'));

  // The cluster path never sets GH_ENABLED: with both lanes on, the policy files would come from git.
  putSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'snap-policy-cm',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kubectl: {
      available: true,
      namespaces: ['logging'],
      probedNamespaces: ['logging'],
      forwarders: [
        { kind: 'fluentbit', namespace: 'logging', workloadKind: 'DaemonSet', workloadName: 'fluent-bit', image: 'cr.fluentbit.io/fluent/fluent-bit:3.1.0', containerName: 'fluent-bit', labels: {}, readyReplicas: 3 },
      ],
      helmReleases: [],
      log10xApps: [],
      storageClasses: [],
      ingressClasses: [],
      serviceAccountIrsa: [],
      backendAgents: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
    probeLog: [],
  } as never);
  const cluster = await executeAdviseInstall(
    {
      snapshot_id: 'snap-policy-cm',
      app: 'receiver',
      forwarder: 'fluentbit',
      backends: ['prometheus'],
      backend_credentials: { prometheus: { secretName: 'prom-creds' } },
      airgapped: false,
      license_source: 'builtin',
      log_destination: 'datadog',
    } as never,
    {} as never,
  );
  const cmd = String((cluster.data as Record<string, unknown>).markdown);
  assert.match(cmd, /- name: K8S_ENABLED/);
  assert.doesNotMatch(cmd, /- name: GH_ENABLED/);
  // The compact recipe now names GH_FILES_ENABLED, so it no longer asks for a policy folder.
  assert.match(cmd, /GH_FILES_ENABLED/);
});
