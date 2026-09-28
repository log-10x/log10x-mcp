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
// embedded-image `tenx:` block to an upstream-chart overlay. All
// supported forwarders are now on upstream charts — five use the
// sidecar pattern (extraContainers + extraVolumes), filebeat uses the
// image swap (no sidecar; engine runs as a child of filebeat inside
// the same container, per the deploy.md doc). The sidecar-shape
// assertions below skip filebeat since it has no log10x container to
// look for.
const MIGRATED_TO_SIDECAR = new Set<ForwarderKind>(['fluentbit', 'otel-collector', 'vector', 'logstash', 'fluentd']);

// Filebeat uses image swap instead of a sidecar — the 10x engine runs
// as a child of filebeat's entrypoint inside the same container. The
// shape assertions for filebeat below check the image swap + the
// daemonset.extraEnvs / extraVolumes / filebeatConfig overlay instead
// of looking for a log10x container.
const MIGRATED_TO_IMAGESWAP = new Set<ForwarderKind>(['filebeat']);

// Every forwarder is wizard-supported now (no forked charts served).
// Kept as a (currently empty) Set for forward compatibility when a
// future forwarder lands as wizard-supported-but-not-yet-migrated.
const WIZARD_BLOCKED_RECEIVERS = new Set<ForwarderKind>([]);
const wizardSupportedReceivers = forwarders.filter((f) => !WIZARD_BLOCKED_RECEIVERS.has(f));

/**
 * Locate the `*-values.yaml` contents in a plan, whether emitted via
 * the singular `file` slot (legacy) or the `files[]` array (today's
 * write step always uses files[]). Returns '' if not found.
 */
function findValuesContents(plan: { install: Array<{ file?: { path: string; contents: string }; files?: Array<{ path: string; contents: string }> }> }): string {
  for (const s of plan.install) {
    if (s.file?.path.endsWith('-values.yaml')) return s.file.contents;
    if (s.files) {
      const v = s.files.find((f) => f.path.endsWith('-values.yaml'));
      if (v) return v.contents;
    }
  }
  for (const s of plan.install) {
    if (s.file) return s.file.contents;
    if (s.files && s.files.length > 0) return s.files[0].contents;
  }
  return '';
}

/**
 * Concatenate every file content the install step emits — handles
 * both legacy `file` and new `files[]` shapes. Used by tests that
 * grep across the entire overlay (values.yaml + kustomize patches).
 */
function findAllEmittedContent(plan: { install: Array<{ file?: { path: string; contents: string }; files?: Array<{ path: string; contents: string }> }> }): string {
  const parts: string[] = [];
  for (const s of plan.install) {
    if (s.file) parts.push(s.file.contents);
    if (s.files) for (const f of s.files) parts.push(f.contents);
  }
  return parts.join('\n--\n');
}

