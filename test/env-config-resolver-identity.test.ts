/**
 * F2 regression: the env-var fallback branch of `resolveEnvConfig` used to
 * accept ANY schema-valid partial regardless of identity. That meant a typo
 * like `env_id="prod-eks-eats"` would silently substitute whichever env's
 * partial was packaged in LOG10X_* vars (typically the demo env) and return
 * it as `source='env_var_fallback'`, breaking the resolver's "never returns
 * a partial" promise (in the worse possible way: returning the WRONG full
 * config).
 *
 * These tests pin the identity check: the env-var partial is only acceptable
 * when its env_id OR nickname matches the requested envIdOrNickname.
 *
 * Bonus: trace comprehensiveness — when the partial is rejected for
 * identity-mismatch, the resolution_trace must surface the rejection so
 * downstream callers can warn about stale env vars.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveEnvConfig,
  EnvConfigResolutionError,
} from '../src/lib/env-config/resolver.js';
import type { EnvironmentConfig } from '../src/lib/env-config/types.js';
import type { EnvConfigStore, StoreKind } from '../src/lib/env-config/store-interface.js';

// ── helpers ──────────────────────────────────────────────────────────────

function makeFullConfig(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  return {
    schema_version: '1.0',
    env_id: 'demo-env-id',
    nickname: 'demo',
    cluster: { type: 'eks', region: 'us-east-1' },
    destination: { siem_vendor: 'datadog' },
    offload_destinations: [
      { nickname: 'primary', type: 's3', status: 'active', bucket: 'demo-bucket' },
    ],
    streamer: { url: 'http://streamer.demo.svc:8080' },
    retriever: {
      url: 'http://retriever.demo.svc:8080',
      input_bucket: 'demo-archive',
      query_queues: {
        index: 'arn:aws:sqs:us-east-1:000:idx',
        subquery: 'arn:aws:sqs:us-east-1:000:sub',
        stream: 'arn:aws:sqs:us-east-1:000:stm',
        query: 'arn:aws:sqs:us-east-1:000:qry',
      },
    },
    ...overrides,
  };
}

/** A store that reports unavailable — used to force the resolver into the env-var branch. */
function makeUnavailableStore(kind: StoreKind, reason = 'test: store offline'): EnvConfigStore {
  return {
    kind,
    isAvailable: async () => ({ available: false, reason }),
    read: async () => null,
    write: async () => undefined,
    list: async () => [],
    delete: async () => undefined,
  };
}

// ── tests ────────────────────────────────────────────────────────────────

describe('resolveEnvConfig: env-var fallback identity check (F2)', () => {
  it('rejects env-var partial whose env_id/nickname does not match the request', async () => {
    const envVarPartial = makeFullConfig({ env_id: 'demo-env-id', nickname: 'demo' });

    let caught: EnvConfigResolutionError | undefined;
    try {
      await resolveEnvConfig({
        envIdOrNickname: 'prod-eks-eats',
        stores: [makeUnavailableStore('local')],
        envVarFallback: envVarPartial,
      });
    } catch (err) {
      caught = err as EnvConfigResolutionError;
    }

    assert.ok(caught instanceof EnvConfigResolutionError, 'must throw EnvConfigResolutionError');
    assert.equal(
      caught!.trace.some(t => t.source === 'env_var_fallback' && t.status === 'matched'),
      false,
      'env_var_fallback must NOT have matched',
    );

    const envVarStep = caught!.trace.find(t => t.source === 'env_var_fallback');
    assert.ok(envVarStep, 'trace must contain an env_var_fallback step');
    assert.equal(envVarStep!.status, 'skipped');
    assert.ok(envVarStep!.reason.includes('does not match requested'), `reason missing 'does not match requested': ${envVarStep!.reason}`);
    assert.ok(envVarStep!.reason.includes('prod-eks-eats'), `reason missing 'prod-eks-eats': ${envVarStep!.reason}`);
    assert.ok(envVarStep!.reason.includes('demo-env-id'), `reason missing 'demo-env-id': ${envVarStep!.reason}`);
    assert.ok(envVarStep!.reason.includes('demo'), `reason missing 'demo': ${envVarStep!.reason}`);
  });

  it('accepts env-var partial when env_id matches the requested name', async () => {
    const envVarPartial = makeFullConfig({ env_id: 'prod-eks', nickname: 'production' });

    const result = await resolveEnvConfig({
      envIdOrNickname: 'prod-eks',
      stores: [makeUnavailableStore('local')],
      envVarFallback: envVarPartial,
    });

    assert.equal(result.source, 'env_var_fallback');
    assert.equal(result.config.env_id, 'prod-eks');
    const matched = result.resolution_trace.find(
      t => t.source === 'env_var_fallback' && t.status === 'matched',
    );
    assert.ok(matched, 'must surface a matched env_var_fallback trace entry');
  });

  it('accepts env-var partial when nickname matches even if env_id does not', async () => {
    const envVarPartial = makeFullConfig({ env_id: 'uuid-aaaa-bbbb', nickname: 'staging' });

    const result = await resolveEnvConfig({
      envIdOrNickname: 'staging',
      stores: [makeUnavailableStore('local')],
      envVarFallback: envVarPartial,
    });

    assert.equal(result.source, 'env_var_fallback');
    assert.equal(result.config.nickname, 'staging');
  });

  it('trace surfaces ALL skipped sources when nothing matches (F8 comprehensiveness)', async () => {
    const envVarPartial = makeFullConfig({ env_id: 'demo-env-id', nickname: 'demo' });

    let caught: EnvConfigResolutionError | undefined;
    try {
      await resolveEnvConfig({
        envIdOrNickname: 'totally-unknown-env',
        stores: [
          makeUnavailableStore('k8s', 'no kubeconfig'),
          makeUnavailableStore('aws_ssm', 'no AWS creds'),
        ],
        envVarFallback: envVarPartial,
      });
    } catch (err) {
      caught = err as EnvConfigResolutionError;
    }

    assert.ok(caught instanceof EnvConfigResolutionError);
    const sources = caught!.trace.map(t => t.source);
    assert.ok(sources.includes('explicit_arg'));
    assert.ok(sources.includes('store:k8s'));
    assert.ok(sources.includes('store:aws_ssm'));
    assert.ok(sources.includes('env_var_fallback'));
    for (const step of caught!.trace) {
      assert.ok(step.reason.length > 0, `step ${step.source} has empty reason`);
    }
  });
});
