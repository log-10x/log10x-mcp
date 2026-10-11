/**
 * The plan the MCP writes must run on the engine as written: patterns bound to
 * their containers even when the engine drops lines, a tier_down cap that
 * scales with the target so different targets move different sets, and the
 * two files in the engine's own grammar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindRecordsToLines, templateEnds } from '../src/lib/pattern-extraction.js';
import { solvePlan, type SolverPattern } from '../src/lib/plan-solver.js';
import { engineFilesFromContainerCaps } from '../src/lib/report/build-report-data.js';
import { renderCsvDiff, type PerPatternRow } from '../src/tools/configure-engine.js';

const GB = 1_000_000_000;

test('templateEnds undoes the engine escaping and swallows timestamp slots', () => {
  assert.deepEqual(templateEnds('$(yyyy-MM-dd HH:mm:ss) INFO started $ workers'), { prefix: '', suffix: ' workers', lines: 1 });
  assert.deepEqual(templateEnds('ghcr.io//demo:$.$ pulled'), { prefix: 'ghcr.io/demo:', suffix: ' pulled', lines: 1 });
  assert.deepEqual(templateEnds('price /$ $'), { prefix: 'price $ ', suffix: '', lines: 1 });
  assert.deepEqual(templateEnds('no slots at all'), { prefix: 'no slots at all', suffix: 'no slots at all', lines: 1 });
  assert.equal(templateEnds('Caused by: $\n\tat $').lines, 2);
});

test('binding re-synchronises on template ends where the engine dropped a line', () => {
  const templates = new Map([
    ['A', { template: 'user $ logged in' }],
    ['B', { template: 'order $ shipped' }],
    ['C', { template: 'Caused by: $\n\tat $' }],
  ]);
  const lines = [
    'user 1 logged in',
    '',                       // dropped by the engine: no record comes back for it
    'order 7 shipped',
    'Caused by: boom',
    '\tat com.x.Y',
    'user 2 logged in',
  ];
  const records = [{ templateHash: 'A' }, { templateHash: 'B' }, { templateHash: 'C' }, { templateHash: 'A' }];
  const b = bindRecordsToLines(records, templates, lines);
  assert.deepEqual(b.head, [0, 2, 3, 5]);
  assert.equal(b.bound, 4);
  assert.equal(b.resyncs, 1);
  assert.equal(b.unbound, 0);
});

test('a record whose ends match nothing nearby stays unbound and the walk moves on by its span', () => {
  const templates = new Map([['A', { template: 'user $ logged in' }], ['Z', { template: 'zzz $ zzz' }]]);
  const lines = ['user 1 logged in', 'a line the template does not describe', 'user 2 logged in'];
  const b = bindRecordsToLines([{ templateHash: 'A' }, { templateHash: 'Z' }, { templateHash: 'A' }], templates, lines);
  assert.deepEqual(b.head, [0, undefined, 2]);
  assert.equal(b.unbound, 1);
});

function estate(): SolverPattern[] {
  // Two containers. The collector's three big INFO patterns, its ERROR line
  // (kept, and the cap once the INFO ones are planned) and the cart's two.
  return [
    { hash: 't', name: 'Traces', services: { collector: 46 * GB }, severity: 'INFO', bytes: 46 * GB, avgEventBytes: 1200 },
    { hash: 'l', name: 'Logs', services: { collector: 44 * GB }, severity: 'INFO', bytes: 44 * GB, avgEventBytes: 1200 },
    { hash: 'm', name: 'Metrics', services: { collector: 18 * GB }, severity: 'INFO', bytes: 18 * GB, avgEventBytes: 1200 },
    { hash: 'f', name: 'failed to upload', services: { collector: 4 * GB }, severity: 'ERROR', bytes: 4 * GB, avgEventBytes: 1000 },
    { hash: 'g', name: 'GetCartAsync', services: { cart: 13 * GB }, severity: 'INFO', bytes: 13 * GB, avgEventBytes: 1700 },
    { hash: 'a', name: 'AddItemAsync', services: { cart: 9 * GB }, severity: 'INFO', bytes: 9 * GB, avgEventBytes: 1700 },
  ];
}

test('three targets plan three different sets, and the caps follow the kept patterns', () => {
  const at = (pct: number) => solvePlan(estate(), { destination: 'datadog', retrieverInstalled: false, targetPct: pct });
  const p30 = at(30);
  const p50 = at(50);
  const p70 = at(70);
  const names = (p: ReturnType<typeof at>) => p.planned.map((r) => r.name);
  // 30%: Traces and Logs over the cap Metrics sets: (46-18 + 44-18) x 0.9 = 48.6 of 134 = 36%.
  assert.deepEqual(names(p30), ['Traces', 'Logs']);
  assert.equal(p30.containerCaps.collector.capBytesMonthly, 18 * GB);
  assert.equal(p30.containerCaps.collector.keptMaxPattern, 'Metrics');
  assert.equal(Math.round(p30.achievedPct), 36);
  // 50%: Metrics joins and the cap drops to the ERROR line: (42+40+14) x 0.9 = 86.4 of 134 = 64%.
  // The cart hosts no planned pattern, so it gets no row.
  assert.deepEqual(names(p50), ['Traces', 'Logs', 'Metrics']);
  assert.equal(p50.containerCaps.collector.capBytesMonthly, 4 * GB);
  assert.equal(p50.containerCaps.collector.keptMaxPattern, 'failed to upload');
  assert.equal(p50.containerCaps.cart, undefined);
  assert.equal(Math.round(p50.achievedPct), 64);
  // 70%: GetCartAsync over AddItemAsync moves 4 x 0.9 = 3.6, still short, so AddItemAsync joins
  // and the cart has nothing kept: its cap is 0 (1 byte on the wire) and (13+9) x 0.9 = 19.8 moves;
  // 106 of 134 = 79%.
  assert.deepEqual(names(p70), ['Traces', 'Logs', 'Metrics', 'GetCartAsync', 'AddItemAsync']);
  assert.equal(p70.containerCaps.cart.capBytesMonthly, 0);
  assert.equal(Math.round(p70.achievedPct), 79);
  // The plan states what the engine moves, the excess over the cap less the floor.
  const traces50 = p50.planned.find((r) => r.name === 'Traces')!;
  assert.equal(traces50.movedBytesMonthly, (46 - 4) * GB * 0.9);
  assert.equal(traces50.perEventMove!.events_moved, ((46 - 4) * GB * 0.9) / 1200);
});

test('the engine files carry the cap per window in the engine grammar, one row per container', () => {
  const p = solvePlan(estate(), { destination: 'datadog', retrieverInstalled: false, targetPct: 70 });
  const files = engineFilesFromContainerCaps(p.containerCaps, 36_000, 'plan datadog 70 pct: x,y');
  // collector: 4 GB over a 36,000 s span is 26,666,667 bytes per 240 s window; the cart keeps
  // nothing, so its cap is the 1-byte minimum.
  assert.equal(files.capsCsv, 'container,cap\ncart,1::plan datadog 70 pct; x;y\ncollector,26666667::plan datadog 70 pct; x;y\n');
  assert.equal(files.actionsCsv, 'container,action\ncart,tier_down::plan datadog 70 pct; x;y\ncollector,tier_down::plan datadog 70 pct; x;y\n');
  // offload acts on the whole container: the 1-byte minimum
  const off = engineFilesFromContainerCaps({ s3: { action: 'offload', capBytesMonthly: 0 } }, 36_000, 'r');
  assert.equal(off.capsCsv, 'container,cap\ns3,1::r\n');
});

test('configure_engine caps a tier_down container at its largest pass row, never at the sum', () => {
  const row = (over: Partial<PerPatternRow>): PerPatternRow => ({
    pattern_hash: 'h', pattern: 'p', current_bytes_30d: 0, cap_bytes_per_window: 0, action: 'pass',
    container: 'api', saved_bytes_monthly: 0, saved_dollars_monthly: 0,
    projected_monthly_usd_low: 0, projected_monthly_usd_expected: 0, projected_monthly_usd_high: 0, reason: '',
    ...over,
  });
  const rows = [
    row({ pattern_hash: 'a', action: 'tier_down', cap_bytes_per_window: 50_000 }),
    row({ pattern_hash: 'b', action: 'tier_down', cap_bytes_per_window: 30_000 }),
    row({ pattern_hash: 'c', action: 'pass', cap_bytes_per_window: 12_000 }),
    row({ pattern_hash: 'd', action: 'pass', cap_bytes_per_window: 7_000 }),
  ];
  // renderCsvDiff returns a unified diff of the file; the new row is its `+` line.
  const diff = renderCsvDiff(['api'], undefined, rows, 'tier_down', new Map([['api', 'tier_down']]), 'soft');
  const line = diff.split('\n').find((l) => l.startsWith('+api,'));
  assert.ok(line, diff);
  assert.match(line!, /^\+api,12000::/);
});
