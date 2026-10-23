/**
 * The rows run: rows written into a ClickHouse logs table held at a rate an hour.
 * The reads go through a fake ClickHouse and a fake Prometheus that answer the exact
 * queries the run sends; the plan is checked against the arithmetic it states (the
 * table takes at most R an hour at the limits, down to the always-pass floor).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePolicyYaml, PolicyLoadError } from '../src/lib/policy-loader.js';
import { emitPolicyYaml, emitK8sBudgetCronJob, emitGitHubActions, isBudgetRun, scheduleOf } from '../src/lib/scheduler-manifest-emitter.js';
import { chCredsFromEnv, planRows, readRowsInputs, splitTable, renderRowsReport, type ChQuery, type RowsReads } from '../src/lib/clickhouse-rows-tick.js';
import { renderBudgetFiles } from '../src/lib/budget-tick.js';
import { receiverFleetValues } from '../src/lib/fleet-default-install.js';
import { ALWAYS_PASS_LINES, REGULATOR_WINDOW_SECONDS } from '../src/lib/report/user-units.js';
import type { CustomerMetricsBackend } from '../src/lib/customer-metrics.js';

const NOW = 1_792_660_000;
const HOUR_START = Math.floor(NOW / 3600) * 3600;
const WINDOWS = 3600 / REGULATOR_WINDOW_SECONDS;

function policyText(extra: string, plane = '  delivery: configmap\n  namespace: logging'): string {
  return ['schema_version: "1.0"', 'reduction:', '  target_services: []', extra, '  exceptions: []', 'config_plane:', '  repo: /tmp/x', plane, ''].join('\n');
}

test('policy: rows_per_hour as a number or auto, alone, offload only', () => {
  const p = parsePolicyYaml(policyText('  rows_per_hour: 120000'));
  assert.equal(p.rows?.rows_per_hour, 120000);
  assert.equal(p.rows?.table, 'default.otel_logs');
  assert.equal(p.rows?.container_label, 'k8s_container');
  assert.equal(p.rows?.default_action, 'offload');
  assert.equal(p.rows?.keep_count, 50);
  assert.equal(p.config_plane.delivery, 'configmap');
  const a = parsePolicyYaml(policyText('  rows_per_hour: auto\n  clickhouse_table: logs.otel_logs\n  clickhouse_cluster: default'));
  assert.equal(a.rows?.rows_per_hour, undefined);
  assert.equal(a.rows?.table, 'logs.otel_logs');
  assert.equal(a.rows?.cluster, 'default');
  assert.throws(() => parsePolicyYaml(policyText('  rows_per_hour: many')), PolicyLoadError);
  assert.throws(() => parsePolicyYaml(policyText('  rows_per_hour: 10\n  budget_usd_monthly: 5000\n  standard_indexes:\n    - main')), /different goals/);
  assert.throws(() => parsePolicyYaml(policyText('  rows_per_hour: 10\n  target_percent: 30')), /different goals/);
  assert.throws(() => parsePolicyYaml(policyText('  rows_per_hour: 10\n  default_action: tier_down')), /no ClickHouse route/);
  assert.throws(() => parsePolicyYaml(policyText('  rows_per_hour: 10\n  service_actions:\n    kafka: tier_down')), /no ClickHouse route/);
  assert.throws(() => parsePolicyYaml(policyText('  rows_per_hour: 10\n  clickhouse_table: otel_logs')), /database.table/);
});

test('setup writes a rows policy the loader reads, hourly, with ClickHouse and Prometheus credentials', () => {
  for (const scheduler of ['k8s_cron', 'github_actions'] as const) {
    const opts = { target_services: [], target_percent: 30, scheduler, config_plane: '/tmp/repo', exceptions: [], min_delta_pp: 2, rows_per_hour: 'auto' as const };
    assert.ok(isBudgetRun(opts));
    assert.equal(scheduleOf(opts), 'hourly');
    const y = emitPolicyYaml(opts);
    const p = parsePolicyYaml(y);
    assert.ok(p.rows, scheduler);
    assert.equal(p.rows?.rows_per_hour, undefined);
    assert.equal(p.rows?.table, 'default.otel_logs');
    assert.equal(p.cron_utc, '0 * * * *');
    assert.equal(p.config_plane.delivery, scheduler === 'k8s_cron' ? 'configmap' : 'gitops');
    const manifest = scheduler === 'k8s_cron' ? emitK8sBudgetCronJob(opts) : emitGitHubActions(opts);
    assert.match(manifest, /CLICKHOUSE_URL/);
    assert.match(manifest, /LOG10X_CUSTOMER_METRICS_URL/);
    assert.doesNotMatch(manifest, /DD_API_KEY/);
  }
  const fixed = emitPolicyYaml({ target_services: [], target_percent: 30, scheduler: 'k8s_cron', config_plane: '/tmp/repo', exceptions: [], min_delta_pp: 2, rows_per_hour: 500000, clickhouse_table: 'logs.otel_logs' });
  assert.equal(parsePolicyYaml(fixed).rows?.rows_per_hour, 500000);
  assert.equal(parsePolicyYaml(fixed).rows?.table, 'logs.otel_logs');
});

test('a ClickHouse Receiver for the rows run counts lines and stamps the hash', () => {
  const v = receiverFleetValues({ datadog: false, clickhouseRows: true, engineVersion: '1.1.147' });
  assert.deepEqual(v.options.find(([k]) => k === 'rateReceiverUnit'), ['rateReceiverUnit', 'events']);
  assert.deepEqual(v.options.find(([k]) => k === 'symbolMessageHashField'), ['symbolMessageHashField', 'tenx_hash']);
  const old = receiverFleetValues({ datadog: false, clickhouseRows: true, unit: 'events', engineVersion: '1.1.140' });
  assert.equal(old.options.find(([k]) => k === 'rateReceiverUnit'), undefined);
  assert.ok(old.notes.some((n) => n.includes('rateReceiverUnit events')));
});

test('credentials from the environment: the key, or user and password', () => {
  assert.equal(chCredsFromEnv({}), undefined);
  assert.deepEqual(chCredsFromEnv({ CLICKHOUSE_URL: 'https://h:8443', CLICKHOUSE_API_KEY: 'k' }), { url: 'https://h:8443', username: 'default', password: 'k' });
  assert.deepEqual(chCredsFromEnv({ CLICKHOUSE_URL: 'http://h:8123', CLICKHOUSE_USER: 'u', CLICKHOUSE_PASSWORD: 'p' }), { url: 'http://h:8123', username: 'u', password: 'p' });
  assert.equal(chCredsFromEnv({ CLICKHOUSE_URL: 'http://h:8123' }), undefined);
  assert.deepEqual(splitTable('default.otel_logs'), { db: 'default', tbl: 'otel_logs' });
  assert.throws(() => splitTable('otel_logs'), /database.table/);
  assert.throws(() => splitTable("default.otel_logs'; DROP"), /database.table/);
});

/** A ClickHouse that wrote `byHour` rows per complete hour, and a Prometheus with these statements. */
function fakes(byHour: number[], statements: Array<{ c: string; h: string; sev?: string; route?: string; lines: number }>) {
  const sql: string[] = [];
  const ch: ChQuery = async (q) => {
    sql.push(q);
    if (q.includes('system.part_log')) {
      assert.match(q, /event_type = 'NewPart'/);
      assert.match(q, /database = 'default' AND table = 'otel_logs'/);
      assert.match(q, new RegExp(`event_time < toDateTime\\(${HOUR_START}\\)`));
      return byHour.map((r, i) => `${HOUR_START - (byHour.length - i) * 3600}\t${r}`).join('\n') + '\n';
    }
    if (q.includes('system.parts')) return '424242\n';
    throw new Error(`unexpected SQL: ${q}`);
  };
  const promql: string[] = [];
  const prom = {
    backendType: 'mock',
    endpoint: 'mock',
    async queryInstant(q: string) {
      promql.push(q);
      return {
        status: 'success',
        data: {
          resultType: 'vector',
          result: statements.map((s) => ({
            metric: { k8s_container: s.c, tenx_hash: s.h, message_pattern: `p_${s.h}`, severity_level: s.sev ?? 'INFO', routeState: s.route ?? 'pass' },
            value: [HOUR_START, String(s.lines)] as [number, string],
          })),
        },
      };
    },
    async queryRange() {
      throw new Error('not used');
    },
    async listLabels() {
      return [];
    },
    async listLabelValues() {
      return [];
    },
    remoteWriteUrl() {
      return undefined;
    },
  } as unknown as CustomerMetricsBackend;
  return { ch, prom, sql, promql };
}

