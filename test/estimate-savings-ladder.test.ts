/**
 * Entry-contract tests for the estimate_savings forecast target arguments.
 *
 * A budget is a standing line; a percent is a one-shot cut; default_action /
 * proposed_config are explicit-plan modes. The combinations are ambiguous asks
 * and must be rejected at the door — BEFORE any backend query — so these tests
 * run with a hollow env and never touch a network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEstimateForecast, leversInsteadOfCompact } from '../src/tools/estimate-savings.js';
import type { EnvConfig } from '../src/lib/environments.js';

const hollowEnv = { nickname: 'test', labels: {} } as unknown as EnvConfig;

const base = { destination: 'cloudwatch', retention_months: 1 } as const;

test('forecast rejects the two budgets together', async () => {
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runEstimateForecast({ ...base, budget_usd_monthly: 100, budget_gb_monthly: 50 } as any, hollowEnv),
    /mutually exclusive/
  );
});

test('forecast rejects budget + target_percent', async () => {
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runEstimateForecast({ ...base, budget_usd_monthly: 100, target_percent: 30 } as any, hollowEnv),
    /mutually exclusive/
  );
});

test('forecast rejects budget + default_action (budgets are ladder-only)', async () => {
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runEstimateForecast({ ...base, budget_usd_monthly: 100, default_action: 'drop' } as any, hollowEnv),
    /ladder solver only/
  );
});

test('forecast rejects budget + proposed_config', async () => {
  await assert.rejects(
    runEstimateForecast(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...base, budget_gb_monthly: 100, proposed_config: [{ pattern_hash: 'x', action: 'compact' }] } as any,
      hollowEnv
    ),
    /ladder solver only/
  );
});

test('forecast with no target at all names all three options', async () => {
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runEstimateForecast({ ...base } as any, hollowEnv),
    /target_percent, budget_usd_monthly, or budget_gb_monthly/
  );
});

// ---------------------------------------------------------------------------
// Compact refused on ClickHouse
//
// The refusal has to name a lever the destination actually has. Hardcoding
// "tier_down, sample, or drop" sent a ClickHouse user to a tool call that
// refuses one step later: there is no cheaper in-platform tier modeled there.
// ---------------------------------------------------------------------------

test('compact is refused on clickhouse and the refusal names offload', () => {
  const levers = leversInsteadOfCompact('clickhouse');
  assert.ok(levers.includes('offload'), `expected offload, got ${levers.join(', ')}`);
  assert.ok(!levers.includes('compact'));
  assert.ok(!levers.includes('tier_down'), 'clickhouse has no modeled cheaper tier yet');
});

test('compact refused elsewhere still names that destination own lever', () => {
  assert.ok(leversInsteadOfCompact('datadog').includes('tier_down'));
  assert.ok(leversInsteadOfCompact('cloudwatch').includes('tier_down'));
  // Every destination keeps the lossy opt-ins as the last resort.
  for (const dest of ['clickhouse', 'datadog', 'sumo']) {
    assert.ok(leversInsteadOfCompact(dest).includes('sample'));
    assert.ok(leversInsteadOfCompact(dest).includes('drop'));
  }
});
