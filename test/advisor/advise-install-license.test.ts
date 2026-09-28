/**
 * Licence default of `log10x_advise_install` (2026-09-28).
 *
 * With no `license_source`, the wizard puts no licence in the plan: the
 * engine runs its built-in evaluation licence (10 nodes, 30 days from each
 * start, airgapped). Nothing is minted, so the gateway is never called, and
 * no step creates a licence Secret. An explicit choice sticks across calls,
 * so the re-invoke after sign-in, or the call that carries a pasted JWT,
 * keeps the licence the user asked for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executeAdviseInstall, adviseInstallSchema } from '../../src/tools/advise-install.js';
import { putSnapshot } from '../../src/lib/discovery/snapshot-store.js';
import { SNAPSHOT_SCHEMA_VERSION, type DiscoverySnapshot } from '../../src/lib/discovery/types.js';
import type { Environments } from '../../src/lib/environments.js';

type Args = Parameters<typeof executeAdviseInstall>[0];

function k8sSnapshot(id: string): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    startedAt: '2026-09-28T00:00:00Z',
    finishedAt: '2026-09-28T00:01:00Z',
    kubectl: {
      available: true,
      context: 'kind-test',
      namespaces: ['logging', 'default'],
      probedNamespaces: ['logging'],
      forwarders: [],
      helmReleases: [],
      log10xApps: [],
      storageClasses: ['standard'],
      ingressClasses: [],
      backendAgents: [],
      serviceAccountIrsa: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
    probeLog: [],
  };
}

function data(out: object): Record<string, unknown> {
  return (out as { data: Record<string, unknown> }).data;
}

function installText(d: Record<string, unknown>): string {
  return JSON.stringify(d) + String(d.markdown ?? '');
}

/** Fail loudly if anything reaches the network: the default path mints nothing. */
async function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network call on the builtin-licence path');
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('schema: license_source offers builtin and leaves the default to the wizard', () => {
  const field = adviseInstallSchema.license_source;
  assert.equal(field.safeParse(undefined).success, true);
  assert.equal(field.safeParse(undefined).data, undefined, 'an omitted value must not overwrite the session');
  assert.equal(field.safeParse('builtin').success, true);
  for (const v of ['signin', 'paste', 'demo']) assert.equal(field.safeParse(v).success, true, v);
  assert.match(field.description ?? '', /Defaults to `"builtin"`/);
  assert.match(field.description ?? '', /10 nodes, 30 days from each start, airgapped/);
});

const PROM_ANSWERS = {
  backends: ['prometheus'],
  backend_credentials: { prometheus: { secretName: 'prom-creds', plainValues: { PROMETHEUS_REMOTE_WRITE_URL: 'https://prom.example/api/v1/write' } } },
  airgapped: false,
};

for (const forwarder of ['fluentbit', 'otel-collector'] as const) {
  test(`wizard default: a ${forwarder} receiver plan carries no licence and calls no gateway`, async () => {
    const id = `snap-builtin-${forwarder}`;
    putSnapshot(k8sSnapshot(id));
    const out = await withNoNetwork(() =>
      executeAdviseInstall(
        { snapshot_id: id, app: 'receiver', forwarder, ...PROM_ANSWERS } as Args,
        {} as Environments
      )
    );
    const d = data(out);
    assert.equal(d.mode, 'plan', `expected a plan, got ${String(d.mode)}: ${String(d.markdown).slice(0, 400)}`);
    assert.equal(d.license_kind, 'builtin');
    const text = installText(d);
    assert.ok(!text.includes('TENX_LICENSE_FILE'), 'no TENX_LICENSE_FILE in a builtin plan');
    assert.ok(!text.includes('tenx-license'), 'no tenx-license volume in a builtin plan');
    assert.ok(!text.includes('Create license Secret'), 'no Secret step in a builtin plan');
    assert.ok(!text.includes('create secret generic'), 'no kubectl create secret in a builtin plan');
    const md = String(d.markdown);
    assert.match(md, /\*\*License\*\*: none in the plan/);
    assert.match(md, /10 nodes, 30 days from each start, airgapped/);
    assert.ok(!/14-day/.test(md), 'the default path never mentions a demo window');
    const warnings = ((out as { warnings?: string[] }).warnings ?? []).join('\n');
    assert.match(warnings, /built-in evaluation licence, 10 nodes, 30 days from each start, airgapped/);
    assert.ok(!/demo license/i.test(warnings), 'no demo warning on the default path');
    assert.ok(!/`log10x` metrics backend/.test(warnings), 'no log10x-backend warning when log10x was never chosen');
  });
}

