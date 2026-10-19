/**
 * Gate for handoff 4b.1: the regulator values on every Datadog Receiver
 * install, independent of the fleet default, and the error keep count and
 * totals file on the first engine that declares them (1.1.146).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { receiverFleetValues } from '../src/lib/fleet-default-install.js';
import { renderPolicyConfigMapManifest, renderPolicyPullEnvLines } from '../src/lib/advisor/reporter-forwarders.js';

const values = (o: Array<[string, string]>, k: string): string[] => o.filter(([key]) => key === k).map(([, v]) => v);

test('4b.1 gate: a Datadog Receiver plan with no fleet default carries the regulator values', () => {
  const rv = receiverFleetValues({ datadog: true, engineVersion: '1.1.145' });
  assert.deepEqual(values(rv.options, 'rateReceiverWarmupMs'), ['0']);
  assert.deepEqual(values(rv.options, 'rateReceiverMinSharePercent'), ['0']);
  assert.deepEqual(values(rv.options, 'rateReceiverMinRetentionThreshold'), ['0']);
  assert.deepEqual(values(rv.options, 'rateReceiverSeverityFloors'), [
    'TRACE=0', 'DEBUG=0', 'INFO=0', 'WARN=0', 'ERROR=0', 'CRITICAL=0', 'FATAL=0',
  ]);
  // No fleet default given: no limit and no default action are written.
  assert.deepEqual(values(rv.options, 'rateReceiverAbsoluteCap'), []);
  assert.deepEqual(values(rv.options, 'rateReceiverDefaultAction'), []);
});

test('4b.1: the error floor is half when a service offloads and the engine has no keep counts', () => {
  const rv = receiverFleetValues({ datadog: true, engineVersion: '1.1.145', anyOffload: true });
  assert.ok(values(rv.options, 'rateReceiverSeverityFloors').includes('ERROR=0.5'));
  assert.deepEqual(values(rv.options, 'rateReceiverKeepCounts'), []);
});

test('4b.1 gate: keep counts are written from 1.1.146 only, K = 50 by default', () => {
  const early = receiverFleetValues({ datadog: true, engineVersion: '1.1.145' });
  assert.deepEqual(values(early.options, 'rateReceiverKeepCounts'), []);
  const ready = receiverFleetValues({ datadog: true, engineVersion: '1.1.146' });
  assert.deepEqual(values(ready.options, 'rateReceiverKeepCounts'), ['ERROR=50', 'CRITICAL=50', 'FATAL=50']);
  // K replaces the share floor on the error levels.
  assert.ok(values(ready.options, 'rateReceiverSeverityFloors').includes('ERROR=0'));
  const k = receiverFleetValues({ datadog: true, engineVersion: '1.1.146', keepCount: 20, fleetDefault: { capBytesPerWindowPerNode: 6000, action: 'offload' } });
  assert.deepEqual(values(k.options, 'rateReceiverKeepCounts'), ['ERROR=20', 'CRITICAL=20', 'FATAL=20']);
  assert.ok(values(k.options, 'rateReceiverSeverityFloors').includes('ERROR=0'));
  // Each option once: the fleet default path does not repeat the regulator values.
  assert.equal(values(k.options, 'rateReceiverWarmupMs').length, 1);
});

test('4b.1: a non-Datadog Receiver gets none of it; an old engine gets none of it', () => {
  assert.deepEqual(receiverFleetValues({ datadog: false, engineVersion: '1.1.146' }).options, []);
  const old = receiverFleetValues({ datadog: true, engineVersion: '1.1.136' });
  assert.deepEqual(values(old.options, 'rateReceiverWarmupMs'), []);
  assert.deepEqual(old.options, [['symbolMessageHashField', 'tenx_hash']]);
});

test('4b.1 gate: the seed ConfigMap carries totals.csv and the Receiver env points at it', () => {
  const m = renderPolicyConfigMapManifest('logging');
  assert.match(m, /totals\.csv: \|\n    container,total\n    tenx-seed,1::/);
  const env = renderPolicyPullEnvLines('  ').join('\n');
  assert.match(env, /- name: TOTAL_LOOKUP_FILE\n    value: \/tmp\/tenx\/kubernetes\/\$\(K8S_NAMESPACE\)\/log10x-action-intent\/totals\.csv/);
});
