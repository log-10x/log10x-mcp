/**
 * The Azure branch of the advise-retriever wizard.
 *
 * The acceptance run reached a plan whose step 1 was never literally
 * runnable: `<aks-cluster-name>` had no argument behind it, the resource group
 * and the region were in the schema but never asked for, and the question that
 * asks for the workload-identity pair said the provisioning script prints both
 * ids. It writes them into the values file it produces instead.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  executeAdviseRetriever,
  _setResolveClusterConfigForTests,
} from '../../src/tools/advise-retriever.js';
import { putSnapshot, _clearSnapshotStore } from '../../src/lib/discovery/snapshot-store.js';
import type { DiscoverySnapshot } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';
import type { ClusterConfigResolveResult } from '../../src/lib/env-config/resolve-cluster-config.js';

const TEST_STATE_DIR = join(tmpdir(), `retriever-azure-wizard-${randomUUID()}`);
process.env.LOG10X_ADVISOR_STATE_DIR = TEST_STATE_DIR;

const NAMESPACE = 'logging';
const RELEASE = 'my-retriever';
const PASTED_JWT = 'eyJwYXN0ZWQiOiJieS10aGUtY2FsbGVyIn0';

function freshId(): string {
  return `disc-azwiz-${randomUUID()}`;
}

function aksSnap(id: string): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    startedAt: '2026-09-13T00:00:00Z',
    finishedAt: '2026-09-13T00:00:10Z',
    kubectl: {
      available: true,
      context: 'tenx-aks',
      namespaces: [NAMESPACE],
      probedNamespaces: [NAMESPACE],
      forwarders: [],
      helmReleases: [],
      log10xApps: [],
      storageClasses: [],
      ingressClasses: [],
      backendAgents: [],
      serviceAccountIrsa: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    azure: {
      available: true,
      subscriptionId: 'sub-1',
      tenantId: 'tenant-1',
      functionApps: [],
      containerAppCount: 0,
      eventHubNamespaces: [],
    },
    recommendations: { suggestedNamespace: NAMESPACE, alreadyInstalled: {} },
    probeLog: [],
  };
}

/** No env-config doc anywhere, so the wizard reads only what the test passes. */
function noEnvConfig(): () => Promise<ClusterConfigResolveResult> {
  return async () => ({
    ok: false,
    error: 'no env-config doc in any store (test)',
    resolution_warnings: [],
    resolution_trace: [{ source: 'store:local', status: 'skipped', reason: 'no doc (test)' }],
  });
}

function data(out: object): Record<string, unknown> {
  return (out as { data: Record<string, unknown> }).data;
}

const PLACEMENT = {
  resource_group: 'tenx-rg',
  location: 'eastus',
  aks_cluster_name: 'tenx-aks',
  namespace: NAMESPACE,
};

const STORAGE = {
  storage_account: 'tenxlogs',
  input_container: 'logs',
};

const IDENTITY = {
  azure_client_id: '11111111-1111-1111-1111-111111111111',
  azure_tenant_id: '22222222-2222-2222-2222-222222222222',
};

beforeEach(() => {
  _clearSnapshotStore();
  _setResolveClusterConfigForTests(noEnvConfig());
});

afterEach(() => {
  _setResolveClusterConfigForTests(undefined);
});

test('azure wizard asks where the resources go before anything else', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const d = data(out);
  assert.equal(d.mode, 'next_question');
  assert.equal(d.question_id, 'azure-placement');
  const shape = d.shape as { type: string; fields: Array<{ name: string; required: boolean }> };
  assert.equal(shape.type, 'form');
  const fields = shape.fields.map((f) => f.name);
  for (const expected of ['resource_group', 'location', 'aks_cluster_name', 'namespace']) {
    assert.ok(fields.includes(expected), `placement form missing ${expected}; got: ${fields.join(', ')}`);
  }
});

// ── P3: the namespace the provisioning command carries is asked for ─────────

test('the placement form asks for the namespace the provisioning command needs', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const d = data(out);
  assert.equal(d.question_id, 'azure-placement');
  const shape = d.shape as {
    fields: Array<{ name: string; required: boolean; default?: string; example?: string }>;
  };
  const ns = shape.fields.find((f) => f.name === 'namespace');
  assert.ok(ns, 'the placement form carries a namespace field');
  assert.equal(ns!.required, true, 'the namespace is required, not inferred silently');
  // The snapshot suggests one, so the field arrives pre-filled rather than blank.
  assert.equal(ns!.default, NAMESPACE, 'the suggested namespace is offered as the default');
  // The acceptance run had to run a command carrying a literal placeholder to
  // get the answer to the next question.
  const md = d.markdown as string;
  assert.ok(md.includes('--namespace <namespace>'), 'the command still shows the gap being asked about');
  assert.ok(
    md.includes('system:serviceaccount:<namespace>:<release>'),
    'the question says what the namespace binds to',
  );
});

