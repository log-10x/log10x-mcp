import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRoundTrip, stripEncodedAnchors } from '../src/lib/dev-cli.js';

test('identical text, with or without a trailing newline on either side', () => {
  const input = 'a 1\nb 2\nc 3';
  const r = compareRoundTrip(input, 'a 1\nb 2\nc 3\n', 3);
  assert.equal(r.status, 'identical');
  assert.equal(r.records, 3);
  assert.equal(r.inputLines, 3);
  assert.equal(r.decodedLines, 3);
  assert.equal(r.differingLines, 0);
  assert.equal(compareRoundTrip(input + '\n', 'a 1\nb 2\nc 3', 3).status, 'identical');
});

test('a grouped record decodes to several lines and still compares line for line', () => {
  const input = '10:00 ERROR failed\n\tat a.b(c:1)\n\tat d.e(f:2)\n10:01 INFO ok';
  const r = compareRoundTrip(input, input + '\n', 2);
  assert.equal(r.status, 'identical');
  assert.equal(r.inputLines, 4);
  assert.equal(r.decodedLines, 4);
});

test('a differing line is counted and the first one is quoted', () => {
  const r = compareRoundTrip('a 1\nb 2\nc 3', 'a 1\nb 9\nc 3\n', 3);
  assert.equal(r.status, 'differs');
  assert.equal(r.differingLines, 1);
  assert.deepEqual(r.firstDifference, { line: 2, input: 'b 2', decoded: 'b 9' });
});

test('missing lines count as differences', () => {
  const r = compareRoundTrip('a 1\nb 2\nc 3', 'a 1\n', 3);
  assert.equal(r.status, 'differs');
  assert.equal(r.differingLines, 2);
  assert.equal(r.decodedLines, 1);
});

test('carriage returns the engine drops are named in the note', () => {
  const r = compareRoundTrip('a 1\r\nb 2\r\n', 'a 1\nb 2\n', 2);
  assert.equal(r.status, 'differs');
  assert.match(r.note ?? '', /carriage returns/);
});

test('stripEncodedAnchors removes the parser anchors and nothing else', () => {
  const anchored = '~h1,10:00,42,pattern=,order $ shipped,patternHash=,abc\n~h2,a\\,b,pattern=,x,patternHash=,def\n~h3,plain';
  assert.equal(stripEncodedAnchors(anchored), '~h1,10:00,42\n~h2,a\\,b\n~h3,plain');
  // An escaped comma before `pattern=` is a value, not the anchor.
  assert.equal(stripEncodedAnchors('~h4,v\\,pattern=,w'), '~h4,v\\,pattern=,w');
});
