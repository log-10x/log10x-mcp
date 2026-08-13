/**
 * Policy-loop wiring: the seams between what the MCP writes and what the
 * engine reads.
 *
 *   1. Seed lifecycle — the install wizard seeds the policy ConfigMap with
 *      one no-op `tenx-seed` row per file (the engine aborts launch on a
 *      missing ConfigMap and refuses a rows-less CSV). configure_engine's
 *      merges must drop the seed once a real row lands, and must keep it
 *      while it is the only row (a rows-less file bricks the next boot).
 *   2. Seed manifest shape — non-empty caps.csv + actions.csv, RBAC read
 *      grant scoped to the one ConfigMap.
 *   3. recurring-tick (tenx-recur) — mute rows are per-PATTERN thinning
 *      decisions keyed by message_pattern (the engine's mute-file key) and
 *      belong in mutes.csv, NEVER in caps.csv: caps is the container-keyed
 *      byte-cap file with a different value grammar, where a sub-1 "cap"
 *      is a per-container regulator opt-out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { mergeActionRows } from '../src/tools/configure-engine.js';
import {
  renderPolicyConfigMapManifest,
  POLICY_CONFIGMAP_NAME,
} from '../src/lib/advisor/reporter-forwarders.js';
import { writeOutputFiles, type PatternDecision } from '../src/lib/recurring-tick.js';

// ── 1. Seed lifecycle in the merges ─────────────────────────────────────

const SEED_ACTIONS = 'container,action\ntenx-seed,pass::install seed; replaced by log10x_configure_engine\n';

test('mergeActionRows: real rows replace the tenx-seed row', () => {
  const merged = mergeActionRows(SEED_ACTIONS, 'container,action\ncartservice,compact::MCP configure_engine (hard)\n');
  assert.match(merged, /^cartservice,compact::/m);
  assert.doesNotMatch(merged, /tenx-seed/, 'seed row dropped once a real row exists');
});

test('mergeActionRows: the seed row survives alone (a rows-less file bricks the boot)', () => {
  const merged = mergeActionRows(SEED_ACTIONS, 'container,action\n');
  assert.match(merged, /^tenx-seed,pass::/m, 'seed kept when it is the only row');
  assert.ok(merged.trim().split('\n').length >= 2, 'file never becomes header-only');
});

// ── 2. Seed manifest shape ──────────────────────────────────────────────

test('policy ConfigMap manifest: seeded files + scoped RBAC', () => {
  const m = renderPolicyConfigMapManifest('logging');
  assert.match(m, /name: log10x-action-intent/);
  assert.match(m, /namespace: logging/);
  // Each file carries a header AND one row — the engine's lookup loader
  // refuses zero-byte and header-only CSVs at launch.
  assert.match(m, /caps\.csv: \|\n    container,cap\n    tenx-seed,1::/);
  assert.match(m, /actions\.csv: \|\n    container,action\n    tenx-seed,pass::/);
  // Read-only grant on this one ConfigMap, bound namespace-wide (the
  // forwarder chart's ServiceAccount name varies per chart).
  assert.match(m, /resourceNames: \["log10x-action-intent"\]/);
  assert.match(m, /verbs: \["get"\]/);
  assert.match(m, /name: system:serviceaccounts:logging/);
  assert.equal(POLICY_CONFIGMAP_NAME, 'log10x-action-intent');
});

// ── 3. recurring-tick writes engine-conformant files ────────────────────

function decision(over: Partial<PatternDecision>): PatternDecision {
  return {
    pattern_hash: 'user_authenticated_session_id',
    service: 'auth',
    severity: 'INFO',
    bytes: 1_000_000,
    share_pct: 12,
    action: 'drop',
    reason: 'high-volume noise',
    ...over,
  };
}

test('recurring-tick: mute decisions land in mutes.csv, never caps.csv', () => {
  const repo = join(tmpdir(), `tenx-recur-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repo, { recursive: true });
  try {
    writeOutputFiles(repo, [
      decision({ action: 'drop' }),
      decision({ pattern_hash: 'cart_item_added_sku', action: 'sample' }),
      decision({ pattern_hash: 'payment_charged_ok', action: 'compact' }),
    ], false);

    const rateDir = join(repo, 'pipelines', 'run', 'receive', 'rate');
    assert.ok(existsSync(join(rateDir, 'mutes.csv')), 'mutes.csv written');
    assert.ok(!existsSync(join(rateDir, 'caps.csv')), 'caps.csv NOT written by the mute path');

    const mutes = readFileSync(join(rateDir, 'mutes.csv'), 'utf8');
    // Keyed by the message_pattern name; value = <sampleRate>:<untilEpoch>:<reason>.
    assert.match(mutes, /^user_authenticated_session_id,0:/m, 'drop -> sample_rate 0');
    assert.match(mutes, /^cart_item_added_sku,0\.1:/m, 'sample -> sample_rate 0.1');
    assert.doesNotMatch(mutes, /payment_charged_ok/, 'compact decisions stay out of the mute file');

    // Compact decisions go to the compact CSV; intent JSON is written.
    assert.ok(existsSync(join(repo, 'pipelines', 'run', 'receive', 'compact', 'compact-cap.csv')));
    assert.ok(existsSync(join(repo, 'data', 'action-intent.json')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
