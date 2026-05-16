import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenxHash } from '../src/lib/pattern-hash.js';

/**
 * Locked cross-language conformance vectors. Identical to the engine's
 * JUnit fixture (l1x-inc/.../PatternHashEncoderConformanceTest) and
 * test/pattern-hash-vectors.json. The last three were captured from an
 * actual engine pipeline run (dev app, aggregated.csv) — proof the TS
 * reproduces what the real engine emits, not just the spec.
 *
 * A mismatch here means the contract drifted; do NOT "fix" by editing an
 * expected value — every deployed tenx_hash filter would be inconsistent.
 */
const UNICODE = String.fromCodePoint(0x00e9, 0x00e8, 0x20, 0x4e2d, 0x6587, 0x20)
  + 'unicode'; // "éè 中文 unicode", code-point built so source encoding is irrelevant

const VECTORS: Array<[string, string]> = [
  ['', '70bbN1HY6Zk'],
  ['the cat', 'E-OzMXyO0Uo'],
  ['a', '0k7E8amMbls'],
  ['OOMKilled: pod ${x} exceeded memory', 'wy7WAbcu8U8'],
  [UNICODE, '-wCKskD3BR0'],
  ['user=12345 action=login status=200', 'nq6LnqpN3DM'],
  // captured from a real engine run (aggregated.csv message_pattern -> tenx_hash)
  ['auth_user_logged_in_from', 'dfuI-CJlieQ'],
  ['cart_oom_killed_pod_limit', '2YRvdeD6IBg'],
  ['cart_oom_killed_pod_abc_limit', 'L0N_4Xo0tsg'],
];

test('tenxHash reproduces every locked conformance vector', () => {
  for (const [input, expected] of VECTORS) {
    assert.equal(tenxHash(input), expected, `tenx_hash(${JSON.stringify(input)})`);
  }
});

test('tenxHash output is always 11 base64url chars', () => {
  for (const [input] of VECTORS) {
    const h = tenxHash(input);
    assert.equal(h.length, 11, `length for ${JSON.stringify(input)}`);
    assert.match(h, /^[A-Za-z0-9_-]{11}$/, `charset for ${JSON.stringify(input)}`);
  }
});

test('tenxHash is deterministic and discriminates patterns', () => {
  assert.equal(tenxHash('the cat'), tenxHash('the cat'));
  assert.notEqual(
    tenxHash('cart_oom_killed_pod_limit'),
    tenxHash('cart_oom_killed_pod_abc_limit'),
  );
});
