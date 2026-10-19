/**
 * The budget run reads Datadog with a personal access token (DD_PAT, sent as
 * a Bearer token) or with the API and application key pair, and its CronJob
 * and GitHub Actions run pass either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { datadogMetricsCredsFromEnv, ddQueryPoints } from '../src/lib/datadog-metrics-read.js';
import { emitGitHubActions, emitK8sCronJob, type PolicyOptions } from '../src/lib/scheduler-manifest-emitter.js';

const KEYS = ['DD_PAT', 'DATADOG_PAT', 'DD_API_KEY', 'DATADOG_API_KEY', 'DD_APP_KEY', 'DATADOG_APP_KEY', 'DD_SITE', 'DATADOG_SITE'];

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('DD_PAT alone is enough, and a query sends it as a Bearer token', async () => {
  const creds = withEnv({ DD_PAT: 'pat-value', DD_SITE: 'us5.datadoghq.com' }, () => datadogMetricsCredsFromEnv());
  assert.ok(creds, 'DD_PAT alone gives credentials');
  const realFetch = globalThis.fetch;
  let sent: Record<string, string> = {};
  let url = '';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    url = String(input);
    sent = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    return new Response(JSON.stringify({ status: 'ok', series: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await ddQueryPoints(creds!, 'sum:x{*}', 0, 3600);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(url, /^https:\/\/api\.us5\.datadoghq\.com\/api\/v1\/query/);
  assert.equal(sent['Authorization'], 'Bearer pat-value');
  assert.equal(sent['DD-API-KEY'], undefined);
  assert.equal(sent['DD-APPLICATION-KEY'], undefined);
});

test('the key pair still works, and an API key alone is not enough', () => {
  const pair = withEnv({ DD_API_KEY: 'a', DD_APP_KEY: 'b' }, () => datadogMetricsCredsFromEnv());
  assert.deepEqual(pair, { site: 'datadoghq.com', apiKey: 'a', appKey: 'b' });
  assert.equal(withEnv({ DD_API_KEY: 'a' }, () => datadogMetricsCredsFromEnv()), undefined);
});

const budget = {
  target_services: [],
  target_percent: 30,
  schedule: 'hourly',
  scheduler: 'k8s_cron',
  config_plane: 'https://github.com/acme/log10x-config',
  exceptions: [],
  min_delta_pp: 2,
  budget_usd_monthly: 20_000,
  standard_indexes: ['main'],
  namespace: 'logging',
} as PolicyOptions;

test('the budget CronJob and GitHub Actions run pass DD_PAT, and no key is required by the pod', () => {
  const m = emitK8sCronJob(budget);
  for (const k of ['DD_PAT', 'DD_API_KEY', 'DD_APP_KEY', 'DD_SITE']) {
    assert.match(m, new RegExp(`key: ${k}\\n\\s+optional: true`), `${k} is optional in the Secret`);
  }
  const w = emitGitHubActions({ ...budget, scheduler: 'github_actions', nodes_by_container: { checkout: 3 } } as PolicyOptions);
  assert.match(w, /DD_PAT: \$\{\{ secrets\.DD_PAT \}\}/);
});
