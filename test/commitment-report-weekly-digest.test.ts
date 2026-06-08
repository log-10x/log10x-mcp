/**
 * Tests for the `format=weekly_digest` path in commitment-report.ts.
 *
 * All tests are pure-function / offline — no live Prometheus backend or
 * commitment record required.  History data is injected via temporary files.
 *
 * Covers:
 *   1. readHistorySince: empty file → no runs
 *   2. readHistorySince: lines outside window excluded
 *   3. readHistorySince: malformed lines skipped
 *   4. executeCommitmentReport weekly_digest: empty history → caveat + 0 ticks
 *   5. executeCommitmentReport weekly_digest: applied ticks in window aggregated
 *   6. Action distribution from valid action-intent.json content
 *   7. New-this-week pattern detection from recent set_at_iso
 *   8. Anomaly growth detection when savings grow >5x
 *   9. Markdown is populated on the returned envelope
 *  10. readRecentHistory: returns N most recent runs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

import {
  readHistorySince,
  readRecentHistory,
} from '../src/lib/recur-history-reader.js';
import {
  executeCommitmentReport,
  type WeeklyDigestEnvelope,
  type CommitmentReportArgs,
} from '../src/tools/commitment-report.js';

// ─── test helpers ─────────────────────────────────────────────────────────────

/**
 * Write a JSONL history file with the given tick entries and return its path.
 */
function writeHistory(
  name: string,
  entries: Array<{
    ts: string;
    status: string;
    projected_savings_pct: number;
    delta_patterns: number;
    delta_pp: number;
    message: string;
  }>
): string {
  const dir = pathJoin(tmpdir(), 'log10x-test-digest');
  mkdirSync(dir, { recursive: true });
  const filePath = pathJoin(dir, `${name}-history.jsonl`);
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(filePath, lines, 'utf8');
  return filePath;
}

/**
 * Write a minimal action-intent.json with the given entries and return its path.
 */
function writeActionIntent(
  name: string,
  entries: Array<{
    pattern_hash: string;
    service: string;
    action: string;
    reason: string;
    set_at_iso: string;
    until_epoch_sec: number;
  }>
): string {
  const dir = pathJoin(tmpdir(), 'log10x-test-digest');
  mkdirSync(dir, { recursive: true });
  const filePath = pathJoin(dir, `${name}-intent.json`);
  const content = JSON.stringify({
    schema_version: '1.0',
    updated_at_iso: new Date().toISOString(),
    entries,
  });
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function nowIso(): string {
  return new Date().toISOString();
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── recur-history-reader tests ───────────────────────────────────────────────

test('readHistorySince: non-existent file returns empty array', () => {
  const runs = readHistorySince(0, '/tmp/log10x-test-no-such-file-xyz.jsonl');
  assert.deepEqual(runs, []);
});

test('readHistorySince: empty file returns empty array', () => {
  const dir = pathJoin(tmpdir(), 'log10x-test-digest');
  mkdirSync(dir, { recursive: true });
  const p = pathJoin(dir, 'empty.jsonl');
  writeFileSync(p, '', 'utf8');
  const runs = readHistorySince(0, p);
  assert.deepEqual(runs, []);
});

test('readHistorySince: lines outside window are excluded', () => {
  const oldTs = daysAgoIso(10);
  const recentTs = daysAgoIso(2);
  const filePath = writeHistory('window-test', [
    {
      ts: oldTs,
      status: 'applied',
      projected_savings_pct: 20,
      delta_patterns: 3,
      delta_pp: 2,
      message: 'old tick',
    },
    {
      ts: recentTs,
      status: 'no_change',
      projected_savings_pct: 21,
      delta_patterns: 0,
      delta_pp: 0.1,
      message: 'recent tick',
    },
  ]);
  // Only look at last 7 days
  const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const runs = readHistorySince(sinceMs, filePath);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, 'no_change');
  assert.equal(runs[0]!.message, 'recent tick');
});

test('readHistorySince: malformed lines are skipped', () => {
  const dir = pathJoin(tmpdir(), 'log10x-test-digest');
  mkdirSync(dir, { recursive: true });
  const p = pathJoin(dir, 'malformed.jsonl');
  writeFileSync(
    p,
    [
      'NOT_JSON',
      '',
      JSON.stringify({
        ts: daysAgoIso(1),
        status: 'applied',
        projected_savings_pct: 30,
        delta_patterns: 2,
        delta_pp: 5,
        message: 'good',
      }),
      '{"ts":"bad-date","status":"applied","projected_savings_pct":10,"delta_patterns":0,"delta_pp":0,"message":"x"}',
    ].join('\n'),
    'utf8'
  );
  const runs = readHistorySince(0, p);
  // Only the one good line with a valid ISO ts should survive
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, 'applied');
  assert.equal(runs[0]!.projected_savings_pct, 30);
});

