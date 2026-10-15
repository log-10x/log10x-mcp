/**
 * Caps are enforced per Receiver. A DaemonSet Receiver sees only its node's
 * pods, so a cap measured on a container's whole stream is divided by the
 * nodes that container runs on; a Receiver beside a central forwarder sees the
 * whole stream and gets the undivided cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveEnforcingInstances,
  perInstanceCap,
  medianInstances,
  describeInstances,
  divideCapCsv,
  nodesPerContainerFromPods,
} from '../src/lib/enforcing-instances.js';
import { renderCsvDiff } from '../src/tools/configure-engine.js';
import { engineFilesFromContainerCaps } from '../src/lib/report/build-report-data.js';

test('instance counts: argument, then discovery, then pods, else unknown; sidecar is 1', () => {
  const e = resolveEnforcingInstances(['a', 'b', 'c', 'd'], {
    nodesByContainer: { a: 4 },
    discovered: { a: 9, b: 3 },
    fromPods: { b: 7, c: 2 },
  });
  assert.deepEqual(e.byContainer.a, { instances: 4, basis: 'argument' });
  assert.deepEqual(e.byContainer.b, { instances: 3, basis: 'discovery' });
  assert.deepEqual(e.byContainer.c, { instances: 2, basis: 'pod_list' });
  assert.deepEqual(e.byContainer.d, { instances: 1, basis: 'unknown' });
  const side = resolveEnforcingInstances(['a'], { mode: 'sidecar', nodesByContainer: { a: 4 } });
  assert.deepEqual(side.byContainer.a, { instances: 1, basis: 'sidecar' });
  assert.equal(describeInstances(e, 'b'), 'b: per node, 3 nodes from discovery');
  assert.equal(describeInstances(e, 'd'), 'd: node count unknown, written for one Receiver');
  assert.equal(describeInstances(side, 'a'), 'a: one Receiver sees its whole stream, cap not divided');
});

test('per-instance cap divides and never goes below 1 byte', () => {
  assert.equal(perInstanceCap(9000, 3), 3000);
  assert.equal(perInstanceCap(1, 5), 1);
  assert.equal(perInstanceCap(0, 1), 1);
});

test('median instances over known counts only', () => {
  const e = resolveEnforcingInstances(['a', 'b', 'c', 'd'], { discovered: { a: 2, b: 6, c: 4 } });
  assert.deepEqual(medianInstances(e), { median: 4, known: 3 });
  assert.deepEqual(medianInstances(resolveEnforcingInstances(['x'], {})), { median: 1, known: 0 });
});

test('nodes per container from pod rows count distinct nodes', () => {
  const n = nodesPerContainerFromPods([
    { nodeName: 'n1', containers: ['cart', 'istio-proxy'] },
    { nodeName: 'n2', containers: ['cart'] },
    { nodeName: 'n2', containers: ['cart'] },
    { containers: ['pending'] },
  ]);
  assert.deepEqual(n, { cart: 2, 'istio-proxy': 1 });
});

test('configure_engine divides a tier_down cap by the nodes its container runs on', () => {
  const rows = [
    { pattern_hash: 'a', pattern: 'kept', container: 'cart', current_bytes_30d: 0, cap_bytes_per_window: 9000, action: 'pass', saved_bytes_monthly: 0, saved_dollars_monthly: 0, projected_monthly_usd_low: 0, projected_monthly_usd_expected: 0, projected_monthly_usd_high: 0, reason: 'r' },
    { pattern_hash: 'b', pattern: 'moved', container: 'cart', current_bytes_30d: 0, cap_bytes_per_window: 50000, action: 'tier_down', saved_bytes_monthly: 0, saved_dollars_monthly: 0, projected_monthly_usd_low: 0, projected_monthly_usd_expected: 0, projected_monthly_usd_high: 0, reason: 'r' },
  ] as never;
  const actions = new Map([['cart', 'tier_down' as const]]);
  const whole = renderCsvDiff(['cart'], undefined, rows, 'tier_down', actions, 'hard');
  // Between the kept 9,000 and the moved 50,000, at their geometric mean: sqrt(9000 x 50000) = 21,213.
  assert.match(whole, /\+cart,21213::/);
  const perNode = renderCsvDiff(
    ['cart'], undefined, rows, 'tier_down', actions, 'hard', undefined,
    resolveEnforcingInstances(['cart'], { discovered: { cart: 3 } }),
  );
  assert.match(perNode, /\+cart,7071::/);
});

test('POC engine files divide the same way; offload stays at 1 byte', () => {
  const caps = {
    cart: { action: 'tier_down' as const, capBytesMonthly: 3_600_000 },
    ad: { action: 'offload' as const, capBytesMonthly: 0 },
  };
  // 3,600,000 bytes over a 3,600 s span is 240,000 per 240 s window.
  const one = engineFilesFromContainerCaps(caps, 3600, 'r');
  assert.match(one.capsCsv, /^cart,240000::r$/m);
  const four = engineFilesFromContainerCaps(caps, 3600, 'r', resolveEnforcingInstances(['cart', 'ad'], { fromPods: { cart: 4, ad: 2 } }));
  assert.match(four.capsCsv, /^cart,60000::r$/m);
  assert.match(four.capsCsv, /^ad,1::r$/m);
});

test('a POC caps.csv is divided row by row, header and preamble untouched', () => {
  const csv = '# target_percent=50\ncontainer,cap\ncart,9000::reason\nad,1::reason\n';
  const out = divideCapCsv(csv, resolveEnforcingInstances(['cart', 'ad'], { nodesByContainer: { cart: 3, ad: 5 } }));
  assert.equal(out, '# target_percent=50\ncontainer,cap\ncart,3000::reason\nad,1::reason\n');
});
