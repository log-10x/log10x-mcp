/**
 * advise-retriever wizard tests.
 *
 * Covers:
 *   - Step advancement: each answer advances the wizard to the next question
 *   - Snapshot expiry: missing snapshot returns 'missing_snapshot' mode
 *   - infra_mode branches: terraform / cli / existing all reach plan emission
 *   - IRSA verification step: step 5 asks for iam_role_arn, shape is 'string'
 *   - markdown is non-empty at each step (must_render_verbatim equivalent)
 *   - shape/question_id present when a decision is pending (must_ask_user equivalent)
 *   - actions point back to log10x_advise_retriever (not mis-routing to other tools)
 *   - session isolation: each snapshot_id has its own state
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { executeAdviseRetriever } from '../../src/tools/advise-retriever.js';
import {
  putSnapshot,
  _clearSnapshotStore,
} from '../../src/lib/discovery/snapshot-store.js';
import type { DiscoverySnapshot } from '../../src/lib/discovery/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../../src/lib/discovery/types.js';

// Redirect disk state to a temp subdir per test run so tests don't collide.
const TEST_STATE_DIR = join(tmpdir(), `retriever-wizard-test-${randomUUID()}`);
process.env.LOG10X_ADVISOR_STATE_DIR = TEST_STATE_DIR;
// This wizard does a live demo-license fetch, and getOrMintDemoLicense()
// persists the result. Redirect that write to a throwaway temp path so it never
// lands in the shared default (~/.log10x/demo-license.json) and leak a demo env
// into other tests' environment resolution (e.g. preview_filter).
process.env.LOG10X_DEMO_LICENSE_PATH = join(TEST_STATE_DIR, 'demo-license.json');

// ── Snapshot factories ────────────────────────────────────────────────────────

function freshId(): string {
  return `disc-rwiz-${randomUUID()}`;
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
      serviceAccountIrsa: [],
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
    },
    probeLog: [],
    ...overrides,
  };
}

/** Snapshot where all infra is pre-detected (happy path). */
function richSnap(id: string): DiscoverySnapshot {
  return baseSnap(id, {
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
      serviceAccountIrsa: [
        {
          namespace: 'logging',
          name: 'tenx-retriever',
          roleArn: 'arn:aws:iam::111:role/tenx-retriever',
        },
      ],
    },
    recommendations: {
      suggestedNamespace: 'logging',
      alreadyInstalled: {},
      retrieverS3Bucket: 'tenx-logs-111',
      retrieverSqsUrls: {
        index: 'https://sqs.us-east-1.amazonaws.com/111/tenx-index',
        query: 'https://sqs.us-east-1.amazonaws.com/111/tenx-query',
        subquery: 'https://sqs.us-east-1.amazonaws.com/111/tenx-subquery',
        stream: 'https://sqs.us-east-1.amazonaws.com/111/tenx-stream',
      },
    },
  });
}

/** Data block from a StructuredOutput. */
function data(out: object): Record<string, unknown> {
  return (out as { data: Record<string, unknown> }).data;
}

/** Convenience: call the wizard with license bypassed via paste mode. */
async function call(
  snapId: string,
  extra: Record<string, unknown> = {}
): Promise<ReturnType<typeof executeAdviseRetriever>> {
  return executeAdviseRetriever({
    snapshot_id: snapId,
    license_source: 'demo',
    ...extra,
  } as Parameters<typeof executeAdviseRetriever>[0]);
}

// ── Snapshot expiry / missing snapshot ───────────────────────────────────────

test('wizard: missing snapshot returns missing_snapshot mode', async () => {
  _clearSnapshotStore();
  const out = await call('disc-rwiz-does-not-exist-xyz');
  const d = data(out);
  assert.equal(d.mode, 'missing_snapshot');
  assert.equal(d.ok, false);
  // Markdown must be non-empty (must_render_verbatim equivalent).
  assert.ok(
    typeof d.markdown === 'string' && (d.markdown as string).length > 0,
    'missing_snapshot: markdown must be non-empty'
  );
  // Actions must recommend log10x_discover_env.
  const acts = (out as { actions: Array<{ tool: string }> }).actions;
  assert.ok(
    acts.some((a) => a.tool === 'log10x_discover_env'),
    'missing_snapshot: actions must include log10x_discover_env'
  );
  // No wizard chaining back to itself — user must re-discover first.
  assert.ok(
    !acts.some((a) => a.tool === 'log10x_advise_retriever'),
    'missing_snapshot: should not re-suggest advise_retriever before re-discover'
  );
});