test('readHistorySince: results are sorted chronologically', () => {
  const filePath = writeHistory('sort-test', [
    {
      ts: daysAgoIso(5),
      status: 'applied',
      projected_savings_pct: 10,
      delta_patterns: 1,
      delta_pp: 1,
      message: 'older',
    },
    {
      ts: daysAgoIso(1),
      status: 'applied',
      projected_savings_pct: 20,
      delta_patterns: 2,
      delta_pp: 2,
      message: 'newer',
    },
    {
      ts: daysAgoIso(3),
      status: 'no_change',
      projected_savings_pct: 15,
      delta_patterns: 0,
      delta_pp: 0,
      message: 'middle',
    },
  ]);
  const runs = readHistorySince(0, filePath);
  assert.equal(runs.length, 3);
  assert.ok(runs[0]!.ts_ms <= runs[1]!.ts_ms);
  assert.ok(runs[1]!.ts_ms <= runs[2]!.ts_ms);
  assert.equal(runs[0]!.message, 'older');
  assert.equal(runs[2]!.message, 'newer');
});

test('readRecentHistory: returns at most limit items', () => {
  const filePath = writeHistory('recent-limit', [
    {
      ts: daysAgoIso(6),
      status: 'applied',
      projected_savings_pct: 10,
      delta_patterns: 1,
      delta_pp: 1,
      message: 'a',
    },
    {
      ts: daysAgoIso(5),
      status: 'applied',
      projected_savings_pct: 11,
      delta_patterns: 1,
      delta_pp: 1,
      message: 'b',
    },
    {
      ts: daysAgoIso(4),
      status: 'applied',
      projected_savings_pct: 12,
      delta_patterns: 1,
      delta_pp: 1,
      message: 'c',
    },
  ]);
  const recent = readRecentHistory(2, filePath);
  assert.equal(recent.length, 2);
  // Should be the two most recent (b and c)
  assert.equal(recent[0]!.message, 'b');
  assert.equal(recent[1]!.message, 'c');
});

// ─── executeCommitmentReport weekly_digest tests ──────────────────────────────

test('weekly_digest: empty history produces caveat and zero tick count', async () => {
  const noopHistPath = pathJoin(tmpdir(), 'log10x-test-digest', 'noop-empty.jsonl');
  writeFileSync(noopHistPath, '', 'utf8');

  const args: CommitmentReportArgs = {
    format: 'weekly_digest',
    period: '90d',
    history_path: noopHistPath,
    action_intent_path: pathJoin(tmpdir(), 'log10x-test-no-such-intent.json'),
  };
  const result = await executeCommitmentReport(args);
  // commitment-report.ts returns a chassis envelope; the real
  // WeeklyDigestEnvelope lives at result.data.payload (chassis migration).
  const env = (result.data as { payload: WeeklyDigestEnvelope }).payload;

  assert.equal(env.tick_count, 0);
  assert.equal(env.applied_count, 0);
  assert.equal(env.total_projected_savings_pct, null);
  assert.ok(env.caveats.some((c) => c.includes('No tick runs')));
});

