/**
 * Receiver advisor tests. The same plan builder serves reporter +
 * receiver — these tests lock down the receiver-specific differences:
 * the right feature flags / kind values land in the chart values for
 * each forwarder, release-name default, alreadyInstalled note keyed
 * by receiver, and plan.app field.
 *
 * Per-forwarder values shape (current chart format, no backcompat):
 * Every chart (fluent-bit / fluentd / otel-collector / filebeat / logstash)
 * uses `tenx.optimize` and `tenx.readOnly` booleans. Default mode emits
 * neither. The two flags are mutually exclusive — every chart's
 * `tenx-validate.yaml` template fails install if both are true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReporterPlan } from '../../src/lib/advisor/reporter.js';
import type { DiscoverySnapshot, ForwarderKind } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';

function baseSnapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'disc-rec-test-1',
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
      backendAgents: [],
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
  'fluentbit',
  'fluentd',
  'filebeat',
  'logstash',
  'otel-collector',
];

for (const fw of forwarders) {
  if (fw === 'logstash') {
    // log10x-elastic/logstash@1.0.6 is chart-broken for sidecar mode;
    // the advisor blocks it entirely. Assert the blocker path here.
    test(`receiver plan for ${fw} is blocked (chart broken)`, async () => {
      const plan = await buildReporterPlan({
        snapshot: baseSnapshot(),
        app: 'receiver',
        forwarder: fw,
        licenseJwt: 'test',
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
  test(`receiver plan for ${fw}: values match the chart's expected shape`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    assert.equal(plan.app, 'receiver');
    const content = plan.install.find((s) => s.file)!.file!.contents;
    // Every supported chart now uses boolean feature flags. Default mode
    // (neither flag set) is just plain receiver — no `kind:` line, no
    // `optimize: true`, no `readOnly: true`.
    assert.ok(!/^\s*kind:/m.test(content), `${fw} values should NOT embed any kind: line; got: ${content}`);
    assert.ok(!content.includes('optimize: true'), `${fw} default-mode values should NOT enable optimize`);
    assert.ok(!content.includes('readOnly: true'), `${fw} default-mode values should NOT enable readOnly`);
  });
}

test('receiver default release name is my-receiver', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
  });
  assert.equal(plan.releaseName, 'my-receiver');
});

test('reporter default release name is my-reporter (unchanged)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluentbit',
    licenseJwt: 'test',
  });
  assert.equal(plan.app, 'reporter');
  assert.equal(plan.releaseName, 'my-reporter');
});

test('explicit release_name overrides the app default', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    releaseName: 'custom-rec-name',
    licenseJwt: 'test',
  });
  assert.equal(plan.releaseName, 'custom-rec-name');
});

test('alreadyInstalled.receiver triggers a note, not a blocker', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        alreadyInstalled: { receiver: 'demo' },
      },
    }),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
  });
  assert.equal(plan.blockers.length, 0);
  assert.ok(
    plan.notes.some((n) => n.toLowerCase().includes('receiver') && n.includes('`demo`')),
    `expected a note about existing Receiver in demo namespace; got: ${plan.notes.join(' | ')}`
  );
});

test('receiver plan install commands reference the same chart as reporter', async () => {
  // Receiver uses the same charts; only kind differs. Logstash is
  // blocked upstream (chart-broken sidecar wiring) so we skip it here —
  // the logstash blocker is covered by the dedicated test above.
  const expected: Record<string, string> = {
    'fluentbit': 'log10x-fluent/fluent-bit',
    fluentd: 'log10x-fluent/fluentd',
    filebeat: 'log10x-elastic/filebeat',
    'otel-collector': 'log10x-otel/opentelemetry-collector',
  };
  for (const fw of forwarders) {
    if (fw === 'logstash') continue;
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    const installText = JSON.stringify(plan.install);
    assert.ok(
      installText.includes(expected[fw]),
      `receiver plan for ${fw} should reference chart '${expected[fw]}'`
    );
  }
});

// ── optimize flag ──

test('optimize=true on fluent-bit receiver flips tenx.optimize: true', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
    destination: 'mock',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `no blockers expected, got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('optimize: true'),
    `fluent-bit optimize=true values should set tenx.optimize: true; got: ${content}`
  );
  assert.ok(
    !content.includes('readOnly: true'),
    `fluent-bit optimize=true values should NOT set tenx.readOnly; got: ${content}`
  );
});

test('optimize=true on fluentd receiver flips tenx.optimize: true', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentd',
    licenseJwt: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(content.includes('optimize: true'), `fluentd optimize=true values should set tenx.optimize: true`);
});

test('optimize=true on filebeat receiver sets tenx.optimize: true', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'filebeat',
    licenseJwt: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('optimize: true'),
    `filebeat optimize=true values should set tenx.optimize: true; got: ${content}`
  );
  assert.ok(!/^\s*kind:/m.test(content), `filebeat values should NOT embed any kind: line`);
});

test('optimize=true adds an encoded-events verify probe', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
    optimize: true,
  });
  const encodedProbe = plan.verify.find((p) => p.name === 'tenx-encoded-events');
  assert.ok(encodedProbe, `expected a verify probe named 'tenx-encoded-events'; got: ${plan.verify.map((p) => p.name).join(',')}`);
  assert.ok(
    encodedProbe!.commands.some((c) => c.includes('~[')),
    `encoded-events probe should grep for templateHash prefix; got commands: ${encodedProbe!.commands.join(' | ')}`
  );
});

test('optimize=false leaves fluent-bit values unchanged (no optimize flag)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
    optimize: false,
  });
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    !content.includes('optimize: true'),
    `optimize=false must NOT set tenx.optimize: true; got: ${content}`
  );
  assert.ok(
    !content.includes('receiverOptimize'),
    `optimize=false must NOT include any legacy receiverOptimize env (the workaround was deleted); got: ${content}`
  );
});

test('optimize=true on filebeat receiver is allowed (1.0.7 unified path)', async () => {
  // As of chart 1.0.7, every forwarder maps kind=optimize to
  // @apps/receiver + receiverOptimize=true env — no per-forwarder
  // blocker anymore.
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'filebeat',
    licenseJwt: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  assert.ok(plan.install.length > 0, 'install plan should be emitted for filebeat + optimize');
});

test('optimize=true on otel-collector receiver is allowed (1.0.7 unified path)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'otel-collector',
    licenseJwt: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  assert.ok(plan.install.length > 0, 'install plan should be emitted for otel-collector + optimize');
});

test('optimize=true with app=reporter is blocked', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reporter',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
    optimize: true,
  });
  assert.ok(
    plan.blockers.some((b) => b.includes('Receiver-app feature')),
    `expected reporter+optimize blocker; got: ${plan.blockers.join(' | ')}`
  );
});

test('mode=readonly flips tenx.readOnly: true on fluent-bit', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
    readOnly: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('readOnly: true'),
    `mode=readonly must set tenx.readOnly: true; got: ${content}`
  );
  assert.ok(
    !content.includes('receiverReadOnly'),
    `mode=readonly must NOT emit any legacy receiverReadOnly env (the workaround was deleted); got: ${content}`
  );
});

test('mode=readonly + optimize=true is blocked', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
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
    forwarder: 'fluentbit',
    licenseJwt: 'test',
    readOnly: true,
  });
  assert.ok(
    plan.blockers.some((b) => b.includes('Receiver-app concept')),
    `expected reporter+readOnly blocker; got: ${plan.blockers.join(' | ')}`
  );
});

test('mode=readonly sets tenx.readOnly: true on filebeat', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'filebeat',
    licenseJwt: 'test',
    readOnly: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('readOnly: true'),
    `mode=readonly on filebeat must set tenx.readOnly: true; got: ${content}`
  );
  assert.ok(!/^\s*kind:/m.test(content), `filebeat values should NOT embed any kind: line`);
});

test('mode=readonly flips tenx.readOnly: true on otel-collector', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'otel-collector',
    licenseJwt: 'test',
    readOnly: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  const content = plan.install.find((s) => s.file)!.file!.contents;
  assert.ok(
    content.includes('readOnly: true'),
    `mode=readonly must set tenx.readOnly: true; got: ${content}`
  );
});

test('app=reporter uses STANDALONE_SPEC (reporter-10x chart) regardless of detected forwarder', async () => {
  // Production intent shift (2026-05): Reporter is no longer "sugar for
  // Receiver + readOnly" running on the per-forwarder chart. It's a
  // dedicated DaemonSet via the log10x/reporter-10x chart, sitting
  // alongside the user's existing forwarder. The values doc is flat
  // (top-level log10xLicenseJwt), not the per-forwarder `tenx:` block.
  for (const fw of ['fluentbit', 'filebeat'] as const) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'reporter',
      forwarder: fw,
      licenseJwt: 'test',
    });
    assert.equal(plan.blockers.length, 0, `${fw}: no blockers; got: ${plan.blockers.join(' | ')}`);
    const content = plan.install.find((s) => s.file)!.file!.contents;
    assert.ok(
      content.includes('log10xLicenseJwt: "test"'),
      `${fw}: standalone Reporter chart uses flat log10xLicenseJwt; got: ${content}`
    );
    assert.ok(
      content.includes('# reporter-10x: non-invasive parallel DaemonSet.'),
      `${fw}: should render the reporter-10x preamble, not the per-forwarder values`
    );
    // Reporter chart has no `tenx.readOnly` field — the chart itself is
    // read-only by design.
    assert.ok(
      !/^\s*readOnly:/m.test(content),
      `${fw}: reporter chart has no tenx.readOnly field; got: ${content}`
    );
  }
});
