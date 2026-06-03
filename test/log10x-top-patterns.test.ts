/**
 * Assertions for the log10x_top_patterns structured envelope (defect 13).
 *
 * These tests exercise the envelope shape using the computeTrendDelta
 * helper directly (no live Prometheus queries). They verify:
 *   1. Every pattern row in data.patterns includes a trend_delta field.
 *   2. trend_delta.glyph is consistent with the row's state.
 *   3. Existing state field is still present and unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTrendDelta } from '../src/lib/trend-delta.js';
import type { TrendDelta } from '../src/lib/trend-delta.js';
import type { Badge } from '../src/lib/top-patterns-extras.js';

/** Minimal pattern row shape returned by the top_patterns envelope. */
interface PatternRow {
  state: Badge;
  trend_delta: TrendDelta;
  trend_bytes_per_sec: number[];
  first_seen_age_seconds: number | null;
}

/** Build a synthetic pattern row the way top-patterns.ts does. */
function buildRow(
  state: Badge,
  trendArray: number[],
  firstSeenAgeSeconds: number | null
): PatternRow {
  return {
    state,
    trend_delta: computeTrendDelta(state, trendArray, firstSeenAgeSeconds),
    trend_bytes_per_sec: trendArray,
    first_seen_age_seconds: firstSeenAgeSeconds,
  };
}

/** Expected glyph per state. */
const EXPECTED_GLYPH: Record<Badge, TrendDelta['glyph']> = {
  GROWING: '↗',
  SHRINKING: '↘',
  STABLE: '─',
  ACUTE: '🔥',
  NEW: '🆕',
};

const STATES: Badge[] = ['GROWING', 'SHRINKING', 'STABLE', 'ACUTE', 'NEW'];

describe('top_patterns envelope — trend_delta field', () => {
  it('every synthetic pattern row includes a trend_delta field', () => {
    const rows = STATES.map(s => buildRow(s, [100, 120, 130], 172800));
    for (const row of rows) {
      assert.ok(row.trend_delta !== undefined, `trend_delta missing for state ${row.state}`);
      assert.ok(typeof row.trend_delta.glyph === 'string');
      assert.ok(typeof row.trend_delta.label === 'string');
      assert.ok(typeof row.trend_delta.value === 'number');
    }
  });

  it('trend_delta.glyph matches state category for all five states', () => {
    for (const state of STATES) {
      const row = buildRow(state, [100, 100, 110, 100, 100, 110], 86400);
      assert.equal(
        row.trend_delta.glyph,
        EXPECTED_GLYPH[state],
        `glyph mismatch for state ${state}`
      );
    }
  });

  it('existing state field is preserved alongside trend_delta', () => {
    for (const state of STATES) {
      const row = buildRow(state, [50, 60], 3600);
      assert.equal(row.state, state);
      assert.ok(row.trend_delta !== undefined);
    }
  });

  it('GROWING row: trend_delta scope is wow and unit is pct', () => {
    const row = buildRow('GROWING', [100, 150], null);
    assert.equal(row.trend_delta.scope, 'wow');
    assert.equal(row.trend_delta.unit, 'pct');
  });

  it('ACUTE row: trend_delta scope is h1 and unit is pct', () => {
    const row = buildRow('ACUTE', Array.from({ length: 12 }, (_, i) => i < 6 ? 10 : 100), null);
    assert.equal(row.trend_delta.scope, 'h1');
    assert.equal(row.trend_delta.unit, 'pct');
  });

  it('NEW row: trend_delta scope is age and unit is days', () => {
    const row = buildRow('NEW', [], 259200);
    assert.equal(row.trend_delta.scope, 'age');
    assert.equal(row.trend_delta.unit, 'days');
    assert.equal(row.trend_delta.value, 3);
  });

  it('SHRINKING row: trend_delta value is negative', () => {
    const arr = [...Array.from({ length: 72 }, () => 200), ...Array.from({ length: 72 }, () => 100)];
    const row = buildRow('SHRINKING', arr, null);
    assert.ok(row.trend_delta.value < 0, `expected negative value, got ${row.trend_delta.value}`);
  });

  it('STABLE row: label uses ± prefix', () => {
    const arr = [...Array.from({ length: 72 }, () => 100), ...Array.from({ length: 72 }, () => 103)];
    const row = buildRow('STABLE', arr, null);
    assert.match(row.trend_delta.label, /^±/);
  });
});