// ── Step advancement (OIDC not detected path) ─────────────────────────────────

test('wizard step 1: no OIDC + AWS available => oidc-check question', async () => {
  _clearSnapshotStore();
  const id = freshId();
  // AWS available + no serviceAccountIrsa entries = OIDC probably off.
  const snap = baseSnap(id, {
    aws: { available: true, region: 'us-east-1', s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [], // no IRSA = OIDC not detected
    },
  });
  putSnapshot(snap);

  const out = await call(id);
  const d = data(out);
  assert.equal(d.mode, 'next_question');
  assert.equal(d.question_id, 'oidc-check');
  // shape is present and has type 'info' with resolutions.
  const shape = d.shape as { type: string; resolutions?: unknown[] };
  assert.equal(shape.type, 'info');
  assert.ok(Array.isArray(shape.resolutions) && shape.resolutions.length >= 2,
    'oidc-check: shape.resolutions must have at least 2 choices');
  // markdown non-empty.
  assert.ok(typeof d.markdown === 'string' && (d.markdown as string).length > 50,
    'oidc-check: markdown must have content');
  // Actions re-invoke advise_retriever (locked on this tool).
  const acts = (out as { actions: Array<{ tool: string }> }).actions;
  assert.ok(
    acts.some((a) => a.tool === 'log10x_advise_retriever'),
    'oidc-check: required-next action must re-invoke advise_retriever'
  );
});

// ── Step advancement (OIDC assumed enabled via IRSA entries) ─────────────────

test('wizard step 2: OIDC enabled but no full infra => infra-review question', async () => {
  _clearSnapshotStore();
  const id = freshId();
  // One IRSA entry (unrelated to retriever) = OIDC assumed enabled.
  const snap = baseSnap(id, {
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [
        { namespace: 'logging', name: 'some-other-sa', roleArn: 'arn:aws:iam::111:role/other' },
      ],
    },
  });
  putSnapshot(snap);

  const out = await call(id);
  const d = data(out);
  assert.equal(d.mode, 'next_question');
  assert.equal(d.question_id, 'infra-review');
  const shape = d.shape as { type: string; choices?: Array<{ value: string }> };
  assert.equal(shape.type, 'single-choice');
  assert.ok(Array.isArray(shape.choices));
  const choiceValues = (shape.choices ?? []).map((c) => c.value);
  assert.ok(choiceValues.includes('terraform'), 'infra-review choices must include terraform');
  assert.ok(choiceValues.includes('cli'), 'infra-review choices must include cli');
  assert.ok(choiceValues.includes('existing'), 'infra-review choices must include existing');
  // markdown must be non-empty.
  assert.ok(typeof d.markdown === 'string' && (d.markdown as string).length > 50);
});

test('wizard step 2 → step 3 terraform: infra-review answered, no infra => infra instructions', async () => {
  _clearSnapshotStore();
  const id = freshId();
  const snap = baseSnap(id, {
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [
        { namespace: 'logging', name: 'other-sa', roleArn: 'arn:aws:iam::111:role/other' },
      ],
    },
  });
  putSnapshot(snap);

  // Step 1: get infra-review.
  const step1 = await call(id);
  assert.equal(data(step1).question_id, 'infra-review');

  // Step 2: answer infra_mode = terraform.
  const step2 = await call(id, { infra_mode: 'terraform' });
  const d = data(step2);
  assert.equal(d.mode, 'next_question');
  // Should be on an infra-provision question (input-bucket or sqs-urls).
  assert.ok(
    d.question_id === 'input-bucket' || d.question_id === 'sqs-urls',
    `expected input-bucket or sqs-urls; got ${String(d.question_id)}`
  );
  // markdown must contain terraform content.
  assert.ok(
    typeof d.markdown === 'string' && (d.markdown as string).toLowerCase().includes('terraform'),
    'terraform step: markdown must mention terraform'
  );
});

test('wizard step 2 → step 3 cli: infra-review answered with cli => cli instructions', async () => {
  _clearSnapshotStore();
  const id = freshId();
  const snap = baseSnap(id, {
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [
        { namespace: 'logging', name: 'other-sa', roleArn: 'arn:aws:iam::111:role/other' },
      ],
    },
  });
  putSnapshot(snap);

  // Answer infra_mode = cli on first call (short-circuits infra-review step).
  const out = await call(id, { infra_mode: 'cli' });
  const d = data(out);
  assert.equal(d.mode, 'next_question');
  // Markdown must contain CLI provisioning content.
  assert.ok(
    typeof d.markdown === 'string' && (d.markdown as string).includes('aws '),
    'cli step: markdown must include aws CLI commands'
  );
  // The IRSA verification snippet appears in the CLI instructions.
  assert.ok(
    (d.markdown as string).includes('sts') || (d.markdown as string).includes('AssumeRole'),
    'cli step: markdown must include IRSA/STS verification command'
  );
});

