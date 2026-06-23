/**
 * configure_engine cap CSV emit: key-binding regression test.
 *
 * Bug shape (proven live on workflow wzwe4to8v): the cap CSV writer
 * previously emitted two row shapes:
 *   - <container>,<cap>::<reason>   (works — engine keys caps.csv by
 *                                    rateReceiverContainerField value,
 *                                    default k8s_container)
 *   - pat:<hash>,<cap>::<reason>    (dead bytes — no event has
 *                                    k8s_container=pat:<hash>, so the
 *                                    engine never matches these rows)
 *
 * The per-container action is folded into the single cap value
 * (`<container>,<bytes>:<action>:<reason>`); there is no separate
 * action-intent.json side-file. Per-PATTERN detail stays out of the CSV.
 *
 * This test locks in the fix:
 *   1. No `pat:` prefix rows in the emitted CSV.
 *   2. One container-keyed row per service container being configured.
 *   3. Service-name == container-name fallback (no snapshot) still
 *      produces a working container-keyed row.
 *   4. Per-pattern overrides (floor / non-default action) do NOT leak
 *      into caps.csv — they belong in action-intent.json (covered by
 *      action-intent-writer.test.ts; here we just assert their absence
 *      from the CSV).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCsvDiff,
  type PerPatternRow,
} from '../src/tools/configure-engine.js';

/**
 * Reconstruct the post-merge caps.csv body from the unified-diff string
 * returned by renderCsvDiff. The diff format is:
 *   --- a/caps.csv
 *   +++ b/caps.csv
 *   -<line removed from baseline>
 *   +<line added in after>
 * We collect the `+` additions (modulo the header marker) — that's the
 * set of rows that will be written into caps.csv post-merge.
 */
