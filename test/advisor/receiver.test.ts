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

// Forwarders whose Receiver renderer has been migrated from the old
// embedded-image `tenx:` block to the upstream-chart sidecar overlay
// pattern (extraContainers + extraVolumes per deploy.md). Tests
// assertion-branch on membership: migrated forwarders get sidecar-shape
// assertions; the rest keep the legacy assertions until they're done.
// Expand as each forwarder spec is rewritten.
const MIGRATED_TO_SIDECAR = new Set<ForwarderKind>(['fluentbit', 'otel-collector', 'vector', 'logstash']);

for (const fw of forwarders) {
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
    if (MIGRATED_TO_SIDECAR.has(fw)) {
      // Sidecar overlay shape (per receiver/deploy.md): extraContainers
      // with the log10x sidecar + license Secret mounted via the chart's
      // own volume mechanism. Most charts use `extraVolumes:`; the
      // elastic/logstash chart uses `secretMounts:` instead (different
      // chart-side convention, same effect).
      assert.ok(content.includes('extraContainers:'), `${fw} values should declare extraContainers`);
      assert.ok(/name:\s*log10x\b/.test(content), `${fw} sidecar container should be named log10x`);
      assert.ok(content.includes('image: log10x/edge-10x'), `${fw} sidecar should use log10x/edge-10x image`);
      assert.ok(
        content.includes('extraVolumes:') || content.includes('secretMounts:'),
        `${fw} should mount the license Secret via extraVolumes or secretMounts`
      );
      assert.ok(content.includes('TENX_LICENSE_FILE'), `${fw} sidecar should read license via TENX_LICENSE_FILE`);
      assert.ok(!content.startsWith('tenx:'), `${fw} receiver overlays should NOT have a top-level tenx: block`);
    } else {
      // Legacy embedded-image shape — pending migration to sidecar overlay.
      assert.ok(!/^\s*kind:/m.test(content), `${fw} values should NOT embed any kind: line; got: ${content}`);
      assert.ok(!content.includes('optimize: true'), `${fw} default-mode values should NOT enable optimize`);
      assert.ok(!content.includes('readOnly: true'), `${fw} default-mode values should NOT enable readOnly`);
    }
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

test('receiver plan install commands reference the right chart', async () => {
  // Migrated forwarders target the UPSTREAM chart with a sidecar overlay.
  // Pre-migration forwarders still target the old log10x repackages
  // (they will move to upstream as each one is rewritten).
  const upstream: Partial<Record<ForwarderKind, string>> = {
    'fluentbit': 'fluent/fluent-bit',
    'otel-collector': 'open-telemetry/opentelemetry-collector',
    'vector': 'vector/vector',
    'logstash': 'elastic/logstash',
  };
  const legacy: Partial<Record<ForwarderKind, string>> = {
    fluentd: 'log10x-fluent/fluentd',
    filebeat: 'log10x-elastic/filebeat',
  };
  for (const fw of forwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    const installText = JSON.stringify(plan.install);
    const expected = upstream[fw] ?? legacy[fw];
    assert.ok(
      expected && installText.includes(expected),
      `receiver plan for ${fw} should reference chart '${expected}'`
    );
  }
});

// ── optimize flag ──

test('optimize=true on fluent-bit receiver appends receiverOptimize to the engine args', async () => {
  // Post-migration: optimize is no longer a chart-value boolean. It's
  // appended to the log10x sidecar container's args as the engine flag
  // `receiverOptimize true`, which switches the receiver to compact
  // encoded output.
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
    content.includes('receiverOptimize'),
    `fluent-bit optimize=true values should append receiverOptimize to the sidecar args; got: ${content}`
  );
  assert.ok(/name:\s*log10x\b/.test(content), 'fluent-bit overlay should have the log10x sidecar');
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
