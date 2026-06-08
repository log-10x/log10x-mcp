/**
 * Unit tests for template-expander.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandTemplate, expandedByteLength } from '../src/lib/template-expander.js';

test('expandTemplate: substitutes bare $ slots with positional values', () => {
  const result = expandTemplate('hello $ world $', ['alice', 'bob']);
  assert.equal(result, 'hello alice world bob');
});

test('expandTemplate: substitutes typed format-spec slots', () => {
  // $(yyyy-MM-dd'T'HH:mm:ss'Z') is a timestamp slot
  const result = expandTemplate('at $(yyyy-MM-dd) logged in', ['2026-01-01']);
  assert.equal(result, 'at 2026-01-01 logged in');
});

test('expandTemplate: handles a mix of bare and typed slots', () => {
  const result = expandTemplate('user=$, time=$(HH:mm:ss), level=$', [
    'alice',
    '12:34:56',
    'INFO',
  ]);
  assert.equal(result, 'user=alice, time=12:34:56, level=INFO');
});

test('expandTemplate: returns an empty string for an empty template', () => {
  assert.equal(expandTemplate('', ['a', 'b']), '');
});

test('expandTemplate: returns the template unchanged when values array is empty', () => {
  // Slots with no values → empty string substitution
  const result = expandTemplate('hello $, world $', []);
  assert.equal(result, 'hello , world ');
});

test('expandTemplate: ignores extra values beyond the slot count', () => {
  const result = expandTemplate('one $', ['a', 'b', 'c']);
  assert.equal(result, 'one a');
});

test('expandTemplate: handles a template with no slots', () => {
  const result = expandTemplate('no slots here', ['x', 'y']);
  assert.equal(result, 'no slots here');
});

test('expandTemplate: handles literal $ adjacent to a slot marker', () => {
  // A bare '$' that is not followed by '(' is a slot; other text is literal.
  const result = expandTemplate('cost=$USD', ['42']);
  assert.equal(result, 'cost=42USD');
});

test('expandTemplate: handles slots at the start and end of the template', () => {
  const result = expandTemplate('$ middle $', ['start', 'end']);
  assert.equal(result, 'start middle end');
});

test('expandTemplate: handles values containing special characters', () => {
  const result = expandTemplate('path=$', ['/var/log/app.log']);
  assert.equal(result, 'path=/var/log/app.log');
});

test('expandTemplate: handles multi-byte UTF-8 values', () => {
  const result = expandTemplate('msg=$', ['こんにちは']);
  assert.equal(result, 'msg=こんにちは');
});

test('expandTemplate: substitutes an empty string when there are fewer values than slots', () => {
  const result = expandTemplate('a=$, b=$, c=$', ['x', 'y']);
  assert.equal(result, 'a=x, b=y, c=');
});

test('expandedByteLength: returns the UTF-8 byte length of the expanded string', () => {
  const template = 'level=$ msg=$';
  const values = ['INFO', 'hello world'];
  const expanded = expandTemplate(template, values);
  const expected = Buffer.byteLength(expanded, 'utf8');
  assert.equal(expandedByteLength(template, values), expected);
});

test('expandedByteLength: returns 0 for an empty template with no slots', () => {
  assert.equal(expandedByteLength('', []), 0);
});

test('expandedByteLength: counts multi-byte characters correctly', () => {
  const template = '$';
  const values = ['日本語'];
  // 'こんにちは' is 3 bytes per char in UTF-8; '日本語' = 9 bytes
  const result = expandedByteLength(template, values);
  assert.equal(result, Buffer.byteLength('日本語', 'utf8'));
});
