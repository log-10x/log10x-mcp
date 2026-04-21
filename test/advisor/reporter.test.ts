/**
 * Reporter advisor tests. Exercise preflight logic + plan generation
 * for each supported forwarder, plus the blocker paths when required
 * input is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReporterPlan } from '../../src/lib/advisor/reporter.js';
import { renderPlan } from '../../src/lib/advisor/render.js';
import type { DiscoverySnapshot, ForwarderKind } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';

function baseSnapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'disc-test-1',
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
  'vector',
  'logstash',
  'otel-collector',
];

for (const fw of forwarders) {
  test(`plan for ${fw}: install + verify + teardown all present`, () => {
    const plan = buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      apiKey: 'test-key',
      destination: 'mock',
    });
    assert.equal(plan.blockers.length, 0, `no blockers with api_key supplied; got: ${plan.blockers.join(', ')}`);
    assert.ok(plan.install.length >= 4, `install should have ≥4 steps; got ${plan.install.length}`);
    assert.ok(plan.verify.length >= 2, `verify should have ≥2 probes; got ${plan.verify.length}`);
    assert.ok(plan.teardown.length >= 2, `teardown should have ≥2 steps; got ${plan.teardown.length}`);
    // Every install step that writes a file must have a path + contents.
    for (const s of plan.install) {
      if (s.file) {
        assert.ok(s.file.path.length > 0);
        assert.ok(s.file.contents.length > 0);
      }
    }
  });
}

test('missing api_key adds a blocker', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
  });
  assert.ok(plan.blockers.some((b) => b.toLowerCase().includes('license key')));
});

test('skipInstall means missing api_key does not block', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
    skipInstall: true,
  });
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.install.length, 0);
  assert.ok(plan.verify.length > 0, 'verify should still be populated');
});

test('release name collision flagged in preflight', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        helmReleases: [
          {
            name: 'my-reporter',
            namespace: 'logging',
            chart: 'fluent-bit-1.0.0',
            appVersion: '1.0',
            status: 'deployed',
            revision: 1,
          },
        ],
      },
    }),
    forwarder: 'fluent-bit',
    releaseName: 'my-reporter',
    namespace: 'logging',
    apiKey: 'test',
  });
  const collision = plan.preflight.find((p) => p.name === 'release collision');
  assert.ok(collision);
  assert.equal(collision?.status, 'fail');
});

test('forwarder alignment warns when detected differs from requested', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot({
      recommendations: { suggestedNamespace: 'demo', existingForwarder: 'fluentd', alreadyInstalled: {} },
    }),
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  const align = plan.preflight.find((p) => p.name === 'forwarder alignment');
  assert.ok(align);
  assert.equal(align?.status, 'warn');
  assert.ok(align?.detail.includes('fluentd'));
  assert.ok(align?.detail.includes('fluent-bit'));
});

test('vector flags chart availability as upstream-fallback', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'vector',
    apiKey: 'test',
  });
  const chart = plan.preflight.find((p) => p.name === 'chart availability');
  assert.equal(chart?.status, 'warn');
  assert.ok(plan.notes.some((n) => n.toLowerCase().includes('work-in-progress')));
});

test('splunk destination without hec_token blocks', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
    apiKey: 'test',
    destination: 'splunk',
  });
  assert.ok(plan.blockers.some((b) => b.toLowerCase().includes('splunk_hec_token')));
});

test('renderPlan for "install" omits verify and teardown', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  const out = renderPlan(plan, 'install');
  assert.ok(out.includes('## Install'));
  assert.ok(!out.includes('## Verify'));
  assert.ok(!out.includes('## Teardown'));
});

test('renderPlan for "teardown" omits install and verify', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
    apiKey: 'test',
    skipInstall: true,
    skipVerify: true,
  });
  const out = renderPlan(plan, 'teardown');
  assert.ok(out.includes('## Teardown'));
  assert.ok(!out.includes('## Install'));
  assert.ok(!out.includes('## Verify'));
});

test('already-installed reporter triggers a note, not a blocker', () => {
  const plan = buildReporterPlan({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        alreadyInstalled: { reporter: 'demo' },
      },
    }),
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  assert.equal(plan.blockers.length, 0);
  assert.ok(plan.notes.some((n) => n.toLowerCase().includes('already installed')));
});

test('values.yaml content is syntactically close to YAML', () => {
  // Smoke-test by grabbing the generated file for each forwarder and
  // ensuring it contains the expected top-level keys. This isn't a
  // real YAML parser — just a "did we not accidentally break the
  // template?" check.
  for (const fw of forwarders) {
    const plan = buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      apiKey: 'test-key',
      destination: 'mock',
    });
    const writeStep = plan.install.find((s) => s.file);
    assert.ok(writeStep, `${fw} should have a file-write step`);
    const content = writeStep!.file!.contents;
    assert.ok(content.includes('tenx:'), `${fw} file should declare tenx block`);
    assert.ok(content.includes('apiKey: "test-key"'), `${fw} file should embed api key`);
  }
});
