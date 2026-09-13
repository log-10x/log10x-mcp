/**
 * Azure Blob as an offload destination, across every surface that reads it.
 *
 * Before this, `azure_blob` was a dead enum: log10x_offload_add stored the
 * string, and the retriever probe, the offload-delivery verifier and doctor
 * all shelled out to `aws s3api` and then reported a missing IAM policy. The
 * cases below pin the three properties that fix has to keep:
 *
 *   1. The read path addresses a blob container, not a bucket.
 *   2. No blob-destination message mentions IAM.
 *   3. The WRITE path stays absent and says so. A generated `aws_s3` sink
 *      under a warning is still a generated `aws_s3` sink.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  objectStoreTargetFrom,
  storeUri,
  storeListCommand,
  storeReadAccessRemedy,
  type ObjectStoreTarget,
} from '../src/lib/object-store.js';
import {
  runRetrieverProbe,
  AZURE_BLOB_REMEDIES,
  type ProbeDeps,
} from '../src/lib/retriever-probe.js';
import {
  verifyOffloadDelivery,
  type OffloadDeliveryDeps,
  type S3ObjectMeta,
} from '../src/lib/offload-delivery.js';
import { offloadDeliveryFixes } from '../src/tools/doctor.js';
import {
  renderOffloadSection,
  azureBlobOffloadUnavailable,
} from '../src/lib/offload-recipes.js';
import { buildRetrieverPlan } from '../src/lib/advisor/retriever.js';
import { executeOffloadAdd } from '../src/tools/offload-manage.js';
import type { EnvConfigStore } from '../src/lib/env-config/store-interface.js';
import type { EnvironmentConfig } from '../src/lib/env-config/types.js';
import type { DiscoverySnapshot } from '../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/lib/discovery/types.js';

const ACCOUNT = 'tenxlogs';
const CONTAINER = 'rawlogs';
const BLOB: ObjectStoreTarget = {
  kind: 'azure_blob',
  container: CONTAINER,
  storageAccount: ACCOUNT,
};
const BLOB_URI = `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/`;

/** Every phrase that would send an Azure operator to a control they do not have. */
const IAM_WORDS = /\bIAM\b|IRSA|s3:[A-Za-z]|arn:aws|s3:\/\//;

function assertNoIamVocabulary(text: string, where: string): void {
  assert.ok(!IAM_WORDS.test(text), `${where} leaks AWS IAM vocabulary: ${text}`);
}

// ── object-store target + addressing ───────────────────────────────────────

test('objectStoreTargetFrom maps an azure_blob destination onto account + container', () => {
  const target = objectStoreTargetFrom({
    type: 'azure_blob',
    bucket: CONTAINER,
    storage_account: ACCOUNT,
  });
  assert.deepEqual(target, { kind: 'azure_blob', container: CONTAINER, storageAccount: ACCOUNT });
  assert.equal(storeUri(target!), BLOB_URI);
  assert.match(storeListCommand(target!), /^az storage blob list /);
  assert.ok(storeListCommand(target!).includes(`--account-name ${ACCOUNT}`));
  assert.ok(storeListCommand(target!).includes('--auth-mode login'));
});

test('objectStoreTargetFrom leaves s3 alone and declines gcs / file', () => {
  assert.deepEqual(objectStoreTargetFrom({ type: 's3', bucket: 'b' }), {
    kind: 's3',
    container: 'b',
  });
  assert.equal(objectStoreTargetFrom({ type: 'gcs', bucket: 'b' }), undefined);
  assert.equal(objectStoreTargetFrom({ type: 'file', bucket: 'b' }), undefined);
  // A destination with no type at all is the historical S3 shape.
  assert.deepEqual(objectStoreTargetFrom(undefined, 'legacy'), { kind: 's3', container: 'legacy' });
});

test('storeReadAccessRemedy names blob roles for Azure and IAM only for S3', () => {
  const azure = storeReadAccessRemedy(BLOB);
  assert.ok(azure.includes('Storage Blob Data Reader'));
  assert.ok(azure.includes('az login'));
  assert.ok(azure.includes('AZURE_STORAGE_KEY'));
  assertNoIamVocabulary(azure, 'azure read remedy');

  const s3 = storeReadAccessRemedy({ kind: 's3', container: 'b' });
  assert.ok(s3.includes('s3:ListBucket'), 'the S3 branch keeps its own wording');
});

