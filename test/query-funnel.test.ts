/**
 * query-funnel.ts acceptance tests.
 *
 * Verdict classifier + funnel extraction, exercised with the REAL _DONE
 * markers captured from the demo retriever plus synthetic markers covering
 * every engine close() reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnoseQuery,
  diagnoseFromStats,
  formatFunnel,
  type DoneMarker,
} from '../src/lib/query-funnel.js';

// Real marker captured live from the demo (diag-test-1, severity_level==ERROR, now-2h).
const REAL_DISPATCHED: DoneMarker = {
  queryId: 'diag-test-1',
  reason: 'dispatched',
  scanned: 0,
  matched: 0,
  skippedSearch: 0,
  skippedTemplate: 0,
  streamRequests: 0,
  streamBlobs: 0,
  submittedTasks: 60,
  expectedMarkers: 0,
  elapsedMs: 76,
};

test('real dispatched marker, 0 events -> DISPATCHED_BLIND with coordinator-blind funnel', () => {
  const d = diagnoseQuery(REAL_DISPATCHED, 0);
  assert.equal(d.verdict, 'DISPATCHED_BLIND');
  assert.equal(d.funnel.dispatched, 60);
  assert.equal(d.funnel.coordinatorBlind, true);
  assert.match(d.hint, /ROLLUP gap/);
  assert.match(d.explanation, /do NOT reflect what the subqueries found/);
});

test('any marker with events returned -> OK (authoritative over coordinator counters)', () => {
  // Even a "dispatched" marker whose own counters read 0: if files came back, it is OK.
  const d = diagnoseQuery(REAL_DISPATCHED, 5);
  assert.equal(d.verdict, 'OK');
  assert.equal(d.funnel.eventsReturned, 5);
  assert.match(d.explanation, /returned 5 event/);
});

test('OK but some worker files failed -> partial, hint to retry', () => {
  const d = diagnoseQuery({ reason: 'dispatched', submittedTasks: 10 }, 3, { failedWorkerFiles: 2 });
  assert.equal(d.verdict, 'OK');
  assert.match(d.explanation, /partial/);
  assert.match(d.hint, /retry fetch_results/i);
});

test('no marker -> NO_MARKER', () => {
  const d = diagnoseQuery(null, 0);
  assert.equal(d.verdict, 'NO_MARKER');
  assert.equal(d.funnel.dispatched, null);
  assert.match(d.hint, /retriever_query_status/);
});

test('empty-range -> EMPTY_RANGE, points at time-mapping', () => {
  const d = diagnoseQuery({ reason: 'empty-range', scanned: 0, submittedTasks: 0 }, 0);
  assert.equal(d.verdict, 'EMPTY_RANGE');
  assert.match(d.hint, /time-range -> blob mapping|time-mapping/);
});

test('bloom-miss -> BLOOM_REJECTED_ALL, reports scanned count', () => {
  const d = diagnoseQuery({ reason: 'bloom-miss', scanned: 42, matched: 0 }, 0);
  assert.equal(d.verdict, 'BLOOM_REJECTED_ALL');
  assert.match(d.explanation, /42 blob/);
  assert.match(d.hint, /match-all|probe/);
});

test('match-no-dispatch -> MATCHED_NO_EVENTS (predicate path)', () => {
  const d = diagnoseQuery({ reason: 'match-no-dispatch', scanned: 10, matched: 3, streamRequests: 0 }, 0);
  assert.equal(d.verdict, 'MATCHED_NO_EVENTS');
  assert.match(d.hint, /Probe|exact filter/);
});

test('local success but zero events -> MATCHED_NO_EVENTS (filter dropped all)', () => {
  const d = diagnoseQuery({ reason: 'success', scanned: 8, matched: 2, streamRequests: 0 }, 0);
  assert.equal(d.verdict, 'MATCHED_NO_EVENTS');
});

test('stream requested but files failed + zero events -> MATCHED_NO_EVENTS (stream failure flavor)', () => {
  const d = diagnoseQuery(
    { reason: 'success', scanned: 8, matched: 2, streamRequests: 4 },
    0,
    { failedWorkerFiles: 4 },
  );
  assert.equal(d.verdict, 'MATCHED_NO_EVENTS');
  assert.match(d.explanation, /failed/);
  assert.match(d.hint, /fetch\/permission|fetch_results/);
});

test('unknown reason, zero events -> INCONCLUSIVE', () => {
  const d = diagnoseQuery({ reason: 'unknown', scanned: 0 }, 0);
  assert.equal(d.verdict, 'INCONCLUSIVE');
});

test('funnel extraction maps marker fields and tolerates missing ones', () => {
  const d = diagnoseQuery({ reason: 'bloom-miss', scanned: 7 }, 0);
  assert.equal(d.funnel.scanned, 7);
  assert.equal(d.funnel.dispatched, null); // submittedTasks absent
  assert.equal(d.funnel.streamRequests, null);
  assert.equal(d.funnel.eventsReturned, 0);
});

test('formatFunnel renders a compact one-liner + blind tag for remote dispatch', () => {
  const line = formatFunnel(diagnoseQuery(REAL_DISPATCHED, 0));
  assert.match(line, /verdict=DISPATCHED_BLIND/);
  assert.match(line, /dispatched=60/);
  assert.match(line, /events=0/);
  assert.match(line, /coordinator-blind/);
});

test('formatFunnel has no blind tag for a local (non-dispatched) query', () => {
  const line = formatFunnel(diagnoseQuery({ reason: 'bloom-miss', scanned: 5 }, 0));
  assert.doesNotMatch(line, /coordinator-blind/);
  assert.match(line, /scanned=5/);
});

// --- diagnoseFromStats: ground truth from the engine's per-stage CW events ---

test('diagnoseFromStats: dbg-2 (matched, 0 bytes fetched) -> FETCH_OR_PARSE_EMPTY', () => {
  // Demo trace: scan matched 5 of 6 blobs, 2 workers ran, but 0 bytes of events
  // were fetched (fetchedBytes=0) and nothing reached the writer.
  const d = diagnoseFromStats(
    { scanned: 6, matched: 5, streamWorkers: 2, workersComplete: 2, fetchedBytes: 0, resultEvents: 0 },
    0,
  );
  assert.equal(d?.verdict, 'FETCH_OR_PARSE_EMPTY');
  assert.equal(d?.funnel.coordinatorBlind, false);
  assert.match(d!.explanation, /0 bytes of events were fetched/);
  assert.match(d!.hint, /fetch|parse/i);
});

test('diagnoseFromStats: real dbg-4 (matched, 816KB fetched, 0 written) -> FILTER_NO_MATCH', () => {
  // The actual demo trace: 26 resolved, 18 bloom-matched, 9 workers fetched
  // 816145 bytes of events, but the exact predicate wrote 0 (emptyFlushes=0).
  // fetchedBytes>0 PROVES fetch+parse worked — so this is a filter drop, NOT
  // fetch-empty. This case is exactly what corrected the verdict logic.
  const d = diagnoseFromStats(
    { submittedKeys: 26, scanned: 26, matched: 18, streamWorkers: 9, workersComplete: 9, fetchedBytes: 816145, resultEvents: 0, emptyFlushes: 0 },
    0,
  );
  assert.equal(d?.verdict, 'FILTER_NO_MATCH');
  assert.equal(d?.funnel.fetchedVolume, 816145);
  assert.match(d!.explanation, /816145 byte\(s\) of events were fetched/);
});

test('diagnoseFromStats: FILTER_NO_MATCH surfaces the exact predicate when present', () => {
  const d = diagnoseFromStats(
    { scanned: 6, matched: 5, fetchedBytes: 816145, resultEvents: 0, filterExpr: 'severity_level == "INFO"' },
    0,
  );
  assert.equal(d?.verdict, 'FILTER_NO_MATCH');
  assert.match(d!.explanation, /Filter applied: `severity_level == "INFO"`/);
});

test('diagnoseFromStats: s3BytesRead==0 (matched, nothing parsed) -> FETCH_EMPTY', () => {
  const d = diagnoseFromStats(
    { scanned: 6, matched: 5, fetchedBytes: 0, emptyFlushes: 0, resultEvents: 0, s3BytesRead: 0 },
    0,
  );
  assert.equal(d?.verdict, 'FETCH_EMPTY');
  assert.equal(d?.funnel.s3BytesRead, 0);
  assert.match(d!.explanation, /object read returned 0 bytes/);
});

test('diagnoseFromStats: s3BytesRead>0 but 0 parsed -> PARSE_EMPTY', () => {
  const d = diagnoseFromStats(
    { scanned: 6, matched: 5, fetchedBytes: 0, emptyFlushes: 0, resultEvents: 0, s3BytesRead: 4096 },
    0,
  );
  assert.equal(d?.verdict, 'PARSE_EMPTY');
  assert.match(d!.explanation, /returned 4096 byte\(s\), but 0 events were parsed/);
});

test('diagnoseFromStats: s3BytesRead absent -> FETCH_OR_PARSE_EMPTY (graceful fallback)', () => {
  // Engine that predates the s3BytesRead counter: cannot split fetch vs parse.
  const d = diagnoseFromStats(
    { scanned: 6, matched: 5, fetchedBytes: 0, emptyFlushes: 0, resultEvents: 0 },
    0,
  );
  assert.equal(d?.verdict, 'FETCH_OR_PARSE_EMPTY');
});

test('diagnoseFromStats: scanned 0 -> EMPTY_RANGE', () => {
  assert.equal(diagnoseFromStats({ scanned: 0, matched: 0 }, 0)?.verdict, 'EMPTY_RANGE');
});

test('diagnoseFromStats: submittedKeys 0 -> EMPTY_RANGE (resolution stage, ground truth)', () => {
  const d = diagnoseFromStats({ submittedKeys: 0, scanned: 0, matched: 0 }, 0);
  assert.equal(d?.verdict, 'EMPTY_RANGE');
  assert.equal(d?.funnel.resolvedBlobs, 0);
  assert.match(d!.explanation, /resolution stage mapped 0/);
});

test('diagnoseFromStats: scanned>0 matched 0 -> BLOOM_REJECTED_ALL', () => {
  assert.equal(diagnoseFromStats({ scanned: 9, matched: 0 }, 0)?.verdict, 'BLOOM_REJECTED_ALL');
});

test('diagnoseFromStats: events reached writer but exact predicate dropped all -> FILTER_NO_MATCH', () => {
  const d = diagnoseFromStats(
    { scanned: 6, matched: 5, streamWorkers: 2, resultEvents: 0, emptyFlushes: 12 },
    0,
  );
  assert.equal(d?.verdict, 'FILTER_NO_MATCH');
  assert.equal(d?.funnel.filterDropped, 12);
  assert.match(d!.explanation, /exact predicate wrote 0/);
});

test('diagnoseFromStats: events written but none reached caller -> DELIVERY_INCOMPLETE', () => {
  const d = diagnoseFromStats(
    { scanned: 6, matched: 5, streamWorkers: 2, fetchedBytes: 12345, resultEvents: 7 },
    0,
  );
  assert.equal(d?.verdict, 'DELIVERY_INCOMPLETE');
});

test('diagnoseFromStats: events returned -> OK', () => {
  assert.equal(diagnoseFromStats({ scanned: 6, matched: 5, fetchedBytes: 999, resultEvents: 7 }, 7)?.verdict, 'OK');
});

test('diagnoseFromStats: no stats -> null (caller falls back to marker)', () => {
  assert.equal(diagnoseFromStats(null, 0), null);
  assert.equal(diagnoseFromStats({}, 0), null);
});
