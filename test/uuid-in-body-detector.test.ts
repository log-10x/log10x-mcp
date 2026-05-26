import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUuidInBody } from '../src/lib/detectors/uuid-in-body.js';
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

test('findUuidInBody: empty result for low-cardinality slots', () => {
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm1',
      count: 100,
      bytes: 10000,
      variables: { verb: ['get', 'post'] },
    }),
  ];
  const out = findUuidInBody(patterns);
  assert.equal(out.length, 0);
});

test('findUuidInBody: detects UUID-shape values with regex match', () => {
  // Distinct count == count (within cap) and values are UUID-shaped.
  const distinctValues = [
    'e0f83483-3150-4951-afd1-886061c949b8',
    'deadbeef-1111-2222-3333-444444444444',
    'cafef00d-aaaa-bbbb-cccc-dddddddddddd',
    '12345678-90ab-cdef-1234-567890abcdef',
    '00000000-0000-0000-0000-000000000000',
    '11111111-2222-3333-4444-555555555555',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'fffffff1-2222-3333-4444-555555555555',
    '99999999-8888-7777-6666-555555555555',
    'abcdef12-3456-7890-abcd-ef1234567890',
    '12345678-1234-1234-1234-123456789012',
    '98765432-9876-9876-9876-987654321098',
  ];
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm-audit',
      count: 12, // matches distinct count → ratio = 1.0
      bytes: 10000,
      variables: { auditID: distinctValues },
    }),
  ];
  const out = findUuidInBody(patterns);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.uuidLikeSlots.length, 1);
  assert.equal(out[0]!.uuidLikeSlots[0]!.regexMatch, 'uuid');
  assert.match(out[0]!.fixHint, /UUID/);
});

test('findUuidInBody: detects ISO timestamp slots', () => {
  const timestamps = [
    '2026-05-25T10:00:00Z',
    '2026-05-25T10:01:00Z',
    '2026-05-25T10:02:00Z',
    '2026-05-25T10:03:00Z',
    '2026-05-25T10:04:00Z',
    '2026-05-25T10:05:00Z',
    '2026-05-25T10:06:00Z',
    '2026-05-25T10:07:00Z',
    '2026-05-25T10:08:00Z',
    '2026-05-25T10:09:00Z',
    '2026-05-25T10:10:00Z',
  ];
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm-logged-time',
      count: 11,
      bytes: 5000,
      variables: { eventTime: timestamps },
    }),
  ];
  const out = findUuidInBody(patterns);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.uuidLikeSlots[0]!.regexMatch, 'timestamp');
  assert.match(out[0]!.fixHint, /timestamp/);
});

test('findUuidInBody: distinctCount < minDistinct does not trigger', () => {
  const fewUuids = [
    'e0f83483-3150-4951-afd1-886061c949b8',
    'deadbeef-1111-2222-3333-444444444444',
    'cafef00d-aaaa-bbbb-cccc-dddddddddddd',
  ];
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm-fewuuid',
      count: 3,
      bytes: 1000,
      variables: { auditID: fewUuids },
    }),
  ];
  // Distinct=3, count=3 → ratio=1.0 but distinctCount < default minDistinctForUuid=10.
  const out = findUuidInBody(patterns);
  assert.equal(out.length, 0);
});

test('findUuidInBody: hex-id pattern detected', () => {
  const hexIds = [
    'abcdef1234567890',
    '1234567890abcdef',
    'fedcba0987654321',
    'aabbccddeeff0011',
    '1122334455667788',
    '99aabbccddeeff00',
    'cafef00dbabec0de',
    'deadbeef12345678',
    '0011223344556677',
    '8899aabbccddeeff',
    'feedfacedeadbeef',
  ];
  const patterns: ExtractedPattern[] = [
    mk({
      hash: 'h1',
      symbolMessage: 'sm-hex',
      count: 11,
      bytes: 5000,
      variables: { traceId: hexIds },
    }),
  ];
  const out = findUuidInBody(patterns);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.uuidLikeSlots[0]!.regexMatch, 'hex_id');
});
