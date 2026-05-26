import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSlotsBySymbolMessage } from '../src/lib/detectors/slot-aggregation.js';
import type { ExtractedPattern } from '../src/lib/pattern-extraction.js';

function makePattern(over: Partial<ExtractedPattern>): ExtractedPattern {
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

test('aggregateSlotsBySymbolMessage: single pattern aggregates as single-member', () => {
  const patterns: ExtractedPattern[] = [
    makePattern({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 100,
      variables: { customerId: ['acme', 'foo', 'bar'] },
    }),
  ];
  const out = aggregateSlotsBySymbolMessage(patterns);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.symbolMessage, 'sm1');
  assert.equal(out[0]!.templateHashes.length, 1);
  assert.equal(out[0]!.totalEvents, 100);
  // Single semantic slot stays as one slot, aggregation_status = 'per_template_hash_only' (no merge across templates needed).
  assert.ok(out[0]!.slots.length >= 1);
  const slot = out[0]!.slots.find((s) => s.slotName === 'customerId')!;
  assert.equal(slot.aggregationStatus, 'per_template_hash_only');
  assert.equal(slot.templateHashesContributing.length, 1);
});

test('aggregateSlotsBySymbolMessage: two templates sharing symbolMessage merge by semantic slot name', () => {
  const patterns: ExtractedPattern[] = [
    makePattern({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 50,
      variables: { customerId: ['acme', 'foo'], status: ['ok'] },
    }),
    makePattern({
      hash: 'h2',
      symbolMessage: 'sm1',
      count: 50,
      variables: { customerId: ['bar', 'baz'], status: ['ok', 'fail'] },
    }),
  ];
  const out = aggregateSlotsBySymbolMessage(patterns);
  assert.equal(out.length, 1);
  const grp = out[0]!;
  assert.equal(grp.templateHashes.length, 2);
  assert.equal(grp.totalEvents, 100);
  // customerId merges across both templates.
  const cid = grp.slots.find((s) => s.slotName === 'customerId')!;
  assert.equal(cid.aggregationStatus, 'merged');
  assert.equal(cid.templateHashesContributing.length, 2);
  // status also merges; distinct count is 2 across both (ok + fail).
  const stat = grp.slots.find((s) => s.slotName === 'status')!;
  assert.equal(stat.aggregationStatus, 'merged');
  assert.equal(stat.distinctCount, 2);
});

test('aggregateSlotsBySymbolMessage: positional slot names (slot_N) do NOT merge across templates', () => {
  const patterns: ExtractedPattern[] = [
    makePattern({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 50,
      variables: { slot_0: ['v1', 'v2'] },
    }),
    makePattern({
      hash: 'h2',
      symbolMessage: 'sm1',
      count: 50,
      variables: { slot_0: ['v3', 'v4'] },
    }),
  ];
  const out = aggregateSlotsBySymbolMessage(patterns);
  assert.equal(out.length, 1);
  const slots = out[0]!.slots.filter((s) => s.slotName === 'slot_0');
  // Two separate per-templateHash entries because position is unreliable.
  assert.equal(slots.length, 2);
  for (const s of slots) {
    assert.equal(s.aggregationStatus, 'per_template_hash_only');
    assert.match(s.aggregationReason ?? '', /position not reliable/);
  }
});

test('aggregateSlotsBySymbolMessage: patterns without symbolMessage do NOT merge', () => {
  const patterns: ExtractedPattern[] = [
    makePattern({ hash: 'h1', count: 50, variables: { customerId: ['acme'] } }),
    makePattern({ hash: 'h2', count: 50, variables: { customerId: ['foo'] } }),
  ];
  const out = aggregateSlotsBySymbolMessage(patterns);
  // Each hash becomes its own group (no merge).
  assert.equal(out.length, 2);
  for (const g of out) {
    assert.equal(g.templateHashes.length, 1);
  }
});

test('aggregateSlotsBySymbolMessage: minEvents threshold drops low-volume groups', () => {
  const patterns: ExtractedPattern[] = [
    makePattern({
      hash: 'h1',
      symbolMessage: 'sm-tiny',
      count: 3,
      variables: { customerId: ['acme'] },
    }),
    makePattern({
      hash: 'h2',
      symbolMessage: 'sm-real',
      count: 50,
      variables: { customerId: ['foo', 'bar'] },
    }),
  ];
  const out = aggregateSlotsBySymbolMessage(patterns, { minEvents: 10 });
  // sm-tiny dropped; sm-real kept.
  assert.equal(out.length, 1);
  assert.equal(out[0]!.symbolMessage, 'sm-real');
});

test('aggregateSlotsBySymbolMessage: dominant-value percentage preserved across merge', () => {
  // Both templates have customerId where one value dominates.
  const patterns: ExtractedPattern[] = [
    makePattern({
      hash: 'h1',
      symbolMessage: 'sm-skew',
      count: 100,
      variables: { customerId: ['acme', 'foo', 'bar'] },
    }),
    makePattern({
      hash: 'h2',
      symbolMessage: 'sm-skew',
      count: 100,
      variables: { customerId: ['acme', 'baz'] },
    }),
  ];
  const out = aggregateSlotsBySymbolMessage(patterns);
  const cid = out[0]!.slots.find((s) => s.slotName === 'customerId')!;
  // acme is dominant in both templates → dominant in merged result.
  assert.equal(cid.dominantValue, 'acme');
  assert.ok(cid.dominantPct > 0.4); // approximation but should still be the top
  assert.equal(cid.aggregationStatus, 'merged');
});

test('aggregateSlotsBySymbolMessage: totalEncodedBytes sums across members', () => {
  const patterns: ExtractedPattern[] = [
    makePattern({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 50,
      bytes: 5000,
      encodedBytes: 800,
      variables: { customerId: ['a'] },
    }),
    makePattern({
      hash: 'h2',
      symbolMessage: 'sm1',
      count: 50,
      bytes: 4500,
      encodedBytes: 700,
      variables: { customerId: ['b'] },
    }),
  ];
  const out = aggregateSlotsBySymbolMessage(patterns);
  assert.equal(out[0]!.totalEncodedBytes, 1500);
  assert.equal(out[0]!.totalBytes, 9500);
});
