/**
 * Tier 1B end-to-end regression: a SIEM lens must flip the $/GB rate to the
 * LENS destination's LIST price through the estimate_savings executor, even
 * when the env carries an account rate (envs.json analyzerCost) AND
 * LOG10X_ANALYZER_COST is set in the environment.
 *
 * This is the coverage that was missing: the unit tests in siem-lens.test.ts
 * exercise resolveRate/resolveSiemLens in isolation, but nothing pinned that
 * the `lensed` flag actually rides through runEstimateVerify -> resolveRate to
 * produce list_price dollars. Without this, the cost_options -> estimate_savings
 * hop (Bug 2) and any future inline refactor of the inner functions could
 * silently drop the lens and price the lensed Splunk story at the env's
 * $1.50 CloudWatch account rate.
 *
 * Setup mirrors estimate-verify-baseline-offset.test.ts: a stub metrics backend
 * returns scalar kept/dropped cohorts so the verify math is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEstimateVerify } from '../src/tools/estimate-savings.js';
import { DEFAULT_LABELS } from '../src/lib/promql.js';
import { DEFAULT_ANALYZER_COST_PER_GB } from '../src/lib/siem/pricing.js';
import type { PrometheusResponse } from '../src/lib/api.js';
import type { EnvConfig } from '../src/lib/environments.js';

const GB = 1e9;

function scalarResp(value: number): PrometheusResponse {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: [{ metric: {}, value: [Math.floor(Date.now() / 1000), String(value)] }],
    },
  };
}
function emptyResp(): PrometheusResponse {
  return { status: 'success', data: { resultType: 'vector', result: [] } };
}

/**
 * Env whose ACTUAL destination is CloudWatch with a $1.50/GB account rate
 * (the demo-shaped stray rate). Returns 300 dropped / 700 kept bytes.
 */
function makeCloudwatchEnvAt1_50(): EnvConfig {
  const backend = {
    kind: 'log10x' as const,
    endpoint: 'stub://lens-rate',
    async queryInstant(promql: string): Promise<PrometheusResponse> {
      if (promql.startsWith('sum by')) return emptyResp();
      if (promql.includes('routeState="drop"')) return scalarResp(300);
      if (promql.includes('routeState!="drop"')) return scalarResp(700);
      return scalarResp(1000);
    },
    async queryRange(): Promise<PrometheusResponse> {
      return emptyResp();
    },
    async listLabels(): Promise<string[]> {
      return [];
    },
    async listLabelValues(): Promise<string[]> {
      return [];
    },
  };
  return {
    nickname: 'lens-rate-test',
    analyzer: 'cloudwatch',
    analyzerCost: 1.5,
    metricsBackend: backend,
    labels: DEFAULT_LABELS,
    apiKey: 'stub',
    envId: 'stub',
  } as unknown as EnvConfig;
}

const POST_DROPPED_BYTES = 300;

test('verify: lensed run prices at lens LIST rate, not the $1.50 env account rate (even with LOG10X_ANALYZER_COST set)', async () => {
  const prev = process.env.LOG10X_ANALYZER_COST;
  process.env.LOG10X_ANALYZER_COST = '1.5';
  try {
    const env = makeCloudwatchEnvAt1_50();
    const vr = await runEstimateVerify(
      {
        destination: 'splunk',
        baseline_window: '7d',
        post_window: '14d',
        lensed: true,
      },
      env,
    );
    // The lens skips rungs 2 (env analyzerCost=1.5) and 3 (LOG10X_ANALYZER_COST=1.5)
    // and lands on the Splunk LIST price.
    assert.equal(vr.rate_source, 'list_price');
    // Reconstruct the per-GB rate the dollars imply and assert it is Splunk
    // list ($6), NOT the $1.50 account rate.
    const impliedRate = vr.delivered_dollars_now / (POST_DROPPED_BYTES / GB);
    assert.ok(
      Math.abs(impliedRate - DEFAULT_ANALYZER_COST_PER_GB.splunk) < 1e-9,
      `expected Splunk list $${DEFAULT_ANALYZER_COST_PER_GB.splunk}/GB, got $${impliedRate}/GB`,
    );
    assert.ok(
      Math.abs(impliedRate - 1.5) > 1e-9,
      'rate must NOT be the $1.50 env account rate under a lens',
    );
  } finally {
    if (prev === undefined) delete process.env.LOG10X_ANALYZER_COST;
    else process.env.LOG10X_ANALYZER_COST = prev;
  }
});

test('verify: NON-lensed run honours the $1.50 env account rate (control)', async () => {
  const prev = process.env.LOG10X_ANALYZER_COST;
  delete process.env.LOG10X_ANALYZER_COST;
  try {
    const env = makeCloudwatchEnvAt1_50();
    const vr = await runEstimateVerify(
      {
        destination: 'cloudwatch',
        baseline_window: '7d',
        post_window: '14d',
        // lensed omitted -> false
      },
      env,
    );
    assert.equal(vr.rate_source, 'customer_supplied');
    const impliedRate = vr.delivered_dollars_now / (POST_DROPPED_BYTES / GB);
    assert.ok(
      Math.abs(impliedRate - 1.5) < 1e-9,
      `expected the $1.50 env account rate, got $${impliedRate}/GB`,
    );
  } finally {
    if (prev !== undefined) process.env.LOG10X_ANALYZER_COST = prev;
  }
});
