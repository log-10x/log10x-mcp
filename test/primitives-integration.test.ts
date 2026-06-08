/**
 * Integration tests for the cross-pillar primitives.
 *
 * Drives the FULL primitive (queryRange → extractFirstSeries →
 * computeMovedSignal / pearsonWithOffset → envelope) against an
 * in-process Prometheus-API stub. Closes the "math is unit-tested but
 * the integration chain isn't" gap.
 *
 * NOT covered here (deliberately):
 *   - Real customer Prometheus quirks (rate-window oddities, label-set
 *     churn, sparse-vs-dense alignment in the wild). These need a real
 *     backend; see README "First customer pilot validation playbook."
 *   - The log10x_pattern anchor path. That talks to the log10x TSDB,
 *     not the customer backend; covered by manual chaos runs.
 *
 * Each test:
 *   1. Spins up a stub on a random port.
 *   2. Sets LOG10X_CUSTOMER_METRICS_URL + LOG10X_CUSTOMER_METRICS_TYPE.
 *   3. Registers fixture series.
 *   4. Calls the primitive directly with anchor_type='customer_metric'.
 *   5. Asserts on the envelope's `data` shape.
 *   6. Closes the stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStubProm, buildSeries, STUB_ENV, type StubProm } from './helpers/stub-prom.js';
import { executeMetricsThatMoved } from '../src/tools/metrics-that-moved.js';
import { executeRankByShapeSimilarity } from '../src/tools/rank-by-shape-similarity.js';
import { executeMetricOverlay } from '../src/tools/metric-overlay.js';
import type { EnvConfig } from '../src/lib/environments.js';

const ENV = STUB_ENV as EnvConfig;

// Post-ChassisEnvelope migration: the tools now return
// buildChassisEnvelope({..., payload: data}), so the tool-specific result
// rows live at out.data.payload.* (chassis-envelope.ts nests them under
// `payload`; status/human_summary are mirrored at the chassis top level too).
// These tests assert on the tool result rows, so read through `payload`.
function payloadOf<T>(out: { data?: unknown }): T {
  return (out.data as { payload: T }).payload;
}

// Stash the original env vars so concurrent test files don't poison
// each other. Restored after each test.
function snapshotEnv(): { url?: string; type?: string; auth?: string } {
  return {
    url: process.env.LOG10X_CUSTOMER_METRICS_URL,
    type: process.env.LOG10X_CUSTOMER_METRICS_TYPE,
    auth: process.env.LOG10X_CUSTOMER_METRICS_AUTH,
  };
}
function restoreEnv(s: { url?: string; type?: string; auth?: string }) {
  if (s.url === undefined) delete process.env.LOG10X_CUSTOMER_METRICS_URL;
  else process.env.LOG10X_CUSTOMER_METRICS_URL = s.url;
  if (s.type === undefined) delete process.env.LOG10X_CUSTOMER_METRICS_TYPE;
  else process.env.LOG10X_CUSTOMER_METRICS_TYPE = s.type;
  if (s.auth === undefined) delete process.env.LOG10X_CUSTOMER_METRICS_AUTH;
  else process.env.LOG10X_CUSTOMER_METRICS_AUTH = s.auth;
}

async function withStub(fn: (stub: StubProm) => Promise<void>): Promise<void> {
  const before = snapshotEnv();
  const stub = await startStubProm();
  process.env.LOG10X_CUSTOMER_METRICS_URL = stub.url;
  process.env.LOG10X_CUSTOMER_METRICS_TYPE = 'generic_prom';
  delete process.env.LOG10X_CUSTOMER_METRICS_AUTH;
  try {
    await fn(stub);
  } finally {
    await stub.close();
    restoreEnv(before);
  }
}

// ── metrics_that_moved ───────────────────────────────────────────────

test('metrics_that_moved: co-moving candidate ends up in moved[], flat candidate in not_moved[]', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    // 20-bucket anchor: first half low, second half high.
    // Use distinct high values so partitionByMedian splits cleanly (ties
    // at the median collapse high or low to empty).
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor_metric', { values: buildSeries(anchorVals, 30, endTs) });
    // Co-mover: same phases.
    stub.setFixture('candidate_co', {
      values: buildSeries([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], 30, endTs),
    });
    // Flat: same value through both phases.
    stub.setFixture('candidate_flat', {
      values: buildSeries(Array(20).fill(7), 30, endTs),
    });

    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor_metric',
        candidates: ['candidate_co', 'candidate_flat'],
        window: '10m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected structured envelope');
    const data = payloadOf<{
      moved: Array<{ candidate: string; phase_gap: number; direction: string }>;
      not_moved: Array<{ candidate: string; phase_gap: number }>;
      evaluation_failed: string[];
    }>(out);
    assert.equal(data.moved.length, 1, `expected 1 moved candidate, got ${JSON.stringify(data.moved)}`);
    assert.equal(data.moved[0].candidate, 'candidate_co');
    assert.equal(data.moved[0].direction, 'co');
    assert.equal(data.not_moved.length, 1);
    assert.equal(data.not_moved[0].candidate, 'candidate_flat');
    assert.equal(data.evaluation_failed.length, 0);
  });
});

test('metrics_that_moved: anchor with zero series → "insufficient for phase analysis" headline', async () => {
  await withStub(async (stub) => {
    // Anchor fixture not registered → stub returns empty matrix.
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'missing_anchor',
        candidates: ['some_candidate'],
        window: '10m',
        step: '30s',
        view: 'markdown',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    // Markdown-view envelope always has data.markdown; the headline
    // is the agent-facing signal.
    assert.match(
      out.summary.headline,
      /insufficient for phase analysis|0 buckets/i,
      `unexpected headline: ${out.summary.headline}`,
    );
  });
});

test('metrics_that_moved: anti-correlated candidate is "moved" with direction=anti', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    // Use distinct high values so partitionByMedian splits cleanly (ties
    // at the median collapse high or low to empty).
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });
    stub.setFixture('candidate_anti', {
      values: buildSeries([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 30, endTs),
    });
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['candidate_anti'],
        window: '10m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const data = payloadOf<{ moved: Array<{ direction: string }> }>(out);
    assert.equal(data.moved.length, 1);
    assert.equal(data.moved[0].direction, 'anti');
  });
});

test('metrics_that_moved: 503 on candidate fetch → candidate lands in evaluation_failed[]', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    // Use distinct high values so partitionByMedian splits cleanly (ties
    // at the median collapse high or low to empty).
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });
    // Register all candidates so they're known queries; then enable a
    // near-total failure rail. backend-fetch now retries 5xx up to 3
    // attempts (LOG10X_RETRY_ATTEMPTS default), so a *single* transient
    // 503 is absorbed by the retry and the candidate succeeds. Only a
    // candidate whose every retry attempt 503s lands in
    // evaluation_failed[]. rate=0.99 keeps the anchor (request 1) green
    // but fails every subsequent attempt, so all three candidates
    // exhaust their retries → evaluation_failed[]. Expect ≥1 failed.
    const flatVals = buildSeries(
      [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
      30,
      endTs,
    );
    stub.setFixture('cand_a', { values: flatVals });
    stub.setFixture('cand_b', { values: flatVals });
    stub.setFixture('cand_c', { values: flatVals });
    stub.setFailureRate(0.99);
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['cand_a', 'cand_b', 'cand_c'],
        window: '10m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const data = payloadOf<{ evaluation_failed: string[]; moved: unknown[]; not_moved: unknown[] }>(out);
    assert.ok(
      data.evaluation_failed.length >= 1,
      `expected ≥1 failed candidate from injected 503s, got ${JSON.stringify(data)}`,
    );
  });
});

// ── rank_by_shape_similarity ─────────────────────────────────────────

test('rank_by_shape_similarity: identical-shape candidate ranks first', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const shape = [0, 0, 1, 3, 8, 15, 20, 18, 10, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    stub.setFixture('anchor', { values: buildSeries(shape, 30, endTs) });
    stub.setFixture('cand_match', { values: buildSeries(shape, 30, endTs) });
    // A noise candidate with no relationship to the spike shape.
    stub.setFixture('cand_noise', { values: buildSeries([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 30, endTs) });

    const out = await executeRankByShapeSimilarity(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['cand_noise', 'cand_match'],
        window: '10m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const data = payloadOf<{
      ranked: Array<{ candidate: string; pearson_magnitude: number; lag_seconds: number; lag_at_bound: boolean }>;
    }>(out);
    assert.ok(data.ranked.length >= 1);
    assert.equal(data.ranked[0].candidate, 'cand_match');
    assert.ok(data.ranked[0].pearson_magnitude > 0.95);
    assert.equal(data.ranked[0].lag_seconds, 0);
    assert.equal(data.ranked[0].lag_at_bound, false);
  });
});

test('rank_by_shape_similarity: lag_search_max_abs narrows the lag scan', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    // Anchor lagging candidate by ~60s (2 buckets of 30s).
    const cand = [0, 0, 0, 1, 5, 10, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const anch = [0, 0, 0, 0, 0, 1, 5, 10, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    stub.setFixture('anchor', { values: buildSeries(anch, 30, endTs) });
    stub.setFixture('candidate', { values: buildSeries(cand, 30, endTs) });

    // With lag_search_max_abs=30, we should NOT find the -60s peak.
    const out = await executeRankByShapeSimilarity(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['candidate'],
        window: '10m',
        step: '30s',
        lag_search_max_abs: 30,
        view: 'summary',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const data = payloadOf<{ ranked: Array<{ lag_seconds: number; lag_at_bound: boolean }> }>(out);
    assert.ok(Math.abs(data.ranked[0].lag_seconds) <= 30, `lag should be within ±30, got ${data.ranked[0].lag_seconds}`);
    // Peak at -30 = the boundary of the narrowed search → lag_at_bound true.
    assert.equal(data.ranked[0].lag_at_bound, true);
  });
});

test('rank_by_shape_similarity: anchor_phase_aligned_floor controls the flag', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    // Anchor has clear high/low partition; candidate has a small but
    // real gap (~12%). With default floor 0.15 it's NOT aligned; with
    // floor 0.05 it IS.
    // Distinct anchor values so the partition splits cleanly.
    const anch = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    // Candidate with ~12% gap between phases (high-mean / low-mean ratio).
    const cand = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113];
    stub.setFixture('anchor', { values: buildSeries(anch, 30, endTs) });
    stub.setFixture('candidate', { values: buildSeries(cand, 30, endTs) });

    const strict = await executeRankByShapeSimilarity(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['candidate'],
        window: '10m',
        step: '30s',
        // default floor 0.15
        view: 'summary',
      },
      ENV,
    );
    const loose = await executeRankByShapeSimilarity(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['candidate'],
        window: '10m',
        step: '30s',
        anchor_phase_aligned_floor: 0.05,
        view: 'summary',
      },
      ENV,
    );
    if (typeof strict === 'string' || typeof loose === 'string') throw new Error('expected envelopes');
    const strictData = payloadOf<{ ranked: Array<{ anchor_phase_aligned: boolean; anchor_phase_gap: number }> }>(strict);
    const looseData = payloadOf<{ ranked: Array<{ anchor_phase_aligned: boolean; anchor_phase_gap: number }> }>(loose);
    assert.equal(strictData.ranked[0].anchor_phase_aligned, false, `gap was ${strictData.ranked[0].anchor_phase_gap}`);
    assert.equal(looseData.ranked[0].anchor_phase_aligned, true);
  });
});

// ── metric_overlay ───────────────────────────────────────────────────

test('metric_overlay: returns aligned anchor+candidate timeseries + peak facts', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const anch = [0, 0, 1, 3, 8, 15, 20, 18, 10, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    const cand = [0, 0, 1, 3, 8, 15, 20, 18, 10, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    stub.setFixture('anchor', { values: buildSeries(anch, 30, endTs) });
    stub.setFixture('candidate', { values: buildSeries(cand, 30, endTs) });

    const out = await executeMetricOverlay(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidate: 'candidate',
        window: '10m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const data = payloadOf<{
      n_buckets_aligned: number;
      facts: { peak_offset_seconds: number | null };
      series: Array<{ ts: number; anchor_value: number | null; candidate_value: number | null }>;
    }>(out);
    assert.ok(data.n_buckets_aligned >= 18, `expected ~20 buckets aligned, got ${data.n_buckets_aligned}`);
    assert.equal(data.facts.peak_offset_seconds, 0, 'identical shapes peak at the same ts');
    assert.ok(data.series.length >= 20);
  });
});

test('metric_overlay: sparse anchor + dense candidate → right-aligns on trailing buckets', async () => {
  // The v4 regression scenario: anchor has 10 buckets at the END of the
  // window; candidate has 40 buckets across the whole window. Without
  // right-align, the math would pad the anchor with leading zeros and
  // compute peak_offset_seconds against the wrong half of the candidate.
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const sparseAnchor = [1, 5, 12, 20, 15, 8, 3, 1, 0, 0];
    const denseCand = [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      1, 5, 12, 20, 15, 8, 3, 1, 0, 0,
    ];
    stub.setFixture('anchor', { values: buildSeries(sparseAnchor, 30, endTs) });
    stub.setFixture('candidate', { values: buildSeries(denseCand, 30, endTs) });

    const out = await executeMetricOverlay(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidate: 'candidate',
        window: '20m',
        step: '30s',
        view: 'summary',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const data = payloadOf<{
      n_buckets_aligned: number;
      facts: { peak_offset_seconds: number | null };
    }>(out);
    // Aligned on the trailing 10 buckets (size of sparse anchor).
    assert.ok(data.n_buckets_aligned >= 8 && data.n_buckets_aligned <= 10);
    // Both peaks land on the same right-aligned bucket.
    assert.equal(data.facts.peak_offset_seconds, 0, 'right-align should put both peaks at offset 0');
  });
});

test('metric_overlay: missing candidate returns the no-overlap headline', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    stub.setFixture('anchor', { values: buildSeries([1, 2, 3, 4, 5, 6, 7, 8], 30, endTs) });
    // candidate not registered → empty matrix
    const out = await executeMetricOverlay(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidate: 'no_such_metric',
        window: '10m',
        step: '30s',
        view: 'markdown',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    assert.match(out.summary.headline, /no overlap|0 buckets|insufficient|no data|no_signal/i);
  });
});

// ── GA-track: unified envelope, structural guards, structured errors ─

test('GA: metrics_that_moved emits unified envelope with status, threshold_basis, anchor_ref, telemetry', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });
    stub.setFixture('cand_co', {
      values: buildSeries([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], 30, endTs),
    });
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['cand_co'],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{
      status: string;
      threshold_used: number;
      threshold_basis: string;
      anchor_ref: { type: string; expression: string };
      anchor_dispersion: number;
      query_count: number;
      total_latency_ms: number;
      backend_pressure_hint: string | null;
      human_summary: string;
      moved: Array<{ metric_ref: string }>;
    }>(out);
    assert.equal(d.status, 'success');
    assert.equal(d.threshold_used, 0.15);
    assert.equal(d.threshold_basis, 'unvalidated_default');
    assert.equal(d.anchor_ref.type, 'customer_metric');
    assert.equal(d.anchor_ref.expression, 'anchor');
    assert.ok(d.anchor_dispersion > 0.15, `expected dispersion > 0.15, got ${d.anchor_dispersion}`);
    assert.equal(d.query_count, 2, 'one anchor + one candidate query');
    assert.ok(d.total_latency_ms >= 0);
    assert.ok(d.backend_pressure_hint === 'ok' || d.backend_pressure_hint === 'slow');
    assert.ok(d.human_summary.length > 0);
    assert.equal(d.moved.length, 1);
    assert.equal(d.moved[0].metric_ref, 'cand_co');
  });
});

test('GA: anchor without phase separation → status=anchor_no_phase_separation, no threshold returned', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    // Flat anchor: same value throughout. CV = 0. Guard refuses.
    stub.setFixture('flat_anchor', { values: buildSeries(Array(20).fill(7), 30, endTs) });
    stub.setFixture('cand', { values: buildSeries(Array(20).fill(5), 30, endTs) });
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'flat_anchor',
        candidates: ['cand'],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{
      status: string;
      anchor_dispersion: number;
      moved: unknown[];
      not_moved: unknown[];
      evaluation_failed: unknown[];
      human_summary: string;
    }>(out);
    assert.equal(d.status, 'anchor_no_phase_separation');
    assert.equal(d.anchor_dispersion, 0);
    assert.equal(d.moved.length, 0);
    assert.equal(d.not_moved.length, 0);
    assert.equal(d.evaluation_failed.length, 0);
    // Per Notes 9-12 the refusal prose was rewritten to plain English;
    // the internal 'floor'/'phase'/'re-anchor' jargon was intentionally
    // dropped. Assert on the current source copy (metrics-that-moved.ts
    // baseProse): 'too steady over this window ... Try a different
    // starting pattern or widen the window.'
    assert.match(d.human_summary, /too steady over this window/i);
    assert.match(d.human_summary, /different starting pattern|widen the window/i);
    // Headline was also rewritten to plain English (source line 493):
    // 'The pattern we looked at is too steady to compare against other
    // metrics. Try a different starting pattern.'
    assert.match(out.summary.headline, /too steady to compare/i);
  });
});

test('GA: every candidate below threshold → status=no_signal', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });
    // Candidate flat across both phases — gap below 0.15 floor.
    stub.setFixture('flat_cand', { values: buildSeries(Array(20).fill(7), 30, endTs) });
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['flat_cand'],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{ status: string; moved: unknown[]; not_moved: unknown[]; human_summary: string }>(out);
    assert.equal(d.status, 'no_signal');
    assert.equal(d.moved.length, 0);
    assert.equal(d.not_moved.length, 1, 'flat candidate still gets evaluated, just below floor');
    // Per Notes 9-12 the no_signal prose was rewritten to plain English
    // (buildHumanSummary no_signal branch). Assert on the current source
    // copy: 'No metrics moved with this pattern over the window. N stayed
    // flat. Try a different starting pattern or widen the window.'
    assert.match(d.human_summary, /No metrics moved with this pattern/i);
    assert.match(d.human_summary, /stayed flat/i);
  });
});

test('GA: backend 503 on anchor → status=error with PrimitiveError envelope, retryable=true', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    stub.setFixture('anchor', { values: buildSeries([1, 2, 3, 4, 5, 6, 7, 8], 30, endTs) });
    stub.setFixture('cand', { values: buildSeries([1, 2, 3, 4, 5, 6, 7, 8], 30, endTs) });
    // Hard fail every request — anchor will 503 first.
    stub.setFailureRate(1.0);
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['cand'],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{
      status: string;
      error?: { error_type: string; retryable: boolean; suggested_backoff_ms: number | null; hint: string };
    }>(out);
    assert.equal(d.status, 'error');
    assert.ok(d.error, 'error envelope must be populated');
    if (!d.error) return;
    assert.equal(d.error.error_type, 'backend_unavailable');
    assert.equal(d.error.retryable, true);
    assert.ok((d.error.suggested_backoff_ms ?? 0) > 0);
    assert.match(d.error.hint, /HTTP 503/);
  });
});

test('GA: metric_ref round-trips across the three tools', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });
    // PromQL with extra whitespace — canonicalMetricRef should collapse it.
    const candWithSpace = 'rate(  http_requests_total{job="api"}[5m])';
    const candCanonical = 'rate( http_requests_total{job="api"}[5m])';
    stub.setFixture(candWithSpace, {
      values: buildSeries([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], 30, endTs),
    });
    // Also register under the canonical form so the rank/overlay calls
    // can fetch it (the stub fixtures are keyed by exact match).
    stub.setFixture(candCanonical, {
      values: buildSeries([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], 30, endTs),
    });

    // Step 1: metrics_that_moved
    const r1 = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: [candWithSpace],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof r1 === 'string') throw new Error('expected envelope');
    const d1 = payloadOf<{ moved: Array<{ metric_ref: string }> }>(r1);
    assert.equal(d1.moved.length, 1);
    const ref1 = d1.moved[0].metric_ref;
    assert.equal(ref1, candCanonical, 'metric_ref must be canonical (whitespace collapsed)');

    // Step 2: pass that ref to rank_by_shape_similarity
    const r2 = await executeRankByShapeSimilarity(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: [ref1],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof r2 === 'string') throw new Error('expected envelope');
    const d2 = payloadOf<{ ranked: Array<{ metric_ref: string }> }>(r2);
    assert.equal(d2.ranked.length, 1, 'rank_by_shape should fetch the canonical-ref candidate cleanly');
    const ref2 = d2.ranked[0].metric_ref;
    assert.equal(ref2, ref1, 'metric_ref must remain identical across tool calls');

    // Step 3: pass that ref to metric_overlay
    const r3 = await executeMetricOverlay(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidate: ref2,
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof r3 === 'string') throw new Error('expected envelope');
    const d3 = payloadOf<{ candidate_ref: string }>(r3);
    assert.equal(d3.candidate_ref, ref2, 'metric_ref preserved through full 3-tool chain');
  });
});

test('GA: rank_by_shape includes anchor_ref echo and threshold_basis=caller_override when caller passes args', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const shape = [0, 0, 1, 3, 8, 15, 20, 18, 10, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    stub.setFixture('anchor', { values: buildSeries(shape, 30, endTs) });
    stub.setFixture('cand', { values: buildSeries(shape, 30, endTs) });
    const out = await executeRankByShapeSimilarity(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['cand'],
        window: '10m',
        step: '30s',
        anchor_phase_aligned_floor: 0.2, // caller override
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{
      threshold_basis: string;
      threshold_used: number;
      anchor_ref: { type: string; expression: string };
    }>(out);
    assert.equal(d.threshold_basis, 'caller_override');
    assert.equal(d.threshold_used, 0.2);
    assert.equal(d.anchor_ref.expression, 'anchor');
  });
});

test('GA: metric_overlay emits status=no_signal when anchor returns nothing', async () => {
  await withStub(async (stub) => {
    // anchor not registered → empty matrix
    const endTs = Math.floor(Date.now() / 1000);
    stub.setFixture('cand', { values: buildSeries([1, 2, 3, 4, 5, 6, 7, 8], 30, endTs) });
    const out = await executeMetricOverlay(
      {
        anchor_type: 'customer_metric',
        anchor: 'missing_anchor',
        candidate: 'cand',
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{ status: string; n_buckets_aligned: number }>(out);
    assert.equal(d.status, 'no_signal');
    assert.equal(d.n_buckets_aligned, 0);
  });
});

// ── threshold_audit: floor + observed-distribution disclosure ──

test('GA: metrics_that_moved emits threshold_audit with observed_phase_gap_distribution', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });
    stub.setFixture('cand_co', {
      values: buildSeries([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], 30, endTs),
    });
    stub.setFixture('cand_flat', { values: buildSeries(Array(20).fill(7), 30, endTs) });
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['cand_co', 'cand_flat'],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{
      threshold_audit: {
        phase_gap_floor: { value: number; basis: string };
        observed_phase_gap_distribution: { n: number; min: number; p50: number; max: number } | null;
      };
    }>(out);
    assert.ok(d.threshold_audit, 'threshold_audit must be present on success');
    assert.equal(d.threshold_audit.phase_gap_floor.value, 0.15);
    assert.equal(d.threshold_audit.phase_gap_floor.basis, 'unvalidated_default');
    assert.ok(d.threshold_audit.observed_phase_gap_distribution !== null);
    if (d.threshold_audit.observed_phase_gap_distribution) {
      assert.equal(d.threshold_audit.observed_phase_gap_distribution.n, 2);
      assert.ok(d.threshold_audit.observed_phase_gap_distribution.max >= d.threshold_audit.observed_phase_gap_distribution.min);
    }
  });
});

test('GA: metrics_that_moved human_summary explicitly references the floor AND observed median', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const anchorVals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    stub.setFixture('anchor', { values: buildSeries(anchorVals, 30, endTs) });
    stub.setFixture('cand', {
      values: buildSeries([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], 30, endTs),
    });
    const out = await executeMetricsThatMoved(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['cand'],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{ human_summary: string }>(out);
    // Per Notes 9-12, buildHumanSummary intentionally dropped the internal
    // jargon ('phase-gap floor', 'observed median phase_gap', 'unvalidated
    // default') from user-facing prose. The calibration caveat is now the
    // plain-English 'Match threshold is a default (not yet tuned for your
    // data).' Assert on the current copy (source is the source of truth).
    assert.match(d.human_summary, /moved with this pattern/i);
    assert.match(d.human_summary, /strongest match/i);
    assert.match(d.human_summary, /Match threshold is a default \(not yet tuned for your data\)/i);
  });
});

test('GA: rank_by_shape_similarity emits threshold_audit with observed_pearson_magnitude_distribution', async () => {
  await withStub(async (stub) => {
    const endTs = Math.floor(Date.now() / 1000);
    const shape = [0, 0, 1, 3, 8, 15, 20, 18, 10, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    stub.setFixture('anchor', { values: buildSeries(shape, 30, endTs) });
    stub.setFixture('cand1', { values: buildSeries(shape, 30, endTs) });
    stub.setFixture('cand2', {
      values: buildSeries([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 30, endTs),
    });
    const out = await executeRankByShapeSimilarity(
      {
        anchor_type: 'customer_metric',
        anchor: 'anchor',
        candidates: ['cand1', 'cand2'],
        window: '10m',
        step: '30s',
      },
      ENV,
    );
    if (typeof out === 'string') throw new Error('expected envelope');
    const d = payloadOf<{
      threshold_audit: {
        anchor_phase_aligned_floor: { value: number; basis: string };
        lag_search_max_abs: { value: number; basis: string };
        observed_pearson_magnitude_distribution: { n: number; max: number } | null;
        n_lag_at_bound: number;
      };
    }>(out);
    assert.ok(d.threshold_audit);
    assert.equal(d.threshold_audit.anchor_phase_aligned_floor.value, 0.15);
    assert.equal(d.threshold_audit.anchor_phase_aligned_floor.basis, 'unvalidated_default');
    assert.equal(d.threshold_audit.lag_search_max_abs.value, 1800);
    assert.ok(d.threshold_audit.observed_pearson_magnitude_distribution !== null);
    if (d.threshold_audit.observed_pearson_magnitude_distribution) {
      assert.ok(d.threshold_audit.observed_pearson_magnitude_distribution.max > 0.9);
    }
    // n_lag_at_bound can be > 0 — flat candidates have no preferred lag,
    // so their Pearson-peak ties at the boundary by JS's stable sort.
    // What we pin is the field's PRESENCE and type, not its value.
    assert.ok(typeof d.threshold_audit.n_lag_at_bound === 'number');
  });
});
