import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnv, setLastUsed, type Environments, type EnvConfig } from '../src/lib/environments.js';
import { createMetricsBackend } from '../src/lib/metrics-backend.js';
import { DEFAULT_LABELS } from '../src/lib/promql.js';

// `loadEnvironments` always hits `GET /api/v1/user` now (the env-var-only
// fast paths were removed in the credential-resolution simplification).
// That makes it integration-only — see `test/integration/`.
//
// What stays here: pure-function tests for `resolveEnv` (the chain
// every tool callback uses to pick an env) and `setLastUsed`. No
// network, no env vars.

function makeTestBackend(apiKey: string, envId: string) {
  return createMetricsBackend({ kind: 'log10x', apiKey, envId });
}

function makeEnvs(): Environments {
  const a: EnvConfig = {
    nickname: 'prod', apiKey: 'k', envId: 'eP', isDefault: true, permissions: 'OWNER',
    metricsBackend: makeTestBackend('k', 'eP'), labels: { ...DEFAULT_LABELS },
  };
  const b: EnvConfig = {
    nickname: 'demo', apiKey: 'k', envId: 'eD', permissions: 'READ',
    metricsBackend: makeTestBackend('k', 'eD'), labels: { ...DEFAULT_LABELS },
  };
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
    (err: Error) => /Unknown environment "nonexistent"/.test(err.message) && /prod; demo/.test(err.message)
  );
});

test('setLastUsed: pinned env overrides resolveEnv default fallback', () => {
  const envs = makeEnvs();
  setLastUsed(envs, envs.byNickname.get('demo')!);
  assert.equal(resolveEnv(envs).nickname, 'demo');
});

// ── Phase 3 paths: env vars + envs.json + both-set detection ───────────

