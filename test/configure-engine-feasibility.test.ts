/**
 * configure_engine feasibility: dual-axis (bytes OR dollars).
 *
 * Bug shape (repo audit): feasibility was tracked purely in bytes
 * (remainingBytesToShed). tier_down has bytes_out == bytes_in, so it sheds
 * zero bytes and remainingBytesToShed never moves. When tier_down is the
 * standard-tier action (e.g. CloudWatch, where compact is a no-op), a plan
 * that hits its dollar target via the cheaper tier was reported INFEASIBLE.
 *
 * Fix: a plan is feasible if it hits the byte target OR the dollar target.
 * The per-row saved_dollars already captures tier_down's rate delta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlanFeasible } from '../src/tools/configure-engine.js';

// Tolerance is ±10% (FEASIBILITY_TOLERANCE_PCT = 0.1).

test('tier_down: zero bytes shed but dollar target met -> feasible', () => {
  const r = isPlanFeasible({
    targetShedBytes: 1_000_000,
    remainingBytesToShed: 1_000_000, // tier_down sheds nothing
    currentMonthlyUsd: 1000,
    targetPercent: 30, // targetShedUsd = 300
    achievedSavedUsd: 300, // the cheaper tier delivers the full $ target
  });
  assert.equal(r.bytesFeasible, false, 'no bytes shed -> byte axis fails');
  assert.equal(r.dollarsFeasible, true, 'dollar target met');
  assert.equal(r.feasible, true, 'feasible via the dollar axis');
});

test('byte target met -> feasible even when dollars fall short', () => {
  const r = isPlanFeasible({
    targetShedBytes: 1_000_000,
    remainingBytesToShed: 0, // fully shed
    currentMonthlyUsd: 1000,
    targetPercent: 30,
    achievedSavedUsd: 0,
  });
  assert.equal(r.bytesFeasible, true);
  assert.equal(r.feasible, true);
});

test('both axes miss -> infeasible', () => {
  const r = isPlanFeasible({
    targetShedBytes: 1_000_000,
    remainingBytesToShed: 1_000_000,
    currentMonthlyUsd: 1000,
    targetPercent: 30, // need $270 within tolerance
    achievedSavedUsd: 100,
  });
  assert.equal(r.bytesFeasible, false);
  assert.equal(r.dollarsFeasible, false);
  assert.equal(r.feasible, false);
});

test('zero target -> feasible (nothing to shed)', () => {
  const r = isPlanFeasible({
    targetShedBytes: 0,
    remainingBytesToShed: 0,
    currentMonthlyUsd: 1000,
    targetPercent: 0,
    achievedSavedUsd: 0,
  });
  assert.equal(r.feasible, true);
});

test('dollar savings within the 10% tolerance band -> feasible', () => {
  // targetShedUsd = 300; tolerance floor = 270.
  const justInside = isPlanFeasible({
    targetShedBytes: 1_000_000,
    remainingBytesToShed: 1_000_000,
    currentMonthlyUsd: 1000,
    targetPercent: 30,
    achievedSavedUsd: 275, // >= 270
  });
  assert.equal(justInside.feasible, true);

  const justOutside = isPlanFeasible({
    targetShedBytes: 1_000_000,
    remainingBytesToShed: 1_000_000,
    currentMonthlyUsd: 1000,
    targetPercent: 30,
    achievedSavedUsd: 260, // < 270, and bytes also miss
  });
  assert.equal(justOutside.feasible, false);
});
