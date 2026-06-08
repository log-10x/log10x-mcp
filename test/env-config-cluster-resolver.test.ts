/**
 * Tests for resolveClusterConfig bug fixes F1 (unconditional 'default'
 * candidate append) and F8 (corrupt on-prem doc swallowed silently).
 *
 * Note: project uses node:test (not vitest). Cases mirror vitest's
 * describe/it shape using node:test's describe/it.
 *
 * Each test injects its own EnvConfigStore stubs via the `stores` option so
 * we don't touch real K8s/SSM/GCP/Azure/local file backends. process.env is
 * cleared per-test to keep the env-var-fallback path deterministic — the
 * resolver reads LOG10X_* directly via envConfigFromEnvVars() and any
 * leakage from the runner shell would change the outcome.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveClusterConfig,
  type ClusterConfigResolveSuccess,
  type ClusterConfigResolveFailure,
} from '../src/lib/env-config/resolve-cluster-config.js';
import type { EnvConfigStore, StoreKind } from '../src/lib/env-config/store-interface.js';
import type { EnvironmentConfig } from '../src/lib/env-config/types.js';

// Minimal valid EnvironmentConfig factory. Schema requires schema_version,
// env_id, nickname, cluster.type, destination.siem_vendor, at least one
// offload destination, streamer.url, and retriever with bucket + 4 queues.
function makeEnv(envId: string, nickname = envId): EnvironmentConfig {
  return {
    schema_version: '1.0',
    env_id: envId,
    nickname,
    cluster: { type: 'kind' },
    destination: { siem_vendor: 'other' },
    offload_destinations: [
      { nickname: 'primary', type: 's3', status: 'active', bucket: `bucket-${envId}` },
    ],
    streamer: { url: `https://streamer.${envId}.test` },
    retriever: {
      url: `https://retriever.${envId}.test`,
      input_bucket: `archive-${envId}`,
      query_queues: {
        index: `q-index-${envId}`,
        subquery: `q-sub-${envId}`,
        stream: `q-stream-${envId}`,
        query: `q-query-${envId}`,
      },
    },
  };
}

interface StubStoreOpts {
  kind?: StoreKind;
  available?: boolean;
  unavailableReason?: string;
  // Map of envIdOrNickname -> EnvironmentConfig present in this store
  docs?: Record<string, EnvironmentConfig>;
  // envIdOrNickname values that should trigger a corrupt-doc throw
  corrupt?: Set<string>;
}

function makeStubStore(opts: StubStoreOpts = {}): EnvConfigStore {
  const kind: StoreKind = opts.kind ?? 'local';
  const available = opts.available ?? true;
  const docs = opts.docs ?? {};
  const corrupt = opts.corrupt ?? new Set<string>();
  return {
    kind,
    async isAvailable() {
      return available
        ? { available: true, reason: '' }
        : { available: false, reason: opts.unavailableReason ?? 'unavailable in test' };
    },
    async read(envIdOrNickname: string) {
      if (corrupt.has(envIdOrNickname)) {
        throw new Error(`corrupt env-config document for "${envIdOrNickname}" (unparseable JSON)`);
      }
      return docs[envIdOrNickname] ?? null;
    },
    async write() {
      throw new Error('stub store: write not implemented');
    },
    async list() {
      return Object.values(docs);
    },
    async delete() {
      throw new Error('stub store: delete not implemented');
    },
  };
}

const SAVED_ENV = { ...process.env };

function clearLog10xEnvVars() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('LOG10X_')) delete process.env[k];
  }
}

describe('resolveClusterConfig — F1 (no silent default fallback)', () => {
  beforeEach(() => {
    clearLog10xEnvVars();
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('LOG10X_')) delete process.env[k];
    }
    for (const k of Object.keys(SAVED_ENV)) {
      if (k.startsWith('LOG10X_')) process.env[k] = SAVED_ENV[k];
    }
  });

  it('(a) explicit envIdOrNickname=nonexistent, no LOG10X_ENV_ID, no default doc → ok:false naming the requested id', async () => {
    // Store has nothing; no env vars; caller asked for "nonexistent". F1:
    // the resolver must NOT silently push 'default' onto the candidate list.
    const store = makeStubStore({ docs: {} });
    const res = await resolveClusterConfig({
      envIdOrNickname: 'nonexistent',
      stores: [store],
    });
    assert.equal(res.ok, false, 'expected ok:false when explicit id is unknown and no default doc exists');
    const failure = res as ClusterConfigResolveFailure;
    assert.equal(failure.requested_env_id_or_nickname, 'nonexistent', 'failure must echo the originally-requested id');
    // The error message should reference the actual id the caller asked for,
    // not just a generic "could not resolve".
    assert.match(failure.error, /nonexistent/i, `error message should name the requested id; got: ${failure.error}`);
  });

  it('(b) explicit envIdOrNickname=nonexistent WITH default.json present → ok:false (NOT silent substitution)', async () => {
    // This is the F1 keystone: store HAS a 'default' doc that points at a
    // completely different env. Pre-fix, resolveCandidateIds appended
    // 'default' to the candidate chain so the resolver would happily return
    // the default doc and report ok:true under source='on_prem_store'. The
    // caller asked for "nonexistent", not "default" — that's a silent
    // substitution and a footgun. Fixed code must refuse.
    const defaultDoc = makeEnv('env-default-real', 'default');
    const store = makeStubStore({ docs: { default: defaultDoc } });
    const res = await resolveClusterConfig({
      envIdOrNickname: 'nonexistent',
      stores: [store],
    });
    assert.equal(res.ok, false, 'must NOT silently substitute the default doc when caller asked for a different env');
    const failure = res as ClusterConfigResolveFailure;
    assert.equal(failure.requested_env_id_or_nickname, 'nonexistent');
    assert.match(failure.error, /nonexistent/i);
  });

  it('(c) no explicit envIdOrNickname, no LOG10X_ENV_ID, default.json exists → ok:true via default fallback (legitimate use)', async () => {
    // F1 fix MUST preserve the legitimate path: caller has no opinion
    // (CLI tool that just wants whatever env is discoverable), no env vars
    // are set, and the local file store has a 'default' doc. The
    // dev/local-file-store workflow depends on this fallback.
    const defaultDoc = makeEnv('env-default-real', 'default');
    const store = makeStubStore({ docs: { default: defaultDoc } });
    const res = await resolveClusterConfig({ stores: [store] });
    assert.equal(res.ok, true, 'legitimate "default" fallback must still work when caller passes no id');
    const success = res as ClusterConfigResolveSuccess;
    assert.equal(success.source, 'on_prem_store');
    assert.equal(success.config.env_id, 'env-default-real');
    assert.equal(success.requested_env_id_or_nickname, undefined, 'no explicit id → requested_env_id_or_nickname is undefined');
  });
});

describe('resolveClusterConfig — F8 (corrupt on-prem doc must not be silently dropped)', () => {
  beforeEach(() => {
    clearLog10xEnvVars();
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('LOG10X_')) delete process.env[k];
    }
    for (const k of Object.keys(SAVED_ENV)) {
      if (k.startsWith('LOG10X_')) process.env[k] = SAVED_ENV[k];
    }
  });

  it('(d) explicit envIdOrNickname resolves to corrupt on-prem doc → failure exposes a warning naming the corrupt-doc scenario', async () => {
    // Caller asked for "prod-east". The (sole) store reports available,
    // and reading "prod-east" throws (corrupt JSON). Pre-F8, the resolver
    // would either (a) swallow the throw and return env-var fallback with
    // no warning, or (b) return ok:false with only the throw's message —
    // either way, the caller has no structured signal that the on-prem
    // doc was present-but-unparseable. Fixed shape must surface a
    // resolution_warnings entry that explicitly names the scenario.
    const store = makeStubStore({
      kind: 'local',
      docs: {},
      corrupt: new Set(['prod-east']),
    });
    const res = await resolveClusterConfig({
      envIdOrNickname: 'prod-east',
      stores: [store],
    });
    // Either ok:false (no fallback satisfied the schema — the expected
    // outcome in this test since we set no LOG10X_* vars), or ok:true via
    // a fallback path that captured the warning. Both shapes must carry
    // resolution_warnings.
    const warnings: string[] = res.ok
      ? (res as ClusterConfigResolveSuccess).resolution_warnings
      : (res as ClusterConfigResolveFailure).resolution_warnings;
    assert.ok(Array.isArray(warnings), 'resolution_warnings field must be present on result shape');
    assert.ok(
      warnings.some(w => /unparseable|corrupt/i.test(w) && /prod-east|local/i.test(w)),
      `warnings must explicitly name the corrupt-doc scenario; got: ${JSON.stringify(warnings)}`,
    );
    if (!res.ok) {
      const failure = res as ClusterConfigResolveFailure;
      assert.equal(failure.requested_env_id_or_nickname, 'prod-east', 'failure must echo originally-requested id');
    }
  });
});
