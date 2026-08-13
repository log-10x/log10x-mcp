/**
 * configure_engine engine-file emit: grammar + key-binding contract tests.
 *
 * ENGINE CONTRACT (rate-object-cap.js / rate-object-lookup-cap.js, verified
 * live against the shipped regulator — see test/fixtures/coralogix-e2e):
 *
 *   caps.csv     <container>,<bytes>[:<untilEpochSec>][:<reason>]
 *                — keyed by rateReceiverContainerField (k8s_container).
 *                  The second field is an EXPIRY EPOCH, never an action.
 *                  A cap of 0 is a per-container regulator OPT-OUT (the
 *                  engine falls back to the fleet absoluteCap and regulates
 *                  nothing), so every written row carries a cap >= 1.
 *   actions.csv  <container>,<action>[:<untilEpochSec>][:<reason>]
 *                — the ONLY place the engine reads the over-cap action.
 *                  A service with no row defaults to hard `drop`, and a
 *                  missing/empty file fails the receiver launch when the
 *                  cap variant is active.
 *
 * This test pins:
 *   1. No `pat:` prefix rows in caps.csv (dead bytes — no event has
 *      k8s_container=pat:<hash>).
 *   2. One container-keyed row per configured container, in both files.
 *   3. Service-name == container-name fallback (no snapshot) still
 *      produces a working container-keyed row.
 *   4. Cap values are `<bytes>::<reason>` — no action token in the epoch
 *      slot, no zero caps.
 *   5. actions.csv carries the per-service action, merges over existing
 *      rows, and is never empty.
 *   6. Per-pattern overrides (floor / non-default action) do NOT leak
 *      into caps.csv — they belong in action-intent.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCsvDiff,
  renderActionsCsv,
  mergeActionRows,
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
  // Engine grammar: bytes, EMPTY epoch slot, reason. An action token in the
  // second field would land in the engine's untilEpochSec parse and the
  // action itself would silently never ship.
  assert.match(
    paymentRow!,
    /^payment-service,\d+::/,
    `expected "<container>,<bytes>::<reason>" engine shape; got: ${paymentRow}`
  );
});

test('renderCsvDiff: engine grammar — no action token in the epoch slot, no zero caps', () => {
  const rows: PerPatternRow[] = [
    makeRow({ pattern_hash: 'aaa', action: 'compact', container: 'svc-compact' }),
    makeRow({ pattern_hash: 'bbb', action: 'offload', container: 'svc-offload', cap_bytes_per_window: 0 }),
    makeRow({ pattern_hash: 'ccc', action: 'drop', container: 'svc-drop', cap_bytes_per_window: 0 }),
  ];
  const actionByContainer = new Map<string, PerPatternRow['action']>([
    ['svc-compact', 'compact'],
    ['svc-offload', 'offload'],
    ['svc-drop', 'drop'],
  ]);
  const diff = renderCsvDiff(
    ['svc-compact', 'svc-offload', 'svc-drop'],
    undefined,
    rows,
    'compact',
    actionByContainer,
    'hard',
    { targetPercent: 30, baselineMonthlyBytes: 100_000_000 }
  );
  const dataRows = additionsFromDiff(diff).filter(
    (l) => l.length > 0 && !l.startsWith('#') && l !== 'container,cap'
  );
  const ACTIONS = ['pass', 'sample', 'compact', 'tier_down', 'offload', 'drop'];
  for (const r of dataRows) {
    const m = r.match(/^([^,]+),(\d+):([^:]*):/);
    assert.ok(m, `row must parse as <container>,<bytes>:<epoch>:<reason>; got: ${r}`);
    assert.ok(Number(m![2]) >= 1, `cap must be >= 1 (0 is an engine opt-out); got: ${r}`);
    assert.ok(
      !ACTIONS.includes(m![3]),
      `epoch slot must never carry an action token; got: ${r}`
    );
    assert.equal(m![3], '', `epoch slot must be empty (no expiry); got: ${r}`);
  }
  // offload/drop containers get the 1-byte minimum, not 0.
  assert.match(dataRows.find((r) => r.startsWith('svc-offload,'))!, /^svc-offload,1::/);
  assert.match(dataRows.find((r) => r.startsWith('svc-drop,'))!, /^svc-drop,1::/);
});

test('renderActionsCsv: per-service actions in engine grammar, merged, never empty', () => {
  const actionByContainer = new Map<string, PerPatternRow['action']>([
    ['svc-a', 'compact'],
    ['svc-b', 'offload'],
  ]);
  const existing = 'container,action\nsvc-other,tier_down::operator pin\n';
  const csv = renderActionsCsv(['svc-a', 'svc-b'], actionByContainer, 'compact', existing, 'hard');

  assert.match(csv, /^container,action\n/, 'header row present');
  assert.match(csv, /^svc-a,compact::/m, 'svc-a action row');
  assert.match(csv, /^svc-b,offload::/m, 'svc-b action row');
  // Rows for services outside this run SURVIVE the merge.
  assert.match(csv, /^svc-other,tier_down::/m, 'existing row survives');
  // A configured container with no per-service decision takes the default.
  const withDefault = renderActionsCsv(['svc-c'], new Map(), 'tier_down', undefined, 'soft');
  assert.match(withDefault, /^svc-c,tier_down::/m, 'default action row');
  // Never empty: header + at least one row (an empty actions.csv fails the
  // receiver launch when the cap variant is active).
  assert.ok(withDefault.trim().split('\n').length >= 2, 'never header-only');
});

test('mergeActionRows: configured rows win, others survive', () => {
  const existing = 'container,action\nsvc-a,drop::old\nsvc-keep,pass::pin\n';
  const fresh = 'container,action\nsvc-a,compact::new\n';
  const merged = mergeActionRows(existing, fresh);
  assert.match(merged, /^svc-a,compact::new$/m, 'new row wins');
  assert.match(merged, /^svc-keep,pass::pin$/m, 'unrelated row survives');
  assert.doesNotMatch(merged, /svc-a,drop/, 'stale row replaced');
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

  // cap = sum of that container's per-pattern caps (100+50 / 300). The
  // action ships in actions.csv, never in the cap value; offload gets the
  // 1-byte minimum, not 0 (0 is an engine opt-out).
  assert.equal(byKey['cartservice'], '150::MCP configure_engine (hard)');
  assert.equal(byKey['frontend'], '300::MCP configure_engine (hard)');
  assert.equal(byKey['noisy-svc'], '1::MCP configure_engine (hard)');

  // The per-service actions land in the sibling actions.csv.
  const actionsCsv = renderActionsCsv(
    ['cartservice', 'frontend', 'noisy-svc'],
    actionByContainer,
    'compact',
    undefined,
    'hard'
  );
  assert.match(actionsCsv, /^cartservice,compact::/m);
  assert.match(actionsCsv, /^frontend,pass::/m);
  assert.match(actionsCsv, /^noisy-svc,offload::/m);
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
  assert.equal(row, 'svc-x,100::MCP configure_engine (hard)');
  // The fallback action reaches actions.csv via defaultAction.
  const actionsCsv = renderActionsCsv(['svc-x'], new Map(), 'sample', undefined, 'hard');
  assert.match(actionsCsv, /^svc-x,sample::/m);
});
