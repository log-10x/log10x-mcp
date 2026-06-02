/**
 * Piece D — renderer enforcement test for the dollar-discipline contract.
 *
 * Three assertions per renderer, run across every dollar-emitting surface
 * via a uniform fixture shape:
 *
 *   1. unset fixture  → renderer emits NO '$' (no rate available, no number).
 *   2. list_price     → every '$N' is followed within 200 chars by the
 *                       'list price' / 'may differ' disclosure tail.
 *   3. customer_supplied → '$' appears but the renderer does NOT inject a
 *                          fake "list price" disclaimer.
 *
 * Plus two foundation tests for buildDisclosedDollarValue and fmtDisclosedDollar.
 *
 * The fixtures + rendering helper deliberately go through fmtDisclosedDollar
 * so the renderer-level contract is enforced structurally. As each real
 * production renderer is migrated to call fmtDisclosedDollar, swap its
 * fixture-driven mock for the production export — the assertions stay
 * identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDisclosedDollarValue,
  type DisclosedDollarValue,
} from '../src/lib/cost.js';
import { fmtDisclosedDollar } from '../src/lib/format.js';
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

interface RendererSpec {
  name: string;
  fn: (env: DollarEnvelopeFixture) => string;
  fixture: (mode: Mode) => DollarEnvelopeFixture;
}

const RENDERERS: RendererSpec[] = [
  { name: 'commitment-report', fn: renderCommitment, fixture: commitmentFixture },
  { name: 'top-patterns-render', fn: renderTopPatterns, fixture: topPatternsFixture },
  { name: 'poc-report-renderer', fn: renderPocReport, fixture: pocFixture },
  { name: 'savings', fn: renderSavings, fixture: savingsFixture },
  { name: 'trend', fn: renderTrend, fixture: trendFixture },
  { name: 'baseline', fn: renderBaseline, fixture: baselineFixture },
  { name: 'event-lookup', fn: renderEventLookup, fixture: eventLookupFixture },
];

for (const r of RENDERERS) {
  test(`${r.name} unset fixture emits NO dollar amount`, () => {
    const env = r.fixture('unset');
    const out = r.fn(env);
    // We tolerate the literal "$/GB" token in the "no rate configured"
    // disclosure (it is a unit label, not a quoted spend). The check refuses
    // any '$N' style amount.
    const dollarAmount = /\$[\d.,]+[KMB]?/;
    const m = out.match(dollarAmount);
    assert.equal(
      m,
      null,
      `${r.name} emitted a dollar amount on an unset fixture: ${m && m[0]}\nFull output:\n${out}`
    );
  });

  test(`${r.name} list_price fixture: every '$' has its disclosure within 200 chars`, () => {
    const env = r.fixture('list_price');
    const out = r.fn(env);
    assert.ok(out.includes('$'), `${r.name} missing '$' on list_price fixture`);
    const reg = /\$[\d.,KMB]+/g;
    let m: RegExpExecArray | null;
    while ((m = reg.exec(out)) !== null) {
      const window = out.slice(m.index, m.index + 200);
      assert.match(
        window,
        /(list price|may differ)/,
        `${r.name}: '$' at offset ${m.index} has no disclosure in 200-char window:\n${window}`
      );
    }
  });

  test(`${r.name} customer_supplied fixture: '$' present, no injected list_price caveat`, () => {
    const env = r.fixture('customer_supplied');
    const out = r.fn(env);
    assert.ok(out.includes('$'), `${r.name} missing '$' on customer_supplied fixture`);
    assert.equal(
      out.includes('list price'),
      false,
      `${r.name} injected a "list price" disclaimer on a customer_supplied fixture:\n${out}`
    );
    assert.equal(
      out.includes('may differ'),
      false,
      `${r.name} injected a "may differ" disclaimer on a customer_supplied fixture:\n${out}`
    );
  });
}

// ---------------------------------------------------------------------------
// Foundation contract — type-level safety net.
// ---------------------------------------------------------------------------

test('buildDisclosedDollarValue disclosure-by-source contract', () => {
  const c = buildDisclosedDollarValue(1800, 'customer_supplied', 'Splunk', 5.0);
  assert.equal(c.source, 'customer_supplied');
  assert.equal(c.disclosure, null);
  assert.equal(c.value, 1800);

  const l = buildDisclosedDollarValue(1800, 'list_price', 'Splunk', 5.0);
  assert.equal(l.source, 'list_price');
  assert.ok(l.disclosure, 'list_price must carry a disclosure');
  assert.match(l.disclosure!, /Splunk list price \$5\.00\/GB/);
  assert.match(l.disclosure!, /your actual bill may differ/);

  const u = buildDisclosedDollarValue(0, 'unset', null, null);
  assert.equal(u.source, 'unset');
  assert.equal(u.disclosure, '(no $/GB rate configured)');
});

test('buildDisclosedDollarValue falls back to "SIEM" + "list price" when label/rate are null', () => {
  const l = buildDisclosedDollarValue(1000, 'list_price', null, null);
  assert.match(l.disclosure!, /at SIEM list price/);
  assert.match(l.disclosure!, /may differ/);
});

test('fmtDisclosedDollar refuses to print a number without disclosure metadata', () => {
  assert.equal(fmtDisclosedDollar(null), '—');
  assert.equal(fmtDisclosedDollar(undefined), '—');

  const unset = buildDisclosedDollarValue(0, 'unset', null, null);
  const u = fmtDisclosedDollar(unset);
  assert.match(u, /^—/);
  assert.match(u, /no \$\/GB rate configured/);

  const list = buildDisclosedDollarValue(1800, 'list_price', 'Splunk', 5);
  const lOut = fmtDisclosedDollar(list);
  assert.ok(lOut.includes('$1.8K'), `expected $1.8K in ${lOut}`);
  assert.ok(lOut.includes('list price'), `expected "list price" in ${lOut}`);

  const cust = buildDisclosedDollarValue(1800, 'customer_supplied', 'Splunk', 5);
  const cOut = fmtDisclosedDollar(cust);
  assert.ok(cOut.includes('$1.8K'));
  assert.equal(cOut.includes('list price'), false);
  assert.equal(cOut.includes('may differ'), false);
});

// ---------------------------------------------------------------------------
// Envelope discipline: SavingsProjection mirrors carry the disclosed value.
// ---------------------------------------------------------------------------

test('projectAction populates total_dollars_disclosed alongside total_dollars', async () => {
  const { projectAction } = await import('../src/lib/cost.js');
  const p = projectAction({
    action: 'compact',
    bytes_in: 1024 * 1024 * 1024,
    destination: 'splunk',
  });
  assert.ok(p.total_dollars_disclosed, 'expected total_dollars_disclosed mirror');
  assert.equal(p.total_dollars_disclosed!.value, p.total_dollars);
  assert.equal(p.total_dollars_disclosed!.source, 'list_price');
  assert.ok(p.total_dollars_disclosed!.disclosure);
  assert.match(p.total_dollars_disclosed!.disclosure!, /Splunk list price/);
});

test('projectSavings headline.dollars_disclosed mirrors numeric dollars cells', async () => {
  const { projectSavings } = await import('../src/lib/cost.js');
  const h = projectSavings({
    destination: 'splunk',
    bytes_in: 1e9,
    action: 'compact',
  });
  assert.equal(h.rate_source, 'list_price');
  assert.ok(h.dollars, 'numeric dollars present');
  assert.ok(h.dollars_disclosed, 'disclosed dollars present');
  if (h.dollars!.list_expected != null) {
    assert.ok(h.dollars_disclosed!.list_expected);
    assert.equal(h.dollars_disclosed!.list_expected!.value, h.dollars!.list_expected);
    assert.equal(h.dollars_disclosed!.list_expected!.source, 'list_price');
    assert.match(h.dollars_disclosed!.list_expected!.disclosure!, /list price/);
  }
});

test('customer_supplied headline never carries a list-price caveat on the customer cell', async () => {
  const { projectSavings } = await import('../src/lib/cost.js');
  const h = projectSavings({
    destination: 'splunk',
    bytes_in: 1e9,
    action: 'compact',
    effective_ingest_per_gb: 0.4,
  });
  assert.equal(h.rate_source, 'customer_supplied');
  const cust = h.dollars_disclosed?.customer_expected;
  assert.ok(cust);
  assert.equal(cust!.disclosure, null);
});
