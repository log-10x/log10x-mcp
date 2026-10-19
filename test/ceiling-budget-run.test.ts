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
      // As Datadog answers a rollup: buckets of the query's interval, aligned
      // to the interval, so the first starts at or before \`from\`.
      const n = Number(/rollup\(sum, (\d+)\)/.exec(q)?.[1] ?? 3600);
      const aligned = (tags: Record<string, string>, perHour: number): Series => {
        const points: Array<[number, number]> = [];
        for (let t = Math.floor(from / n) * n; t < to; t += n) points.push([t, (perHour * n) / H]);
        return { tags, points };
      };
      return [
        aligned({ tenx_hash: 'a', message_pattern: 'big_one', k8s_container: 'checkout', severity_level: 'INFO' }, 30_000),
        aligned({ tenx_hash: 'b', k8s_container: 'checkout', severity_level: 'ERROR' }, 1_000),
        aligned({ tenx_hash: 'c', k8s_container: 'payments', severity_level: 'INFO' }, 5_000),
      ];
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
  // Over budget, a service without a row gets the same level and the median service's total.
  assert.equal(caps['*'], 430);
  assert.equal(totals['*'], Math.floor((1_000 + level + 5_000) / 2 / 15 / 2));
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

test('review 6: the statement query is hourly, inside the 1,500-point limit', async () => {
  const calls: string[] = [];
  seams._setBudgetDeps?.({ creds, query: datadogStub(calls), k8s: clusterStub(2, []), nowMs: () => NOW * 1000 });
  await tick.runTick(parsePolicyYaml(policy()));
  assert.ok(calls.some((q) => /log10x\.all_events_summaryVolume\{tenx_env:env-1\} by \{tenx_hash,message_pattern,k8s_container,severity_level\}\.rollup\(sum, 3600\)/.test(q)), calls.join('\n'));
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
  // The plan builder as advise_install calls it for an engine that reads the
  // git lane (1.1.146): the pinned 1.1.145 refuses policy_git (re-review 2).
  const { buildReporterPlan } = await import('../src/lib/advisor/reporter.js');
  const { getSnapshot } = await import('../src/lib/discovery/snapshot-store.js');
  const { receiverFleetValues } = await import('../src/lib/fleet-default-install.js');
  const values = receiverFleetValues({ datadog: true, engineVersion: '1.1.146' });
  const plan = await buildReporterPlan({
    snapshot: getSnapshot('snap-policy-git') as never,
    app: 'receiver',
    forwarder: 'fluentbit',
    builtinLicense: true,
    destination: 'mock',
    backends: ['prometheus'],
    backendCredentials: { prometheus: { secretName: 'prom-creds' } },
    airgapped: false,
    engineOptions: values.options,
    engineEnv: values.env,
    policyGit: { repo: 'acme/log10x-config', branch: 'log10x-policy', tokenSecretName: 'log10x-policy-git' },
  } as never);
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(plan);
  const md = strings.join('\n');
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
  assert.match(md, /git -c "http\.https:\/\/github\.com\/\.extraheader=\$AUTH" push --quiet origin log10x-policy/);
  // The token never lands in a remote URL or a file, and the clone is removed.
  assert.doesNotMatch(md, /x-access-token:\$\{GH_TOKEN\}@/);
  assert.match(md, /trap 'rm -rf "\$SEED"' EXIT/);
  assert.doesNotMatch(md, /Seed the engine-policy ConfigMap/);
  // The seed step comes before the Helm values step, and the seed records events.
  assert.ok(md.indexOf('Seed the policy files on the pulled branch') < md.indexOf('Write Helm values'));
  assert.match(md, /printf 'events\\n' > log10x\/policy\/regulator-unit/);

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
});

