/**
 * Unit tests for streamer-diagnostics buildDiagnostics and explainZeroResults.
 *
 * No real CW polling here — we feed synthetic CW event arrays and assert the
 * resulting diagnostic shape. These tests lock down the diagnostic signatures
 * that the MCP and console rely on for debugging zero-result queries.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildDiagnostics,
  explainZeroResults,
  type StreamerQueryDiagnostics,
} from '../src/lib/streamer-diagnostics.js';

// The CWEvent shape expected by buildDiagnostics.
interface CWEvent {
  level: string;
  message: string;
  data?: Record<string, number | string>;
  ts: number;
}

function ev(level: string, message: string, data?: Record<string, number | string>, ts = 0): CWEvent {
  return { level, message, data, ts };
}

test('buildDiagnostics: empty input yields empty diagnostics', () => {
  const d = buildDiagnostics([]);
  assert.deepEqual(d, {});
});

test('buildDiagnostics: query plan event populates queryPlan', () => {
  const d = buildDiagnostics([
    ev('INFO', 'query plan: templateHashes=3, vars=2, timeslice=60000ms, dispatch=remote', {
      templateHashes: 3,
      vars: 2,
      timeslice: 60000,
      dispatch: 'remote',
    }),
  ]);
  assert.deepEqual(d.queryPlan, {
    templateHashes: 3,
    vars: 2,
    timeslice: 60000,
    dispatch: 'remote',
  });
});

test('buildDiagnostics: unknown dispatch value falls back to "unknown"', () => {
  const d = buildDiagnostics([
    ev('INFO', 'query plan: templateHashes=0, vars=1', {
      templateHashes: 0,
      vars: 1,
      timeslice: 0,
      dispatch: 'hybrid-future-mode',
    }),
  ]);
  assert.equal(d.queryPlan?.dispatch, 'unknown');
});

test('buildDiagnostics: query empty event sets emptyReason', () => {
  const d = buildDiagnostics([
    ev('INFO', 'query empty: no matching template hashes or vars (templateHashes=0, vars=0)', {
      reason: 'no_template_hashes_or_vars',
      templateHashCount: 0,
      varsCount: 0,
    }),
  ]);
  assert.equal(d.emptyReason, 'no_template_hashes_or_vars');
});

test('buildDiagnostics: multiple scan complete events aggregate', () => {
  const d = buildDiagnostics([
    ev('PERF', 'scan complete: scanned=100, matched=20, skippedDuplicate=3, skippedSearch=77, skippedTemplate=0', {
      scanned: 100,
      matched: 20,
      skippedDuplicate: 3,
      skippedSearch: 77,
      skippedTemplate: 0,
    }),
    ev('PERF', 'scan complete: scanned=50, matched=10, skippedDuplicate=1, skippedSearch=39, skippedTemplate=0', {
      scanned: 50,
      matched: 10,
      skippedDuplicate: 1,
      skippedSearch: 39,
      skippedTemplate: 0,
    }),
  ]);
  assert.deepEqual(d.scanStats, {
    scanned: 150,
    matched: 30,
    skippedSearch: 116,
    skippedTemplate: 0,
    skippedDuplicate: 4,
  });
});

test('buildDiagnostics: worker started/complete counts aggregate', () => {
  const d = buildDiagnostics([
    ev('PERF', 'stream worker started: object=a.log, byteRanges=2, fetchRange=[0,1000] (1000 bytes)'),
    ev('PERF', 'stream worker started: object=b.log, byteRanges=1, fetchRange=[0,500] (500 bytes)'),
    ev('PERF', 'stream worker complete: fetched 1000 bytes', { fetchedBytes: 1000 }),
    ev('PERF', 'results writer complete: 42 events written, 0 dropped, 8000 bytes', { resultEvents: 42 }),
  ]);
  assert.equal(d.workerStats?.started, 2);
  assert.equal(d.workerStats?.complete, 1);
  assert.equal(d.workerStats?.totalFetchedBytes, 1000);
  assert.equal(d.workerStats?.totalResultEvents, 42);
});

test('buildDiagnostics: only first "query complete" sets coordinatorElapsedMs', () => {
  const d = buildDiagnostics([
    ev('PERF', 'query complete: elapsed=250ms', { elapsedMs: 250 }),
    ev('PERF', 'query complete: elapsed=42ms', { elapsedMs: 42 }), // sub-query, should be ignored
  ]);
  assert.equal(d.coordinatorElapsedMs, 250);
});

test('buildDiagnostics: ERROR-level events collected', () => {
  const d = buildDiagnostics([
    ev('ERROR', 'query aborted: processing time limit exceeded'),
    ev('INFO', 'query plan: templateHashes=0, vars=1'),
    ev('ERROR', 'scan error: failed reading object=x'),
  ]);
  assert.deepEqual(d.errors, [
    'query aborted: processing time limit exceeded',
    'scan error: failed reading object=x',
  ]);
});

test('explainZeroResults: pollingError takes precedence', () => {
  const d: StreamerQueryDiagnostics = { pollingError: 'AWS CLI not found' };
  assert.match(explainZeroResults(d)!, /Diagnostics unavailable/);
});

test('explainZeroResults: emptyReason yields token-explanation', () => {
  const d: StreamerQueryDiagnostics = { emptyReason: 'no_template_hashes_or_vars' };
  assert.match(explainZeroResults(d)!, /no Bloom filter tokens/);
});

test('explainZeroResults: scan matched=0 distinguishes from missing scanStats', () => {
  const d: StreamerQueryDiagnostics = {
    queryPlan: { templateHashes: 0, vars: 1, timeslice: 0, dispatch: 'local' },
    scanStats: { scanned: 100, matched: 0, skippedSearch: 100, skippedTemplate: 0, skippedDuplicate: 0 },
  };
  const msg = explainZeroResults(d)!;
  assert.match(msg, /Bloom filter scanned 100/);
  assert.match(msg, /none matched/);
});

test('explainZeroResults: Bloom false positive (matched>0 but no results and all workers complete)', () => {
  const d: StreamerQueryDiagnostics = {
    scanStats: { scanned: 50, matched: 10, skippedSearch: 40, skippedTemplate: 0, skippedDuplicate: 0 },
    workerStats: { started: 10, complete: 10, totalFetchedBytes: 1000, totalResultEvents: 0 },
  };
  assert.match(explainZeroResults(d)!, /false positives/);
});

test('explainZeroResults: worker timeout (matched>0, complete<started)', () => {
  const d: StreamerQueryDiagnostics = {
    scanStats: { scanned: 50, matched: 10, skippedSearch: 40, skippedTemplate: 0, skippedDuplicate: 0 },
    workerStats: { started: 10, complete: 3, totalFetchedBytes: 500, totalResultEvents: 0 },
  };
  const msg = explainZeroResults(d)!;
  assert.match(msg, /only 3 completed/);
  assert.match(msg, /still be arriving/);
});

test('explainZeroResults: queryPlan present, scanStats missing, NOT partial → stale indexer', () => {
  const d: StreamerQueryDiagnostics = {
    queryPlan: { templateHashes: 0, vars: 1, timeslice: 0, dispatch: 'local' },
    // partialResults intentionally unset — means marker poll reached stability
  };
  const msg = explainZeroResults(d)!;
  assert.match(msg, /no index objects exist for the time range/);
  assert.match(msg, /indexer is running/);
});

test('explainZeroResults: queryPlan present, scanStats missing, partial → poll timeout hypothesis', () => {
  const d: StreamerQueryDiagnostics = {
    queryPlan: { templateHashes: 0, vars: 1, timeslice: 0, dispatch: 'local' },
    partialResults: true,
  };
  const msg = explainZeroResults(d)!;
  assert.match(msg, /MCP poll timed out/);
  assert.match(msg, /log10x_streamer_query_status/);
});

test('explainZeroResults: no diagnostic signal returns null', () => {
  const d: StreamerQueryDiagnostics = {};
  assert.equal(explainZeroResults(d), null);
});

test('explainZeroResults: error takes precedence over scanStats', () => {
  const d: StreamerQueryDiagnostics = {
    scanStats: { scanned: 10, matched: 5, skippedSearch: 5, skippedTemplate: 0, skippedDuplicate: 0 },
    errors: ['query aborted: timeout'],
  };
  assert.match(explainZeroResults(d)!, /1 error/);
});
