import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSkew } from '../src/lib/detectors/skew.js';
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

test('findSkew: no findings when no slot is skewed', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 100,
      bytes: 10000,
      variables: { verb: ['get', 'post', 'put', 'delete', 'patch'] },
    }),
  ];
  // 5 distinct values with inverse-rank weighting: top value gets
  // about 1 / (1 + 1/2 + 1/3 + 1/4 + 1/5) ≈ 44% — below the 0.6
  // threshold.
  const out = findSkew(patterns);
  assert.equal(out.length, 0);
});

test('findSkew: surfaces high-skew slot above threshold', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 1000,
      bytes: 100000,
      variables: { verb: ['get'] }, // 100% dominance
    }),
  ];
  const out = findSkew(patterns);
  assert.equal(out.length, 1);
  const finding = out[0]!;
  assert.equal(finding.skewedSlots.length, 1);
  assert.equal(finding.skewedSlots[0]!.slotName, 'verb');
  assert.equal(finding.skewedSlots[0]!.dominantValue, 'get');
  assert.equal(finding.skewedSlots[0]!.dominantPct, 1.0);
  // Sampling at 1/10 the dominant value drops (1 - 0.1) × 1.0 = 90% of events.
  assert.ok(finding.samplingOpportunityPct > 0.85);
});

test('findSkew: ranks by bytes × dominance', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm-small',
      count: 100,
      bytes: 1000, // small
      variables: { verb: ['get'] },
    }),
    mk({
      hash: 'h2',
      symbolMessage: 'sm-big',
      count: 1000,
      bytes: 100000, // big
      variables: { verb: ['get'] },
    }),
  ];
  const out = findSkew(patterns);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.patternIdentity, 'sm-big');
  assert.equal(out[1]!.patternIdentity, 'sm-small');
});

test('findSkew: respects minConcentration override', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 100,
      bytes: 10000,
      variables: { verb: ['get', 'post'] }, // ~67% dominance via inverse-rank
    }),
  ];
  // Default threshold 0.6 → should fire.
  assert.equal(findSkew(patterns).length, 1);
  // Threshold 0.8 → should not fire.
  assert.equal(findSkew(patterns, { minConcentration: 0.8 }).length, 0);
});

test('findSkew: respects topN cap', () => {
  const patterns: ExtractedPattern[] = Array.from({ length: 30 }, (_, i) =>
    mk({
      hash: `h${i}`,
      symbolMessage: `sm${i}`,
      count: 100 + i,
      bytes: 10000,
      variables: { verb: ['get'] },
    })
  );
  const out = findSkew(patterns, { topN: 5 });
  assert.equal(out.length, 5);
});
