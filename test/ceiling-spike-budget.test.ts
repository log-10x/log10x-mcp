/**
 * Gate for handoff 4b.4: the spike audit given X. How far over a monthly
 * Standard budget the account went, month by month, and each service's share
 * of the overage from its share of the lines past the budget. Fixture series,
 * no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSpikeAudit, renderSpikeAuditMarkdown } from '../src/lib/datadog-spike-audit.js';

const H = 3600;
const JUL1 = Date.UTC(2026, 6, 1) / 1000;
const AUG1 = Date.UTC(2026, 7, 1) / 1000;
const SEP1 = Date.UTC(2026, 8, 1) / 1000;

function hourly(tags: Record<string, string>, from: number, to: number, v: number) {
  const points: Array<[number, number]> = [];
  for (let t = from; t < to; t += H) points.push([t, v]);
  return { tags, points };
}

// July: a 1,000 and b 3,000 an hour in `main` (2,976,000 events); August: 1,000 each.
// A Flex-only index adds 50,000 an hour, which does not bill as Standard.
const input = {
  fromSec: JUL1,
  toSec: SEP1,
  events: [
    hourly({ service: 'a', datadog_index: 'main' }, JUL1, SEP1, 1_000),
    hourly({ service: 'b', datadog_index: 'main' }, JUL1, AUG1, 3_000),
    hourly({ service: 'b', datadog_index: 'main' }, AUG1, SEP1, 1_000),
    hourly({ service: 'b', datadog_index: 'flex-only' }, JUL1, SEP1, 50_000),
  ],
  bytes: [],
};

test('4b.4 gate: given X, the overage per month and each service share of it', () => {
  const audit = buildSpikeAudit(input, { budgetUsdMonthly: 4, standardIndexes: ['main'] } as never) as ReturnType<typeof buildSpikeAudit> & {
    budget?: {
      months: Array<{ month: string; events: number; overEvents: number; overUsd: number; crossedIso?: string; partial: boolean }>;
      services: Array<{ service: string; overEvents: number; share: number; overUsd: number }>;
      overUsd: number;
      monthsOver: number;
    };
  };
  const b = audit.budget;
  assert.ok(b, 'the audit carries the budget section');
  // X = $4 at $1.70 a million = 2,352,941 events. July: 2,976,000, so 623,059 past it.
  const x = 4 / 1.7e-6;
  assert.equal(b.months.length, 2);
  assert.equal(b.months[0].month, '2026-07');
  assert.equal(b.months[0].events, 2_976_000);
  assert.ok(Math.abs(b.months[0].overEvents - (2_976_000 - x)) < 1e-6);
  // Crossed in hour 588 of July: 2,352,941 / 4,000 = 588.2.
  assert.equal(b.months[0].crossedIso, '2026-07-25T12:00:00.000Z');
  assert.equal(b.months[0].partial, false);
  assert.equal(b.months[1].overEvents, 0);
  assert.equal(b.monthsOver, 1);
  // Past the budget, b sent three lines for each of a's.
  assert.deepEqual(b.services.map((s) => s.service), ['b', 'a']);
  assert.ok(Math.abs(b.services[0].share - 0.75) < 1e-9);
  assert.ok(Math.abs(b.services[1].share - 0.25) < 1e-9);
  assert.ok(Math.abs(b.services[0].overUsd + b.services[1].overUsd - b.overUsd) < 1e-9);
  assert.ok(Math.abs(b.overUsd - (2_976_000 - x) * 1.7e-6) < 1e-9);

  const md = renderSpikeAuditMarkdown(audit);
  assert.match(md, /### Against a budget of \$4 a month/);
  assert.match(md, /Standard indexing \(the indexes main\) went over \$4 in 1 of 2 months, by 623,059 events, \$1\.1 in all\./);
  assert.match(md, /\| b \| 467,294 \| 75% \| \$0\.79 \|/);
});

test('4b.4: under X every month, and no budget section without X', () => {
  const under = buildSpikeAudit(input, { budgetUsdMonthly: 100, standardIndexes: ['main'] } as never) as { budget?: { monthsOver: number } };
  assert.equal(under.budget?.monthsOver, 0);
  assert.equal((buildSpikeAudit(input) as { budget?: unknown }).budget, undefined);
});