// ── retriever probe ────────────────────────────────────────────────────────

function probeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    listObjects: async () => [],
    kubectlLogs: async () => 'pipeline started',
    sqsDepths: async () => ({}),
    sqsListQueues: async () => [],
    kubectlGetPod: async () => ({ name: 'retriever-0', ready: true, observed: 'Ready' }),
    cwFilterLogEvents: async () => [],
    pickTopHash: async () => ({ status: 'ok', hash: 'abc123' }),
    submitRetrieverQuery: async () => ({
      queryId: 'q1',
      eventsMatched: 1,
      eventsReturned: 1,
    }),
    ...over,
  };
}

const PROBE_ARGS = {
  namespace: 'log10x',
  offload_bucket: CONTAINER,
  input_bucket: 'tenx-index',
  query_log_group: 'log10x-retriever-query-events',
  store_kind: 'azure_blob' as const,
  storage_account: ACCOUNT,
  target_hash: 'abc123',
};

test('probe reports blob-container facts when the destination is azure_blob', async () => {
  const result = await runRetrieverProbe(
    PROBE_ARGS,
    probeDeps({
      listObjects: async () => [
        { Key: 'app/2026/09/12/part-0.jsonl', LastModified: new Date().toISOString(), Size: 12 },
      ],
    }),
  );
  const offload = result.asserts.find((a) => a.name === 'offload_bucket_has_recent_data');
  assert.ok(offload, 'offload assert present');
  assert.ok(offload!.pass, `expected pass, observed: ${offload!.observed}`);
  assert.ok(offload!.observed.includes(BLOB_URI), `observed names the blob URI: ${offload!.observed}`);
  assert.ok(offload!.observed.includes('blob(s)'), 'observed counts blobs, not objects');
  assertNoIamVocabulary(offload!.observed, 'probe offload observed');
});

test('probe blames the blob data plane, never IAM, when the listing fails', async () => {
  const result = await runRetrieverProbe(
    PROBE_ARGS,
    probeDeps({
      listObjects: async () => {
        throw new Error('AuthorizationPermissionMismatch');
      },
    }),
  );
  assert.equal(result.verdict, 'broken');
  const offload = result.asserts.find((a) => a.name === 'offload_bucket_has_recent_data');
  assert.ok(!offload!.pass);
  assert.ok(offload!.observed.includes('Storage Blob Data Reader'));
  assert.equal(offload!.remedy, AZURE_BLOB_REMEDIES.offload_bucket_has_recent_data);
  assertNoIamVocabulary(offload!.observed, 'probe list-failure observed');
  assertNoIamVocabulary(offload!.remedy!, 'probe list-failure remedy');
});

test('probe keeps the S3 wording when the destination is s3', async () => {
  const result = await runRetrieverProbe(
    { ...PROBE_ARGS, store_kind: 's3', storage_account: undefined },
    probeDeps({
      listObjects: async () => [
        { Key: 'app/part-0.jsonl', LastModified: new Date().toISOString(), Size: 9 },
      ],
    }),
  );
  const offload = result.asserts.find((a) => a.name === 'offload_bucket_has_recent_data');
  assert.ok(offload!.observed.includes(`s3://${CONTAINER}/`));
  assert.ok(offload!.observed.includes('object(s)'));
});

// ── offload-delivery verifier ──────────────────────────────────────────────

const NOW = 1_750_000_000_000;
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function deliveryDeps(opts: {
  objects: S3ObjectMeta[];
  bodies?: Record<string, string>;
  stamped?: number | null;
  listThrows?: string;
}): OffloadDeliveryDeps {
  return {
    async listObjects() {
      if (opts.listThrows) throw new Error(opts.listThrows);
      return opts.objects;
    },
    async getObject(_container, key) {
      return opts.bodies?.[key] ?? '';
    },
    async stampedOffloadBytes() {
      return opts.stamped ?? null;
    },
  };
}

const DELIVERY_ARGS = {
  bucket: CONTAINER,
  prefix: 'app/',
  recencyMinutes: 30,
  sampleObjects: 3,
  nowMs: NOW,
  storeKind: 'azure_blob' as const,
  storageAccount: ACCOUNT,
};

