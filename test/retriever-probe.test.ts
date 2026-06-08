/**
 * Tests for the retriever e2e probe.
 *
 * The probe runs entirely against an injectable ProbeDeps surface, so each
 * test wires a deterministic mock and asserts the verdict + the specific
 * assert that triggered it.
 *
 * Coverage:
 *   1. happy path — every assert passes → verdict green.
 *   2. empty offload bucket → broken at offload_bucket_has_recent_data.
 *   3. indexer pipeline not running → broken at indexer_pipeline_running.
 *   4. cw stream fetch missing → broken at cw_stream_fetch (chart 1.0.20 class).
 *   5. metric backend missing + no target_hash → verdict unknown.
 *   6. target_hash supplied → metric backend is never called.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRetrieverProbe, type ProbeDeps, REMEDIES } from '../src/lib/retriever-probe.js';

const ARGS = {
  namespace: 'log10x',
  offload_bucket: 'tenx-retriever-351939435334',
  input_bucket: 'tenx-retriever-input-351939435334',
  query_log_group: 'log10x-retriever-query-events',
};

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function happyDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  let pickHashCalls = 0;
  return {
    s3ListObjects: async (bucket, prefix) => {
      // offload bucket: return a recent object so the recent-data assert passes
      if (prefix === '') {
        return [
          { Key: 'data-1.jsonl', LastModified: nowIso(-30_000), Size: 1024 },
          { Key: 'data-2.jsonl', LastModified: nowIso(-60_000), Size: 2048 },
        ];
      }
      // qr/<queryId>/ prefix: return one jsonl
      if (prefix.includes('/qr/')) {
        return [{ Key: `${prefix}worker-1.jsonl`, LastModified: nowIso(), Size: 4096 }];
      }
      return [];
    },
    kubectlLogs: async () =>
      [
        'starting pipeline - Tenx: @/apps/retriever/index',
        'starting pipeline - Tenx: @/apps/retriever/stream',
      ].join('\n'),
    sqsDepths: async (urls) => {
      const out: Record<string, number> = {};
      for (const u of urls) out[u] = 0;
      return out;
    },
    sqsListQueues: async (prefix) => {
      if (prefix.includes('subquery')) return ['https://sqs.example.com/q/tenx-retriever-subquery-001'];
      if (prefix.includes('stream')) return ['https://sqs.example.com/q/tenx-retriever-stream-001'];
      return [];
    },
    kubectlGetPod: async () => ({
      name: 'my-retriever-retriever-10x-all-in-one-abc',
      ready: true,
      observed: 'pod my-retriever-retriever-10x-all-in-one-abc: 1/1 containers ready',
    }),
    cwFilterLogEvents: async (_group, filter) => {
      if (filter.includes('"scan complete"')) {
        return [
          { timestamp: Date.now(), message: '{"event":"scan complete","scanned":1000,"matched":16}' },
        ];
      }
      if (filter.includes('"stream worker"')) {
        return [
          { timestamp: Date.now(), message: 'stream worker complete: fetched 12345 bytes' },
        ];
      }
      return [];
    },
    pickTopHash: async () => {
      pickHashCalls++;
      return { status: 'ok' as const, hash: 'FU1__vh8hbY' };
    },
    submitRetrieverQuery: async () => ({
      queryId: 'q-abc-123',
      eventsMatched: 16,
      eventsReturned: 1,
    }),
    ...overrides,
  };
}

// 1. ── Happy path: every assert passes → verdict green ─────────────────────

test('probe: all asserts pass → verdict green', async () => {
  const deps = happyDeps();
  const result = await runRetrieverProbe(ARGS, deps);
  assert.equal(result.verdict, 'green', `expected green, got ${result.verdict}; reason=${result.reason ?? '-'}`);
  assert.equal(result.picked_hash, 'FU1__vh8hbY');
  assert.equal(result.query_id, 'q-abc-123');
  // 4 preflight + 4 post-query = 8 asserts
  assert.equal(result.asserts.length, 8);
  for (const a of result.asserts) {
    assert.equal(a.pass, true, `assert ${a.name} should pass but didn't: ${a.observed}`);
  }
  assert.equal(result.first_failed_assert, undefined);
  assert.equal(result.surfaced_remedy, undefined);
});

// 2. ── Empty offload bucket → broken at offload_bucket_has_recent_data ────

test('probe: offload bucket empty → broken at offload_bucket_has_recent_data', async () => {
  const deps = happyDeps({
    s3ListObjects: async (_bucket, prefix) => {
      if (prefix === '') return []; // no offload data
      if (prefix.includes('/qr/')) {
        return [{ Key: `${prefix}worker-1.jsonl`, LastModified: nowIso(), Size: 1 }];
      }
      return [];
    },
  });
  const result = await runRetrieverProbe(ARGS, deps);
  assert.equal(result.verdict, 'broken');
  assert.equal(result.first_failed_assert, 'offload_bucket_has_recent_data');
  assert.equal(result.surfaced_remedy, REMEDIES.offload_bucket_has_recent_data);
  // Query should NOT have been fired because preflight failed
  assert.equal(result.query_id, undefined);
});

// 3. ── Indexer not running → broken at indexer_pipeline_running ───────────

test('probe: indexer pipeline not running → broken with that remedy', async () => {
  const deps = happyDeps({
    kubectlLogs: async () => 'some unrelated log line\nanother line without the marker',
  });
  const result = await runRetrieverProbe(ARGS, deps);
  assert.equal(result.verdict, 'broken');
  assert.equal(result.first_failed_assert, 'indexer_pipeline_running');
  assert.equal(result.surfaced_remedy, REMEDIES.indexer_pipeline_running);
});

// 4. ── CW stream fetch missing → broken at cw_stream_fetch ────────────────

test('probe: cw stream fetch missing → broken with chart-1.0.20-class remedy', async () => {
  const deps = happyDeps({
    cwFilterLogEvents: async (_group, filter) => {
      // scan complete events exist (>0 matched) but stream worker events
      // are missing — that's the chart-1.0.20 silent-stream-launch-fail
      // signature this remedy keys on.
      if (filter.includes('"scan complete"')) {
        return [
          { timestamp: Date.now(), message: '{"event":"scan complete","scanned":1000,"matched":16}' },
        ];
      }
      return [];
    },
  });
  const result = await runRetrieverProbe(ARGS, deps);
  assert.equal(result.verdict, 'broken');
  assert.equal(result.first_failed_assert, 'cw_stream_fetch');
  assert.equal(result.surfaced_remedy, REMEDIES.cw_stream_fetch);
  // The remedy text should call out the chart 1.0.20 class
  assert.ok(
    (result.surfaced_remedy ?? '').includes('1.0.20'),
    `expected remedy to mention chart 1.0.20: ${result.surfaced_remedy}`,
  );
});

// 5. ── Metric backend missing + no target_hash → verdict unknown ──────────

test('probe: no metric backend + no target_hash → verdict unknown', async () => {
  const deps = happyDeps({
    pickTopHash: async () => ({ status: 'no_backend' as const }),
  });
  const result = await runRetrieverProbe(ARGS, deps);
  assert.equal(result.verdict, 'unknown');
  assert.ok(
    (result.reason ?? '').toLowerCase().includes('metric backend'),
    `expected reason to mention metric backend: ${result.reason}`,
  );
  assert.equal(result.asserts.length, 0);
});

test('probe: metric backend present but empty + no target_hash → verdict unknown', async () => {
  const deps = happyDeps({
    pickTopHash: async () => ({ status: 'no_data' as const }),
  });
  const result = await runRetrieverProbe(ARGS, deps);
  assert.equal(result.verdict, 'unknown');
  assert.ok(
    (result.reason ?? '').toLowerCase().includes('no patterns'),
    `expected reason to mention no patterns: ${result.reason}`,
  );
});

// 6. ── target_hash supplied → metric backend never called ─────────────────

test('probe: target_hash supplied → pickTopHash never called', async () => {
  let pickCalls = 0;
  const deps = happyDeps({
    pickTopHash: async () => {
      pickCalls++;
      return { status: 'ok' as const, hash: 'should-never-be-used' };
    },
  });
  const result = await runRetrieverProbe(
    { ...ARGS, target_hash: 'EXPLICIT_HASH' },
    deps,
  );
  assert.equal(pickCalls, 0, 'pickTopHash should not be called when target_hash is supplied');
  assert.equal(result.verdict, 'green');
  assert.equal(result.picked_hash, 'EXPLICIT_HASH');
});
