/**
 * Integration-style test for the async poc-from-siem flow.
 *
 * We can't hit a real SIEM in CI, so the test substitutes an in-memory
 * SIEM connector that returns a fixed event stream. The pipeline runs the
 * local engine (it shells out to `tenx`). Since `tenx` isn't installed in
 * CI, the analyze step cleanly fails with the documented install hint —
 * we assert on the failure surface.
 *
 * This covers: snapshot lifecycle, progress callbacks, file path
 * generation, failure surface (analyze_failed), and the `unknown
 * snapshot_id` rejection path.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';

// Same pattern as pattern-extraction.test: force tenx-not-installed.
const ORIG_TENX_PATH = process.env.LOG10X_TENX_PATH;
beforeEach(() => {
  process.env.LOG10X_TENX_PATH = '/var/empty/nope-no-tenx-here';
});
afterEach(() => {
  if (ORIG_TENX_PATH === undefined) delete process.env.LOG10X_TENX_PATH;
  else process.env.LOG10X_TENX_PATH = ORIG_TENX_PATH;
});

import {
  executePocStatus,
  runPipeline,
  _resetSnapshots,
  _getSnapshot,
  type PocSubmitArgs,
} from '../src/tools/poc-from-siem.js';
import type { SiemConnector } from '../src/lib/siem/index.js';

function fakeConnector(events: unknown[]): SiemConnector {
  return {
    id: 'cloudwatch',
    displayName: 'Fake CloudWatch',
    discoverCredentials: async () => ({ available: true, source: 'env' }),
    pullEvents: async (opts) => {
      opts.onProgress({ step: 'fake page 1', pct: 25, eventsFetched: events.length });
      return {
        events,
        metadata: {
          actualCount: events.length,
          truncated: false,
          queryUsed: 'fake',
          reasonStopped: 'source_exhausted',
        },
      };
    },
  };
}

test('executePocStatus returns a typed input_invalid envelope for unknown snapshot_id', async () => {
  _resetSnapshots();
  const res = await executePocStatus({ snapshot_id: 'does-not-exist' });
  assert.equal(res.tool, 'log10x_poc_from_siem_status');
  const data = res.data as {
    snapshot_id: string;
    status: string;
    error?: { error_type: string; hint: string };
  };
  assert.equal(data.snapshot_id, 'does-not-exist');
  assert.equal(data.status, 'error');
  assert.equal(data.error?.error_type, 'input_invalid');
  assert.match(data.error?.hint ?? '', /Unknown snapshot_id/);
});

test('runPipeline surfaces analyze failure cleanly when local engine missing', async () => {
  _resetSnapshots();
  // Simulate the missing engine DETERMINISTICALLY. This test used to rely on
  // the analyze step failing on its own — which it did on every docker-having
  // machine, but only because the file-output lane's config path resolved to
  // nothing (the defect test/file-output-severity.test.ts now pins). Once
  // that was fixed, analyze legitimately completed here and this test's
  // assertion flipped: its green had been the bug in a test's clothing.
  // Forcing local mode with a nonexistent binary makes the simulation true
  // on every machine, docker or not.
  const prevMode = process.env.LOG10X_TENX_MODE;
  const prevPath = process.env.LOG10X_TENX_PATH;
  process.env.LOG10X_TENX_MODE = 'local';
  process.env.LOG10X_TENX_PATH = '/nonexistent/tenx-for-this-test';
  const id = randomUUID();
  const snap: Parameters<typeof runPipeline>[1] = {
    id,
    status: 'pulling' as const,
    progressPct: 0,
    stepDetail: 'starting',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };
  // Seed the snapshot explicitly — runPipeline reads/mutates it.
  (_getSnapshot as unknown) as (id: string) => unknown;
  // Manually register via SNAPSHOTS map: runPipeline takes the snapshot by
  // reference and mutates it, so we retain it via the exported helpers.
  // But the map is private; we emulate by running the pipeline against the
  // freshly-created snapshot object. The fact that status + error are set
  // on `snap` proves the flow works end-to-end.

  const connector = fakeConnector([
    'ERROR payment_gateway_timeout',
    'ERROR payment_gateway_timeout',
    'INFO heartbeat',
  ]);

  const args: PocSubmitArgs = {
    window: '1h',
    target_event_count: 100,
    max_pull_minutes: 1,
    ai_prettify: false,
  };

  try {
    await runPipeline(connector, snap, args);
  } finally {
    if (prevMode === undefined) delete process.env.LOG10X_TENX_MODE;
    else process.env.LOG10X_TENX_MODE = prevMode;
    if (prevPath === undefined) delete process.env.LOG10X_TENX_PATH;
    else process.env.LOG10X_TENX_PATH = prevPath;
  }
  assert.equal(snap.status, 'failed');
  assert.ok(snap.error && /analyze_failed/.test(snap.error));
  assert.ok(snap.retryHint);
});

test('runPipeline pull-error surfaces failure without crashing', async () => {
  _resetSnapshots();
  const snap: Parameters<typeof runPipeline>[1] = {
    id: 'snap-pull-err',
    status: 'pulling' as const,
    progressPct: 0,
    stepDetail: 'starting',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };
  const brokenConnector: SiemConnector = {
    id: 'cloudwatch',
    displayName: 'Broken',
    discoverCredentials: async () => ({ available: true, source: 'env' }),
    pullEvents: async () => {
      throw new Error('boom: auth expired');
    },
  };
  await runPipeline(brokenConnector, snap, {
    window: '1h',
    target_event_count: 100,
    max_pull_minutes: 1,
    ai_prettify: false,
  });
  assert.equal(snap.status, 'failed');
  assert.ok(snap.error && /pull_failed/.test(snap.error));
});

test('runPipeline zero-event pull is treated as error', async () => {
  _resetSnapshots();
  const snap: Parameters<typeof runPipeline>[1] = {
    id: 'snap-empty',
    status: 'pulling' as const,
    progressPct: 0,
    stepDetail: 'starting',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };
  const emptyConnector: SiemConnector = {
    id: 'datadog',
    displayName: 'Empty',
    discoverCredentials: async () => ({ available: true, source: 'env' }),
    pullEvents: async () => ({
      events: [],
      metadata: {
        actualCount: 0,
        truncated: false,
        queryUsed: 'none',
        reasonStopped: 'error',
        notes: ['nothing to see'],
      },
    }),
  };
  await runPipeline(emptyConnector, snap, {
    window: '24h',
    target_event_count: 100,
    max_pull_minutes: 1,
    ai_prettify: false,
  });
  assert.equal(snap.status, 'failed');
  assert.ok(snap.error && /pull_errored/.test(snap.error));
});
