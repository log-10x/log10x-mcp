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
  // v3 (approved in the phone-readability review): verdict/how/never-touched
  // opening block; noun-first numbered cards with the verdict LAST; identifier
  // only when it adds information; never a table.
  assert.match(SERVER_INSTRUCTIONS, /THREE-LINE BLOCK/);
  assert.match(SERVER_INSTRUCTIONS, /Target: cut <targetPct>%/);
  assert.match(SERVER_INSTRUCTIONS, /NUMBERED stacked list/);
  assert.match(SERVER_INSTRUCTIONS, /NEVER a markdown table/);
  assert.match(SERVER_INSTRUCTIONS, /opens with the NOUN, and the verdict comes last/);
  assert.match(SERVER_INSTRUCTIONS, /never truncated/);
  assert.match(SERVER_INSTRUCTIONS, /hedged guess is worse than silence/);
  assert.match(SERVER_INSTRUCTIONS, /belongs to the\s+user, never to you/);
});

test('instructions carry the budget-target grammar (denomination discipline)', async () => {
  const { SERVER_INSTRUCTIONS } = await import('../src/lib/server-instructions.js');
  assert.match(SERVER_INSTRUCTIONS, /BUDGET TARGETS/);
  assert.match(SERVER_INSTRUCTIONS, /budget_usd_monthly/);
  assert.match(SERVER_INSTRUCTIONS, /budget_gb_monthly/);
  // the verdict stays in the user's denomination — a dollar budget met by
  // tier_down moves nothing out; a volume budget says nothing about the bill.
  assert.match(SERVER_INSTRUCTIONS, /stay in the\s+user's denomination/);
  assert.match(SERVER_INSTRUCTIONS, /tier_down cannot serve\s+a volume budget/);
  // idempotence: under budget renders the headroom line and no cards.
  assert.match(SERVER_INSTRUCTIONS, /headroom/);
});
