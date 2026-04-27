/**
 * Coverage for fix #8: local-source POC sampler.
 *
 * Asserts:
 *   1. pickRandom is reservoir-style (no duplicates, returns at most n).
 *   2. pickRandom returns the input verbatim when n >= length.
 *   3. sampleFromKubectl with a non-existent kubectl path surfaces a
 *      clear "kubectl not found" note rather than throwing.
 *   4. sampleFromKubectl with a kubectl that exits non-zero
 *      (simulated via a path that always errors) returns an empty
 *      result and a structured note.
 *
 * Network-touching paths (real `kubectl get pods`) are NOT exercised
 * here because CI does not have a cluster. Connector-style test that
 * stubs the spawn layer lives in a follow-up if/when needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickRandom, sampleFromKubectl } from '../src/lib/local-source.js';

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('pickRandom returns the whole input when n >= length', () => {
  const items = ['a', 'b', 'c'];
  const out = pickRandom(items, 10, seededRng(1));
  assert.equal(out.length, 3);
  assert.deepEqual(out.sort(), ['a', 'b', 'c']);
});

test('pickRandom samples n distinct items without duplicates', () => {
  const items = Array.from({ length: 50 }, (_, i) => `pod-${i}`);
  const out = pickRandom(items, 10, seededRng(42));
  assert.equal(out.length, 10);
  const unique = new Set(out);
  assert.equal(unique.size, 10);
  for (const x of out) assert.ok(items.includes(x));
});

test('pickRandom with different seeds produces different draws', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const a = pickRandom(items, 10, seededRng(1));
  const b = pickRandom(items, 10, seededRng(2));
  // With 100 items and 10-pick, two distinct seeds should disagree.
  assert.notDeepEqual(a, b);
});

test('sampleFromKubectl surfaces missing-kubectl as a structured note, not a throw', async () => {
  const out = await sampleFromKubectl({
    kubectlPath: '/var/empty/no-kubectl-here',
    namespace: 'default',
    perPodTimeoutMs: 500,
  });
  assert.equal(out.events.length, 0);
  assert.equal(out.totalBytes, 0);
  assert.equal(out.composition.length, 0);
  // The error message from spawn for ENOENT or permission failure
  // takes one of two paths in the error handler — both surface as
  // a note rather than an unhandled throw.
  assert.ok(out.notes.length > 0, 'expected at least one note');
});

test('sampleFromKubectl with a stub that exits non-zero returns empty result + note', async () => {
  // /usr/bin/false on macOS/linux exits 1 immediately.
  const out = await sampleFromKubectl({
    kubectlPath: '/usr/bin/false',
    namespace: 'default',
    perPodTimeoutMs: 500,
  });
  assert.equal(out.events.length, 0);
  assert.ok(out.notes.length > 0);
  // The note should mention failure context rather than crashing.
  assert.ok(/failed|exit|kubectl/i.test(out.notes.join(' ')));
});
