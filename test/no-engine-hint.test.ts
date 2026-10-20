import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenxAvailabilityShortHint, tenxAvailabilityHint } from '../src/lib/install-hints.js';
import { clipAtWord } from '../src/tools/poc-from-local.js';

test('the no-engine hint for an agent is whole, short, and asks for no env var', () => {
  const saved = process.env.LOG10X_TENX_MODE;
  delete process.env.LOG10X_TENX_MODE;
  try {
    const h = tenxAvailabilityShortHint();
    assert.ok(h.length < 400, `hint is ${h.length} characters`);
    assert.match(h, /run this tool again\.$/);
    assert.doesNotMatch(h, /LOG10X_TENX_MODE/);
    assert.match(h, /Start Docker/);
  } finally {
    if (saved !== undefined) process.env.LOG10X_TENX_MODE = saved;
  }
});

test('with LOG10X_TENX_MODE=local the hint does not offer Docker', () => {
  const saved = process.env.LOG10X_TENX_MODE;
  process.env.LOG10X_TENX_MODE = 'local';
  try {
    assert.doesNotMatch(tenxAvailabilityShortHint(), /Start Docker/);
  } finally {
    if (saved === undefined) delete process.env.LOG10X_TENX_MODE; else process.env.LOG10X_TENX_MODE = saved;
  }
});

test('the full guide no longer asks to set LOG10X_TENX_MODE for docker', () => {
  assert.doesNotMatch(tenxAvailabilityHint(), /set LOG10X_TENX_MODE=docker/);
});

test('long hints are cut at a word, never mid-word', () => {
  const long = 'Tenx is not available. Two ways to get it: Docker or a local install. Three flavors ship. Only one of them compiles.';
  const c = clipAtWord(long, 80);
  assert.ok(c.endsWith(' (cut)'));
  const body = c.slice(0, -' (cut)'.length);
  assert.ok(long.startsWith(body));
  assert.ok(long[body.length] === ' ' || /[.,;:]/.test(long[body.length]), `cut inside a word: "${body}"`);
  assert.equal(clipAtWord('short', 80), 'short');
});
