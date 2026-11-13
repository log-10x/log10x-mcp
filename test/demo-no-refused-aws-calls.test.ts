/**
 * The hosted public demo makes no AWS call its role is refused.
 *
 * The demo task role (log10x-public-demo-mcp-task) may run
 * logs:FilterLogEvents on /log10x/otel-demo and logs:DescribeLogGroups, and
 * nothing else. Every refused call trips the l1x-unauthorized-api-call alarm,
 * and anyone on the internet can drive the role. These tests stand in for the
 * SDK clients (prototype `send`) and record every command, then assert that in
 * the hosted demo:
 *   1. the SSM env-config store never sends GetParameter / GetParametersByPath;
 *   2. the CloudWatch log search reads /log10x/otel-demo only, with no
 *      DescribeLogGroups fan-out, whatever scope the caller passed;
 *   3. the CloudWatch dependency check answers "not available in the demo"
 *      without sending DescribeMetricFilters / DescribeAlarms / ListDashboards;
 *   4. Retriever discovery never sends ListBuckets.
 * Each demo case has a control showing the same path still calls AWS outside
 * the demo.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';

import { DEMO_ENV } from '../src/lib/demo-env.js';
import {
  isPublicDemoPlayground,
  PUBLIC_DEMO_LOG_GROUP,
} from '../src/lib/tool-availability.js';
import type { Environments } from '../src/lib/environments.js';
import { AwsSsmStore } from '../src/lib/env-config/store-aws-ssm.js';
import { cloudwatchConnector } from '../src/lib/siem/cloudwatch.js';
import { fetchCloudWatchInventory } from '../src/lib/siem/deps/cloudwatch.js';
import { checkDeps } from '../src/lib/siem/deps/index.js';
import { resolveRetriever, clearRetrieverResolutionCacheForTest } from '../src/lib/retriever-api.js';
import { setS3ClientFactoryForTests } from '../src/lib/s3-read.js';

type Sent = { command: string; input: Record<string, unknown> };

const ENV_KEYS = ['LOG10X_MCP_DEMO_PLAYGROUND', 'LOG10X_API_KEY', 'AWS_REGION', 'PATH'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

type Proto = { send: (...a: unknown[]) => unknown };
const savedSend = new Map<Proto, PropertyDescriptor | undefined>();

/** Replace `send` on a client class prototype; record every command. */
function recordSends(
  cls: { prototype: unknown },
  sent: Sent[],
  answer: (command: string, input: Record<string, unknown>) => unknown = () => ({}),
): void {
  const proto = cls.prototype as Proto;
  if (!savedSend.has(proto)) savedSend.set(proto, Object.getOwnPropertyDescriptor(proto, 'send'));
  proto.send = async function (cmd: unknown) {
    const command = (cmd as { constructor: { name: string } }).constructor.name;
    const input = ((cmd as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
    sent.push({ command, input });
    return answer(command, input);
  };
}

function hostedDemo(): void {
  process.env.LOG10X_MCP_DEMO_PLAYGROUND = '1';
  process.env.LOG10X_API_KEY = DEMO_ENV.apiKey;
  process.env.AWS_REGION = 'us-east-1';
}

function notDemo(): void {
  delete process.env.LOG10X_MCP_DEMO_PLAYGROUND;
  process.env.LOG10X_API_KEY = 'a-customer-key';
  process.env.AWS_REGION = 'us-east-1';
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const [proto, desc] of savedSend) {
    if (desc) Object.defineProperty(proto, 'send', desc);
    else delete (proto as Partial<Proto>).send;
  }
  savedSend.clear();
  setS3ClientFactoryForTests(null);
  clearRetrieverResolutionCacheForTest();
});

// ── the predicate ──────────────────────────────────────────────────────

test('isPublicDemoPlayground: demo mode on the playground only', () => {
  hostedDemo();
  assert.equal(isPublicDemoPlayground(), true, 'playground + public demo key');
  assert.equal(
    isPublicDemoPlayground({ isDemoMode: true } as Environments),
    true,
    'playground + envs.isDemoMode',
  );

  process.env.LOG10X_API_KEY = 'a-customer-key';
  assert.equal(isPublicDemoPlayground(), false, 'playground with a real key is not the demo');

  process.env.LOG10X_API_KEY = DEMO_ENV.apiKey;
  delete process.env.LOG10X_MCP_DEMO_PLAYGROUND;
  assert.equal(
    isPublicDemoPlayground({ isDemoMode: true } as Environments),
    false,
    'a keyless local boot is demo mode but not the hosted playground: its AWS creds are the user\'s own',
  );
});

// ── 1. SSM env-config store ────────────────────────────────────────────

test('SSM store: hosted demo reports unavailable and never sends', async () => {
  hostedDemo();
  const sent: Sent[] = [];
  recordSends(SSMClient, sent);
  const store = new AwsSsmStore();

  const avail = await store.isAvailable();
  assert.equal(avail.available, false);
  assert.match(avail.reason, /not available in the demo/);

  // A caller that skips isAvailable() still gets no client.
  await assert.rejects(() => store.read('6aa99191-f827-4579-a96a-c0ebdfe73884'), /not available in the demo/);
  await assert.rejects(() => store.list(), /not available in the demo/);

  assert.deepEqual(sent, [], 'no GetParameter / GetParametersByPath sent');
});

