/**
 * Regression test for the env-config store-chain split bug.
 *
 * Original bug: env_register wrote to the K8sConfigMapStore (top of the
 * resolver chain), but env_diff_vs_envvars / dest_set / env_validate /
 * retriever_register hardcoded `new LocalFileStore()` for their reads.
 * Result: writer and readers used different backends, so a freshly-
 * registered doc came back as "env_not_found" from every manage tool.
 *
 * Fix: every tool walks the same store chain (k8s → aws_ssm → gcp_sm →
 * azure_ac → local), reads through it, and writes back to the SAME store
 * the read resolved against — so an edit doesn't shadow the source of
 * truth on the next read.
 *
 * These tests use in-memory fake stores that implement the EnvConfigStore
 * contract. We never touch the real cloud SDKs or `~/.log10x` — both would
 * be flaky on a clean CI box and would also defeat the purpose of testing
 * the chain (we want to assert which store handled each call).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvConfigStore, StoreKind } from '../src/lib/env-config/store-interface.js';
import type { EnvironmentConfig } from '../src/lib/env-config/types.js';
import {
  executeDestSet,
  executeEnvDiffVsEnvvars,
  executeEnvValidate,
} from '../src/tools/env-config-manage.js';
import { executeRetrieverRegister } from '../src/tools/retriever-register.js';

// ── fake store ──────────────────────────────────────────────────────────────

/**
 * In-memory env-config store keyed by env_id (with nickname fallback on
 * read, matching the LocalFileStore semantics). The `available` flag lets
 * us simulate "this store has no creds" without throwing during isAvailable.
 *
 * Read/write counters are exposed so tests can assert which backend
 * actually handled each call — the original bug would have passed a
 * "find the doc somewhere" assertion while still routing reads to the
 * wrong backend.
 */
class FakeStore implements EnvConfigStore {
  readonly kind: StoreKind;
  available: boolean;
  docs: Map<string, EnvironmentConfig>;
  readCount = 0;
  writeCount = 0;

  constructor(kind: StoreKind, available: boolean = true) {
    this.kind = kind;
    this.available = available;
    this.docs = new Map();
  }

  async isAvailable(): Promise<{ available: boolean; reason: string }> {
    return { available: this.available, reason: this.available ? 'fake' : 'fake unavailable' };
  }

  async read(envIdOrNickname: string): Promise<EnvironmentConfig | null> {
    this.readCount += 1;
    const byId = this.docs.get(envIdOrNickname);
    if (byId) return byId;
    for (const doc of this.docs.values()) {
      if (doc.nickname === envIdOrNickname) return doc;
    }
    return null;
  }

  async write(config: EnvironmentConfig): Promise<void> {
    this.writeCount += 1;
    this.docs.set(config.env_id, config);
  }

  async list(): Promise<EnvironmentConfig[]> {
    return Array.from(this.docs.values());
  }

  async delete(envId: string): Promise<void> {
    this.docs.delete(envId);
  }
}

/**
 * A minimal valid EnvironmentConfig — enough fields to satisfy the schema.
 * Tests that care about a specific field override it on top of this.
 */
function makeEnvDoc(env_id: string, nickname: string): EnvironmentConfig {
  return {
    schema_version: '1.0',
    env_id,
    nickname,
    cluster: {
      type: 'eks',
      region: 'us-east-1',
      account: '123456789012',
    },
    destination: {
      siem_vendor: 'datadog',
      region: 'us-east-1',
    },
    offload_destinations: [
      {
        nickname: 'primary',
        type: 's3',
        status: 'active',
        bucket: 'acme-offload',
        region: 'us-east-1',
      },
    ],
    streamer: {
      url: 'https://streamer.acme.internal:8443',
    },
    retriever: {
      url: 'https://retriever.acme.internal:8443',
      input_bucket: 'acme-archive',
      query_queues: {
        index: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-index',
        subquery: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-subquery',
        stream: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-stream',
        query: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-query',
      },
    },
    updated_at: '2026-06-06T00:00:00.000Z',
  };
}

/**
 * Extract the structured `data` payload from a tool envelope. We don't
 * care about formatting / headlines here — the assertion is on whether
 * the tool found the doc and on the `store_used` field that pins which
 * backend handled the call.
 */
function envelopeData(out: unknown): Record<string, unknown> {
  // StructuredOutput envelopes are objects with a `data` key holding the
  // tool-specific payload; the helper buildEnvelope() guarantees this shape.
  const o = out as { data?: Record<string, unknown> };
  assert.ok(o && o.data, 'envelope must have a .data payload');
  return o.data!;
}

// ── (a) regression of the actual reported bug ────────────────────────────────

test(
  'env_diff_vs_envvars finds a doc that env_register wrote to the k8s store (regression)',
  async () => {
    const k8s = new FakeStore('k8s');
    const ssm = new FakeStore('aws_ssm');
    const local = new FakeStore('local');
    const chain = [k8s, ssm, local];

    // Simulate env_register writing to the highest-precedence store.
    const doc = makeEnvDoc('env-abc', 'acme-prod');
    await k8s.write(doc);

    const out = await executeEnvDiffVsEnvvars({ env_id: 'env-abc' }, chain);
    const data = envelopeData(out);

    assert.equal(data.ok, true, 'must find the doc that env_register persisted');
    assert.equal(data.env_id, 'env-abc');
    assert.equal(data.nickname, 'acme-prod');
    assert.equal(
      data.store_used,
      'k8s',
      'reader must report the same backend the writer used',
    );
    // Crucially: local should never have been hit because k8s answered.
    assert.equal(local.readCount, 0, 'local file store must not be read when k8s has the doc');
  },
);

