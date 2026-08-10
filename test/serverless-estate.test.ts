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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pocFromLocalSchema } from '../src/tools/poc-from-local.js';
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
  // the fold serves the OFFLOAD slice (awss3 marshaler: body needs tenx_hash
  // in the body); the TCO policy matches the NESTED keypath — measured live,
  // the OTLP exporter wraps records under logRecord and a flat $d.routeState
  // compiles to "keypath does not exist" and tiers nothing
  assert.ok(r.collector.body.includes('transform/tenx-fold'));
  assert.ok(
    r.collector.placementNote.includes('$d.logRecord.attributes.routeState'),
    'placement note must carry the nested keypath this path requires'
  );
  assert.ok(
    r.collector.prerequisites.some((p) => p.includes('$d.logRecord.attributes.routeState')),
    'prerequisites must state the nested policy keypath'
  );
  assert.ok(
    !r.collector.prerequisites.some((p) => /dpxl[^]*?<v1> \$d\.routeState ==/.test(p)),
    'the flat keypath must not be presented as the policy expression on this path'
  );
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
  assert.ok(cdk.body.includes('.filter(p => p.name !== process.env.POLICY_NAME)'));
  // The PUT contract, measured live on the v5 API: GET entries are flat and
  // must be TRANSLATED (a verbatim re-PUT 400s on "unknown field id"), and
  // logRules sits BESIDE policy in each item, never inside it.
  assert.ok(cdk.body.includes('function toPutItem'));
  assert.ok(cdk.body.includes('logRules: { dpxlExpression:'));
  // the nested keypath — the flat $d.routeState tiers nothing on this path
  assert.ok(cdk.body.includes('$d.logRecord.attributes.routeState'));
  assert.ok(!cdk.body.includes('"<v1> $d.routeState'));
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

/**
 * The MCP boundary itself, not the tool function below it.
 *
 * Measured 2026-08-10 by driving the real server over stdio in a no-egress
 * container: `log10x_poc_from_local` advertised `paths` in its schema, the
 * agent sent it, and the tool answered "source file requires paths" — the
 * hand-written destructure in the registration dropped it. That made the
 * serverless / no-cluster POC path unreachable through the MCP interface,
 * and the unit suite could not see it because every other test calls
 * executePocFromLocal() directly, below the boundary that lost the field.
 *
 * This pins the registration against its own schema: every property the
 * tool advertises must be threaded, or a future hand-written destructure
 * silently drops another one.
 */
test('poc_from_local registration threads every advertised schema key', async () => {
  // Tests run from test-build/, so resolve the source through cwd rather
  // than import.meta.url (which points into the build output).
  const src = await readFile(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  const start = src.indexOf("registerLog10xTool('log10x_poc_from_local'");
  assert.ok(start > 0, 'registration not found');
  const block = src.slice(start, src.indexOf('registerLog10xTool(', start + 10));

  const advertised = Object.keys(pocFromLocalSchema);
  const missing = advertised.filter((key) => !new RegExp(`\\b${key}\\s*:`).test(block));

  assert.deepEqual(
    missing,
    [],
    `these schema keys are advertised but never passed through the registration: ${missing.join(', ')}`
  );
});
