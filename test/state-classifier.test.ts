/**
 * Unit tests for classifyStateFromDelta (defect 14).
 *
 * Verifies that state is derived exclusively from trend_delta.value
 * (WoW percent change) and first-seen age. Threshold: ±15% (approved
 * by Tal 2026-06-03). ACUTE branch is TODO (requires 1h delta input).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStateFromDelta } from '../src/lib/top-patterns-extras.js';

const SEVEN_DAYS = 7 * 24 * 3600;

describe('classifyStateFromDelta', () => {
  // ── GROWING ──────────────────────────────────────────────────────────────
  it('+20% delta → GROWING', () => {
    assert.equal(classifyStateFromDelta(20, null), 'GROWING');
  });

  it('+16% delta → GROWING (just above threshold)', () => {
    assert.equal(classifyStateFromDelta(16, null), 'GROWING');
  });

  // ── SHRINKING ────────────────────────────────────────────────────────────
  it('-25% delta → SHRINKING', () => {
    assert.equal(classifyStateFromDelta(-25, null), 'SHRINKING');
  });

  it('-16% delta → SHRINKING (just below threshold)', () => {
    assert.equal(classifyStateFromDelta(-16, null), 'SHRINKING');
  });

  // ── STABLE ───────────────────────────────────────────────────────────────
  it('+5% delta → STABLE (well within band)', () => {
    assert.equal(classifyStateFromDelta(5, null), 'STABLE');
  });

  it('+15% delta → STABLE (inclusive at upper threshold)', () => {
    // The bug this fixes: patterns at +1% were labeled GROWING under
    // the old 5% threshold. With ±15% band, +15 is still STABLE.
    assert.equal(classifyStateFromDelta(15, null), 'STABLE');
  });

  it('-15% delta → STABLE (inclusive at lower threshold)', () => {
    assert.equal(classifyStateFromDelta(-15, null), 'STABLE');
  });

  it('0% delta → STABLE', () => {
    assert.equal(classifyStateFromDelta(0, null), 'STABLE');
  });

  // ── NEW ──────────────────────────────────────────────────────────────────
  it('age < 7d → NEW regardless of delta', () => {
    const ageSeconds = SEVEN_DAYS - 1; // one second under the threshold
    assert.equal(classifyStateFromDelta(50, ageSeconds), 'NEW');
  });

  it('age exactly 7d → NOT new (GROWING because delta > 15)', () => {
    // The boundary is exclusive: age < 7d is NEW. At exactly 7d, fall
    // through to the delta-based classification.
    assert.equal(classifyStateFromDelta(20, SEVEN_DAYS), 'GROWING');
  });

  it('age < 7d with 0% delta → NEW (age wins over delta)', () => {
    assert.equal(classifyStateFromDelta(0, SEVEN_DAYS - 3600), 'NEW');
  });

  it('null age with +5% delta → STABLE (null age is not < 7d)', () => {
    assert.equal(classifyStateFromDelta(5, null), 'STABLE');
  });

  // ── ACUTE (TODO) ─────────────────────────────────────────────────────────
  // ACUTE requires a separate 1h delta input that is not yet wired.
  // This test documents the deferred branch: until h1DeltaPct is available,
  // classifyStateFromDelta never returns ACUTE.
  it('ACUTE: classifyStateFromDelta never returns ACUTE today (deferred)', () => {
    // A very large WoW delta is still GROWING, not ACUTE.
    assert.equal(classifyStateFromDelta(500, null), 'GROWING');
    assert.equal(classifyStateFromDelta(200, null), 'GROWING');
  });
});