for (const fw of wizardSupportedReceivers) {
  test(`receiver plan for ${fw}: values match the chart's expected shape`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    assert.equal(plan.app, 'receiver');
    // The write step may use `file` (single, the common case) or `files`
    // (multi-file, used by fluentd's kustomize post-renderer overlay).
    // Concatenate everything emitted in the write step so the shape
    // assertions catch references regardless of which side they land on
    // — for fluentd that means the sidecar's `image:` lives in
    // sidecar-patch.yaml, not values.yaml.
    const writeStep = plan.install.find((s) => s.file || (s.files && s.files.length > 0))!;
    const allEmitted = (writeStep.files ?? (writeStep.file ? [writeStep.file] : []))
      .map((f) => f.contents)
      .join('\n--\n');
    if (MIGRATED_TO_SIDECAR.has(fw)) {
      // Sidecar overlay shape (per receiver/deploy.md): the sidecar
      // container is named `log10x`, runs the `log10x/edge-10x` image,
      // and reads its license from a Kubernetes-mounted file via
      // TENX_LICENSE_FILE. Most charts express this with
      // `extraContainers:` + `extraVolumes:` in values.yaml; logstash
      // uses `extraContainers:` + `secretMounts:`; fluentd splits the
      // sidecar across a kustomize patch — same semantics, different
      // chart-side surface.
      assert.ok(/name:\s*log10x\b/.test(allEmitted), `${fw} sidecar container should be named log10x`);
      assert.ok(allEmitted.includes('image: log10x/edge-10x'), `${fw} sidecar should use log10x/edge-10x image`);
      assert.ok(allEmitted.includes('TENX_LICENSE_FILE'), `${fw} sidecar should read license via TENX_LICENSE_FILE`);
      const isFluentdKustomize = fw === 'fluentd';
      if (!isFluentdKustomize) {
        // Plain-values forwarders declare extraContainers + (extraVolumes |
        // secretMounts) directly in values.yaml. Fluentd's kustomize patch
        // doesn't use that surface — it patches the rendered Deployment.
        assert.ok(allEmitted.includes('extraContainers:'), `${fw} values should declare extraContainers`);
        assert.ok(
          allEmitted.includes('extraVolumes:') || allEmitted.includes('secretMounts:'),
          `${fw} should mount the license Secret via extraVolumes or secretMounts`
        );
      }
      // Non-fluentd values.yaml should NOT have a top-level tenx: block.
      // (Fluentd's values.yaml also has no tenx: block — it starts with
      // `kind: Deployment`. Assert this uniformly across migrated set.)
      const valuesContents = (writeStep.files ?? []).find((f) => f.path.endsWith('-values.yaml'))?.contents
        ?? writeStep.file?.contents
        ?? '';
      assert.ok(!valuesContents.startsWith('tenx:'), `${fw} receiver overlays should NOT have a top-level tenx: block`);
    } else if (MIGRATED_TO_IMAGESWAP.has(fw)) {
      // Image-swap overlay shape (filebeat, per receiver/deploy.md): no
      // sidecar container; the chart's default filebeat image is
      // replaced with log10x/filebeat-10x and the engine runs as a
      // child of filebeat's entrypoint inside that container. License,
      // mode flags, and backend env vars all land on
      // daemonset.extraEnvs / extraVolumes.
      assert.ok(allEmitted.includes('image: "log10x/filebeat-10x"'), `${fw} should swap to the log10x/filebeat-10x image`);
      assert.ok(allEmitted.includes('TENX_LICENSE_FILE'), `${fw} should read license via TENX_LICENSE_FILE in daemonset.extraEnvs`);
      assert.ok(allEmitted.includes('TENX_RUN_ARGS'), `${fw} should set TENX_RUN_ARGS to drive @run/input/forwarder/filebeat @apps/receiver`);
      assert.ok(allEmitted.includes('extraVolumes:'), `${fw} should mount the license Secret via daemonset.extraVolumes`);
      // No log10x sidecar container in the image-swap path.
      assert.ok(!/name:\s*log10x\b/.test(allEmitted), `${fw} should NOT declare a log10x sidecar container`);
      assert.ok(!allEmitted.includes('image: log10x/edge-10x'), `${fw} should NOT reference the edge-10x sidecar image`);
    } else {
      // Unreachable: every wizardSupportedReceivers entry is in
      // MIGRATED_TO_SIDECAR or MIGRATED_TO_IMAGESWAP. Kept as a
      // type-narrowing branch + future-proofing if a new forwarder
      // lands in wizardSupportedReceivers before being added to either
      // migrated set.
      assert.fail(`${fw} is wizard-supported but not in MIGRATED_TO_SIDECAR or MIGRATED_TO_IMAGESWAP — update the set`);
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
  const upstream: Partial<Record<ForwarderKind, string>> = {
    'fluentbit': 'fluent/fluent-bit',
    'otel-collector': 'open-telemetry/opentelemetry-collector',
    'vector': 'vector/vector',
    'logstash': 'elastic/logstash',
    'fluentd': 'fluent/fluentd',
    'filebeat': 'elastic/filebeat',
  };
  for (const fw of wizardSupportedReceivers) {
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
      `receiver plan for ${fw} should reference chart '${expected}'`
    );
  }
});