// ── (b) write-after-read goes to the SAME store ──────────────────────────────

test(
  'dest_set reads from k8s and writes back to k8s (not local)',
  async () => {
    const k8s = new FakeStore('k8s');
    const ssm = new FakeStore('aws_ssm');
    const local = new FakeStore('local');
    const chain = [k8s, ssm, local];

    const doc = makeEnvDoc('env-xyz', 'acme-staging');
    await k8s.write(doc);
    // Clear write-counter so the "1 write" assertion below covers the
    // dest_set call only, not the test setup write above.
    k8s.writeCount = 0;

    const out = await executeDestSet(
      {
        env_id: 'env-xyz',
        siem_vendor: 'splunk',
        region: 'us-west-2',
        ingest_url: 'https://splunk.acme.internal:8088/services/collector',
      },
      chain,
    );
    const data = envelopeData(out);

    assert.equal(data.ok, true);
    assert.equal(data.store_used, 'k8s', 'edit reports back the store it wrote to');

    assert.equal(k8s.writeCount, 1, 'k8s store received the destination edit');
    assert.equal(local.writeCount, 0, 'local store must not be written to');
    assert.equal(ssm.writeCount, 0, 'ssm store must not be written to');

    // The persisted doc must carry the new destination — proves we wrote
    // the merged config, not just the read-through one.
    const persisted = await k8s.read('env-xyz');
    assert.ok(persisted, 'env doc still resolvable from k8s');
    assert.equal(persisted!.destination.siem_vendor, 'splunk');
    assert.equal(persisted!.destination.region, 'us-west-2');
  },
);

// ── (c) LocalFile path still works (no regression on the dev fallback) ───────

test(
  'env_diff_vs_envvars reads from local when only local has the doc',
  async () => {
    const k8s = new FakeStore('k8s', /* available */ false);
    const ssm = new FakeStore('aws_ssm', /* available */ false);
    const local = new FakeStore('local');
    const chain = [k8s, ssm, local];

    const doc = makeEnvDoc('env-local', 'dev-laptop');
    await local.write(doc);

    const out = await executeEnvDiffVsEnvvars({ env_id: 'env-local' }, chain);
    const data = envelopeData(out);

    assert.equal(data.ok, true, 'local fallback resolves the doc');
    assert.equal(data.store_used, 'local');
  },
);

// ── (d) retriever_register falls through when an earlier store has no doc ────

test(
  'retriever_register cleanly falls through k8s (empty) to ssm (has doc)',
  async () => {
    const k8s = new FakeStore('k8s');                  // available, empty
    const ssm = new FakeStore('aws_ssm');              // available, has the doc
    const local = new FakeStore('local');              // available, empty
    const chain = [k8s, ssm, local];

    const doc = makeEnvDoc('env-mid', 'mid-tier');
    await ssm.write(doc);
    ssm.writeCount = 0; // exclude setup write from the assertion below

    const out = await executeRetrieverRegister(
      {
        env_id: 'env-mid',
        url: 'https://retriever.acme.internal:8443',
        input_bucket: 'acme-archive-2',
        query_queues: {
          index: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-index-2',
          subquery: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-subquery-2',
          stream: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-stream-2',
          query: 'https://sqs.us-east-1.amazonaws.com/123456789012/q-query-2',
        },
      },
      chain,
    );
    const data = envelopeData(out);

    assert.equal(data.ok, true, 'retriever_register found the doc in the second store');
    assert.equal(ssm.writeCount, 1, 'edit landed in the same store the read found the doc in');
    assert.equal(local.writeCount, 0, 'edit must not be sprayed to lower-precedence backends');
    assert.equal(k8s.writeCount, 0, 'edit must not land in the higher-precedence backend that had nothing');

    // The persisted doc must carry the new retriever block.
    const persisted = await ssm.read('env-mid');
    assert.ok(persisted, 'env doc still resolvable from ssm');
    assert.equal(persisted!.retriever.input_bucket, 'acme-archive-2');
  },
);

// ── env_validate also walks the chain (covers the 4th hardcoded LocalFileStore) ──

test(
  'env_validate finds the doc via the k8s store',
  async () => {
    const k8s = new FakeStore('k8s');
    const local = new FakeStore('local');
    const chain = [k8s, local];

    const doc = makeEnvDoc('env-val', 'val-test');
    await k8s.write(doc);

    const out = await executeEnvValidate({ env_id: 'env-val' }, chain);
    const data = envelopeData(out);

    assert.equal(data.env_id, 'env-val', 'validate resolved the right env');
    assert.equal(data.store_used, 'k8s');
    assert.equal(data.schema_passed, true);
    assert.equal(local.readCount, 0, 'local must not be touched when k8s answered');
  },
);

// ── env_not_found across the WHOLE chain still surfaces a clean envelope ─────

test(
  'env_diff_vs_envvars returns env_not_found when no store has the doc',
  async () => {
    const k8s = new FakeStore('k8s');
    const ssm = new FakeStore('aws_ssm');
    const local = new FakeStore('local');
    const chain = [k8s, ssm, local];

    // No doc anywhere.
    const out = await executeEnvDiffVsEnvvars({ env_id: 'env-missing' }, chain);
    const data = envelopeData(out);

    assert.equal(data.ok, false);
    assert.equal(data.env_id, 'env-missing');
    assert.match(
      String(data.error),
      /any configured store/i,
      'error message must hint that the resolver walked the full chain',
    );
  },
);
