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

// log10x-elastic/logstash@1.0.6 is chart-broken for sidecar mode — the
// advisor emits a blocker for `forwarder=logstash` (no install steps).
// Tests that iterate over forwarders and expect each to produce install
// plans use `installableForwarders`; the logstash-blocker assertion
// lives in its own dedicated test below.
const installableForwarders: ForwarderKind[] = forwarders.filter((f) => f !== 'logstash');

for (const fw of installableForwarders) {
  test(`plan for ${fw}: install + verify + teardown all present`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      licenseJwt: 'test-key',
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

test('Receiver plan for logstash is blocked (chart-broken sidecar wiring)', async () => {
  // Reporter is standalone-only now, so the logstash sidecar bug only
  // applies to the Receiver path.
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'logstash',
    licenseJwt: 'test-key',
    destination: 'mock',
  });
  assert.ok(
    plan.blockers.some((b) => b.toLowerCase().includes('logstash')),
    `expected logstash blocker; got: ${plan.blockers.join(' | ')}`
  );
  assert.equal(plan.install.length, 0, 'blocked plans should not emit install steps');
  assert.ok(plan.verify.length > 0, 'verify probes still emitted');
  assert.ok(plan.teardown.length > 0, 'teardown still emitted');
});

test('missing license_jwt adds a blocker', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluentbit',
  });
  assert.ok(plan.blockers.some((b) => b.toLowerCase().includes('license jwt')));
});

test('skipInstall means missing license_jwt does not block', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluentbit',
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
    forwarder: 'fluentbit',
    releaseName: 'my-reporter',
    namespace: 'logging',
    licenseJwt: 'test',
  });
  const collision = plan.preflight.find((p) => p.name === 'release collision');
  assert.ok(collision);
  assert.equal(collision?.status, 'fail');
});

test('Receiver: forwarder alignment warns when detected differs from requested', async () => {
  // Alignment check only matters for Receiver (sidecar must match the
  // user's actual forwarder). Reporter is standalone — runs alongside
  // any forwarder (or none), so its alignment check is always "ok".
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot({
      recommendations: { suggestedNamespace: 'demo', existingForwarder: 'fluentd', alreadyInstalled: {} },
    }),
    app: 'receiver',
    forwarder: 'fluentbit',
    licenseJwt: 'test',
  });
  const align = plan.preflight.find((p) => p.name === 'forwarder alignment');
  assert.ok(align);
  assert.equal(align?.status, 'warn');
  assert.ok(align?.detail.includes('fluentd'));
  assert.ok(align?.detail.includes('fluentbit'));
});

test('splunk destination without hec_token blocks', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluentbit',
    licenseJwt: 'test',
    destination: 'splunk',
  });
  assert.ok(plan.blockers.some((b) => b.toLowerCase().includes('splunk_hec_token')));
});

test('renderPlan for "install" omits verify and teardown', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluentbit',
    licenseJwt: 'test',
  });
  const out = renderPlan(plan, 'install');
  assert.ok(out.includes('## Install'));
  assert.ok(!out.includes('## Verify'));
  assert.ok(!out.includes('## Teardown'));
});

test('renderPlan for "teardown" omits install and verify', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluentbit',
    licenseJwt: 'test',
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
    forwarder: 'fluentbit',
    licenseJwt: 'test',
  });
  assert.equal(plan.blockers.length, 0);
  assert.ok(plan.notes.some((n) => n.toLowerCase().includes('already installed')));
});