test('receiver plan for fluentd emits the kustomize post-renderer overlay (5 files)', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentd',
    licenseJwt: 'test',
    destination: 'mock',
  });
  assert.equal(plan.blockers.length, 0, `no blockers expected; got: ${plan.blockers.join(' | ')}`);

  // The write step uses files[] (multi-file emit), not file (singular).
  const writeStep = plan.install.find((s) => s.files && s.files.length > 1);
  assert.ok(writeStep, `expected a step with files[].length > 1; got steps: ${plan.install.map((s) => s.title).join(' | ')}`);

  // Exactly five files: values.yaml + 4 kustomize files.
  const paths = writeStep!.files!.map((f) => f.path);
  assert.equal(writeStep!.files!.length, 5, `fluentd should emit 5 files; got: ${paths.join(', ')}`);
  assert.ok(paths.some((p) => p.endsWith('-values.yaml')), `values.yaml missing; got: ${paths.join(', ')}`);
  assert.ok(paths.includes('tenx-kustomize/kustomization.yaml'), `kustomization.yaml missing`);
  assert.ok(paths.includes('tenx-kustomize/sidecar-patch.yaml'), `sidecar-patch.yaml missing`);
  assert.ok(paths.includes('tenx-kustomize/post-render.sh'), `post-render.sh missing`);
  assert.ok(paths.includes('tenx-kustomize/post-render.cmd'), `post-render.cmd missing`);

  // post-render.sh must be marked executable (drives chmod hint + summary flag).
  const sh = writeStep!.files!.find((f) => f.path === 'tenx-kustomize/post-render.sh');
  assert.ok(sh?.executable === true, `post-render.sh should be executable: true; got: ${JSON.stringify(sh)}`);

  // The install step must chmod the script + pass --post-renderer to helm.
  const installStep = plan.install.find((s) => s.commands.some((c) => c.startsWith('helm upgrade')));
  assert.ok(installStep, `expected an install step running helm upgrade`);
  const installCmds = installStep!.commands.join('\n');
  assert.ok(installCmds.includes('chmod +x tenx-kustomize/post-render.sh'), `expected chmod command; got: ${installCmds}`);
  assert.ok(installCmds.includes('--post-renderer ./tenx-kustomize/post-render.sh'), `expected --post-renderer flag; got: ${installCmds}`);
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
  const content = findValuesContents(plan);
  assert.ok(
    content.includes('receiverOptimize'),
    `fluent-bit optimize=true values should append receiverOptimize to the sidecar args; got: ${content}`
  );
  assert.ok(/name:\s*log10x\b/.test(content), 'fluent-bit overlay should have the log10x sidecar');
});

// Deleted: 'optimize=true on fluentd receiver flips tenx.optimize: true'
// Fluentd is now blocked (kustomize post-renderer not yet wired).
//
// Deleted: 'optimize=true on filebeat receiver sets tenx.optimize: true'
// Filebeat is now blocked (upstream chart has no extraContainers hook).

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
  const content = findValuesContents(plan);
  assert.ok(
    !content.includes('optimize: true'),
    `optimize=false must NOT set tenx.optimize: true; got: ${content}`
  );
  assert.ok(
    !content.includes('receiverOptimize'),
    `optimize=false must NOT include any legacy receiverOptimize env (the workaround was deleted); got: ${content}`
  );
});

// Deleted: 'optimize=true on filebeat receiver is allowed (1.0.7 unified path)'
// Filebeat is now blocked.

test('optimize=true on otel-collector receiver is allowed', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'otel-collector',
    licenseJwt: 'test',
    optimize: true,
  });
  assert.equal(plan.blockers.length, 0, `expected no blockers; got: ${plan.blockers.join(' | ')}`);
  assert.ok(plan.install.length > 0, 'install plan should be emitted for otel-collector + optimize');
  const content = findValuesContents(plan);
  assert.ok(
    content.includes('receiverOptimize'),
    `otel-collector optimize=true values should append receiverOptimize to the sidecar args; got: ${content}`
  );
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

