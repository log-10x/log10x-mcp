/**
 * Regulator advisor tests. The same plan builder serves reporter +
 * regulator — these tests lock down the regulator-specific
 * differences: kind='regulate' in values, release-name default,
 * alreadyInstalled note keyed by regulator, and plan.app field.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReporterPlan } from '../../src/lib/advisor/reporter.js';
import type { DiscoverySnapshot, ForwarderKind } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';

function baseSnapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'disc-reg-test-1',
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
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    recommendations: {
      suggestedNamespace: 'logging',
      alreadyInstalled: {},
    },
    probeLog: [],
    ...overrides,
  };
}

const forwarders: ForwarderKind[] = [
  'fluent-bit',
  'fluentd',
  'filebeat',
  'logstash',
  'otel-collector',
];

for (const fw of forwarders) {
  test(`regulator plan for ${fw}: values embed kind=regulate`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'regulator',
      forwarder: fw,
      apiKey: 'test',
      destination: 'mock',
    });
    assert.equal(plan.app, 'regulator');
    const content = plan.install.find((s) => s.file)!.file!.contents;
    assert.ok(content.includes('kind: "regulate"'), `${fw} values should embed kind=regulate`);
    assert.ok(!content.includes('kind: "report"'), `${fw} values should NOT embed kind=report`);
  });
}

test('regulator default release name is my-regulator', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  assert.equal(plan.releaseName, 'my-regulator');
});

test('reporter default release name is my-reporter (unchanged)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  assert.equal(plan.app, 'reporter');
  assert.equal(plan.releaseName, 'my-reporter');
});

test('explicit release_name overrides the app default', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'fluent-bit',
    releaseName: 'custom-reg-name',
    apiKey: 'test',
  });
  assert.equal(plan.releaseName, 'custom-reg-name');
});

test('alreadyInstalled.regulator triggers a note, not a blocker', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        alreadyInstalled: { regulator: 'demo' },
      },
    }),
    app: 'regulator',
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  assert.equal(plan.blockers.length, 0);
  assert.ok(
    plan.notes.some((n) => n.toLowerCase().includes('regulator') && n.includes('`demo`')),
    `expected a note about existing Regulator in demo namespace; got: ${plan.notes.join(' | ')}`
  );
});

test('regulator plan install commands reference the same chart as reporter', async () => {
  // Regulator uses the same charts; only kind differs.
  const expected: Record<string, string> = {
    'fluent-bit': 'log10x-fluent/fluent-bit',
    fluentd: 'log10x-fluent/fluentd',
    filebeat: 'log10x-elastic/filebeat',
    logstash: 'log10x-elastic/logstash',
    'otel-collector': 'log10x-otel/opentelemetry-collector',
  };
  for (const fw of forwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'regulator',
      forwarder: fw,
      apiKey: 'test',
      destination: 'mock',
    });
    const installText = JSON.stringify(plan.install);
    assert.ok(
      installText.includes(expected[fw]),
      `regulator plan for ${fw} should reference chart '${expected[fw]}'`
    );
  }
});
