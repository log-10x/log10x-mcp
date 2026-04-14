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

test('single-env load succeeds with both vars set', () => {
  process.env.LOG10X_API_KEY = 'k';
  process.env.LOG10X_ENV_ID = 'e';
  const envs = loadEnvironments();
  assert.equal(envs.all.length, 1);
  assert.equal(envs.default.nickname, 'default');
});

test('throws EnvironmentValidationError when no env vars set', () => {
  assert.throws(
    () => loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /LOG10X_API_KEY/.test(err.message)
  );
});

test('multi-env load succeeds with valid JSON array', () => {
  process.env.LOG10X_ENVS = JSON.stringify([
    { nickname: 'prod', apiKey: 'k1', envId: 'e1' },
    { nickname: 'staging', apiKey: 'k2', envId: 'e2' },
  ]);
  const envs = loadEnvironments();
  assert.equal(envs.all.length, 2);
  assert.equal(envs.default.nickname, 'prod');
  assert.equal(envs.byNickname.get('staging')?.envId, 'e2');
});

test('multi-env throws on malformed JSON with structured error', () => {
  process.env.LOG10X_ENVS = '{not valid';
  assert.throws(
    () => loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /not valid JSON/.test(err.message)
  );
});

test('multi-env throws on missing required fields with path info', () => {
  process.env.LOG10X_ENVS = JSON.stringify([{ nickname: 'prod', apiKey: '' }]);
  assert.throws(
    () => loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /apiKey|envId/.test(err.message)
  );
});

test('multi-env rejects duplicate nicknames', () => {
  process.env.LOG10X_ENVS = JSON.stringify([
    { nickname: 'prod', apiKey: 'k', envId: 'e' },
    { nickname: 'PROD', apiKey: 'k2', envId: 'e2' },
  ]);
  assert.throws(
    () => loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /Duplicate/.test(err.message)
  );
});
