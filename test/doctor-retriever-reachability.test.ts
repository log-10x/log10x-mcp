/**
 * Doctor retriever-reachability classifier.
 *
 * Regression for the false-PASS bug: the helm_release_probe fallback resolves
 * the in-cluster Service DNS name (*.svc.cluster.local), which doctor used to
 * report as a healthy endpoint even though it is unreachable from an MCP host
 * outside the cluster. isClusterInternalUrl is the gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClusterInternalUrl } from '../src/tools/doctor.js';

test('isClusterInternalUrl flags in-cluster Service DNS', () => {
  // The exact shape the demo env's helm_release_probe fallback emits.
  assert.equal(
    isClusterInternalUrl('http://my-retriever-retriever-10x-all-in-one.log10x.svc.cluster.local:80'),
    true
  );
  assert.equal(isClusterInternalUrl('http://svc.namespace.svc.cluster.local'), true);
  assert.equal(isClusterInternalUrl('http://foo.bar.svc'), true);
  assert.equal(isClusterInternalUrl('https://thing.cluster.local'), true);
  assert.equal(isClusterInternalUrl('http://host.internal:8080'), true);
});

test('isClusterInternalUrl passes externally-routable endpoints', () => {
  assert.equal(isClusterInternalUrl('https://retriever.log10x.com'), false);
  assert.equal(
    isClusterInternalUrl('https://abc123.us-east-1.elb.amazonaws.com:443'),
    false
  );
  assert.equal(isClusterInternalUrl('http://10.0.1.5:80'), false); // IP, not a .local name
  assert.equal(isClusterInternalUrl('not a url'), false);
});
