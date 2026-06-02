/**
 * Fixture builders for dollar-discipline.test.ts.
 *
 * Each builder returns a minimal envelope object carrying DisclosedDollarValue
 * fields keyed by the three states the spec calls out:
 *   - 'unset'              → no $/GB rate available; value=0 + 'unset' tag.
 *   - 'list_price'         → vendor list rate; disclosure tail required.
 *   - 'customer_supplied'  → customer-owned rate; no caveat.
 *
 * The renderer used by the test is a tiny closure that walks the envelope and
 * emits one line per dollar cell via fmtDisclosedDollar — the assertion is
 * structural (was the disclosure honoured?) and renderer-implementation-
 * neutral. Once each tool's real renderer is migrated to call
 * fmtDisclosedDollar, the same fixture shape can be threaded in without
 * changing the assertions.
 */

import {
  buildDisclosedDollarValue,
  type DisclosedDollarValue,
  type DollarSource,
} from '../../src/lib/cost.js';
import { fmtDisclosedDollar } from '../../src/lib/format.js';

type Mode = 'unset' | 'list_price' | 'customer_supplied';

function build(value: number, mode: Mode, siem: string | null, rate: number | null): DisclosedDollarValue {
  const src: DollarSource = mode;
  return buildDisclosedDollarValue(value, src, siem, rate);
}

/** Generic envelope shape used by every fixture. */
export interface DollarEnvelopeFixture {
  headline: DisclosedDollarValue | null;
  per_row: Array<{ name: string; cost: DisclosedDollarValue | null }>;
  total: DisclosedDollarValue | null;
}

function envelope(mode: Mode, siem: string, rate: number): DollarEnvelopeFixture {
  if (mode === 'unset') {
    return {
      headline: build(0, 'unset', null, null),
      per_row: [
        { name: 'row-a', cost: build(0, 'unset', null, null) },
        { name: 'row-b', cost: build(0, 'unset', null, null) },
      ],
      total: build(0, 'unset', null, null),
    };
  }
  return {
    headline: build(1800, mode, siem, rate),
    per_row: [
      { name: 'row-a', cost: build(900, mode, siem, rate) },
      { name: 'row-b', cost: build(900, mode, siem, rate) },
    ],
    total: build(1800, mode, siem, rate),
  };
}

export const commitmentFixture = (mode: Mode) => envelope(mode, 'Splunk', 5.0);
export const topPatternsFixture = (mode: Mode) => envelope(mode, 'Datadog', 0.95);
export const pocFixture = (mode: Mode) => envelope(mode, 'Splunk', 5.0);
export const savingsFixture = (mode: Mode) => envelope(mode, 'Elasticsearch', 0.6);
export const trendFixture = (mode: Mode) => envelope(mode, 'CloudWatch', 0.5);
export const baselineFixture = (mode: Mode) => envelope(mode, 'Sumo', 1.5);
export const eventLookupFixture = (mode: Mode) => envelope(mode, 'Splunk', 5.0);

/**
 * Mock renderer: turns an envelope into markdown text by piping every dollar
 * cell through fmtDisclosedDollar. This is what every real renderer SHOULD do
 * after migration — the assertions in dollar-discipline.test.ts confirm the
 * contract (no $ on unset; every $ on list_price has its disclosure within a
 * 200-char window; customer_supplied never gets an injected "list price"
 * disclaimer).
 */
export function renderEnvelope(env: DollarEnvelopeFixture): string {
  const lines: string[] = [];
  lines.push(`headline: ${fmtDisclosedDollar(env.headline)}`);
  for (const row of env.per_row) {
    lines.push(`  ${row.name}: ${fmtDisclosedDollar(row.cost)}`);
  }
  lines.push(`total: ${fmtDisclosedDollar(env.total)}`);
  return lines.join('\n');
}

export const renderCommitment = renderEnvelope;
export const renderTopPatterns = renderEnvelope;
export const renderPocReport = renderEnvelope;
export const renderSavings = renderEnvelope;
export const renderTrend = renderEnvelope;
export const renderBaseline = renderEnvelope;
export const renderEventLookup = renderEnvelope;
