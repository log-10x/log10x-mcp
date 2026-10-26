/**
 * The ClickHouse census: where a cluster's CPU goes, read from its own system
 * tables over a window. W is the write share (inserts into the logs table plus
 * its merges, over node CPU), Q the read share (SELECTs over node CPU), with
 * the hourly peak, rows and bytes per table, and tables no SELECT touched.
 * Read only. Every SQL statement sent is kept in `queries`.
 */

import { sysTable, tsvRows, type ChQuery } from './clickhouse-rows-tick.js';
import { fmtBytes, fmtCount } from './format.js';

const HOUR = 3600;
const IDENT = /^[A-Za-z0-9_]+$/;
/** Tag on every census statement, so the census never counts its own reads. */
export const CENSUS_TAG = 'log10x_census';
const CPU_EVENT = 'OSCPUVirtualTimeMicroseconds';
const SYSTEM_DBS = `('system', 'INFORMATION_SCHEMA', 'information_schema')`;
const KINDS = `type IN ('QueryFinish', 'ExceptionWhileProcessing')`;
const NOT_CENSUS = `query NOT LIKE '%${CENSUS_TAG}%'`;
const TOP_SHAPES = 10;
const TOP_TABLES = 15;
const SHAPE_CHARS = 300;

export interface CensusOptions {
  nowSec: number;
  days: number;
  database: string;
  table: string;
  /** Cluster for clusterAllReplicas over the system logs; undefined reads one node. */
  cluster?: string;
  /** The ClickHouse user the census runs as, named in GRANT lines. */
  user: string;
}

export type DenominatorSource = 'metric_log' | 'asynchronous_metric_log' | 'attributed';

export interface Unreadable {
  table: string;
  reason: 'grant' | 'error';
  message: string;
  grant?: string;
}

export interface ReadShape {
  user: string;
  shape: string;
  selects: number;
  cpu_seconds: number;
  share_of_node: number | null;
  read_rows: number;
  read_bytes: number;
}

export interface TableWritten {
  table: string;
  new_parts: number;
  rows_written: number;
  bytes_written: number;
  rows_merged: number;
  /** Rows merged over rows written. */
  write_amplification: number | null;
}

export interface TableStored {
  table: string;
  rows: number;
  bytes_on_disk: number;
  compressed_bytes: number;
  uncompressed_bytes: number;
  compression_ratio: number | null;
}

export interface TableRead {
  table: string;
  selects: number;
  last_read: string;
}

export interface NeverRead {
  table: string;
  engine: string;
  rows: number;
  bytes_on_disk: number;
}

export interface HourCpu {
  hour: string;
  node_cpu_seconds: number;
  cores: number;
  write_cpu_seconds: number;
  read_cpu_seconds: number;
}

export interface CensusReport {
  target_table: string;
  database: string;
  cluster: string | null;
  window: { from: string; to: string; days: number };
  window_found: { first_hour: string | null; last_hour: string | null; hours: number };
  denominator: DenominatorSource;
  merge_cpu_method: 'profile_events' | 'duration' | 'none';
  ttl_split: boolean;
  cpu_seconds: {
    node_total: number;
    insert_table: number;
    merge_table: number;
    ttl_merge_table: number;
    insert_all: number;
    merge_all: number;
    ttl_merge_all: number;
    select: number;
    other_queries: number;
  };
  selects: number;
  /** W on the target table: its inserts and merges (ordinary and TTL) over node CPU. */
  w_share: number | null;
  w_parts: { insert: number; merge: number; ttl_merge: number } | null;
  /** The same over every table on the node. */
  w_share_all_tables: number | null;
  q_share: number | null;
  /** Node CPU no log attributes (replication, moves, log flushes); printed, never folded into W or Q. */
  residual_share: number | null;
  peak: {
    hour: string;
    cores: number;
    mean_cores: number;
    peak_to_mean: number;
    w_at_peak: number | null;
    q_at_peak: number | null;
  } | null;
  hours: HourCpu[];
  top_shapes: ReadShape[];
  tables_written: TableWritten[];
  tables_stored: TableStored[];
  tables_read: TableRead[];
  /** Tables system.tables listed in the database; never_read is only meaningful above zero. */
  tables_listed: number;
  never_read: NeverRead[];
  unreadable: Unreadable[];
  missing_logs: string[];
  notes: string[];
  queries: string[];
}

