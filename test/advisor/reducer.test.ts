/**
 * Reducer advisor tests. The same plan builder serves reporter +
 * reducer — these tests lock down the reducer-specific
 * differences: kind='regulate' in values, release-name default,
 * alreadyInstalled note keyed by reducer, and plan.app field.
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
  if (fw === 'logstash') {
    // log10x-elastic/logstash@1.0.6 is chart-broken for sidecar mode;
    // the advisor blocks it entirely. Assert the blocker path here.
    test(`reducer plan for ${fw} is blocked (chart broken)`, async () => {
      const plan = await buildReporterPlan({
        snapshot: baseSnapshot(),
        app: 'reducer',
        forwarder: fw,
        apiKey: 'test',
        destination: 'mock',
      });
      assert.ok(
        plan.blockers.some((b) => b.toLowerCase().includes('logstash')),
        `expected logstash blocker; got: ${plan.blockers.join(' | ')}`
      );
      assert.equal(plan.install.length, 0, `blocked plans should not emit install steps`);
    });
    continue;
  }
  test(`reducer plan for ${fw}: values embed kind=regulate`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'reducer',
      forwarder: fw,
      apiKey: 'test',
      destination: 'mock',
    });
    assert.equal(plan.app, 'reducer');
    const content = plan.install.find((s) => s.file)!.file!.contents;
    assert.ok(content.includes('kind: "regulate"'), `${fw} values should embed kind=regulate`);
    assert.ok(!content.includes('kind: "report"'), `${fw} values should NOT embed kind=report`);
  });
}

test('reducer default release name is my-reducer', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  assert.equal(plan.releaseName, 'my-reducer');
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
    app: 'reducer',
    forwarder: 'fluent-bit',
    releaseName: 'custom-reg-name',
    apiKey: 'test',
  });
  assert.equal(plan.releaseName, 'custom-reg-name');
});

test('alreadyInstalled.reducer triggers a note, not a blocker', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        alreadyInstalled: { reducer: 'demo' },
      },
    }),
    app: 'reducer',
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  assert.equal(plan.blockers.length, 0);
  assert.ok(
    plan.notes.some((n) => n.toLowerCase().includes('receiver') && n.includes('`demo`')),
    `expected a note about existing Receiver in demo namespace; got: ${plan.notes.join(' | ')}`
  );
});

test('reducer plan install commands reference the same chart as reporter', async () => {
  // Reducer uses the same charts; only kind differs. Logstash is
  // blocked upstream (chart-broken sidecar wiring) so we skip it here —
  // the logstash blocker is covered by the dedicated test above.
  const expected: Record<string, string> = {
    'fluent-bit': 'log10x-fluent/fluent-bit',
    fluentd: 'log10x-fluent/fluentd',
    filebeat: 'log10x-elastic/filebeat',
    'otel-collector': 'log10x-otel/opentelemetry-collector',
  };
  for (const fw of forwarders) {
    if (fw === 'logstash') continue;
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'reducer',
      forwarder: fw,
      apiKey: 'test',
      destination: 'mock',
    });
    const installText = JSON.stringify(plan.install);
    assert.ok(
      installText.includes(expected[fw]),
      `reducer plan for ${fw} should reference chart '${expected[fw]}'`
    );
  }
});

// ── optimize flag ──

test('optimize=true on fluent-bit reducer renders the reducerOptimize env block', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    destination: 'mock',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `no blockers expected, got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('reducerOptimize'),
    `fluent-bit optimize=true values should set reducerOptimize env; got: ${content}`
  );
  assert.ok(
    content.includes('value: "true"'),
    `fluent-bit optimize=true values should set reducerOptimize to "true"; got: ${content}`
  );
});

test('optimize=true on fluent-bit does NOT flip tenx.optimize (chart-broken path)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
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

test('optimize=true on fluentd reducer renders the reducerOptimize env block', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'fluentd',
    apiKey: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(content.includes('reducerOptimize'), `fluentd optimize=true values should set reducerOptimize env`);
});

test('optimize=true adds an encoded-events verify probe', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
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
    app: 'reducer',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    optimize: false,
  });
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    !content.includes('reducerOptimize'),
    `optimize=false must NOT include reducerOptimize env; got: ${content}`
  );
});

test('optimize=true on filebeat reducer is allowed (1.0.7 unified path)', async () => {
  // As of chart 1.0.7, every forwarder maps kind=optimize to
  // @apps/reducer + reducerOptimize=true env — no per-forwarder
  // blocker anymore.
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'filebeat',
    apiKey: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  assert.ok(plan.install.length > 0, 'install plan should be emitted for filebeat + optimize');
});

test('optimize=true on otel-collector reducer is allowed (1.0.7 unified path)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'otel-collector',
    apiKey: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  assert.ok(plan.install.length > 0, 'install plan should be emitted for otel-collector + optimize');
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
    plan.blockers.some((b) => b.includes('Receiver-app feature')),
    `expected reporter+optimize blocker; got: ${plan.blockers.join(' | ')}`
  );
});

test('mode=readonly emits reducerReadOnly env on fluent-bit', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    readOnly: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('reducerReadOnly') && content.includes('"true"'),
    `mode=readonly must include reducerReadOnly=true env; got: ${content}`
  );
});

test('mode=readonly + optimize=true is blocked', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    optimize: true,
    readOnly: true,
  });
  assert.ok(
    plan.blockers.some((b) => b.includes('no-op when mode=readonly')),
    `expected mutual-exclusion blocker; got: ${plan.blockers.join(' | ')}`
  );
});

test('mode=readonly with app=reporter is blocked', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reporter',
    forwarder: 'fluent-bit',
    apiKey: 'test',
    readOnly: true,
  });
  assert.ok(
    plan.blockers.some((b) => b.includes('Receiver-app concept')),
    `expected reporter+readOnly blocker; got: ${plan.blockers.join(' | ')}`
  );
});

test('mode=readonly emits reducerReadOnly env on filebeat', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'filebeat',
    apiKey: 'test',
    readOnly: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('reducerReadOnly'),
    `mode=readonly must include reducerReadOnly env; got: ${content}`
  );
});

test('mode=readonly emits reducerReadOnly env on otel-collector', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reducer',
    forwarder: 'otel-collector',
    apiKey: 'test',
    readOnly: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('reducerReadOnly'),
    `mode=readonly must include reducerReadOnly env; got: ${content}`
  );
});
