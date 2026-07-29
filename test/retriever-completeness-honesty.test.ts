/**
 * The retriever must never present an INFERRED completion as verified.
 *
 * Measured on the demo Lambda retriever: a count query returned 330 of 1,217
 * events in S3 (3 of 10 worker files) while reporting `truncated: false`,
 * `partial_results: false`, and the sentence "Wall time was clean and no
 * worker reported partial results." Recall across repeat runs of the same
 * query was 27%, 42%, 89%, 100% — non-deterministic, and silent every time.
 *
 * Two distinct facts were being conflated:
 *   - `partialResults` answers "did a worker declare ITSELF short"
 *   - completeness answers "did we collect EVERY worker"
 * Both can be clean while the result set is a quarter of the truth.
 *
 * The coordinator is not at fault: in remote-dispatch mode it submits scan
 * tasks to SQS and exits, and stream markers are written by other processes
 * in numbers that depend on bloom matches. It cannot know the count, so it
 * writes expectedMarkers=0 and the client falls back to a quiet-window guess.
 * The guess is fine. Reporting the guess as fact is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrieverQueryHumanSummary as buildHumanSummary } from '../src/tools/retriever-query.js';

const base = {
  eventsMatched: 330,
  eventsReturned: 0,
  wallTimeMs: 93_294,
  from: '2026-06-23T00:00:00Z',
  to: '2026-06-23T01:00:00Z',
  target: 'app',
  truncated: false,
  partialResults: false,
  offloadedHashCount: 0,
  previewBasis: 'none' as const,
};

test('an inferred completion is never reported as clean', () => {
  const summary = buildHumanSummary({
    ...base,
    completenessBasis: 'quiet_window_inferred',
  } as never);

  assert.ok(
    !/no worker reported partial results/i.test(summary),
    'must not reuse the sentence that accompanied a 27%-recall result'
  );
  assert.match(summary, /INFERRED/, 'must name the guess as a guess');
  assert.match(
    summary,
    /forensic or compliance/i,
    'must warn against authoritative use of an unverified result'
  );
});

test('a confirmed completion says so, and carries no caveat', () => {
  const summary = buildHumanSummary({
    ...base,
    completenessBasis: 'marker_count_confirmed',
  } as never);

  assert.match(summary, /Completeness confirmed/i);
  assert.ok(!/INFERRED/.test(summary), 'a counted result must not be hedged');
});

test('truncation and inference are reported independently', () => {
  const summary = buildHumanSummary({
    ...base,
    truncated: true,
    completenessBasis: 'quiet_window_inferred',
  } as never);

  assert.match(summary, /truncated at the per-worker cap/);
  assert.match(summary, /INFERRED/);
});

test('a worker-declared partial is still surfaced alongside inference', () => {
  const summary = buildHumanSummary({
    ...base,
    partialResults: true,
    completenessBasis: 'quiet_window_inferred',
  } as never);

  assert.match(summary, /one or more workers were partial/);
  assert.match(summary, /INFERRED/);
});