// Deleted: 'mode=readonly flips tenx.readOnly: true on fluent-bit'
// The chart-value `tenx.readOnly: true` does not exist in the new
// sidecar-overlay model. readOnly behavior would now need to be
// expressed as an engine arg appended to the log10x sidecar's args
// (mirror of `receiverOptimize`), which isn't implemented yet. The
// mutual-exclusion blocker tests below still cover the
// readOnly + optimize and readOnly + app=reporter conflict cases.

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

// Deleted: 'mode=readonly sets tenx.readOnly: true on filebeat' — blocked.
// Deleted: 'mode=readonly flips tenx.readOnly: true on otel-collector' —
// the chart-value pattern no longer exists in the sidecar overlay model.

test('app=reporter uses STANDALONE_SPEC (reporter-10x chart) regardless of detected forwarder', async () => {
  // Reporter is not "sugar for Receiver + readOnly" running on the
  // per-forwarder chart. It is a
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
    const content = findValuesContents(plan);
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

// ── Engine-policy pull wiring ────────────────────────────────────────────
//
// The receiver enforces caps.csv / actions.csv only when the engine's
// kubernetes pull lane is armed on the pod (K8S_ENABLED) and the lookup
// files point into the pull destination (CAP_LOOKUP_FILE et al). A values
// overlay without these vars produces a receiver that ignores every policy
// log10x_configure_engine writes. The seed step matters equally: the
// engine's first pull runs on the launch thread and a missing ConfigMap
// aborts startup, and the lookup loader refuses a rows-less CSV — so the
// pre-install manifest must exist and must carry one no-op row per file.

for (const fw of wizardSupportedReceivers) {
  test(`receiver plan for ${fw}: wires the engine-policy pull env`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    const all = findAllEmittedContent(plan);
    for (const needle of [
      'K8S_ENABLED',
      'K8S_CONFIGMAP',
      'CAP_LOOKUP_FILE',
      'ACTION_LOOKUP_FILE',
      'CONFIG_GENERATION_FILE',
      'fieldPath: metadata.namespace',
    ]) {
      assert.ok(all.includes(needle), `${fw} receiver values must wire ${needle}`);
    }
    // Paths must interpolate the downward-API namespace, not hardcode one.
    assert.ok(
      all.includes('/tmp/tenx/kubernetes/$(K8S_NAMESPACE)/log10x-action-intent/actions.csv'),
      `${fw}: ACTION_LOOKUP_FILE must point into the pull destination`
    );
  });

  test(`receiver plan for ${fw}: seeds the policy ConfigMap before install`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
    });
    const seed = plan.install.find((s) => s.title === 'Seed the engine-policy ConfigMap');
    assert.ok(seed, 'seed step present on receiver installs');
    const cmd = (seed!.commands ?? []).join('\n');
    // One no-op row per file — header-only and zero-byte files fail the
    // engine's lookup loader at launch.
    assert.match(cmd, /tenx-seed,1::/, 'caps.csv seed row');
    assert.match(cmd, /tenx-seed,pass::/, 'actions.csv seed row');
    // RBAC read grant scoped to the one ConfigMap.
    assert.match(cmd, /kind: Role/);
    assert.match(cmd, /resourceNames: \["log10x-action-intent"\]/);
    // Seed runs before the pod (re)starts: precede the helm install/upgrade.
    const seedIdx = plan.install.indexOf(seed!);
    const helmIdx = plan.install.findIndex(
      (s) => /install via helm|upgrade the existing/i.test(s.title)
    );
    assert.ok(helmIdx >= 0, 'helm install/upgrade step present');
    assert.ok(seedIdx < helmIdx, 'seed step precedes the helm install/upgrade step');
  });
}

test('reporter (standalone) plan has no policy seed step and no pull env', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    forwarder: 'fluentbit',
    licenseJwt: 'test',
  });
  assert.ok(
    !plan.install.find((s) => s.title === 'Seed the engine-policy ConfigMap'),
    'reporter (report-mode, no regulator) needs no policy ConfigMap'
  );
});

