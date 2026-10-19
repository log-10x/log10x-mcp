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
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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

function clusterStub(nodes: number, writes: Array<Record<string, string>>, extra: Record<string, string> = {}) {
  const names = Array.from({ length: nodes }, (_, i) => `node-${i}`);
  return {
    async listRunningPods() {
      return names.flatMap((n) => [
        { nodeName: n, containers: ['checkout'] },
        { nodeName: n, containers: ['payments'] },
      ]);
    },
    async countNodes() {
      return nodes;
    },
    async getConfigMap() {
      return { data: { 'caps.csv': 'container,cap\ntenx-seed,1::install seed\n', ...extra }, resourceVersion: '7' };
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
  seams._setBudgetDeps?.({ creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' }, query: datadogStub([]), k8s: null, nowMs: () => NOW * 1000 });
  const result = await tick.runTick(parsePolicyYaml(text), { dryRun: true });
  assert.equal(result.status, 'dry_run');
  assert.equal(rows(result.budget_files?.['caps.csv']).checkout, 215);
  assert.match(result.budget_report ?? '', /Node counts from nodes_by_container in policy\.yaml/);
  assert.ok(!existsSync(join(repo, 'pipelines', 'run', 'receive', 'rate', 'caps.csv')), 'dry run writes nothing');
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
