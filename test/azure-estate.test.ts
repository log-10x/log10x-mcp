/**
 * Coverage for the Azure serverless (Function Apps, no process slot) path:
 *
 *   1. azureStreamsRecipe emits the CERTIFIED collector settings — the three
 *      measured traps (format mismatch, bytes-body decode, checkpoint
 *      replay) are pinned so a regression cannot ship a config that
 *      silently collapses every event to one pattern identity.
 *   2. executeAdviseInstall branches to the stream-topology plan when the
 *      snapshot says estateShape='azure_serverless' — no helm, no Lambda
 *      extension, and the honest platform constraints stated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { azureStreamsRecipe } from '../src/lib/offload-recipes.js';
import { putSnapshot } from '../src/lib/discovery/snapshot-store.js';
import { SNAPSHOT_SCHEMA_VERSION, type DiscoverySnapshot } from '../src/lib/discovery/types.js';
import { executeAdviseInstall } from '../src/tools/advise-install.js';
import type { Environments } from '../src/lib/environments.js';

test('azureStreamsRecipe: the certified collector settings are pinned', () => {
  const r = azureStreamsRecipe({ eventHubNamespace: 'acme-hub-ns' });

  // loopback pairing, same as every other topology
  assert.ok(r.collector.body.includes('127.0.0.1:4317'));
  assert.ok(r.collector.body.includes('127.0.0.1:24225'));
  assert.ok(r.collector.body.includes('attributes["routeState"] == "offload"'));
  assert.ok(r.collector.body.includes('context: log'));

  // measured trap 1: format must match the hub's payload
  assert.ok(r.collector.body.includes('format: azure'));
  assert.ok(
    r.collector.prerequisites.some((p) => p.includes("'raw' for application logs")),
    'the format distinction must be a stated prerequisite'
  );

  // measured trap 2: bytes body collapses every event to one identity
  assert.ok(
    r.collector.body.includes('Decode(log.body, "utf-8")'),
    'the decode transform must ship in the config'
  );
  assert.ok(
    !r.collector.body.includes('String(log.body)'),
    'String() is the measured wrong fix (yields base64) and must not appear'
  );

  // measured trap 3: checkpoint or replay
  assert.ok(r.collector.body.includes('storage: file_storage'));
  assert.ok(r.collector.body.includes('replays the retention window'));

  // the certification itself is a stated prerequisite, not folklore
  assert.ok(r.collector.prerequisites.some((p) => p.includes('CERTIFIED against a live Event Hub')));

  // honesty rails
  assert.ok(
    r.hub.prerequisites.some((p) => p.includes('already emitted, transported, and billed')),
    'the topology must state what it gives up vs edge regulation'
  );
  assert.ok(
    r.engine.prerequisites.some((p) => p.includes('write-only')),
    'offload without fetch-back must be stated'
  );

  // discovered namespace threads into the hub commands
  assert.ok(r.hub.body.includes('acme-hub-ns'));
});

function azureSnapshot(id: string): DiscoverySnapshot {
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
      available: false,
      error: 'not configured',
      s3Buckets: [],
      sqsQueues: [],
      cwLogGroups: [],
    },
    azure: {
      available: true,
      subscriptionId: 'sub-123',
      tenantId: 'tenant-123',
      functionApps: [
        { name: 'checkout-fn', kind: 'functionapp' },
        { name: 'payments-fn', kind: 'functionapp,linux' },
      ],
      containerAppCount: 1,
      eventHubNamespaces: ['acme-hub-ns'],
    },
    recommendations: {
      suggestedNamespace: 'logging',
      alreadyInstalled: {},
      estateShape: 'azure_serverless',
      azureServerless: {
        functionAppCount: 2,
        containerAppCount: 1,
        eventHubNamespaceCount: 1,
      },
    },
    probeLog: [],
  };
}

test('advise_install: azure_serverless snapshot short-circuits to the stream plan', async () => {
  const snap = azureSnapshot('snap-azure-test');
  putSnapshot(snap);
  const out = await executeAdviseInstall(
    { snapshot_id: 'snap-azure-test', license_source: 'signin' },
    {} as Environments
  );
  const data = out.data as Record<string, unknown>;
  assert.equal(data.mode, 'azure_serverless_plan');
  assert.equal(data.ok, true);
  assert.equal(data.function_app_count, 2);
  assert.equal(data.container_app_count, 1);

  const md = String(data.markdown);
  // the certified pairing and the discovered namespace both surface
  assert.ok(md.includes('127.0.0.1:4317'));
  assert.ok(md.includes('Decode(log.body, "utf-8")'));
  assert.ok(md.includes('acme-hub-ns'));
  // no helm and no Lambda-extension plan on this path
  assert.ok(!/helm upgrade/i.test(md));
  assert.ok(!md.includes('TENX_RECEIVE_MUTE_S3_URI'));
});
