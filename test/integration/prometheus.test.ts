import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryInstant, fetchLabels } from '../../src/lib/api.js';

// Integration tests hit the real Log10x Prometheus gateway at prometheus.log10x.com.
// Uses the demo environment credentials published in the console's config.js.
// Skipped unless LOG10X_INTEGRATION_TESTS=1 so CI doesn't call the production API.

const enabled = process.env.LOG10X_INTEGRATION_TESTS === '1';

// Demo credentials — public, baked into the comsite embedded widget.
const DEMO_ENV = {
  nickname: 'demo',
  apiKey: process.env.LOG10X_DEMO_API_KEY || '4d985100-ee4a-4b6c-b784-a416b8684868',
  envId: process.env.LOG10X_DEMO_ENV_ID || '6aa99191-f827-4579-a96a-c0ebdfe73884',
};

test('Prometheus gateway: queryInstant returns success for a known label query', { skip: !enabled }, async () => {
  const res = await queryInstant(
    DEMO_ENV,
    'count(all_events_summaryBytes_total{tenx_env="edge"})'
  );
  assert.equal(res.status, 'success');
  assert.ok(Array.isArray(res.data.result));
});

test('Prometheus gateway: fetchLabels returns a non-empty label universe', { skip: !enabled }, async () => {
  const labels = await fetchLabels(DEMO_ENV);
  assert.ok(labels.length > 0, `expected non-empty label list, got ${labels.length}`);
  // The core labels should always be present.
  assert.ok(labels.includes('message_pattern'), 'expected message_pattern in label universe');
  assert.ok(labels.includes('tenx_user_service'), 'expected tenx_user_service in label universe');
});
