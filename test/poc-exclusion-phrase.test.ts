/**
 * Coverage for fix #1: literal-phrase exclusion configs.
 *
 * Asserts:
 *   1. extractLiteralPhrase pulls the longest literal run from a templated body.
 *   2. Templates that begin with a variable slot are flagged `leading: false`.
 *   3. Each vendor's exclusion renderer emits the literal phrase, not the
 *      old `tokens.join('.*')` regex spaghetti.
 *   4. Approximation footnote surfaces when at least one drop has
 *      `literalLeading: false`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  _internals,
  type _EnrichedPattern,
} from '../src/lib/poc-report-renderer.js';

const { extractLiteralPhrase, renderNativeExclusion, renderFluentBit } = _internals;

function fakePattern(overrides: Partial<_EnrichedPattern>): _EnrichedPattern {
  return {
    hash: 'h0',
    template: '',
    count: 1000,
    bytes: 1_000_000,
    sampleEvent: '',
    variables: {},
    costPerWindow: 10,
    pctOfTotal: 0.05,
    costPerWeek: 70,
    recommendedAction: 'mute',
    sampleRate: 1,
    projectedSavings: 70,
    reasoning: 'noise',
    confidence: 'high',
    identity: 'fake_identity',
    literalPhrase: '',
    literalLeading: true,
    ...overrides,
  };
}

test('extractLiteralPhrase picks the longest literal run from a leading-literal template', () => {
  const out = extractLiteralPhrase(
    '$(ts) ERROR Payment Gateway Timeout for tenant=$ txId=$ ms=$',
    'payment_gateway_timeout'
  );
  assert.equal(out.phrase, 'ERROR Payment Gateway Timeout for tenant=');
  assert.equal(out.leading, false); // the timestamp $(ts) sits before it
});

test('extractLiteralPhrase flags leading=true when the template starts with a literal', () => {
  const out = extractLiteralPhrase(
    'Payment Gateway Timeout for tenant=$ txId=$',
    'payment_gateway_timeout'
  );
  assert.equal(out.phrase, 'Payment Gateway Timeout for tenant=');
  assert.equal(out.leading, true);
});

test('extractLiteralPhrase flags leading=false when the template begins with a variable', () => {
  const out = extractLiteralPhrase(
    '$ Connection Refused for service=$',
    'connection_refused_service'
  );
  assert.equal(out.phrase, 'Connection Refused for service=');
  assert.equal(out.leading, false);
});

test('extractLiteralPhrase falls back to the spaced identity when no run qualifies', () => {
  const out = extractLiteralPhrase('$=$ $=$ $=$', 'no_anchor_pattern');
  assert.equal(out.phrase, 'no anchor pattern');
  assert.equal(out.leading, false);
});

test('datadog exclusion emits an indexed phrase query, not a regex', () => {
  const out = renderNativeExclusion('datadog', [
    fakePattern({
      identity: 'payment_gateway_timeout',
      literalPhrase: 'Payment Gateway Timeout for tenant=',
      literalLeading: true,
    }),
  ]);
  // The query field is JSON-encoded, so the inner quotes show as \" in the
  // serialized string. Assert on the @message: prefix + the literal phrase
  // separately rather than reproducing JSON escaping in the test regex.
  assert.match(out, /@message:/);
  assert.match(out, /Payment Gateway Timeout for tenant=/);
  assert.doesNotMatch(out, /\.\*/);
  assert.doesNotMatch(out, /@message:\//); // no slash-bounded regex form
});

test('splunk exclusion emits a literal substring REGEX, no .* interleaving', () => {
  const out = renderNativeExclusion('splunk', [
    fakePattern({
      identity: 'payment_gateway_timeout',
      literalPhrase: 'Payment Gateway Timeout for tenant=',
      literalLeading: true,
    }),
  ]);
  assert.match(out, /REGEX = Payment Gateway Timeout for tenant=/);
  assert.doesNotMatch(out, /\.\*/);
});

test('elasticsearch exclusion uses a single ctx.message.contains call per pattern', () => {
  const out = renderNativeExclusion('elasticsearch', [
    fakePattern({
      identity: 'heartbeat_loop',
      literalPhrase: 'heartbeat ok ts=',
      literalLeading: true,
    }),
  ]);
  assert.match(out, /ctx\.message\.contains\('heartbeat ok ts='\)/);
  // No && chain across token-by-token contains() calls.
  const containsCount = (out.match(/contains\(/g) || []).length;
  assert.equal(containsCount, 1);
});

test('cloudwatch exclusion uses a single phrase exclude per pattern', () => {
  const out = renderNativeExclusion('cloudwatch', [
    fakePattern({
      identity: 'heartbeat_loop',
      literalPhrase: 'heartbeat ok',
      literalLeading: true,
    }),
  ]);
  assert.match(out, /-"heartbeat ok"/);
});

test('approximation footnote surfaces when a pattern lacks a leading literal', () => {
  const out = renderNativeExclusion('datadog', [
    fakePattern({
      identity: 'connection_refused',
      literalPhrase: 'Connection Refused for service=',
      literalLeading: false,
    }),
  ]);
  assert.match(out, /NOTE: one or more patterns/);
  assert.match(out, /connection_refused → "Connection Refused for service="/);
});

test('approximation footnote stays absent when every pattern leads with a literal', () => {
  const out = renderNativeExclusion('datadog', [
    fakePattern({
      identity: 'payment_gateway_timeout',
      literalPhrase: 'Payment Gateway Timeout',
      literalLeading: true,
    }),
  ]);
  assert.doesNotMatch(out, /NOTE: one or more patterns/);
});

test('fluent-bit emits an escaped literal exclude, not a token AND-chain', () => {
  const out = renderFluentBit([
    fakePattern({
      identity: 'heartbeat_loop',
      literalPhrase: 'heartbeat ok ts=',
      literalLeading: true,
    }),
  ]);
  assert.match(out, /Exclude\s+log heartbeat ok ts=/);
  assert.doesNotMatch(out, /\.\*/);
});