test('delivery verifier names the blob endpoint on a verified Azure sink', async () => {
  const r = await verifyOffloadDelivery(
    DELIVERY_ARGS,
    deliveryDeps({
      objects: [{ Key: 'app/a.jsonl', Size: 100, LastModified: minsAgo(1) }],
      bodies: { 'app/a.jsonl': JSON.stringify({ routeState: 'offload' }) + '\n' },
      stamped: 4096,
    }),
  );
  assert.equal(r.verdict, 'verified');
  assert.ok(r.message.includes(`https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/app/`));
  assert.ok(!r.message.includes('s3://'), 'no s3:// URI for a blob container');
});

test('delivery verifier reports the blob role, never IAM, when the listing fails', async () => {
  const r = await verifyOffloadDelivery(
    DELIVERY_ARGS,
    deliveryDeps({ objects: [], listThrows: 'AuthorizationPermissionMismatch' }),
  );
  assert.equal(r.verdict, 'unverified');
  assert.ok(r.message.includes('Storage Blob Data Reader'));
  assertNoIamVocabulary(r.message, 'delivery unverified message');
});

test('delivery verifier still reports silent_loss against a blob container', async () => {
  const r = await verifyOffloadDelivery(
    DELIVERY_ARGS,
    deliveryDeps({ objects: [], stamped: 1024 }),
  );
  assert.equal(r.verdict, 'silent_loss');
  assert.ok(r.message.includes(`https://${ACCOUNT}.blob.core.windows.net/`));
});

test('delivery verifier keeps the s3:// URI when no store kind is passed', async () => {
  const r = await verifyOffloadDelivery(
    { bucket: 'tenx-bucket', prefix: 'app/', nowMs: NOW },
    deliveryDeps({ objects: [], stamped: 0 }),
  );
  assert.equal(r.verdict, 'idle');
  assert.ok(r.message.includes('s3://tenx-bucket/app/'));
});

// ── doctor ─────────────────────────────────────────────────────────────────

test('doctor offload_delivery fixes drop IAM vocabulary on a blob container', () => {
  const azure = offloadDeliveryFixes(BLOB);
  for (const [verdict, text] of Object.entries(azure)) {
    assertNoIamVocabulary(text!, `doctor fix ${verdict}`);
  }
  assert.ok(azure.unverified!.includes('Storage Blob Data Reader'));
  assert.ok(azure.silent_loss!.includes('Storage Blob Data Contributor'));
  // The write path does not exist, and the fix says so rather than pointing at
  // a recipe that would emit an S3 sink.
  assert.ok(azure.silent_loss!.includes('S3-compatible'));

  const s3 = offloadDeliveryFixes({ kind: 's3', container: 'b' });
  assert.ok(s3.unverified!.includes('s3:ListBucket'), 'the S3 branch is unchanged');
});

// ── recipes: the write path does not exist ─────────────────────────────────

test('renderOffloadSection returns the state of play for azure_blob and emits no sink', () => {
  const md = renderOffloadSection(
    {
      bucket: CONTAINER,
      region: 'eastus',
      prefix: 'app',
      destinationType: 'azure_blob',
      storageAccount: ACCOUNT,
    },
    'fluent-bit',
    'azure-monitor',
  );
  assert.ok(md.includes('Offload delivery to Azure Blob is not available.'));
  assert.ok(md.includes(BLOB_URI), 'the container the Retriever can already read is named');
  assert.ok(md.includes('S3-compatible'), 'the available alternative is named');
  // No config to paste, from any generator.
  assert.ok(!md.includes('aws_s3'), 'no S3 sink emitted');
  assert.ok(!md.includes('[sinks.'), 'no vector sink block');
  assert.ok(!md.includes('aws_iam_policy_document'), 'no forwarder-write Terraform');
  // No hedging, no apology.
  assert.ok(!/sorry|unfortunately|apolog/i.test(md));
});

test('azureBlobOffloadUnavailable falls back to a placeholder account', () => {
  const md = azureBlobOffloadUnavailable({ bucket: CONTAINER, region: '' });
  assert.ok(md.includes('<storage-account>'));
  assert.ok(md.includes('Offload delivery to Azure Blob is not available.'));
});

