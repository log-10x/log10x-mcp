/**
 * Coverage for the serverless (Lambda + OTel extension) estate path:
 *
 *   1. lambdaOtelExtensionRecipe emits the three-part pairing (collector
 *      splice, engine env, execution-environment declaration) with the
 *      loopback ports, the routeState routing, and the airgapped guard.
 *   2. lambdaEstateCdkConstruct emits the read-modify-write Coralogix
 *      custom resource (never a blind PUT) and the CreateLogGroup
 *      auto-subscription rule.
 *   3. executeAdviseInstall branches to the serverless plan when the
 *      snapshot says estateShape='serverless' — the advice path is no
 *      longer k8s-gated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lambdaOtelExtensionRecipe } from '../src/lib/offload-recipes.js';
import { lambdaEstateCdkConstruct } from '../src/lib/cdk-recipes.js';
import { putSnapshot } from '../src/lib/discovery/snapshot-store.js';
import { SNAPSHOT_SCHEMA_VERSION, type DiscoverySnapshot } from '../src/lib/discovery/types.js';
import { executeAdviseInstall } from '../src/tools/advise-install.js';
import type { Environments } from '../src/lib/environments.js';

test('lambdaOtelExtensionRecipe: three parts, loopback pairing, routeState routing', () => {
  const r = lambdaOtelExtensionRecipe({ region: 'us-east-1', bucket: 'acme-offload' });

  // collector splice: both loopback hops + routing on the log attribute
  assert.ok(r.collector.body.includes('127.0.0.1:4317'));
  assert.ok(r.collector.body.includes('127.0.0.1:24225'));
  assert.ok(r.collector.body.includes('attributes["routeState"] == "offload"'));
  assert.ok(r.collector.body.includes('context: log'));
  // the Coralogix path folds the record into a body object so the proven
  // $d.routeState dpxl mechanism applies
  assert.ok(r.collector.body.includes('transform/tenx-fold'));
  assert.ok(r.collector.body.includes('acme-offload'));

  // engine env: offload marker + hash + the airgapped guard
  assert.ok(r.engine.body.includes('outputOffload=true'));
  assert.ok(r.engine.body.includes('symbolMessageHashField=tenx_hash'));
  assert.ok(r.engine.body.includes('TENX_AIRGAPPED=true'));

  // execution environment: extensions-api lifecycle, shutdown drain warning
  assert.ok(r.executionEnvironment.body.includes('/2020-01-01/extension/register'));
  assert.ok(r.executionEnvironment.body.includes('SHUTDOWN'));
  assert.ok(/not published/i.test(r.executionEnvironment.prerequisites.join(' ')));
});

test('lambdaOtelExtensionRecipe: no bucket -> offload pipeline stays commented', () => {
  const r = lambdaOtelExtensionRecipe({ region: 'us-east-1' });
  assert.ok(r.collector.body.includes('# logs/tenx-offload'));
  assert.ok(!r.collector.body.includes('s3_bucket: undefined'));
});

test('lambdaEstateCdkConstruct: read-modify-write TCO + CreateLogGroup rule', () => {
  const cdk = lambdaEstateCdkConstruct({ region: 'us-east-1', coralogixRegion: 'us2' });
  // the real endpoint on the REGIONAL host, and merge-by-name (no blind PUT)
  assert.ok(cdk.body.includes('/mgmt/openapi'));
  assert.ok(cdk.body.includes('log-policies/v1'));
  assert.ok(cdk.body.includes('replaces the ENTIRE ordered policy list'));
  assert.ok(cdk.body.includes('.filter(p => (p.policy || p).name !== process.env.POLICY_NAME)'));
  // CloudWatch remainder: per-group subscription + new-group rule
  assert.ok(cdk.body.includes('SubscriptionFilter'));
  assert.ok(cdk.body.includes("eventName: ['CreateLogGroup']"));
  // engine env travels with attach()
  assert.ok(cdk.body.includes("addEnvironment('TENX_AIRGAPPED', 'true')"));
});

function serverlessSnapshot(id: string): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kubectl: {
      available: false,
      error: 'no cluster',
      namespaces: [],
      probedNamespaces: [],
      forwarders: [],
      helmReleases: [],
      log10xApps: [],
      storageClasses: [],
      ingressClasses: [],
      serviceAccountIrsa: [],
      backendAgents: [],
    },
    aws: {
      available: true,
      region: 'us-east-1',
      s3Buckets: [],
      sqsQueues: [],
      cwLogGroups: [
        { name: '/aws/lambda/checkout', subscriptionFilters: [] },
      ],
      lambda: {
        available: true,
        truncated: false,
        functionsWithOtelExtension: 3,
        functions: [],
      },
    },
    recommendations: {
      suggestedNamespace: 'logging',
      alreadyInstalled: {},
      estateShape: 'serverless',
      existingForwarder: 'otel-collector',
      serverless: {
        functionCount: 4,
        functionsWithOtelExtension: 3,
        logGroupsSubscribed: 0,
        logGroupsUnsubscribed: 1,
      },
    },
    probeLog: [],
  };
}

test('advise_install: serverless snapshot short-circuits the k8s wizard', async () => {
  const snap = serverlessSnapshot('snap-serverless-test');
  putSnapshot(snap);
  const out = await executeAdviseInstall(
    { snapshot_id: 'snap-serverless-test', license_source: 'signin' },
    {} as Environments
  );
  const data = out.data as Record<string, unknown>;
  assert.equal(data.mode, 'serverless_plan');
  assert.equal(data.ok, true);
  assert.equal(data.function_count, 4);
  const md = String(data.markdown);
  assert.ok(md.includes('127.0.0.1:4317'));
  assert.ok(md.includes('CoralogixTcoPolicies') || md.includes('coralogixMonitoringRecipe'));
  // no helm anywhere on this path
  assert.ok(!/helm upgrade/i.test(md));
});
