import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneLine } from '../src/lib/siem/sample.js';

test('oneLine: plain string passes through unchanged', () => {
  const line = 'GET /health 200 5ms';
  assert.equal(oneLine(line, 120), line);
});

test('oneLine: object with .log field returns .log value', () => {
  const ev = { log: 'OOMKilled: pod exceeded memory limit', stream: 'stderr', docker: {} };
  assert.equal(oneLine(ev, 120), 'OOMKilled: pod exceeded memory limit');
  assert.notEqual(oneLine(ev, 120), '[object Object]');
});

test('oneLine: object with .message field returns .message value', () => {
  const ev = { message: 'user login failed for alice', level: 'ERROR', timestamp: 1234567890 };
  assert.equal(oneLine(ev, 120), 'user login failed for alice');
  assert.notEqual(oneLine(ev, 120), '[object Object]');
});

test('oneLine: object with neither .log/.message/.raw/.body falls back to JSON.stringify', () => {
  const ev = { severity: 'INFO', service: 'checkout', code: 42 };
  const result = oneLine(ev, 120);
  assert.notEqual(result, '[object Object]');
  // Must be valid JSON or contain the fields
  assert.match(result, /checkout/);
});

test('oneLine: deeply-wrapped fluentd/docker envelope unwraps to the real log line', () => {
  // CloudWatch shape: outer SIEM event has message = JSON string of fluentd record
  const inner = { log: 'cart service started on port 8080', stream: 'stdout', kubernetes: { pod_name: 'cart-xyz' } };
  const outer = { message: JSON.stringify(inner), '@timestamp': '2026-06-03T00:00:00Z' };
  const result = oneLine(outer, 120);
  assert.equal(result, 'cart service started on port 8080');
  assert.notEqual(result, '[object Object]');
});

test('oneLine: truncates to max chars and appends " ..."', () => {
  const long = 'x'.repeat(200);
  const result = oneLine(long, 120);
  assert.equal(result.length, 124); // 120 + ' ...'
  assert.ok(result.endsWith(' ...'));
});

test('oneLine: no case ever returns "[object Object]"', () => {
  const cases: unknown[] = [
    'plain string',
    { log: 'has log' },
    { message: 'has message' },
    { _raw: 'has raw' },
    { body: 'has body' },
    { unknown_field: 'no known field', count: 99 },
    { message: JSON.stringify({ log: 'nested fluentd line' }) },
    42,
    null,
    undefined,
  ];
  for (const c of cases) {
    const result = oneLine(c, 220);
    assert.notEqual(result, '[object Object]', `case: ${JSON.stringify(c)}`);
  }
});
