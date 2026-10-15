/**
 * Datadog: Flex is the default tier_down route, and a Flex move is stated as
 * lines, never as a share of the bill.
 *
 * Ruling (Tal, 2026-09-30): Flex is the default tier-down route on Datadog,
 * because the data is still searchable in Datadog. The planner plans tier_down
 * to Flex before offload. The plan reports the events and GB moved out of the
 * Standard index, the Standard indexing line avoided at Datadog list, and the
 * Flex line added at the tier the moved volume lands in: Flex Starter, storage
 * and compute at one rate for at least 3 months, compute bundled for volumes
 * below 2 billion events a month and 10 billion stored; above either, Flex
 * storage on a scalable compute tier, with compute unpriced and excluded. It prints no percentage of the
 * Datadog bill and no 0.6/0.4 blend (claims charter: never a Datadog Flex
 * percentage, bare or qualified).
 *
 * Before this, the model priced Flex at $1.00/GB, which was $2.50 x 0.40: a
 * modeled 0.6 fraction of the bill that every Datadog plan printed as "cut N%
 * of the datadog bill".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  DATADOG_FLEX_LIST_PRICING,
  DEFAULT_ACTION_BY_DESTINATION,
  projectAction,
  projectPerEventTierMove,
  perEventPricingTier,
  tierDownRateDelta,
  getDestinationCostModel,
} from '../src/lib/cost.js';
import { solvePlan, type SolverPattern } from '../src/lib/plan-solver.js';
import { isPlanFeasible, _resolveServiceAction } from '../src/tools/configure-engine.js';
import { executeEstimateSavings } from '../src/tools/estimate-savings.js';
import { makeStubBackend, makeFakeEnv } from './helpers/fake-env.js';

const GB = 1_000_000_000;

/** No share of the bill: no "N%" anywhere near the word "bill". */
const BILL_PERCENT = /\d\s*%[^.]*\bbill\b|\bbill\b[^.]*\d\s*%/i;

test('Datadog plans tier_down to Flex before offload', () => {
  assert.deepEqual(DEFAULT_ACTION_BY_DESTINATION.datadog, ['tier_down', 'offload']);
  const decision = _resolveServiceAction({
    container: 'api',
    destination: 'datadog',
    model: getDestinationCostModel('datadog'),
    globalStandardAction: 'compact',
    autoRecommend: true,
    compactWorthItRatio: 0.6,
    warnings: [],
  } as never);
  assert.equal(decision.action, 'tier_down');
});

// The fixed example: 1,000 GB a month of 1,000-byte events, one billion events.
test('a 1,000 GB/mo Flex move is priced per event at Datadog list, as lines', () => {
  const move = projectPerEventTierMove(DATADOG_FLEX_LIST_PRICING, 1000 * GB, { avgEventBytes: 1000 });
  assert.equal(move.events_moved, 1e9);
  assert.equal(move.events_basis, 'measured');
  assert.equal(move.standard_indexing_avoided_usd, 1700); // $1.70 per million, 15-day retention
  // One billion events a month, held 3 months, is 3 billion stored, below both
  // Starter limits (2 billion a month, 10 billion stored), so the line is $0.60
  // per million stored per month for 3 months.
  assert.equal(move.pricing_tier, 'starter');
  assert.equal(move.tier_storage_added_usd, 1800);
  assert.equal(move.tier_retention_months, 3);
  assert.match(move.text, /1 billion events \(1000 GB\) a month out of the Standard index into Datadog Flex Logs/);
  assert.match(move.text, /Standard indexing avoided: \$1,700\/mo at \$1\.70 per million events \(15-day retention\)/);
  assert.match(
    move.text,
    /Flex Starter added: \$1,800\/mo at \$0\.60 per million events stored per month, compute bundled for volumes below 2 billion events a month and 10 billion stored, held 3 months \(Datadog Log Management pricing page, read 2026-10-15\)/,
  );
  assert.ok(!/unpriced/.test(move.text), move.text);
  assert.match(move.text, /read 2026-10-13/);
  assert.ok(!/%/.test(move.text), move.text);
});

test('above Starter, a Flex move is priced at scalable storage with compute unpriced', () => {
  // Four billion events a month is above Starter's 2 billion a month (and, held
  // 3 months, its 10 billion stored): storage at $0.05 per million stored per
  // month, held 30 days, and the compute line named, not counted.
  const move = projectPerEventTierMove(DATADOG_FLEX_LIST_PRICING, 4000 * GB, { avgEventBytes: 1000 });
  assert.equal(move.pricing_tier, 'scalable');
  assert.equal(move.tier_storage_added_usd, 200);
  assert.equal(move.tier_retention_months, 1);
  assert.match(move.text, /Flex storage added: \$200\/mo at \$0\.05 per million events stored per month, held 30 days, on a scalable compute tier/);
  assert.match(move.text, /Flex compute is unpriced .* excluded from both figures/);
  assert.match(move.text, /Flex Starter compute bundled for volumes below 2 billion events a month and 10 billion stored/);
});

