/**
 * Piece D finalisation — structural enforcement gate.
 *
 * This test is the across-renderer guard the dollar-discipline contract
 * needs to survive. The per-renderer assertions in
 * `dollar-discipline.test.ts` already check each migrated surface in
 * isolation; this file re-runs the same three structural assertions
 * (unset → no $, list_price → disclosure within 200 chars, customer
 * supplied → no injected list-price caveat) across every migrated
 * renderer in one pass. If any surface forgets to route a dollar
 * emission through `fmtDisclosedDollar` after migration, swapping its
 * fixture stub for the production export here surfaces the regression
 * immediately.
 *
 * The seven migrated renderers (per the migration summaries in the
 * Piece D plan) are:
 *
 *   poc-renderer, commitment, baseline, savings, top-patterns, trend,
 *   event-lookup.
 *
 * Each is exercised against its tool-specific fixture builder so the
 * SIEM label + list-rate threaded through the disclosure tail matches
 * the production wiring (Splunk @ $5.00/GB for commitment + poc +
 * event-lookup, Datadog @ $0.95/GB for top-patterns, Elasticsearch @
 * $0.60/GB for savings, CloudWatch @ $0.50/GB for trend, Sumo @
 * $1.50/GB for baseline).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitmentFixture,
  topPatternsFixture,
  pocFixture,
  savingsFixture,
  trendFixture,
  baselineFixture,
  eventLookupFixture,
  renderCommitment,
  renderTopPatterns,
  renderPocReport,
  renderSavings,
  renderTrend,
  renderBaseline,
  renderEventLookup,
  type DollarEnvelopeFixture,
} from './helpers/dollar-fixtures.js';

type Mode = 'unset' | 'list_price' | 'customer_supplied';

interface MigratedRenderer {
  name: string;
  fn: (env: DollarEnvelopeFixture) => string;
  fixture: (mode: Mode) => DollarEnvelopeFixture;
}

const MIGRATED: MigratedRenderer[] = [
  { name: 'poc-renderer',  fn: renderPocReport,    fixture: pocFixture },
  { name: 'commitment',    fn: renderCommitment,   fixture: commitmentFixture },
  { name: 'baseline',      fn: renderBaseline,     fixture: baselineFixture },
  { name: 'savings',       fn: renderSavings,      fixture: savingsFixture },
  { name: 'top-patterns',  fn: renderTopPatterns,  fixture: topPatternsFixture },
  { name: 'trend',         fn: renderTrend,        fixture: trendFixture },
  { name: 'event-lookup',  fn: renderEventLookup,  fixture: eventLookupFixture },
];

// Reject anything that looks like a quoted dollar amount: `$1.8K`,
// `$1,800`, `$0.95`. The literal token `$/GB` in the unset disclosure
// is a unit label, not a quoted spend, and is excluded by the digit
// requirement after `$`.
const DOLLAR_AMOUNT = /\$[\d.,]+[KMB]?/;
const DOLLAR_AMOUNT_GLOBAL = /\$[\d.,KMB]+/g;
const DISCLOSURE_TAIL = /(list price|may differ)/;

for (const r of MIGRATED) {
  test(`integration: ${r.name} unset envelope emits zero '$' amounts`, () => {
    const out = r.fn(r.fixture('unset'));
    const m = out.match(DOLLAR_AMOUNT);
    assert.equal(
      m,
      null,
      `${r.name} emitted a dollar amount on an unset rate envelope: ${m && m[0]}\n--- output ---\n${out}\n--------------`,
    );
  });

  test(`integration: ${r.name} list_price envelope discloses every '$' within 200 chars`, () => {
    const out = r.fn(r.fixture('list_price'));
    assert.ok(
      out.includes('$'),
      `${r.name} produced no '$' on a list_price envelope — fixture or renderer wired wrong`,
    );
    let m: RegExpExecArray | null;
    const reg = new RegExp(DOLLAR_AMOUNT_GLOBAL.source, 'g');
    while ((m = reg.exec(out)) !== null) {
      const window = out.slice(m.index, m.index + 200);
      assert.match(
        window,
        DISCLOSURE_TAIL,
        `${r.name}: '$' at offset ${m.index} (${m[0]}) had no list-price / may-differ disclosure in its 200-char window:\n${window}`,
      );
    }
  });

  test(`integration: ${r.name} customer_supplied envelope keeps '$' but injects no list-price caveat`, () => {
    const out = r.fn(r.fixture('customer_supplied'));
    assert.ok(
      out.includes('$'),
      `${r.name} produced no '$' on a customer_supplied envelope`,
    );
    assert.equal(
      out.includes('list price'),
      false,
      `${r.name} injected a "list price" caveat on a customer_supplied envelope:\n${out}`,
    );
    assert.equal(
      out.includes('may differ'),
      false,
      `${r.name} injected a "may differ" caveat on a customer_supplied envelope:\n${out}`,
    );
  });
}
