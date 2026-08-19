/**
 * The server instructions are the one piece of routing every MCP client is
 * guaranteed to inject into the agent's context — the answer to "how does
 * the agent know what to ask". This pins the two lanes that must never
 * drop out of it: the orientation handshake, and the prospect lane the
 * homepage teaches ("run a cost POC", "define a plan that cuts 30%").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_INSTRUCTIONS } from '../src/lib/server-instructions.js';

test('the instructions still route fresh sessions through log10x_start', () => {
  assert.match(SERVER_INSTRUCTIONS, /log10x_start/);
  assert.match(SERVER_INSTRUCTIONS, /ROUTING RULE/);
});

test('the instructions route the POC ask to the tool that does it', () => {
  assert.match(SERVER_INSTRUCTIONS, /log10x_poc_from_local/);
  assert.match(SERVER_INSTRUCTIONS, /run a cost POC/i);
  assert.match(SERVER_INSTRUCTIONS, /target_percent_reduction/, 'the percentage ask names its argument');
  assert.match(SERVER_INSTRUCTIONS, /log10x_poc_from_siem_submit/, 'the analyzer-credentials variant is named');
});

test('the instructions require demo-data numbers to be labeled', () => {
  assert.match(SERVER_INSTRUCTIONS, /demo dataset[\s\S]*must say so/);
});

test('instructions carry the plan-row rendering grammar (stacked list, never a table)', async () => {
  const { SERVER_INSTRUCTIONS } = await import('../src/lib/server-instructions.js');
  // The grammar is what makes every host render a plan the same way: headline
  // verbatim, stacked rows so the pattern identity never crops, gloss under the
  // interpretation rules, gap relayed verbatim with the choice left to the user.
  assert.match(SERVER_INSTRUCTIONS, /RENDERING A PLAN/);
  assert.match(SERVER_INSTRUCTIONS, /STACKED\s+LIST, never a markdown table/);
  assert.match(SERVER_INSTRUCTIONS, /headline sentence first, verbatim/);
  assert.match(SERVER_INSTRUCTIONS, /never truncate/);
  assert.match(SERVER_INSTRUCTIONS, /hedged guess is worse than silence/);
  assert.match(SERVER_INSTRUCTIONS, /belongs to the user, never to you/);
});
