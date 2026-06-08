/**
 * Unit tests for measure-compaction.ts
 *
 * Mocks runMcpAppOnEvents to return fixture data. Verifies:
 *   - ratio math
 *   - confidence tiers
 *   - envelope schema
 *
 * TODO(ci): convert to node:test — currently EXCLUDED from tsconfig.test.json.
 *
 * This file is a faithful node:test translation of the original vitest suite,
 * but it cannot run as-is: it mocks three plain `export function` exports
 * (`runMcpAppOnEvents`, `getConnector`, `resolveSiemSelection`) that the tool
 * imports across a module boundary. Under strict-mode ESM, reassigning a
 * read-only module-namespace binding throws "Cannot assign to read only
 * property of object '[object Module]'", so the live-namespace monkey-patch
 * idiom used by recurring-tick.test.ts (whose REAL seam is env-var backend
 * routing, not the namespace swap) does not take effect here.
 *
 * To re-enable, the tool needs an injection seam (e.g. an exported
 * `_setRunner` / `_setConnectorFactory` like commitment-report's
 * `_setVerifyRunner`), OR the test script must pass
 * `--experimental-test-module-mocks` so `mock.module` can be used. Either is a
 * src/CI change out of scope for the test-only fix. Until then the file is
 * excluded so `tsc -p tsconfig.test.json` (and the publish CI) stays green.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EnvConfig } from '../src/lib/environments.js';

// ── Live-namespace handles (populated in `before`) ──

type AnyFn = (...args: any[]) => any;

let runnerNs: { runMcpAppOnEvents: AnyFn } & Record<string, unknown>;
let siemNs: { getConnector: AnyFn } & Record<string, unknown>;
let resolveNs: {
  resolveSiemSelection: AnyFn;
  formatAmbiguousError: AnyFn;
  formatNoneError: AnyFn;
} & Record<string, unknown>;

let executeMeasureCompaction: (
  args: { service: string; sample_size?: number; timeRange?: string; environment?: string },
  env: EnvConfig,
) => Promise<any>;

// Controllable runner mock: a queue of one-shot results falls back to a
// default. Mirrors vitest's mockResolvedValue + mockResolvedValueOnce.
let runnerDefaultResult: unknown;
let runnerOnceQueue: unknown[] = [];
function nextRunnerResult(): unknown {
  if (runnerOnceQueue.length > 0) return runnerOnceQueue.shift();
  return runnerDefaultResult;
}

// Controllable connector mock: like the runner, a one-shot queue over a
// default pull result, plus a record of pull-call args (mock.calls).
let pullDefaultResult: unknown;
let pullOnceQueue: unknown[] = [];
const pullCalls: any[] = [];
function makeConnector() {
  return {
    pullEvents: async (callArgs: unknown) => {
      pullCalls.push(callArgs);
      if (pullOnceQueue.length > 0) return pullOnceQueue.shift();
      return pullDefaultResult;
    },
  };
}

// Minimal fake EnvConfig — measure-compaction does not use the env directly.
const fakeEnv = {} as unknown as EnvConfig;

// ── Fixtures ──

function defaultPullResult() {
  return {
    events: [
      'ERROR Database connection failed: timeout',
      'ERROR Database connection failed: timeout',
      'ERROR Database connection failed: refused',
      'INFO  Request handled in 42ms path=/api/v1/users',
      'INFO  Request handled in 99ms path=/api/v1/orders',
      'INFO  Request handled in 15ms path=/api/v1/health',
      'DEBUG Cache miss key=abc123',
      'DEBUG Cache miss key=def456',
      'DEBUG Cache miss key=ghi789',
      'DEBUG Cache miss key=jkl012',
      'DEBUG Cache miss key=mno345',
    ],
    metadata: { actualCount: 11, truncated: false, queryUsed: '', reasonStopped: 'source_exhausted' },
  };
}

/**
 * Build a fixture McpAppRunnerResult simulating three patterns:
 *   - patternA: 4 events
 *   - patternB: 6 events
 *   - patternC: 1 event (low confidence)
 */
