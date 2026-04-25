import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeToolError } from '../src/lib/tool-errors.js';

test('describeToolError adds 401 hint pointing at doctor for any tool', () => {
  const out = describeToolError('log10x_cost_drivers', new Error('Prometheus HTTP 401: Unauthorized'));
  assert.match(out, /HTTP 401/);
  assert.match(out, /log10x_doctor/);
});

test('describeToolError adds 5xx hint mentioning retry exhaustion', () => {
  const out = describeToolError('log10x_pattern_trend', new Error('Prometheus HTTP 503: Service Unavailable'));
  assert.match(out, /HTTP 503/);
  assert.match(out, /log10x_doctor|gateway/);
});

test('investigate-specific: unresolved anchor suggests event_lookup', () => {
  const out = describeToolError('log10x_investigate', new Error('Could not resolve "checkoutservice" to a known pattern'));
  assert.match(out, /log10x_event_lookup/);
});

test('resolve_batch: too-large batch suggests pagination or privacy_mode', () => {
  const out = describeToolError(
    'log10x_resolve_batch',
    new Error('Batch too large: 250.0 KB exceeds the 100 KB paste Lambda limit')
  );
  assert.match(out, /paginate|privacy_mode/);
});

test('retriever_query: not-configured suggests deployment URL', () => {
  const out = describeToolError(
    'log10x_retriever_query',
    new Error('Retriever endpoint not configured')
  );
  assert.match(out, /Retriever|__SAVE_LOG10X_RETRIEVER_URL__/);
});

test('investigation_get: missing record explains TTL eviction', () => {
  const out = describeToolError(
    'log10x_investigation_get',
    new Error('No investigation with id "abc" in this session\'s cache')
  );
  assert.match(out, /TTL|LRU|regenerate/);
});

test('describeToolError returns plain Error: prefix when no suggestion fits', () => {
  const out = describeToolError('log10x_savings', new Error('something exotic'));
  assert.match(out, /^Error: something exotic/);
});
