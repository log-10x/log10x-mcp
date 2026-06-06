/**
 * advise-retriever — F4 bug fix: env-config bucket precedence vs user input.
 *
 * BUG: The wizard's nextQuestion() consulted only session.inputBucket and
 * the snapshot. The env-config doc was loaded ONLY at plan-emission time,
 * and the precedence chain there let envCfgActiveOffload.bucket WIN over
 * session.inputBucket SILENTLY — the user's typed answer was discarded
 * without a warning.
 *
 * FIX: env-config is resolved BEFORE nextQuestion. When an active offload
 * bucket exists, it becomes the resolved input bucket (no question asked).
 * When the user separately supplied a different bucket, env-config still
 * wins (it's the cluster's declared source of truth), and a warning is
 * surfaced on the envelope: "User-supplied bucket X differs from env-config
 * bucket Y; using Y per env-config precedence."
 *
 * Cases:
 *   (a) env-config has active offload bucket; user did NOT supply one
 *       → no input-bucket question; plan uses env-config bucket; no
 *         disagreement warning.
 *   (b) env-config has active offload bucket; user DID supply a different
 *       one → plan uses env-config bucket (precedence preserved); envelope
 *       warning fires and mentions BOTH bucket names.
 *   (c) no env-config doc → original ask-and-use behavior preserved
 *       (regression check — the bug fix must NOT break the no-env-config
 *       path).
 *
 * Runner: node:test (the project's standard runner).
 *
 * The advise-retriever module exposes _setResolveClusterConfigForTests as
 * a test seam, so we don't have to monkey-patch real K8s/SSM/GCP/Azure/
 * local-file stores. Each test installs its own deterministic resolver.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  executeAdviseRetriever,
  _setResolveClusterConfigForTests,
} from '../src/tools/advise-retriever.js';
import {
  putSnapshot,
  _clearSnapshotStore,
} from '../src/lib/discovery/snapshot-store.js';
import type { DiscoverySnapshot } from '../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../src/lib/discovery/types.js';
import type { EnvironmentConfig } from '../src/lib/env-config/types.js';
import type { ClusterConfigResolveResult } from '../src/lib/env-config/resolve-cluster-config.js';

// Redirect retriever-session disk state to a temp subdir so tests don't
// leak across runs or collide with the existing wizard tests.
const TEST_STATE_DIR = join(tmpdir(), `retriever-bucket-test-${randomUUID()}`);
process.env.LOG10X_ADVISOR_STATE_DIR = TEST_STATE_DIR;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function freshId(): string {
  return `disc-rbuck-${randomUUID()}`;
}

function baseSnap(id: string, overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    startedAt: '2026-06-01T00:00:00Z',
    finishedAt: '2026-06-01T00:00:10Z',
    kubectl: {
      available: true,
      context: 'arn:aws:eks:us-east-1:111:cluster/test',
      namespaces: ['logging', 'default'],
      probedNamespaces: ['logging'],
      forwarders: [],
      helmReleases: [],
      log10xApps: [],
      storageClasses: ['gp3'],
      ingressClasses: ['alb'],
      backendAgents: [],
      // OIDC assumed enabled — IRSA entry present so the wizard skips
      // the OIDC step and doesn't get stuck before the bucket question.
      serviceAccountIrsa: [
        {
          namespace: 'logging',
          name: 'tenx-retriever',
          roleArn: 'arn:aws:iam::111:role/tenx-retriever',
        },
      ],
    },
    aws: {
      available: true,
      region: 'us-east-1',
      s3Buckets: [],
      sqsQueues: [],
      cwLogGroups: [],
    },
    recommendations: {
      suggestedNamespace: 'logging',
      alreadyInstalled: {},
      // All four SQS URLs pre-detected so the wizard isn't blocked on
      // those questions; we want to exercise the input-bucket path.
      retrieverSqsUrls: {
        index: 'https://sqs.us-east-1.amazonaws.com/111/tenx-index',
        query: 'https://sqs.us-east-1.amazonaws.com/111/tenx-query',
        subquery: 'https://sqs.us-east-1.amazonaws.com/111/tenx-subquery',
        stream: 'https://sqs.us-east-1.amazonaws.com/111/tenx-stream',
      },
    },
    probeLog: [],
    ...overrides,
  };
}

function makeEnvCfg(bucket: string): EnvironmentConfig {
  return {
    schema_version: '1.0',
    env_id: 'test-env',
    nickname: 'test',
    cluster: { type: 'kind' },
    destination: { siem_vendor: 'other' },
    offload_destinations: [
      {
        nickname: 'primary',
        type: 's3',
        status: 'active',
        bucket,
      },
    ],
    streamer: { url: 'https://streamer.test' },
    retriever: {
      url: 'https://retriever.test',
      input_bucket: bucket,
      query_queues: {
        index: 'https://sqs.us-east-1.amazonaws.com/111/tenx-index',
        subquery: 'https://sqs.us-east-1.amazonaws.com/111/tenx-subquery',
        stream: 'https://sqs.us-east-1.amazonaws.com/111/tenx-stream',
        query: 'https://sqs.us-east-1.amazonaws.com/111/tenx-query',
      },
    },
  };
}

function envCfgPresentResolver(bucket: string): () => Promise<ClusterConfigResolveResult> {
  return async () => ({
    ok: true,
    config: makeEnvCfg(bucket),
    source: 'on_prem_store',
    source_store_kind: 'local',
    stale_env_var_warnings: [],
    resolution_warnings: [],
    resolution_trace: [
      { source: 'store:local', status: 'matched', reason: 'test injected' },
    ],
  });
}

function envCfgAbsentResolver(): () => Promise<ClusterConfigResolveResult> {
  return async () => ({
    ok: false,
    error: 'no env-config doc in any store (test)',
    resolution_warnings: [],
    resolution_trace: [
      { source: 'store:local', status: 'skipped', reason: 'no doc (test)' },
    ],
  });
}

function data(out: object): Record<string, unknown> {
  return (out as { data: Record<string, unknown> }).data;
}

function warnings(out: object): string[] {
  return ((out as { warnings?: string[] }).warnings ?? []) as string[];
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  _clearSnapshotStore();
});

afterEach(() => {
  // Clear the resolver override so a leaked stub doesn't poison the
  // sibling test files that share the same process.
  _setResolveClusterConfigForTests(undefined);
});

// ── Case (a): env-config bucket present, user did NOT supply one ─────────────

test(
  'F4 (a): env-config active offload bucket present, user did NOT supply ' +
    'inputBucket → bucket question skipped; final plan uses env-config bucket',
  async () => {
    const id = freshId();
    putSnapshot(baseSnap(id));
    _setResolveClusterConfigForTests(envCfgPresentResolver('env-cfg-bucket-aaa'));

    const out = await executeAdviseRetriever({
      snapshot_id: id,
      infra_mode: 'existing',
      // No index_source_bucket supplied — wizard previously asked, now
      // env-config is authoritative.
      license_source: 'paste',
      license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
    } as Parameters<typeof executeAdviseRetriever>[0]);

    const d = data(out);
    // The wizard should NOT be asking for input-bucket — env-config has
    // already supplied it. We accept either plan emission OR a downstream
    // question (e.g. IRSA / license) — but NOT input-bucket.
    assert.notStrictEqual(
      d.question_id,
      'input-bucket',
      `case (a): wizard should not ask input-bucket when env-config has one; ` +
        `got mode=${String(d.mode)} question_id=${String(d.question_id)}`,
    );

    // We expect a plan in this fixture (rich snapshot + license paste +
    // env-config bucket supplies the last missing infra value).
    assert.strictEqual(
      d.mode,
      'plan',
      `case (a): expected plan mode; got ${String(d.mode)}: ` +
        `${String(d.human_summary ?? '').slice(0, 200)}`,
    );

    // No disagreement warning fires — user didn't supply anything.
    const ws = warnings(out);
    assert.ok(
      !ws.some((w) => w.includes('differs from env-config bucket')),
      `case (a): no precedence-mismatch warning expected; got: ${JSON.stringify(ws)}`,
    );

    // The plan envelope should reference the env-config bucket somewhere
    // downstream — we check both the markdown (rendered plan) and the
    // human_summary if available.
    const markdown = String(d.markdown ?? '');
    const hasBucket = markdown.includes('env-cfg-bucket-aaa');
    assert.ok(
      hasBucket,
      `case (a): plan markdown should reference env-config bucket; ` +
        `markdown snippet: ${markdown.slice(0, 400)}`,
    );
  },
);

// ── Case (b): env-config bucket present, user supplied a DIFFERENT one ──────

test(
  'F4 (b): env-config bucket present AND user supplied a different one → ' +
    'precedence warning fires; final plan uses env-config bucket',
  async () => {
    const id = freshId();
    putSnapshot(baseSnap(id));
    _setResolveClusterConfigForTests(envCfgPresentResolver('env-cfg-bucket-WINS'));

    const out = await executeAdviseRetriever({
      snapshot_id: id,
      infra_mode: 'existing',
      // User supplies an explicitly DIFFERENT bucket.
      index_source_bucket: 'user-typed-bucket-LOSES',
      license_source: 'paste',
      license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
    } as Parameters<typeof executeAdviseRetriever>[0]);

    const d = data(out);
    assert.strictEqual(
      d.mode,
      'plan',
      `case (b): expected plan; got ${String(d.mode)}: ` +
        `${String(d.human_summary ?? '').slice(0, 200)}`,
    );

    // Precedence-mismatch warning fires AND mentions BOTH bucket names.
    const ws = warnings(out);
    const mismatch = ws.find(
      (w) =>
        w.includes('user-typed-bucket-LOSES') &&
        w.includes('env-cfg-bucket-WINS'),
    );
    assert.ok(
      mismatch,
      `case (b): warning should mention BOTH bucket names; got warnings: ` +
        `${JSON.stringify(ws)}`,
    );
    assert.ok(
      mismatch!.toLowerCase().includes('env-config'),
      `case (b): warning should explain env-config precedence; got: ${mismatch}`,
    );

    // Final plan markdown contains the env-config bucket (winner), NOT
    // the user's typed bucket (loser).
    const markdown = String(d.markdown ?? '');
    assert.ok(
      markdown.includes('env-cfg-bucket-WINS'),
      `case (b): plan should reference env-config bucket; ` +
        `markdown snippet: ${markdown.slice(0, 400)}`,
    );
    assert.ok(
      !markdown.includes('user-typed-bucket-LOSES'),
      `case (b): plan should NOT reference user's bucket (env-config wins); ` +
        `markdown snippet: ${markdown.slice(0, 400)}`,
    );
  },
);

// ── Case (c): no env-config doc → original ask-and-use behavior ──────────────

test(
  'F4 (c): no env-config doc → original ask-and-use behavior preserved; ' +
    "user-supplied bucket flows through to the plan and no spurious warning fires",
  async () => {
    const id = freshId();
    putSnapshot(baseSnap(id));
    _setResolveClusterConfigForTests(envCfgAbsentResolver());

    // Sub-case 1: user does NOT supply a bucket → wizard asks for it.
    const askOut = await executeAdviseRetriever({
      snapshot_id: id,
      infra_mode: 'existing',
      license_source: 'paste',
      license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
    } as Parameters<typeof executeAdviseRetriever>[0]);
    const askData = data(askOut);
    assert.strictEqual(
      askData.mode,
      'next_question',
      `case (c-1): no env-config + no user bucket should ask a question; ` +
        `got mode=${String(askData.mode)}`,
    );
    assert.strictEqual(
      askData.question_id,
      'input-bucket',
      `case (c-1): should ask for input-bucket; got ${String(askData.question_id)}`,
    );
    // No disagreement warning when there's no env-config to disagree with.
    const askWarnings = warnings(askOut);
    assert.ok(
      !askWarnings.some((w) => w.includes('differs from env-config bucket')),
      `case (c-1): no precedence-mismatch warning when there's no env-config; ` +
        `got: ${JSON.stringify(askWarnings)}`,
    );

    // Sub-case 2: user supplies a bucket → wizard accepts it and emits a
    // plan using the user-supplied value (original behavior).
    const planOut = await executeAdviseRetriever({
      snapshot_id: id,
      infra_mode: 'existing',
      index_source_bucket: 'user-supplied-bucket',
      license_source: 'paste',
      license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
    } as Parameters<typeof executeAdviseRetriever>[0]);
    const planData = data(planOut);
    assert.strictEqual(
      planData.mode,
      'plan',
      `case (c-2): expected plan; got ${String(planData.mode)}: ` +
        `${String(planData.human_summary ?? '').slice(0, 200)}`,
    );
    const planWarnings = warnings(planOut);
    assert.ok(
      !planWarnings.some((w) => w.includes('differs from env-config bucket')),
      `case (c-2): no precedence-mismatch warning expected when there's no ` +
        `env-config doc; got: ${JSON.stringify(planWarnings)}`,
    );
    const markdown = String(planData.markdown ?? '');
    assert.ok(
      markdown.includes('user-supplied-bucket'),
      `case (c-2): plan should reference user's bucket; markdown snippet: ` +
        `${markdown.slice(0, 400)}`,
    );
  },
);
