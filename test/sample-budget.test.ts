import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePerHashBudgetMs,
  computeMaxPullMinutes,
  DEFAULT_PER_HASH_MS,
  MAX_PER_HASH_MS,
  DEFAULT_MAX_PULL_MINUTES,
} from '../src/lib/sample-budget.js';

test('computePerHashBudgetMs: returns 2500 for undefined window (matches historic constant)', () => {
  assert.equal(computePerHashBudgetMs(undefined), 2500);
});

test('computePerHashBudgetMs: returns DEFAULT_PER_HASH_MS for undefined', () => {
  assert.equal(computePerHashBudgetMs(undefined), DEFAULT_PER_HASH_MS);
});

test('computePerHashBudgetMs: returns 2500 for unparseable window string', () => {
  assert.equal(computePerHashBudgetMs('invalid'), 2500);
  assert.equal(computePerHashBudgetMs(''), 2500);
  assert.equal(computePerHashBudgetMs('5sec'), 2500);
});

test('computePerHashBudgetMs: 5m -> 2500 (sub-hour, tier 1)', () => {
  assert.equal(computePerHashBudgetMs('5m'), 2500);
});

test('computePerHashBudgetMs: 1h -> 2500 (exactly at tier 1 ceiling)', () => {
  assert.equal(computePerHashBudgetMs('1h'), 2500);
});

test('computePerHashBudgetMs: 6h -> 4000 (exactly at tier 2 ceiling)', () => {
  assert.equal(computePerHashBudgetMs('6h'), 4000);
});

test('computePerHashBudgetMs: 2h -> 4000 (between tier 1 and tier 2)', () => {
  assert.equal(computePerHashBudgetMs('2h'), 4000);
});

test('computePerHashBudgetMs: 24h -> 6000 (exactly at tier 3 ceiling)', () => {
  assert.equal(computePerHashBudgetMs('24h'), 6000);
});

test('computePerHashBudgetMs: 1d -> 6000 (same as 24h, day unit)', () => {
  assert.equal(computePerHashBudgetMs('1d'), 6000);
});

test('computePerHashBudgetMs: 7h -> 6000 (between tier 2 and tier 3)', () => {
  assert.equal(computePerHashBudgetMs('7h'), 6000);
});

test('computePerHashBudgetMs: 7d -> 15000 (168h, beyond tier 4 ceiling of 72h)', () => {
  assert.equal(computePerHashBudgetMs('7d'), 15000);
});

test('computePerHashBudgetMs: 3d -> 10000 (exactly at tier 4 ceiling 72h)', () => {
  assert.equal(computePerHashBudgetMs('3d'), 10000);
});

test('computePerHashBudgetMs: 30d -> 15000 (above tier 4 ceiling)', () => {
  assert.equal(computePerHashBudgetMs('30d'), 15000);
});

test('computePerHashBudgetMs: 90d -> 15000 (hard ceiling)', () => {
  assert.equal(computePerHashBudgetMs('90d'), MAX_PER_HASH_MS);
});

test('computePerHashBudgetMs: 4d -> 15000 (beyond 72h)', () => {
  assert.equal(computePerHashBudgetMs('4d'), 15000);
});

test('computeMaxPullMinutes: returns 0.25 for undefined window (matches historic constant)', () => {
  assert.equal(computeMaxPullMinutes(undefined), DEFAULT_MAX_PULL_MINUTES);
  assert.equal(computeMaxPullMinutes(undefined), 0.25);
});

test('computeMaxPullMinutes: returns 0.25 for unparseable window', () => {
  assert.equal(computeMaxPullMinutes('bad'), 0.25);
});

test('computeMaxPullMinutes: 1h -> 0.25', () => {
  assert.equal(computeMaxPullMinutes('1h'), 0.25);
});

test('computeMaxPullMinutes: 5m -> 0.25', () => {
  assert.equal(computeMaxPullMinutes('5m'), 0.25);
});

test('computeMaxPullMinutes: 6h -> 0.33', () => {
  assert.equal(computeMaxPullMinutes('6h'), 0.33);
});

test('computeMaxPullMinutes: 24h -> 0.5', () => {
  assert.equal(computeMaxPullMinutes('24h'), 0.5);
});

test('computeMaxPullMinutes: 1d -> 0.5', () => {
  assert.equal(computeMaxPullMinutes('1d'), 0.5);
});

test('computeMaxPullMinutes: 3d -> 0.75 (72h)', () => {
  assert.equal(computeMaxPullMinutes('3d'), 0.75);
});

test('computeMaxPullMinutes: 7d -> 1.0 (above 72h)', () => {
  assert.equal(computeMaxPullMinutes('7d'), 1.0);
});

test('computeMaxPullMinutes: 30d -> 1.0 (hard ceiling)', () => {
  assert.equal(computeMaxPullMinutes('30d'), 1.0);
});