// The log10x-hosted TSDB serves the public demo, not customer installs, so
// the wizard never offers it and never defaults to it.
test('wizard: with no backends given, the question offers only user-owned backends, detected first', async () => {
  const id = 'snap-backends-question';
  const snap = k8sSnapshot(id);
  snap.kubectl.backendAgents = [{ kind: 'datadog', confidence: 'helm-release', evidence: 'datadog-agent' }];
  putSnapshot(snap);
  const out = await executeAdviseInstall(
    { snapshot_id: id, app: 'receiver', forwarder: 'fluentbit' } as Args,
    {} as Environments
  );
  const d = data(out);
  assert.equal(d.mode, 'next_question');
  assert.equal(d.question_id, 'backends');
  const shape = d.shape as { choices: Array<{ value: string; recommended?: boolean }> };
  const values = shape.choices.map((c) => c.value);
  assert.ok(!values.includes('log10x'), `log10x must not be offered: ${values.join(', ')}`);
  assert.deepEqual([...values].sort(), ['cloudwatch', 'datadog', 'elastic', 'prometheus']);
  assert.equal(values[0], 'datadog', 'the detected backend is listed first');
  const md = String(d.markdown);
  assert.ok(!md.includes('`log10x`'), `the question must not list log10x:\n${md}`);
  assert.ok(!/SaaS/.test(md), `no SaaS suggestion in the question:\n${md}`);
});

test('wizard: a plan answered with only user-owned backends names no log10x backend', async () => {
  const id = 'snap-no-log10x-backend';
  putSnapshot(k8sSnapshot(id));
  const out = await withNoNetwork(() =>
    executeAdviseInstall(
      { snapshot_id: id, app: 'receiver', forwarder: 'fluentbit', ...PROM_ANSWERS } as Args,
      {} as Environments
    )
  );
  const d = data(out);
  assert.equal(d.mode, 'plan');
  const md = String(d.markdown);
  assert.match(md, /\*\*Metrics backends\*\*: `prometheus`\n/);
  assert.ok(!md.includes('`log10x`'), 'log10x never appears as a backend');
  assert.ok(!md.includes('@run/output/metric/log10x'));
  assert.match(md, /"@run\/output\/metric\/prometheus"/);
});

test('wizard: an explicit log10x backend still works, with the licence warning', async () => {
  const id = 'snap-explicit-log10x';
  putSnapshot(k8sSnapshot(id));
  const out = await withNoNetwork(() =>
    executeAdviseInstall(
      { snapshot_id: id, app: 'receiver', forwarder: 'fluentbit', backends: ['log10x'] } as Args,
      {} as Environments
    )
  );
  const d = data(out);
  assert.equal(d.mode, 'plan');
  assert.equal(d.license_kind, 'builtin');
  const warnings = ((out as { warnings?: string[] }).warnings ?? []).join('\n');
  assert.match(warnings, /`log10x` metrics backend receives nothing on the built-in evaluation licence/);
  assert.match(String(d.markdown), /the `log10x` metrics backend receives no metrics until the engine is licensed/);
  const lic = (d.preflight as Array<{ name: string; status: string }>).find((c) => c.name === 'license');
  assert.equal(lic?.status, 'warn');
});

test('wizard: a paste choice sticks when the follow-up call carries only the JWT', async () => {
  const id = 'snap-paste-sticky';
  putSnapshot(k8sSnapshot(id));
  const first = await executeAdviseInstall(
    { snapshot_id: id, app: 'receiver', forwarder: 'fluentbit', backends: ['log10x'], license_source: 'paste' } as Args,
    {} as Environments
  );
  assert.equal(data(first).mode, 'next_question');
  assert.equal(data(first).question_id, 'license-paste');

  const second = await withNoNetwork(() =>
    executeAdviseInstall({ snapshot_id: id, license_jwt_paste: 'pasted.jwt.value' } as Args, {} as Environments)
  );
  const d = data(second);
  assert.equal(d.mode, 'plan');
  assert.equal(d.license_kind, 'user-pasted');
  const text = installText(d);
  assert.ok(text.includes('Create license Secret'), 'a pasted JWT still gets its Secret step');
  assert.ok(text.includes('TENX_LICENSE_FILE'), 'a pasted JWT is still mounted');
  assert.ok(text.includes('pasted.jwt.value'));
});

test('wizard: an explicit builtin drops a JWT an earlier turn stored', async () => {
  const id = 'snap-paste-then-builtin';
  putSnapshot(k8sSnapshot(id));
  await executeAdviseInstall(
    { snapshot_id: id, app: 'receiver', forwarder: 'fluentbit', backends: ['log10x'], license_jwt_paste: 'old.jwt' } as Args,
    {} as Environments
  );
  const out = await withNoNetwork(() =>
    executeAdviseInstall({ snapshot_id: id, license_source: 'builtin' } as Args, {} as Environments)
  );
  const d = data(out);
  assert.equal(d.mode, 'plan');
  assert.equal(d.license_kind, 'builtin');
  const text = installText(d);
  assert.ok(!text.includes('old.jwt'));
  assert.ok(!text.includes('Create license Secret'));
});
