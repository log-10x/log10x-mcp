/**
 * deriveActionsCsv acceptance test.
 *
 * `actions.csv` is the engine's per-SERVICE action-routing file (header
 * `container,action`, ONE row per service). The receiver reads it keyed by
 * k8s container (== the service) and stamps `route(<action>)` on that
 * service's regulator-excess slice. It is derived from the SAME per-pattern
 * action-intent entries that feed `action-intent.json`.
 *
 * Scenarios:
 *   1. Grouping — multiple patterns per service collapse to one row;
 *      header is `container,action`; rows are sorted by service.
 *   2. Mode rule — the most frequent action among a service's patterns wins.
 *   3. Aggressive tie-break — on an even frequency split the more aggressive
 *      action wins (drop > offload > tier_down > compact > sample > pass).
 *   4. Empty-service entries are skipped (engine keys by container).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveActionsCsv,
  buildActionIntentEntries,
} from '../src/lib/action-intent-writer.js';
import type { Action } from '../src/lib/cost.js';

function entries(
  rows: Array<{ pattern_hash: string; service: string; action: Action }>,
) {
  return buildActionIntentEntries(rows);
}

function parseRows(csv: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of csv.trim().split('\n')) {
    if (line === 'container,action') continue;
    const [c, a] = line.split(',');
    out.set(c, a);
  }
  return out;
}

test('deriveActionsCsv: header + one row per service, sorted by service', () => {
  const csv = deriveActionsCsv(
    entries([
      { pattern_hash: 'h1', service: 'payment', action: 'offload' },
      { pattern_hash: 'h2', service: 'frontend', action: 'compact' },
      { pattern_hash: 'h3', service: 'frontend', action: 'compact' },
      { pattern_hash: 'h4', service: 'checkout', action: 'drop' },
    ]),
  );
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'container,action');
  // Three distinct services → three rows, sorted ascending.
  assert.deepEqual(lines.slice(1), [
    'checkout,drop',
    'frontend,compact',
    'payment,offload',
  ]);
  // Trailing newline present (matches writeActionIntent convention).
  assert.ok(csv.endsWith('\n'));
});

test('deriveActionsCsv: per-service MODE (most frequent action wins)', () => {
  // frontend: compact ×3, sample ×1 → compact.
  // api: pass ×1, sample ×2 → sample.
  const csv = deriveActionsCsv(
    entries([
      { pattern_hash: 'a', service: 'frontend', action: 'compact' },
      { pattern_hash: 'b', service: 'frontend', action: 'compact' },
      { pattern_hash: 'c', service: 'frontend', action: 'compact' },
      { pattern_hash: 'd', service: 'frontend', action: 'sample' },
      { pattern_hash: 'e', service: 'api', action: 'pass' },
      { pattern_hash: 'f', service: 'api', action: 'sample' },
      { pattern_hash: 'g', service: 'api', action: 'sample' },
    ]),
  );
  const rows = parseRows(csv);
  assert.equal(rows.get('frontend'), 'compact');
  assert.equal(rows.get('api'), 'sample');
});

test('deriveActionsCsv: tie-break picks the MOST AGGRESSIVE action', () => {
  // Even 1-1 splits across the full aggression ladder. Each pair should
  // resolve to the more aggressive member:
  //   drop vs offload    → drop
  //   offload vs tier_down → offload
  //   tier_down vs compact → tier_down
  //   compact vs sample    → compact
  //   sample vs pass       → sample
  const csv = deriveActionsCsv(
    entries([
      { pattern_hash: '1', service: 's_drop', action: 'drop' },
      { pattern_hash: '2', service: 's_drop', action: 'offload' },
      { pattern_hash: '3', service: 's_offload', action: 'offload' },
      { pattern_hash: '4', service: 's_offload', action: 'tier_down' },
      { pattern_hash: '5', service: 's_tier', action: 'tier_down' },
      { pattern_hash: '6', service: 's_tier', action: 'compact' },
      { pattern_hash: '7', service: 's_compact', action: 'compact' },
      { pattern_hash: '8', service: 's_compact', action: 'sample' },
      { pattern_hash: '9', service: 's_sample', action: 'sample' },
      { pattern_hash: '10', service: 's_sample', action: 'pass' },
    ]),
  );
  const rows = parseRows(csv);
  assert.equal(rows.get('s_drop'), 'drop');
  assert.equal(rows.get('s_offload'), 'offload');
  assert.equal(rows.get('s_tier'), 'tier_down');
  assert.equal(rows.get('s_compact'), 'compact');
  assert.equal(rows.get('s_sample'), 'sample');
});

test('deriveActionsCsv: mode beats aggression (frequency wins over the ladder)', () => {
  // pass ×3 vs drop ×1 — the mode (pass) wins even though drop is more
  // aggressive. The aggression order is only a tie-break, not an override.
  const csv = deriveActionsCsv(
    entries([
      { pattern_hash: 'a', service: 'svc', action: 'pass' },
      { pattern_hash: 'b', service: 'svc', action: 'pass' },
      { pattern_hash: 'c', service: 'svc', action: 'pass' },
      { pattern_hash: 'd', service: 'svc', action: 'drop' },
    ]),
  );
  assert.equal(parseRows(csv).get('svc'), 'pass');
});

test('deriveActionsCsv: entries with empty service are skipped', () => {
  const csv = deriveActionsCsv(
    entries([
      { pattern_hash: 'a', service: '', action: 'drop' },
      { pattern_hash: 'b', service: 'frontend', action: 'compact' },
    ]),
  );
  const lines = csv.trim().split('\n');
  assert.deepEqual(lines, ['container,action', 'frontend,compact']);
});

test('deriveActionsCsv: no entries → header only', () => {
  const csv = deriveActionsCsv([]);
  assert.equal(csv, 'container,action\n');
});
