/**
 * The ClickHouse census, read through a fake ClickHouse that answers each
 * statement by what it reads. Checked against the arithmetic it states: W is
 * the logs table's insert and merge CPU over node CPU, Q is SELECT CPU over
 * node CPU, the peak is the hour with the most cores.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCensus, renderCensusMarkdown, writeShareArg, CENSUS_TAG, type CensusOptions } from '../src/lib/clickhouse-census.js';
import { executeClickhouseCensus, defaultCluster } from '../src/tools/clickhouse-census.js';
import type { ChQuery } from '../src/lib/clickhouse-rows-tick.js';

const NOW = 1_792_660_000;
const T1 = Math.floor(NOW / 3600) * 3600 - 5 * 3600;
const T2 = T1 + 3600;
const T3 = T1 + 7200;
const M = 1e6;

type Answer = string[][] | Error;
type Spec = Partial<Record<'columns' | 'metric' | 'async' | 'queryCpu' | 'merge' | 'shapes' | 'written' | 'stored' | 'reads' | 'tables', Answer>>;

const tsv = (rows: Array<Array<string | number>>): string[][] => rows.map((r) => r.map(String));

const BASE: Spec = {
  columns: tsv([
    ['part_log', 'merge_reason'],
    ['part_log', 'ProfileEvents'],
    ['metric_log', 'ProfileEvent_OSCPUVirtualTimeMicroseconds'],
  ]),
  // 1, 2 and 1 cores over three whole hours: 14,400 CPU seconds.
  metric: tsv([[T1, 3600 * M, 3600], [T2, 7200 * M, 3600], [T3, 3600 * M, 3600]]),
  async: tsv([[T1, 9000 * M, 3600]]),
  queryCpu: tsv([
    [T1, 'insert_table', 10, 1000 * M],
    [T1, 'select', 50, 500 * M],
    [T2, 'insert_table', 30, 3000 * M],
    [T2, 'insert_other', 2, 200 * M],
    [T2, 'select', 40, 400 * M],
    [T2, 'other', 3, 100 * M],
    [T3, 'insert_table', 10, 1000 * M],
    [T3, 'select', 60, 600 * M],
  ]),
  merge: tsv([
    [T1, 1, 0, 4, 400 * M],
    [T1, 0, 0, 1, 100 * M],
    [T2, 1, 0, 8, 800 * M],
    [T2, 1, 1, 2, 200 * M],
    [T3, 1, 0, 4, 400 * M],
  ]),
  shapes: tsv([
    ['hyperdx', 'SELECT Body\\nFROM default.otel_logs WHERE ServiceName = ? LIMIT ?', 120, 900 * M, 5_000_000, 900_000_000],
    ['alerts', 'SELECT count() FROM default.otel_logs WHERE SeverityText = ?', 30, 300 * M, 2_000_000, 40_000_000],
  ]),
  written: tsv([
    ['default', 'otel_logs', 'NewPart', 50, 1_000_000, 200_000_000],
    ['default', 'otel_logs', 'MergeParts', 12, 3_000_000, 0],
    ['default', 'otel_audit', 'NewPart', 5, 10_000, 1_000_000],
  ]),
  stored: tsv([
    ['default', 'otel_logs', 5_000_000, 300_000_000, 290_000_000, 2_900_000_000],
    ['default', 'otel_audit', 70_000, 9_000_000, 8_000_000, 24_000_000],
  ]),
  reads: tsv([
    ['default.otel_logs', 150, T3],
    ['default.otel_traces', 2, T2],
  ]),
  tables: tsv([
    ['otel_logs', 'MergeTree'],
    ['otel_audit', 'MergeTree'],
    ['otel_traces', 'MergeTree'],
  ]),
};

function keyOf(q: string): keyof Spec {
  if (q.includes('FROM system.columns')) return 'columns';
  if (q.includes('system.asynchronous_metric_log')) return 'async';
  if (q.includes('system.metric_log')) return 'metric';
  if (q.includes('system.query_log')) return q.includes('multiIf') ? 'queryCpu' : q.includes('normalizeQuery') ? 'shapes' : 'reads';
  if (q.includes('system.part_log')) return q.includes("event_type = 'MergeParts'") ? 'merge' : 'written';
  if (q.includes('system.parts')) return 'stored';
  if (q.includes('system.tables')) return 'tables';
  throw new Error(`unexpected SQL: ${q}`);
}

function fake(over: Spec = {}) {
  const spec: Spec = { ...BASE, ...over };
  const sql: string[] = [];
  const ch: ChQuery = async (q) => {
    sql.push(q);
    const a = spec[keyOf(q)];
    if (a instanceof Error) throw a;
    return (a ?? []).map((r) => r.join('\t')).join('\n') + '\n';
  };
  return { ch, sql };
}

const OPTS: CensusOptions = { nowSec: NOW, days: 7, database: 'default', table: 'otel_logs', user: 'census' };
const near = (a: number | null | undefined, b: number, msg?: string): void => {
  assert.ok(a != null && Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);
};

test('W is the table\'s inserts and merges over node CPU; Q is SELECT CPU over node CPU; the residual is printed apart', async () => {
  const f = fake();
  const r = await runCensus(f.ch, OPTS);
  assert.equal(r.denominator, 'metric_log');
  near(r.cpu_seconds.node_total, 14_400);
  near(r.cpu_seconds.insert_table, 5000);
  near(r.cpu_seconds.insert_all, 5200);
  near(r.cpu_seconds.merge_table, 1600);
  near(r.cpu_seconds.ttl_merge_table, 200);
  near(r.cpu_seconds.merge_all, 1700);
  near(r.w_share, (5000 + 1600 + 200) / 14_400, 'W');
  near(r.w_parts!.insert, 5000 / 14_400);
  near(r.w_parts!.merge, 1600 / 14_400);
  near(r.w_share_all_tables, (5200 + 1700 + 200) / 14_400);
  near(r.q_share, 1500 / 14_400, 'Q');
  near(r.residual_share, 1 - (5200 + 1700 + 200 + 1500 + 100) / 14_400);
  assert.equal(r.selects, 150);
  assert.equal(r.unreadable.length, 0);
  assert.equal(r.missing_logs.length, 0);
  // every statement sent is kept, tagged, and leaves the census's own queries out
  assert.deepEqual(r.queries, f.sql);
  for (const q of r.queries) assert.ok(q.startsWith(`/* ${CENSUS_TAG} */`), q);
  for (const q of r.queries.filter((x) => x.includes('system.query_log'))) assert.match(q, /query NOT LIKE '%log10x_census%'/);
  // inserts are matched to the table on the query text, flushes included
  const qc = r.queries.find((x) => x.includes('multiIf'))!;
  assert.match(qc, /IN \('Insert', 'AsyncInsertFlush'\)/);
  assert.match(qc, /has\(tables, 'default\.otel_logs'\)/);
  assert.match(qc, /ProfileEvents\['OSCPUVirtualTimeMicroseconds'\]/);
  assert.match(qc, /event_time >= toDateTime\(\d+\) AND event_time < toDateTime\(\d+\)/);
});

test('TTL merges are reported apart and counted in W; without merge_reason they are not split', async () => {
  const r = await runCensus(fake().ch, OPTS);
  assert.equal(r.ttl_split, true);
  near(r.w_parts!.ttl_merge, 200 / 14_400);
  assert.match(r.queries.find((q) => q.includes("event_type = 'MergeParts'"))!, /startsWith\(toString\(merge_reason\), 'TTL'\) AS ttl/);
  assert.match(renderCensusMarkdown(r), /TTL merges 1\.4%/);

  const old = fake({ columns: tsv([['part_log', 'ProfileEvents'], ['metric_log', 'ProfileEvent_OSCPUVirtualTimeMicroseconds']]) });
  const r2 = await runCensus(old.ch, OPTS);
  assert.equal(r2.ttl_split, false);
  assert.match(old.sql.find((q) => q.includes("event_type = 'MergeParts'"))!, / 0 AS ttl/);
  assert.ok(r2.notes.some((n) => /no merge_reason column/.test(n)));
});

test('without ProfileEvents in part_log, merge CPU is the merge duration at one core, and the report says so', async () => {
  const f = fake({ columns: tsv([['part_log', 'merge_reason'], ['metric_log', 'ProfileEvent_OSCPUVirtualTimeMicroseconds']]) });
  const r = await runCensus(f.ch, OPTS);
  assert.equal(r.merge_cpu_method, 'duration');
  assert.match(f.sql.find((q) => q.includes("event_type = 'MergeParts'"))!, /sum\(duration_ms\) \* 1000/);
  assert.ok(r.notes.some((n) => /duration at one core/.test(n)));
});

test('the peak is the hour with the most cores, with W and Q in that hour', async () => {
  const r = await runCensus(fake().ch, OPTS);
  assert.ok(r.peak);
  assert.equal(r.peak!.hour, new Date(T2 * 1000).toISOString().replace(/:00\.000Z$/, 'Z'));
  near(r.peak!.cores, 2);
  near(r.peak!.mean_cores, 14_400 / 10_800);
  near(r.peak!.peak_to_mean, 2 / (14_400 / 10_800));
  near(r.peak!.w_at_peak, (3000 + 800 + 200) / 7200);
  near(r.peak!.q_at_peak, 400 / 7200);
  assert.equal(r.window_found.hours, 3);
  assert.equal(r.hours.length, 3);

  // an hour the node series covers only partly is read as cores over the seconds it covers
  const short = await runCensus(fake({ metric: tsv([[T1, 3600 * M, 3600], [T2, 900 * M, 600]]) }).ch, OPTS);
  assert.equal(short.peak!.hour, new Date(T2 * 1000).toISOString().replace(/:00\.000Z$/, 'Z'));
  near(short.peak!.cores, 1.5);
  near(short.peak!.mean_cores, 4500 / 4200);
});

test('no metric_log: node CPU falls back to asynchronous_metric_log, then to the attributed sum', async () => {
  const gone = new Error('ClickHouse 404: Code: 60. DB::Exception: Table system.metric_log does not exist. (UNKNOWN_TABLE)');
  const a = await runCensus(fake({ metric: gone }).ch, OPTS);
  assert.equal(a.denominator, 'asynchronous_metric_log');
  assert.deepEqual(a.missing_logs, ['system.metric_log']);
  near(a.cpu_seconds.node_total, 9000);
  assert.ok(a.notes.some((n) => /host/.test(n)));
  assert.match(renderCensusMarkdown(a), /lower bound, since the node total here is host-wide\.$/);

  const asyncGone = new Error('ClickHouse 404: Code: 60. DB::Exception: Table system.asynchronous_metric_log does not exist. (UNKNOWN_TABLE)');
  const b = await runCensus(fake({ metric: gone, async: asyncGone }).ch, OPTS);
  assert.equal(b.denominator, 'attributed');
  assert.deepEqual(b.missing_logs, ['system.metric_log', 'system.asynchronous_metric_log']);
  near(b.cpu_seconds.node_total, 5200 + 1700 + 200 + 1500 + 100);
  assert.equal(b.residual_share, null);
  near(b.w_share, 6800 / 8700);
  assert.ok(b.notes.some((n) => /^No node total/.test(n)));

  // a metric_log without the counter column is not queried
  const narrow = fake({ columns: tsv([['part_log', 'ProfileEvents'], ['metric_log', 'event_time']]) });
  const c = await runCensus(narrow.ch, OPTS);
  assert.equal(c.denominator, 'asynchronous_metric_log');
  assert.ok(!narrow.sql.some((q) => q.includes('system.metric_log')));
});

test('a grants error on one table names the GRANT and the rest of the census still runs', async () => {
  const denied = new Error(
    "ClickHouse 500: Code: 497. DB::Exception: census: Not enough privileges. To execute this query, it's necessary to have the grant SELECT(event_time, event_type) ON system.part_log. (ACCESS_DENIED)",
  );
  const r = await runCensus(fake({ merge: denied, written: denied }).ch, OPTS);
  assert.deepEqual(r.unreadable.map((u) => [u.table, u.reason, u.grant]), [['system.part_log', 'grant', 'GRANT SELECT ON system.part_log TO census']]);
  assert.equal(r.merge_cpu_method, 'none');
  near(r.w_share, 5000 / 14_400);
  near(r.q_share, 1500 / 14_400);
  assert.equal(r.tables_written.length, 0);
  assert.ok(r.tables_stored.length > 0);
  // the part_log read is not retried for the per-table rows after a grants error
  assert.equal(r.queries.filter((q) => q.includes('system.part_log')).length, 1);
  const md = renderCensusMarkdown(r);
  assert.match(md, /system\.part_log: not enough privileges\. Run `GRANT SELECT ON system\.part_log TO census`/);
  assert.match(md, /lower bound until system\.part_log can be read\.$/);
});

test('never read: tables in the database that no SELECT touched, with their stored bytes', async () => {
  const r = await runCensus(fake().ch, OPTS);
  assert.deepEqual(r.never_read, [{ table: 'default.otel_audit', engine: 'MergeTree', rows: 70_000, bytes_on_disk: 9_000_000 }]);
  assert.deepEqual(r.tables_read.map((t) => t.table), ['default.otel_logs', 'default.otel_traces']);
  assert.match(r.queries.find((q) => q.includes('ARRAY JOIN'))!, /startsWith\(t, 'default\.'\)/);
  assert.match(renderCensusMarkdown(r), /\| default\.otel_audit \| MergeTree \| 70K \| 9 MB \|/);

  // a user who cannot see the database is told so, never that every table was read
  const blind = await runCensus(fake({ tables: [], stored: [] }).ch, OPTS);
  assert.equal(blind.tables_listed, 0);
  assert.deepEqual(blind.never_read, []);
  assert.equal(blind.unreadable[0].grant, 'GRANT SHOW TABLES ON default.* TO census');
  assert.doesNotMatch(renderCensusMarkdown(blind), /was read by at least one SELECT/);
});

test('rows and bytes per table, write amplification and the compression ratio', async () => {
  const r = await runCensus(fake().ch, OPTS);
  const w = r.tables_written.find((t) => t.table === 'default.otel_logs')!;
  assert.equal(w.rows_written, 1_000_000);
  assert.equal(w.bytes_written, 200_000_000);
  assert.equal(w.write_amplification, 3);
  const s = r.tables_stored.find((t) => t.table === 'default.otel_logs')!;
  assert.equal(s.compression_ratio, 10);
  // system.parts is read on one node, never across replicas
  assert.ok(r.queries.some((q) => q.includes('FROM system.parts WHERE active')));
});

test('read shapes come back in CPU order with their user and count, unescaped', async () => {
  const r = await runCensus(fake().ch, OPTS);
  assert.equal(r.top_shapes[0].user, 'hyperdx');
  assert.equal(r.top_shapes[0].shape, 'SELECT Body FROM default.otel_logs WHERE ServiceName = ? LIMIT ?');
  assert.equal(r.top_shapes[0].selects, 120);
  near(r.top_shapes[0].share_of_node, 900 / 14_400);
  const odd = await runCensus(fake({ shapes: tsv([['u', "SELECT a FROM t WHERE match(b, '\\\\d|x')", 1, M, 1, 1]]) }).ch, OPTS);
  assert.equal(odd.top_shapes[0].shape, "SELECT a FROM t WHERE match(b, '\\d|x')");
  assert.match(renderCensusMarkdown(odd), /match\(b, '\\\\d\\\|x'\)/);
  const q = r.queries.find((x) => x.includes('normalizeQuery'))!;
  assert.match(q, /GROUP BY user, normalized_query_hash ORDER BY cpu DESC LIMIT 10/);
});

test('the report ends by telling the user to pass the measured W to log10x_estimate_savings, and computes no dollars', async () => {
  const md = renderCensusMarkdown(await runCensus(fake().ch, OPTS));
  const last = md.trim().split('\n').pop()!;
  assert.equal(last, 'Pass `compute_write_share: 0.47` to log10x_estimate_savings so its ClickHouse compute saving moves only this measured write share.');
  assert.match(md, /Dollars are not computed/);
  assert.doesNotMatch(md, /\$\d/);
  assert.equal(writeShareArg(0.04718), 0.047);
  assert.equal(writeShareArg(1.3), 1);
});

test('on ClickHouse Cloud the system logs are read with clusterAllReplicas; parts, tables and columns are not', async () => {
  assert.equal(defaultCluster('https://abc123.us-east-1.aws.clickhouse.cloud:8443'), 'default');
  assert.equal(defaultCluster('http://localhost:8123'), undefined);
  const f = fake();
  const env = await executeClickhouseCensus(
    { view: 'summary' },
    { creds: { url: 'https://abc123.us-east-1.aws.clickhouse.cloud:8443', username: 'default', password: 'sekret' }, ch: f.ch, nowMs: () => NOW * 1000 },
  );
  assert.equal(env.status, 'success');
  for (const t of ['query_log', 'part_log', 'metric_log']) {
    const qs = f.sql.filter((q) => q.includes(`system.${t}`));
    assert.ok(qs.length > 0, t);
    for (const q of qs) assert.match(q, new RegExp(`clusterAllReplicas\\('default', system\\.${t}\\)`));
  }
  for (const t of ['parts', 'tables', 'columns']) {
    for (const q of f.sql.filter((x) => x.includes(`system.${t} `))) assert.doesNotMatch(q, /clusterAllReplicas/, t);
  }
  const payload = env.data.payload as { queries: string[]; cluster: string };
  assert.deepEqual(payload.queries, f.sql);
  assert.equal(payload.cluster, 'default');
  assert.doesNotMatch(JSON.stringify(env), /sekret/);

  // an explicit empty cluster reads one node
  const one = fake();
  await executeClickhouseCensus({ cluster: '' }, { creds: { url: 'https://abc123.us-east-1.aws.clickhouse.cloud:8443', username: 'default', password: 'k' }, ch: one.ch, nowMs: () => NOW * 1000 });
  assert.ok(!one.sql.some((q) => q.includes('clusterAllReplicas')));

  // a grants error on Cloud names REMOTE too
  const denied = new Error('ClickHouse 500: Code: 497. DB::Exception: default: Not enough privileges. (ACCESS_DENIED)');
  const r = await runCensus(fake({ metric: denied }).ch, { ...OPTS, cluster: 'default' });
  assert.equal(r.unreadable[0].grant, 'GRANT SELECT ON system.metric_log TO census; GRANT REMOTE ON *.* TO census');
});

test('the tool: markdown view renders the page, a partial read says partial, no credentials returns the variables and grants', async () => {
  const creds = { url: 'http://localhost:8123', username: 'census', password: 'pw-not-printed' };
  const md = await executeClickhouseCensus({}, { creds, ch: fake().ch, nowMs: () => NOW * 1000 });
  assert.equal(md.view, 'markdown');
  assert.equal(md.status, 'success');
  const page = (md.data.payload as { markdown: string }).markdown;
  assert.match(page, /^# ClickHouse census: default\.otel_logs, last 7 days/);
  assert.equal(md.data.must_render_verbatim, page);
  assert.match(md.summary.headline, /^W 47\.2% and Q 10\.4% of node CPU on default\.otel_logs over 7 days; peak hour 1\.5 times the mean/);

  const denied = new Error('ClickHouse 500: Code: 497. DB::Exception: census: Not enough privileges. (ACCESS_DENIED)');
  const partial = await executeClickhouseCensus({ view: 'summary' }, { creds, ch: fake({ merge: denied }).ch, nowMs: () => NOW * 1000 });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.data.scope.candidates_failed, ['system.part_log']);

  const none = await executeClickhouseCensus({}, { creds: null });
  assert.equal(none.status, 'error');
  assert.match(none.data.error!.hint, /CLICKHOUSE_URL/);
  assert.match(none.data.error!.hint, /GRANT SELECT ON system\.query_log/);
  assert.match(none.data.error!.hint, /GRANT SHOW TABLES ON default\.\*/);

  const down: ChQuery = async () => {
    throw new Error('ClickHouse 516: Code: 516. DB::Exception: census: Authentication failed: password pw-not-printed is incorrect. (AUTHENTICATION_FAILED)');
  };
  const auth = await executeClickhouseCensus({}, { creds, ch: down, nowMs: () => NOW * 1000 });
  assert.equal(auth.status, 'error');
  assert.equal(auth.data.error!.error_type, 'config_missing');
  assert.doesNotMatch(JSON.stringify(auth), /pw-not-printed/);

  const bad = await executeClickhouseCensus({ table: 'otel_logs; DROP' } as never, { creds, ch: fake().ch });
  assert.equal(bad.status, 'error');
});