test('the placement answer removes the namespace placeholder from every later command', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    ...PLACEMENT,
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const md = data(out).markdown as string;
  assert.ok(!md.includes('<namespace>'), `a namespace placeholder is still printed:\n${md}`);
  assert.ok(md.includes(`--namespace ${NAMESPACE}`), 'the answered namespace is in the command');
});

// ── P6: storage account names are globally unique ───────────────────────────

test('the storage-account question says the name is global and how to test it', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    ...PLACEMENT,
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const d = data(out);
  assert.equal(d.question_id, 'azure-storage-account');
  const md = d.markdown as string;
  assert.ok(/globally unique/i.test(md), `the question never says the name is global:\n${md}`);
  assert.ok(
    md.includes('az storage account check-name'),
    'the question gives the command that tests a candidate name',
  );
  const shape = d.shape as { example?: string; description?: string };
  // `tenxlogs` is the name the acceptance run tried first, and it collided.
  assert.notEqual(shape.example, 'tenxlogs', 'the example is no longer a name anyone would collide on');
  assert.ok(/globally unique/i.test(shape.description ?? ''), 'the shape description says so too');
});

test('azure wizard moves to the storage account once placement is answered', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    ...PLACEMENT,
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const d = data(out);
  assert.equal(d.question_id, 'azure-storage-account');
  // The provisioning command printed under this question is now runnable as
  // printed: placement came first, so nothing in it is a placeholder.
  const md = d.markdown as string;
  assert.ok(md.includes('--resource-group tenx-rg'), 'the resource group is in the command');
  assert.ok(md.includes('--create-aks tenx-aks'), 'the cluster name is in the command');
  assert.ok(!md.includes('<aks-cluster-name>'), 'no cluster placeholder is left');
});

test('the workload-identity question says where the two ids are written', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    ...PLACEMENT,
    ...STORAGE,
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const d = data(out);
  assert.equal(d.question_id, 'azure-workload-identity');
  const md = d.markdown as string;
  assert.ok(
    md.includes('Neither id is printed'),
    `the question still claims the script prints them:\n${md}`,
  );
  assert.ok(
    md.includes(`${RELEASE}-azure-provisioned.yaml`),
    'the question names the file the script writes them into',
  );
  assert.ok(md.includes('storage.azure.auth'), 'the question names the block they sit in');
});

test('the azure wizard emits a plan once every answer is in', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    ...PLACEMENT,
    ...STORAGE,
    ...IDENTITY,
    action: 'install',
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const d = data(out);
  assert.equal(d.mode, 'plan', `expected a plan; got ${String(d.mode)}: ${String(d.markdown).slice(0, 300)}`);
  assert.deepEqual(d.blockers, []);
  const md = d.markdown as string;
  assert.ok(md.includes('--create-aks tenx-aks'), 'the plan provisions the named cluster');
  assert.ok(md.includes('az aks get-credentials'), 'the plan points kubectl at the cluster');
  assert.ok(md.includes(`fullnameOverride: "${RELEASE}"`), 'the values file carries the override');
  assert.ok(md.includes('-l app=retriever-10x'), 'the kubectl selector matches the chart');
  for (const forbidden of ['s3://', 'aws s3', 'terraform']) {
    assert.ok(!md.toLowerCase().includes(forbidden), `the azure plan mentions "${forbidden}"`);
  }
});

test('a pasted licence reaches the values file and a minted one would not', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    ...PLACEMENT,
    ...STORAGE,
    ...IDENTITY,
    action: 'install',
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  const md = data(out).markdown as string;
  assert.ok(md.includes(`log10xApiKey: "${PASTED_JWT}"`), 'the caller\'s own key is wired in');
  // One copy, in the chart key that reads it. The second copy lived in a
  // `tenx:` block the published chart has no key for.
  assert.equal(md.split(PASTED_JWT).length - 1, 1, 'the key appears once');
});

test('aks_cluster_name is a known argument', async () => {
  const id = freshId();
  putSnapshot(aksSnap(id));

  const out = await executeAdviseRetriever({
    snapshot_id: id,
    storage_provider: 'azure',
    aks_cluster_name: 'tenx-aks',
    license_source: 'paste',
    license_jwt_paste: PASTED_JWT,
  } as Parameters<typeof executeAdviseRetriever>[0]);

  assert.notEqual(data(out).mode, 'unknown_args');
});
