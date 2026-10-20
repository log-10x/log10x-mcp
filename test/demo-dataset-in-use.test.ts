import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDemoEnv, demoDatasetInUse, DEMO_FALLBACK_FLAG } from '../src/lib/demo-env.js';

test('the demo dataset is in use only while the demo key is the one in use', () => {
  const saved = { ...process.env };
  try {
    applyDemoEnv();
    assert.equal(demoDatasetInUse(), true);
    process.env.LOG10X_API_KEY = 'a-signed-in-key';
    assert.equal(process.env[DEMO_FALLBACK_FLAG], '1', 'the boot flag stays set');
    assert.equal(demoDatasetInUse(), false);
  } finally {
    process.env = saved;
  }
});
