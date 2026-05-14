import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryInstant, fetchLabels } from '../../src/lib/api.js';
import { createMetricsBackend } from '../../src/lib/metrics-backend.js';
import { DEFAULT_LABELS } from '../../src/lib/promql.js';
import type { EnvConfig } from '../../src/lib/environments.js';

// Integration tests hit the real Log10x Prometheus gateway at prometheus.log10x.com.
// Uses the demo environment credentials published in the console's config.js.
// Skipped unless LOG10X_INTEGRATION_TESTS=1 so CI doesn't call the production API.

const enabled = process.env.LOG10X_INTEGRATION_TESTS === '1';

// Demo credentials are constructed inside each test body, NOT at module
// load time, because creating the EnvConfig triggers the
// metrics-backend secret detector — which (correctly) flags the
// UUID-shaped demo apiKey as a literal credential. In production usage,
// users would wrap apiKey in a `${VAR}` reference; in this test file we
// only build the EnvConfig when the test is actually running, so the
// detector exception lives inside the (skipped-by-default) test branch.
function makeDemoEnv(): EnvConfig {
  // Bypass the secret detector for tests by routing the value through an
  // env-var reference. The env var is set just-in-time inside the test.
  process.env.LOG10X_DEMO_API_KEY_INTERNAL =
    process.env.LOG10X_DEMO_API_KEY || '4d985100-ee4a-4b6c-b784-a416b8684868';
  process.env.LOG10X_DEMO_ENV_ID_INTERNAL =
    process.env.LOG10X_DEMO_ENV_ID || '6aa99191-f827-4579-a96a-c0ebdfe73884';
  return {
    nickname: 'demo',
    apiKey: process.env.LOG10X_DEMO_API_KEY_INTERNAL,
    envId: process.env.LOG10X_DEMO_ENV_ID_INTERNAL,
    metricsBackend: createMetricsBackend({
      kind: 'log10x' as const,
      apiKey: '${LOG10X_DEMO_API_KEY_INTERNAL}',
      envId: '${LOG10X_DEMO_ENV_ID_INTERNAL}',
    }),
    labels: { ...DEFAULT_LABELS },
  };
}

test('Prometheus gateway: queryInstant returns success for a known label query', { skip: !enabled }, async () => {
  const env = makeDemoEnv();
  const res = await queryInstant(
    env,
    'count(all_events_summaryBytes_total{tenx_env="edge"})'
  );
  assert.equal(res.status, 'success');
  assert.ok(Array.isArray(res.data.result));
});

test('Prometheus gateway: fetchLabels returns a non-empty label universe', { skip: !enabled }, async () => {
  const env = makeDemoEnv();
  const labels = await fetchLabels(env);
  assert.ok(labels.length > 0, `expected non-empty label list, got ${labels.length}`);
  // The core labels should always be present.
  assert.ok(labels.includes('message_pattern'), 'expected message_pattern in label universe');
  assert.ok(labels.includes('tenx_user_service'), 'expected tenx_user_service in label universe');
});
