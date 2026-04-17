/**
 * Tests for the structured next-actions hint format.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderNextActions, extractNextActions } from '../src/lib/next-actions.js';

test('renderNextActions: empty list produces empty string', () => {
  assert.equal(renderNextActions([]), '');
});

test('renderNextActions: produces single-line HTML-comment JSON block', () => {
  const out = renderNextActions([
    { tool: 'log10x_investigate', args: { starting_point: 'payments', window: '1h' }, reason: 'drill into top service' },
  ]);
  assert.match(out, /^<!-- NEXT_ACTIONS:.+-->$/);
  assert.ok(!out.includes('\n'));
});

test('extractNextActions: roundtrips through render', () => {
  const input = [
    { tool: 'log10x_pattern_trend', args: { pattern: 'abc', timeRange: '1h' }, reason: 'check rate' },
    { tool: 'log10x_cost_drivers', args: { timeRange: '7d' }, reason: 'compare week-over-week' },
  ];
  const block = renderNextActions(input);
  const response = `## Some Tool Output\n\nStuff here.\n\n${block}`;
  const extracted = extractNextActions(response);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].tool, 'log10x_pattern_trend');
  assert.deepEqual(extracted[0].args, { pattern: 'abc', timeRange: '1h' });
  assert.equal(extracted[1].tool, 'log10x_cost_drivers');
});

test('extractNextActions: returns [] when no block present', () => {
  assert.deepEqual(extractNextActions('## Output\n\nNo structured hints here.'), []);
});

test('extractNextActions: returns [] on malformed JSON', () => {
  assert.deepEqual(extractNextActions('<!-- NEXT_ACTIONS:{broken json -->'), []);
});

test('extractNextActions: ignores non-tool entries', () => {
  const response = '<!-- NEXT_ACTIONS:[{"tool":"x","args":{}},{"not":"a tool"}] -->';
  const extracted = extractNextActions(response);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].tool, 'x');
});

test('extractNextActions: picks the LAST block if multiple exist', () => {
  // Guard against tools that might embed the pattern inside their body text.
  const response = '<!-- NEXT_ACTIONS:[{"tool":"earlier","args":{}}] -->\nbody\n<!-- NEXT_ACTIONS:[{"tool":"canonical","args":{}}] -->';
  const extracted = extractNextActions(response);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].tool, 'canonical');
});