function makeFixtureResult() {
  const templates = new Map([
    ['tmplA', { templateHash: 'tmplA', template: 'ERROR Database connection failed: $', variableSlots: [{ position: 0 }] }],
    ['tmplB', { templateHash: 'tmplB', template: 'INFO  Request handled in $ms path=$', variableSlots: [{ position: 0 }, { position: 1 }] }],
    ['tmplC', { templateHash: 'tmplC', template: 'DEBUG Cache miss key=$', variableSlots: [{ position: 0 }] }],
  ]);

  const encodedLines = [
    // patternA (4 events)
    { templateHash: 'tmplA', values: ['timeout'],  tenxHash: 'hashA', symbolMessage: 'error_database_connection_failed', lineBytes: 30 },
    { templateHash: 'tmplA', values: ['timeout'],  tenxHash: 'hashA', symbolMessage: 'error_database_connection_failed', lineBytes: 30 },
    { templateHash: 'tmplA', values: ['refused'],  tenxHash: 'hashA', symbolMessage: 'error_database_connection_failed', lineBytes: 30 },
    { templateHash: 'tmplA', values: ['reset'],    tenxHash: 'hashA', symbolMessage: 'error_database_connection_failed', lineBytes: 30 },
    // patternB (6 events)
    { templateHash: 'tmplB', values: ['42',  '/api/v1/users'],  tenxHash: 'hashB', symbolMessage: 'info_request_handled', lineBytes: 20 },
    { templateHash: 'tmplB', values: ['99',  '/api/v1/orders'], tenxHash: 'hashB', symbolMessage: 'info_request_handled', lineBytes: 21 },
    { templateHash: 'tmplB', values: ['15',  '/api/v1/health'], tenxHash: 'hashB', symbolMessage: 'info_request_handled', lineBytes: 22 },
    { templateHash: 'tmplB', values: ['100', '/api/v1/users'],  tenxHash: 'hashB', symbolMessage: 'info_request_handled', lineBytes: 23 },
    { templateHash: 'tmplB', values: ['200', '/api/v1/orders'], tenxHash: 'hashB', symbolMessage: 'info_request_handled', lineBytes: 24 },
    { templateHash: 'tmplB', values: ['5',   '/api/v1/health'], tenxHash: 'hashB', symbolMessage: 'info_request_handled', lineBytes: 25 },
    // patternC (1 event — low confidence)
    { templateHash: 'tmplC', values: ['abc123'], tenxHash: 'hashC', symbolMessage: 'debug_cache_miss', lineBytes: 15 },
  ];

  return {
    templates,
    encodedLines,
    aggregatedRows: [],
    wallTimeMs: 50,
    runtimeName: 'measure-test-123',
  };
}

// ── Mock install ──

before(async () => {
  runnerNs = (await import('../src/lib/mcp-app-runner.js')) as any;
  siemNs = (await import('../src/lib/siem/index.js')) as any;
  resolveNs = (await import('../src/lib/siem/resolve.js')) as any;

  // Patch the live namespaces. These persist for the whole file; the tool
  // imports them once and reads through the live binding on each call.
  runnerNs.runMcpAppOnEvents = async () => nextRunnerResult();
  siemNs.getConnector = () => makeConnector();
  resolveNs.resolveSiemSelection = async () => ({
    kind: 'resolved',
    id: 'splunk',
    displayName: 'Splunk',
    selectionMethod: 'sole',
  });
  resolveNs.formatAmbiguousError = () => 'ambiguous';
  resolveNs.formatNoneError = () => 'none';

  // Import the tool AFTER patching so its static imports resolve to the
  // patched namespace objects.
  ({ executeMeasureCompaction } = (await import('../src/tools/measure-compaction.js')) as any);
});

beforeEach(() => {
  runnerDefaultResult = makeFixtureResult();
  runnerOnceQueue = [];
  pullDefaultResult = defaultPullResult();
  pullOnceQueue = [];
  pullCalls.length = 0;
});

// ── Tests ──

test('returns a StructuredOutput envelope', async () => {
  const result = await executeMeasureCompaction(
    { service: 'my-service', sample_size: 11, timeRange: '1h' },
    fakeEnv,
  );
  assert.ok('schema_version' in result);
  assert.equal(result.tool, 'log10x_measure_compaction');
  assert.ok('data' in result);
  assert.ok('summary' in result);
});

test('returns patterns grouped by tenxHash', async () => {
  const result = await executeMeasureCompaction({ service: 'my-service' }, fakeEnv);
  const data = result.data.payload as any;
  assert.equal(data.patterns.length, 3); // hashA, hashB, hashC
});

