import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupCommandCell,
  normalizeForwarder,
  FILL_ME_NS,
  FILL_ME_WORKLOAD,
  _cellKeys,
  type CmdCtx,
} from '../src/lib/report/command-matrix.js';

const ctx: CmdCtx = { namespace: 'demo', workload: 'tenx-fluentd', capsFileName: 'log10x-caps.csv' };
const bareCtx: CmdCtx = { capsFileName: 'log10x-caps.csv' };

test('v1 ships exactly the two designed cells', () => {
  assert.deepEqual(_cellKeys().sort(), ['cloudwatch|fluentd|k8s', 'splunk|hec|k8s']);
});

test('every cell renders apply/undo with full ctx and no fill-me markers', () => {
  for (const key of _cellKeys()) {
    const [siem, fwd, install] = key.split('|');
    const cell = lookupCommandCell(siem, fwd, install as 'k8s' | 'host');
    assert.ok(cell, key);
    for (const block of [cell!.applyCaps(ctx), cell!.undoCaps(ctx)]) {
      assert.ok(block.length > 0, key);
      const joined = block.join('\n');
      assert.ok(!joined.includes(FILL_ME_NS), key);
      assert.ok(!joined.includes(FILL_ME_WORKLOAD), key);
      assert.ok(joined.includes('demo'), key);
    }
  }
});

test('missing ctx renders explicit fill-me markers, never invented values', () => {
  const cell = lookupCommandCell('cloudwatch', 'fluentd', 'k8s')!;
  const joined = cell.applyCaps(bareCtx).join('\n');
  assert.ok(joined.includes(FILL_ME_NS));
  assert.ok(joined.includes(FILL_ME_WORKLOAD));
  assert.ok(!joined.includes('default'));
});

test('forwarder aliases normalize; unknown forwarders do not resolve to a cell', () => {
  assert.equal(normalizeForwarder('fluentbit'), 'fluent-bit');
  assert.equal(normalizeForwarder('Fluentd'), 'fluentd');
  assert.equal(normalizeForwarder('splunk-uf'), null);
  assert.equal(lookupCommandCell('cloudwatch', 'vector', 'k8s'), null);
  assert.equal(lookupCommandCell('cloudwatch', 'fluentd', 'host'), null);
  assert.equal(lookupCommandCell(null, 'fluentd', 'k8s'), null);
});