test('re-review 3 gate: statement rates survive buckets aligned before the window', async () => {
  const { hourlyRate } = await import('../src/lib/budget-tick.js');
  // A run at 12:37 with a 24-hour lookback: the first hourly bucket starts at 12:00 the day before.
  const from = NOW + 37 * 60 - 24 * H;
  const pts: Array<[number, number]> = [];
  for (let t = Math.floor(from / H) * H; t < from + 24 * H; t += H) pts.push([t, 1_000]);
  assert.equal(hourlyRate(pts), 1_000);
  // A run off the hour reads the same limits as one on it.
  const writes: Array<Record<string, string>> = [];
  seams._setBudgetDeps?.({ creds, query: datadogStub([]), k8s: clusterStub(2, writes), nowMs: () => (NOW + 37 * 60) * 1000 });
  await tick.runTick(parsePolicyYaml(policy()));
  assert.ok(rows(writes[0]['caps.csv']).checkout > 1, 'statements are not read as 0 an hour');
  assert.ok(rows(writes[0]['totals.csv']).payments > 1);
});

test('re-review 1 gate: the files-lane switch follows the engine', async () => {
  const { buildCompactReceiverGitopsExplainer, gitopsFilesSwitch } = await import('../src/lib/advisor/reporter.js');
  const { azureStreamsRecipe } = await import('../src/lib/offload-recipes.js');
  assert.equal(gitopsFilesSwitch('1.1.145'), 'GH_ENABLED');
  assert.equal(gitopsFilesSwitch('1.1.146'), 'GH_FILES_ENABLED');
  const names = (v: string) => buildCompactReceiverGitopsExplainer({ optimize: false, engineVersion: v }).envVars.map((e) => e.name);
  assert.ok(names('1.1.145').includes('GH_ENABLED') && !names('1.1.145').includes('GH_FILES_ENABLED'));
  assert.ok(names('1.1.146').includes('GH_FILES_ENABLED') && !names('1.1.146').includes('GH_ENABLED'));
  const body = (v: string) => JSON.stringify(azureStreamsRecipe({ engineVersion: v }));
  assert.match(body('1.1.145'), /\\nGH_ENABLED=true/);
  assert.match(body('1.1.146'), /\\nGH_FILES_ENABLED=true/);
  assert.doesNotMatch(body('1.1.146'), /\\nGH_ENABLED=true/);
});