/** The connection failed outright (network, authentication), not one table. */
export class CensusConnectError extends Error {}

// ─── SQL ───────────────────────────────────────────────────────────────────

function windowPredicate(fromSec: number, toSec: number): string {
  return (
    `event_date >= toDate(toDateTime(${fromSec})) AND event_date <= toDate(toDateTime(${toSec})) ` +
    `AND event_time >= toDateTime(${fromSec}) AND event_time < toDateTime(${toSec})`
  );
}

/** re2 for `INSERT INTO [TABLE] [db.]tbl`, quoted or not, written as a ClickHouse string literal body. */
export function insertIntoRegex(db: string, tbl: string): string {
  const q = '[\\x60"]?';
  const re = `(?i)\\bINSERT\\s+INTO\\s+(TABLE\\s+)?(${q}${db}${q}\\.)?${q}${tbl}${q}(\\s|\\(|$)`;
  return re.replace(/\\/g, '\\\\');
}

export function censusSql(o: CensusOptions, fromSec: number, toSec: number) {
  const { database: db, table: tbl, cluster } = o;
  const S = (name: string): string => sysTable(name, cluster);
  const W = windowPredicate(fromSec, toSec);
  const tag = `/* ${CENSUS_TAG} */`;
  const pe = `ProfileEvents['${CPU_EVENT}']`;
  return {
    columns:
      `${tag} SELECT table, name FROM system.columns WHERE database = 'system' ` +
      `AND table IN ('part_log', 'metric_log') AND name IN ('merge_reason', 'ProfileEvents', 'ProfileEvent_${CPU_EVENT}')`,
    nodeCpu:
      `${tag} SELECT toUnixTimestamp(toStartOfHour(event_time)) AS h, sum(ProfileEvent_${CPU_EVENT}), dateDiff('second', min(event_time), max(event_time)) + 1 ` +
      `FROM ${S('metric_log')} WHERE ${W} GROUP BY h ORDER BY h`,
    nodeCpuAsync:
      `${tag} SELECT h, sum(cores * secs) * 1000000, max(secs) FROM (SELECT h, host, avg(v) AS cores, dateDiff('second', min(t), max(t)) + 1 AS secs FROM ` +
      `(SELECT toUnixTimestamp(toStartOfHour(event_time)) AS h, hostName() AS host, event_time AS t, sum(value) AS v FROM ${S('asynchronous_metric_log')} ` +
      `WHERE ${W} AND metric IN ('OSUserTime', 'OSSystemTime') GROUP BY h, host, t) GROUP BY h, host) GROUP BY h ORDER BY h`,
    queryCpu:
      `${tag} SELECT toUnixTimestamp(toStartOfHour(event_time)) AS h, ` +
      `multiIf(toString(query_kind) IN ('Insert', 'AsyncInsertFlush'), ` +
      `if(match(query, '${insertIntoRegex(db, tbl)}') AND (empty(tables) OR has(tables, '${db}.${tbl}')), 'insert_table', 'insert_other'), ` +
      `toString(query_kind) = 'Select', 'select', 'other') AS side, count(), sum(${pe}) ` +
      `FROM ${S('query_log')} WHERE ${W} AND ${KINDS} AND ${NOT_CENSUS} GROUP BY h, side ORDER BY h`,
    mergeCpu: (method: 'profile_events' | 'duration', ttlSplit: boolean): string =>
      `${tag} SELECT toUnixTimestamp(toStartOfHour(event_time)) AS h, (database = '${db}' AND table = '${tbl}') AS on_table, ` +
      `${ttlSplit ? "startsWith(toString(merge_reason), 'TTL')" : '0'} AS ttl, count(), ` +
      `${method === 'profile_events' ? `sum(${pe})` : 'sum(duration_ms) * 1000'} ` +
      `FROM ${S('part_log')} WHERE ${W} AND event_type = 'MergeParts' GROUP BY h, on_table, ttl ORDER BY h`,
    shapes:
      `${tag} SELECT user, any(substring(normalizeQuery(query), 1, ${SHAPE_CHARS})) AS shape, count(), sum(${pe}) AS cpu, sum(read_rows), sum(read_bytes) ` +
      `FROM ${S('query_log')} WHERE ${W} AND ${KINDS} AND toString(query_kind) = 'Select' AND ${NOT_CENSUS} ` +
      `GROUP BY user, normalized_query_hash ORDER BY cpu DESC LIMIT ${TOP_SHAPES}`,
    written:
      `${tag} SELECT database, table, toString(event_type) AS e, count(), sum(rows), sum(size_in_bytes) FROM ${S('part_log')} ` +
      `WHERE ${W} AND event_type IN ('NewPart', 'MergeParts') AND database NOT IN ${SYSTEM_DBS} GROUP BY database, table, e`,
    stored:
      `${tag} SELECT database, table, sum(rows), sum(bytes_on_disk), sum(data_compressed_bytes), sum(data_uncompressed_bytes) ` +
      `FROM system.parts WHERE active AND database NOT IN ${SYSTEM_DBS} GROUP BY database, table`,
    reads:
      `${tag} SELECT t, count(), toUnixTimestamp(max(event_time)) FROM ${S('query_log')} ARRAY JOIN tables AS t ` +
      `WHERE ${W} AND ${KINDS} AND toString(query_kind) = 'Select' AND ${NOT_CENSUS} AND startsWith(t, '${db}.') GROUP BY t`,
    tables:
      `${tag} SELECT name, engine FROM system.tables WHERE database = '${db}' AND NOT is_temporary ` +
      `AND engine NOT IN ('View', 'MaterializedView', 'LiveView', 'WindowView')`,
  };
}