test('SSM store control: outside the demo, read and list send GetParameter / GetParametersByPath', async () => {
  notDemo();
  const sent: Sent[] = [];
  recordSends(SSMClient, sent, (command) => (command === 'GetParametersByPathCommand' ? { Parameters: [] } : { Parameter: undefined }));
  const store = new AwsSsmStore();
  await store.read('some-env');
  assert.deepEqual(
    sent.map((s) => s.command),
    ['GetParameterCommand', 'GetParametersByPathCommand'],
  );
  assert.equal(sent[1].input.Path, '/log10x/env-config/');
});

// ── 2. CloudWatch log search ───────────────────────────────────────────

const pull = (scope?: string) =>
  cloudwatchConnector.pullEvents({
    window: '1h',
    ...(scope !== undefined ? { scope } : {}),
    query: '"tenx_hash"',
    targetEventCount: 10,
    maxPullMinutes: 1,
    buckets: 2,
    onProgress: () => {},
  });

for (const scope of [undefined, '/log10x/*', '/aws/ecs/*', '/log10x/some-other-group', PUBLIC_DEMO_LOG_GROUP]) {
  test(`CloudWatch search: hosted demo reads ${PUBLIC_DEMO_LOG_GROUP} only (scope ${scope ?? 'unset'})`, async () => {
    hostedDemo();
    const sent: Sent[] = [];
    recordSends(CloudWatchLogsClient, sent, () => ({ events: [] }));

    const res = await pull(scope);

    assert.ok(sent.length > 0, 'the demo group is still searched');
    for (const s of sent) {
      assert.equal(s.command, 'FilterLogEventsCommand', `unexpected ${s.command}`);
      assert.equal(s.input.logGroupName, PUBLIC_DEMO_LOG_GROUP);
    }
    assert.equal(res.metadata.queryUsed.split(' | ')[0], PUBLIC_DEMO_LOG_GROUP);
  });
}

test('CloudWatch search control: outside the demo, an unset scope discovers /log10x* and searches every group', async () => {
  notDemo();
  const sent: Sent[] = [];
  recordSends(CloudWatchLogsClient, sent, (command) =>
    command === 'DescribeLogGroupsCommand'
      ? { logGroups: [{ logGroupName: '/log10x/a' }, { logGroupName: '/log10x/b' }] }
      : { events: [] },
  );

  await pull(undefined);

  assert.equal(sent[0].command, 'DescribeLogGroupsCommand');
  assert.equal(sent[0].input.logGroupNamePrefix, '/log10x');
  const searched = new Set(sent.filter((s) => s.command === 'FilterLogEventsCommand').map((s) => s.input.logGroupName));
  assert.deepEqual([...searched].sort(), ['/log10x/a', '/log10x/b']);
});

// ── 3. CloudWatch dependency check ─────────────────────────────────────

test('CloudWatch dependency check: hosted demo answers "not available in the demo" without sending', async () => {
  hostedDemo();
  const sent: Sent[] = [];
  recordSends(CloudWatchLogsClient, sent);
  recordSends(CloudWatchClient, sent);

  const inv = await fetchCloudWatchInventory();
  assert.match(inv.error ?? '', /not available in the demo/);
  assert.deepEqual(inv.objects, []);

  const dep = await checkDeps('cloudwatch', { pattern: 'checkout_failed', tokens: ['checkout', 'failed'] });
  assert.match(dep.error ?? '', /not available in the demo/);

  assert.deepEqual(sent, [], 'no DescribeMetricFilters / DescribeAlarms / ListDashboards sent');
});

test('CloudWatch dependency check control: outside the demo, the three reads are sent', async () => {
  notDemo();
  const sent: Sent[] = [];
  recordSends(CloudWatchLogsClient, sent, () => ({ metricFilters: [] }));
  recordSends(CloudWatchClient, sent, () => ({}));

  const inv = await fetchCloudWatchInventory();
  assert.equal(inv.error, undefined);
  assert.deepEqual(
    sent.map((s) => s.command).sort(),
    ['DescribeAlarmsCommand', 'DescribeMetricFiltersCommand', 'ListDashboardsCommand'],
  );
});

// ── 4. Retriever bucket discovery (same class: account-wide read) ──────

test('Retriever discovery: hosted demo never sends ListBuckets', async () => {
  hostedDemo();
  // No aws / kubectl / helm on PATH, as in the demo image, so the S3 read
  // would fall through to the SDK client recorded here.
  const empty = mkdtempSync(join(tmpdir(), 'no-cli-'));
  process.env.PATH = empty;
  const sent: string[] = [];
  setS3ClientFactoryForTests(() => ({
    async send(cmd: unknown) {
      sent.push((cmd as { constructor: { name: string } }).constructor.name);
      return { Buckets: [] };
    },
  }));
  try {
    clearRetrieverResolutionCacheForTest();
    const r = await resolveRetriever();
    assert.deepEqual(sent, [], 'no ListBuckets sent');
    const step = r.trace.find((t) => t.path === 'aws_s3_bucket_pattern');
    assert.match(step?.reason ?? '', /not available in the demo/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
