import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findConstantSlots } from '../src/lib/detectors/constant-slots.js';
import type { ExtractedPattern } from '../src/lib/pattern-extraction.js';

function mk(over: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    hash: 'h?',
    template: 't',
    count: 50,
    bytes: 5000,
    sampleEvent: '',
    variables: {},
    ...over,
  };
}

test('findConstantSlots: flags slot with distinctCount=1', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 100,
      bytes: 10000,
      variables: {
        apiVersion: ['audit.k8s.io/v1'], // one distinct value
        userId: ['a', 'b', 'c'], // multi-value
      },
    }),
  ];
  const out = findConstantSlots(patterns);
  assert.equal(out.length, 1);
  const f = out[0]!;
  assert.equal(f.constantSlots.length, 1);
  assert.equal(f.constantSlots[0]!.slotName, 'apiVersion');
  assert.equal(f.constantSlots[0]!.constantValue, 'audit.k8s.io/v1');
  assert.ok(f.estimatedCompactSavingsPct > 0);
});

test('findConstantSlots: drops low-sample patterns below minSampleCount', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm-tiny',
      count: 3, // below default 10
      bytes: 300,
      variables: { apiVersion: ['v1'] },
    }),
    mk({
      hash: 'h2',
      symbolMessage: 'sm-real',
      count: 50,
      bytes: 5000,
      variables: { apiVersion: ['v1'] },
    }),
  ];
  const out = findConstantSlots(patterns);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.patternIdentity, 'sm-real');
});

test('findConstantSlots: surfaces multiple constant slots per pattern', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 100,
      bytes: 10000,
      variables: {
        apiVersion: ['audit.k8s.io/v1'],
        kind: ['Event'],
        stage: ['ResponseComplete'],
        auditID: ['uuid1', 'uuid2', 'uuid3'], // not constant
      },
    }),
  ];
  const out = findConstantSlots(patterns);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.constantSlots.length, 3);
});

test('findConstantSlots: ranks by total-bytes savings', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm-small',
      count: 100,
      bytes: 1000,
      variables: { apiVersion: ['v1'] },
    }),
    mk({
      hash: 'h2',
      symbolMessage: 'sm-big',
      count: 1000,
      bytes: 100000,
      variables: { apiVersion: ['v1'] },
    }),
  ];
  const out = findConstantSlots(patterns);
  assert.equal(out[0]!.patternIdentity, 'sm-big');
});

test('findConstantSlots: empty result when no constant slots present', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 100,
      bytes: 10000,
      variables: {
        userId: ['a', 'b', 'c', 'd', 'e'],
        verb: ['get', 'post'],
      },
    }),
  ];
  const out = findConstantSlots(patterns);
  assert.equal(out.length, 0);
});