test('renderOffloadSection is unchanged for an s3 destination', () => {
  const md = renderOffloadSection(
    { bucket: 'tenx-bucket', region: 'us-east-1', prefix: 'app' },
    'vector',
    'datadog',
  );
  assert.ok(md.includes('aws_s3'), 'the S3 path still emits a sink');
  assert.ok(!md.includes('Offload delivery to Azure Blob'));
});

// ── advise: the AKS + Azure Blob install path ──────────────────────────────

function aksSnapshot(): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'disc-aks-1',
    startedAt: '2026-09-12T00:00:00Z',
    finishedAt: '2026-09-12T00:01:00Z',
    kubectl: {
      available: true,
      context: 'aks-tenx',
      namespaces: ['log10x'],
      probedNamespaces: ['log10x'],
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
    recommendations: { suggestedNamespace: 'log10x', alreadyInstalled: {} },
    probeLog: [],
  };
}

const AZURE_PLAN_ARGS = {
  snapshot: aksSnapshot(),
  licenseJwt: 'jwt-value',
  storageProvider: 'azure' as const,
  storageAccount: ACCOUNT,
  inputBucket: CONTAINER,
  resourceGroup: 'tenx-rg',
  location: 'eastus',
  azureClientId: 'client-1',
  azureTenantId: 'tenant-1',
  releaseName: 'my-retriever',
  namespace: 'log10x',
};

test('azure plan runs the provisioning script with every flag it needs', async () => {
  const plan = await buildRetrieverPlan(AZURE_PLAN_ARGS);
  assert.deepEqual(plan.blockers, [], `unexpected blockers: ${plan.blockers.join(' | ')}`);
  const provision = plan.install[0];
  assert.ok(provision, 'a provisioning step leads the plan');
  const cmd = provision!.commands.join('\n');
  assert.ok(cmd.includes('charts/retriever/scripts/azure/provision-retriever.sh'));
  for (const flag of [
    '--resource-group tenx-rg',
    '--location eastus',
    `--account ${ACCOUNT}`,
    '--create-aks',
    '--namespace log10x',
    '--release my-retriever',
    '--values-out',
  ]) {
    assert.ok(cmd.includes(flag), `provision command missing ${flag}`);
  }
});

test('azure plan emits storage.provider: azure values, never IRSA or SQS', async () => {
  const plan = await buildRetrieverPlan(AZURE_PLAN_ARGS);
  const valuesStep = plan.install.find((s) => s.file?.language === 'yaml');
  assert.ok(valuesStep, 'a values step is emitted');
  const values = valuesStep!.file!.contents;
  assert.ok(values.includes('provider: azure'));
  assert.ok(values.includes(`account: "${ACCOUNT}"`));
  assert.ok(values.includes(`inputContainer: "${CONTAINER}"`));
  assert.ok(values.includes(`indexContainer: "${ACCOUNT}/tenx-index/tenx"`));
  assert.ok(values.includes('invoke: queue'));
  assert.ok(values.includes('method: workloadIdentity'));
  assert.ok(values.includes('clientId: "client-1"'));
  assert.ok(values.includes('tenantId: "tenant-1"'));
  for (const q of ['tenx-index', 'tenx-query', 'tenx-subquery', 'tenx-stream']) {
    assert.ok(values.includes(`"${q}"`), `queue ${q} missing`);
  }
  assert.ok(!values.includes('eks.amazonaws.com/role-arn'), 'no IRSA annotation on AKS');
  assert.ok(!values.includes('QueueUrl'), 'no SQS URL keys on AKS');
  assert.ok(values.includes('scheduledQueries:\n  enabled: false'));
});

test('azure plan says the offload write path is absent and the read path is live', async () => {
  const plan = await buildRetrieverPlan(AZURE_PLAN_ARGS);
  assert.ok(plan.offloadMarkdown, 'offload markdown is emitted without an AWS region');
  assert.ok(plan.offloadMarkdown!.includes('Offload delivery to Azure Blob is not available.'));
  assert.ok(!plan.offloadMarkdown!.includes('aws_s3'));
  assert.ok(
    plan.notes.some((n) => n.includes('flat namespace')),
    'the hierarchical-namespace refusal is stated',
  );
  assert.ok(
    plan.notes.some((n) => n.includes('read and index side')),
    'the scope of Azure support is stated',
  );
});

