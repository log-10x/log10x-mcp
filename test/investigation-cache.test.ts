import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordInvestigation,
  getInvestigation,
  listInvestigations,
  clearInvestigationsForTest,
} from '../src/lib/investigation-cache.js';

function rec(id: string, age = 0) {
  return {
    investigationId: id,
    createdAt: Date.now() - age,
    startingPoint: 'svc-' + id,
    environment: 'demo',
    reporterTier: 'edge',
    shape: 'acute' as const,
    report: '## report ' + id,
    patternsReferenced: [],
  };
}

beforeEach(() => clearInvestigationsForTest());

test('record + get round-trip', () => {
  recordInvestigation(rec('alpha'));
  const got = getInvestigation('alpha');
  assert.ok(got);
  assert.equal(got.investigationId, 'alpha');
  assert.equal(got.startingPoint, 'svc-alpha');
});

test('LRU evicts oldest entry past the cap', () => {
  process.env.LOG10X_INVESTIGATION_TTL_MS = '999999999'; // disable TTL effects for this test
  for (let i = 0; i < 60; i++) {
    recordInvestigation(rec('id' + i));
  }
  // Cap is 50 — first 10 should be evicted
  assert.equal(getInvestigation('id0'), undefined);
  assert.equal(getInvestigation('id9'), undefined);
  const survivor = getInvestigation('id10');
  assert.ok(survivor);
});

test('TTL expires entries past the configured age', () => {
  process.env.LOG10X_INVESTIGATION_TTL_MS = '50'; // 50 ms
  recordInvestigation(rec('fresh'));
  // Force the cache to think it's been over 50 ms by writing an old record
  recordInvestigation(rec('stale', 200));
  // recordInvestigation calls evictExpired internally — stale should be gone
  assert.equal(getInvestigation('stale'), undefined);
  // fresh should still be there
  assert.ok(getInvestigation('fresh'));
});

test('listInvestigations returns most recent first', () => {
  process.env.LOG10X_INVESTIGATION_TTL_MS = '999999999';
  recordInvestigation(rec('first'));
  recordInvestigation(rec('second'));
  recordInvestigation(rec('third'));
  const list = listInvestigations(10);
  assert.equal(list.length, 3);
  assert.equal(list[0].investigationId, 'third');
});