test('values.yaml has no duplicate top-level keys (fluentd regression)', async () => {
  // The dogfood pass found that fluentd values emitted two top-level
  // `tenx:` keys — YAML silently kept the second and dropped apiKey /
  // kind / runtimeName / git config entirely. Lock the invariant
  // across every forwarder: each top-level key appears at most once.
  for (const fw of installableForwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      licenseJwt: 'test',
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

test('forwarder values files do NOT embed gitToken or config.git noise', async () => {
  // 2026-05: the gitToken / config.git block was legacy noise — the
  // chart's git-token Secret template gates on `config.git.enabled` OR
  // `symbols.git.enabled` (both default false), so emitting placeholder
  // values that match defaults just clutters the user's values.yaml.
  // Verify neither field appears in any forwarder's rendered values.
  for (const fw of installableForwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    const content = plan.install.find((s) => s.file)!.file!.contents;
    assert.ok(
      !content.includes('gitToken:'),
      `${fw}: rendered values should NOT emit gitToken (chart default works); got: ${content.slice(0, 400)}`
    );
    assert.ok(
      !/config:\s*\n\s+git:/.test(content),
      `${fw}: rendered values should NOT emit config.git block; got: ${content.slice(0, 400)}`
    );
  }
});

test('Receiver: verify probes target the correct container per forwarder', async () => {
  // Forwarder *identifier* (left) vs k8s *container name* in the upstream
  // chart (right). For Fluent Bit the upstream chart names the container
  // `fluent-bit` (with hyphen) even though our identifier is `fluentbit`.
  // Reporter is standalone (its probes target the chart-bundled fluent-bit
  // container) — this check is Receiver-only.
  const expected: Record<string, string> = {
    'fluentbit': 'fluent-bit',
    fluentd: 'fluentd',
    filebeat: 'filebeat',
    logstash: 'logstash',
    'otel-collector': 'opentelemetry-collector',
  };
  for (const fw of installableForwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    const probeCmds = plan.verify.flatMap((v) => v.commands).join(' ');
    assert.ok(
      probeCmds.includes(`-c ${expected[fw]}`),
      `${fw}: at least one verify probe should target container '${expected[fw]}', got: ${probeCmds.slice(0, 200)}`
    );
  }
});

test('Receiver: chart refs are the published names (no `-10x` suffix drift)', async () => {
  // Receiver uses per-forwarder upstream charts (or log10x forks for
  // filebeat / logstash). Reporter has its own chart (log10x/reporter-10x)
  // and skips per-forwarder routing entirely.
  const expected: Record<string, string> = {
    'fluentbit': 'log10x-fluent/fluent-bit',
    fluentd: 'log10x-fluent/fluentd',
    filebeat: 'log10x-elastic/filebeat',
    logstash: 'log10x-elastic/logstash',
    'otel-collector': 'log10x-otel/opentelemetry-collector',
  };
  for (const fw of installableForwarders) {
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
      `${fw}: install plan must reference chart '${expected[fw]}', not found in: ${installText.slice(0, 400)}`
    );
  }
});

test('Receiver: values.yaml content is syntactically close to YAML', async () => {
  // Smoke-test: generated values file has expected shape for each
  // supported Receiver forwarder. All use the embedded-image pattern
  // with a top-level `tenx:` block. (Reporter uses a flat layout —
  // covered by the dedicated Reporter STANDALONE_SPEC test.)
  for (const fw of installableForwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test-key',
      destination: 'mock',
    });
    const writeStep = plan.install.find((s) => s.file);
    assert.ok(writeStep, `${fw} should have a file-write step`);
    const content = writeStep!.file!.contents;
    assert.ok(content.includes('tenx:'), `${fw} file should declare tenx block`);
    assert.ok(content.includes('licenseJwt: "test-key"'), `${fw} file should embed license JWT`);
  }
});

test('Reporter installs reporter-10x regardless of detected forwarder', async () => {
  // Production intent (2026-05): Reporter is always the reporter-10x
  // chart, parallel to whatever forwarder the user is running. The
  // detected forwarder stays in the plan as context but does NOT drive
  // chart selection.
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluentbit',
        alreadyInstalled: {},
      },
    }),
    forwarder: 'fluentbit',
    licenseJwt: 'test-key',
  });
  assert.equal(plan.blockers.length, 0);
  const installText = JSON.stringify(plan.install);
  assert.ok(
    installText.includes('log10x/reporter-10x'),
    `Reporter install should use reporter-10x chart; got: ${installText.slice(0, 400)}`
  );
  assert.ok(
    !installText.includes('log10x-fluent/fluent-bit'),
    'Reporter install should NOT reference the log10x-repackaged fluent-bit chart'
  );
  // Values file uses the flat reporter-10x layout: top-level
  // log10xLicenseJwt, not nested under `tenx:`.
  const valuesContent = plan.install.find((s) => s.file)?.file?.contents ?? '';
  assert.ok(
    valuesContent.includes('log10xLicenseJwt:'),
    'Reporter values should use reporter-10x flat layout (top-level log10xLicenseJwt)'
  );
});

test('Reporter ignores optimize=true with a blocker (Receiver-only feature)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reporter',
    licenseJwt: 'test',
    optimize: true,
  });
  assert.ok(
    plan.blockers.some((b) => b.toLowerCase().includes('optimize') && b.toLowerCase().includes('receiver')),
    `expected reporter+optimize blocker; got: ${plan.blockers.join(' | ')}`
  );
});

test('Reporter with detected logstash deploys cleanly (sidesteps the chart-broken bug)', async () => {
  // The logstash chart-broken bug applies to Receiver (sidecar inside
  // logstash). Reporter runs in parallel via reporter-10x, so it
  // sidesteps the broken chart entirely.
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'logstash',
        alreadyInstalled: {},
      },
    }),
    forwarder: 'logstash',
    licenseJwt: 'test',
  });
  assert.equal(plan.blockers.length, 0, `Reporter should sidestep logstash blocker; got: ${plan.blockers.join(' | ')}`);
});
