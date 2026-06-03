import { describe, it, expect } from 'vitest';
import {
  computePerHashBudgetMs,
  computeMaxPullMinutes,
  DEFAULT_PER_HASH_MS,
  MAX_PER_HASH_MS,
  DEFAULT_MAX_PULL_MINUTES,
} from '../src/lib/sample-budget.js';

describe('computePerHashBudgetMs', () => {
  it('returns 2500 for undefined window (matches historic constant)', () => {
    expect(computePerHashBudgetMs(undefined)).toBe(2500);
  });

  it('returns DEFAULT_PER_HASH_MS for undefined', () => {
    expect(computePerHashBudgetMs(undefined)).toBe(DEFAULT_PER_HASH_MS);
  });

  it('returns 2500 for unparseable window string', () => {
    expect(computePerHashBudgetMs('invalid')).toBe(2500);
    expect(computePerHashBudgetMs('')).toBe(2500);
    expect(computePerHashBudgetMs('5sec')).toBe(2500);
  });

  it('5m -> 2500 (sub-hour, tier 1)', () => {
    expect(computePerHashBudgetMs('5m')).toBe(2500);
  });

  it('1h -> 2500 (exactly at tier 1 ceiling)', () => {
    expect(computePerHashBudgetMs('1h')).toBe(2500);
  });

  it('6h -> 4000 (exactly at tier 2 ceiling)', () => {
    expect(computePerHashBudgetMs('6h')).toBe(4000);
  });

  it('2h -> 4000 (between tier 1 and tier 2)', () => {
    expect(computePerHashBudgetMs('2h')).toBe(4000);
  });

  it('24h -> 6000 (exactly at tier 3 ceiling)', () => {
    expect(computePerHashBudgetMs('24h')).toBe(6000);
  });

  it('1d -> 6000 (same as 24h, day unit)', () => {
    expect(computePerHashBudgetMs('1d')).toBe(6000);
  });

  it('7h -> 6000 (between tier 2 and tier 3)', () => {
    expect(computePerHashBudgetMs('7h')).toBe(6000);
  });

  it('7d -> 10000 (between tier 3 and tier 4)', () => {
    expect(computePerHashBudgetMs('7d')).toBe(10000);
  });

  it('3d -> 10000 (exactly at tier 4 ceiling 72h)', () => {
    expect(computePerHashBudgetMs('3d')).toBe(10000);
  });

  it('30d -> 15000 (above tier 4 ceiling)', () => {
    expect(computePerHashBudgetMs('30d')).toBe(15000);
  });

  it('90d -> 15000 (hard ceiling)', () => {
    expect(computePerHashBudgetMs('90d')).toBe(MAX_PER_HASH_MS);
  });

  it('4d -> 15000 (beyond 72h)', () => {
    expect(computePerHashBudgetMs('4d')).toBe(15000);
  });
});

describe('computeMaxPullMinutes', () => {
  it('returns 0.25 for undefined window (matches historic constant)', () => {
    expect(computeMaxPullMinutes(undefined)).toBe(DEFAULT_MAX_PULL_MINUTES);
    expect(computeMaxPullMinutes(undefined)).toBe(0.25);
  });

  it('returns 0.25 for unparseable window', () => {
    expect(computeMaxPullMinutes('bad')).toBe(0.25);
  });

  it('1h -> 0.25', () => {
    expect(computeMaxPullMinutes('1h')).toBe(0.25);
  });

  it('5m -> 0.25', () => {
    expect(computeMaxPullMinutes('5m')).toBe(0.25);
  });

  it('6h -> 0.33', () => {
    expect(computeMaxPullMinutes('6h')).toBe(0.33);
  });

  it('24h -> 0.5', () => {
    expect(computeMaxPullMinutes('24h')).toBe(0.5);
  });

  it('1d -> 0.5', () => {
    expect(computeMaxPullMinutes('1d')).toBe(0.5);
  });

  it('3d -> 0.75 (72h)', () => {
    expect(computeMaxPullMinutes('3d')).toBe(0.75);
  });

  it('7d -> 1.0 (above 72h)', () => {
    expect(computeMaxPullMinutes('7d')).toBe(1.0);
  });

  it('30d -> 1.0 (hard ceiling)', () => {
    expect(computeMaxPullMinutes('30d')).toBe(1.0);
  });
});
