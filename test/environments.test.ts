import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvironments, EnvironmentValidationError } from '../src/lib/environments.js';

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.LOG10X_API_KEY;
  delete process.env.LOG10X_ENV_ID;
  delete process.env.LOG10X_ENVS;
});

afterEach(() => {
  for (const k of Object.keys(SAVED_ENV)) {
    process.env[k] = SAVED_ENV[k] as string;
  }
});

// `loadEnvironments` is async since the autodiscovery rewrite — the
// LOG10X_API_KEY-alone path hits GET /api/v1/user. The legacy single-env
// (LOG10X_API_KEY + LOG10X_ENV_ID) and multi-env (LOG10X_ENVS JSON) paths
// still complete without a network call, so we can unit-test them.
//
// The "no env vars" path now falls back to the public demo key, which DOES
// hit the network. That branch is exercised in integration tests, not here.

test('single-env load succeeds with both vars set', async () => {
  process.env.LOG10X_API_KEY = 'k';
  process.env.LOG10X_ENV_ID = 'e';
  const envs = await loadEnvironments();
  assert.equal(envs.all.length, 1);
  assert.equal(envs.default.nickname, 'default');
  assert.equal(envs.isDemoMode, false);
  assert.equal(envs.autodiscovered, false);
});

test('multi-env load succeeds with valid JSON array', async () => {
  process.env.LOG10X_ENVS = JSON.stringify([
    { nickname: 'prod', apiKey: 'k1', envId: 'e1' },
    { nickname: 'staging', apiKey: 'k2', envId: 'e2' },
  ]);
  const envs = await loadEnvironments();
  assert.equal(envs.all.length, 2);
  assert.equal(envs.default.nickname, 'prod');
  assert.equal(envs.byNickname.get('staging')?.envId, 'e2');
  assert.equal(envs.isDemoMode, false);
});

test('multi-env throws on malformed JSON with structured error', async () => {
  process.env.LOG10X_ENVS = '{not valid';
  await assert.rejects(
    loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /not valid JSON/.test(err.message)
  );
});

test('multi-env throws on missing required fields with path info', async () => {
  process.env.LOG10X_ENVS = JSON.stringify([{ nickname: 'prod', apiKey: '' }]);
  await assert.rejects(
    loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /apiKey|envId/.test(err.message)
  );
});

test('multi-env rejects duplicate nicknames', async () => {
  process.env.LOG10X_ENVS = JSON.stringify([
    { nickname: 'prod', apiKey: 'k', envId: 'e' },
    { nickname: 'PROD', apiKey: 'k2', envId: 'e2' },
  ]);
  await assert.rejects(
    loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /Duplicate/.test(err.message)
  );
});
