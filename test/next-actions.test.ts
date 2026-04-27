/**
 * Coverage for the structured next-actions framework: tools render
 * a single-line HTML comment block at the END of their output;
 * programmatic callers extract it without regex-parsing markdown.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderNextActions,
  extractNextActions,
  type NextAction,
} from '../src/lib/next-actions.js';

test('renderNextActions returns empty string for empty list', () => {
  assert.equal(renderNextActions([]), '');
});

test('renderNextActions wraps a single action in the HTML-comment block', () => {
  const out = renderNextActions([
    { tool: 'log10x_investigate', args: { starting_point: 'svc-a' }, reason: 'top driver' },
  ]);
  assert.match(out, /^<!-- NEXT_ACTIONS:/);
  assert.match(out, /-->$/);
  assert.match(out, /log10x_investigate/);
});

test('extractNextActions round-trips a list', () => {
  const actions: NextAction[] = [
    { tool: 'log10x_cost_drivers', args: { service: 'cart' }, reason: 'WoW deltas' },
    { tool: 'log10x_top_patterns', args: { service: 'cart' }, reason: 'current top' },
  ];
  const block = renderNextActions(actions);
  const recovered = extractNextActions(block);
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0].tool, 'log10x_cost_drivers');
  assert.deepEqual(recovered[0].args, { service: 'cart' });
});

test('extractNextActions returns [] when no block is present', () => {
  assert.deepEqual(extractNextActions('## Some heading\n\nbody text'), []);
});

test('extractNextActions returns [] on malformed JSON', () => {
  const malformed = '<!-- NEXT_ACTIONS:not-json-{{{ -->';
  assert.deepEqual(extractNextActions(malformed), []);
});

test('extractNextActions filters non-conforming entries', () => {
  const tampered = '<!-- NEXT_ACTIONS:[{"tool":"ok","args":{}},"not-an-object",{"missing_args":true}] -->';
  const out = extractNextActions(tampered);
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, 'ok');
});

test('extractNextActions picks the LAST block when output has trailing content', () => {
  // Tools may include earlier text that mentions the marker; lastIndexOf
  // grabs the canonical end-of-output block.
  const earlier = '<!-- NEXT_ACTIONS:[{"tool":"old","args":{}}] -->';
  const final = '<!-- NEXT_ACTIONS:[{"tool":"new","args":{}}] -->';
  const out = extractNextActions(`${earlier}\n\nintermediate\n\n${final}`);
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, 'new');
});
