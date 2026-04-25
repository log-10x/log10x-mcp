/**
 * Mode recommender tests. Each test fixes one snapshot shape + goal
 * combination and asserts the top-picked alternative. These encode the
 * detection rules from `src/lib/advisor/mode.ts` so regressions in
 * ranking are caught at CI time rather than dogfood time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recommendInstallMode } from '../../src/lib/advisor/mode.js';
import type { DiscoverySnapshot, DetectedForwarder } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';

function baseSnapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'disc-mode-test-1',
    startedAt: '2026-04-22T00:00:00Z',
    finishedAt: '2026-04-22T00:01:00Z',
    kubectl: {
      available: true,
      context: 'arn:aws:eks:us-east-1:111:cluster/test',
      namespaces: ['demo', 'logging', 'default'],
      probedNamespaces: ['demo', 'logging'],
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

function helmForwarder(kind: DetectedForwarder['kind'], namespace = 'logging'): DetectedForwarder {
  return {
    kind,
    namespace,
    workloadKind: 'DaemonSet',
    workloadName: `my-${kind}`,
    image: `docker.io/${kind}:latest`,
    containerName: kind === 'otel-collector' ? 'opentelemetry-collector' : kind,
    labels: {
      'app.kubernetes.io/managed-by': 'Helm',
      'helm.sh/chart': `${kind}-1.0.0`,
      'app.kubernetes.io/instance': `my-${kind}`,
    },
    readyReplicas: 3,
  };
}

function handRolledForwarder(kind: DetectedForwarder['kind']): DetectedForwarder {
  return {
    kind,
    namespace: 'logging',
    workloadKind: 'DaemonSet',
    workloadName: `my-${kind}`,
    image: `docker.io/${kind}:latest`,
    containerName: kind === 'otel-collector' ? 'opentelemetry-collector' : kind,
    labels: {},
    readyReplicas: 3,
  };
}

// ── Rule 1: no forwarder detected → standalone reporter ──

test('no forwarder detected → standalone reporter is top pick', () => {
  const rec = recommendInstallMode({ snapshot: baseSnapshot() });
  assert.equal(rec.topPick.args.app, 'reporter');
  assert.equal(rec.topPick.args.shape, 'standalone');
  assert.ok(
    rec.topPick.rationale.toLowerCase().includes('no forwarder detected') ||
      rec.topPick.rationale.toLowerCase().includes('reporter-10x'),
    `rationale should mention the absence of a forwarder or reporter-10x: ${rec.topPick.rationale}`
  );
});

// ── Rule 2: hand-rolled forwarder → standalone (inline would rewrite manifests) ──

test('hand-rolled fluent-bit → standalone reporter is top pick', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [handRolledForwarder('fluent-bit')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluent-bit',
        alreadyInstalled: {},
      },
    }),
  });
  assert.equal(rec.topPick.args.shape, 'standalone');
  // Inline regulator should be in the list but blocked.
  const inlineReg = rec.alternatives.find(
    (a) => a.args.app === 'regulator' && a.args.shape === 'inline' && !a.args.optimize
  );
  assert.ok(inlineReg);
  assert.ok(inlineReg?.blocker?.toLowerCase().includes('not helm-managed'));
});

// ── Rule 3: helm-managed logstash → standalone (chart broken) ──

test('helm-managed logstash → standalone reporter; inline alts blocked', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('logstash')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'logstash',
        alreadyInstalled: {},
      },
    }),
  });
  assert.equal(rec.topPick.args.shape, 'standalone');
  const inlineAlts = rec.alternatives.filter((a) => a.args.shape === 'inline');
  assert.ok(
    inlineAlts.length > 0,
    'inline alts should still be listed so the user sees what was considered'
  );
  assert.ok(
    inlineAlts.every((a) => a.blocker),
    'every inline alt should have a logstash-chart-broken blocker'
  );
});

// ── Rule 4: helm-managed fluent-bit + goal=compact → inline regulator + optimize ──

test('helm-managed fluent-bit + goal=compact → inline regulator + optimize=true', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('fluent-bit')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluent-bit',
        alreadyInstalled: {},
      },
    }),
    goal: 'compact',
  });
  assert.equal(rec.topPick.args.app, 'regulator');
  assert.equal(rec.topPick.args.shape, 'inline');
  assert.equal(rec.topPick.args.optimize, true);
  assert.equal(rec.topPick.args.forwarder, 'fluent-bit');
  assert.equal(rec.topPick.blocker, undefined);
});

test('helm-managed fluentd + goal=compact → inline regulator + optimize=true', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('fluentd')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluentd',
        alreadyInstalled: {},
      },
    }),
    goal: 'compact',
  });
  assert.equal(rec.topPick.args.app, 'regulator');
  assert.equal(rec.topPick.args.optimize, true);
});

// ── Rule 5: helm-managed filebeat + goal=compact → inline regulator + optimize (1.0.7 unified) ──

test('helm-managed filebeat + goal=compact → inline regulator + optimize=true (1.0.7)', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('filebeat')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'filebeat',
        alreadyInstalled: {},
      },
    }),
    goal: 'compact',
  });
  // With chart 1.0.7, filebeat + optimize is no longer blocked.
  const fbOptimize = rec.alternatives.find(
    (a) => a.args.forwarder === 'filebeat' && a.args.shape === 'inline' && a.args.optimize === true
  );
  assert.ok(fbOptimize);
  assert.equal(fbOptimize?.blocker, undefined, `filebeat + optimize should be available on 1.0.7; got: ${fbOptimize?.blocker}`);
  // Top pick for goal=compact on filebeat is the optimize alt itself.
  assert.equal(rec.topPick.args.forwarder, 'filebeat');
  assert.equal(rec.topPick.args.optimize, true);
  assert.equal(rec.topPick.blocker, undefined);
});

// ── Rule 6: helm-managed fluent-bit + goal=cut-cost → inline regulator (no optimize) ──

test('helm-managed fluent-bit + goal=cut-cost → inline regulator (no optimize)', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('fluent-bit')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluent-bit',
        alreadyInstalled: {},
      },
    }),
    goal: 'cut-cost',
  });
  assert.equal(rec.topPick.args.app, 'regulator');
  assert.equal(rec.topPick.args.shape, 'inline');
  // optimize not required for cut-cost — regulate (filter/sample) alone suffices.
  assert.notEqual(rec.topPick.args.optimize, true);
});

// ── Rule 7: helm-managed fluent-bit + goal=just-metrics → inline reporter ──

test('helm-managed fluent-bit + goal=just-metrics → inline reporter', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('fluent-bit')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluent-bit',
        alreadyInstalled: {},
      },
    }),
    goal: 'just-metrics',
  });
  // Either inline reporter OR standalone reporter is acceptable — both match
  // the goal. Assert just-metrics is report-mode (not regulator).
  assert.equal(rec.topPick.args.app, 'reporter');
});

// ── Rule 8: goal=archive without AWS infra → retriever is blocked ──

test('goal=archive without retriever infra → blocked, top pick falls back', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot(),
    goal: 'archive',
  });
  const retrieverAlt = rec.alternatives.find((a) => a.args.app === 'retriever');
  assert.ok(retrieverAlt);
  assert.ok(
    retrieverAlt?.blocker?.toLowerCase().includes('s3') ||
      retrieverAlt?.blocker?.toLowerCase().includes('sqs'),
    `retriever alt should be blocked on missing AWS infra: ${retrieverAlt?.blocker}`
  );
});

// ── Rule 9: goal=archive WITH retriever infra → retriever is top pick ──

test('goal=archive with retriever infra → retriever is top pick', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      aws: {
        available: true,
        region: 'us-east-1',
        s3Buckets: [{ name: 'my-retriever', matchReason: 'name_match', hasIndexingPrefix: true }],
        sqsQueues: [
          { url: 'https://sqs.us-east-1.amazonaws.com/111/retriever-index-queue', name: 'retriever-index-queue', role: 'index' },
        ],
        cwLogGroups: [],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        retrieverS3Bucket: 'my-retriever',
        retrieverSqsUrls: { index: 'https://sqs.us-east-1.amazonaws.com/111/retriever-index-queue' },
        alreadyInstalled: {},
      },
    }),
    goal: 'archive',
  });
  assert.equal(rec.topPick.args.app, 'retriever');
  assert.equal(rec.topPick.blocker, undefined);
});

// ── Rule 10: already-installed reporter → warning surfaced ──

test('already-installed reporter → warning, not a blocker', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      recommendations: {
        suggestedNamespace: 'logging',
        alreadyInstalled: { reporter: 'demo' },
      },
    }),
  });
  assert.ok(
    rec.warnings.some((w) => w.toLowerCase().includes('already installed')),
    `expected already-installed warning; got: ${rec.warnings.join(' | ')}`
  );
  // Top pick should still be valid — warning doesn't block.
  assert.equal(rec.topPick.blocker, undefined);
});

// ── Rule 11: ranking is deterministic + blocked alts always below installable ──

test('ranking sorts installable alts above blocked ones', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('filebeat')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'filebeat',
        alreadyInstalled: {},
      },
    }),
    goal: 'compact',
  });
  // Walk the list: once we see a blocker, no later alt should be unblocked.
  let sawBlocker = false;
  for (const a of rec.alternatives) {
    if (a.blocker) sawBlocker = true;
    else assert.ok(!sawBlocker, `installable alt '${a.label}' should not follow a blocked one`);
  }
});

// ── Rule 12: no goal + helm-managed forwarder → deterministic top pick, no blockers ──

test('no goal + helm-managed fluent-bit → top pick has no blocker, resolved args present', () => {
  const rec = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('fluent-bit')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluent-bit',
        alreadyInstalled: {},
      },
    }),
  });
  assert.equal(rec.topPick.blocker, undefined);
  assert.ok(rec.topPick.args.app);
  assert.ok(rec.topPick.args.shape);
  assert.ok(rec.topPick.args.namespace);
});

// ── Detection summary must mention helm-managed vs hand-rolled ──

test('detectionSummary flags helm-managed vs hand-rolled', () => {
  const recHelm = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [helmForwarder('fluent-bit')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluent-bit',
        alreadyInstalled: {},
      },
    }),
  });
  assert.ok(
    recHelm.detectionSummary.some((s) => s.includes('helm-managed')),
    `detectionSummary should call out helm-managed: ${recHelm.detectionSummary.join(' | ')}`
  );

  const recHand = recommendInstallMode({
    snapshot: baseSnapshot({
      kubectl: {
        ...baseSnapshot().kubectl,
        forwarders: [handRolledForwarder('fluent-bit')],
      },
      recommendations: {
        suggestedNamespace: 'logging',
        existingForwarder: 'fluent-bit',
        alreadyInstalled: {},
      },
    }),
  });
  assert.ok(
    recHand.detectionSummary.some((s) => s.includes('hand-rolled')),
    `detectionSummary should call out hand-rolled: ${recHand.detectionSummary.join(' | ')}`
  );
});
