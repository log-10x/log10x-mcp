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

// Receiver wizard support status (matches src/lib/advisor/reporter.ts
// blockers): filebeat is the only blocked forwarder (upstream chart has
// no extraContainers hook). Everything else is wizard-supported — fluentd
// via a kustomize post-renderer overlay; the rest via plain extraContainers.
const WIZARD_BLOCKED_RECEIVERS = new Set<ForwarderKind>(['filebeat']);
const installableForwarders: ForwarderKind[] = forwarders.filter(
  (f) => !WIZARD_BLOCKED_RECEIVERS.has(f)
);

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
    // Steps use either `file` (singular) or `files[]` (multi-file emit,
    // e.g. fluentd's kustomize overlay) — assert both shapes.
    for (const s of plan.install) {
      if (s.file) {
        assert.ok(s.file.path.length > 0);
        assert.ok(s.file.contents.length > 0);
      }
      if (s.files) {
        for (const f of s.files) {
          assert.ok(f.path.length > 0, `every emitted file needs a path; step: ${s.title}`);
          assert.ok(f.contents.length > 0, `every emitted file needs contents; path: ${f.path}`);
        }
      }
    }
  });
}

test('Receiver plan for logstash is supported via the upstream chart sidecar overlay', async () => {
  // The old log10x-elastic/logstash repackage was architecturally broken
  // for sidecar mode. The new path uses the upstream elastic/logstash
  // chart with extraContainers (pipe-string form) + secretMounts +
  // logstashConfig + logstashPipeline. No blocker.
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'logstash',
    licenseJwt: 'test-key',
    destination: 'mock',
  });
  assert.equal(plan.blockers.length, 0, `no blockers expected; got: ${plan.blockers.join(' | ')}`);
  const installText = JSON.stringify(plan.install);
  assert.ok(installText.includes('elastic/logstash'), 'should reference the upstream elastic/logstash chart');
  const content = findValuesContents(plan);
  assert.ok(content.includes('extraContainers: |'), 'logstash uses extraContainers as a pipe-string');
  assert.ok(content.includes('secretMounts:'), 'logstash uses secretMounts for the license');
  assert.ok(content.includes('logstashPipeline:'), 'logstash overlay declares the ingest + destinations pipelines');
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
  //
  // Helper: locate the actual values.yaml regardless of whether the
  // write step uses `file` (singular) or `files[]` (multi-file emit,
  // used by fluentd's kustomize overlay).
  for (const fw of installableForwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    const content = findValuesContents(plan);
    assert.ok(content.length > 0, `${fw}: expected to find a values.yaml in plan.install`);
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

/**
 * Locate the `*-values.yaml` contents in a plan, whether emitted via
 * the singular `file` slot (most receivers) or the `files[]` array
 * (fluentd's kustomize multi-file emit). Returns '' if not found.
 */
function findValuesContents(plan: { install: Array<{ file?: { path: string; contents: string }; files?: Array<{ path: string; contents: string }> }> }): string {
  for (const s of plan.install) {
    if (s.file?.path.endsWith('-values.yaml')) return s.file.contents;
    if (s.files) {
      const v = s.files.find((f) => f.path.endsWith('-values.yaml'));
      if (v) return v.contents;
    }
  }
  // Fall back to whatever the first file-emitting step has (covers
  // legacy single-file steps that don't end in -values.yaml).
  for (const s of plan.install) {
    if (s.file) return s.file.contents;
    if (s.files && s.files.length > 0) return s.files[0].contents;
  }
  return '';
}

test('forwarder values files do NOT embed gitToken or config.git noise', async () => {
  // 2026-05: the gitToken / config.git block was legacy noise. Verify
  // neither field appears in any wizard-supported receiver's rendered
  // values. Reporter (STANDALONE_SPEC) intentionally omits gitToken too.
  for (const fw of installableForwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    const content = findValuesContents(plan);
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

test('Receiver: verify probes target the log10x sidecar container', async () => {
  // Migrated receivers all run a sidecar named `log10x`. At least one
  // verify probe per forwarder should target it (the sidecar liveness
  // check). The forwarder's own container is named per upstream chart
  // convention (fluent-bit, vector, logstash, opentelemetry-collector) —
  // probes that target it are still allowed, just not required.
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
      probeCmds.includes('-c log10x'),
      `${fw}: at least one verify probe should target the log10x sidecar container, got: ${probeCmds.slice(0, 400)}`
    );
  }
});

test('Receiver: chart refs are the right published names', async () => {
  // Receiver migration in flight: migrated forwarders target the UPSTREAM
  // chart with a sidecar overlay (the new model per receiver/deploy.md);
  // pre-migration forwarders still target log10x repackages. Reporter
  // has its own chart (log10x/reporter-10x) and skips per-forwarder
  // routing entirely.
  const upstream: Partial<Record<ForwarderKind, string>> = {
    'fluentbit': 'fluent/fluent-bit',
    'otel-collector': 'open-telemetry/opentelemetry-collector',
    'vector': 'vector/vector',
    'logstash': 'elastic/logstash',
    'fluentd': 'fluent/fluentd',
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
    const expected = upstream[fw];
    assert.ok(
      expected && installText.includes(expected),
      `${fw}: install plan must reference chart '${expected}', not found in: ${installText.slice(0, 400)}`
    );
  }
});

test('Receiver: values + overlay files have the expected shape per forwarder', async () => {
  // Every wizard-supported receiver runs a log10x sidecar that reads its
  // license from a Secret-mounted file via TENX_LICENSE_FILE. The
  // chart-side surface differs:
  //   - fluentbit, otel-collector, vector, logstash: extraContainers +
  //     (extraVolumes | secretMounts) in values.yaml.
  //   - fluentd: extraContainers does not exist on the upstream chart, so
  //     the sidecar lives in tenx-kustomize/sidecar-patch.yaml emitted
  //     alongside values.yaml; helm uses --post-renderer to weave them.
  // Concatenate every file the write step emits so the shape assertions
  // catch references regardless of which file they land in.
  const migrated = new Set<ForwarderKind>(['fluentbit', 'otel-collector', 'vector', 'logstash', 'fluentd']);
  for (const fw of installableForwarders) {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test-key',
      destination: 'mock',
    });
    const writeStep = plan.install.find((s) => s.file || (s.files && s.files.length > 0));
    assert.ok(writeStep, `${fw} should have a file-write step`);
    const allFiles = writeStep!.files ?? (writeStep!.file ? [writeStep!.file] : []);
    const allEmitted = allFiles.map((f) => f.contents).join('\n--\n');
    if (migrated.has(fw)) {
      assert.ok(/name:\s*log10x\b/.test(allEmitted), `${fw} should declare a sidecar named log10x`);
      assert.ok(allEmitted.includes('image: log10x/edge-10x'), `${fw} should mount the log10x/edge-10x sidecar`);
      assert.ok(allEmitted.includes('TENX_LICENSE_FILE'), `${fw} should set TENX_LICENSE_FILE in the sidecar env`);
      // The JWT must never appear inline in any emitted file — the
      // license is mounted from a Kubernetes Secret.
      assert.ok(!allEmitted.includes('licenseJwt: "test-key"'), `${fw} should NOT embed the JWT inline (license-Secret pattern)`);
      // Plain-values forwarders express extraContainers + (extraVolumes
      // | secretMounts) in values.yaml; fluentd splits across the
      // kustomize patch (no extraContainers field on the upstream
      // fluent/fluentd chart).
      if (fw !== 'fluentd') {
        assert.ok(allEmitted.includes('extraContainers:'), `${fw} should declare extraContainers (sidecar overlay)`);
        assert.ok(
          allEmitted.includes('extraVolumes:') || allEmitted.includes('secretMounts:'),
          `${fw} should mount the license Secret via extraVolumes or secretMounts`
        );
      }
    } else {
      const content = allFiles[0]?.contents ?? '';
      assert.ok(content.includes('tenx:'), `${fw} file should declare tenx block (legacy embedded-image shape)`);
      assert.ok(content.includes('licenseJwt: "test-key"'), `${fw} file should embed license JWT (legacy shape)`);
    }
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
  const valuesContent = findValuesContents(plan);
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