test('weekly_digest: applied ticks within window are aggregated', async () => {
  const histPath = writeHistory('agg-test', [
    {
      ts: daysAgoIso(5),
      status: 'applied',
      projected_savings_pct: 15,
      delta_patterns: 3,
      delta_pp: 5,
      message: 'tick-1',
    },
    {
      ts: daysAgoIso(3),
      status: 'no_change',
      projected_savings_pct: 15,
      delta_patterns: 0,
      delta_pp: 0,
      message: 'tick-2',
    },
    {
      ts: daysAgoIso(1),
      status: 'applied',
      projected_savings_pct: 18,
      delta_patterns: 2,
      delta_pp: 3,
      message: 'tick-3',
    },
  ]);

  const args: CommitmentReportArgs = {
    format: 'weekly_digest',
    period: '90d',
    history_path: histPath,
    action_intent_path: pathJoin(tmpdir(), 'log10x-test-no-such-intent.json'),
  };
  const result = await executeCommitmentReport(args);
  // commitment-report.ts returns a chassis envelope; the real
  // WeeklyDigestEnvelope lives at result.data.payload (chassis migration).
  const env = (result.data as { payload: WeeklyDigestEnvelope }).payload;

  assert.equal(env.tick_count, 3);
  assert.equal(env.applied_count, 2);
  // total_projected_savings_pct = last tick's value (18)
  assert.equal(env.total_projected_savings_pct, 18);
  assert.equal(env.tick_history.length, 3);
  // tick_history[2] should be the most recent
  assert.equal(env.tick_history[2]!.status, 'applied');
  assert.equal(env.tick_history[2]!.projected_savings_pct, 18);
});

test('weekly_digest: action distribution from valid action-intent.json', async () => {
  const histPath = writeHistory('action-dist', []);
  const intentPath = writeActionIntent('action-dist', [
    {
      pattern_hash: 'h1',
      service: 'frontend',
      action: 'drop',
      reason: 'noisy',
      set_at_iso: daysAgoIso(3),
      until_epoch_sec: 0,
    },
    {
      pattern_hash: 'h2',
      service: 'backend',
      action: 'drop',
      reason: 'noisy2',
      set_at_iso: daysAgoIso(3),
      until_epoch_sec: 0,
    },
    {
      pattern_hash: 'h3',
      service: 'api',
      action: 'compact',
      reason: 'moderate',
      set_at_iso: daysAgoIso(2),
      until_epoch_sec: 0,
    },
  ]);

  const args: CommitmentReportArgs = {
    format: 'weekly_digest',
    period: '90d',
    history_path: histPath,
    action_intent_path: intentPath,
  };
  const result = await executeCommitmentReport(args);
  // commitment-report.ts returns a chassis envelope; the real
  // WeeklyDigestEnvelope lives at result.data.payload (chassis migration).
  const env = (result.data as { payload: WeeklyDigestEnvelope }).payload;

  assert.equal(env.action_distribution['drop']?.pattern_count, 2);
  assert.equal(env.action_distribution['compact']?.pattern_count, 1);
});

test('weekly_digest: new-this-week patterns detected from recent set_at_iso', async () => {
  // buildPatternNotes short-circuits when no tick runs exist
  // (runs.length === 0 → no notes), so seed one applied tick in-window
  // before exercising the action-intent-driven new_this_week path.
  const histPath = writeHistory('new-pattern', [
    {
      ts: daysAgoIso(1),
      status: 'applied',
      projected_savings_pct: 12,
      delta_patterns: 1,
      delta_pp: 2,
      message: 'tick',
    },
  ]);
  const intentPath = writeActionIntent('new-pattern', [
    {
      pattern_hash: 'new-hash-abc',
      service: 'payments',
      action: 'drop',
      reason: 'high volume',
      // set within last 7 days → should be flagged as new_this_week
      set_at_iso: daysAgoIso(2),
      until_epoch_sec: 0,
    },
    {
      pattern_hash: 'old-hash-xyz',
      service: 'payments',
      action: 'compact',
      reason: 'moderate',
      // set 30 days ago → NOT new this week
      set_at_iso: daysAgoIso(30),
      until_epoch_sec: 0,
    },
  ]);

  const args: CommitmentReportArgs = {
    format: 'weekly_digest',
    period: '90d',
    history_path: histPath,
    action_intent_path: intentPath,
  };
  const result = await executeCommitmentReport(args);
  // commitment-report.ts returns a chassis envelope; the real
  // WeeklyDigestEnvelope lives at result.data.payload (chassis migration).
  const env = (result.data as { payload: WeeklyDigestEnvelope }).payload;

  const newNotes = env.pattern_notes.filter((n) => n.kind === 'new_this_week');
  assert.equal(newNotes.length, 1);
  assert.equal(newNotes[0]!.pattern_hash, 'new-hash-abc');
});

