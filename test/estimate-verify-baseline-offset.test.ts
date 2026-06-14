/**
 * runEstimateVerify baseline_offset — anchors the baseline range-vector to
 * pre-policy data so delivered_pct stops collapsing to 0.
 *
 * Without an offset, baseline and post `increase(...[w])` both trail to "now"
 * over an overlapping range, so the baseline is the policy's own output and
 * delivered_pct is algebraically 0 (the degenerate-windowing case). The
 * commitment runner sets baseline_offset to the commitment's age so the
 * baseline lands before the policy went live.
 *
 * These tests capture the emitted PromQL via a stub metricsBackend and assert
 * the `offset` clause lands ONLY on the baseline queries, never the post ones.
 * Baseline window is "7d" and post window is "14d", so the range bracket
 * (`[7d]` vs `[14d]`) discriminates the two cohorts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEstimateVerify } from '../src/tools/estimate-savings.js';
import { DEFAULT_LABELS } from '../src/lib/promql.js';
import type { PrometheusResponse } from '../src/lib/api.js';
import type { EnvConfig } from '../src/lib/environments.js';

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

/** Env whose backend records every query and returns kept/dropped scalars. */
function makeCapturingEnv(captured: string[]): EnvConfig {
  const backend = {
    kind: 'log10x' as const,
    endpoint: 'stub://verify-offset',
    async queryInstant(promql: string): Promise<PrometheusResponse> {
      captured.push(promql);
      // by-hash queries (`sum by (...)`) drive per-pattern rows we don't
      // exercise here — empty keeps the math simple. Scalar cohorts feed the
      // totals: kept on routeState!="drop", dropped on routeState="drop".
      if (promql.startsWith('sum by')) return emptyResp();
      if (promql.includes('routeState="drop"')) return scalarResp(300);
      if (promql.includes('routeState!="drop"')) return scalarResp(700);
      return scalarResp(1000); // postTotal (no routeState filter)
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
    nickname: 'verify-offset-test',
    metricsBackend: backend,
    labels: DEFAULT_LABELS,
    apiKey: 'stub',
    envId: 'stub',
  } as unknown as EnvConfig;
}

const BASE = {
  destination: 'splunk' as const,
  baseline_window: '7d',
  post_window: '14d',
};

test('baseline_offset applies `offset` to baseline queries only, never post', async () => {
  const captured: string[] = [];
  const env = makeCapturingEnv(captured);
  const vr = await runEstimateVerify({ ...BASE, baseline_offset: '30d' }, env);

  const baselineQs = captured.filter((q) => q.includes('[7d]'));
  const postQs = captured.filter((q) => q.includes('[14d]'));
  assert.ok(baselineQs.length >= 1, 'expected baseline queries on [7d]');
  assert.ok(postQs.length >= 1, 'expected post queries on [14d]');
  for (const q of baselineQs) {
    assert.ok(q.includes('[7d] offset 30d'), `baseline missing offset: ${q}`);
  }
  for (const q of postQs) {
    assert.ok(!/\boffset\b/.test(q), `post query must not carry offset: ${q}`);
  }
  assert.equal(vr.baseline_offset, '30d');
});

test('no baseline_offset → no offset clause anywhere', async () => {
  const captured: string[] = [];
  const env = makeCapturingEnv(captured);
  const vr = await runEstimateVerify({ ...BASE }, env);
  for (const q of captured) {
    assert.ok(!/\boffset\b/.test(q), `unexpected offset: ${q}`);
  }
  assert.equal(vr.baseline_offset, undefined);
});

test('malformed baseline_offset is ignored and caveated, not injected', async () => {
  const captured: string[] = [];
  const env = makeCapturingEnv(captured);
  const vr = await runEstimateVerify({ ...BASE, baseline_offset: 'banana' }, env);
  for (const q of captured) {
    assert.ok(!/\boffset\b/.test(q), `malformed offset leaked into query: ${q}`);
  }
  assert.equal(vr.baseline_offset, undefined);
  assert.ok(
    vr.caveats.some((c) => /not a valid PromQL duration/.test(c)),
    'expected an invalid-offset caveat'
  );
});

test('valid baseline_offset pushes a pre-policy-anchor caveat', async () => {
  const captured: string[] = [];
  const env = makeCapturingEnv(captured);
  const vr = await runEstimateVerify({ ...BASE, baseline_offset: '21d' }, env);
  assert.ok(
    vr.caveats.some((c) => /pre-policy window/.test(c)),
    'expected a pre-policy-anchor caveat'
  );
});