// Measured 2026-09-28 by driving log10x_advise_install as a new user
// (fluentbit, backends: ["prometheus"], license_source: "demo"): the plan
// mounted a `log10x-license` Secret that no step created, so the pod would
// wait on it forever, and the sidecar carried no Prometheus output or
// remote-write URL, so the chosen backend received nothing.
for (const fw of ['fluentbit', 'otel-collector'] as ForwarderKind[]) {
  test(`receiver/${fw}: a demo-license plan creates the Secret its sidecar mounts`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'demo.jwt.value',
      isDemoLicense: true,
      destination: 'mock',
    });
    const values = findValuesContents(plan);
    assert.match(values, /secretName: log10x-license/);
    const secretStep = plan.install.find((s) => s.title === 'Create license Secret');
    assert.ok(secretStep, 'the Secret the values mount must be created by the plan');
    assert.match(secretStep!.commands!.join('\n'), /demo\.jwt\.value/);
  });

  test(`receiver/${fw}: a non-log10x backend reaches the sidecar`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'test',
      destination: 'mock',
      backends: ['prometheus'],
      backendCredentials: {
        prometheus: { secretName: 'prom-creds', plainValues: { PROMETHEUS_REMOTE_WRITE_URL: 'https://prom.example/api/v1/write' } },
      },
    });
    const values = findValuesContents(plan);
    assert.match(values, /"@run\/output\/metric\/prometheus"/);
    assert.match(values, /name: prom-creds/);
    assert.match(values, /value: "https:\/\/prom\.example\/api\/v1\/write"/);
  });
}

// The install wizard's default (2026-09-28): no licence in the plan. The
// engine runs its built-in evaluation licence (10 nodes, 30 days from each
// start, airgapped), so the overlay must name no licence at all. A
// TENX_LICENSE_FILE pointing at a missing file, or a volume naming a Secret
// nobody created, keeps the pod from starting.
for (const fw of wizardSupportedReceivers) {
  test(`receiver/${fw}: a builtin-licence plan names no licence env, volume or Secret`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      builtinLicense: true,
      destination: 'mock',
    });
    assert.deepEqual(plan.blockers, [], `no licence is a supported install: ${plan.blockers.join(' | ')}`);
    assert.equal(plan.licenseKind, 'builtin');
    const emitted = findAllEmittedContent(plan);
    assert.ok(emitted.length > 0, 'the plan must still emit the overlay');
    assert.ok(!emitted.includes('TENX_LICENSE_FILE'), `${fw}: no TENX_LICENSE_FILE on the builtin path`);
    assert.ok(!emitted.includes('tenx-license'), `${fw}: no tenx-license volume or mount on the builtin path`);
    assert.ok(!emitted.includes('secretMounts:'), `${fw}: no secretMounts on the builtin path`);
    assert.ok(!emitted.includes('log10x-license'), `${fw}: no licence Secret named on the builtin path`);
    assert.ok(
      !plan.install.some((s) => s.title === 'Create license Secret'),
      `${fw}: no step creates a licence Secret on the builtin path`
    );
    assert.ok(
      !plan.install.flatMap((s) => s.commands ?? []).some((c) => /create secret generic/.test(c)),
      `${fw}: no kubectl create secret on the builtin path`
    );
    const lic = plan.preflight.find((c) => c.name === 'license');
    assert.ok(lic, 'the preflight names the licence the engine runs on');
    assert.match(lic!.detail, /10 nodes, 30 days from each start, airgapped/);
    // Default backends are ['log10x'], which the airgapped evaluation
    // licence cannot report to: a warn that names the way out.
    assert.equal(lic!.status, 'warn');
    assert.match(lic!.detail, /`log10x` metrics backend receives no metrics/);
  });
}