// ── IRSA verification step ────────────────────────────────────────────────────

test('wizard step 5: all infra except IRSA => irsa-role question with string shape', async () => {
  _clearSnapshotStore();
  const id = freshId();
  // Bucket + all SQS present, but NO IRSA SA for retriever.
  const snap = baseSnap(id, {
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [
        { namespace: 'logging', name: 'other-sa', roleArn: 'arn:aws:iam::111:role/other' },
      ],
    },
    recommendations: {
      suggestedNamespace: 'logging',
      alreadyInstalled: {},
      retrieverS3Bucket: 'tenx-logs-111',
      retrieverSqsUrls: {
        index: 'https://sqs.us-east-1.amazonaws.com/111/tenx-index',
        query: 'https://sqs.us-east-1.amazonaws.com/111/tenx-query',
        subquery: 'https://sqs.us-east-1.amazonaws.com/111/tenx-subquery',
        stream: 'https://sqs.us-east-1.amazonaws.com/111/tenx-stream',
      },
    },
  });
  putSnapshot(snap);

  // Answer infra_mode = existing, so the wizard skips provisioning steps.
  const out = await call(id, { infra_mode: 'existing' });
  const d = data(out);
  // Should land on irsa-role (bucket + SQS resolved, IRSA missing).
  assert.equal(d.mode, 'next_question');
  assert.equal(d.question_id, 'irsa-role',
    `expected irsa-role; got ${String(d.question_id)}`);
  const shape = d.shape as { type: string; answer_field?: string };
  assert.equal(shape.type, 'string',
    'irsa-role shape must be type:string');
  assert.equal(shape.answer_field, 'iam_role_arn',
    'irsa-role shape.answer_field must be iam_role_arn');
  // Markdown must mention IRSA role ARN (rewrite renders "IRSA" uppercase).
  assert.ok(
    typeof d.markdown === 'string' && (d.markdown as string).toLowerCase().includes('irsa'),
    'irsa-role markdown must mention irsa'
  );
  // The answer in the next call with iam_role_arn advances past this step.
  const step2 = await call(id, {
    iam_role_arn: 'arn:aws:iam::111:role/tenx-retriever',
  });
  const d2 = data(step2);
  // Should no longer be asking for irsa-role.
  assert.ok(d2.question_id !== 'irsa-role',
    `should advance past irsa-role; still on ${String(d2.question_id)}`);
});

// ── infra_mode branches reach plan emission ───────────────────────────────────

test('wizard: existing infra mode + pasted license => emits plan', async () => {
  _clearSnapshotStore();
  const id = freshId();
  putSnapshot(richSnap(id));

  // Rich snapshot has all infra detected. Provide paste license to skip live fetch.
  const out = await call(id, {
    infra_mode: 'existing',
    license_source: 'paste',
    license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
  });
  const d = data(out);
  assert.equal(d.mode, 'plan',
    `expected plan mode; got ${String(d.mode)}: ${String(d.human_summary ?? '').slice(0, 200)}`);
  // human_summary is the must_render_verbatim equivalent in plan mode.
  assert.ok(typeof d.human_summary === 'string' && (d.human_summary as string).length > 0,
    'plan: human_summary must be non-empty');
});

test('wizard: terraform infra mode + all infra supplied + pasted license => emits plan', async () => {
  _clearSnapshotStore();
  const id = freshId();
  const snap = baseSnap(id, {
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [
        { namespace: 'logging', name: 'other-sa', roleArn: 'arn:aws:iam::111:role/other' },
      ],
    },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
  });
  putSnapshot(snap);

  // Supply all infra values in one call (legacy one-shot compat + terraform mode).
  const out = await call(id, {
    infra_mode: 'terraform',
    index_source_bucket: 'tenx-logs-111',
    index_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-index',
    query_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-query',
    subquery_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-subquery',
    stream_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-stream',
    iam_role_arn: 'arn:aws:iam::111:role/tenx-retriever',
    license_source: 'paste',
    license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
  });
  const d = data(out);
  assert.equal(d.mode, 'plan',
    `expected plan; got ${String(d.mode)}: ${String(d.human_summary ?? '').slice(0, 200)}`);
  // Plan notes should include the terraform mode annotation.
  // The wizard injects a note about terraform into plan.notes when infraMode='terraform'.
  const notes = d.notes as string[] | undefined;
  assert.ok(
    Array.isArray(notes) && notes.some((n) => n.toLowerCase().includes('terraform')),
    `terraform plan: notes must mention terraform; got: ${JSON.stringify(notes)}`
  );
});

