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
  assert.deepEqual(templateEnds('[KAFKA_PORT_$_TCP, tcp:////$.$.$.$:$5]'), { prefix: '[KAFKA_PORT_', suffix: ']', lines: 1 });
  assert.deepEqual(templateEnds('[KAFKA_PORT_$_TCP_PORT, $1]'), { prefix: '[KAFKA_PORT_', suffix: ']', lines: 1 });
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

test('three targets plan three different sets, and the caps follow the kept and moved patterns', () => {
  const at = (pct: number) => solvePlan(estate(), { destination: 'datadog', retrieverInstalled: false, targetPct: pct });
  const p20 = at(20);
  const p50 = at(50);
  const p70 = at(70);
  const names = (p: ReturnType<typeof at>) => p.planned.map((r) => r.name);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));
  // Each cap sits between the largest kept pattern and the smallest moved one, at their geometric mean.
  // An INFO pattern keeps only its always-pass sample over the cap, 5 lines a window on one node.
  // 20%: Traces and Logs over sqrt(18 x 44) = 28.14 GB, between Metrics (kept) and Logs (moved), a
  // margin of 1.56 each side: 46-28.14 + 44-28.14 = 33.7 of 134 = 25%.
  assert.deepEqual(names(p20), ['Traces', 'Logs']);
  assert.ok(near(p20.containerCaps.collector.capBytesMonthly, Math.sqrt(18 * 44) * GB));
  assert.equal(p20.containerCaps.collector.keptMaxPattern, 'Metrics');
  assert.equal(p20.containerCaps.collector.movedMinPattern, 'Logs');
  assert.ok(near(p20.containerCaps.collector.margin!, Math.sqrt(44 / 18)));
  assert.equal(Math.round(p20.achievedPct), 25);
  // 50%: Metrics joins; the cap is sqrt(4 x 18) = 8.49 GB, between the ERROR line and Metrics:
  // 46+44+18 - 3 x 8.49 = 82.5 of 134 = 62%. The cart hosts no planned pattern, so it gets no row.
  assert.deepEqual(names(p50), ['Traces', 'Logs', 'Metrics']);
  assert.ok(near(p50.containerCaps.collector.capBytesMonthly, Math.sqrt(4 * 18) * GB));
  assert.equal(p50.containerCaps.collector.keptMaxPattern, 'failed to upload');
  assert.equal(p50.containerCaps.cart, undefined);
  assert.equal(Math.round(p50.achievedPct), 62);
  // 70%: both cart patterns join and the cart's cap is 0 (1 byte on the wire), nothing separates,
  // and each keeps only its sample: 5 lines x 10,800 windows x 1,700 bytes = 0.09 GB, so
  // 13+9 - 2 x 0.09 = 21.8 moves; 104.4 of 134 = 78%.
  assert.deepEqual(names(p70), ['Traces', 'Logs', 'Metrics', 'GetCartAsync', 'AddItemAsync']);
  assert.equal(p70.containerCaps.cart.capBytesMonthly, 0);
  assert.equal(p70.containerCaps.cart.separated, false);
  assert.equal(Math.round(p70.achievedPct), 78);
  const sample = 5 * 10_800 * 1700;
  assert.ok(near(p70.planned.find((r) => r.name === 'AddItemAsync')!.movedBytesMonthly!, 9 * GB - sample));
  // The plan states what the engine moves, the excess over the cap; the sample sits under the cap.
  const traces50 = p50.planned.find((r) => r.name === 'Traces')!;
  assert.ok(near(traces50.movedBytesMonthly!, (46 - Math.sqrt(4 * 18)) * GB));
  assert.ok(near(traces50.perEventMove!.events_moved, ((46 - Math.sqrt(4 * 18)) * GB) / 1200));
});

test('two templates under one hash merge their event size weighted by events', () => {
  // 45 GB of 1,200-byte records and 1 GB of 120,000-byte ones: 37.5 M events and 8,333,
  // so the merged record is 46 GB / 37.51 M = 1,226 bytes, not the 60,600 of a plain mean.
  const patterns: SolverPattern[] = [
    { hash: 't', name: 'Traces', services: { collector: 45 * GB }, severity: 'INFO', bytes: 45 * GB, avgEventBytes: 1200 },
    { hash: 't', name: 'Traces', services: { collector: 1 * GB }, severity: 'INFO', bytes: 1 * GB, avgEventBytes: 120_000 },
    ...estate().slice(1),
  ];
  const plan = solvePlan(patterns, { destination: 'datadog', retrieverInstalled: false, targetPct: 50 });
  const traces = plan.planned.find((r) => r.name === 'Traces')!;
  const events = (45 * GB) / 1200 + (1 * GB) / 120_000;
  const avg = (46 * GB) / events;
  assert.ok(Math.abs(traces.perEventMove!.events_moved - traces.movedBytesMonthly! / avg) < 1);
  assert.ok(traces.perEventMove!.events_moved > 20_000_000);
});

test('the engine files carry the cap per window in the engine grammar, one row per container', () => {
  const p = solvePlan(estate(), { destination: 'datadog', retrieverInstalled: false, targetPct: 70 });
  const files = engineFilesFromContainerCaps(p.containerCaps, 36_000, 'plan datadog 70 pct: x,y');
  // collector: sqrt(4 x 18) = 8.49 GB over a 36,000 s span is 56,568,542 bytes per 240 s window;
  // the cart keeps nothing, so its cap is the 1-byte minimum.
  assert.equal(files.capsCsv, 'container,cap\ncart,1::plan datadog 70 pct; x;y\ncollector,56568542::plan datadog 70 pct; x;y\n');
  assert.equal(files.actionsCsv, 'container,action\ncart,tier_down::plan datadog 70 pct; x;y\ncollector,tier_down::plan datadog 70 pct; x;y\n');
  // offload acts on the whole container: the 1-byte minimum
  const off = engineFilesFromContainerCaps({ s3: { action: 'offload', capBytesMonthly: 0 } }, 36_000, 'r');
  assert.equal(off.capsCsv, 'container,cap\ns3,1::r\n');
});

test('configure_engine caps a tier_down container between its largest pass row and its smallest moved row, never at the sum', () => {
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
  // sqrt(12,000 x 30,000) = 18,974: the largest pass row can grow 1.6x, the smallest moved row is 1.6x above.
  assert.match(line!, /^\+api,18974::/);
});
