/**
 * config-generation closed-loop acceptance tests.
 *
 * The MCP derives a generation hash from the cap policy and writes it as a
 * sibling key; the engine stamps it as `tenx_config_version`. The verifier
 * recomputes the expected hash from the CURRENT policy and compares it to the
 * label the engine advertises — proving the running engine executes the exact
 * policy the MCP wrote, not just that a write happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeGeneration,
  renderGenerationCsv,
  verifyConfigGeneration,
  type ConfigLiveDeps,
} from '../src/lib/config-generation.js';

const CAPS_A = '# target_percent=80\ncontainer,cap\ncart,0:offload\n';
const CAPS_B = '# target_percent=80\ncontainer,cap\ncart,0:offload\nrecommendation,0:offload\n';

function deps(caps: string | null, running: string[]): ConfigLiveDeps {
  return {
    async readCapsCsv() {
      return caps;
    },
    async readRunningGenerations() {
      return running;
    },
  };
}

test('computeGeneration: deterministic + changes with the policy', () => {
  assert.equal(computeGeneration(CAPS_A), computeGeneration(CAPS_A));
  assert.notEqual(computeGeneration(CAPS_A), computeGeneration(CAPS_B));
  assert.match(computeGeneration(CAPS_A), /^[0-9a-f]{12}$/);
});

test('renderGenerationCsv: header + generation row the engine lookup reads', () => {
  assert.equal(renderGenerationCsv('abc123'), 'key,value\ngeneration,abc123\n');
});

test('live: engine advertises the current policy generation', async () => {
  const gen = computeGeneration(CAPS_A);
  const r = await verifyConfigGeneration(deps(CAPS_A, [gen]));
  assert.equal(r.verdict, 'live');
  assert.equal(r.expected_generation, gen);
  assert.deepEqual(r.running_generations, [gen]);
});

test('live during a rollover: expected present while an old generation drains', async () => {
  const gen = computeGeneration(CAPS_B);
  const old = computeGeneration(CAPS_A);
  const r = await verifyConfigGeneration(deps(CAPS_B, [old, gen]));
  assert.equal(r.verdict, 'live');
  assert.match(r.message, /rollover/i);
});

test('stale: engine advertises an old generation, not the current policy', async () => {
  const old = computeGeneration(CAPS_A);
  const r = await verifyConfigGeneration(deps(CAPS_B, [old]));
  assert.equal(r.verdict, 'stale');
  assert.equal(r.expected_generation, computeGeneration(CAPS_B));
  assert.deepEqual(r.running_generations, [old]);
  assert.match(r.message, /not.*picked up|not live/i);
});

test('unverified: no generation label (stamp config not deployed / no metrics)', async () => {
  const r = await verifyConfigGeneration(deps(CAPS_A, []));
  assert.equal(r.verdict, 'unverified');
  assert.equal(r.expected_generation, computeGeneration(CAPS_A));
});

test('unverified: only the bootstrap/unset placeholders are observed', async () => {
  const r = await verifyConfigGeneration(deps(CAPS_A, ['unset', 'bootstrap']));
  assert.equal(r.verdict, 'unverified');
  assert.deepEqual(r.running_generations, ['unset', 'bootstrap']);
});

test('not_configured: no cap policy to verify', async () => {
  assert.equal((await verifyConfigGeneration(deps(null, []))).verdict, 'not_configured');
  assert.equal((await verifyConfigGeneration(deps('   ', []))).verdict, 'not_configured');
});

test('reads degrade gracefully: throwing deps do not throw the verifier', async () => {
  const throwing: ConfigLiveDeps = {
    async readCapsCsv() {
      throw new Error('kubectl denied');
    },
    async readRunningGenerations() {
      throw new Error('prom down');
    },
  };
  const r = await verifyConfigGeneration(throwing);
  assert.equal(r.verdict, 'not_configured'); // caps unreadable => nothing to verify
});
