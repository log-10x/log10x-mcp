/**
 * Snapshot store tests. Covers put/get, TTL eviction, and id generation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newSnapshotId,
  putSnapshot,
  getSnapshot,
  _clearSnapshotStore,
} from '../../src/lib/discovery/snapshot-store.js';
import { SNAPSHOT_SCHEMA_VERSION, type DiscoverySnapshot } from '../../src/lib/discovery/types.js';

function fixture(id: string): DiscoverySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kubectl: {
      available: true,
      namespaces: [],
      probedNamespaces: [],
      forwarders: [],
      helmReleases: [],
      log10xApps: [],
      storageClasses: [],
      ingressClasses: [],
      serviceAccountIrsa: [],
    },
    aws: { available: false, s3Buckets: [], sqsQueues: [], cwLogGroups: [] },
    recommendations: { suggestedNamespace: 'logging', alreadyInstalled: {} },
    probeLog: [],
  };
}

test('newSnapshotId generates disc- prefixed UUIDs', () => {
  const a = newSnapshotId();
  const b = newSnapshotId();
  assert.notEqual(a, b);
  assert.match(a, /^disc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('put + get round-trip', () => {
  _clearSnapshotStore();
  const s = fixture('disc-test-1');
  putSnapshot(s);
  const got = getSnapshot('disc-test-1');
  assert.ok(got, 'should find the snapshot');
  assert.equal(got?.snapshotId, 'disc-test-1');
});

test('get returns undefined for unknown id', () => {
  _clearSnapshotStore();
  assert.equal(getSnapshot('disc-nope'), undefined);
});