test('above 2 billion events a month, a Flex move lands on scalable even when its stored volume is under 10 billion', () => {
  // 2.5 billion events a month, held 3 months, is 7.5 billion stored, under the
  // stored limit, and above the monthly one: scalable.
  const over = projectPerEventTierMove(DATADOG_FLEX_LIST_PRICING, 2500 * GB, { avgEventBytes: 1000 });
  assert.equal(over.events_moved, 2.5e9);
  assert.equal(over.pricing_tier, 'scalable');
  assert.equal(over.tier_retention_months, 1);
  assert.equal(over.tier_storage_added_usd, 125); // 2,500M events x $0.05/M, held 30 days
  assert.match(over.text, /on a scalable compute tier/);
  // Just under both limits: 1.9 billion a month, 5.7 billion stored over 3 months: Starter.
  const under = projectPerEventTierMove(DATADOG_FLEX_LIST_PRICING, 1900 * GB, { avgEventBytes: 1000 });
  assert.equal(under.pricing_tier, 'starter');
  // Under the monthly limit but over the stored one when held 6 months: 1.9 x 6 = 11.4 billion stored.
  assert.equal(perEventPricingTier(DATADOG_FLEX_LIST_PRICING, 1.9e9, 6).pricing_tier, 'scalable');
  // Exactly at the monthly limit is not below it.
  assert.equal(perEventPricingTier(DATADOG_FLEX_LIST_PRICING, 2e9).pricing_tier, 'scalable');
  assert.equal(DATADOG_FLEX_LIST_PRICING.starter.below_events_monthly, 2e9);
  assert.equal(DATADOG_FLEX_LIST_PRICING.starter.recommended_below_events_stored, 10e9);
});

test('an unmeasured event size is ASSUMED, and the move says so', () => {
  const move = projectPerEventTierMove(DATADOG_FLEX_LIST_PRICING, 1000 * GB);
  assert.equal(move.events_basis, 'assumed');
  assert.match(move.text, /ASSUMED at 1,000 bytes per event/);
});

test('projectAction prices Datadog tier_down by the per-event lines, not the retired 0.6 fraction', () => {
  const args = { bytes_in: 1000 * GB, avg_event_size_bytes: 1000, destination: 'datadog' as const };
  const pass = projectAction({ ...args, action: 'pass' });
  const flex = projectAction({ ...args, action: 'tier_down' });
  // Indexing avoided ($1,700) less Flex Starter added ($1,800): at Starter the
  // move costs more than the 15-day indexing it avoids. The old $1.00/GB model
  // gave $1,500.
  assert.equal((pass.total_dollars ?? 0) - (flex.total_dollars ?? 0), -100);
  assert.ok(flex.per_event_move, 'the move rides on the projection');
  assert.ok(flex.notes?.some((n) => n === flex.per_event_move!.text));
  assert.ok(!flex.notes?.some((n) => /\/GB/.test(n)), 'no per-GB Flex rate in any note');
  // No per-GB fraction exists for a per-event tier.
  assert.equal(tierDownRateDelta(getDestinationCostModel('datadog')), 0);
});

test('Datadog feasibility is judged on volume, never on a share of the bill', () => {
  const r = isPlanFeasible({
    targetShedBytes: 1000,
    remainingBytesToShed: 1000,
    currentMonthlyUsd: 1000,
    targetPercent: 30,
    achievedSavedUsd: 900,
    dollarAxis: false,
  });
  assert.equal(r.dollarsFeasible, false);
  assert.equal(r.feasible, false);
});

function estate(): SolverPattern[] {
  return [
    { hash: 'a', name: 'heartbeat', services: { api: 600 * GB }, severity: 'INFO', bytes: 600 * GB, avgEventBytes: 1000 },
    { hash: 'b', name: 'request served', services: { api: 400 * GB }, severity: 'INFO', bytes: 400 * GB, avgEventBytes: 1000 },
    { hash: 'e', name: 'payment failed', services: { api: 100 * GB }, severity: 'ERROR', bytes: 100 * GB, avgEventBytes: 1000 },
  ];
}

