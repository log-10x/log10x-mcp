import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnv, setLastUsed, type Environments, type EnvConfig } from '../src/lib/environments.js';

// `loadEnvironments` always hits `GET /api/v1/user` now (the env-var-only
// fast paths were removed in the credential-resolution simplification).
// That makes it integration-only — see `test/integration/`.
//
// What stays here: pure-function tests for `resolveEnv` (the chain
// every tool callback uses to pick an env) and `setLastUsed`. No
// network, no env vars.

function makeEnvs(): Environments {
  const a: EnvConfig = { nickname: 'prod', apiKey: 'k', envId: 'eP', isDefault: true, permissions: 'OWNER' };
  const b: EnvConfig = { nickname: 'demo', apiKey: 'k', envId: 'eD', permissions: 'READ' };
  return {
    all: [a, b],
    byNickname: new Map([['prod', a], ['demo', b]]),
    default: a,
    isDemoMode: false,
  };
}

test('resolveEnv: no nickname returns the user default', () => {
  const envs = makeEnvs();
  assert.equal(resolveEnv(envs).nickname, 'prod');
});

test('resolveEnv: explicit nickname returns that env (case-insensitive)', () => {
  const envs = makeEnvs();
  assert.equal(resolveEnv(envs, 'demo').nickname, 'demo');
  assert.equal(resolveEnv(envs, 'DEMO').nickname, 'demo');
});

test('resolveEnv: explicit nickname records lastUsed; unscoped follow-up sticks', () => {
  const envs = makeEnvs();
  assert.equal(resolveEnv(envs, 'demo').nickname, 'demo');
  // Subsequent call with no nickname should resolve to lastUsed (demo), NOT default (prod).
  assert.equal(resolveEnv(envs).nickname, 'demo');
  // Naming the default explicitly switches lastUsed back.
  assert.equal(resolveEnv(envs, 'prod').nickname, 'prod');
  assert.equal(resolveEnv(envs).nickname, 'prod');
});

test('resolveEnv: unknown nickname throws with available list', () => {
  const envs = makeEnvs();
  assert.throws(
    () => resolveEnv(envs, 'nonexistent'),
    (err: Error) => /Unknown environment "nonexistent"/.test(err.message) && /prod, demo/.test(err.message)
  );
});

test('setLastUsed: pinned env overrides resolveEnv default fallback', () => {
  const envs = makeEnvs();
  setLastUsed(envs, envs.byNickname.get('demo')!);
  assert.equal(resolveEnv(envs).nickname, 'demo');
});
