/**
 * The doctor compares the policy ConfigMap's caps.csv with its actions.csv.
 * A capped container with no action row never takes its planned action, and
 * the check names it; the old check passed as soon as actions.csv had any row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyActionsChecks } from '../src/tools/doctor.js';

const caps = 'container,cap\ntenx-seed,1::seed\nopentelemetry-collector,3988425::MCP configure_engine (soft)\ncart,22315::MCP configure_engine (soft)\n';

test('caps.csv with no actions.csv fails', () => {
  const [c] = policyActionsChecks(caps, null, 'demo', 'log10x-action-intent');
  assert.equal(c.status, 'fail');
  assert.match(c.message, /1\.1\.140 it starts and passes them/);
});

test('a capped container with no action row is named', () => {
  const actions = 'container,action\ntenx-seed,pass::seed\ncart,tier_down::MCP configure_engine (soft)\n';
  const [c] = policyActionsChecks(caps, actions, 'demo', 'log10x-action-intent');
  assert.equal(c.status, 'warn');
  assert.match(c.message, /opentelemetry-collector/);
  assert.doesNotMatch(c.message, /cart/);
});

test('every capped container with a row passes, the seed row ignored', () => {
  const actions = 'container,action\ncart,tier_down::x\nopentelemetry-collector,tier_down::x\n';
  const [c] = policyActionsChecks(caps, actions, 'demo', 'log10x-action-intent');
  assert.equal(c.status, 'pass');
});

test('a seed-only caps.csv yields no check', () => {
  assert.deepEqual(policyActionsChecks('container,cap\ntenx-seed,1::seed\n', null, 'demo', 'log10x-action-intent'), []);
});