test('weekly_digest: anomaly growth detected when savings grow >5x', async () => {
  const histPath = writeHistory('anomaly', [
    {
      ts: daysAgoIso(6),
      status: 'applied',
      projected_savings_pct: 5,
      delta_patterns: 2,
      delta_pp: 5,
      message: 'early tick',
    },
    {
      ts: daysAgoIso(1),
      status: 'applied',
      projected_savings_pct: 30, // 6x growth → anomaly
      delta_patterns: 10,
      delta_pp: 25,
      message: 'late tick',
    },
  ]);

  const args: CommitmentReportArgs = {
    format: 'weekly_digest',
    period: '90d',
    history_path: histPath,
    action_intent_path: pathJoin(tmpdir(), 'log10x-test-no-such-intent.json'),
  };
  const result = await executeCommitmentReport(args);
  // commitment-report.ts returns a chassis envelope; the real
  // WeeklyDigestEnvelope lives at result.data.payload (chassis migration).
  const env = (result.data as { payload: WeeklyDigestEnvelope }).payload;

  const anomalies = env.pattern_notes.filter((n) => n.kind === 'anomaly_growth');
  assert.equal(anomalies.length, 1);
  assert.ok(anomalies[0]!.growth_ratio !== undefined);
  assert.ok(anomalies[0]!.growth_ratio! >= 5);
});

test('weekly_digest: no anomaly when savings grow <5x', async () => {
  const histPath = writeHistory('no-anomaly', [
    {
      ts: daysAgoIso(5),
      status: 'applied',
      projected_savings_pct: 10,
      delta_patterns: 1,
      delta_pp: 2,
      message: 'a',
    },
    {
      ts: daysAgoIso(2),
      status: 'applied',
      projected_savings_pct: 20, // 2x — below 5x threshold
      delta_patterns: 2,
      delta_pp: 10,
      message: 'b',
    },
  ]);

  const args: CommitmentReportArgs = {
    format: 'weekly_digest',
    period: '90d',
    history_path: histPath,
    action_intent_path: pathJoin(tmpdir(), 'log10x-test-no-such-intent.json'),
  };
  const result = await executeCommitmentReport(args);
  // commitment-report.ts returns a chassis envelope; the real
  // WeeklyDigestEnvelope lives at result.data.payload (chassis migration).
  const env = (result.data as { payload: WeeklyDigestEnvelope }).payload;

  const anomalies = env.pattern_notes.filter((n) => n.kind === 'anomaly_growth');
  assert.equal(anomalies.length, 0);
});

test('weekly_digest: markdown is populated and contains expected sections', async () => {
  const histPath = writeHistory('markdown-check', [
    {
      ts: daysAgoIso(2),
      status: 'applied',
      projected_savings_pct: 22,
      delta_patterns: 4,
      delta_pp: 6,
      message: 'tick',
    },
  ]);

  const args: CommitmentReportArgs = {
    format: 'weekly_digest',
    period: '90d',
    history_path: histPath,
    action_intent_path: pathJoin(tmpdir(), 'log10x-test-no-such-intent.json'),
  };
  const result = await executeCommitmentReport(args);
  // commitment-report.ts returns a chassis envelope; the real
  // WeeklyDigestEnvelope lives at result.data.payload (chassis migration).
  const env = (result.data as { payload: WeeklyDigestEnvelope }).payload;

  assert.ok(typeof env.markdown === 'string' && env.markdown.length > 0);
  assert.ok(env.markdown!.includes('Weekly Digest'));
  assert.ok(env.markdown!.includes('Tick history'));
});

test('weekly_digest: human_summary is a non-empty string', async () => {
  const histPath = writeHistory('human-summary', []);

  const args: CommitmentReportArgs = {
    format: 'weekly_digest',
    period: '90d',
    history_path: histPath,
    action_intent_path: pathJoin(tmpdir(), 'log10x-test-no-such-intent.json'),
  };
  const result = await executeCommitmentReport(args);
  // commitment-report.ts returns a chassis envelope; the real
  // WeeklyDigestEnvelope lives at result.data.payload (chassis migration).
  const env = (result.data as { payload: WeeklyDigestEnvelope }).payload;

  assert.ok(typeof env.human_summary === 'string' && env.human_summary.length > 0);
  assert.ok(env.human_summary.includes('Weekly digest'));
});