// ─── reads ─────────────────────────────────────────────────────────────────

type Failure = { kind: 'missing' | 'grant' | 'error'; message: string };

function classify(message: string): Failure['kind'] {
  if (/ACCESS_DENIED|Code: 497\b|Not enough privileges/i.test(message)) return 'grant';
  if (/CLUSTER_DOESNT_EXIST|Requested cluster/i.test(message)) return 'error';
  if (/UNKNOWN_TABLE|Code: 60\b|doesn't exist|does not exist/i.test(message)) return 'missing';
  return 'error';
}

function quoteUser(user: string): string {
  return IDENT.test(user) ? user : `\`${user.replace(/`/g, '')}\``;
}

export function grantFor(table: string, user: string, cluster: string | undefined, message = ''): string {
  const u = quoteUser(user);
  const lines = [`GRANT SELECT ON ${table} TO ${u}`];
  if (cluster || /grant REMOTE/i.test(message)) lines.push(`GRANT REMOTE ON *.* TO ${u}`);
  return lines.join('; ');
}

/** Every grant the census needs, for the not-configured answer. SHOW TABLES makes the database visible in system.tables and system.parts. */
export function censusGrants(user: string, database: string, cluster?: string): string[] {
  const u = quoteUser(user);
  const out = ['query_log', 'part_log', 'metric_log', 'asynchronous_metric_log', 'parts', 'tables', 'columns'].map(
    (t) => `GRANT SELECT ON system.${t} TO ${u}`,
  );
  out.push(`GRANT SHOW TABLES ON ${database}.* TO ${u}`);
  if (cluster) out.push(`GRANT REMOTE ON *.* TO ${u}`);
  return out;
}

