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

// ── optimize flag ──

test('optimize=true on fluent-bit regulator renders the regulatorOptimize env block', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    destination: 'mock',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `no blockers expected, got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('regulatorOptimize'),
    `fluent-bit optimize=true values should set regulatorOptimize env; got: ${content}`
  );
  assert.ok(
    content.includes('value: "true"'),
    `fluent-bit optimize=true values should set regulatorOptimize to "true"; got: ${content}`
  );
});

test('optimize=true on fluent-bit does NOT flip tenx.optimize (chart-broken path)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    optimize: true,
  });
  const content = plan.install.find((s) => s.file)!.file!.contents;
  // We specifically do NOT want `tenx.optimize: true` in the rendered
  // values — the chart's optimize path at 1.0.7 references a Lua script
  // that isn't shipped in the image, so using it blows up at init.
  assert.ok(
    !content.includes('optimize: true'),
    `fluent-bit values should NOT set tenx.optimize: true (chart-broken); got: ${content}`
  );
});

test('optimize=true on fluentd regulator renders the regulatorOptimize env block', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'fluentd',
    apiKey: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(content.includes('regulatorOptimize'), `fluentd optimize=true values should set regulatorOptimize env`);
});

test('optimize=true adds an encoded-events verify probe', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    optimize: true,
  });
  const encodedProbe = plan.verify.find((p) => p.name === 'tenx-encoded-events');
  assert.ok(encodedProbe, `expected a verify probe named 'tenx-encoded-events'; got: ${plan.verify.map((p) => p.name).join(',')}`);
  assert.ok(
    encodedProbe!.commands.some((c) => c.includes('~[')),
    `encoded-events probe should grep for templateHash prefix; got commands: ${encodedProbe!.commands.join(' | ')}`
  );
});

test('optimize=false leaves fluent-bit values unchanged (no env block)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    optimize: false,
  });
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    !content.includes('regulatorOptimize'),
    `optimize=false must NOT include regulatorOptimize env; got: ${content}`
  );
});

test('optimize=true on filebeat regulator is blocked (unverified chart)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'filebeat',
    apiKey: 'test',
    optimize: true,
  });
  assert.ok(
    plan.blockers.some((b) => b.includes('optimize=true is verified working only')),
    `expected optimize-unverified blocker for filebeat; got: ${plan.blockers.join(' | ')}`
  );
  assert.equal(plan.install.length, 0, `blocked plans should not emit install steps`);
});

test('optimize=true on otel-collector regulator is blocked (unverified chart)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'regulator',
    forwarder: 'otel-collector',
    apiKey: 'test',
    optimize: true,
  });
  assert.ok(
    plan.blockers.some((b) => b.includes('optimize=true is verified working only')),
    `expected optimize-unverified blocker for otel-collector; got: ${plan.blockers.join(' | ')}`
  );
});

test('optimize=true with app=reporter is blocked', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reporter',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    optimize: true,
  });
  assert.ok(
    plan.blockers.some((b) => b.includes('Regulator-app feature')),
    `expected reporter+optimize blocker; got: ${plan.blockers.join(' | ')}`
  );
});
