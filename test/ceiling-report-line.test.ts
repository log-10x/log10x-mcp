/**
 * Gate for handoff 4b.3: the one report line. Standard held at X, and what
 * the Receiver moved this month from its routeState series, priced where it
 * went (Flex storage, or off the bill in S3) and at the Standard rate.
 * Datadog and the Kubernetes API are stubs; no network.
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
        hourly({ routestate: 'offload' }, OCT1, NOW, 1_000),
      ];
    }
    if (q.includes('all_events_summaryVolume')) {
      return [
        hourly({ tenx_hash: 'a', k8s_container: 'checkout', severity_level: 'INFO' }, from, to, 30_000),
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

const repo = mkdtempSync(join(tmpdir(), 'budget-line-'));

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

const seams = tick as unknown as { _setBudgetDeps?: (d: unknown) => void; _resetBudgetDeps?: () => void };

afterEach(() => {
  seams._resetBudgetDeps?.();
  tick._resetBackendLoader();
});

test('4b.3 gate: the report says Standard held at X and prices what moved where it went', async () => {
  const writes: Array<Record<string, string>> = [];
  seams._setBudgetDeps?.({ creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' }, query: datadogStub([]), k8s: clusterStub(2, writes), nowMs: () => NOW * 1000 });
  tick._setBackendLoader(async () => ({ queryInstant: async () => ({ status: 'success', data: { result: [] } }) }) as never);
  const result = await tick.runTick(parsePolicyYaml(policy()));
  // 348 hours this month: 20,000 an hour to Flex is 6.96 million events (printed 7 million), at
  // $0.05 a million stored about $0.35 a month, $11.83 at $1.70; 1,000 an hour
  // to S3 is 348,000 events, $0.59 at $1.70. Standard: 3.48 million, $5.92.
  const line =
    'Standard held at $20 a month: $5.9 so far this month. Moved this month: ' +
    '7 million events to Flex, about $0.35 a month of Flex storage at $0.05 per million (Flex compute is unpriced and left out), $12 at the Standard rate; ' +
    '348,000 events to S3, off the Datadog bill, $0.59 at the Standard rate.';
  assert.ok((result.budget_report ?? '').includes(line), result.budget_report);
  assert.ok((writes[0]?.['budget-report.md'] ?? '').includes(line));
  assert.ok(result.message.includes('Standard held at $20 a month'));
});