test('wizard: cli infra mode + all infra supplied + pasted license => emits plan', async () => {
  _clearSnapshotStore();
  const id = freshId();
  const snap = baseSnap(id, {
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [
        { namespace: 'logging', name: 'other-sa', roleArn: 'arn:aws:iam::111:role/other' },
      ],
    },
  });
  putSnapshot(snap);

  const out = await call(id, {
    infra_mode: 'cli',
    index_source_bucket: 'tenx-logs-111',
    index_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-index',
    query_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-query',
    subquery_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-subquery',
    stream_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-stream',
    iam_role_arn: 'arn:aws:iam::111:role/tenx-retriever',
    license_source: 'paste',
    license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
  });
  const d = data(out);
  assert.equal(d.mode, 'plan',
    `expected plan; got ${String(d.mode)}: ${String(d.human_summary ?? '').slice(0, 200)}`);
  // The wizard injects a note about CLI provisioning into plan.notes when infraMode='cli'.
  const notes = d.notes as string[] | undefined;
  assert.ok(
    Array.isArray(notes) && notes.some((n) => n.toLowerCase().includes('cli') || n.toLowerCase().includes('aws')),
    `cli plan: notes must mention aws CLI; got: ${JSON.stringify(notes)}`
  );
});

// ── Session accumulation / state advances ─────────────────────────────────────

test('wizard: session accumulates answers across calls', async () => {
  _clearSnapshotStore();
  const id = freshId();
  // Snapshot with OIDC-enabled (IRSA entries), but no retriever infra.
  const snap = baseSnap(id, {
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [
        { namespace: 'logging', name: 'other-sa', roleArn: 'arn:aws:iam::111:role/other' },
      ],
    },
  });
  putSnapshot(snap);

  // Call 1: should be at infra-review.
  const c1 = await call(id);
  assert.equal(data(c1).question_id, 'infra-review', 'call 1 should be infra-review');

  // Call 2: answer infra_mode = existing (no infra detected, must supply manually).
  const c2 = await call(id, { infra_mode: 'existing' });
  const d2 = data(c2);
  // Missing infra: should ask input-bucket (first missing).
  assert.equal(d2.mode, 'next_question');
  assert.ok(
    d2.question_id === 'input-bucket' || d2.question_id === 'sqs-urls',
    `call 2: expected input-bucket or sqs-urls; got ${String(d2.question_id)}`
  );

  // Call 3: supply index_source_bucket; infra_mode remembered from call 2.
  const c3 = await call(id, { index_source_bucket: 'my-logs-bucket' });
  const d3 = data(c3);
  assert.equal(d3.mode, 'next_question');
  // Should now be asking for SQS URLs.
  assert.ok(
    d3.question_id === 'sqs-urls',
    `call 3: expected sqs-urls; got ${String(d3.question_id)}`
  );

  // Call 4: supply all SQS URLs.
  const c4 = await call(id, {
    index_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-index',
    query_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-query',
    subquery_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-subquery',
    stream_queue_url: 'https://sqs.us-east-1.amazonaws.com/111/tenx-stream',
  });
  const d4 = data(c4);
  assert.equal(d4.mode, 'next_question');
  assert.equal(d4.question_id, 'irsa-role',
    `call 4: expected irsa-role; got ${String(d4.question_id)}`);

  // Call 5: supply IRSA ARN.
  const c5 = await call(id, {
    iam_role_arn: 'arn:aws:iam::111:role/tenx-retriever',
    license_source: 'paste',
    license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
  });
  const d5 = data(c5);
  assert.equal(d5.mode, 'plan',
    `call 5: expected plan; got ${String(d5.mode)}: ${String(d5.human_summary ?? '').slice(0, 200)}`);
});

// ── Actions routing / forbidden_next_actions equivalent ──────────────────────

test('wizard: next_question actions always re-invoke log10x_advise_retriever', async () => {
  _clearSnapshotStore();
  const id = freshId();
  const snap = baseSnap(id, {
    kubectl: {
      ...baseSnap(id).kubectl,
      serviceAccountIrsa: [
        { namespace: 'logging', name: 'other-sa', roleArn: 'arn:aws:iam::111:role/other' },
      ],
    },
  });
  putSnapshot(snap);

  const out = await call(id);
  const d = data(out);
  assert.equal(d.mode, 'next_question');
  const acts = (out as { actions: Array<{ tool: string; role?: string }> }).actions;
  // At least one required-next action must point back to advise_retriever.
  const retrieverAction = acts.find((a) => a.tool === 'log10x_advise_retriever');
  assert.ok(retrieverAction,
    'next_question: actions must include log10x_advise_retriever');
  assert.equal(retrieverAction!.role, 'required-next',
    'next_question: advise_retriever action must be required-next');
});