test('computes compaction_ratio_x as total_original / total_encoded', async () => {
  const result = await executeMeasureCompaction({ service: 'my-service' }, fakeEnv);
  const data = result.data.payload as any;
  const patA = data.patterns.find((p: any) => p.pattern_hash === 'hashA');
  assert.ok(patA);
  // total_encoded_bytes = 4 * 30 = 120
  assert.equal(patA.total_encoded_bytes, 120);
  // total_original_bytes = sum of expandedByteLength(template, values):
  //   'ERROR Database connection failed: timeout' = 41, x2
  //   'ERROR Database connection failed: refused' = 41
  //   'ERROR Database connection failed: reset'   = 40
  //   total = 41+41+41+40 = 163
  assert.equal(patA.total_original_bytes, 163);
  // ratio = 163 / 120 ≈ 1.4 (rounded to 1 decimal)
  assert.ok(Math.abs(patA.compaction_ratio_x - 163 / 120) < 0.1);
});

test('assigns confidence tiers correctly', async () => {
  const result = await executeMeasureCompaction({ service: 'my-service' }, fakeEnv);
  const data = result.data.payload as any;
  const patA = data.patterns.find((p: any) => p.pattern_hash === 'hashA');
  const patB = data.patterns.find((p: any) => p.pattern_hash === 'hashB');
  const patC = data.patterns.find((p: any) => p.pattern_hash === 'hashC');

  // patA: 4 events → low (< 10)
  assert.equal(patA.confidence, 'low');
  // patB: 6 events → low (< 10)
  assert.equal(patB.confidence, 'low');
  // patC: 1 event → low
  assert.equal(patC.confidence, 'low');
});

test('assigns medium confidence for 10-49 events', async () => {
  const templates = new Map([
    ['tmplX', { templateHash: 'tmplX', template: 'level=$ msg=$', variableSlots: [] }],
  ]);
  const encodedLines = Array.from({ length: 15 }, (_, i) => ({
    templateHash: 'tmplX',
    values: ['INFO', `message ${i}`],
    tenxHash: 'hashX',
    symbolMessage: 'level_msg',
    lineBytes: 20,
  }));
  runnerOnceQueue.push({
    templates,
    encodedLines,
    aggregatedRows: [],
    wallTimeMs: 10,
    runtimeName: 'test',
  });

  const result = await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
  const data = result.data.payload as any;
  const pat = data.patterns.find((p: any) => p.pattern_hash === 'hashX');
  assert.equal(pat.confidence, 'medium');
  assert.equal(pat.sample_count, 15);
});

test('assigns high confidence for >= 50 events', async () => {
  const templates = new Map([
    ['tmplY', { templateHash: 'tmplY', template: 'ping $', variableSlots: [] }],
  ]);
  const encodedLines = Array.from({ length: 60 }, (_, i) => ({
    templateHash: 'tmplY',
    values: [`host${i}`],
    tenxHash: 'hashY',
    symbolMessage: 'ping',
    lineBytes: 15,
  }));
  runnerOnceQueue.push({
    templates,
    encodedLines,
    aggregatedRows: [],
    wallTimeMs: 10,
    runtimeName: 'test',
  });

  const result = await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
  const data = result.data.payload as any;
  const pat = data.patterns.find((p: any) => p.pattern_hash === 'hashY');
  assert.equal(pat.confidence, 'high');
});

test('includes must_render_verbatim table', async () => {
  const result = await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
  const data = result.data.payload as any;
  assert.equal(typeof data.must_render_verbatim, 'string');
  assert.ok(data.must_render_verbatim.includes('pattern_hash'));
  assert.ok(data.must_render_verbatim.includes('ratio_x'));
});

test('returns zero patterns and a useful summary when no events found', async () => {
  // Override the connector's pull for this test only.
  pullOnceQueue.push({
    events: [],
    metadata: { actualCount: 0, truncated: false, queryUsed: '', reasonStopped: 'source_exhausted' },
  });

  const result = await executeMeasureCompaction({ service: 'nonexistent' }, fakeEnv);
  const data = result.data.payload as any;
  assert.equal(data.patterns.length, 0);
  assert.equal(data.sample_size_actual, 0);
  assert.ok(result.summary.headline.includes('No events found'));
});

test('records siem_pull_ms and engine_ms in the data envelope', async () => {
  const result = await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
  const data = result.data.payload as any;
  assert.equal(typeof data.siem_pull_ms, 'number');
  assert.equal(typeof data.engine_ms, 'number');
});

test('uses default sample_size=500 and timeRange=24h when omitted', async () => {
  await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
  // The pull was invoked with the correct window + target.
  const callArgs = pullCalls[0];
  assert.ok(callArgs);
  assert.equal(callArgs.targetEventCount, 500);
  assert.equal(callArgs.window, '24h');
});