test('re-review 2 gate: policy_git below 1.1.146 is refused with a note; the Receiver reads the ConfigMap', async () => {
  const { putSnapshot } = await import('../src/lib/discovery/snapshot-store.js');
  const { SNAPSHOT_SCHEMA_VERSION } = await import('../src/lib/discovery/types.js');
  const { executeAdviseInstall } = await import('../src/tools/advise-install.js');
  const { manifestEngineVersion } = await import('../src/lib/fleet-default-install.js');
  assert.equal(manifestEngineVersion(), '1.1.145');
  putSnapshot({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'snap-policy-git-old',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kubectl: {
      available: true, namespaces: ['logging'], probedNamespaces: ['logging'],
      forwarders: [{ kind: 'fluentbit', namespace: 'logging', workloadKind: 'DaemonSet', workloadName: 'fluent-bit', image: 'cr.fluentbit.io/fluent/fluent-bit:3.1.0', containerName: 'fluent-bit', labels: {}, readyReplicas: 3 }],
      helmReleases: [], log10xApps: [], storageClasses: [], ingressClasses: [], serviceAccountIrsa: [], backendAgents: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
    probeLog: [],
  } as never);
  const out = await executeAdviseInstall(
    { snapshot_id: 'snap-policy-git-old', app: 'receiver', forwarder: 'fluentbit', backends: ['prometheus'], backend_credentials: { prometheus: { secretName: 'prom-creds' } }, airgapped: false, license_source: 'builtin', log_destination: 'datadog', policy_git: { repo: 'acme/log10x-config' } } as never,
    {} as never,
  );
  const md = String((out.data as Record<string, unknown>).markdown);
  assert.doesNotMatch(md, /- name: GH_ENABLED/);
  assert.match(md, /- name: K8S_ENABLED/);
  assert.match(md, /The git path for the policy files \(policy_git\) needs engine 1\.1\.146 or later/);
});

// ── New services and hourly runs; services with their own number ────────────

test('new-service gate: over budget, the `*` row gets the known level L and the median known service total', async () => {
  const { writes, result } = await run(2);
  const caps = rows(writes[0]['caps.csv']);
  const totals = rows(writes[0]['totals.csv']);
  const level = (20 / 1.7e-6 - 348 * 10_000 - 2_000 * 396) / 396 - 6_000;
  // L per window per node over the 2 Receivers, the limit checkout's 30,000 statement gets.
  assert.equal(caps['*'], Math.floor(level / 15 / 2));
  assert.equal(caps['*'], caps.checkout);
  // The median of checkout (1,000 + L) and payments (5,000), per window per node.
  assert.equal(totals['*'], Math.floor(((1_000 + level) + 5_000) / 2 / 15 / 2));
  assert.equal(totals['*'], Math.floor((totals.checkout + totals.payments) / 2));
  assert.match(result.budget_report ?? '', /A service the run has not seen gets the same level and the median service's [\d,]+ an hour until the next run, which takes any overshoot back from the rest of the month\./);
});

test('new-service gate: under budget with nothing left over, the `*` row gets the median known service cap and total', async () => {
  // X = $34: the Receiver's services may send about 39,717 an hour against 36,000, so
  // each keeps room to grow 1.10x and nothing is left over.
  const { writes, result } = await run(2, policy().replace('budget_usd_monthly: 20', 'budget_usd_monthly: 34'));
  const caps = rows(writes[0]['caps.csv']);
  const totals = rows(writes[0]['totals.csv']);
  const h = (34 / 1.7e-6 - 348 * 10_000 - 2_000 * 396) / 396 / 36_000;
  assert.ok(h > 1 && h < 2);
  assert.equal(caps['*'], Math.floor(((30_000 + 5_000) / 2) * h / 15 / 2));
  assert.equal(totals['*'], Math.floor(((31_000 + 5_000) / 2) * h / 15 / 2));
  assert.match(result.budget_report ?? '', /A service the run has not seen gets the larger of the 0 an hour left over and the median service's limits, [\d,]+ an hour in all, until the next run, which takes any overshoot back from the rest of the month\./);
});

test('new-service: once X is spent the `*` row stays at 1; with no known service it gets what is left over', async () => {
  const spent = await run(2, policy().replace('budget_usd_monthly: 20', 'budget_usd_monthly: 5'));
  assert.equal(rows(spent.writes[0]['caps.csv'])['*'], 1);
  assert.equal(rows(spent.writes[0]['totals.csv'])['*'], 1);
  const { planBudget } = await import('../src/lib/budget-tick.js');
  const p = parsePolicyYaml(policy());
  const plan = planBudget({
    budget: p.budget_usd!,
    nowSec: NOW,
    usage: [hourly({ datadog_index: 'main' }, OCT1, NOW, 10_000)],
    routes: [hourly({ routestate: 'pass' }, OCT1, NOW, 8_000)],
    patterns: [],
    instances: {},
    nodesTotal: 2,
    instanceBasis: 'policy',
    exceptions: [],
    targetServices: [],
  });
  const allowance = (20 / 1.7e-6 - 348 * 10_000 - 2_000 * 396) / 396;
  assert.equal(plan.star.cap, Math.floor(allowance / 15 / 2));
  assert.equal(plan.star.total, plan.star.cap);
});

test('hourly gate: a budget policy with no schedule runs hourly in the CronJob and the GitHub Actions workflow', async () => {
  const { executeSetupRecurring } = await import('../src/tools/setup-recurring.js');
  const drive = async (scheduler: string, extra: Record<string, unknown>) => {
    const r = await executeSetupRecurring({ target_services: [], budget_usd_monthly: 20_000, standard_indexes: ['main'], scheduler, confirm: true, ...extra } as never);
    return (r as unknown as { data: Record<string, string> }).data;
  };
  const k8s = await drive('k8s_cron', { namespace: 'logging' });
  assert.equal(k8s.mode, 'emit', k8s.markdown);
  assert.match(k8s.scheduler_manifest, /\n  schedule: "0 \* \* \* \*"\n/);
  assert.match(k8s.scheduler_manifest, /preset: "?hourly"?\n/);
  const gha = await drive('github_actions', { config_plane: 'https://github.com/acme/log10x-config', nodes_by_container: { checkout: 2 } });
  assert.equal(gha.mode, 'emit', gha.markdown);
  assert.match(gha.scheduler_manifest, /- cron: "0 \* \* \* \*"/);
  assert.match(gha.policy_yaml, /cron_utc: "0 \* \* \* \*"/);
  // A named schedule still wins, and a policy without a budget keeps its default.
  const named = await drive('k8s_cron', { namespace: 'logging', schedule: 'every-6h' });
  assert.match(named.scheduler_manifest, /\n  schedule: "0 \*\/6 \* \* \*"\n/);
  const { emitGitHubActions } = await import('../src/lib/scheduler-manifest-emitter.js');
  const plain = emitGitHubActions({ target_services: [], target_percent: 30, scheduler: 'github_actions', config_plane: 'x', exceptions: [], min_delta_pp: 2 });
  assert.match(plain, /- cron: "0 3 \* \* \*"/);
});

/** checkout and payments each send their own Standard lines: 6,000 and 2,000 an hour. */
function byContainerStub(calls: string[]) {
  const base = datadogStub(calls);
  return async (c: unknown, q: string, from: number, to: number): Promise<Series[]> => {
    if (q.includes('emitted_events_summaryVolume')) {
      calls.push(q);
      return [
        hourly({ routestate: 'pass', k8s_container: 'checkout' }, OCT1, NOW, 6_000),
        hourly({ routestate: 'pass', k8s_container: 'payments' }, OCT1, NOW, 2_000),
        hourly({ routestate: 'tier_down', k8s_container: 'checkout' }, OCT1, NOW, 20_000),
        hourly({ routestate: 'tier_down', k8s_container: 'payments' }, OCT1, NOW, 9_000),
      ];
    }
    return base(c, q, from, to);
  };
}

async function runOwn(text: string) {
  const writes: Array<Record<string, string>> = [];
  const calls: string[] = [];
  seams._setBudgetDeps?.({ creds, query: byContainerStub(calls), k8s: clusterStub(2, writes), nowMs: () => NOW * 1000 });
  const result = await tick.runTick(parsePolicyYaml(text));
  return { result, writes, calls };
}

test('service_budgets gate: a named service is held to its own number, the rest of the account to X minus it', async () => {
  const { result, writes, calls } = await runOwn(policy('  service_budgets:\n    payments: 4'));
  assert.equal(result.status, 'applied', result.message);
  const caps = rows(writes[0]['caps.csv']);
  const totals = rows(writes[0]['totals.csv']);
  // payments: $4 is 2,352,941 events; it sent 348 x 2,000 to Standard so far, so it
  // may send the rest over 396 hours, about 4,184 an hour against 5,000 now.
  const ownRate = (4 / 1.7e-6 - 348 * 2_000) / 396;
  assert.equal(caps.payments, Math.floor(ownRate / 15 / 2));
  assert.equal(totals.payments, Math.floor(ownRate / 15 / 2));
  // The rest: $16 less what the account spent outside payments (348 x 8,000) and
  // what lines outside the Receiver add (2,000 an hour), over 396 hours, for checkout.
  const rest = (16 / 1.7e-6 - 348 * 8_000 - 2_000 * 396) / 396;
  assert.equal(caps.checkout, Math.floor((rest - 1_000) / 15 / 2));
  assert.equal(totals.checkout, Math.floor(rest / 15 / 2));
  // Held through the month: what each spent plus its rate for the hours left is its number.
  assert.ok(Math.abs(348 * 2_000 + ownRate * 396 - 4 / 1.7e-6) < 1);
  assert.ok(Math.abs(348 * 8_000 + 2_000 * 396 + rest * 396 - 16 / 1.7e-6) < 1);
  const report = result.budget_report ?? '';
  assert.match(report, /payments is held to its own \$4 a month: \$1\.2 spent so far, 4,184 events an hour for the rest of the month, a limit of 139 per statement and a total of 139 per window per node\./);
  assert.match(report, /\| payments \(own \$4 a month\) \|/);
  assert.match(report, /The Receiver's other services get the rest of \$16\./);
  // Each service's Standard lines come from the Receiver's emitted series, by container.
  assert.ok(calls.some((q) => /log10x\.emitted_events_summaryVolume\{tenx_env:env-1\} by \{routestate,k8s_container\}\.rollup\(sum, 3600\)/.test(q)), calls.join('\n'));

  // A named service that has spent its number gets 1 line, like a spent account.
  const spent = await runOwn(policy('  service_budgets:\n    payments: 1'));
  assert.equal(rows(spent.writes[0]['caps.csv']).payments, 1);
  assert.equal(rows(spent.writes[0]['totals.csv']).payments, 1);
  assert.match(spent.result.budget_report ?? '', /payments has spent its own \$1 for this month \(\$1\.2 so far\)\. Until the month ends, in payments, every line past its 5-line sample moves to Flex/);
});

test('service_budgets gate: a sum at or over X is refused, and so is a named service in exceptions', async () => {
  assert.throws(() => parsePolicyYaml(policy('  service_budgets:\n    payments: 15\n    checkout: 5')), /service_budgets add up to 20 dollars a month[^\n]*Their sum must be under it\./);
  assert.throws(() => parsePolicyYaml(policy('  service_budgets:\n    payments: 25')), /add up to 25/);
  assert.throws(
    () => parsePolicyYaml(policy('  service_budgets:\n    payments: 4').replace('  exceptions: []', '  exceptions:\n    - payments')),
    /payments is in both service_budgets and exceptions/,
  );
  assert.throws(() => parsePolicyYaml(policy('  service_budgets:\n    payments: -4')), /service_budgets\.payments must be a positive number/);
  assert.deepEqual(parsePolicyYaml(policy('  service_budgets:\n    payments: 4')).budget_usd?.service_budgets, { payments: 4 });
  const { executeSetupRecurring } = await import('../src/tools/setup-recurring.js');
  await assert.rejects(
    executeSetupRecurring({ budget_usd_monthly: 20_000, service_budgets: { payments: 20_000 } } as never),
    /add up to 20000 dollars a month/,
  );
});

test('service_budgets: log10x_setup_recurring writes them to policy.yaml', async () => {
  const { executeSetupRecurring } = await import('../src/tools/setup-recurring.js');
  const r = await executeSetupRecurring({
    target_services: [], budget_usd_monthly: 20_000, standard_indexes: ['main'], scheduler: 'k8s_cron', namespace: 'logging',
    service_budgets: { payments: 4_000 }, confirm: true,
  } as never);
  const data = (r as unknown as { data: Record<string, string> }).data;
  assert.equal(data.mode, 'emit', data.markdown);
  assert.match(data.policy_yaml, /\n  service_budgets:\n    payments: 4000\n/);
  assert.deepEqual(parsePolicyYaml(data.policy_yaml).budget_usd?.service_budgets, { payments: 4_000 });
  assert.match(data.markdown, /\| Own numbers      \| payments \$4000 a month \|/);
});