test('reads: the meter is part_log NewPart rows in the last complete hour, by event time; the rates come from the Receiver', async () => {
  const rows = parsePolicyYaml(policyText('  rows_per_hour: 1000\n  clickhouse_cluster: default')).rows!;
  const f = fakes([900, 1200], [
    { c: 'kafka', h: 'aaa', lines: 700 },
    { c: 'kafka', h: 'bbb', sev: 'ERROR', lines: 100 },
    { c: 'cart', h: 'ccc', lines: 200 },
    { c: 'cart', h: 'ccc', route: 'offload', lines: 300 },
  ]);
  const r = await readRowsInputs(NOW, rows, f.ch, f.prom, 'edge');
  assert.equal(r.rowsLastHour, 1200);
  assert.deepEqual(r.rowsByHour.map((x) => x.rows), [900, 1200]);
  assert.equal(r.activeRows, 424242);
  assert.equal(r.passLinesPerHour, 1000);
  assert.equal(r.offloadLinesPerHour, 300);
  assert.equal(r.statements.length, 4);
  assert.match(f.sql[0], /clusterAllReplicas\('default', system\.part_log\)/);
  assert.match(f.promql[0], /sum by \(k8s_container, tenx_hash, message_pattern, severity_level, routeState\)/);
  assert.match(f.promql[0], /clamp_min\(all_events_summaryVolume_total\{tenx_env="edge"\} @ \d+ - \(all_events_summaryVolume_total\{tenx_env="edge"\} @ \d+ or /);
});

test('reads: a 10-minute meter window on a time-scaled rig reads as a rate an hour', async () => {
  const rows = parsePolicyYaml(policyText('  rows_per_hour: 1000\n  meter_minutes: 10')).rows!;
  assert.equal(rows.meter_minutes, 10);
  const W = Math.floor(NOW / 600) * 600;
  const sql: string[] = [];
  const ch: ChQuery = async (q) => {
    sql.push(q);
    if (q.includes('system.part_log')) return `${W - 600}\t150\n`;
    return '7\n';
  };
  const f = fakes([], [{ c: 'kafka', h: 'aaa', lines: 100 }]);
  const r = await readRowsInputs(NOW, rows, ch, f.prom);
  assert.equal(r.rowsLastHour, 900);
  assert.equal(r.statements[0]?.linesPerHour, 600);
  assert.match(sql[0], /intDiv\(toUnixTimestamp\(event_time\), 600\) \* 600/);
  assert.match(f.promql[0], new RegExp(`@ ${W} - \\(all_events_summaryVolume_total @ ${W - 600} or `));
  assert.throws(() => parsePolicyYaml(policyText('  rows_per_hour: 1000\n  meter_minutes: 7')), /dividing 60/);
});

function reads(W: number, pass: number, statements: RowsReads['statements']): RowsReads {
  return { table: 'default.otel_logs', rowsLastHour: W, rowsByHour: [{ hourStartSec: HOUR_START - 3600, rows: W }], activeRows: 10 * W, passLinesPerHour: pass, offloadLinesPerHour: 0, statements, queries: [] };
}
const st = (c: string, h: string, lines: number, sev = 'INFO') => ({ container: c, hash: h, pattern: `p_${h}`, severity: sev, route: 'pass', linesPerHour: lines });

test('plan: the rate binds, the floor is subtracted, and the table takes at most R an hour', () => {
  const rows = parsePolicyYaml(policyText('  rows_per_hour: 6000\n  outside_rows_per_hour: 1000')).rows!;
  // W 8000 last hour; 1000 rows an hour come from another writer, the Receiver passed 7000.
  const rd = reads(8000, 7000, [st('kafka', 'k1', 4000), st('kafka', 'k2', 2000), st('cart', 'c1', 1000)]);
  const plan = planRows({ rows, reads: rd, instances: { kafka: 2, cart: 1 }, nodesTotal: 2, exceptions: [], targetServices: [] });
  assert.equal(plan.targetRows, 6000);
  assert.equal(plan.outsidePerHour, 1000);
  assert.equal(plan.allowancePerHour, 5000);
  assert.ok(plan.levelPerHour !== undefined && plan.levelPerHour < 4000, 'the noisiest statement is held');
  const kept = plan.rows.reduce((a, r) => a + r.keptPerHour, 0);
  assert.ok(Math.abs(kept - 5000) < 1, `kept ${kept} equals the allowance`);
  assert.ok(plan.projectedPerHour <= 6000 + 1, `projected ${plan.projectedPerHour} at or under R`);
  assert.equal(plan.floorExceedsRate, false);
  // floors: 5 lines a window a node, 15 windows an hour
  const kafkaFloorPerStatement = ALWAYS_PASS_LINES * WINDOWS * 2;
  assert.equal(plan.floorPerHour, 2 * kafkaFloorPerStatement + ALWAYS_PASS_LINES * WINDOWS);
  // files: lines per window per node, offload everywhere, a star row
  const files = renderBudgetFiles(plan);
  assert.match(files['actions.csv'], /^kafka,offload::/m);
  assert.match(files['actions.csv'], /^\*,offload::/m);
  const kafka = plan.rows.find((r) => r.container === 'kafka')!;
  assert.equal(kafka.total, Math.max(1, Math.floor((kafka.keptPerHour * REGULATOR_WINDOW_SECONDS) / 3600 / 2)));
  assert.ok(kafka.cap <= kafka.total);
  const report = renderRowsReport(plan, rows, NOW);
  assert.match(report, /Rows written: 8000 of 6000 an hour last hour/);
  assert.match(report, /part_log/);
});

test('plan: under the rate every statement keeps its lines; exceptions are left alone', () => {
  const rows = parsePolicyYaml(policyText('  rows_per_hour: 20000')).rows!;
  const rd = reads(5000, 4500, [st('kafka', 'k1', 3000), st('cart', 'c1', 1500)]);
  const plan = planRows({ rows, reads: rd, instances: {}, nodesTotal: 1, exceptions: ['cart'], targetServices: [] });
  assert.equal(plan.levelPerHour, undefined);
  assert.equal(plan.movedPerHour, 0);
  const cart = plan.rows.find((r) => r.container === 'cart')!;
  assert.equal(cart.action, 'pass');
  assert.equal(cart.cap, 0);
  assert.ok(plan.projectedPerHour <= 20000);
});

test('plan: when the floor alone exceeds the rate, the run says so and holds nothing below the floor', () => {
  const rows = parsePolicyYaml(policyText('  rows_per_hour: 100')).rows!;
  const statements = Array.from({ length: 40 }, (_, i) => st('svc', `h${i}`, 1000));
  const rd = reads(40000, 40000, statements);
  const plan = planRows({ rows, reads: rd, instances: { svc: 10 }, nodesTotal: 10, exceptions: [], targetServices: [] });
  assert.equal(plan.floorExceedsRate, true);
  assert.equal(plan.levelPerHour, 0);
  assert.equal(plan.floorPerHour, 40 * ALWAYS_PASS_LINES * WINDOWS * 10);
  assert.ok(plan.warnings.some((w) => w.includes('always-pass sample') && w.includes('rateReceiverBaselineCount')));
  assert.ok(plan.projectedPerHour >= plan.floorPerHour);
});

test('plan: auto takes the meter at the first run and the recorded rate after it', () => {
  const rows = parsePolicyYaml(policyText('  rows_per_hour: auto')).rows!;
  const rd = reads(7777, 7000, [st('kafka', 'k1', 7000)]);
  const first = planRows({ rows, reads: rd, instances: {}, nodesTotal: 1, exceptions: [], targetServices: [] });
  assert.equal(first.targetRows, 7777);
  assert.match(first.targetSource, /recorded by this run/);
  const later = planRows({ rows, reads: reads(9000, 8500, [st('kafka', 'k1', 8500)]), instances: {}, nodesTotal: 1, exceptions: [], targetServices: [], recordedRate: 7777 });
  assert.equal(later.targetRows, 7777);
  assert.equal(later.overRate, true);
  assert.ok(later.projectedPerHour <= 7777 + 1);
});

test('plan: the meter anchors the totals; counters that miss lines are scaled up to it', () => {
  const rows = parsePolicyYaml(policyText('  rows_per_hour: 4500')).rows!;
  // the counters saw a tenth of what the meter counted
  const rd = reads(9000, 900, [st('kafka', 'k1', 600), st('cart', 'c1', 300)]);
  const plan = planRows({ rows, reads: rd, instances: {}, nodesTotal: 1, exceptions: [], targetServices: [] });
  assert.equal(plan.outsidePerHour, 0);
  assert.equal(plan.counterScale, 10);
  const kafka = plan.rows.find((r) => r.container === 'kafka')!;
  assert.equal(kafka.linesPerHour, 6000);
  assert.ok(plan.projectedPerHour <= 4500 + 1);
  assert.ok(plan.warnings.some((w) => w.includes('scaled by 10.00')));
  assert.throws(() => parsePolicyYaml(policyText('  rows_per_hour: 10\n  outside_rows_per_hour: -1')), /0 or more/);
});