import { loadEnvironments, EnvironmentValidationError } from '../src/lib/environments.js';
import { beforeEach, afterEach } from 'node:test';
import { writeFile, mkdir, unlink, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

const SAVED_ENV = { ...process.env };
const SAVED_HOME = process.env.HOME;
let tmpHome: string | undefined;

const METRICS_ENV_KEYS = [
  'LOG10X_METRICS_BACKEND_KIND',
  'LOG10X_METRICS_URL',
  'LOG10X_METRICS_AUTH_TYPE',
  'LOG10X_METRICS_AUTH_VALUE',
  'LOG10X_METRICS_AUTH_USER',
  'LOG10X_METRICS_AUTH_HEADER_NAME',
  'LOG10X_METRICS_NICKNAME',
  'LOG10X_METRICS_MIMIR_ORG_ID',
  'LOG10X_METRICS_CORTEX_ORG_ID',
  'LOG10X_METRICS_AMP_REGION',
  'LOG10X_METRICS_DATADOG_SITE',
  'LOG10X_METRICS_GRAFANA_USER',
  'LOG10X_METRICS_GCP_PROJECT_ID',
  'LOG10X_METRICS_LABEL_PATTERN',
  'LOG10X_METRICS_LABEL_SERVICE',
  'LOG10X_METRICS_LABEL_SEVERITY',
  'LOG10X_METRICS_LABEL_ENV',
  'LOG10X_API_KEY',
  'LOG10X_ENV_ID',
  'DD_API_KEY',
  'DD_APP_KEY',
  'DD_SITE',
  'GRAFANA_CLOUD_API_KEY',
];

beforeEach(async () => {
  for (const k of METRICS_ENV_KEYS) delete process.env[k];
  // Redirect ~ to a fresh empty dir so envs.json isn't read from the
  // real user home.
  tmpHome = await mkdtemp(join(tmpdir(), 'log10x-env-test-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  for (const k of METRICS_ENV_KEYS) delete process.env[k];
  for (const k of METRICS_ENV_KEYS) {
    if (SAVED_ENV[k] !== undefined) process.env[k] = SAVED_ENV[k] as string;
  }
  if (SAVED_HOME !== undefined) process.env.HOME = SAVED_HOME;
});

test('phase 3: LOG10X_METRICS_BACKEND_KIND=prometheus builds a single env from env vars', async () => {
  process.env.LOG10X_METRICS_BACKEND_KIND = 'prometheus';
  process.env.LOG10X_METRICS_URL = 'http://prom.test:9090';
  process.env.LOG10X_METRICS_AUTH_TYPE = 'none';
  const envs = await loadEnvironments();
  assert.equal(envs.all.length, 1);
  assert.equal(envs.all[0].nickname, 'default');
  assert.equal(envs.all[0].metricsBackend.kind, 'prometheus');
  assert.equal(envs.all[0].metricsBackend.endpoint, 'http://prom.test:9090');
  assert.equal(envs.isDemoMode, false);
});

test('phase 3: LOG10X_METRICS_NICKNAME overrides default nickname', async () => {
  process.env.LOG10X_METRICS_BACKEND_KIND = 'prometheus';
  process.env.LOG10X_METRICS_URL = 'http://prom.test:9090';
  process.env.LOG10X_METRICS_AUTH_TYPE = 'none';
  process.env.LOG10X_METRICS_NICKNAME = 'acme-prod';
  const envs = await loadEnvironments();
  assert.equal(envs.all[0].nickname, 'acme-prod');
});

test('phase 3: LOG10X_METRICS_LABEL_* overrides the per-env label map', async () => {
  process.env.LOG10X_METRICS_BACKEND_KIND = 'prometheus';
  process.env.LOG10X_METRICS_URL = 'http://prom.test:9090';
  process.env.LOG10X_METRICS_AUTH_TYPE = 'none';
  process.env.LOG10X_METRICS_LABEL_SERVICE = 'service';
  process.env.LOG10X_METRICS_LABEL_PATTERN = 'pattern_hash';
  const envs = await loadEnvironments();
  assert.equal(envs.all[0].labels.service, 'service');
  assert.equal(envs.all[0].labels.pattern, 'pattern_hash');
  // unset labels retain defaults
  assert.equal(envs.all[0].labels.severity, DEFAULT_LABELS.severity);
});

test('phase 3: missing required env var for kind throws clear error', async () => {
  process.env.LOG10X_METRICS_BACKEND_KIND = 'prometheus';
  // LOG10X_METRICS_URL unset
  await assert.rejects(
    () => loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /LOG10X_METRICS_URL/.test(err.message)
  );
});

test('phase 3: ~/.log10x/envs.json is read when present', async () => {
  const dir = join(tmpHome!, '.log10x');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'envs.json'),
    JSON.stringify([
      {
        nickname: 'acme-prod',
        metricsBackend: { kind: 'prometheus', url: 'http://prom.acme:9090', auth: { type: 'none' } },
        isDefault: true,
      },
      {
        nickname: 'acme-staging',
        metricsBackend: { kind: 'mimir', url: 'http://mimir.acme:9009', auth: { type: 'none' }, orgId: 'staging' },
      },
    ])
  );
  const envs = await loadEnvironments();
  assert.equal(envs.all.length, 2);
  assert.equal(envs.default.nickname, 'acme-prod');
  assert.equal(envs.all[0].metricsBackend.kind, 'prometheus');
  assert.equal(envs.all[1].metricsBackend.kind, 'mimir');
});

test('demo license: LOG10X_LICENSE_JWT resolves to a log10x_demo env (no api key)', async () => {
  // payload decodes to {"tenant_id":"demo-xyz"}
  const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJkZW1vLXh5eiJ9.sig';
  process.env.LOG10X_LICENSE_JWT = jwt;
  try {
    const envs = await loadEnvironments();
    assert.equal(envs.all.length, 1);
    assert.equal(envs.default.nickname, 'demo');
    assert.equal(envs.default.metricsBackend.kind, 'log10x_demo');
    assert.equal(envs.default.metricsBackend.endpoint, 'https://prometheus.log10x.com');
    assert.equal(envs.isDemoMode, true);
    assert.equal(envs.default.apiKey, '');
    // tenant id is decoded from the JWT for display
    assert.equal(envs.default.envId, 'demo-xyz');
  } finally {
    delete process.env.LOG10X_LICENSE_JWT;
  }
});

test('phase 3: both env vars AND envs.json set → MCP refuses to start', async () => {
  process.env.LOG10X_METRICS_BACKEND_KIND = 'prometheus';
  process.env.LOG10X_METRICS_URL = 'http://prom.test:9090';
  process.env.LOG10X_METRICS_AUTH_TYPE = 'none';
  const dir = join(tmpHome!, '.log10x');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'envs.json'),
    JSON.stringify([
      {
        nickname: 'acme-prod',
        metricsBackend: { kind: 'prometheus', url: 'http://prom.acme:9090', auth: { type: 'none' } },
      },
    ])
  );
  await assert.rejects(
    () => loadEnvironments(),
    (err: Error) => err instanceof EnvironmentValidationError && /Both LOG10X_METRICS_/.test(err.message)
  );
});

test('phase 3: malformed envs.json throws clear error', async () => {
  const dir = join(tmpHome!, '.log10x');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'envs.json'), '{ not an array }');
  await assert.rejects(() => loadEnvironments(), /not valid JSON/);
});

test('phase 3: envs.json missing required field throws with entry index', async () => {
  const dir = join(tmpHome!, '.log10x');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'envs.json'),
    JSON.stringify([{ nickname: 'incomplete' }])
  );
  await assert.rejects(() => loadEnvironments(), /entry #0.*missing/);
});