function additionsFromDiff(diff: string): string[] {
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

function makeRow(overrides: Partial<PerPatternRow>): PerPatternRow {
  return {
    pattern_hash: 'abc123',
    pattern: 'ERROR_sample_pattern_name',
    current_bytes_30d: 1_000_000,
    cap_bytes_per_window: 1024,
    action: 'compact',
    saved_bytes_monthly: 0,
    saved_dollars_monthly: 0,
    projected_monthly_usd_low: 0,
    projected_monthly_usd_expected: 0,
    projected_monthly_usd_high: 0,
    reason: 'default',
    ...overrides,
  };
}

test('renderCsvDiff: no pat:<hash> rows are ever emitted', () => {
  const rows: PerPatternRow[] = [
    makeRow({ pattern_hash: 'aaa', action: 'drop', reason: 'high volume' }),
    makeRow({
      pattern_hash: 'bbb',
      action: 'pass',
      floor_reason: 'audit floor',
    }),
    makeRow({
      pattern_hash: 'ccc',
      action: 'tier_down',
      reason: 'cheap tier',
    }),
    makeRow({ pattern_hash: 'ddd', action: 'offload', reason: 's3 cold' }),
  ];

  const diff = renderCsvDiff(
    ['opentelemetry-collector'],
    undefined,
    rows,
    'compact', // defaultAction
    new Map(), // actionByContainer: empty -> all fall back to defaultAction
    'hard',
    { targetPercent: 30, baselineMonthlyBytes: 100_000_000 }
  );

  const additions = additionsFromDiff(diff);
  // Even though some rows have a non-default action or a floor_reason
  // (the two conditions that previously triggered `pat:<hash>` emit),
  // ZERO pat:-prefixed rows should appear.
  const patRows = additions.filter((l) => l.startsWith('pat:'));
  assert.deepEqual(
    patRows,
    [],
    `cap CSV should not contain any pat:<hash> rows; got: ${patRows.join('\n')}`
  );
});

test('renderCsvDiff: one container-keyed row per configured container', () => {
  const rows: PerPatternRow[] = [
    makeRow({ pattern_hash: 'aaa', action: 'compact' }),
    makeRow({ pattern_hash: 'bbb', action: 'compact' }),
  ];

  const containers = ['opentelemetry-collector', 'frontend', 'cartservice'];

  const diff = renderCsvDiff(
    containers,
    undefined,
    rows,
    'compact',
    new Map(),
    'hard',
    { targetPercent: 30, baselineMonthlyBytes: 100_000_000 }
  );

  const additions = additionsFromDiff(diff);
  // Filter out preamble (`#` lines) and header (`container,cap`).
  const dataRows = additions.filter(
    (l) => l.length > 0 && !l.startsWith('#') && l !== 'container,cap'
  );

  assert.equal(
    dataRows.length,
    containers.length,
    `expected one row per container, got ${dataRows.length}: ${dataRows.join(' | ')}`
  );

  // Each container should appear as the row key.
  for (const c of containers) {
    const row = dataRows.find((r) => r.startsWith(`${c},`));
    assert.ok(
      row,
      `expected a row keyed by container "${c}"; got rows: ${dataRows.join(' | ')}`
    );
  }
});

test('renderCsvDiff: service-name==container-name fallback (no snapshot)', () => {
  // In the otel-demo cluster, the caller passes the service name as the
  // sole container value when no snapshot resolves an explicit mapping.
  // The emit should produce a working container-keyed row regardless.
  const rows: PerPatternRow[] = [
    makeRow({ pattern_hash: 'aaa', cap_bytes_per_window: 2048 }),
  ];

  const diff = renderCsvDiff(
    ['payment-service'], // service name used as container fallback
    undefined,
    rows,
    'compact',
    new Map(),
    'hard',
    { targetPercent: 30, baselineMonthlyBytes: 100_000_000 }
  );

  const additions = additionsFromDiff(diff);
  const paymentRow = additions.find((l) => l.startsWith('payment-service,'));
  assert.ok(
    paymentRow,
    `expected fallback container-keyed row for "payment-service"; got: ${additions.join(' | ')}`
  );
  // Sanity: the single-file row carries the cap AND the folded-in action.
  assert.match(
    paymentRow!,
    /^payment-service,\d+:compact:/,
    `expected "<container>,<bytes>:<action>:<reason>" shape; got: ${paymentRow}`
  );
});

test('renderCsvDiff: floor patterns do not leak into caps.csv', () => {
  // Previously a row with `floor_reason` triggered a pat:<hash> emit
  // even when the action matched the default. Verify both
  // floor-triggered and action-override conditions stay out of the CSV.
  const rows: PerPatternRow[] = [
    makeRow({
      pattern_hash: 'floor-hash',
      action: 'compact',
      floor_reason: 'signal floor: must keep',
    }),
    makeRow({
      pattern_hash: 'override-hash',
      action: 'drop',
      reason: 'high volume noise',
    }),
  ];

  const diff = renderCsvDiff(
    ['svc-a'],
    undefined,
    rows,
    'compact', // default; override-hash differs from this
    new Map(),
    'hard',
    { targetPercent: 30, baselineMonthlyBytes: 100_000_000 }
  );

  assert.ok(!diff.includes('pat:floor-hash'), 'floor row leaked into CSV');
  assert.ok(
    !diff.includes('pat:override-hash'),
    'action-override row leaked into CSV'
  );
  assert.ok(
    !diff.includes('floor-hash'),
    'pattern hash leaked into CSV (any form)'
  );
  assert.ok(
    !diff.includes('override-hash'),
    'pattern hash leaked into CSV (any form)'
  );
});

test('renderCsvDiff: each container gets its own action + cap = sum of its row caps', () => {
  // Phase-2 per-service advisory: cartservice compacts, frontend passes,
  // noisy-svc offloads. Each container's caps.csv row must reflect ITS OWN
  // action and a cap derived from ITS OWN rows, not a global average/action.
  const rows: PerPatternRow[] = [
    makeRow({ pattern_hash: 'a1', container: 'cartservice', cap_bytes_per_window: 100, action: 'compact' }),
    makeRow({ pattern_hash: 'a2', container: 'cartservice', cap_bytes_per_window: 50, action: 'pass' }),
    makeRow({ pattern_hash: 'b1', container: 'frontend', cap_bytes_per_window: 300, action: 'pass' }),
    makeRow({ pattern_hash: 'c1', container: 'noisy-svc', cap_bytes_per_window: 0, action: 'offload' }),
  ];
  const actionByContainer = new Map<string, PerPatternRow['action']>([
    ['cartservice', 'compact'],
    ['frontend', 'pass'],
    ['noisy-svc', 'offload'],
  ]);

  const diff = renderCsvDiff(
    ['cartservice', 'frontend', 'noisy-svc'],
    undefined,
    rows,
    'compact', // defaultAction (unused: every container has a decision)
    actionByContainer,
    'hard',
    { targetPercent: 30, baselineMonthlyBytes: 100_000_000 }
  );

  const dataRows = additionsFromDiff(diff).filter(
    (l) => l.length > 0 && !l.startsWith('#') && l !== 'container,cap'
  );
  const byKey: Record<string, string> = Object.fromEntries(
    dataRows.map((l) => {
      const i = l.indexOf(',');
      return [l.slice(0, i), l.slice(i + 1)];
    })
  );

  // cap = sum of that container's per-pattern caps (100+50 / 300); offload -> 0.
  assert.equal(byKey['cartservice'], '150:compact:MCP configure_engine (hard)');
  assert.equal(byKey['frontend'], '300:pass:MCP configure_engine (hard)');
  assert.equal(byKey['noisy-svc'], '0:offload:MCP configure_engine (hard)');
});

test('renderCsvDiff: undecided container falls back to defaultAction with its own cap sum', () => {
  const rows: PerPatternRow[] = [
    makeRow({ pattern_hash: 'd1', container: 'svc-x', cap_bytes_per_window: 70, action: 'sample' }),
    makeRow({ pattern_hash: 'd2', container: 'svc-x', cap_bytes_per_window: 30, action: 'sample' }),
  ];
  const diff = renderCsvDiff(
    ['svc-x'],
    undefined,
    rows,
    'sample', // defaultAction used because actionByContainer has no entry
    new Map(),
    'hard',
    { targetPercent: 30, baselineMonthlyBytes: 100_000_000 }
  );
  const row = additionsFromDiff(diff).find((l) => l.startsWith('svc-x,'));
  assert.equal(row, 'svc-x,100:sample:MCP configure_engine (hard)');
});