test('wizard: plan actions do not re-invoke advise_retriever as required-next', async () => {
  _clearSnapshotStore();
  const id = freshId();
  putSnapshot(richSnap(id));

  const out = await call(id, {
    license_source: 'paste',
    license_jwt_paste: 'eyJtb2NrIjoidGVzdCJ9',
  });
  const d = data(out);
  assert.equal(d.mode, 'plan');
  const acts = (out as { actions: Array<{ tool: string; role?: string }> }).actions;
  // advise_retriever must NOT be a required-next on a completed plan.
  const retrieverReqNext = acts.find(
    (a) => a.tool === 'log10x_advise_retriever' && a.role === 'required-next'
  );
  assert.ok(!retrieverReqNext,
    'plan: advise_retriever must not be required-next once plan is emitted');
  // Post-plan actions should include doctor or top_patterns.
  assert.ok(
    acts.some((a) => a.tool === 'log10x_doctor' || a.tool === 'log10x_top_patterns'),
    'plan: actions should suggest log10x_doctor or log10x_top_patterns as followup'
  );
});

// ── Session isolation ─────────────────────────────────────────────────────────

test('wizard: two snapshot_ids have independent sessions', async () => {
  _clearSnapshotStore();
  const id1 = freshId();
  const id2 = freshId();

  // Both snapshots have OIDC-enabled (IRSA entries).
  const makeSnap = (id: string) =>
    baseSnap(id, {
      kubectl: {
        ...baseSnap(id).kubectl,
        serviceAccountIrsa: [
          { namespace: 'logging', name: 'other-sa', roleArn: 'arn:aws:iam::111:role/other' },
        ],
      },
    });
  putSnapshot(makeSnap(id1));
  putSnapshot(makeSnap(id2));

  // Advance id1 to terraform mode.
  await call(id1, { infra_mode: 'terraform' });

  // id2 should still be at infra-review (unaffected by id1's session).
  const out2 = await call(id2);
  assert.equal(data(out2).question_id, 'infra-review',
    'id2 session must be independent of id1');
});

// ── unknown_args guard ────────────────────────────────────────────────────────

test('wizard: unknown arg returns unknown_args mode with suggestions', async () => {
  _clearSnapshotStore();
  const id = freshId();
  putSnapshot(richSnap(id));

  // Pass a known synonym to verify the suggestion mechanism.
  const out = await executeAdviseRetriever({
    snapshot_id: id,
    license_source: 'demo',
    // 'role_arn' is a known synonym for 'iam_role_arn'.
    role_arn: 'arn:aws:iam::111:role/tenx-retriever',
  } as unknown as Parameters<typeof executeAdviseRetriever>[0]);
  const d = data(out);
  assert.equal(d.mode, 'unknown_args');
  assert.ok(Array.isArray(d.unknown_keys));
  assert.ok((d.unknown_keys as string[]).includes('role_arn'));
  // Suggestion must point to iam_role_arn.
  const sugs = d.suggestions as Array<{ unknown: string; did_you_mean: string | null }>;
  const match = sugs.find((s) => s.unknown === 'role_arn');
  assert.ok(match && match.did_you_mean === 'iam_role_arn',
    `expected suggestion iam_role_arn; got ${String(match?.did_you_mean)}`);
});

// ── Auto-skip to existing when all infra detected ─────────────────────────────

test('wizard: all infra detected => auto-sets existing and asks for license only', async () => {
  _clearSnapshotStore();
  const id = freshId();
  putSnapshot(richSnap(id));

  // First call with no answers — wizard should auto-detect 'existing' and skip
  // to license acquisition (demo license path returns plan or signin_required).
  const out = await call(id);
  const d = data(out);
  // When auto-existing + demo license succeeds, we get a plan.
  // When license fails live fetch, we get signin_required or license_error.
  // Either way, wizard must NOT be asking infra-review on full snapshot.
  assert.ok(
    d.mode === 'plan' || d.mode === 'signin_required' || d.mode === 'license_error',
    `expected plan/signin_required/license_error on full snapshot; got ${String(d.mode)}`
  );
});
