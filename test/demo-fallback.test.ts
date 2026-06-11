/**
 * Keyless demo-fallback unit tests.
 *
 * The network-dependent path (detectMode attaching to the live demo
 * backend) is exercised by the stdio probe in CI/manual verification;
 * these tests cover the pure pieces: env application, the keyless
 * guard's demo-key equivalence, the registration denylist, and the
 * opt-out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDemoEnv,
  isDemoFallbackActive,
  DEMO_ENV,
  DEMO_FALLBACK_FLAG,
  DEMO_FALLBACK_DENYLIST,
} from '../src/lib/demo-env.js';
import { shouldRegisterTool, detectMode } from '../src/lib/mode-detect.js';

const ENV_KEYS = [
  'LOG10X_API_KEY',
  'LOG10X_CUSTOMER_METRICS_URL',
  'LOG10X_CUSTOMER_METRICS_TYPE',
  'LOG10X_CUSTOMER_METRICS_AUTH',
  'LOG10X_DEMO_FALLBACK',
  DEMO_FALLBACK_FLAG,
];

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

test('applyDemoEnv wires both layers coherently and marks the flag', () => {
  const snap = snapshotEnv();
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    assert.equal(isDemoFallbackActive(), false);
    applyDemoEnv();
    assert.equal(process.env.LOG10X_API_KEY, DEMO_ENV.apiKey);
    assert.equal(process.env.LOG10X_CUSTOMER_METRICS_URL, DEMO_ENV.metricsUrl);
    assert.equal(process.env.LOG10X_CUSTOMER_METRICS_TYPE, DEMO_ENV.metricsType);
    assert.equal(
      process.env.LOG10X_CUSTOMER_METRICS_AUTH,
      `${DEMO_ENV.apiKey}/${DEMO_ENV.envId}`
    );
    assert.equal(isDemoFallbackActive(), true);
  } finally {
    restoreEnv(snap);
  }
});

test('demoFallback denylist blocks mutators; analysis surface stays', () => {
  for (const tool of DEMO_FALLBACK_DENYLIST) {
    assert.equal(
      shouldRegisterTool(tool, 'analysis', { demoFallback: true }),
      false,
      `${tool} must not register in demo fallback`
    );
    // Sanity: the same tool registers normally outside the fallback.
    assert.equal(shouldRegisterTool(tool, 'analysis'), true, `${tool} normally registers`);
  }
  for (const tool of [
    'log10x_top_patterns',
    'log10x_savings',
    'log10x_cost_options',
    'log10x_estimate_savings',
    'log10x_signin_start',
    'log10x_advise_install',
    'log10x_product_qa',
    'log10x_start', // unknown-to-TOOL_MODES default: analysis modes
  ]) {
    assert.equal(
      shouldRegisterTool(tool, 'analysis', { demoFallback: true }),
      true,
      `${tool} must stay registered in demo fallback`
    );
  }
});

test('LOG10X_DEMO_FALLBACK=off boots straight to POC (no network)', async () => {
  const snap = snapshotEnv();
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.LOG10X_DEMO_FALLBACK = 'off';
    const r = await detectMode({ probeTimeoutMs: 1500 });
    assert.equal(r.mode, 'poc');
    assert.notEqual(r.demoFallback, true);
  } finally {
    restoreEnv(snap);
  }
});
