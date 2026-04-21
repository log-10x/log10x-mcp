/**
 * Streamer advisor tests. Locks down:
 *   - preflight fails closed when AWS infra is missing
 *   - auto-detection from snapshot works when infra is present
 *   - values file wires all four SQS queues + IRSA role
 *   - teardown commands do not touch AWS (infra = Terraform)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStreamerPlan } from '../../src/lib/advisor/streamer.js';
import type { DiscoverySnapshot } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';

function baseSnapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'disc-streamer-1',
    startedAt: '2026-04-21T00:00:00Z',
    finishedAt: '2026-04-21T00:01:00Z',
    kubectl: {
      available: true,
      context: 'arn:aws:eks:us-east-1:111:cluster/test',
      namespaces: ['demo', 'logging', 'default'],
      probedNamespaces: ['demo'],
      forwarders: [],
      helmReleases: [],
      log10xApps: [],
      storageClasses: ['gp3'],
      ingressClasses: ['alb'],
      serviceAccountIrsa: [],
    },
    aws: { available: true, s3Buckets: [], sqsQueues: [], cwLogGroups: [], region: 'us-east-1' },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
    probeLog: [],
    ...overrides,
  };
}

function richSnapshot(): DiscoverySnapshot {
  // Snapshot with all the infra the streamer needs.
  return baseSnapshot({
    kubectl: {
      ...baseSnapshot().kubectl,
      serviceAccountIrsa: [
        {
          namespace: 'demo',
          name: 'tenx-streamer',
          roleArn: 'arn:aws:iam::111:role/tenx-demo-streamer',
        },
      ],
    },
    recommendations: {
      suggestedNamespace: 'logging',
      alreadyInstalled: {},
      streamerS3Bucket: 'tenx-demo-streamer-111',
      streamerSqsUrls: {
        index: 'https://sqs.us-east-1.amazonaws.com/111/tenx-demo-streamer-index-queue',
        query: 'https://sqs.us-east-1.amazonaws.com/111/tenx-demo-streamer-query-queue',
        subquery: 'https://sqs.us-east-1.amazonaws.com/111/tenx-demo-streamer-subquery-queue',
        stream: 'https://sqs.us-east-1.amazonaws.com/111/tenx-demo-streamer-stream-queue',
      },
    },
  });
}

test('plan blocks when api_key is missing', async () => {
  const plan = await buildStreamerPlan({ snapshot: richSnapshot() });
  assert.ok(plan.blockers.some((b) => b.toLowerCase().includes('license key')));
});

test('plan blocks when input bucket is missing from snapshot + args', async () => {
  const plan = await buildStreamerPlan({ snapshot: baseSnapshot(), apiKey: 'x' });
  assert.ok(
    plan.blockers.some((b) => b.toLowerCase().includes('input s3 bucket')),
    `expected input-bucket blocker; got: ${plan.blockers.join(' | ')}`
  );
});

test('plan blocks when any SQS queue URL is missing', async () => {
  const plan = await buildStreamerPlan({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        alreadyInstalled: {},
        streamerS3Bucket: 'bucket',
        streamerSqsUrls: { index: 'url', query: 'url' }, // missing subquery + stream
      },
      kubectl: {
        ...baseSnapshot().kubectl,
        serviceAccountIrsa: [{ namespace: 'demo', name: 'tenx-streamer', roleArn: 'arn' }],
      },
    }),
    apiKey: 'x',
  });
  assert.ok(
    plan.blockers.some((b) => b.toLowerCase().includes('subquery') && b.toLowerCase().includes('stream')),
    `expected SQS blocker listing subquery+stream; got: ${plan.blockers.join(' | ')}`
  );
});

test('plan blocks when IRSA role is missing', async () => {
  const plan = await buildStreamerPlan({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        alreadyInstalled: {},
        streamerS3Bucket: 'bucket',
        streamerSqsUrls: {
          index: 'url',
          query: 'url',
          subquery: 'url',
          stream: 'url',
        },
      },
    }),
    apiKey: 'x',
  });
  assert.ok(
    plan.blockers.some((b) => b.toLowerCase().includes('irsa')),
    `expected IRSA blocker; got: ${plan.blockers.join(' | ')}`
  );
});

test('rich snapshot + api_key produces a no-blocker plan', async () => {
  const plan = await buildStreamerPlan({ snapshot: richSnapshot(), apiKey: 'test' });
  assert.equal(plan.blockers.length, 0, `expected zero blockers; got: ${plan.blockers.join(' | ')}`);
  assert.ok(plan.install.length >= 4, 'install should have ≥4 steps');
  assert.ok(plan.verify.length >= 3, 'verify should have ≥3 probes');
  assert.ok(plan.teardown.length >= 3, 'teardown should have ≥3 steps');
});

test('values file wires all four SQS queues + IRSA role + buckets', async () => {
  const plan = await buildStreamerPlan({ snapshot: richSnapshot(), apiKey: 'test' });
  const values = plan.install.find((s) => s.file)?.file?.contents;
  assert.ok(values, 'install should have a file-write step with contents');
  assert.ok(values!.includes('indexQueueUrl:'), 'values should include indexQueueUrl');
  assert.ok(values!.includes('queryQueueUrl:'), 'values should include queryQueueUrl');
  assert.ok(values!.includes('subQueryQueueUrl:'), 'values should include subQueryQueueUrl');
  assert.ok(values!.includes('streamQueueUrl:'), 'values should include streamQueueUrl');
  assert.ok(values!.includes('eks.amazonaws.com/role-arn:'), 'values should include IRSA annotation');
  assert.ok(values!.includes('inputBucket:'), 'values should include inputBucket');
  assert.ok(values!.includes('indexBucket:'), 'values should include indexBucket');
  assert.ok(values!.includes('indexing-results/'), 'indexBucket should default to /indexing-results/');
});

test('explicit args override snapshot-detected values', async () => {
  const plan = await buildStreamerPlan({
    snapshot: richSnapshot(),
    apiKey: 'test',
    inputBucket: 'custom-bucket',
    irsaRoleArn: 'arn:aws:iam::222:role/custom',
    sqsUrls: {
      index: 'https://custom/index',
      query: 'https://custom/query',
      subquery: 'https://custom/subquery',
      stream: 'https://custom/stream',
    },
  });
  const values = plan.install.find((s) => s.file)?.file?.contents ?? '';
  assert.ok(values.includes('custom-bucket'));
  assert.ok(values.includes('arn:aws:iam::222:role/custom'));
  assert.ok(values.includes('https://custom/index'));
});

test('alreadyInstalled.streamer triggers a note (not a blocker)', async () => {
  const plan = await buildStreamerPlan({
    snapshot: {
      ...richSnapshot(),
      recommendations: {
        ...richSnapshot().recommendations,
        alreadyInstalled: { streamer: 'demo' },
      },
    },
    apiKey: 'test',
  });
  assert.equal(plan.blockers.length, 0);
  assert.ok(plan.notes.some((n) => n.toLowerCase().includes('streamer') && n.includes('`demo`')));
});

test('plan.app is always "streamer"', async () => {
  const plan = await buildStreamerPlan({ snapshot: richSnapshot(), apiKey: 'test' });
  assert.equal(plan.app, 'streamer');
});

test('teardown does not touch AWS infra (Terraform concern)', async () => {
  const plan = await buildStreamerPlan({ snapshot: richSnapshot(), apiKey: 'test' });
  const teardownText = JSON.stringify(plan.teardown);
  // The optional AWS teardown step is a commented-out terraform reference,
  // NOT aws-cli delete calls. Assert no aws-cli delete verbs appear.
  assert.ok(!/aws\s+s3\s+rb|aws\s+sqs\s+delete-queue|aws\s+iam\s+delete-role/.test(teardownText),
    `teardown must not invoke destructive AWS CLI verbs; got: ${teardownText.slice(0, 400)}`);
});