function unescapeTsv(v: string): string {
  return v.replace(/\\(.)/g, (_m, c: string) => ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' })[c] ?? c);
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.000Z$/, 'Z');
const hourIso = (sec: number): string => iso(sec).replace(/:00Z$/, 'Z');
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

function addTo(m: Map<number, number>, h: number, v: number): void {
  m.set(h, (m.get(h) ?? 0) + v);
}

export async function runCensus(ch: ChQuery, o: CensusOptions): Promise<CensusReport> {
  if (!IDENT.test(o.database) || !IDENT.test(o.table)) throw new Error('database and table must be identifiers');
  const toSec = Math.floor(o.nowSec / 60) * 60;
  const fromSec = toSec - Math.round(o.days * 86400);
  const sql = censusSql(o, fromSec, toSec);
  const target = `${o.database}.${o.table}`;
  const queries: string[] = [];
  const unreadable: Unreadable[] = [];
  const missing: string[] = [];
  const notes: string[] = [];

  const run = async (systemTable: string, statement: string, first = false): Promise<string[][] | Failure> => {
    queries.push(statement);
    try {
      return tsvRows(await ch(statement));
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      const kind = classify(message);
      if (first && kind === 'error') throw new CensusConnectError(message);
      if (kind === 'missing') {
        if (!missing.includes(systemTable)) missing.push(systemTable);
      } else if (!unreadable.some((u) => u.table === systemTable)) {
        unreadable.push({
          table: systemTable,
          reason: kind,
          message,
          ...(kind === 'grant' ? { grant: grantFor(systemTable, o.user, o.cluster, message) } : {}),
        });
      }
      return { kind, message };
    }
  };
  const ok = (r: string[][] | Failure): r is string[][] => Array.isArray(r);

  // Which columns this server version's logs carry.
  const cols = await run('system.columns', sql.columns, true);
  const has = new Set(ok(cols) ? cols.map(([t, n]) => `${t}.${n}`) : []);
  const metricLogKnown = ok(cols) && cols.some(([t]) => t === 'metric_log');
  const mergeMethod: 'profile_events' | 'duration' = has.has('part_log.ProfileEvents') ? 'profile_events' : 'duration';
  const ttlSplit = has.has('part_log.merge_reason');

  // Node CPU per hour: metric_log, else asynchronous_metric_log, else what the logs attribute.
  const nodeByHour = new Map<number, number>();
  const spanByHour = new Map<number, number>();
  let denominator: DenominatorSource = 'attributed';
  if (metricLogKnown && !has.has(`metric_log.ProfileEvent_${CPU_EVENT}`)) {
    notes.push(`system.metric_log has no ProfileEvent_${CPU_EVENT} column on this server, so node CPU comes from elsewhere.`);
  } else {
    const r = await run('system.metric_log', sql.nodeCpu);
    if (ok(r)) {
      for (const [h, v, span] of r) {
        addTo(nodeByHour, num(h), num(v));
        spanByHour.set(num(h), num(span));
      }
    }
    if ([...nodeByHour.values()].some((v) => v > 0)) denominator = 'metric_log';
  }
  if (denominator === 'attributed') {
    nodeByHour.clear();
    spanByHour.clear();
    const r = await run('system.asynchronous_metric_log', sql.nodeCpuAsync);
    if (ok(r)) {
      for (const [h, v, span] of r) {
        addTo(nodeByHour, num(h), num(v));
        spanByHour.set(num(h), num(span));
      }
    }
    if ([...nodeByHour.values()].some((v) => v > 0)) denominator = 'asynchronous_metric_log';
    else {
      nodeByHour.clear();
      spanByHour.clear();
    }
  }

  // Query CPU per hour, by side.
  const insT = new Map<number, number>();
  const insO = new Map<number, number>();
  const sel = new Map<number, number>();
  const oth = new Map<number, number>();
  let selects = 0;
  const qc = await run('system.query_log', sql.queryCpu);
  if (ok(qc)) {
    for (const [h, side, n, cpu] of qc) {
      const m = side === 'insert_table' ? insT : side === 'insert_other' ? insO : side === 'select' ? sel : oth;
      addTo(m, num(h), num(cpu));
      if (side === 'select') selects += num(n);
    }
  }

  // Merge CPU per hour, on the table or not, TTL or not.
  const mrgT = new Map<number, number>();
  const ttlT = new Map<number, number>();
  const mrgO = new Map<number, number>();
  const ttlO = new Map<number, number>();
  const mc = await run('system.part_log', sql.mergeCpu(mergeMethod, ttlSplit));
  const mergesRead = ok(mc);
  if (ok(mc)) {
    for (const [h, onTable, ttl, , cpu] of mc) {
      const t = onTable === '1';
      const isTtl = ttl === '1';
      addTo(t ? (isTtl ? ttlT : mrgT) : isTtl ? ttlO : mrgO, num(h), num(cpu));
    }
  }

  const sum = (m: Map<number, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
  const sec = (us: number): number => us / 1e6;
  const insertTable = sum(insT);
  const insertAll = insertTable + sum(insO);
  const mergeTable = sum(mrgT);
  const ttlTable = sum(ttlT);
  const mergeAll = mergeTable + sum(mrgO);
  const ttlAll = ttlTable + sum(ttlO);
  const selectCpu = sum(sel);
  const otherCpu = sum(oth);
  const attributed = insertAll + mergeAll + ttlAll + selectCpu + otherCpu;

  if (denominator === 'attributed') {
    for (const m of [insT, insO, sel, oth, mrgT, ttlT, mrgO, ttlO]) for (const [h, v] of m) addTo(nodeByHour, h, v);
  }
  const nodeTotal = sum(nodeByHour);
  const writeT = new Map<number, number>();
  for (const m of [insT, mrgT, ttlT]) for (const [h, v] of m) addTo(writeT, h, v);

  // Peak over mean, as cores: each hour's CPU over the seconds the node series covers in it,
  // else the seconds of it inside the window.
  const covered = (h: number): number => {
    const span = spanByHour.get(h) ?? 0;
    return Math.max(1, span > 0 ? Math.min(span, HOUR) : Math.min(h + HOUR, toSec) - Math.max(h, fromSec));
  };
  const hours = [...nodeByHour.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([h, v]) => ({ h, v, cores: sec(v) / covered(h) }));
  let peak: CensusReport['peak'] = null;
  if (hours.length > 0) {
    const top = hours.reduce((a, b) => (b.cores > a.cores ? b : a));
    const meanCores = sec(hours.reduce((a, x) => a + x.v, 0)) / hours.reduce((a, x) => a + covered(x.h), 0);
    peak = {
      hour: hourIso(top.h),
      cores: top.cores,
      mean_cores: meanCores,
      peak_to_mean: meanCores > 0 ? top.cores / meanCores : 1,
      w_at_peak: ok(qc) || mergesRead ? div(writeT.get(top.h) ?? 0, top.v) : null,
      q_at_peak: ok(qc) ? div(sel.get(top.h) ?? 0, top.v) : null,
    };
  }

  const wKnown = ok(qc) || mergesRead;
  const report: CensusReport = {
    target_table: target,
    database: o.database,
    cluster: o.cluster ?? null,
    window: { from: iso(fromSec), to: iso(toSec), days: o.days },
    window_found: {
      first_hour: hours.length ? hourIso(hours[0].h) : null,
      last_hour: hours.length ? hourIso(hours[hours.length - 1].h) : null,
      hours: hours.length,
    },
    denominator,
    merge_cpu_method: mergesRead ? mergeMethod : 'none',
    ttl_split: mergesRead && ttlSplit,
    cpu_seconds: {
      node_total: sec(nodeTotal),
      insert_table: sec(insertTable),
      merge_table: sec(mergeTable),
      ttl_merge_table: sec(ttlTable),
      insert_all: sec(insertAll),
      merge_all: sec(mergeAll),
      ttl_merge_all: sec(ttlAll),
      select: sec(selectCpu),
      other_queries: sec(otherCpu),
    },
    selects,
    w_share: wKnown ? div(insertTable + mergeTable + ttlTable, nodeTotal) : null,
    w_parts:
      wKnown && nodeTotal > 0
        ? { insert: insertTable / nodeTotal, merge: mergeTable / nodeTotal, ttl_merge: ttlTable / nodeTotal }
        : null,
    w_share_all_tables: wKnown ? div(insertAll + mergeAll + ttlAll, nodeTotal) : null,
    q_share: ok(qc) ? div(selectCpu, nodeTotal) : null,
    residual_share: denominator !== 'attributed' && nodeTotal > 0 ? 1 - attributed / nodeTotal : null,
    peak,
    hours: hours.map((x) => ({
      hour: hourIso(x.h),
      node_cpu_seconds: sec(x.v),
      cores: x.cores,
      write_cpu_seconds: sec(writeT.get(x.h) ?? 0),
      read_cpu_seconds: sec(sel.get(x.h) ?? 0),
    })),
    top_shapes: [],
    tables_written: [],
    tables_stored: [],
    tables_read: [],
    tables_listed: 0,
    never_read: [],
    unreadable,
    missing_logs: missing,
    notes,
    queries,
  };

  // Read shapes by CPU.
  if (ok(qc)) {
    const r = await run('system.query_log', sql.shapes);
    if (ok(r)) {
      report.top_shapes = r.map(([user, shape, n, cpu, rows, bytes]) => ({
        user: unescapeTsv(user ?? ''),
        shape: unescapeTsv(shape ?? '').replace(/\s+/g, ' ').trim(),
        selects: num(n),
        cpu_seconds: sec(num(cpu)),
        share_of_node: div(num(cpu), nodeTotal),
        read_rows: num(rows),
        read_bytes: num(bytes),
      }));
    }
  }

  // Rows and bytes written per table; merged rows for write amplification.
  if (mergesRead || (!ok(mc) && mc.kind === 'error')) {
    const r = await run('system.part_log', sql.written);
    if (ok(r)) {
      const by = new Map<string, TableWritten>();
      for (const [db, t, e, n, rows, bytes] of r) {
        const key = `${db}.${t}`;
        const w = by.get(key) ?? { table: key, new_parts: 0, rows_written: 0, bytes_written: 0, rows_merged: 0, write_amplification: null };
        if (e === 'NewPart') {
          w.new_parts += num(n);
          w.rows_written += num(rows);
          w.bytes_written += num(bytes);
        } else {
          w.rows_merged += num(rows);
        }
        by.set(key, w);
      }
      for (const w of by.values()) w.write_amplification = div(w.rows_merged, w.rows_written);
      report.tables_written = topWithTarget([...by.values()], (w) => w.rows_written, target);
    }
  }

  // Stored now, on the node that answered.
  const stored = await run('system.parts', sql.stored);
  const storedBy = new Map<string, TableStored>();
  if (ok(stored)) {
    for (const [db, t, rows, disk, comp, uncomp] of stored) {
      storedBy.set(`${db}.${t}`, {
        table: `${db}.${t}`,
        rows: num(rows),
        bytes_on_disk: num(disk),
        compressed_bytes: num(comp),
        uncompressed_bytes: num(uncomp),
        compression_ratio: div(num(uncomp), num(comp)),
      });
    }
    report.tables_stored = topWithTarget([...storedBy.values()], (s) => s.bytes_on_disk, target);
  }

  // Tables in the database no SELECT touched in the window.
  const tables = await run('system.tables', sql.tables);
  if (ok(tables)) {
    report.tables_listed = tables.length;
    if (tables.length === 0) {
      unreadable.push({
        table: 'system.tables',
        reason: 'grant',
        message: `system.tables lists no tables in ${o.database} for this user: the database is empty, or the user cannot see it, which also hides its parts.`,
        grant: `GRANT SHOW TABLES ON ${o.database}.* TO ${quoteUser(o.user)}`,
      });
    } else if (!tables.some(([name]) => name === o.table)) {
      notes.push(`${target} is not in system.tables; pass database and table for the logs table.`);
    }
  }
  if (ok(qc) && ok(tables) && tables.length > 0) {
    const reads = await run('system.query_log', sql.reads);
    if (ok(reads)) {
      const readSet = new Set<string>();
      for (const [t, n, last] of reads) {
        readSet.add(t);
        report.tables_read.push({ table: t, selects: num(n), last_read: iso(num(last)) });
      }
      report.tables_read.sort((a, b) => b.selects - a.selects);
      for (const [name, engine] of tables) {
        const key = `${o.database}.${name}`;
        if (readSet.has(key)) continue;
        const s = storedBy.get(key);
        report.never_read.push({ table: key, engine: engine ?? '', rows: s?.rows ?? 0, bytes_on_disk: s?.bytes_on_disk ?? 0 });
      }
      report.never_read.sort((a, b) => b.bytes_on_disk - a.bytes_on_disk || a.table.localeCompare(b.table));
    }
  }

  notes.push(...methodNotes(report, o));
  return report;
}

function topWithTarget<T extends { table: string }>(rows: T[], by: (x: T) => number, target: string): T[] {
  const sorted = [...rows].sort((a, b) => by(b) - by(a));
  const top = sorted.slice(0, TOP_TABLES);
  const t = sorted.find((x) => x.table === target);
  if (t && !top.includes(t)) top.push(t);
  return top;
}

function methodNotes(r: CensusReport, o: CensusOptions): string[] {
  const out: string[] = [];
  out.push(
    r.denominator === 'metric_log'
      ? `Node CPU is system.metric_log ProfileEvent_${CPU_EVENT}, summed per hour.`
      : r.denominator === 'asynchronous_metric_log'
        ? 'Node CPU is system.asynchronous_metric_log OSUserTime plus OSSystemTime, which count every process on the host, so W and Q are lower bounds and the residual includes work outside ClickHouse.'
        : 'No node total: neither system.metric_log nor system.asynchronous_metric_log answered, so node CPU is the insert, merge and query CPU the logs attribute, and the residual is not known.',
  );
  out.push(
    `W counts the INSERTs into ${r.target_table} (query_kind Insert and AsyncInsertFlush, matched on the query text) and the merges of ${r.target_table} in system.part_log. Query CPU is ProfileEvents ${CPU_EVENT} of finished and failed queries, each counted in the hour it finished.`,
  );
  if (r.merge_cpu_method === 'profile_events') out.push(`Merge CPU is system.part_log ProfileEvents ${CPU_EVENT} of each MergeParts entry.`);
  else if (r.merge_cpu_method === 'duration')
    out.push('Merge CPU is estimated as each merge\'s duration at one core: system.part_log on this server has no ProfileEvents column.');
  else out.push('Merge CPU is not counted: system.part_log could not be read, so W is a lower bound.');
  if (r.merge_cpu_method !== 'none' && !r.ttl_split) out.push('TTL merges are not split out: system.part_log on this server has no merge_reason column.');
  out.push(`The census tags its own statements with ${CENSUS_TAG} and leaves them out of every figure.`);
  if (o.cluster) {
    out.push(
      `System logs are read across replicas with clusterAllReplicas('${o.cluster}', ...); system.parts and system.tables are read on the node that answered.`,
    );
  }
  if (r.w_share != null && r.w_share > 1) out.push('Attributed write CPU exceeds the node total over the window; the logs and the node counter disagree.');
  if (r.window_found.first_hour && Date.parse(r.window_found.first_hour) - Date.parse(r.window.from) > 2 * HOUR * 1000) {
    out.push(`The node CPU series starts at ${r.window_found.first_hour}, later than the window asked for; system-log retention or the server's start bounds it.`);
  }
  return out;
}

// ─── render ────────────────────────────────────────────────────────────────

export function pct(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return 'n/a';
  const v = x * 100;
  if (v > 0 && v < 0.1) return '<0.1%';
  return `${v.toFixed(1).replace(/\.0$/, '')}%`;
}

const fix = (x: number, d: number): string => x.toFixed(d).replace(/\.?0+$/, '');
const cores = (x: number): string => (x >= 0.1 || x === 0 ? fix(x, 2) : String(Number(x.toPrecision(2))));
const cell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** The value to pass as compute_write_share: two decimals, or two significant digits below 0.1. */
export function writeShareArg(w: number): number {
  const c = Math.max(0, Math.min(1, w));
  return Number(c >= 0.1 ? c.toFixed(2) : c.toPrecision(2));
}

export function renderCensusMarkdown(r: CensusReport): string {
  const L: string[] = [];
  const c = r.cpu_seconds;
  L.push(`# ClickHouse census: ${r.target_table}, last ${r.window.days} days`, '');
  const src =
    r.denominator === 'metric_log' ? 'system.metric_log' : r.denominator === 'asynchronous_metric_log' ? 'system.asynchronous_metric_log (host-wide)' : 'the logs alone (no node total)';
  L.push(
    `Window ${r.window.from} to ${r.window.to}; node CPU from ${src}` +
      (r.window_found.hours > 0
        ? `, ${r.window_found.hours} ${r.window_found.hours === 1 ? 'hour' : 'hours'} with data from ${r.window_found.first_hour} to ${r.window_found.last_hour}.`
        : '; no hours with CPU data.'),
    '',
  );
  if (r.w_share != null && r.w_parts) {
    L.push(
      `- **W, write share on ${r.target_table}: ${pct(r.w_share)} of node CPU** (inserts ${pct(r.w_parts.insert)}, merges ${pct(r.w_parts.merge)}, TTL merges ${r.ttl_split ? pct(r.w_parts.ttl_merge) : 'not split out'}). All tables, system logs included: ${pct(r.w_share_all_tables)}.`,
    );
  } else {
    L.push(`- W, write share on ${r.target_table}: not measured (see what could not be read below).`);
  }
  L.push(
    r.q_share != null
      ? `- **Q, read share: ${pct(r.q_share)} of node CPU**, from ${fmtCount(r.selects)} SELECTs.`
      : '- Q, read share: not measured (system.query_log could not be read).',
  );
  if (r.residual_share != null) {
    L.push(`- Residual: ${pct(r.residual_share)} of node CPU no log attributes (replication, moves, log flushes, other background work). Not folded into W or Q.`);
  }
  if (r.peak) {
    const p = r.peak;
    L.push(
      `- Peak hour ${p.hour} at ${cores(p.cores)} cores against a mean of ${cores(p.mean_cores)}: peak over mean ${fix(p.peak_to_mean, 2)}. W in the peak hour ${pct(p.w_at_peak)}, Q ${pct(p.q_at_peak)}.`,
    );
  }
  const merges = r.merge_cpu_method === 'none' ? 'merges not read' : `merges of the table ${fix(c.merge_table + c.ttl_merge_table, 1)} of ${fix(c.merge_all + c.ttl_merge_all, 1)}`;
  L.push(
    `- CPU seconds: node ${fix(c.node_total, 1)}; inserts into the table ${fix(c.insert_table, 1)} of ${fix(c.insert_all, 1)} for all tables; ${merges}; SELECTs ${fix(c.select, 1)}; other statements ${fix(c.other_queries, 1)}.`,
    '',
  );

  if (r.top_shapes.length) {
    L.push('## Read shapes by CPU', '');
    L.push(`| # | User | SELECTs | CPU s | Share of node CPU | Rows read | Shape (normalizeQuery, first 300 characters) |`, '|---|---|---|---|---|---|---|');
    r.top_shapes.forEach((s, i) => {
      L.push(`| ${i + 1} | ${cell(s.user)} | ${fmtCount(s.selects)} | ${fix(s.cpu_seconds, 1)} | ${pct(s.share_of_node)} | ${fmtCount(s.read_rows)} | ${cell(s.shape)} |`);
    });
    L.push('');
  }

  if (r.tables_written.length) {
    L.push('## Written in the window (system.part_log)', '');
    L.push('| Table | New parts | Rows written | Bytes written | Rows merged | Write amplification |', '|---|---|---|---|---|---|');
    for (const w of r.tables_written) {
      L.push(
        `| ${w.table}${w.table === r.target_table ? ' (W)' : ''} | ${fmtCount(w.new_parts)} | ${fmtCount(w.rows_written)} | ${fmtBytes(w.bytes_written)} | ${fmtCount(w.rows_merged)} | ${w.write_amplification == null ? 'n/a' : fix(w.write_amplification, 2)} |`,
      );
    }
    L.push('');
  }

  if (r.tables_stored.length) {
    L.push('## Stored now (system.parts, active parts)', '');
    L.push('| Table | Rows | On disk | Compressed | Uncompressed | Compression ratio |', '|---|---|---|---|---|---|');
    for (const s of r.tables_stored) {
      L.push(
        `| ${s.table} | ${fmtCount(s.rows)} | ${fmtBytes(s.bytes_on_disk)} | ${fmtBytes(s.compressed_bytes)} | ${fmtBytes(s.uncompressed_bytes)} | ${s.compression_ratio == null ? 'n/a' : `${fix(s.compression_ratio, 1)}x`} |`,
      );
    }
    L.push('');
  }

  if (r.tables_listed > 0 && r.q_share != null) {
    L.push(`## Never read in the window`, '');
    if (r.never_read.length) {
      L.push(`Tables in \`${r.database}\` that no SELECT in system.query_log touched:`, '');
      L.push('| Table | Engine | Rows | On disk |', '|---|---|---|---|');
      for (const n of r.never_read) L.push(`| ${n.table} | ${n.engine} | ${fmtCount(n.rows)} | ${fmtBytes(n.bytes_on_disk)} |`);
      L.push('');
    } else {
      L.push(`Every table in \`${r.database}\` was read by at least one SELECT.`, '');
    }
  }

  if (r.unreadable.length || r.missing_logs.length) {
    L.push('## Could not read', '');
    for (const u of r.unreadable) {
      L.push(u.reason === 'grant' ? `- ${u.table}: not enough privileges. Run \`${u.grant}\`.` : `- ${u.table}: ${cell(u.message)}`);
    }
    for (const m of r.missing_logs) L.push(`- ${m}: not present on this server.`);
    L.push('');
  }

  L.push('## Method', '');
  for (const n of r.notes) L.push(`- ${n}`);
  L.push('');
  L.push(
    'Dollars are not computed. The census measures CPU shares from system tables; how the autoscaler responds and what the bill says are not in system tables.',
    '',
  );
  const lowerBound =
    r.merge_cpu_method === 'none'
      ? '; it is a lower bound until system.part_log can be read'
      : r.denominator === 'asynchronous_metric_log'
        ? '; it is a lower bound, since the node total here is host-wide'
        : '';
  L.push(
    r.w_share != null
      ? `Pass \`compute_write_share: ${writeShareArg(r.w_share)}\` to log10x_estimate_savings so its ClickHouse compute saving moves only this measured write share${lowerBound}.`
      : 'W was not measured, so log10x_estimate_savings keeps treating all compute as writes until a census reads it.',
  );
  return L.join('\n');
}