test('receiver/fluentbit: builtin with only user-owned backends is a clean preflight row', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    builtinLicense: true,
    backends: ['prometheus'],
    destination: 'mock',
  });
  const lic = plan.preflight.find((c) => c.name === 'license');
  assert.equal(lic?.status, 'ok');
  assert.ok(!/log10x` metrics backend/.test(lic!.detail));
});

test('receiver/fluentbit: a builtin plan keeps the sidecar, its env and airgapped wiring', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    builtinLicense: true,
    airgapped: true,
    backends: ['prometheus'],
    destination: 'mock',
  });
  const values = findValuesContents(plan);
  assert.match(values, /name: log10x\b/);
  assert.match(values, /image: log10x\/edge-10x:/);
  assert.match(values, /name: TENX_AIRGAPPED/);
  assert.match(values, /name: K8S_ENABLED/);
  assert.ok(!/volumeMounts:/.test(values), 'nothing to mount without a licence');
  assert.ok(!/extraVolumes:/.test(values), 'no extraVolumes without a licence');
});

// A JWT the caller supplied keeps today's path: the Secret step and the mount.
for (const fw of ['fluentbit', 'otel-collector'] as ForwarderKind[]) {
  test(`receiver/${fw}: a pasted JWT still creates the Secret and mounts it`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'pasted.jwt.value',
      destination: 'mock',
    });
    assert.equal(plan.licenseKind, 'user-pasted');
    const values = findValuesContents(plan);
    assert.match(values, /name: TENX_LICENSE_FILE/);
    assert.match(values, /name: tenx-license/);
    assert.match(values, /secretName: log10x-license/);
    const secretStep = plan.install.find((s) => s.title === 'Create license Secret');
    assert.ok(secretStep, 'the Secret the values mount must be created by the plan');
    assert.match(secretStep!.commands!.join('\n'), /pasted\.jwt\.value/);
  });

  test(`receiver/${fw}: a JWT wins over builtinLicense`, async () => {
    const plan = await buildReporterPlan({
      snapshot: baseSnapshot(),
      app: 'receiver',
      forwarder: fw,
      licenseJwt: 'user.jwt.value',
      isDemoLicense: false,
      builtinLicense: true,
      destination: 'mock',
    });
    assert.equal(plan.licenseKind, 'user-scoped');
    assert.ok(plan.install.some((s) => s.title === 'Create license Secret'));
    assert.match(findValuesContents(plan), /name: TENX_LICENSE_FILE/);
  });
}

test('receiver/fluentd: the kustomize patch carries no licence volume on the builtin path', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentd',
    builtinLicense: true,
    destination: 'mock',
  });
  const patch = plan.install
    .flatMap((s) => s.files ?? [])
    .find((f) => f.path === 'tenx-kustomize/sidecar-patch.yaml');
  assert.ok(patch, 'the sidecar patch is still emitted');
  assert.match(patch!.contents, /name: log10x\b/);
  assert.ok(!/volumes:/.test(patch!.contents), 'no pod volume without a licence');
  assert.ok(!/volumeMounts:/.test(patch!.contents), 'no mount without a licence');
});

test('reporter (standalone): a builtin plan sets no licence value, so chart 1.2.0+ renders no Secret', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reporter',
    builtinLicense: true,
    destination: 'mock',
  });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.licenseKind, 'builtin');
  const values = findValuesContents(plan);
  // Only a comment may mention the key; no value line sets it.
  assert.ok(!/^log10xLicenseJwt:/m.test(values), `no log10xLicenseJwt value: ${values}`);
  assert.ok(!/^licenseSecret:/m.test(values), `no licenseSecret block: ${values}`);
  assert.match(values, /built-in evaluation license \(10 nodes,/);
  assert.ok(!plan.install.some((s) => s.title === 'Create license Secret'));
});

test('reporter (standalone): a pasted JWT is still inlined for the chart to store', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'reporter',
    licenseJwt: 'pasted.jwt.value',
    destination: 'mock',
  });
  assert.match(findValuesContents(plan), /log10xLicenseJwt: "pasted\.jwt\.value"/);
});

test('a plan with neither a JWT nor builtinLicense still blocks', async () => {
  const plan = await buildReporterPlan({
    snapshot: baseSnapshot(),
    app: 'receiver',
    forwarder: 'fluentbit',
    destination: 'mock',
  });
  assert.ok(plan.blockers.some((b) => /builtinLicense: true/.test(b)), plan.blockers.join(' | '));
});
