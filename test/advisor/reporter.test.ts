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
  test(`plan for ${fw}: install + verify + teardown all present`, async () => {
    const plan = await buildReporterPlan({
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

test('missing api_key adds a blocker', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
  });
  assert.ok(plan.blockers.some((b) => b.toLowerCase().includes('license key')));
});

test('skipInstall means missing api_key does not block', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
    skipInstall: true,
  });
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.install.length, 0);
  assert.ok(plan.verify.length > 0, 'verify should still be populated');
});

test('release name collision flagged in preflight', async () => {
  const plan = await buildReporterPlan({
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

test('forwarder alignment warns when detected differs from requested', async () => {
  const plan = await buildReporterPlan({
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

test('vector plan notes mention upstream-fallback status', async () => {
  // Chart availability is now LIVE-probed via `helm search repo`, so its
  // status depends on what's in the test environment's helm cache.
  // Instead of asserting the preflight status (which can flake), we
  // assert the plan's notes still flag the WIP chart status.
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'vector',
    apiKey: 'test',
  });
  assert.ok(plan.notes.some((n) => n.toLowerCase().includes('work-in-progress')));
});

test('splunk destination without hec_token blocks', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
    apiKey: 'test',
    destination: 'splunk',
  });
  assert.ok(plan.blockers.some((b) => b.toLowerCase().includes('splunk_hec_token')));
});

test('renderPlan for "install" omits verify and teardown', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluent-bit',
    apiKey: 'test',
  });
  const out = renderPlan(plan, 'install');
  assert.ok(out.includes('## Install'));
  assert.ok(!out.includes('## Verify'));
  assert.ok(!out.includes('## Teardown'));
});

test('renderPlan for "teardown" omits install and verify', async () => {
  const plan = await buildReporterPlan({
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

test('already-installed reporter triggers a note, not a blocker', async () => {
  const plan = await buildReporterPlan({
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

test('values.yaml has no duplicate top-level keys (fluentd regression)', async () => {
  // The dogfood pass found that fluentd values emitted two top-level
  // `tenx:` keys — YAML silently kept the second and dropped apiKey /
  // kind / runtimeName / git config entirely. Lock the invariant
  // across every forwarder: each top-level key appears at most once.
  for (const fw of forwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      apiKey: 'test',
      destination: 'mock',
    });
    const writeStep = plan.install.find((s) => s.file);
    const content = writeStep!.file!.contents;
    // Count lines starting at column 0 with `<word>:` (naive but
    // sufficient — our templates don't embed flow-style).
    const topLevelKeys = content
      .split('\n')
      .filter((l) => /^[A-Za-z_][A-Za-z0-9_-]*:/.test(l))
      .map((l) => l.match(/^([A-Za-z_][A-Za-z0-9_-]*):/)![1]);
    const counts = new Map<string, number>();
    for (const k of topLevelKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const [k, n] of counts) {
      assert.ok(n === 1, `${fw}: top-level key '${k}' appears ${n} times — duplicates silently drop earlier keys`);
    }
  }
});

test('every forwarder values file embeds gitToken (init-container secret mount)', async () => {
  // Every log10x-repackaged chart mounts a tenx-git-token secret in an
  // init container. If gitToken is empty the secret isn't created and
  // pods hang in FailedMount. Every forwarder (except vector, which
  // uses extraContainers without the init) must emit a placeholder.
  for (const fw of forwarders) {
    if (fw === 'vector') continue;
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      apiKey: 'test',
      destination: 'mock',
    });
    const content = plan.install.find((s) => s.file)!.file!.contents;
    assert.ok(
      content.includes('gitToken:'),
      `${fw}: values must emit gitToken (even a placeholder) to satisfy chart init container`
    );
  }
});

test('verify probes target the correct container per forwarder', async () => {
  const expected: Record<string, string> = {
    'fluent-bit': 'fluent-bit',
    fluentd: 'fluentd',
    filebeat: 'filebeat',
    vector: 'tenx',            // sidecar mode
    logstash: 'logstash',
    'otel-collector': 'opentelemetry-collector',
  };
  for (const fw of forwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      apiKey: 'test',
      destination: 'mock',
    });
    const probeCmds = plan.verify.flatMap((v) => v.commands).join(' ');
    // At least one probe command must reference the expected container.
    assert.ok(
      probeCmds.includes(`-c ${expected[fw]}`),
      `${fw}: at least one verify probe should target container '${expected[fw]}', got: ${probeCmds.slice(0, 200)}`
    );
  }
});

test('chart refs are the published names (no `-10x` suffix drift)', async () => {
  const expected: Record<string, string> = {
    'fluent-bit': 'log10x-fluent/fluent-bit',
    fluentd: 'log10x-fluent/fluentd',
    filebeat: 'log10x-elastic/filebeat',
    vector: 'vector/vector',
    logstash: 'log10x-elastic/logstash',
    'otel-collector': 'log10x-otel/opentelemetry-collector',
  };
  for (const fw of forwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      apiKey: 'test',
      destination: 'mock',
    });
    const installText = JSON.stringify(plan.install);
    assert.ok(
      installText.includes(expected[fw]),
      `${fw}: install plan must reference chart '${expected[fw]}', not found in: ${installText.slice(0, 400)}`
    );
  }
});

test('values.yaml content is syntactically close to YAML', async () => {
  // Smoke-test: generated values file has expected shape for each
  // forwarder. Vector is a sidecar install — it injects tenx via
  // `extraContainers` + `TENX_API_KEY` env rather than a top-level
  // `tenx:` block. Every other forwarder uses the embedded-image
  // pattern with a `tenx:` block.
  for (const fw of forwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      apiKey: 'test-key',
      destination: 'mock',
    });
    const writeStep = plan.install.find((s) => s.file);
    assert.ok(writeStep, `${fw} should have a file-write step`);
    const content = writeStep!.file!.contents;
    if (fw === 'vector') {
      // Sidecar-mode: no top-level tenx: block; tenx runs as a sidecar.
      assert.ok(content.includes('extraContainers'), `vector should inject sidecar via extraContainers`);
      assert.ok(content.includes('TENX_API_KEY'), `vector should pass api key as env var`);
      assert.ok(content.includes('test-key'), `vector should embed the api key value`);
    } else {
      assert.ok(content.includes('tenx:'), `${fw} file should declare tenx block`);
      assert.ok(content.includes('apiKey: "test-key"'), `${fw} file should embed api key`);
    }
  }
});
