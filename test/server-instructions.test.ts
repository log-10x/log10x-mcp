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
  // v4 (structured-header review): labeled VERDICT BLOCK with one fact per
  // line; conversation-paced default depth (top 3, expand on request);
  // noun-first numbered cards with the verdict LAST; structured gap with the
  // remedies as a numbered choice; never a table.
  assert.match(SERVER_INSTRUCTIONS, /VERDICT BLOCK/);
  assert.match(SERVER_INSTRUCTIONS, /ONE fact per line/);
  assert.match(SERVER_INSTRUCTIONS, /met, keeping everything/);
  assert.match(SERVER_INSTRUCTIONS, /DEFAULT DEPTH/);
  assert.match(SERVER_INSTRUCTIONS, /TOP 3 cards/);
  assert.match(SERVER_INSTRUCTIONS, /renders as a conversation, not a document/);
  assert.match(SERVER_INSTRUCTIONS, /NUMBERED stacked list/);
  assert.match(SERVER_INSTRUCTIONS, /NEVER a markdown table/);
  assert.match(SERVER_INSTRUCTIONS, /opens with the NOUN, and the verdict comes last/);
  assert.match(SERVER_INSTRUCTIONS, /never truncated/);
  assert.match(SERVER_INSTRUCTIONS, /hedged guess is worse than silence/);
  // the gap is a labeled block, not a paragraph, and the loss decision is
  // never made by the agent.
  assert.match(SERVER_INSTRUCTIONS, /out of reach while keeping everything/);
  assert.match(SERVER_INSTRUCTIONS, /The choice, left with the user/);
  assert.match(SERVER_INSTRUCTIONS, /Never pick for the user/);
  assert.match(SERVER_INSTRUCTIONS, /never soften the\s+word "lossy"/);
  // v4.1 (persona-review fixes): mechanism disclosure, visible ceiling,
  // closing arithmetic, and the pricing basis on every render.
  assert.match(SERVER_INSTRUCTIONS, /Applies as:/);
  assert.match(SERVER_INSTRUCTIONS, /never the <destination>\s+config again/);
  assert.match(SERVER_INSTRUCTIONS, /keep-everything ceiling <keepEverythingCeilingPct>%/);
  assert.match(SERVER_INSTRUCTIONS, /arithmetic on the page MUST close/);
  assert.match(SERVER_INSTRUCTIONS, /Rates: <rateBasis>/);
  assert.match(SERVER_INSTRUCTIONS, /List-price dollars, not a quote/);
  // provenance upgrade: customer-supplied rates get the reconciliation Check
  // line — the one multiplication the reader verifies against their invoice.
  assert.match(SERVER_INSTRUCTIONS, /plan\.rateSource/);
  assert.match(SERVER_INSTRUCTIONS, /\*\*Check:\*\*/);
  assert.match(SERVER_INSTRUCTIONS, /Compare with the invoice/);
  assert.match(SERVER_INSTRUCTIONS, /UPGRADING PROVENANCE/);
  assert.match(SERVER_INSTRUCTIONS, /effective_ingest_per_gb/);
  // blast radius, two tiers: scan-depth honesty (absence of a literal hit is
  // never "safe"), literal hits excluded by default with the trade priced,
  // slice mentions as disclosure with the platform truth relayed verbatim.
  assert.match(SERVER_INSTRUCTIONS, /\*\*Touches:\*\*/);
  assert.match(SERVER_INSTRUCTIONS, /plan_dependencies/);
  assert.match(SERVER_INSTRUCTIONS, /no literal\s+references found in what was scanned/);
  assert.match(SERVER_INSTRUCTIONS, /NEVER "none referenced" or "safe"/);
  assert.match(SERVER_INSTRUCTIONS, /Excluded by default:/);
  assert.match(SERVER_INSTRUCTIONS, /include_referenced/);
  assert.match(SERVER_INSTRUCTIONS, /DISCLOSURE, not exclusion/);
  assert.match(SERVER_INSTRUCTIONS, /platform_truth verbatim/);
});

test('instructions carry the review riders: window, ceiling gloss, audit-first, free fix, unpin flag', async () => {
  const { SERVER_INSTRUCTIONS } = await import('../src/lib/server-instructions.js');
  // every dollar states its measurement period
  assert.match(SERVER_INSTRUCTIONS, /Measured over <scope\.window/);
  // the ceiling is glossed on first use, never left as jargon
  assert.match(SERVER_INSTRUCTIONS, /the most this destination\s+can cut without losing an event/);
  // audit is the front door; plans are for stated targets
  assert.match(SERVER_INSTRUCTIONS, /AUDIT BEFORE PLAN/);
  assert.match(SERVER_INSTRUCTIONS, /Never invent a target to force a plan/);
  // DEBUG noise names the free fix instead of monetizing it silently
  assert.match(SERVER_INSTRUCTIONS, /logger-level change upstream is the free fix/);
  // an unpinned protected type never moves invisibly
  assert.match(SERVER_INSTRUCTIONS, /unprotect_patterns/);
  assert.match(SERVER_INSTRUCTIONS, /unpinned by you/);
  // rollback is stated where the mechanism is stated
  assert.match(SERVER_INSTRUCTIONS, /Reverting that commit IS the rollback/);
  // the skeleton is the unit made visible — rendered whenever a row carries it
  assert.match(SERVER_INSTRUCTIONS, /skeleton — the template body, \$ slots and all/);
  assert.match(SERVER_INSTRUCTIONS, /skeleton IS the message type made visible/);
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