test('a Datadog percent plan counts volume out of the Standard index and states no bill figure', () => {
  const pl = solvePlan(estate(), { destination: 'datadog', retrieverInstalled: false, targetPct: 45 });
  assert.equal(pl.percentBasis, 'standard_index_volume');
  assert.equal(pl.keepEverythingLever, 'tier_down');
  assert.ok(pl.met);
  // The engine moves each planned pattern's excess over its container's cap.
  // The cap sits between the largest pattern the container keeps, `payment
  // failed` (ERROR, 100 GB), and the smallest it moves, `request served`
  // (400 GB), at their geometric mean: 200 GB, a margin of 2 on each side.
  // The INFO floor keeps a tenth of the excess. `heartbeat` alone sets the
  // cap at sqrt(400 x 600) = 490 GB and moves 99 GB of 1,100, short of 45%,
  // so `request served` is planned too: (600 - 200) x 0.9 = 360 GB and
  // (400 - 200) x 0.9 = 180 GB, 540 GB of 1,100.
  assert.equal(Math.round(pl.achievedPct), 49);
  assert.deepEqual(pl.containerCaps, {
    api: {
      action: 'tier_down',
      capBytesMonthly: 200 * GB,
      keptMaxPattern: 'payment failed',
      movedMinPattern: 'request served',
      separated: true,
      margin: 2,
      keptMaxBytesMonthly: 100 * GB,
      movedMinBytesMonthly: 400 * GB,
    },
  });
  assert.equal(pl.landsAtUsd, undefined, 'a before/after pair would be a share of the bill');
  assert.ok(pl.perEventMove);
  assert.equal(pl.perEventMove!.standard_indexing_avoided_usd, 918); // 540M events x $1.70/M
  const row = pl.planned[0];
  assert.equal(row.action, 'tier_down');
  assert.equal(row.movedBytesMonthly, 360 * GB);
  assert.equal(row.savedUsd, 612); // 360M events x $1.70/M
  assert.equal(row.addedUsd, 648); // 360M events x $0.60/M at Flex Starter, held 3 months
  assert.match(pl.rateBasis, /per million events/);
  assert.ok(!/Flex Logs ingest \$[\d.]+\/GB/.test(pl.rateBasis), pl.rateBasis);
});

test('estimate_savings on Datadog renders the Flex lines and no percentage of the bill', async () => {
  const stub = makeStubBackend({
    instant: [
      {
        match: 'summaryBytes_total',
        series: [
          { metric: { tenx_hash: 'wy7WAbcu8U8', tenx_user_service: 'api', message_pattern: 'heartbeat $' }, value: 6_000_000_000 },
          { metric: { tenx_hash: 'E-OzMXyO0Uo', tenx_user_service: 'api', message_pattern: 'request served $' }, value: 4_000_000_000 },
        ],
      },
      {
        match: 'summaryVolume_total',
        series: [
          { metric: { tenx_hash: 'wy7WAbcu8U8' }, value: 6_000_000 },
          { metric: { tenx_hash: 'E-OzMXyO0Uo' }, value: 4_000_000 },
        ],
      },
      { match: 'count(', series: [{ metric: {}, value: 2 }] },
    ],
  });
  const out = (await executeEstimateSavings(
    { mode: 'forecast', target_percent: 50, destination: 'datadog' } as never,
    makeFakeEnv(stub),
  )) as unknown as { summary?: { headline?: string }; data?: { headline?: string } };
  const text = JSON.stringify(out);
  const headline = String(out.summary?.headline ?? out.data?.headline ?? '');
  assert.match(headline, /out of the Datadog Standard index/, headline);
  assert.match(headline, /Flex Starter added: .* compute bundled for volumes below 2 billion events a month and 10 billion stored, held 3 months/, headline);
  assert.ok(!BILL_PERCENT.test(headline), headline);
  assert.ok(!/cut \d+% of the datadog bill/i.test(text), 'no "cut N% of the datadog bill" anywhere in the envelope');
});

/** Every .ts file under src, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('no rendered string pairs Flex with a percentage or a per-GB rate', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        // "Flex" the Datadog tier (capitalised; CSS flex is not it) within the
        // same clause as a percentage or a per-GB dollar rate.
        const flexNear = /\bFlex\b[^.;]{0,80}(\d\s*%|\$\d+(\.\d+)?\/GB)|(\d\s*%|\$\d+(\.\d+)?\/GB)[^.;]{0,80}\bFlex\b/;
        if (flexNear.test(code)) {
          offenders.push(`${file}:${i + 1}: ${code.slice(0, 140)}`);
        }
      });
  }
  assert.deepEqual(offenders, []);
});