test('azure plan blocks on a missing storage account and on missing workload identity', async () => {
  const noAccount = await buildRetrieverPlan({
    ...AZURE_PLAN_ARGS,
    storageAccount: undefined,
  });
  assert.ok(noAccount.blockers.some((b) => b.includes('storage_account')));

  const noIdentity = await buildRetrieverPlan({
    ...AZURE_PLAN_ARGS,
    azureClientId: undefined,
    azureTenantId: undefined,
  });
  assert.ok(noIdentity.blockers.some((b) => b.includes('azure_client_id')));
});

test('the aws plan path is untouched by the azure branch', async () => {
  const plan = await buildRetrieverPlan({
    snapshot: aksSnapshot(),
    licenseJwt: 'jwt-value',
    inputBucket: 'tenx-bucket',
    irsaRoleArn: 'arn:aws:iam::111:role/tenx',
    sqsUrls: { index: 'i', query: 'q', subquery: 's', stream: 'st' },
  });
  assert.deepEqual(plan.blockers, [], `unexpected blockers: ${plan.blockers.join(' | ')}`);
  const valuesStep = plan.install.find((s) => s.file?.language === 'yaml');
  assert.ok(valuesStep!.file!.contents.includes('eks.amazonaws.com/role-arn'));
  assert.ok(!valuesStep!.file!.contents.includes('provider: azure'));
});

// ── offload_add: storage_account reaches the document ──────────────────────

function memoryStore(seed: EnvironmentConfig): { store: EnvConfigStore; current: () => EnvironmentConfig } {
  let doc = seed;
  return {
    current: () => doc,
    store: {
      kind: 'local',
      async isAvailable() {
        return { available: true, reason: 'test' };
      },
      async read(idOrNickname: string) {
        return idOrNickname === doc.env_id || idOrNickname === doc.nickname ? doc : null;
      },
      async write(config: EnvironmentConfig) {
        doc = config;
      },
      async list() {
        return [doc];
      },
      async delete() {
        doc = seed;
      },
    },
  };
}

function seedEnv(): EnvironmentConfig {
  return {
    schema_version: '1.0',
    env_id: '11111111-1111-1111-1111-111111111111',
    nickname: 'aks-prod',
    cluster: { type: 'aks' },
    destination: { siem_vendor: 'azure-monitor' },
    offload_destinations: [
      { nickname: 'legacy', type: 's3', status: 'active', bucket: 'legacy-bucket' },
    ],
    streamer: { url: 'http://streamer.log10x.svc:8080' },
    retriever: {
      url: 'http://retriever.log10x.svc:80',
      input_bucket: 'tenx-index',
      query_queues: { index: 'i', query: 'q', subquery: 's', stream: 'st' },
    },
    created_at: '2026-09-12T00:00:00Z',
    updated_at: '2026-09-12T00:00:00Z',
  } as EnvironmentConfig;
}

test('offload_add stores storage_account on an azure_blob destination', async () => {
  const { store, current } = memoryStore(seedEnv());
  await executeOffloadAdd(
    {
      env_id: 'aks-prod',
      nickname: 'blob-primary',
      type: 'azure_blob',
      bucket: CONTAINER,
      storage_account: ACCOUNT,
      region: 'eastus',
      auth: { method: 'workload_identity' },
    },
    [store],
  );
  const added = current().offload_destinations.find((d) => d.nickname === 'blob-primary');
  assert.ok(added, 'destination was appended');
  assert.equal(added!.type, 'azure_blob');
  assert.equal(added!.bucket, CONTAINER);
  assert.equal(added!.storage_account, ACCOUNT);
  // The read path can now address it.
  const target = objectStoreTargetFrom(added!);
  assert.equal(storeUri(target!), BLOB_URI);
});

test('offload_add refuses an azure_blob destination with no storage_account', async () => {
  const { store, current } = memoryStore(seedEnv());
  const out = await executeOffloadAdd(
    { env_id: 'aks-prod', nickname: 'blob-broken', type: 'azure_blob', bucket: CONTAINER },
    [store],
  );
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  assert.ok(text.includes('storage_account'), `expected a storage_account refusal, got: ${text}`);
  assert.equal(
    current().offload_destinations.find((d) => d.nickname === 'blob-broken'),
    undefined,
    'nothing unreadable is persisted',
  );
});
