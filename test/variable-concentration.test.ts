import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConcentration } from '../src/lib/variable-concentration.js';
import type { EncodedEvent, Template } from '../src/lib/cli-output-parser.js';

test('computeConcentration reports dominant value percentage per slot', () => {
  const templates = new Map<string, Template>([
    [
      'h1',
      {
        templateHash: 'h1',
        template: 'tenant=$ order=$',
        variableSlots: [
          { position: 0, precedingToken: 'tenant=' },
          { position: 1, precedingToken: 'order=' },
        ],
      },
    ],
  ]);
  const events: EncodedEvent[] = [
    { templateHash: 'h1', values: ['acme', '12345'] },
    { templateHash: 'h1', values: ['acme', '12346'] },
    { templateHash: 'h1', values: ['acme', '12347'] },
    { templateHash: 'h1', values: ['foo', '12348'] },
  ];
  const result = computeConcentration(events, templates);
  assert.equal(result.length, 1);
  const pattern = result[0];
  assert.equal(pattern.count, 4);
  // First slot (highest concentration) should be tenant with acme at 75%.
  const tenant = pattern.slots.find((s) => s.inferredName === 'tenant');
  assert.ok(tenant);
  assert.equal(tenant!.topValues[0].value, 'acme');
  assert.equal(tenant!.topValues[0].count, 3);
  assert.equal(tenant!.topValues[0].pct, 0.75);
  assert.equal(tenant!.namingConfidence, 'high');
});

test('semantic naming: high confidence for structured-log keys', () => {
  const templates = new Map<string, Template>([
    [
      'h1',
      {
        templateHash: 'h1',
        template: 'pod_id=$',
        variableSlots: [{ position: 0, precedingToken: 'pod_id=' }],
      },
    ],
  ]);
  const events: EncodedEvent[] = [{ templateHash: 'h1', values: ['pod-1'] }, { templateHash: 'h1', values: ['pod-2'] }];
  const result = computeConcentration(events, templates);
  assert.equal(result[0].slots[0].inferredName, 'pod_id');
  assert.equal(result[0].slots[0].namingConfidence, 'high');
});

test('semantic naming: low confidence for positional-only slots', () => {
  const templates = new Map<string, Template>([
    [
      'h1',
      {
        templateHash: 'h1',
        template: 'error $',
        variableSlots: [{ position: 0, precedingToken: '[' }],
      },
    ],
  ]);
  const events: EncodedEvent[] = [{ templateHash: 'h1', values: ['a'] }, { templateHash: 'h1', values: ['b'] }];
  const result = computeConcentration(events, templates);
  assert.equal(result[0].slots[0].namingConfidence, 'low');
  assert.match(result[0].slots[0].inferredName, /^slot_\d+$/);
});

test('computeConcentration skips patterns below minCount', () => {
  const templates = new Map<string, Template>([
    ['h1', { templateHash: 'h1', template: 'x=$' }],
  ]);
  const events: EncodedEvent[] = [{ templateHash: 'h1', values: ['single'] }];
  const result = computeConcentration(events, templates, { minCount: 2 });
  assert.equal(result.length, 0);
});

test('maxConcentration captures the strongest dimension', () => {
  const templates = new Map<string, Template>([
    [
      'h1',
      {
        templateHash: 'h1',
        template: 'a=$ b=$',
        variableSlots: [
          { position: 0, precedingToken: 'a=' },
          { position: 1, precedingToken: 'b=' },
        ],
      },
    ],
  ]);
  const events: EncodedEvent[] = [
    { templateHash: 'h1', values: ['x', '1'] },
    { templateHash: 'h1', values: ['x', '2'] },
    { templateHash: 'h1', values: ['x', '3'] },
    { templateHash: 'h1', values: ['x', '4'] },
  ];
  const result = computeConcentration(events, templates);
  // slot a has 100% concentration on "x"; slot b has 25% max.
  assert.equal(result[0].maxConcentration, 1);
});
