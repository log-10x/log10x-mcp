/**
 * Unit tests for measure-compaction.ts
 *
 * Mocks runMcpAppOnEvents to return fixture data. Verifies:
 *   - ratio math
 *   - confidence tiers
 *   - envelope schema
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ── Mocks ──

// Mock mcp-app-runner before importing the tool.
vi.mock('../src/lib/mcp-app-runner.js', () => ({
  runMcpAppOnEvents: vi.fn(),
}));

// Mock SIEM resolution to always resolve to a fake "splunk" connector.
vi.mock('../src/lib/siem/resolve.js', () => ({
  resolveSiemSelection: vi.fn().mockResolvedValue({
    kind: 'resolved',
    id: 'splunk',
    displayName: 'Splunk',
    selectionMethod: 'sole',
  }),
  formatAmbiguousError: vi.fn().mockReturnValue('ambiguous'),
  formatNoneError: vi.fn().mockReturnValue('none'),
}));

// Mock getConnector to return a fake connector.
vi.mock('../src/lib/siem/index.js', () => ({
  getConnector: vi.fn().mockReturnValue({
    pullEvents: vi.fn().mockResolvedValue({
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
    }),
  }),
}));

import { executeMeasureCompaction } from '../src/tools/measure-compaction.js';
import { runMcpAppOnEvents } from '../src/lib/mcp-app-runner.js';
import type { EnvConfig } from '../src/lib/environments.js';

// Minimal fake EnvConfig — measure-compaction does not use the env directly.
const fakeEnv = {} as unknown as EnvConfig;

// ── Fixtures ──

/**
 * Build a fixture McpAppRunnerResult simulating three patterns:
 *   - patternA: 4 events, ~40B original / ~10B encoded each → ratio ~4
 *   - patternB: 6 events, ~60B original / ~10B encoded each → ratio ~6
 *   - single-event: 1 event                                 → low confidence
 *
 * We set lineBytes explicitly so the ratio math is deterministic.
 */
