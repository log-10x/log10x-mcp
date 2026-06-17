/**
 * query-probe.ts — window-narrowing math for the localization probe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nowOffsetSec, narrowWindow, recentFallbackWindow } from '../src/lib/query-probe.js';

test('nowOffsetSec parses now() and now("-Nx") forms', () => {
  assert.equal(nowOffsetSec('now()'), 0);
  assert.equal(nowOffsetSec('now("-30s")'), 30);
  assert.equal(nowOffsetSec('now("-5m")'), 300);
  assert.equal(nowOffsetSec("now('-2h')"), 7200);
  assert.equal(nowOffsetSec('now("-1d")'), 86400);
  assert.equal(nowOffsetSec('now(-90s)'), 90); // unquoted
  assert.equal(nowOffsetSec('1781700000000'), null); // epoch is not a now-offset
  assert.equal(nowOffsetSec('garbage'), null);
});

test('narrowWindow anchors a 60s window at the end of a now()-relative range', () => {
  assert.deepEqual(narrowWindow('now("-2h")', 'now()', 60), { from: 'now("-60s")', to: 'now()' });
});

test('narrowWindow on a past now()-relative range keeps the same anchor', () => {
  assert.deepEqual(narrowWindow('now("-15m")', 'now("-10m")', 60), {
    from: 'now("-660s")',
    to: 'now("-600s")',
  });
});

test('narrowWindow handles epoch-ms bounds', () => {
  assert.deepEqual(narrowWindow('1781700000000', '1781700300000', 60), {
    from: '1781700240000',
    to: '1781700300000',
  });
});

test('narrowWindow handles ISO8601 bounds (MCP-normalized from/to)', () => {
  const toE = Date.parse('2026-06-17T21:00:00.000Z');
  assert.deepEqual(narrowWindow('2026-06-17T19:00:00.000Z', '2026-06-17T21:00:00.000Z', 60), {
    from: String(toE - 60_000),
    to: String(toE),
  });
});

test('narrowWindow honors a custom window size', () => {
  assert.deepEqual(narrowWindow('now("-1h")', 'now()', 20), { from: 'now("-20s")', to: 'now()' });
});

test('narrowWindow skews the window back from the anchor (avoids the unindexed edge)', () => {
  assert.deepEqual(narrowWindow('now("-2h")', 'now()', 20, 120), {
    from: 'now("-140s")',
    to: 'now("-120s")',
  });
  const toE = Date.parse('2026-06-17T21:00:00.000Z');
  assert.deepEqual(narrowWindow('2026-06-17T19:00:00.000Z', '2026-06-17T21:00:00.000Z', 20, 120), {
    from: String(toE - 140_000),
    to: String(toE - 120_000),
  });
});

test('narrowWindow returns null for unparseable bounds', () => {
  assert.equal(narrowWindow('yesterday', 'today'), null);
});

test('recentFallbackWindow yields a skewed recent slice', () => {
  assert.deepEqual(recentFallbackWindow(60, 90), { from: 'now("-150s")', to: 'now("-90s")' });
});
