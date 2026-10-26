/**
 * Gate for handoff 4b.4: the spike audit given X. How far over a monthly
 * Standard budget the account went, month by month, and each service's share
 * of the overage from its share of the lines past the budget. Fixture series,
 * no network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildSpikeAudit, renderSpikeAuditMarkdown } from '../src/lib/datadog-spike-audit.js';
import { EVENTS_QUERY, executeDatadogSpikeAudit } from '../src/tools/datadog-spike-audit.js';

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
  assert.match(md, /By the account's usage metrics, Standard indexing on main went over the budget in 1 of 2 months, by about 623,059 events, about \$1\.1 at the rate above\./);
  assert.match(md, /\| b \| 467,294 \| 75% \| \$0\.79 \|/);
});

test('4b.4: under X every month, and no budget section without X', () => {
  const under = buildSpikeAudit(input, { budgetUsdMonthly: 100, standardIndexes: ['main'] } as never) as { budget?: { monthsOver: number } };
  assert.equal(under.budget?.monthsOver, 0);
  assert.equal((buildSpikeAudit(input) as { budget?: unknown }).budget, undefined);
});

type B = {
  months: Array<{ month: string; overEvents: number; budgetUsd: number; partial: boolean }>;
  overEvents: number;
};

test('review 10 gate: the budget section is an estimate and states what a ceiling does not hold', () => {
  const md = renderSpikeAuditMarkdown(buildSpikeAudit(input, { budgetUsdMonthly: 4, standardIndexes: ['main'] } as never));
  assert.doesNotMatch(md, /was paid/);
  assert.match(md, /This is an estimate: Datadog's estimated usage differs from billable usage\./);
  assert.match(md, /does not hold error lines up to K per statement per node per window, the first lines of each statement in every window \(past a service's total at most 50 sample lines and 500 error lines a window on each node\), or lines that do not pass the Receiver\./);
});

test('review 11 gate: a partial month is held to X prorated by its hours in the window', () => {
  // The window starts on July 16 (half of July's 744 hours fall inside it).
  const JUL16 = Date.UTC(2026, 6, 16, 12) / 1000;
  const half = { ...input, fromSec: JUL16 };
  const a = buildSpikeAudit(half, { budgetUsdMonthly: 4, standardIndexes: ['main'] } as never) as { budget?: B };
  const jul = a.budget!.months[0];
  assert.equal(jul.partial, true);
  assert.ok(Math.abs(jul.budgetUsd - 2) < 1e-9, `July budget prorated to $2, got ${jul.budgetUsd}`);
  // 372 hours x 4,000 = 1,488,000 events against 1,176,471: 311,529 over.
  assert.ok(Math.abs(jul.overEvents - (1_488_000 - 2 / 1.7e-6)) < 1e-6);
  assert.match(renderSpikeAuditMarkdown(a as never), /\| 2026-07 \(part\) \| 1,488,000 \| \$2\.5 \| \$2, prorated \|/);
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('review 12 gate: without standard_indexes the total is every index including Flex, in the headline', async () => {
  globalThis.fetch = (async (req: string | URL | Request) => {
    const url = new URL(typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url);
    const q = url.searchParams.get('query') ?? '';
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const src = q === EVENTS_QUERY ? input.events : [];
    const series = src.map((s) => ({
      tag_set: Object.entries(s.tags).map(([k, v]) => `${k}:${v}`),
      pointlist: s.points.filter(([ts]) => ts >= from && ts < to).map(([ts, v]) => [ts * 1000, v]),
    }));
    return new Response(JSON.stringify({ status: 'ok', series }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const out = await executeDatadogSpikeAudit(
    { lookback: '62d', budget_usd_monthly: 4 },
    { creds: { site: 'datadoghq.com', apiKey: 'k', appKey: 'a' }, nowMs: () => SEP1 * 1000 },
  );
  const headline = (out as unknown as { summary: { headline: string } }).summary.headline;
  assert.equal(typeof headline, 'string');
  assert.match(headline, /indexed events on every index, Flex included \(pass standard_indexes for Standard alone\)/);
  const md = String((out.data.payload as { markdown: string }).markdown);
  assert.match(md, /By the account's usage metrics, indexed events on every index, Flex included/);
});