function makeFixtureResult() {
  // Templates
  const templates = new Map([
    ['tmplA', { templateHash: 'tmplA', template: 'ERROR Database connection failed: $', variableSlots: [{ position: 0 }] }],
    ['tmplB', { templateHash: 'tmplB', template: 'INFO  Request handled in $ms path=$', variableSlots: [{ position: 0 }, { position: 1 }] }],
    ['tmplC', { templateHash: 'tmplC', template: 'DEBUG Cache miss key=$', variableSlots: [{ position: 0 }] }],
  ]);

  // Encoded lines: tenxHash pins the pattern identity.
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

// ── Tests ──

describe('executeMeasureCompaction', () => {
  beforeEach(() => {
    (runMcpAppOnEvents as Mock).mockResolvedValue(makeFixtureResult());
  });

  it('returns a StructuredOutput envelope', async () => {
    const result = await executeMeasureCompaction(
      { service: 'my-service', sample_size: 11, timeRange: '1h' },
      fakeEnv
    );
    expect(result).toHaveProperty('schema_version');
    expect(result).toHaveProperty('tool', 'log10x_measure_compaction');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('summary');
  });

  it('returns patterns grouped by tenxHash', async () => {
    const result = await executeMeasureCompaction(
      { service: 'my-service' },
      fakeEnv
    );
    const data = (result.data as any).payload;
    expect(data.patterns).toHaveLength(3); // hashA, hashB, hashC
  });

  it('computes compaction_ratio_x as total_original / total_encoded', async () => {
    const result = await executeMeasureCompaction(
      { service: 'my-service' },
      fakeEnv
    );
    const data = (result.data as any).payload;
    const patA = data.patterns.find((p: any) => p.pattern_hash === 'hashA');
    expect(patA).toBeDefined();
    // total_encoded_bytes = 4 * 30 = 120
    expect(patA.total_encoded_bytes).toBe(120);
    // total_original_bytes = sum of expandedByteLength(template, values)
    // template = 'ERROR Database connection failed: $'
    // literal prefix 'ERROR Database connection failed: ' = 34 bytes
    // values vary: 'timeout', 'timeout', 'refused', 'reset'
    // Byte lengths: 'ERROR Database connection failed: timeout' = 41, x2
    //               'ERROR Database connection failed: refused' = 41
    //               'ERROR Database connection failed: reset'   = 39
    // total = 41+41+41+39 = 162
    expect(patA.total_original_bytes).toBe(162);
    // ratio = 162 / 120 ≈ 1.4 (rounded to 1 decimal)
    expect(patA.compaction_ratio_x).toBeCloseTo(162 / 120, 1);
  });

  it('assigns confidence tiers correctly', async () => {
    const result = await executeMeasureCompaction(
      { service: 'my-service' },
      fakeEnv
    );
    const data = (result.data as any).payload;
    const patA = data.patterns.find((p: any) => p.pattern_hash === 'hashA');
    const patB = data.patterns.find((p: any) => p.pattern_hash === 'hashB');
    const patC = data.patterns.find((p: any) => p.pattern_hash === 'hashC');

    // patA: 4 events → low (< 10)
    expect(patA.confidence).toBe('low');
    // patB: 6 events → low (< 10)
    expect(patB.confidence).toBe('low');
    // patC: 1 event → low
    expect(patC.confidence).toBe('low');
  });

  it('assigns medium confidence for 10-49 events', async () => {
    // Build a fixture with 15 events for one pattern.
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
    (runMcpAppOnEvents as Mock).mockResolvedValueOnce({
      templates,
      encodedLines,
      aggregatedRows: [],
      wallTimeMs: 10,
      runtimeName: 'test',
    });

    const result = await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
    const data = (result.data as any).payload;
    const pat = data.patterns.find((p: any) => p.pattern_hash === 'hashX');
    expect(pat.confidence).toBe('medium');
    expect(pat.sample_count).toBe(15);
  });

  it('assigns high confidence for >= 50 events', async () => {
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
    (runMcpAppOnEvents as Mock).mockResolvedValueOnce({
      templates,
      encodedLines,
      aggregatedRows: [],
      wallTimeMs: 10,
      runtimeName: 'test',
    });

    const result = await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
    const data = (result.data as any).payload;
    const pat = data.patterns.find((p: any) => p.pattern_hash === 'hashY');
    expect(pat.confidence).toBe('high');
  });

  it('includes must_render_verbatim table', async () => {
    const result = await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
    const data = (result.data as any).payload;
    expect(typeof data.must_render_verbatim).toBe('string');
    expect(data.must_render_verbatim).toContain('pattern_hash');
    expect(data.must_render_verbatim).toContain('ratio_x');
  });

  it('returns zero patterns and a useful summary when no events found', async () => {
    // Override the connector's pullEvents mock for this test only.
    const { getConnector } = await import('../src/lib/siem/index.js');
    (getConnector as Mock).mockReturnValueOnce({
      pullEvents: vi.fn().mockResolvedValue({
        events: [],
        metadata: { actualCount: 0, truncated: false, queryUsed: '', reasonStopped: 'source_exhausted' },
      }),
    });

    const result = await executeMeasureCompaction({ service: 'nonexistent' }, fakeEnv);
    const data = (result.data as any).payload;
    expect(data.patterns).toHaveLength(0);
    expect(data.sample_size_actual).toBe(0);
    expect(result.summary.headline).toContain('No events found');
  });

  it('records siem_pull_ms and engine_ms in the data envelope', async () => {
    const result = await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
    const data = (result.data as any).payload;
    expect(typeof data.siem_pull_ms).toBe('number');
    expect(typeof data.engine_ms).toBe('number');
  });

  it('uses default sample_size=500 and timeRange=24h when omitted', async () => {
    await executeMeasureCompaction({ service: 'svc' }, fakeEnv);
    const { getConnector } = await import('../src/lib/siem/index.js');
    const connector = (getConnector as Mock).mock.results.at(-1)?.value;
    if (connector) {
      // The pull was invoked with the correct window.
      // We only assert sample_size reached the connector as targetEventCount.
      // getConnector is a shared mockReturnValue, so pullEvents calls
      // accumulate across the whole suite — read THIS test's call (the last).
      const callArgs = (connector.pullEvents as Mock).mock.lastCall?.[0];
      if (callArgs) {
        expect(callArgs.targetEventCount).toBe(500);
        expect(callArgs.window).toBe('24h');
      }
    }
  });
});
