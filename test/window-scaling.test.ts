/**
 * Tests for src/lib/window-scaling.ts
 *
 * Covers:
 *   - parseWindowMs: valid inputs, invalid inputs
 *   - scaleBytes: identity, scale-down, scale-up, zero window throws, zero bytes
 *   - percentToTargetBytes: nominal, 100%, 0%, clamping
 *   - scaleObservedToReceiverWindow: integration with parseWindowMs + scaleBytes
 *   - readableWindow: inverse of parseWindowMs for common values
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWindowMs,
  scaleBytes,
  percentToTargetBytes,
  scaleObservedToReceiverWindow,
  readableWindow,
  RECEIVER_DEFAULT_RESET_MS,
} from '../src/lib/window-scaling.js';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

// ─── parseWindowMs ────────────────────────────────────────────────────────────

test('parseWindowMs accepts 5m', () => {
  assert.equal(parseWindowMs('5m'), 5 * 60_000);
});

test('parseWindowMs accepts 1h', () => {
  assert.equal(parseWindowMs('1h'), 3_600_000);
});

test('parseWindowMs accepts 24h', () => {
  assert.equal(parseWindowMs('24h'), 24 * 3_600_000);
});

test('parseWindowMs accepts 7d', () => {
  assert.equal(parseWindowMs('7d'), 7 * 86_400_000);
});

test('parseWindowMs throws on "5sec"', () => {
  assert.throws(() => parseWindowMs('5sec'), TypeError);
});

test('parseWindowMs throws on "1" (no unit)', () => {
  assert.throws(() => parseWindowMs('1'), TypeError);
});

test('parseWindowMs throws on "tomorrow"', () => {
  assert.throws(() => parseWindowMs('tomorrow'), TypeError);
});

test('parseWindowMs throws on negative-looking input "-5m"', () => {
  assert.throws(() => parseWindowMs('-5m'), TypeError);
});

// ─── scaleBytes ───────────────────────────────────────────────────────────────

test('scaleBytes identity: 100MB from 1h to 1h = 100MB', () => {
  const oneHourMs = 3_600_000;
  assert.equal(scaleBytes(100 * MB, oneHourMs, oneHourMs), 100 * MB);
});

test('scaleBytes scale-down: 100MB from 1h to 4min ≈ 6.67MB', () => {
  const oneHourMs = 3_600_000;
  const fourMinMs = 240_000;
  const result = scaleBytes(100 * MB, oneHourMs, fourMinMs);
  // 100MB * (4/60) = 6.666...MB
  const expected = (100 * MB * 4) / 60;
  assert.ok(
    Math.abs(result - expected) < 1,
    `Expected ~${expected.toFixed(0)} bytes, got ${result.toFixed(0)}`,
  );
});

test('scaleBytes scale-up: 100MB from 1h to 24h = 2400MB', () => {
  const oneHourMs = 3_600_000;
  const oneDayMs = 86_400_000;
  assert.equal(scaleBytes(100 * MB, oneHourMs, oneDayMs), 2400 * MB);
});

test('scaleBytes throws RangeError on zero fromWindowMs', () => {
  assert.throws(() => scaleBytes(100 * MB, 0, 3_600_000), RangeError);
});

test('scaleBytes throws RangeError on zero toWindowMs', () => {
  assert.throws(() => scaleBytes(100 * MB, 3_600_000, 0), RangeError);
});

test('scaleBytes zero bytes returns 0 regardless of windows', () => {
  assert.equal(scaleBytes(0, 3_600_000, 240_000), 0);
});

// ─── percentToTargetBytes ─────────────────────────────────────────────────────

test('percentToTargetBytes: 100MB at 30% reduction → 70MB', () => {
  assert.equal(percentToTargetBytes(100 * MB, 30), 70 * MB);
});

test('percentToTargetBytes: 100MB at 100% reduction → 0', () => {
  assert.equal(percentToTargetBytes(100 * MB, 100), 0);
});

test('percentToTargetBytes: 100MB at 0% reduction → 100MB', () => {
  assert.equal(percentToTargetBytes(100 * MB, 0), 100 * MB);
});

test('percentToTargetBytes clamps percent below 0 to 0 (no change)', () => {
  assert.equal(percentToTargetBytes(100 * MB, -10), 100 * MB);
});

test('percentToTargetBytes clamps percent above 100 to 100 (zero output)', () => {
  assert.equal(percentToTargetBytes(100 * MB, 150), 0);
});

// ─── scaleObservedToReceiverWindow ────────────────────────────────────────────

test('scaleObservedToReceiverWindow: 1GB over 24h → ~2.78MB per 4-min window', () => {
  // 1GB / (24*60/4 windows) = 1GB / 360 = ~2.844MB
  const result = scaleObservedToReceiverWindow(GB, '24h');
  const windowsPerDay = (24 * 60 * 60 * 1000) / RECEIVER_DEFAULT_RESET_MS; // 360
  const expected = GB / windowsPerDay;
  assert.ok(
    Math.abs(result - expected) < 1,
    `Expected ~${expected.toFixed(0)} bytes (~2.78MB), got ${result.toFixed(0)}`,
  );
});

test('scaleObservedToReceiverWindow uses custom receiverResetMs', () => {
  const eightMinMs = 480_000;
  // 1GB over 1h, reset every 8min → 1GB * (8min/60min) = 1GB/7.5
  const result = scaleObservedToReceiverWindow(GB, '1h', eightMinMs);
  const expected = GB * (eightMinMs / 3_600_000);
  assert.ok(
    Math.abs(result - expected) < 1,
    `Expected ~${expected.toFixed(0)}, got ${result.toFixed(0)}`,
  );
});

// ─── readableWindow ───────────────────────────────────────────────────────────

test('readableWindow: 240000 → "4m"', () => {
  assert.equal(readableWindow(240_000), '4m');
});

test('readableWindow: 3600000 → "1h"', () => {
  assert.equal(readableWindow(3_600_000), '1h');
});

test('readableWindow: 86400000 → "1d"', () => {
  assert.equal(readableWindow(86_400_000), '1d');
});

test('readableWindow: 300000 (5m) → "5m"', () => {
  assert.equal(readableWindow(300_000), '5m');
});

test('readableWindow: 604800000 (7d) → "7d"', () => {
  assert.equal(readableWindow(604_800_000), '7d');
});
