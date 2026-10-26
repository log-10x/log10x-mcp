/**
 * The plan solver and the runs count what passes over a limit with the shipped
 * Receiver regulator's defaults. test/fixtures/engine/rate-config.yaml is a
 * verbatim copy of the config repo's pipelines/run/receive/rate/config.yaml;
 * the pin fails when the shipped file and the MCP's constants part.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keptOverCapLines, solvePlan, type SolverPattern } from '../src/lib/plan-solver.js';
import { ALWAYS_PASS_LINES, REGULATOR_WINDOW_SECONDS } from '../src/lib/report/user-units.js';
import { BASELINE_MAX_OVER_TOTAL_DEFAULT, ERROR_CLASS_LEVELS, KEEP_COUNT_DEFAULT, KEEP_MAX_OVER_TOTAL_DEFAULT } from '../src/lib/fleet-default-install.js';
import { servicePass, sharePastTotal } from '../src/lib/regulator-pass.js';

const yaml = readFileSync(join(process.cwd(), 'test', 'fixtures', 'engine', 'rate-config.yaml'), 'utf8');

function scalar(key: string): string {
  const m = new RegExp(`\\n  ${key}: (.+)\\n`).exec(yaml);
  assert.ok(m, `${key} not in the shipped config`);
  return m[1].replace(/#.*/, '').trim();
}

