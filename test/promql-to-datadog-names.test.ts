import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promqlToDatadog } from '../src/lib/promql-to-datadog.js';

test('engine counters map to the log10x distributions', () => {
  const q = promqlToDatadog('sum(increase(all_events_summaryBytes_total{tenx_env="prod"}[1h]))');
  assert.match(q, /log10x\.all_events_summaryBytes\{tenx_env:prod\}/);
  assert.doesNotMatch(q, /_total/);
});

test('emitted counters map too', () => {
  const q = promqlToDatadog('sum by (message_pattern) (increase(emitted_events_summaryVolume_total[5m]))');
  assert.match(q, /log10x\.emitted_events_summaryVolume\{\*\}/);
});

test('other names lose only _total', () => {
  assert.match(promqlToDatadog('sum(rate(http_requests_total[5m]))'), /(^|[^.])http_requests\{\*\}/);
  assert.match(promqlToDatadog('sum(rate(http_request_duration_seconds_count[5m]))'), /http_request_duration_seconds_count\{\*\}/);
});

test('bare selectors and the optimized-size counter map too', () => {
  assert.match(promqlToDatadog('emitted_events_summaryBytes_total{tenx_env="prod"}'), /^sum:log10x\.emitted_events_summaryBytes\{tenx_env:prod\}$/);
  assert.match(promqlToDatadog('emitted_events_optimized_size_total[1h]'), /^sum:log10x\.emitted_events_optimized_size\{\*\}\.as_count\(\)$/);
  assert.match(promqlToDatadog('sum(increase(indexed_events_summaryVolume_total[1h]))'), /log10x\.indexed_events_summaryVolume/);
});
