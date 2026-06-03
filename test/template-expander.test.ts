/**
 * Unit tests for template-expander.ts
 */

import { describe, it, expect } from 'vitest';
import { expandTemplate, expandedByteLength } from '../src/lib/template-expander.js';

describe('expandTemplate', () => {
  it('substitutes bare $ slots with positional values', () => {
    const result = expandTemplate('hello $ world $', ['alice', 'bob']);
    expect(result).toBe('hello alice world bob');
  });

  it('substitutes typed format-spec slots', () => {
    // $(yyyy-MM-dd'T'HH:mm:ss'Z') is a timestamp slot
    const result = expandTemplate('at $(yyyy-MM-dd) logged in', ['2026-01-01']);
    expect(result).toBe('at 2026-01-01 logged in');
  });

  it('handles a mix of bare and typed slots', () => {
    const result = expandTemplate('user=$, time=$(HH:mm:ss), level=$', [
      'alice',
      '12:34:56',
      'INFO',
    ]);
    expect(result).toBe('user=alice, time=12:34:56, level=INFO');
  });

  it('returns an empty string for an empty template', () => {
    expect(expandTemplate('', ['a', 'b'])).toBe('');
  });

  it('returns the template unchanged when values array is empty', () => {
    // Slots with no values → empty string substitution
    const result = expandTemplate('hello $, world $', []);
    expect(result).toBe('hello , world ');
  });

  it('ignores extra values beyond the slot count', () => {
    const result = expandTemplate('one $', ['a', 'b', 'c']);
    expect(result).toBe('one a');
  });

  it('handles a template with no slots', () => {
    const result = expandTemplate('no slots here', ['x', 'y']);
    expect(result).toBe('no slots here');
  });

  it('handles literal $ adjacent to a slot marker', () => {
    // A bare '$' that is not followed by '(' is a slot; other text is literal.
    const result = expandTemplate('cost=$USD', ['42']);
    expect(result).toBe('cost=42USD');
  });

  it('handles slots at the start and end of the template', () => {
    const result = expandTemplate('$ middle $', ['start', 'end']);
    expect(result).toBe('start middle end');
  });

  it('handles values containing special characters', () => {
    const result = expandTemplate('path=$', ['/var/log/app.log']);
    expect(result).toBe('path=/var/log/app.log');
  });

  it('handles multi-byte UTF-8 values', () => {
    const result = expandTemplate('msg=$', ['こんにちは']);
    expect(result).toBe('msg=こんにちは');
  });

  it('substitutes an empty string when there are fewer values than slots', () => {
    const result = expandTemplate('a=$, b=$, c=$', ['x', 'y']);
    expect(result).toBe('a=x, b=y, c=');
  });
});

describe('expandedByteLength', () => {
  it('returns the UTF-8 byte length of the expanded string', () => {
    const template = 'level=$ msg=$';
    const values = ['INFO', 'hello world'];
    const expanded = expandTemplate(template, values);
    const expected = Buffer.byteLength(expanded, 'utf8');
    expect(expandedByteLength(template, values)).toBe(expected);
  });

  it('returns 0 for an empty template with no slots', () => {
    expect(expandedByteLength('', [])).toBe(0);
  });

  it('counts multi-byte characters correctly', () => {
    const template = '$';
    const values = ['日本語'];
    // 'こんにちは' is 3 bytes per char in UTF-8; '日本語' = 9 bytes
    const result = expandedByteLength(template, values);
    expect(result).toBe(Buffer.byteLength('日本語', 'utf8'));
  });
});