function levels(key: string): Record<string, number> {
  const m = new RegExp(`\\n  ${key}:\\n((?:    - .*\\n)+)`).exec(yaml);
  assert.ok(m, `${key} not in the shipped config`);
  return Object.fromEntries(
    m[1].trim().split('\n').map((l) => {
      const [k, v] = l.replace(/#.*/, '').trim().replace(/^- /, '').split('=');
      return [k.trim(), Number(v)];
    }),
  );
}

test('the solver\'s regulator constants are the shipped config\'s', () => {
  // No share guard and no random floor: a cap holds every pattern it is set for.
  assert.equal(Number(scalar('minSharePercent')), 0);
  assert.equal(Number(scalar('minRetentionThreshold')), 0);
  const floors = levels('severityFloors');
  assert.ok(Object.keys(floors).length >= 7);
  for (const [level, f] of Object.entries(floors)) assert.equal(f, 0, `${level} floor`);
  // The keep count: lines over the cap per pattern per window per node.
  const keep = levels('keepCounts');
  assert.deepEqual(Object.keys(keep).sort(), [...ERROR_CLASS_LEVELS].sort());
  for (const [level, k] of Object.entries(keep)) assert.equal(keptOverCapLines(level), k, level);
  for (const level of Object.keys(floors)) if (!(level in keep)) assert.equal(keptOverCapLines(level), 0, level);
  // Past a service's total: at most this many sample and keep-count lines per window per node.
  assert.equal(Number(scalar('baselineMaxOverTotal')), BASELINE_MAX_OVER_TOTAL_DEFAULT);
  assert.equal(Number(scalar('keepMaxOverTotal')), KEEP_MAX_OVER_TOTAL_DEFAULT);
  // The always-pass sample and the window it counts in.
  assert.equal(Number(scalar('baselineCount')), ALWAYS_PASS_LINES);
  const d = /^\$=parseDuration\("(\d+)([smh])"\)$/.exec(scalar('resetIntervalMs'));
  assert.ok(d, scalar('resetIntervalMs'));
  assert.equal(Number(d[1]) * { s: 1, m: 60, h: 3600 }[d[2] as 's' | 'm' | 'h'], REGULATOR_WINDOW_SECONDS);
});

const GB = 1_000_000_000;
const WINDOWS = (30 * 86_400) / 240;

/** One container, 100 GB a month, 500-byte lines: a WARN line kept as the cap, then 3%, 40% and 56% patterns. */
function checkout(): SolverPattern[] {
  const p = (hash: string, name: string, severity: string, gb: number): SolverPattern => ({
    hash, name, severity, services: { checkout: gb * GB }, bytes: gb * GB, avgEventBytes: 500,
  });
  return [
    p('w', 'retrying', 'WARN', 1),
    p('c', 'cache miss', 'INFO', 3),
    p('e', 'payment failed', 'ERROR', 40),
    p('r', 'request served', 'INFO', 56),
  ];
}

test('a 3% pattern moves its excess, an ERROR keeps 50 lines a window a node, an INFO keeps only the sample', () => {
  const pl = solvePlan(checkout(), {
    destination: 'cloudwatch',
    retrieverInstalled: false,
    targetPct: 99,
    unprotectPatterns: ['e'],
    nodesByContainer: { checkout: 3 },
  });
  const cap = Math.sqrt(1 * 3) * GB; // between `retrying` (kept) and `cache miss` (moved)
  assert.ok(Math.abs(pl.containerCaps.checkout.capBytesMonthly - cap) < 1);
  const moved = (h: string) => pl.planned.find((r) => r.hash === h)?.movedBytesMonthly;
  // 3% of its container, over the cap: planned, its whole excess moves (its sample sits under the cap).
  assert.ok(Math.abs(moved('c')! - (3 * GB - cap)) < 1);
  // ERROR: 50 lines over the cap each window on each of 3 nodes stay, not half the excess.
  assert.ok(Math.abs(moved('e')! - (40 * GB - cap - 50 * WINDOWS * 3 * 500)) < 1);
  assert.ok(moved('e')! > 0.9 * 40 * GB);
  // INFO: nothing over the cap stays.
  assert.ok(Math.abs(moved('r')! - (56 * GB - cap)) < 1);
  assert.equal(moved('w'), undefined, 'WARN stays protected');
});

test('under a cap of 0 an INFO pattern keeps its sample on every node, over the span given', () => {
  const cart: SolverPattern[] = [
    { hash: 'g', name: 'GetCartAsync', severity: 'INFO', services: { cart: 13 * GB }, bytes: 13 * GB, avgEventBytes: 1700 },
  ];
  const month = solvePlan(cart, { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 90 });
  assert.equal(month.containerCaps.cart.capBytesMonthly, 0);
  assert.ok(Math.abs(month.planned[0].movedBytesMonthly! - (13 * GB - 5 * WINDOWS * 1700)) < 1);
  const fourNodes = solvePlan(cart, { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 90, nodesByContainer: { cart: 4 } });
  assert.ok(Math.abs(fourNodes.planned[0].movedBytesMonthly! - (13 * GB - 5 * WINDOWS * 4 * 1700)) < 1);
  // An hour's capture: 15 windows.
  const hour = solvePlan(cart, { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 90, spanSeconds: 3600 });
  assert.ok(Math.abs(hour.planned[0].movedBytesMonthly! - (13 * GB - 5 * 15 * 1700)) < 1);
});

test('the plan states what stays over each cap and the node count it counted', () => {
  const unknown = solvePlan(checkout(), { destination: 'cloudwatch', retrieverInstalled: false, targetPct: 99, unprotectPatterns: ['e'] });
  const note = unknown.notes?.find((n) => n.startsWith('tier_down moves'));
  assert.ok(note, unknown.notes?.join(' | '));
  assert.match(note, /first 5 lines of each statement/);
  assert.match(note, /ERROR, CRITICAL or FATAL statement, 50 lines over the cap, every 4-minute window on each node/);
  assert.match(note, /Node count unknown for checkout: counted as one node/);
  const known = solvePlan(checkout(), {
    destination: 'cloudwatch', retrieverInstalled: false, targetPct: 99, unprotectPatterns: ['e'], nodesByContainer: { checkout: 3 },
  });
  assert.ok(!known.notes?.some((n) => /Node count unknown/.test(n)), known.notes?.join(' | '));
});

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

test('a bound past the total is shared evenly, no ask given more than it asked; 0 removes it', () => {
  assert.ok(Math.abs(sum(sharePastTotal(Array(1422).fill(50), 500)) - 500) < 1e-9);
  assert.deepEqual(sharePastTotal([50, 50, 50], 500), [50, 50, 50]);
  assert.deepEqual(sharePastTotal([2, 50, 50], 60), [2, 29, 29]);
  assert.deepEqual(sharePastTotal([-3, 20], 500), [0, 20]);
  assert.equal(sum(sharePastTotal(Array(1422).fill(50), 0)), 71_100);
});

/** One node, lines as the unit: n statements of `perWindow` lines a window, an hour of 15 windows. */
const W15 = 3600 / REGULATOR_WINDOW_SECONDS;
const burst = (n: number, perWindow: number, error: boolean) => Array.from({ length: n }, () => ({ rate: perWindow * W15, lines: perWindow * W15, error }));
const opts = { windowsPerHour: W15, nodes: 1, keepCount: KEEP_COUNT_DEFAULT };

test('the regulator gate burst: 1,422 new ERROR patterns of 7 lines under a total of 100 keep 100 + 50 + 500', () => {
  const sts = burst(1422, 7, true);
  // The per-statement limit that leaves the service a total of 100 lines a window.
  const level = (100 / 1422) * W15;
  const p = servicePass(sts, level, opts);
  assert.ok(Math.abs(p.total / W15 - 100) < 1e-9, String(p.total / W15));
  assert.ok(Math.abs(p.kept / W15 - 650) < 1e-9, String(p.kept / W15));
  // At no limit at all, the floor past the total: 50 sample and 500 keep-count lines, where 5 + 2 a statement kept 9,954.
  assert.ok(Math.abs(servicePass(sts, 0, opts).kept / W15 - 550) < 1e-9);
  // Three busy error statements: 15 sample and 150 keep-count lines.
  assert.ok(Math.abs(servicePass(burst(3, 1000, true), 0, opts).kept / W15 - 165) < 1e-9);
  // Sample lines past their bound take the keep count next: 100 ERROR patterns of 5 lines keep 50 + 450.
  assert.ok(Math.abs(servicePass(burst(100, 5, true), 0, opts).kept / W15 - 500) < 1e-9);
  // INFO patterns: the sample alone, at most 50.
  assert.ok(Math.abs(servicePass(burst(1422, 7, false), 0, opts).kept / W15 - 50) < 1e-9);
  assert.ok(Math.abs(servicePass(burst(3, 1000, false), 0, opts).kept / W15 - 15) < 1e-9);
});

test('the plan writes caps and no total, so each error pattern keeps its 50 over the cap with no service bound', () => {
  // 20 ERROR patterns in one container keep 1,000 lines a window a node over the cap, past the 500 a total would allow.
  const ps: SolverPattern[] = [
    { hash: 'w', name: 'retrying', severity: 'WARN', services: { burst: 1 * GB }, bytes: 1 * GB, avgEventBytes: 500 },
    ...Array.from({ length: 20 }, (_, i): SolverPattern => ({
      hash: `e${i}`, name: `migration ${i} failed`, severity: 'ERROR', services: { burst: 10 * GB }, bytes: 10 * GB, avgEventBytes: 500,
    })),
  ];
  const pl = solvePlan(ps, {
    destination: 'cloudwatch',
    retrieverInstalled: false,
    targetPct: 99,
    unprotectPatterns: ps.filter((p) => p.severity === 'ERROR').map((p) => p.hash),
    nodesByContainer: { burst: 2 },
  });
  const cap = pl.containerCaps.burst.capBytesMonthly;
  for (let i = 0; i < 20; i++) {
    const moved = pl.planned.find((r) => r.hash === `e${i}`)?.movedBytesMonthly;
    assert.ok(moved !== undefined && Math.abs(moved - (10 * GB - cap - 50 * WINDOWS * 2 * 500)) < 1, `e${i}: ${moved}`);
  }
});
