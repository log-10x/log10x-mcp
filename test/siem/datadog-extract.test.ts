/**
 * Coverage for fix #5: defensive message extraction in the Datadog
 * connector. The prior `?.message` shortcut returned `undefined` for
 * events whose body lived under `attributes.attributes.*`, which then
 * became the literal string "undefined" after the pull loop joined
 * events with `\n` and the templater fingerprinted a phantom pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _internals } from '../../src/lib/siem/datadog.js';

const { extractMessage } = _internals;

test('extractMessage returns attributes.message on the happy path', () => {
  const out = extractMessage({ attributes: { message: 'hello' } });
  assert.equal(out, 'hello');
});

test('extractMessage falls through to attributes.attributes.message', () => {
  const out = extractMessage({
    attributes: { attributes: { message: 'nested hello' } },
  });
  assert.equal(out, 'nested hello');
});

test('extractMessage tries log / body / raw variants', () => {
  assert.equal(
    extractMessage({ attributes: { attributes: { log: 'log body' } } }),
    'log body'
  );
  assert.equal(
    extractMessage({ attributes: { attributes: { body: 'body body' } } }),
    'body body'
  );
  assert.equal(
    extractMessage({ attributes: { attributes: { raw: 'raw body' } } }),
    'raw body'
  );
});

test('extractMessage stringifies attributes.attributes when no known field hits', () => {
  const out = extractMessage({
    attributes: { attributes: { customKey: 'custom value', n: 42 } },
  });
  assert.match(out!, /customKey/);
  assert.match(out!, /custom value/);
});

test('extractMessage returns null when nothing is resolvable', () => {
  assert.equal(extractMessage({}), null);
  assert.equal(extractMessage({ attributes: {} }), null);
  assert.equal(extractMessage({ attributes: { attributes: {} } }), null);
  assert.equal(extractMessage(null), null);
  assert.equal(extractMessage(undefined), null);
});

test('extractMessage does not return literal "undefined" for empty attributes', () => {
  // The bug being fixed: prior code returned `undefined`, which became
  // the literal string "undefined" after events.join('\n').
  const out = extractMessage({ attributes: { service: 'web' } });
  assert.equal(out, null);
  // Sanity: null is falsy, so the caller's `if (message === null) skip`
  // will fire instead of pushing a phantom event.
  assert.notEqual(out, 'undefined');
});

test('extractMessage prefers attributes.message even when nested.message exists', () => {
  const out = extractMessage({
    attributes: {
      message: 'top',
      attributes: { message: 'nested' },
    },
  });
  assert.equal(out, 'top');
});

test('extractMessage skips empty-string attributes.message and falls through', () => {
  const out = extractMessage({
    attributes: {
      message: '',
      attributes: { message: 'nested wins' },
    },
  });
  assert.equal(out, 'nested wins');
});
