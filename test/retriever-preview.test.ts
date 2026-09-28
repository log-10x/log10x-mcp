/**
 * The retriever preview carries each event whole. It used to cut every event
 * at 240 characters with no marker, and the homepage demo quoted
 * "... - Transient error StatusCode.UNAVA" as if it were the line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PREVIEW_TEXT_MAX_CHARS, previewText } from '../src/lib/retriever-preview.js';

const RECOMMENDATION_LINE =
  '{"stream":"stderr","log":"2026-09-28 21:53:01,790 WARNING [opentelemetry.exporter.otlp.proto.grpc.exporter] ' +
  '[exporter.py:424] [trace_id=0 span_id=0 resource.service.name=recommendation trace_sampled=False] - ' +
  'Transient error StatusCode.UNAVAILABLE encountered while exporting logs to otel-collector:4317, retrying in 1s.",' +
  '"kubernetes":{"container_name":"recommendation","namespace_name":"otel-demo"}}';

test('retriever preview: a real log line longer than 240 characters comes back whole', () => {
  assert.ok(RECOMMENDATION_LINE.length > 240, 'fixture must exceed the old cut');
  const p = previewText(RECOMMENDATION_LINE);
  assert.equal(p.text, RECOMMENDATION_LINE);
  assert.ok(p.text!.includes('StatusCode.UNAVAILABLE encountered while exporting logs'));
  assert.equal(p.text_truncated, undefined);
  assert.equal(p.text_chars, undefined);
});

test('retriever preview: only a multi-kilobyte event is shortened, and it says so', () => {
  const blob = 'x'.repeat(PREVIEW_TEXT_MAX_CHARS + 500);
  const p = previewText(blob);
  assert.equal(p.text!.length, PREVIEW_TEXT_MAX_CHARS);
  assert.equal(p.text_truncated, true);
  assert.equal(p.text_chars, blob.length);
});

test('retriever preview: an event with no text contributes no text keys', () => {
  assert.deepEqual(previewText(undefined), {});
  assert.deepEqual(previewText(42), {});
});
