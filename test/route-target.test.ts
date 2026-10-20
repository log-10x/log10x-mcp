import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeTarget } from '../src/lib/report/user-units.js';

test('tier_down alone stays in the SIEM and keeps every line', () => {
  const r = routeTarget(new Set(['tier_down']), 'datadog');
  assert.equal(r.short, 'Flex Logs');
  assert.match(r.clause, /^go to Flex Logs, where they stay searchable in Datadog$/);
  assert.equal(r.leavesIndex, true);
  assert.equal(r.lossless, true);
});

test('compact stays in the SIEM and is not said to leave the index', () => {
  const r = routeTarget(new Set(['compact']), 'splunk');
  assert.match(r.clause, /compact form, still in the SIEM/);
  assert.equal(r.leavesIndex, false);
  assert.equal(r.lossless, true);
});

test('drop and sample are lossy and say so', () => {
  const d = routeTarget(new Set(['drop']), 'cloudwatch');
  assert.match(d.clause, /deletes them/);
  assert.equal(d.lossless, false);
  const s = routeTarget(new Set(['tier_down', 'sample']), 'cloudwatch');
  assert.match(s.clause, /^go, by container, to /);
  assert.match(s.clause, /sampling/);
  assert.equal(s.lossless, false);
});

test('three routes read as a list', () => {
  const r = routeTarget(new Set(['tier_down', 'offload', 'compact']), 'cloudwatch');
  assert.equal(r.short, 'Infrequent Access, the offload bucket and compact form');
  assert.doesNotMatch(r.clause, /others/);
});
